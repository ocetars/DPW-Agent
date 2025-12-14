#!/usr/bin/env node
/**
 * DPW-Agent Web API Server
 * 提供 HTTP API 供 DronePilotWeb 前端调用
 */

import 'dotenv/config';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { OrchestratorAgent } from '../agents/orchestrator/OrchestratorAgent.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('WebServer');
const PORT = parseInt(process.env.WEB_API_PORT) || 3000;

async function main() {
  const app = express();
  
  // 中间件
  app.use(express.json({ limit: '10mb' }));
  
  // CORS
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // 创建 Orchestrator
  const orchestrator = new OrchestratorAgent();

  // ==================== API 路由 ====================

  /**
   * 健康检查
   * GET /api/health
   */
  app.get('/api/health', async (req, res) => {
    try {
      const deps = await orchestrator.checkDependencies();
      const allOk = Object.values(deps).every(v => v);
      
      res.json({
        status: allOk ? 'healthy' : 'degraded',
        agents: deps,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        status: 'unhealthy',
        error: error.message,
      });
    }
  });

  /**
   * 聊天接口
   * POST /api/chat
   * Body: { message, sessionId?, mapId?, filters? }
   */
  app.post('/api/chat', async (req, res) => {
    const startTime = Date.now();
    const { message, sessionId, mapId, filters } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'message is required',
      });
    }

    logger.info(`Chat request: "${message.substring(0, 50)}..."`);

    try {
      const response = await orchestrator.chat({
        message,
        sessionId: sessionId || uuidv4(),
        mapId,
        filters,
      });

      res.json({
        success: true,
        ...response,
      });
    } catch (error) {
      logger.error('Chat error:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        durationMs: Date.now() - startTime,
      });
    }
  });

  /**
   * 获取会话历史
   * GET /api/sessions/:sessionId/history
   */
  app.get('/api/sessions/:sessionId/history', (req, res) => {
    const { sessionId } = req.params;
    const history = orchestrator.getSessionHistory(sessionId);
    
    res.json({
      sessionId,
      history,
    });
  });

  /**
   * 清除会话
   * DELETE /api/sessions/:sessionId
   */
  app.delete('/api/sessions/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    orchestrator.clearSession(sessionId);
    
    res.json({
      success: true,
      message: `Session ${sessionId} cleared`,
    });
  });

  /**
   * 创建新会话
   * POST /api/sessions
   */
  app.post('/api/sessions', (req, res) => {
    const sessionId = uuidv4();
    
    res.json({
      success: true,
      sessionId,
    });
  });

  // ==================== 错误处理 ====================

  app.use((err, req, res, next) => {
    logger.error('Server error:', err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  });

  // ==================== 启动服务器 ====================

  app.listen(PORT, () => {
    logger.info(`Web API Server running on http://localhost:${PORT}`);
    logger.info('');
    logger.info('API Endpoints:');
    logger.info(`  GET  /api/health                    - 健康检查`);
    logger.info(`  POST /api/chat                      - 聊天`);
    logger.info(`  POST /api/sessions                  - 创建会话`);
    logger.info(`  GET  /api/sessions/:id/history      - 获取历史`);
    logger.info(`  DELETE /api/sessions/:id            - 清除会话`);
  });

  // 检查依赖
  logger.info('');
  logger.info('Checking dependent agents...');
  const deps = await orchestrator.checkDependencies();
  for (const [name, ok] of Object.entries(deps)) {
    logger.info(`  ${ok ? '✅' : '❌'} ${name}`);
  }

  // 优雅退出
  process.on('SIGINT', () => {
    logger.info('Shutting down...');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('Shutting down...');
    process.exit(0);
  });
}

main().catch(error => {
  logger.error('Failed to start Web Server:', error);
  process.exit(1);
});

