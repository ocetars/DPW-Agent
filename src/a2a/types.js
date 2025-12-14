/**
 * A2A Protocol 类型定义
 * 参考: https://a2a-protocol.org/latest/
 */

/**
 * AgentCard - Agent 的元数据描述
 * @typedef {Object} AgentCard
 * @property {string} name - Agent 名称
 * @property {string} description - Agent 描述
 * @property {string} url - Agent 服务地址
 * @property {string} version - Agent 版本
 * @property {AgentSkill[]} skills - Agent 技能列表
 */

/**
 * AgentSkill - Agent 的技能描述
 * @typedef {Object} AgentSkill
 * @property {string} id - 技能 ID
 * @property {string} name - 技能名称
 * @property {string} description - 技能描述
 * @property {Object} inputSchema - 输入参数 JSON Schema
 * @property {Object} outputSchema - 输出参数 JSON Schema
 */

/**
 * A2A Task - Agent 间传递的任务
 * @typedef {Object} A2ATask
 * @property {string} id - 任务 ID
 * @property {string} skill - 要调用的技能 ID
 * @property {Object} input - 输入参数
 * @property {Object} [context] - 上下文信息
 * @property {string} [sessionId] - 会话 ID（用于多轮对话）
 */

/**
 * A2A TaskResult - 任务执行结果
 * @typedef {Object} A2ATaskResult
 * @property {string} taskId - 对应的任务 ID
 * @property {boolean} success - 是否成功
 * @property {Object} [output] - 输出结果
 * @property {string} [error] - 错误信息
 * @property {Object} [metadata] - 元数据（如耗时等）
 */

/**
 * A2A Message Types
 */
export const A2AMessageType = {
  // 任务相关
  TASK_SUBMIT: 'task/submit',
  TASK_RESULT: 'task/result',
  TASK_CANCEL: 'task/cancel',
  TASK_STATUS: 'task/status',
  
  // Agent 发现
  AGENT_CARD: 'agent/card',
  AGENT_PING: 'agent/ping',
  AGENT_PONG: 'agent/pong',
  
  // 错误
  ERROR: 'error',
};

/**
 * Task 状态
 */
export const TaskStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/**
 * 创建 AgentCard
 * @param {Object} config
 * @returns {AgentCard}
 */
export function createAgentCard(config) {
  return {
    name: config.name,
    description: config.description,
    url: config.url,
    version: config.version || '1.0.0',
    skills: config.skills || [],
  };
}

/**
 * 创建 A2A Task
 * @param {Object} config
 * @returns {A2ATask}
 */
export function createTask(config) {
  return {
    id: config.id || crypto.randomUUID(),
    skill: config.skill,
    input: config.input || {},
    context: config.context || {},
    sessionId: config.sessionId,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 创建 Task Result
 * @param {string} taskId
 * @param {boolean} success
 * @param {Object} data
 * @returns {A2ATaskResult}
 */
export function createTaskResult(taskId, success, data) {
  return {
    taskId,
    success,
    output: success ? data : undefined,
    error: success ? undefined : (data?.message || data),
    metadata: {
      completedAt: new Date().toISOString(),
    },
  };
}

