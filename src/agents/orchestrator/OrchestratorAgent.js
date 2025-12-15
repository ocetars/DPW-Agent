/**
 * Orchestrator Agent
 * 核心编排 Agent，负责：
 * - 接收用户请求
 * - 调度 RAG / Planner / Executor
 * - 管理多轮对话上下文
 * - **ReAct 循环**：Plan → Execute → Observe → Reflect → (Re-plan if needed)
 * 
 * 架构说明：
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                    DPW-Agent 多 Agent 架构 (ReAct)              │
 * ├─────────────────────────────────────────────────────────────────┤
 * │                                                                 │
 * │  User Request ──► Orchestrator ──┬──► RAG Agent                │
 * │                       │          ├──► Planner Agent (plan/reflect)
 * │                       │          └──► Executor Agent           │
 * │                       │                                        │
 * │                       └──► ReAct Loop (max 3 iterations)       │
 * │                            Plan → Execute → Reflect → ...      │
 * │                                                                 │
 * └─────────────────────────────────────────────────────────────────┘
 */

import { AgentClient } from '../../a2a/AgentClient.js';
import { DEFAULT_PORTS, getAgentUrl } from '../definitions.js';
import { createLogger } from '../../utils/logger.js';
import { getStreamLogger, AgentName } from '../../utils/StreamLogger.js';
import { v4 as uuidv4 } from 'uuid';

// ReAct 循环配置
const REACT_CONFIG = {
  maxIterations: 3,           // 最大迭代次数（防止无限循环）
  minConfidenceToStop: 0.8,   // 反思置信度达到此值时停止循环
  maxRagRetries: 2,           // RAG 重试最大次数（当 Planner 发现缺失信息时）
};

export class OrchestratorAgent {
  constructor(config = {}) {
    this.logger = createLogger('OrchestratorAgent');
    this.streamLogger = getStreamLogger();
    
    // A2A Client 用于调用其他 Agent
    this.a2aClient = new AgentClient('Orchestrator');
    
    // 注册其他 Agent
    this._registerAgents(config);
    
    // 会话存储（内存）
    this.sessions = new Map();
    
    // 配置
    this.config = {
      ragEnabled: config.ragEnabled !== false,
      maxHistoryLength: config.maxHistoryLength || 10,
      reactEnabled: config.reactEnabled !== false, // 默认启用 ReAct
      maxReactIterations: config.maxReactIterations || REACT_CONFIG.maxIterations,
    };
  }

  /**
   * 注册其他 Agent 的地址
   * @private
   */
  _registerAgents(config) {
    const ragUrl = config.ragUrl || getAgentUrl('rag', DEFAULT_PORTS.rag);
    const plannerUrl = config.plannerUrl || getAgentUrl('planner', DEFAULT_PORTS.planner);
    const executorUrl = config.executorUrl || getAgentUrl('executor', DEFAULT_PORTS.executor);

    this.a2aClient.registerAgent('rag', ragUrl);
    this.a2aClient.registerAgent('planner', plannerUrl);
    this.a2aClient.registerAgent('executor', executorUrl);

    // this.logger.info('Registered agents:', { rag: ragUrl, planner: plannerUrl, executor: executorUrl });
  }

  /**
   * 检查依赖 Agent 是否可用
   * @returns {Promise<Object>}
   */
  async checkDependencies() {
    const results = {};
    
    for (const [name, url] of this.a2aClient.agentRegistry) {
      results[name] = await this.a2aClient.ping(url);
    }

    return results;
  }

  /**
   * 处理用户聊天请求（ReAct 模式）
   * @param {Object} request
   * @param {string} request.message - 用户消息
   * @param {string} [request.sessionId] - 会话 ID
   * @param {string} [request.mapId] - 地图 ID
   * @param {Object} [request.filters] - RAG 过滤条件
   * @returns {Promise<Object>}
   */
  async chat(request) {
    const startTime = Date.now();
    const { message, sessionId = uuidv4(), mapId, filters = {} } = request;
    const requestId = uuidv4(); // 用于日志追踪

    // ===== 流式日志：请求开始 =====
    this.streamLogger.requestStart(requestId, message, sessionId);

    // 获取或创建会话
    const session = this._getOrCreateSession(sessionId);
    session.history.push({ role: 'user', content: message, timestamp: Date.now() });

    try {
      // ===== 阶段 1: RAG 智能检索 =====
      let ragHits = [];
      let ragIntent = null; // 保存解析的用户意图
      let ragTargetResults = {}; // 保存每个目标的检索结果
      
      if (this.config.ragEnabled) {
        try {
          this.streamLogger.agentCallStart(requestId, AgentName.RAG, 'smartRetrieve', { query: message.substring(0, 50) });
          const ragStartTime = Date.now();
          
          // 使用智能检索（会先解析意图，再针对每个目标分别检索）
          const ragResult = await this._callRagSmart(message, { mapId, ...filters }, sessionId);
          ragHits = ragResult.output?.hits || [];
          ragIntent = ragResult.output?.intent || null;
          ragTargetResults = ragResult.output?.targetResults || {};
          
          // 发出意图解析日志
          if (ragIntent) {
            this.streamLogger.ragIntentParsed(requestId, ragIntent, ragResult.output?.durationMs);
          }
          
          this.streamLogger.ragResult(requestId, ragHits, Date.now() - ragStartTime);
          this.streamLogger.agentCallEnd(requestId, AgentName.RAG, 'smartRetrieve', { 
            hitCount: ragHits.length,
            targets: ragIntent?.targets || [],
          }, Date.now() - ragStartTime);
        } catch (error) {
          this.streamLogger.agentCallError(requestId, AgentName.RAG, 'smartRetrieve', error);
          this.logger.warn(`[${sessionId}] RAG failed, continuing without context:`, error.message);
        }
      }

      // ===== 阶段 1.5: 获取无人机状态 =====
      let droneState = await this._getDroneStateSafe(requestId, sessionId);

      // ===== 阶段 1.6: 发现可用工具 =====
      let availableTools = await this._getAvailableToolsSafe(requestId, sessionId);
      
      // RAG 重试计数器
      let ragRetryCount = 0;

      // ===== ReAct 循环 =====
      const allToolCalls = [];
      const allPlans = [];
      const reflections = [];
      let iteration = 0;
      let goalAchieved = false;
      let currentPlan = null;
      let lastExecutionResult = null;
      let finalReflection = null;

      while (iteration < this.config.maxReactIterations && !goalAchieved) {
        iteration++;
        this.logger.info(`[${sessionId}] ReAct iteration ${iteration}/${this.config.maxReactIterations}`);

        // ===== 阶段 2: 规划 =====
        this.streamLogger.agentCallStart(requestId, AgentName.PLANNER, 'plan', { iteration, ragHitsCount: ragHits.length });
        this.streamLogger.plannerStart(requestId, message);
        const planStartTime = Date.now();
        
        const planResult = await this._callPlanner(message, ragHits, droneState, availableTools, session, sessionId);
        
        if (!planResult.success) {
          this.streamLogger.agentCallError(requestId, AgentName.PLANNER, 'plan', new Error(planResult.error));
          throw new Error(planResult.error || 'Planning failed');
        }

        currentPlan = planResult.output;
        allPlans.push({ iteration, plan: currentPlan });
        this.streamLogger.plannerResult(requestId, currentPlan, Date.now() - planStartTime);
        this.streamLogger.agentCallEnd(requestId, AgentName.PLANNER, 'plan', { stepCount: currentPlan.steps?.length || 0 }, Date.now() - planStartTime);

        // ===== 阶段 3: 如果需要澄清，尝试 RAG 重试或返回 =====
        if (currentPlan.needsClarification) {
          const missingLocations = currentPlan.missingLocations || [];
          
          // 如果有缺失的地图点位信息，且未超过重试次数，尝试重新检索
          if (missingLocations.length > 0 && ragRetryCount < REACT_CONFIG.maxRagRetries) {
            ragRetryCount++;
            this.logger.info(`[${sessionId}] Planner missing ${missingLocations.length} locations, RAG retry ${ragRetryCount}/${REACT_CONFIG.maxRagRetries}`);
            
            try {
              // 发出 RAG 重试开始日志
              this.streamLogger.ragRetryStart(requestId, missingLocations, ragRetryCount);
              this.streamLogger.agentCallStart(requestId, AgentName.RAG, 'retrieveMissing', { 
                missingTargets: missingLocations,
                retryCount: ragRetryCount,
              });
              const ragRetryStartTime = Date.now();
              
              // 针对缺失的点位重新检索
              const retryResult = await this._callRagMissing(missingLocations, { mapId, ...filters }, sessionId);
              const retryHits = retryResult.output?.hits || [];
              
              // 发出 RAG 重试结果日志
              this.streamLogger.ragRetryResult(requestId, missingLocations, retryHits, Date.now() - ragRetryStartTime);
              this.streamLogger.agentCallEnd(requestId, AgentName.RAG, 'retrieveMissing', { 
                hitCount: retryHits.length,
                missingTargets: missingLocations,
              }, Date.now() - ragRetryStartTime);
              
              // 合并新的检索结果（去重）
              if (retryHits.length > 0) {
                const existingChunks = new Set(ragHits.map(h => h.chunkText));
                for (const hit of retryHits) {
                  if (!existingChunks.has(hit.chunkText)) {
                    ragHits.push(hit);
                    existingChunks.add(hit.chunkText);
                  }
                }
                this.logger.info(`[${sessionId}] RAG retry found ${retryHits.length} new hits, total now ${ragHits.length}`);
                
                // 继续下一轮 ReAct 迭代（重新规划）
                continue;
              } else {
                this.logger.info(`[${sessionId}] RAG retry found no new results for: ${missingLocations.join(', ')}`);
              }
            } catch (error) {
              this.streamLogger.agentCallError(requestId, AgentName.RAG, 'retrieveMissing', error);
              this.logger.warn(`[${sessionId}] RAG retry failed:`, error.message);
            }
          }
          
          // RAG 重试无效或已达上限，返回澄清请求
          const response = {
            sessionId,
            requestId,
            answer: currentPlan.clarificationQuestion || '请提供更多信息',
            plan: null,
            toolCalls: allToolCalls,
            ragHits,
            needsClarification: true,
            missingLocations,
            ragRetries: ragRetryCount,
            reactIterations: iteration,
            durationMs: Date.now() - startTime,
          };

          session.history.push({ role: 'assistant', content: response.answer, timestamp: Date.now() });
          this.streamLogger.requestEnd(requestId, response);
          return response;
        }

        // ===== 阶段 4: 执行 =====
        if (currentPlan.steps && currentPlan.steps.length > 0) {
          this.streamLogger.agentCallStart(requestId, AgentName.EXECUTOR, 'execute', { iteration, stepCount: currentPlan.steps.length });
          this.streamLogger.executorStart(requestId, currentPlan.steps);
          const execStartTime = Date.now();
          
          lastExecutionResult = await this._callExecutorWithProgress(currentPlan.steps, sessionId, requestId);
          
          if (lastExecutionResult.success) {
            allToolCalls.push(...(lastExecutionResult.output?.results || []));
          }
          
          this.streamLogger.executorResult(requestId, lastExecutionResult.output || {});
          this.streamLogger.agentCallEnd(requestId, AgentName.EXECUTOR, 'execute', { allSuccess: lastExecutionResult.output?.allSuccess }, Date.now() - execStartTime);
        } else {
          // 没有步骤需要执行，直接认为目标达成
          goalAchieved = true;
          break;
        }

        // ===== 阶段 5: Observe - 获取执行后的无人机状态 =====
        const postExecDroneState = await this._getDroneStateSafe(requestId, sessionId);

        // ===== 阶段 6: Reflect - 反思是否达成目标 =====
        if (this.config.reactEnabled) {
          this.streamLogger.reflectStart(requestId, iteration);
          const reflectStartTime = Date.now();

          try {
            const reflectResult = await this._callReflect(
              message,
              currentPlan,
              lastExecutionResult,
              postExecDroneState,
              ragHits,
              availableTools,
              sessionId
            );

            if (reflectResult.success) {
              finalReflection = reflectResult.output;
              reflections.push({ iteration, reflection: finalReflection });

              // 发出反思结果日志
              this.streamLogger.reflectResult(requestId, finalReflection, Date.now() - reflectStartTime);

              // 判断是否达成目标
              if (finalReflection.goalAchieved && finalReflection.confidence >= REACT_CONFIG.minConfidenceToStop) {
                goalAchieved = true;
              } else if (finalReflection.nextSteps && finalReflection.nextSteps.length > 0) {
                // 有补救步骤，更新 droneState 继续下一轮迭代
                droneState = postExecDroneState;
                // 注意：下一轮会重新规划，nextSteps 会在规划时被考虑
              } else {
                // 没有补救步骤但目标未达成，可能是无法完成
                this.logger.warn(`[${sessionId}] Goal not achieved but no nextSteps provided`);
                goalAchieved = true; // 强制退出循环
              }
            } else {
              this.streamLogger.agentCallError(requestId, AgentName.PLANNER, 'reflect', new Error(reflectResult.error || 'Reflect failed'));
              // 反思失败，假定目标达成以退出循环
              goalAchieved = true;
            }
          } catch (error) {
            this.streamLogger.agentCallError(requestId, AgentName.PLANNER, 'reflect', error);
            this.logger.warn(`[${sessionId}] Reflection failed:`, error.message);
            goalAchieved = true; // 反思出错，退出循环
          }
        } else {
          // ReAct 未启用，单次执行后退出
          goalAchieved = true;
        }
      }

      // ===== 阶段 7: 生成回答 =====
      const answer = this._generateAnswerWithReflection(currentPlan, lastExecutionResult, finalReflection, iteration);

      // ===== 阶段 8: 记录到历史 =====
      session.history.push({ role: 'assistant', content: answer, timestamp: Date.now() });
      this._trimHistory(session);

      const response = {
        sessionId,
        requestId,
        answer,
        plan: currentPlan?.steps,
        reasoning: currentPlan?.reasoning,
        toolCalls: allToolCalls,
        ragHits,
        executionSuccess: lastExecutionResult?.output?.allSuccess ?? true,
        goalAchieved,
        reactIterations: iteration,
        reflections: reflections.map(r => ({
          iteration: r.iteration,
          goalAchieved: r.reflection.goalAchieved,
          confidence: r.reflection.confidence,
          summary: r.reflection.summary,
        })),
        durationMs: Date.now() - startTime,
      };

      // ===== 流式日志：请求结束 =====
      this.streamLogger.requestEnd(requestId, response);
      // this.logger.info(`[${sessionId}] Completed in ${response.durationMs}ms (${iteration} iterations, goalAchieved: ${goalAchieved})`);
      return response;

    } catch (error) {
      this.logger.error(`[${sessionId}] Error:`, error.message);
      
      const errorResponse = {
        sessionId,
        requestId,
        answer: `抱歉，处理您的请求时出错：${error.message}`,
        error: error.message,
        durationMs: Date.now() - startTime,
      };

      session.history.push({ role: 'assistant', content: errorResponse.answer, timestamp: Date.now() });
      this.streamLogger.requestEnd(requestId, errorResponse);
      return errorResponse;
    }
  }

  /**
   * 安全获取无人机状态
   * @private
   */
  async _getDroneStateSafe(requestId, sessionId) {
    try {
      this.streamLogger.agentCallStart(requestId, AgentName.EXECUTOR, 'getDroneState', {});
      const stateStartTime = Date.now();
      
      const stateResult = await this._callExecutorGetDroneState(sessionId);
      if (stateResult?.success) {
        const droneState = stateResult.output;
        this.streamLogger.agentCallEnd(requestId, AgentName.EXECUTOR, 'getDroneState', { position: droneState?.position }, Date.now() - stateStartTime);
        return droneState;
      }
    } catch (error) {
      this.streamLogger.agentCallError(requestId, AgentName.EXECUTOR, 'getDroneState', error);
      this.logger.warn(`[${sessionId}] Failed to get drone state:`, error.message);
    }
    return null;
  }

  /**
   * 安全获取可用工具列表
   * @private
   */
  async _getAvailableToolsSafe(requestId, sessionId) {
    try {
      this.streamLogger.agentCallStart(requestId, AgentName.EXECUTOR, 'listTools', {});
      const toolsStartTime = Date.now();

      const toolsResult = await this._callExecutorListTools(sessionId);
      if (toolsResult?.success) {
        const tools = toolsResult.output?.tools || [];
        this.streamLogger.agentCallEnd(
          requestId,
          AgentName.EXECUTOR,
          'listTools',
          { toolCount: tools.length },
          Date.now() - toolsStartTime
        );
        return tools;
      }
    } catch (error) {
      this.streamLogger.agentCallError(requestId, AgentName.EXECUTOR, 'listTools', error);
      this.logger.warn(`[${sessionId}] Failed to list MCP tools:`, error.message);
    }
    return [];
  }

  /**
   * 调用 RAG Agent（普通检索）
   * @private
   */
  async _callRag(query, filters, sessionId) {
    return this.a2aClient.submitTask('rag', 'retrieve', {
      query,
      filters,
    }, { sessionId, timeout: 30000 });
  }

  /**
   * 调用 RAG Agent（智能检索 - 会先解析意图）
   * @private
   */
  async _callRagSmart(query, filters, sessionId) {
    return this.a2aClient.submitTask('rag', 'smartRetrieve', {
      query,
      filters,
    }, { sessionId, timeout: 45000 }); // 稍长超时因为需要多次检索
  }

  /**
   * 调用 RAG Agent（针对缺失目标重新检索）
   * @private
   */
  async _callRagMissing(missingTargets, filters, sessionId) {
    return this.a2aClient.submitTask('rag', 'retrieveMissing', {
      missingTargets,
      filters,
    }, { sessionId, timeout: 30000 });
  }

  /**
   * 调用 Planner Agent
   * @private
   */
  async _callPlanner(userRequest, ragHits, droneState, availableTools, session, sessionId) {
    return this.a2aClient.submitTask('planner', 'plan', {
      userRequest,
      ragHits,
      droneState,
      availableTools,
    }, { sessionId, timeout: 60000 });
  }

  /**
   * 调用 Planner Agent 的 reflect 技能
   * @private
   */
  async _callReflect(originalRequest, previousPlan, executionResult, currentDroneState, ragHits, availableTools, sessionId) {
    return this.a2aClient.submitTask('planner', 'reflect', {
      originalRequest,
      previousPlan,
      executionResult,
      currentDroneState,
      ragHits,
      availableTools,
    }, { sessionId, timeout: 60000 });
  }

  /**
   * 调用 Executor Agent 获取无人机状态（特例）
   * @private
   */
  async _callExecutorGetDroneState(sessionId) {
    return this.a2aClient.submitTask('executor', 'getDroneState', {}, { sessionId, timeout: 15000 });
  }

  /**
   * 调用 Executor Agent 获取 MCP 工具列表
   * @private
   */
  async _callExecutorListTools(sessionId) {
    return this.a2aClient.submitTask('executor', 'listTools', {}, { sessionId, timeout: 15000 });
  }

  /**
   * 调用 Executor Agent
   * @private
   */
  async _callExecutor(steps, sessionId) {
    return this.a2aClient.submitTask('executor', 'execute', {
      steps,
      stopOnError: true,
    }, { sessionId, timeout: 120000 });
  }

  /**
   * 调用 Executor Agent（带进度回调）
   * @private
   */
  async _callExecutorWithProgress(steps, sessionId, requestId) {
    const result = await this.a2aClient.submitTask('executor', 'execute', {
      steps,
      stopOnError: true,
    }, { sessionId, timeout: 120000 });

    // 回放步骤日志
    if (result.success && result.output?.results) {
      for (let i = 0; i < result.output.results.length; i++) {
        const stepResult = result.output.results[i];
        const step = steps[i];
        
        this.streamLogger.executorStepStart(requestId, i, {
          tool: stepResult.tool || step?.tool,
          args: stepResult.args || step?.args,
          description: stepResult.description || step?.description,
        });
        
        this.streamLogger.executorStepEnd(
          requestId, 
          i, 
          stepResult.success, 
          stepResult.durationMs, 
          stepResult.error
        );
      }
    }

    return result;
  }

  /**
   * 生成带反思的最终回答
   * @private
   */
  _generateAnswerWithReflection(plan, executionResult, reflection, iterations) {
    const parts = [];

    // 推理过程
    if (plan?.reasoning) {
      parts.push(plan.reasoning);
    }

    // 执行结果
    if (executionResult?.success && executionResult.output) {
      const { allSuccess, completedSteps, totalSteps, results } = executionResult.output;
      
      if (allSuccess) {
        parts.push(`已成功执行 ${completedSteps} 个步骤。`);
      } else {
        const failedStep = results?.find(r => !r.success);
        parts.push(`执行了 ${completedSteps}/${totalSteps} 个步骤。`);
        if (failedStep) {
          parts.push(`第 ${failedStep.step} 步失败：${failedStep.error}`);
        }
      }
    } else if (!plan?.steps || plan.steps.length === 0) {
      parts.push('没有需要执行的操作。');
    }

    // 反思总结
    if (reflection?.summary) {
      parts.push(reflection.summary);
    }

    // 如果迭代超过1次，说明有过重试
    if (iterations > 1) {
      parts.push(`（经过 ${iterations} 轮验证调整）`);
    }

    return parts.join('\n\n') || '任务已处理。';
  }

  /**
   * 获取或创建会话
   * @private
   */
  _getOrCreateSession(sessionId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        id: sessionId,
        history: [],
        createdAt: Date.now(),
      });
    }
    return this.sessions.get(sessionId);
  }

  /**
   * 裁剪历史记录
   * @private
   */
  _trimHistory(session) {
    if (session.history.length > this.config.maxHistoryLength * 2) {
      session.history = session.history.slice(-this.config.maxHistoryLength * 2);
    }
  }

  /**
   * 获取会话历史
   * @param {string} sessionId
   * @returns {Array}
   */
  getSessionHistory(sessionId) {
    const session = this.sessions.get(sessionId);
    return session?.history || [];
  }

  /**
   * 清除会话
   * @param {string} sessionId
   */
  clearSession(sessionId) {
    this.sessions.delete(sessionId);
  }
}

// 单例
let instance = null;

export function getOrchestratorAgent(config) {
  if (!instance) {
    instance = new OrchestratorAgent(config);
  }
  return instance;
}

export function resetOrchestratorAgent() {
  instance = null;
}
