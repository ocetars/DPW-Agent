/**
 * Executor Agent
 * 作为 MCP Client 执行无人机控制步骤
 */

import { getMcpClient } from './McpClientWrapper.js';
import { createLogger } from '../../utils/logger.js';

export class ExecutorAgent {
  /**
   * @param {Object} [config]
   * @param {McpClientWrapper} [config.mcpClient]
   */
  constructor(config = {}) {
    this.mcpClient = config.mcpClient || getMcpClient();
    this.logger = createLogger('ExecutorAgent');
    this.initialized = false;
  }

  /**
   * 初始化（连接 MCP Server）
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    this.logger.info('Initializing Executor Agent...');
    await this.mcpClient.connect();
    this.initialized = true;
    this.logger.info('Executor Agent initialized');
  }

  /**
   * 从 MCP Server 获取可用工具列表（协议发现）
   * @returns {Promise<Array>}
   */
  async listTools() {
    await this.initialize();
    await this.mcpClient.refreshTools();
    return this.mcpClient.getAvailableTools();
  }

  /**
   * 获取无人机当前状态（特例：动态调用 MCP 工具 drone.get_state）
   * 说明：虽然我们移除了硬编码工具列表，但无人机状态是规划阶段的重要上下文，
   *       因此作为特例保留这个便捷方法。工具名仍然通过 MCP 协议校验。
   * @returns {Promise<Object>}
   */
  async getDroneState() {
    await this.initialize();
    
    const toolName = 'drone.get_state';
    
    // 协议校验：确保工具确实存在
    if (!this.mcpClient.hasTool(toolName)) {
      await this.mcpClient.refreshTools();
      if (!this.mcpClient.hasTool(toolName)) {
        throw new Error(`MCP Server does not expose tool: ${toolName}`);
      }
    }
    
    return this.mcpClient.callTool(toolName, {});
  }

  /**
   * 执行一系列步骤
   * @param {Array} steps - 执行步骤 [{ tool, args, description }]
   * @param {Object} [options]
   * @param {boolean} [options.stopOnError=true] - 遇错是否停止
   * @param {Function} [options.onProgress] - 进度回调
   * @returns {Promise<Object>} - 执行结果
   */
  async execute(steps, options = {}) {
    const { stopOnError = true, onProgress } = options;
    const startTime = Date.now();

    // 确保已初始化
    await this.initialize();

    this.logger.info(`Executing ${steps.length} steps...`);

    const results = [];
    let allSuccess = true;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepStartTime = Date.now();

      // 进度回调
      if (onProgress) {
        onProgress({
          current: i + 1,
          total: steps.length,
          step,
          status: 'running',
        });
      }

      try {
        const result = await this._executeStep(step);
        
        results.push({
          step: i + 1,
          tool: step.tool,
          args: step.args,
          description: step.description,
          success: true,
          result,
          durationMs: Date.now() - stepStartTime,
        });

        this.logger.info(`Step ${i + 1}/${steps.length} completed: ${step.tool}`);

        // 进度回调
        if (onProgress) {
          onProgress({
            current: i + 1,
            total: steps.length,
            step,
            status: 'completed',
            result,
          });
        }
      } catch (error) {
        allSuccess = false;
        
        results.push({
          step: i + 1,
          tool: step.tool,
          args: step.args,
          description: step.description,
          success: false,
          error: error.message,
          durationMs: Date.now() - stepStartTime,
        });

        this.logger.error(`Step ${i + 1}/${steps.length} failed: ${step.tool}`, error.message);

        // 进度回调
        if (onProgress) {
          onProgress({
            current: i + 1,
            total: steps.length,
            step,
            status: 'failed',
            error: error.message,
          });
        }

        if (stopOnError) {
          this.logger.info('Stopping execution due to error (stopOnError=true)');
          break;
        }
      }
    }

    const totalDurationMs = Date.now() - startTime;
    
    this.logger.info(`Execution completed: ${results.filter(r => r.success).length}/${results.length} steps successful in ${totalDurationMs}ms`);

    return {
      results,
      allSuccess,
      totalDurationMs,
      completedSteps: results.filter(r => r.success).length,
      totalSteps: steps.length,
    };
  }

  /**
   * 执行单个步骤
   * @private
   */
  async _executeStep(step) {
    const { tool, args = {} } = step;

    if (!tool || typeof tool !== 'string') {
      throw new Error('Invalid step.tool (must be a non-empty string)');
    }

    // 协议驱动：只允许调用 MCP Server 实际暴露的工具
    if (!this.mcpClient.hasTool(tool)) {
      // 尝试刷新一次（防止 server 工具集发生变化）
      await this.mcpClient.refreshTools();
      if (!this.mcpClient.hasTool(tool)) {
        throw new Error(`Unknown MCP tool: ${tool}`);
      }
    }

    this.logger.debug(`Executing: ${tool}`, args);

    // 调用 MCP 工具
    const requestOptions = {};

    // 允许上层按步骤传入超时（毫秒）
    if (typeof step.timeoutMs === 'number' && Number.isFinite(step.timeoutMs) && step.timeoutMs > 0) {
      requestOptions.timeout = step.timeoutMs;
    }

    // 关键：航线任务是长时间运行的（会持续 progress），不能用 SDK 默认 60s 超时
    if (tool === 'drone.run_mission') {
      const DEFAULT_MISSION_TIMEOUT_MS = parseInt(process.env.MCP_MISSION_TIMEOUT_MS || '1800000', 10); // 30min
      const timeout = Math.max(requestOptions.timeout || 0, DEFAULT_MISSION_TIMEOUT_MS);
      requestOptions.timeout = timeout;
      // 保险：即便后续加入 MCP progress 通知，也希望 progress 能刷新超时
      requestOptions.resetTimeoutOnProgress = true;
      // 可选：限制最长总等待时间，避免“无限挂起”
      requestOptions.maxTotalTimeout = timeout;
    }

    return this.mcpClient.callTool(tool, args, requestOptions);
  }

  /**
   * 关闭连接
   */
  async shutdown() {
    this.logger.info('Shutting down Executor Agent...');
    await this.mcpClient.disconnect();
    this.initialized = false;
  }
}

// 单例
let instance = null;

export function getExecutorAgent(config) {
  if (!instance) {
    instance = new ExecutorAgent(config);
  }
  return instance;
}

export function resetExecutorAgent() {
  if (instance) {
    instance.shutdown().catch(() => {});
  }
  instance = null;
}

