#!/usr/bin/env node
/**
 * RAG Agent Server
 * 独立进程运行的 RAG Agent
 */

import 'dotenv/config';
import { AgentServer } from '../../a2a/AgentServer.js';
import { RagAgentCard, DEFAULT_PORTS } from '../definitions.js';
import { RagAgent } from './RagAgent.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('RagAgentServer');

async function main() {
  const port = parseInt(process.env.A2A_RAG_PORT) || DEFAULT_PORTS.rag;
  
  // 更新 AgentCard 的 URL
  const agentCard = {
    ...RagAgentCard,
    url: `http://localhost:${port}`,
  };

  // 创建 RAG Agent 实例
  const ragAgent = new RagAgent();

  // 创建 A2A Server
  const server = new AgentServer({
    agentCard,
    port,
    skillHandlers: {
      // 注册 retrieve 技能
      retrieve: async (input, context) => {
        const { query, filters = {} } = input;
        
        if (!query) {
          throw new Error('query is required');
        }

        const result = await ragAgent.retrieve(query, filters);
        
        return {
          hits: result.hits,
          totalFound: result.totalFound,
          formattedContext: ragAgent.formatHitsAsContext(result.hits),
          coordinates: ragAgent.extractCoordinates(result.hits),
          durationMs: result.durationMs,
        };
      },
    },
  });

  // 启动服务器
  await server.start();
  logger.info(`RAG Agent started on port ${port}`);

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
  logger.error('Failed to start RAG Agent:', error);
  process.exit(1);
});

