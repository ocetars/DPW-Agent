#!/usr/bin/env node
/**
 * Orchestrator Agent Server
 * 独立进程运行的 Orchestrator Agent
 */

import 'dotenv/config';
import { AgentServer } from '../../a2a/AgentServer.js';
import { OrchestratorAgentCard, DEFAULT_PORTS } from '../definitions.js';
import { OrchestratorAgent } from './OrchestratorAgent.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('OrchestratorAgentServer');

async function main() {
  const port = parseInt(process.env.A2A_ORCHESTRATOR_PORT) || DEFAULT_PORTS.orchestrator;
  
  // 更新 AgentCard 的 URL
  const agentCard = {
    ...OrchestratorAgentCard,
    url: `http://localhost:${port}`,
  };

  // 创建 Orchestrator Agent 实例
  const orchestratorAgent = new OrchestratorAgent();

  // 检查依赖
  logger.info('Checking dependent agents...');
  const deps = await orchestratorAgent.checkDependencies();
  logger.info('Dependent agents status:', deps);

  // 创建 A2A Server
  const server = new AgentServer({
    agentCard,
    port,
    skillHandlers: {
      // 注册 chat 技能
      chat: async (input, context) => {
        const { message, mapId, filters } = input;
        
        if (!message) {
          throw new Error('message is required');
        }

        const result = await orchestratorAgent.chat({
          message,
          sessionId: context.sessionId,
          mapId,
          filters,
        });

        return result;
      },
    },
  });

  // 启动服务器
  await server.start();
  logger.info(`Orchestrator Agent started on port ${port}`);

  // 优雅退出
  process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Shutting down...');
    await server.stop();
    process.exit(0);
  });
}

main().catch(error => {
  logger.error('Failed to start Orchestrator Agent:', error);
  process.exit(1);
});

