#!/usr/bin/env node
/**
 * Executor Agent Server
 * 独立进程运行的 Executor Agent
 */

import 'dotenv/config';
import { AgentServer } from '../../a2a/AgentServer.js';
import { ExecutorAgentCard, DEFAULT_PORTS } from '../definitions.js';
import { ExecutorAgent } from './ExecutorAgent.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('ExecutorAgentServer');

async function main() {
  const port = parseInt(process.env.A2A_EXECUTOR_PORT) || DEFAULT_PORTS.executor;
  
  // 更新 AgentCard 的 URL
  const agentCard = {
    ...ExecutorAgentCard,
    url: `http://localhost:${port}`,
  };

  // 创建 Executor Agent 实例
  const executorAgent = new ExecutorAgent();

  // 预先初始化（连接 MCP Server）
  try {
    await executorAgent.initialize();
  } catch (error) {
    logger.warn('Failed to initialize MCP connection, will retry on first request:', error.message);
  }

  // 创建 A2A Server
  const server = new AgentServer({
    agentCard,
    port,
    skillHandlers: {
      // 注册 execute 技能
      execute: async (input, context) => {
        const { steps, stopOnError = true } = input;
        
        if (!steps || !Array.isArray(steps)) {
          throw new Error('steps array is required');
        }

        const result = await executorAgent.execute(steps, { stopOnError });
        return result;
      },

      // 注册 listTools 技能（从 MCP Server 动态发现）
      listTools: async (input, context) => {
        const tools = await executorAgent.listTools();
        return { tools };
      },

      // 注册 getDroneState 技能（特例：获取无人机状态供规划使用）
      getDroneState: async (input, context) => {
        const state = await executorAgent.getDroneState();
        return state;
      },
    },
  });

  // 启动服务器
  await server.start();
  logger.info(`Executor Agent started on port ${port}`);

  // 优雅退出
  const shutdown = async () => {
    logger.info('Shutting down...');
    await executorAgent.shutdown();
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(error => {
  logger.error('Failed to start Executor Agent:', error);
  process.exit(1);
});

