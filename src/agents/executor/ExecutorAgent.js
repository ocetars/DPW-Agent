/**
 * Executor Agent
 * 作为 MCP Client 执行无人机控制步骤
 */

import { getMcpClient } from './McpClientWrapper.js';
import { createLogger } from '../../utils/logger.js';

// 工具名称映射（支持多种命名风格）
const TOOL_NAME_MAP = {
  'drone.get_state': 'drone.get_state',
  'drone.getState': 'drone.get_state',
  'getState': 'drone.get_state',
  
  'drone.take_off': 'drone.take_off',
  'drone.takeOff': 'drone.take_off',
  'takeOff': 'drone.take_off',
  
  'drone.land': 'drone.land',
  'land': 'drone.land',
  
  'drone.hover': 'drone.hover',
  'hover': 'drone.hover',
  
  'drone.move_to': 'drone.move_to',
  'drone.moveTo': 'drone.move_to',
  'moveTo': 'drone.move_to',

  'drone.move_relative': 'drone.move_relative',
  'drone.moveRelative': 'drone.move_relative',
  'moveRelative': 'drone.move_relative',
  
  'drone.run_mission': 'drone.run_mission',
  'drone.runMission': 'drone.run_mission',
  'runMission': 'drone.run_mission',
  
  'drone.cancel': 'drone.cancel',
  'cancel': 'drone.cancel',
  
  'drone.pause': 'drone.pause',
  'pause': 'drone.pause',
  
  'drone.resume': 'drone.resume',
  'resume': 'drone.resume',
};

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

    // 规范化工具名称
    const normalizedTool = TOOL_NAME_MAP[tool] || tool;

    this.logger.debug(`Executing: ${normalizedTool}`, args);

    // 调用 MCP 工具
    return this.mcpClient.callTool(normalizedTool, args);
  }

  /**
   * 获取无人机状态
   * @returns {Promise<Object>}
   */
  async getState() {
    await this.initialize();
    return this.mcpClient.getState();
  }

  /**
   * 紧急停止（悬停）
   * @returns {Promise<Object>}
   */
  async emergencyStop() {
    await this.initialize();
    this.logger.warn('Emergency stop triggered!');
    return this.mcpClient.hover();
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

