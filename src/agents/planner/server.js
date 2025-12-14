#!/usr/bin/env node
/**
 * Planner Agent Server
 * 独立进程运行的 Planner Agent
 */

import 'dotenv/config';
import { AgentServer } from '../../a2a/AgentServer.js';
import { PlannerAgentCard, DEFAULT_PORTS } from '../definitions.js';
import { PlannerAgent } from './PlannerAgent.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('PlannerAgentServer');

async function main() {
  const port = parseInt(process.env.A2A_PLANNER_PORT) || DEFAULT_PORTS.planner;
  
  // 更新 AgentCard 的 URL
  const agentCard = {
    ...PlannerAgentCard,
    url: `http://localhost:${port}`,
  };

  // 创建 Planner Agent 实例
  const plannerAgent = new PlannerAgent();

  // 创建 A2A Server
  const server = new AgentServer({
    agentCard,
    port,
    skillHandlers: {
      // 注册 plan 技能
      plan: async (input, context) => {
        const { userRequest, ragHits = [], droneState, availableTools = [] } = input;
        
        if (!userRequest) {
          throw new Error('userRequest is required');
        }

        const result = await plannerAgent.plan(userRequest, ragHits, droneState, availableTools);
        
        return result;
      },

      // 注册 reflect 技能（ReAct 模式的反思阶段）
      reflect: async (input, context) => {
        const { 
          originalRequest, 
          previousPlan, 
          executionResult, 
          currentDroneState,
          ragHits = [],
          availableTools = [],
        } = input;
        
        if (!originalRequest) {
          throw new Error('originalRequest is required');
        }

        const result = await plannerAgent.reflect(
          originalRequest,
          previousPlan,
          executionResult,
          currentDroneState,
          ragHits,
          availableTools
        );
        
        return result;
      },
    },
  });

  // 启动服务器
  await server.start();
  logger.info(`Planner Agent started on port ${port}`);

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
  logger.error('Failed to start Planner Agent:', error);
  process.exit(1);
});

