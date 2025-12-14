#!/usr/bin/env node
/**
 * DPW-Agent 主入口
 * 启动所有 Agent 服务（适用于开发/测试）
 */

import 'dotenv/config';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = createLogger('Main');

const AGENTS = [
  { name: 'rag', script: 'agents/rag/server.js' },
  { name: 'planner', script: 'agents/planner/server.js' },
  { name: 'executor', script: 'agents/executor/server.js' },
  { name: 'orchestrator', script: 'agents/orchestrator/server.js' },
];

const processes = new Map();

function startAgent(agent) {
  const scriptPath = path.join(__dirname, agent.script);
  
  logger.info(`Starting ${agent.name} agent...`);
  
  const proc = spawn('node', [scriptPath], {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  proc.stdout.on('data', (data) => {
    process.stdout.write(`[${agent.name}] ${data}`);
  });

  proc.stderr.on('data', (data) => {
    process.stderr.write(`[${agent.name}] ${data}`);
  });

  proc.on('exit', (code) => {
    logger.warn(`${agent.name} agent exited with code ${code}`);
    processes.delete(agent.name);
  });

  processes.set(agent.name, proc);
  return proc;
}

async function main() {
  logger.info('Starting DPW-Agent system...');
  logger.info('');

  // 启动所有 Agent
  for (const agent of AGENTS) {
    startAgent(agent);
    // 等待一小段时间让端口绑定
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  logger.info('');
  logger.info('All agents started. Press Ctrl+C to stop.');
  logger.info('');
  logger.info('Usage:');
  logger.info('  CLI:     npm run agent:cli');
  logger.info('  Web API: npm run agent:server');

  // 优雅退出
  const shutdown = () => {
    logger.info('');
    logger.info('Shutting down all agents...');
    
    for (const [name, proc] of processes) {
      logger.info(`Stopping ${name}...`);
      proc.kill('SIGTERM');
    }

    setTimeout(() => {
      process.exit(0);
    }, 2000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(error => {
  logger.error('Failed to start:', error);
  process.exit(1);
});

