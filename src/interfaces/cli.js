#!/usr/bin/env node
/**
 * DPW-Agent CLI
 * 命令行交互界面
 */

import 'dotenv/config';
import readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import { OrchestratorAgent } from '../agents/orchestrator/OrchestratorAgent.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('CLI');

// ANSI 颜色
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

function print(text, color = '') {
  console.log(color + text + colors.reset);
}

function printHeader() {
  console.log('');
  print('╔════════════════════════════════════════════════════════════╗', colors.cyan);
  print('║          DPW-Agent - 无人机智能控制助手                     ║', colors.cyan);
  print('║          A2A + RAG + MCP 多Agent系统                        ║', colors.cyan);
  print('╚════════════════════════════════════════════════════════════╝', colors.cyan);
  console.log('');
  print('命令：', colors.dim);
  print('  /help    - 显示帮助', colors.dim);
  print('  /status  - 检查系统状态', colors.dim);
  print('  /clear   - 清除会话历史', colors.dim);
  print('  /quit    - 退出', colors.dim);
  console.log('');
}

async function main() {
  printHeader();

  // 创建 Orchestrator（直接使用，不需要 A2A Server）
  const orchestrator = new OrchestratorAgent();

  // 检查依赖
  print('正在检查系统状态...', colors.yellow);
  const deps = await orchestrator.checkDependencies();
  
  const allOk = Object.values(deps).every(v => v);
  if (!allOk) {
    print('⚠️  部分 Agent 不可用，功能可能受限：', colors.yellow);
    for (const [name, ok] of Object.entries(deps)) {
      print(`   ${ok ? '✅' : '❌'} ${name}`, ok ? colors.green : colors.red);
    }
    console.log('');
    print('提示：请先启动各个 Agent 服务：', colors.dim);
    print('  npm run agent:rag', colors.dim);
    print('  npm run agent:planner', colors.dim);
    print('  npm run agent:executor', colors.dim);
    console.log('');
  } else {
    print('✅ 所有 Agent 已就绪', colors.green);
    console.log('');
  }

  // 创建会话
  const sessionId = uuidv4();
  print(`会话 ID: ${sessionId}`, colors.dim);
  console.log('');

  // 创建 readline 接口
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: colors.green + '你> ' + colors.reset,
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    // 处理命令
    if (input.startsWith('/')) {
      await handleCommand(input, orchestrator, sessionId, rl);
      rl.prompt();
      return;
    }

    // 处理用户消息
    try {
      print('', colors.reset);
      print('思考中...', colors.dim);

      const response = await orchestrator.chat({
        message: input,
        sessionId,
      });

      // 清除 "思考中..."
      process.stdout.write('\x1b[1A\x1b[2K');

      // 显示回答
      print('');
      print('🤖 助手:', colors.blue);
      print(response.answer, colors.reset);

      // 显示执行详情
      if (response.plan && response.plan.length > 0) {
        print('');
        print('📋 执行计划:', colors.cyan);
        for (let i = 0; i < response.plan.length; i++) {
          const step = response.plan[i];
          print(`   ${i + 1}. ${step.tool} ${step.description || ''}`, colors.dim);
        }
      }

      if (response.toolCalls && response.toolCalls.length > 0) {
        print('');
        print('🔧 工具调用结果:', colors.cyan);
        for (const call of response.toolCalls) {
          const status = call.success ? '✅' : '❌';
          print(`   ${status} ${call.tool} (${call.durationMs}ms)`, call.success ? colors.green : colors.red);
          if (!call.success && call.error) {
            print(`      错误: ${call.error}`, colors.red);
          }
        }
      }

      if (response.ragHits && response.ragHits.length > 0) {
        print('');
        print('📍 相关点位:', colors.cyan);
        for (const hit of response.ragHits.slice(0, 3)) {
          const name = hit.chunkText ? hit.chunkText.substring(0, 200) + '...' : '未命名';
          const score = (hit.score * 100).toFixed(0);
          print(`   - ${name} (${score}%)`, colors.dim);
        }
      }

      print('');
      print(`⏱️  耗时: ${response.durationMs}ms`, colors.dim);
      print('');

    } catch (error) {
      print('');
      print(`❌ 错误: ${error.message}`, colors.red);
      print('');
    }

    rl.prompt();
  });

  rl.on('close', () => {
    print('');
    print('再见！', colors.cyan);
    process.exit(0);
  });
}

async function handleCommand(input, orchestrator, sessionId, rl) {
  const [cmd, ...args] = input.slice(1).split(' ');

  switch (cmd.toLowerCase()) {
    case 'help':
      print('');
      print('可用命令:', colors.cyan);
      print('  /help              - 显示帮助', colors.reset);
      print('  /status            - 检查系统状态', colors.reset);
      print('  /clear             - 清除会话历史', colors.reset);
      print('  /history           - 显示会话历史', colors.reset);
      print('  /quit, /exit, /q   - 退出', colors.reset);
      print('');
      print('示例对话:', colors.cyan);
      print('  "让无人机起飞到1.5米"', colors.reset);
      print('  "飞到起点位置"', colors.reset);
      print('  "执行巡逻任务"', colors.reset);
      print('');
      break;

    case 'status':
      print('');
      print('正在检查系统状态...', colors.yellow);
      const deps = await orchestrator.checkDependencies();
      print('');
      print('Agent 状态:', colors.cyan);
      for (const [name, ok] of Object.entries(deps)) {
        print(`  ${ok ? '✅' : '❌'} ${name}`, ok ? colors.green : colors.red);
      }
      print('');
      break;

    case 'clear':
      orchestrator.clearSession(sessionId);
      print('');
      print('✅ 会话历史已清除', colors.green);
      print('');
      break;

    case 'history':
      const history = orchestrator.getSessionHistory(sessionId);
      print('');
      if (history.length === 0) {
        print('会话历史为空', colors.dim);
      } else {
        print('会话历史:', colors.cyan);
        for (const msg of history) {
          const role = msg.role === 'user' ? '你' : '助手';
          const time = new Date(msg.timestamp).toLocaleTimeString();
          print(`  [${time}] ${role}: ${msg.content.substring(0, 50)}...`, colors.dim);
        }
      }
      print('');
      break;

    case 'quit':
    case 'exit':
    case 'q':
      rl.close();
      break;

    default:
      print('');
      print(`未知命令: /${cmd}`, colors.yellow);
      print('输入 /help 查看可用命令', colors.dim);
      print('');
  }
}

// 运行
main().catch(error => {
  logger.error('CLI error:', error);
  process.exit(1);
});

