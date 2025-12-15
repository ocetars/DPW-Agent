/**
 * StreamLogger - 流式日志系统
 * 
 * 支持事件发布的日志系统，用于实时展示 Agent 调用链路
 * 
 * 架构链路说明：
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                    DPW-Agent 多 Agent 架构                       │
 * ├─────────────────────────────────────────────────────────────────┤
 * │                                                                 │
 * │  User Request                                                   │
 * │       │                                                         │
 * │       ▼                                                         │
 * │  ┌─────────────────┐                                           │
 * │  │  Orchestrator   │ ◄─── 核心编排 Agent                        │
 * │  │     Agent       │      负责调度所有子 Agent                   │
 * │  └────────┬────────┘                                           │
 * │           │                                                     │
 * │     ┌─────┴─────┬─────────────┐                                │
 * │     ▼           ▼             ▼                                │
 * │  ┌──────┐   ┌─────────┐   ┌──────────┐                        │
 * │  │ RAG  │   │ Planner │   │ Executor │                        │
 * │  │Agent │   │  Agent  │   │  Agent   │                        │
 * │  └──┬───┘   └────┬────┘   └────┬─────┘                        │
 * │     │            │             │                               │
 * │     ▼            ▼             ▼                               │
 * │  Supabase     Gemini        MCP                                │
 * │  (向量检索)    (LLM规划)    (无人机控制)                         │
 * │                                                                 │
 * └─────────────────────────────────────────────────────────────────┘
 */

import { EventEmitter } from 'events';

/**
 * 事件类型定义
 */
export const LogEventType = {
  // 请求生命周期
  REQUEST_START: 'request:start',
  REQUEST_END: 'request:end',
  REQUEST_ERROR: 'request:error',

  // Agent 调用链路
  AGENT_CALL_START: 'agent:call:start',
  AGENT_CALL_END: 'agent:call:end',
  AGENT_CALL_ERROR: 'agent:call:error',

  // RAG 相关
  RAG_QUERY: 'rag:query',
  RAG_EMBEDDING: 'rag:embedding',
  RAG_SEARCH: 'rag:search',
  RAG_RESULT: 'rag:result',
  RAG_INTENT_PARSED: 'rag:intent:parsed',      // 智能检索意图解析完成
  RAG_RETRY_START: 'rag:retry:start',          // RAG 重试开始
  RAG_RETRY_RESULT: 'rag:retry:result',        // RAG 重试结果

  // Planner 相关
  PLANNER_START: 'planner:start',
  PLANNER_PROMPT: 'planner:prompt',
  PLANNER_LLM_CALL: 'planner:llm:call',
  PLANNER_LLM_RESPONSE: 'planner:llm:response',
  PLANNER_RESULT: 'planner:result',

  // ReAct 反思相关
  REFLECT_START: 'reflect:start',
  REFLECT_RESULT: 'reflect:result',

  // Executor 相关
  EXECUTOR_START: 'executor:start',
  EXECUTOR_STEP_START: 'executor:step:start',
  EXECUTOR_STEP_END: 'executor:step:end',
  EXECUTOR_MCP_CALL: 'executor:mcp:call',
  EXECUTOR_MCP_RESPONSE: 'executor:mcp:response',
  EXECUTOR_RESULT: 'executor:result',

  // 通用日志
  LOG: 'log',
};

/**
 * 日志级别
 */
export const LogLevel = {
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
};

/**
 * Agent 名称常量
 */
export const AgentName = {
  ORCHESTRATOR: 'Orchestrator',
  RAG: 'RAG',
  PLANNER: 'Planner',
  EXECUTOR: 'Executor',
};

/**
 * StreamLogger 类
 * 单例模式，全局事件中心
 */
class StreamLogger extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100); // 允许多个订阅者
    this._requestContexts = new Map(); // 存储请求上下文
  }

  /**
   * 创建请求上下文
   * @param {string} requestId - 请求 ID
   * @param {Object} metadata - 元数据
   */
  createContext(requestId, metadata = {}) {
    this._requestContexts.set(requestId, {
      requestId,
      startTime: Date.now(),
      events: [],
      ...metadata,
    });
  }

  /**
   * 获取请求上下文
   * @param {string} requestId 
   */
  getContext(requestId) {
    return this._requestContexts.get(requestId);
  }

  /**
   * 清理请求上下文
   * @param {string} requestId 
   */
  clearContext(requestId) {
    this._requestContexts.delete(requestId);
  }

  /**
   * 发出日志事件
   * @param {string} eventType - 事件类型
   * @param {Object} payload - 事件数据
   */
  log(eventType, payload = {}) {
    const event = {
      type: eventType,
      timestamp: new Date().toISOString(),
      ...payload,
    };

    // 存储到请求上下文
    if (payload.requestId) {
      const context = this._requestContexts.get(payload.requestId);
      if (context) {
        context.events.push(event);
      }
    }

    // 发出事件
    this.emit(eventType, event);
    this.emit('*', event); // 通配符事件，用于订阅所有事件
  }

  // ==================== 便捷方法 ====================

  /**
   * 请求开始
   */
  requestStart(requestId, message, sessionId) {
    this.createContext(requestId, { message, sessionId });
    this.log(LogEventType.REQUEST_START, {
      requestId,
      sessionId,
      message,
      agent: AgentName.ORCHESTRATOR,
      phase: '接收请求',
    });
  }

  /**
   * 请求结束
   */
  requestEnd(requestId, result) {
    const context = this.getContext(requestId);
    const durationMs = context ? Date.now() - context.startTime : 0;
    
    this.log(LogEventType.REQUEST_END, {
      requestId,
      agent: AgentName.ORCHESTRATOR,
      phase: '请求完成',
      durationMs,
      success: !result.error,
    });
    
    this.clearContext(requestId);
  }

  /**
   * Agent 调用开始
   */
  agentCallStart(requestId, agentName, action, params = {}) {
    this.log(LogEventType.AGENT_CALL_START, {
      requestId,
      agent: agentName,
      action,
      params,
      phase: `调用 ${agentName} Agent`,
    });
  }

  /**
   * Agent 调用结束
   */
  agentCallEnd(requestId, agentName, action, result, durationMs) {
    this.log(LogEventType.AGENT_CALL_END, {
      requestId,
      agent: agentName,
      action,
      result,
      durationMs,
      phase: `${agentName} Agent 响应`,
    });
  }

  /**
   * Agent 调用错误
   */
  agentCallError(requestId, agentName, action, error) {
    this.log(LogEventType.AGENT_CALL_ERROR, {
      requestId,
      agent: agentName,
      action,
      error: error.message || error,
      phase: `${agentName} Agent 错误`,
      level: LogLevel.ERROR,
    });
  }

  // ==================== RAG 相关 ====================

  ragQuery(requestId, query) {
    this.log(LogEventType.RAG_QUERY, {
      requestId,
      agent: AgentName.RAG,
      phase: '向量检索查询',
      query: query.substring(0, 100),
    });
  }

  ragEmbedding(requestId, dimensions) {
    this.log(LogEventType.RAG_EMBEDDING, {
      requestId,
      agent: AgentName.RAG,
      phase: '生成 Embedding',
      dimensions,
    });
  }

  ragSearch(requestId, params) {
    this.log(LogEventType.RAG_SEARCH, {
      requestId,
      agent: AgentName.RAG,
      phase: 'Supabase 向量搜索',
      ...params,
    });
  }

  ragResult(requestId, hits, durationMs) {
    this.log(LogEventType.RAG_RESULT, {
      requestId,
      agent: AgentName.RAG,
      phase: '检索完成',
      hitCount: hits.length,
      topHits: hits.slice(0, 5).map(h => ({
        score: h.score,
        text: h.chunkText?.substring(0, 80),
      })),
      durationMs,
    });
  }

  /**
   * RAG 智能检索意图解析完成
   */
  ragIntentParsed(requestId, intent, durationMs) {
    this.log(LogEventType.RAG_INTENT_PARSED, {
      requestId,
      agent: AgentName.RAG,
      phase: '意图解析完成',
      targets: intent.targets || [],
      reasoning: intent.reasoning?.substring(0, 100),
      durationMs,
    });
  }

  /**
   * RAG 重试开始
   */
  ragRetryStart(requestId, missingTargets, retryCount) {
    this.log(LogEventType.RAG_RETRY_START, {
      requestId,
      agent: AgentName.RAG,
      phase: `RAG 重试 (第 ${retryCount} 次)`,
      missingTargets,
      retryCount,
    });
  }

  /**
   * RAG 重试结果
   */
  ragRetryResult(requestId, missingTargets, newHits, durationMs) {
    this.log(LogEventType.RAG_RETRY_RESULT, {
      requestId,
      agent: AgentName.RAG,
      phase: 'RAG 重试完成',
      missingTargets,
      newHitCount: newHits.length,
      topHits: newHits.slice(0, 3).map(h => ({
        score: h.score,
        text: h.chunkText?.substring(0, 60),
      })),
      durationMs,
    });
  }

  // ==================== Planner 相关 ====================

  plannerStart(requestId, userRequest) {
    this.log(LogEventType.PLANNER_START, {
      requestId,
      agent: AgentName.PLANNER,
      phase: '开始任务规划',
      userRequest: userRequest.substring(0, 100),
    });
  }

  plannerLLMCall(requestId) {
    this.log(LogEventType.PLANNER_LLM_CALL, {
      requestId,
      agent: AgentName.PLANNER,
      phase: '调用 Gemini LLM',
    });
  }

  plannerLLMResponse(requestId, durationMs) {
    this.log(LogEventType.PLANNER_LLM_RESPONSE, {
      requestId,
      agent: AgentName.PLANNER,
      phase: 'LLM 响应',
      durationMs,
    });
  }

  plannerResult(requestId, plan, durationMs) {
    this.log(LogEventType.PLANNER_RESULT, {
      requestId,
      agent: AgentName.PLANNER,
      phase: '规划完成',
      stepCount: plan.steps?.length || 0,
      steps: plan.steps?.map(s => ({ 
        tool: s.tool, 
        description: s.description,
        args: s.args,
      })),
      reasoning: plan.reasoning?.substring(0, 200),
      needsClarification: plan.needsClarification,
      missingLocations: plan.missingLocations || [], // 缺失的地图点位
      durationMs,
    });
  }

  // ==================== ReAct 反思相关 ====================

  reflectStart(requestId, iteration) {
    this.log(LogEventType.REFLECT_START, {
      requestId,
      agent: AgentName.PLANNER,
      phase: `ReAct 反思 (第 ${iteration} 轮)`,
      iteration,
    });
  }

  reflectResult(requestId, reflection, durationMs) {
    this.log(LogEventType.REFLECT_RESULT, {
      requestId,
      agent: AgentName.PLANNER,
      phase: '反思完成',
      goalAchieved: reflection.goalAchieved,
      confidence: reflection.confidence,
      observation: reflection.observation?.substring(0, 100),
      reasoning: reflection.reasoning?.substring(0, 150),
      nextStepsCount: reflection.nextSteps?.length || 0,
      nextSteps: reflection.nextSteps?.map(s => ({
        tool: s.tool,
        description: s.description,
      })),
      summary: reflection.summary,
      durationMs,
    });
  }

  // ==================== Executor 相关 ====================

  executorStart(requestId, steps) {
    this.log(LogEventType.EXECUTOR_START, {
      requestId,
      agent: AgentName.EXECUTOR,
      phase: '开始执行任务',
      totalSteps: steps.length,
    });
  }

  executorStepStart(requestId, stepIndex, step) {
    this.log(LogEventType.EXECUTOR_STEP_START, {
      requestId,
      agent: AgentName.EXECUTOR,
      phase: `执行步骤 ${stepIndex + 1}`,
      stepIndex,
      tool: step.tool,
      args: step.args,
      description: step.description,
    });
  }

  executorMCPCall(requestId, tool, args) {
    this.log(LogEventType.EXECUTOR_MCP_CALL, {
      requestId,
      agent: AgentName.EXECUTOR,
      phase: 'MCP 工具调用',
      tool,
      args,
    });
  }

  executorMCPResponse(requestId, tool, success, durationMs) {
    this.log(LogEventType.EXECUTOR_MCP_RESPONSE, {
      requestId,
      agent: AgentName.EXECUTOR,
      phase: 'MCP 响应',
      tool,
      success,
      durationMs,
    });
  }

  executorStepEnd(requestId, stepIndex, success, durationMs, error = null) {
    this.log(LogEventType.EXECUTOR_STEP_END, {
      requestId,
      agent: AgentName.EXECUTOR,
      phase: `步骤 ${stepIndex + 1} ${success ? '完成' : '失败'}`,
      stepIndex,
      success,
      durationMs,
      error,
    });
  }

  executorResult(requestId, result) {
    this.log(LogEventType.EXECUTOR_RESULT, {
      requestId,
      agent: AgentName.EXECUTOR,
      phase: '执行完成',
      completedSteps: result.completedSteps,
      totalSteps: result.totalSteps,
      allSuccess: result.allSuccess,
      durationMs: result.totalDurationMs,
    });
  }
}

// 单例实例
let instance = null;

export function getStreamLogger() {
  if (!instance) {
    instance = new StreamLogger();
  }
  return instance;
}

export { StreamLogger };
