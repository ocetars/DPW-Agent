/**
 * MCP Client Wrapper
 * 封装 MCP SDK，连接到 DronePilotWeb 的 MCP Server
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class McpClientWrapper {
  /**
   * @param {Object} [config]
   * @param {string} [config.serverPath] - MCP Server 路径
   */
  constructor(config = {}) {
    this.serverPath = config.serverPath || 
      process.env.MCP_SERVER_PATH || 
      path.resolve(__dirname, '../../../../DronePilotWeb/mcp/server.js');
    
    this.client = null;
    this.transport = null;
    this.serverProcess = null;
    this.connected = false;
    this.tools = new Map();
    this.logger = createLogger('McpClient');
  }

  /**
   * 连接到 MCP Server
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.connected) {
      this.logger.debug('Already connected');
      return;
    }

    this.logger.info(`Connecting to MCP Server at: ${this.serverPath}`);

    try {
      // 创建 stdio 传输
      this.transport = new StdioClientTransport({
        command: 'node',
        args: [this.serverPath],
      });

      // 创建 MCP Client
      this.client = new Client({
        name: 'dpw-agent-executor',
        version: '1.0.0',
      });

      // 连接
      await this.client.connect(this.transport);
      this.connected = true;

      // 获取可用工具列表
      await this._loadTools();

      this.logger.info('Connected to MCP Server successfully');
    } catch (error) {
      this.logger.error('Failed to connect to MCP Server:', error.message);
      throw error;
    }
  }

  /**
   * 加载可用工具
   * @private
   */
  async _loadTools() {
    try {
      const result = await this.client.listTools();
      
      this.tools.clear();
      for (const tool of result.tools || []) {
        this.tools.set(tool.name, tool);
        this.logger.debug(`Loaded tool: ${tool.name}`);
      }

      this.logger.info(`Loaded ${this.tools.size} tools`);
    } catch (error) {
      this.logger.warn('Failed to load tools:', error.message);
    }
  }

  /**
   * 调用工具
   * @param {string} toolName - 工具名称
   * @param {Object} [args] - 工具参数
   * @returns {Promise<Object>} - 工具执行结果
   */
  async callTool(toolName, args = {}) {
    if (!this.connected) {
      throw new Error('Not connected to MCP Server');
    }

    this.logger.debug(`Calling tool: ${toolName}`, args);

    try {
      const result = await this.client.callTool({
        name: toolName,
        arguments: args,
      });

      // 解析结果
      const content = result.content || [];
      const textContent = content.find(c => c.type === 'text');
      
      if (textContent) {
        try {
          return JSON.parse(textContent.text);
        } catch {
          return { text: textContent.text };
        }
      }

      return result;
    } catch (error) {
      this.logger.error(`Tool ${toolName} failed:`, error.message);
      throw error;
    }
  }

  /**
   * 断开连接
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (!this.connected) {
      return;
    }

    this.logger.info('Disconnecting from MCP Server...');

    try {
      if (this.client) {
        await this.client.close();
      }
    } catch (error) {
      this.logger.warn('Error closing client:', error.message);
    }

    this.connected = false;
    this.client = null;
    this.transport = null;
    
    this.logger.info('Disconnected from MCP Server');
  }

  /**
   * 获取可用工具列表
   * @returns {Array}
   */
  getAvailableTools() {
    return Array.from(this.tools.values());
  }

  /**
   * 检查是否已连接
   * @returns {boolean}
   */
  isConnected() {
    return this.connected;
  }

  // ==================== 便捷方法 ====================

  /**
   * 获取无人机状态
   */
  async getState() {
    return this.callTool('drone.get_state');
  }

  /**
   * 起飞
   * @param {number} [altitude=1.0]
   */
  async takeOff(altitude = 1.0) {
    return this.callTool('drone.take_off', { altitude });
  }

  /**
   * 降落
   */
  async land() {
    return this.callTool('drone.land');
  }

  /**
   * 悬停
   */
  async hover() {
    return this.callTool('drone.hover');
  }

  /**
   * 移动到指定位置
   * @param {number} x
   * @param {number} z
   * @param {number} [y]
   * @param {Object} [options]
   */
  async moveTo(x, z, y = null, options = {}) {
    const args = { x, z, ...options };
    if (y != null) {
      args.y = y;
    }
    return this.callTool('drone.move_to', args);
  }

  /**
   * 执行航线任务
   * @param {Array} waypoints
   */
  async runMission(waypoints) {
    return this.callTool('drone.run_mission', { waypoints });
  }

  /**
   * 取消任务
   */
  async cancel() {
    return this.callTool('drone.cancel');
  }

  /**
   * 暂停任务
   */
  async pause() {
    return this.callTool('drone.pause');
  }

  /**
   * 继续任务
   */
  async resume() {
    return this.callTool('drone.resume');
  }
}

// 单例
let instance = null;

export function getMcpClient(config) {
  if (!instance) {
    instance = new McpClientWrapper(config);
  }
  return instance;
}

export function resetMcpClient() {
  if (instance) {
    instance.disconnect().catch(() => {});
  }
  instance = null;
}

