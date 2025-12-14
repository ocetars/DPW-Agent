/**
 * A2A Agent Server
 * 基于 HTTP 的 Agent 服务器，处理 A2A 协议消息
 */

import express from 'express';
import { createLogger } from '../utils/logger.js';
import { A2AMessageType, createTaskResult } from './types.js';

export class AgentServer {
  /**
   * @param {Object} config
   * @param {Object} config.agentCard - Agent 元数据
   * @param {number} config.port - 服务端口
   * @param {Object} config.skillHandlers - 技能处理函数映射 { skillId: handler }
   */
  constructor(config) {
    this.agentCard = config.agentCard;
    this.port = config.port;
    this.skillHandlers = config.skillHandlers || {};
    this.logger = createLogger(`A2A:${this.agentCard.name}`);
    
    this.app = express();
    this.app.use(express.json({ limit: '10mb' }));
    this._setupRoutes();
  }

  _setupRoutes() {
    // Agent Card 获取
    this.app.get('/.well-known/agent.json', (req, res) => {
      res.json(this.agentCard);
    });

    // Ping/健康检查
    this.app.get('/ping', (req, res) => {
      res.json({ status: 'ok', agent: this.agentCard.name });
    });

    // 任务提交
    this.app.post('/tasks', async (req, res) => {
      const task = req.body;
      this.logger.info(`Received task: ${task.id}, skill: ${task.skill}`);
      
      try {
        const result = await this._handleTask(task);
        res.json(result);
      } catch (error) {
        this.logger.error(`Task ${task.id} failed:`, error.message);
        res.status(500).json(createTaskResult(task.id, false, error.message));
      }
    });

    // 错误处理
    this.app.use((err, req, res, next) => {
      this.logger.error('Server error:', err);
      res.status(500).json({ error: err.message });
    });
  }

  async _handleTask(task) {
    const { id, skill, input, context, sessionId } = task;
    
    const handler = this.skillHandlers[skill];
    if (!handler) {
      throw new Error(`Unknown skill: ${skill}`);
    }

    const startTime = Date.now();
    
    try {
      const output = await handler(input, { context, sessionId, taskId: id });
      const result = createTaskResult(id, true, output);
      result.metadata.durationMs = Date.now() - startTime;
      return result;
    } catch (error) {
      const result = createTaskResult(id, false, error.message);
      result.metadata.durationMs = Date.now() - startTime;
      return result;
    }
  }

  /**
   * 注册技能处理器
   * @param {string} skillId
   * @param {Function} handler
   */
  registerSkill(skillId, handler) {
    this.skillHandlers[skillId] = handler;
  }

  /**
   * 启动服务器
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        this.logger.info(`Agent "${this.agentCard.name}" listening on port ${this.port}`);
        resolve();
      });
    });
  }

  /**
   * 停止服务器
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.logger.info(`Agent "${this.agentCard.name}" stopped`);
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

