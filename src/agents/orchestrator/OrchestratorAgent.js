/**
 * Orchestrator Agent
 * 核心编排 Agent，负责：
 * - 接收用户请求
 * - 调度 RAG / Planner / Executor
 * - 管理多轮对话上下文
 * 
 * 架构说明：
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                    DPW-Agent 多 Agent 架构                       │
 * ├─────────────────────────────────────────────────────────────────┤
 * │                                                                 │
 * │  User Request ──► Orchestrator ──┬──► RAG Agent                │
 * │                                  ├──► Planner Agent            │
 * │                                  └──► Executor Agent           │
 * │                                                                 │
 * └─────────────────────────────────────────────────────────────────┘
 */

import { AgentClient } from '../../a2a/AgentClient.js';
import { DEFAULT_PORTS, getAgentUrl } from '../definitions.js';
import { createLogger } from '../../utils/logger.js';
import { getStreamLogger, AgentName } from '../../utils/StreamLogger.js';
import { v4 as uuidv4 } from 'uuid';

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

    this.logger.info('Registered agents:', { rag: ragUrl, planner: plannerUrl, executor: executorUrl });
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
   * 处理用户聊天请求
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
    // this.logger.info(`[${sessionId}] Processing: "${message.substring(0, 50)}..."`);

    // 获取或创建会话
    const session = this._getOrCreateSession(sessionId);
    session.history.push({ role: 'user', content: message, timestamp: Date.now() });

    try {
      // ===== 阶段 1: RAG 检索 =====
      let ragHits = [];
      let ragResult = null;
      
      if (this.config.ragEnabled) {
        try {
          this.streamLogger.agentCallStart(requestId, AgentName.RAG, 'retrieve', { query: message.substring(0, 50) });
          const ragStartTime = Date.now();
          
          ragResult = await this._callRag(message, { mapId, ...filters }, sessionId);
          ragHits = ragResult.output?.hits || [];
          
          this.streamLogger.ragResult(requestId, ragHits, Date.now() - ragStartTime);
          this.streamLogger.agentCallEnd(requestId, AgentName.RAG, 'retrieve', { hitCount: ragHits.length }, Date.now() - ragStartTime);
          // this.logger.info(`[${sessionId}] RAG returned ${ragHits.length} hits`);
        } catch (error) {
          this.streamLogger.agentCallError(requestId, AgentName.RAG, 'retrieve', error);
          this.logger.warn(`[${sessionId}] RAG failed, continuing without context:`, error.message);
        }
      }

      // ===== 阶段 1.5: 获取无人机状态 =====
      let droneState = null;
      try {
        this.streamLogger.agentCallStart(requestId, AgentName.EXECUTOR, 'getState', {});
        const stateStartTime = Date.now();
        
        const stateResult = await this._callExecutorGetState(sessionId);
        if (stateResult?.success) {
          droneState = stateResult.output;
          this.streamLogger.agentCallEnd(requestId, AgentName.EXECUTOR, 'getState', { position: droneState?.position }, Date.now() - stateStartTime);
        }
      } catch (error) {
        this.streamLogger.agentCallError(requestId, AgentName.EXECUTOR, 'getState', error);
        this.logger.warn(`[${sessionId}] Failed to get drone state, continuing without it:`, error.message);
      }

      // ===== 阶段 2: 规划 =====
      this.streamLogger.agentCallStart(requestId, AgentName.PLANNER, 'plan', { ragHitsCount: ragHits.length });
      this.streamLogger.plannerStart(requestId, message);
      const planStartTime = Date.now();
      
      const planResult = await this._callPlanner(message, ragHits, droneState, session, sessionId);
      
      if (!planResult.success) {
        this.streamLogger.agentCallError(requestId, AgentName.PLANNER, 'plan', new Error(planResult.error));
        throw new Error(planResult.error || 'Planning failed');
      }

      const plan = planResult.output;
      this.streamLogger.plannerResult(requestId, plan, Date.now() - planStartTime);
      this.streamLogger.agentCallEnd(requestId, AgentName.PLANNER, 'plan', { stepCount: plan.steps?.length || 0 }, Date.now() - planStartTime);

      // ===== 阶段 3: 如果需要澄清，直接返回 =====
      if (plan.needsClarification) {
        const response = {
          sessionId,
          requestId,
          answer: plan.clarificationQuestion || '请提供更多信息',
          plan: null,
          toolCalls: [],
          ragHits,
          needsClarification: true,
          durationMs: Date.now() - startTime,
        };

        session.history.push({ role: 'assistant', content: response.answer, timestamp: Date.now() });
        this.streamLogger.requestEnd(requestId, response);
        return response;
      }

      // ===== 阶段 4: 执行 =====
      let executionResult = null;
      const toolCalls = [];

      if (plan.steps && plan.steps.length > 0) {
        this.streamLogger.agentCallStart(requestId, AgentName.EXECUTOR, 'execute', { stepCount: plan.steps.length });
        this.streamLogger.executorStart(requestId, plan.steps);
        const execStartTime = Date.now();
        
        // 使用带回调的执行方法
        executionResult = await this._callExecutorWithProgress(plan.steps, sessionId, requestId);
        
        if (executionResult.success) {
          toolCalls.push(...(executionResult.output?.results || []));
        }
        
        this.streamLogger.executorResult(requestId, executionResult.output || {});
        this.streamLogger.agentCallEnd(requestId, AgentName.EXECUTOR, 'execute', { allSuccess: executionResult.output?.allSuccess }, Date.now() - execStartTime);
      }

      // ===== 阶段 5: 生成回答 =====
      const answer = this._generateAnswer(plan, executionResult);

      // ===== 阶段 6: 记录到历史 =====
      session.history.push({ role: 'assistant', content: answer, timestamp: Date.now() });
      this._trimHistory(session);

      const response = {
        sessionId,
        requestId,
        answer,
        plan: plan.steps,
        reasoning: plan.reasoning,
        toolCalls,
        ragHits,
        executionSuccess: executionResult?.output?.allSuccess ?? true,
        durationMs: Date.now() - startTime,
      };

      // ===== 流式日志：请求结束 =====
      this.streamLogger.requestEnd(requestId, response);
      this.logger.info(`[${sessionId}] Completed in ${response.durationMs}ms`);
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
   * 调用 RAG Agent
   * @private
   */
  async _callRag(query, filters, sessionId) {
    return this.a2aClient.submitTask('rag', 'retrieve', {
      query,
      filters,
    }, { sessionId, timeout: 30000 });
  }

  /**
   * 调用 Planner Agent
   * @private
   */
  async _callPlanner(userRequest, ragHits, droneState, session, sessionId) {
    // TODO: 可以把历史对话也传给 Planner 作为上下文
    return this.a2aClient.submitTask('planner', 'plan', {
      userRequest,
      ragHits,
      droneState,
      // conversationHistory: session.history.slice(-4), // 最近的对话
    }, { sessionId, timeout: 60000 });
  }

  /**
   * 调用 Executor Agent 获取状态
   * @private
   */
  async _callExecutorGetState(sessionId) {
    return this.a2aClient.submitTask('executor', 'getState', {}, { sessionId, timeout: 15000 });
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
    // 为每个步骤发送进度事件
    const result = await this.a2aClient.submitTask('executor', 'execute', {
      steps,
      stopOnError: true,
    }, { sessionId, timeout: 120000 });

    // 如果执行成功，回放步骤日志（因为 A2A 调用是同步的）
    // 同时发送步骤开始和结束事件，让日志更完整
    if (result.success && result.output?.results) {
      for (let i = 0; i < result.output.results.length; i++) {
        const stepResult = result.output.results[i];
        const step = steps[i];
        
        // 发送步骤开始事件
        this.streamLogger.executorStepStart(requestId, i, {
          tool: stepResult.tool || step?.tool,
          args: stepResult.args || step?.args,
          description: stepResult.description || step?.description,
        });
        
        // 发送步骤结束事件
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
   * 生成最终回答
   * @private
   */
  _generateAnswer(plan, executionResult) {
    const parts = [];

    // 推理过程
    if (plan.reasoning) {
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
    } else if (!plan.steps || plan.steps.length === 0) {
      parts.push('没有需要执行的操作。');
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

