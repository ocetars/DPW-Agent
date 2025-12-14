#!/usr/bin/env node
/**
 * DPW-Agent Web API Server
 * 提供 HTTP API 供 DronePilotWeb 前端调用
 * 
 * 支持 SSE (Server-Sent Events) 流式接口，实时返回 Agent 调用链路
 */

import 'dotenv/config';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { OrchestratorAgent } from '../agents/orchestrator/OrchestratorAgent.js';
import { createLogger } from '../utils/logger.js';
import { getStreamLogger, LogEventType } from '../utils/StreamLogger.js';

const logger = createLogger('WebServer');
const streamLogger = getStreamLogger();
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
   * 流式聊天接口 (SSE)
   * POST /api/chat/stream
   * Body: { message, sessionId?, mapId?, filters? }
   * 
   * 返回 Server-Sent Events 流，实时推送 Agent 调用链路
   * 
   * 事件格式：
   * - event: agent_event  (Agent 调用事件)
   * - event: result       (最终结果)
   * - event: error        (错误)
   */
  app.post('/api/chat/stream', async (req, res) => {
    const { message, sessionId, mapId, filters } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'message is required',
      });
    }

    logger.info(`Stream chat request: "${message.substring(0, 50)}..."`);

    // 设置 SSE 头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 禁用 nginx 缓冲

    // 发送 SSE 事件的辅助函数
    const sendEvent = (eventName, data) => {
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // 捕获请求 ID
    let capturedRequestId = null;
    
    // 订阅流式日志事件
    const eventHandler = (event) => {
      // 只处理当前请求的事件
      if (capturedRequestId && event.requestId !== capturedRequestId) {
        return;
      }

      // 捕获 requestId
      if (event.type === LogEventType.REQUEST_START && !capturedRequestId) {
        capturedRequestId = event.requestId;
      }

      // 发送事件
      sendEvent('agent_event', {
        type: event.type,
        timestamp: event.timestamp,
        agent: event.agent,
        phase: event.phase,
        // 根据事件类型添加相关数据
        ...(event.hitCount !== undefined && { hitCount: event.hitCount }),
        ...(event.stepCount !== undefined && { stepCount: event.stepCount }),
        ...(event.stepIndex !== undefined && { stepIndex: event.stepIndex }),
        ...(event.tool && { tool: event.tool }),
        ...(event.success !== undefined && { success: event.success }),
        ...(event.durationMs !== undefined && { durationMs: event.durationMs }),
        ...(event.error && { error: event.error }),
        ...(event.completedSteps !== undefined && { completedSteps: event.completedSteps }),
        ...(event.totalSteps !== undefined && { totalSteps: event.totalSteps }),
      });
    };

    // 监听所有事件
    streamLogger.on('*', eventHandler);

    try {
      const response = await orchestrator.chat({
        message,
        sessionId: sessionId || uuidv4(),
        mapId,
        filters,
      });

      // 发送最终结果
      sendEvent('result', {
        success: true,
        ...response,
      });

    } catch (error) {
      logger.error('Stream chat error:', error);
      sendEvent('error', {
        success: false,
        error: error.message,
      });
    } finally {
      // 取消订阅
      streamLogger.off('*', eventHandler);
      
      // 结束 SSE 流
      res.end();
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
    logger.info(`  POST /api/chat/stream               - 流式聊天 (SSE)`);
    logger.info(`  POST /api/sessions                  - 创建会话`);
    logger.info(`  GET  /api/sessions/:id/history      - 获取历史`);
    logger.info(`  DELETE /api/sessions/:id            - 清除会话`);
    logger.info('');
    logger.info('SSE 流式接口说明:');
    logger.info('  POST /api/chat/stream 返回 Server-Sent Events');
    logger.info('  事件类型: agent_event (调用链路), result (结果), error (错误)');
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

