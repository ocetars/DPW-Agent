/**
 * A2A Agent Client
 * 用于调用其他 Agent 的客户端
 */

import { createLogger } from '../utils/logger.js';
import { createTask } from './types.js';

export class AgentClient {
  /**
   * @param {string} name - 客户端名称（用于日志）
   */
  constructor(name = 'AgentClient') {
    this.logger = createLogger(`A2A:${name}`);
    this.agentRegistry = new Map(); // agentName -> agentUrl
  }

  /**
   * 注册已知 Agent
   * @param {string} name - Agent 名称
   * @param {string} url - Agent URL
   */
  registerAgent(name, url) {
    this.agentRegistry.set(name, url);
    this.logger.debug(`Registered agent: ${name} -> ${url}`);
  }

  /**
   * 获取 Agent Card
   * @param {string} agentUrl
   * @returns {Promise<Object>}
   */
  async getAgentCard(agentUrl) {
    const response = await fetch(`${agentUrl}/.well-known/agent.json`);
    if (!response.ok) {
      throw new Error(`Failed to get agent card: ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * 检查 Agent 是否可用
   * @param {string} agentUrl
   * @returns {Promise<boolean>}
   */
  async ping(agentUrl) {
    try {
      const response = await fetch(`${agentUrl}/ping`, { 
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * 提交任务到 Agent
   * @param {string} agentNameOrUrl - Agent 名称或 URL
   * @param {string} skill - 技能 ID
   * @param {Object} input - 输入参数
   * @param {Object} [options] - 可选配置
   * @returns {Promise<Object>} - 任务结果
   */
  async submitTask(agentNameOrUrl, skill, input, options = {}) {
    // 解析 URL
    let agentUrl = agentNameOrUrl;
    if (!agentNameOrUrl.startsWith('http')) {
      agentUrl = this.agentRegistry.get(agentNameOrUrl);
      if (!agentUrl) {
        throw new Error(`Unknown agent: ${agentNameOrUrl}`);
      }
    }

    const task = createTask({
      id: options.taskId,
      skill,
      input,
      context: options.context,
      sessionId: options.sessionId,
    });

    this.logger.debug(`Submitting task ${task.id} to ${agentUrl}, skill: ${skill}`);

    const response = await fetch(`${agentUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(task),
      signal: options.timeout ? AbortSignal.timeout(options.timeout) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Task submission failed: ${response.status} ${errorText}`);
    }

    const result = await response.json();
    
    if (!result.success) {
      this.logger.warn(`Task ${task.id} failed: ${result.error}`);
    } else {
      this.logger.debug(`Task ${task.id} completed successfully`);
    }

    return result;
  }

  /**
   * 便捷方法：调用 RAG Agent
   * @param {string} query - 查询文本
   * @param {Object} [filters] - 过滤条件
   * @param {Object} [options] - 可选配置
   */
  async callRag(query, filters = {}, options = {}) {
    return this.submitTask('rag', 'retrieve', { query, filters }, options);
  }

  /**
   * 便捷方法：调用 Planner Agent
   * @param {string} userRequest - 用户请求
   * @param {Array} ragHits - RAG 检索结果
   * @param {Object} [options] - 可选配置
   */
  async callPlanner(userRequest, ragHits = [], options = {}) {
    return this.submitTask('planner', 'plan', { userRequest, ragHits }, options);
  }

  /**
   * 便捷方法：调用 Executor Agent
   * @param {Array} steps - 执行步骤
   * @param {Object} [options] - 可选配置
   */
  async callExecutor(steps, options = {}) {
    return this.submitTask('executor', 'execute', { steps }, options);
  }
}

