#!/usr/bin/env node
/**
 * DPW-Agent CLI
 * 命令行交互界面
 * 
 * 支持流式日志输出，实时展示 Agent 调用链路
 */

import 'dotenv/config';
import readline from 'readline';
import { v4 as uuidv4 } from 'uuid';
import { OrchestratorAgent } from '../agents/orchestrator/OrchestratorAgent.js';
import { createLogger } from '../utils/logger.js';
import { getStreamLogger, LogEventType, AgentName } from '../utils/StreamLogger.js';

const logger = createLogger('CLI');
const streamLogger = getStreamLogger();

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
  magenta: '\x1b[35m',
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgMagenta: '\x1b[45m',
};

// Agent 颜色映射
const agentColors = {
  [AgentName.ORCHESTRATOR]: colors.cyan,
  [AgentName.RAG]: colors.magenta,
  [AgentName.PLANNER]: colors.yellow,
  [AgentName.EXECUTOR]: colors.green,
};

// Agent 图标映射
const agentIcons = {
  [AgentName.ORCHESTRATOR]: '🎯',
  [AgentName.RAG]: '🔍',
  [AgentName.PLANNER]: '📋',
  [AgentName.EXECUTOR]: '⚙️',
};

function print(text, color = '') {
  console.log(color + text + colors.reset);
}

function printHeader() {
  console.log('');
  // ASCII Art Logo
  print('    ____  ____ _       __     ___                    __ ', colors.cyan);
  print('   / __ \\/ __ \\ |     / /    /   | ____ ____  ____  / /_', colors.cyan);
  print('  / / / / /_/ / | /| / /    / /| |/ __ `/ _ \\/ __ \\/ __/', colors.cyan);
  print(' / /_/ / ____/| |/ |/ /    / ___ / /_/ /  __/ / / / /_  ', colors.cyan);
  print('/_____/_/     |__/|__/    /_/  |_\\__, /\\___/_/ /_/\\__/  ', colors.cyan);
  print('                                /____/                   ', colors.cyan);
  console.log('');
  print('A2A + RAG + MCP + ReAct 多 Agent 协作系统', colors.yellow);
  print('═'.repeat(70), colors.dim);
  console.log('');
  print('架构:', colors.dim);
  print('  Orchestrator ──┬──► RAG Agent (向量检索)', colors.dim);
  print('                 ├──► Planner Agent (LLM规划 + 反思)', colors.dim);
  print('                 └──► Executor Agent (MCP执行)', colors.dim);
  console.log('');
  print('ReAct 循环: Plan → Execute → Observe → Reflect → (Re-plan)', colors.yellow);
  console.log('');
  // print('命令：', colors.dim);
  // print('  /help    - 显示帮助', colors.dim);
  // print('  /status  - 检查系统状态', colors.dim);
  // print('  /clear   - 清除会话历史', colors.dim);
  // print('  /stream  - 切换流式日志显示', colors.dim);
  // print('  /quit    - 退出', colors.dim);
  // console.log('');
}

/**
 * 获取时间戳字符串
 */
function getTimeStr() {
  return new Date().toLocaleTimeString('zh-CN', { 
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * 打印流向箭头
 */
function printFlow(from, to, action = '') {
  const fromIcon = agentIcons[from] || '📌';
  const toIcon = agentIcons[to] || '📌';
  const fromColor = agentColors[from] || colors.dim;
  const toColor = agentColors[to] || colors.dim;
  const actionStr = action ? ` ${colors.dim}(${action})${colors.reset}` : '';
  
  console.log(
    `${colors.dim}[${getTimeStr()}]${colors.reset} ` +
    `${fromIcon} ${fromColor}${from}${colors.reset} ` +
    `${colors.yellow}──▶${colors.reset} ` +
    `${toIcon} ${toColor}${to}${colors.reset}` +
    actionStr
  );
}

/**
 * 打印返回箭头
 */
function printReturn(from, to, result = '', durationMs = null) {
  const fromIcon = agentIcons[from] || '📌';
  const toIcon = agentIcons[to] || '📌';
  const fromColor = agentColors[from] || colors.dim;
  const toColor = agentColors[to] || colors.dim;
  const timeStr = durationMs ? ` ${colors.dim}(${durationMs}ms)${colors.reset}` : '';
  const resultStr = result ? ` ${colors.dim}${result}${colors.reset}` : '';
  
  console.log(
    `${colors.dim}[${getTimeStr()}]${colors.reset} ` +
    `${fromIcon} ${fromColor}${from}${colors.reset} ` +
    `${colors.green}◀──${colors.reset} ` +
    `${toIcon} ${toColor}${to}${colors.reset}` +
    resultStr + timeStr
  );
}

/**
 * 打印详细信息块
 */
function printDetailBlock(title, items, indent = '    ') {
  console.log(`${indent}${colors.cyan}┌─ ${title}${colors.reset}`);
  for (const item of items) {
    console.log(`${indent}${colors.dim}│${colors.reset}  ${item}`);
  }
  console.log(`${indent}${colors.dim}└─────────────────────${colors.reset}`);
}

/**
 * 打印 Agent 操作
 */
function printAgentAction(agent, action, detail = '') {
  const icon = agentIcons[agent] || '📌';
  const color = agentColors[agent] || colors.dim;
  const detailStr = detail ? ` ${colors.dim}${detail}${colors.reset}` : '';
  
  console.log(
    `${colors.dim}[${getTimeStr()}]${colors.reset} ` +
    `${icon} ${color}[${agent}]${colors.reset} ` +
    `${action}${detailStr}`
  );
}

/**
 * 格式化流式日志输出 - 详细版
 */
function handleStreamEvent(event) {
  switch (event.type) {
    // ===== 请求开始 =====
    case LogEventType.REQUEST_START:
      console.log('');
      printAgentAction(
        AgentName.ORCHESTRATOR, 
        `${colors.bright}接收用户请求${colors.reset}`,
        `"${event.message?.substring(0, 50)}"`
      );
      break;

    // ===== RAG 调用 =====
    case LogEventType.AGENT_CALL_START:
      if (event.agent === AgentName.RAG && event.action === 'smartRetrieve') {
        console.log('');
        printFlow(AgentName.ORCHESTRATOR, AgentName.RAG, '智能向量检索');
        printAgentAction(AgentName.RAG, '解析用户意图 + 查询 Supabase 向量数据库...');
      } else if (event.agent === AgentName.RAG && event.action === 'retrieveMissing') {
        // RAG 重试时的日志由 RAG_RETRY_START 处理
      } else if (event.agent === AgentName.RAG) {
        console.log('');
        printFlow(AgentName.ORCHESTRATOR, AgentName.RAG, '向量检索');
        printAgentAction(AgentName.RAG, '查询 Supabase 向量数据库...');
      } else if (event.agent === AgentName.PLANNER) {
        console.log('');
        printFlow(AgentName.ORCHESTRATOR, AgentName.PLANNER, 'LLM 规划');
        printAgentAction(AgentName.PLANNER, '调用 Gemini 生成执行计划...');
      } else if (event.agent === AgentName.EXECUTOR && event.action === 'execute') {
        console.log('');
        printFlow(AgentName.ORCHESTRATOR, AgentName.EXECUTOR, '执行任务');
      }
      break;

    // ===== RAG 意图解析完成 =====
    case LogEventType.RAG_INTENT_PARSED:
      if (event.targets && event.targets.length > 0) {
        const items = event.targets.map((t, i) => 
          `${colors.yellow}#${i + 1}${colors.reset} ${t}`
        );
        printDetailBlock(`解析出 ${event.targets.length} 个查询目标`, items);
        if (event.reasoning) {
          console.log(`${colors.dim}    └─ 推理: ${event.reasoning}${colors.reset}`);
        }
      }
      break;

    // ===== RAG 重试开始 =====
    case LogEventType.RAG_RETRY_START:
      console.log('');
      printAgentAction(AgentName.RAG, `${colors.yellow}🔄 RAG 重试${colors.reset}`, `第 ${event.retryCount} 次`);
      if (event.missingTargets && event.missingTargets.length > 0) {
        const targetStr = event.missingTargets.join(', ');
        console.log(`${colors.dim}    └─ 缺失目标: ${colors.yellow}${targetStr}${colors.reset}`);
      }
      printFlow(AgentName.ORCHESTRATOR, AgentName.RAG, '针对缺失目标重新检索');
      break;

    // ===== RAG 重试结果 =====
    case LogEventType.RAG_RETRY_RESULT:
      if (event.newHitCount > 0 && event.topHits) {
        const items = event.topHits.map((h, i) => 
          `${colors.green}#${i + 1}${colors.reset} ${h.text}... ${colors.dim}(${(h.score * 100).toFixed(0)}%)${colors.reset}`
        );
        printDetailBlock(`重试找到 ${event.newHitCount} 个新结果`, items);
      } else {
        printAgentAction(AgentName.RAG, `${colors.yellow}重试未找到新结果${colors.reset}`, `目标: ${event.missingTargets?.join(', ')}`);
      }
      printReturn(AgentName.ORCHESTRATOR, AgentName.RAG, `${event.newHitCount} 条新结果`, event.durationMs);
      break;

    // ===== RAG 结果 =====
    case LogEventType.RAG_RESULT:
      if (event.hitCount > 0 && event.topHits) {
        const items = event.topHits.map((h, i) => 
          `${colors.yellow}#${i + 1}${colors.reset} ${h.text}... ${colors.dim}(${(h.score * 100).toFixed(0)}%)${colors.reset}`
        );
        printDetailBlock(`检索到 ${event.hitCount} 个匹配点位`, items);
      } else {
        printAgentAction(AgentName.RAG, '未找到匹配点位');
      }
      printReturn(AgentName.ORCHESTRATOR, AgentName.RAG, `${event.hitCount} 条结果`, event.durationMs);
      break;

    // ===== Planner 结果 =====
    case LogEventType.PLANNER_RESULT:
      // 显示推理过程
      if (event.reasoning) {
        console.log(`${colors.dim}    └─ 推理: ${event.reasoning}${colors.reset}`);
      }
      
      if (event.steps && event.steps.length > 0) {
        const items = event.steps.map((s, i) => {
          let argsStr = '';
          if (s.args && Object.keys(s.args).length > 0) {
            argsStr = ` ${colors.dim}(${Object.entries(s.args).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join(', ')})${colors.reset}`;
          }
          return `${colors.yellow}Step ${i + 1}:${colors.reset} ${colors.green}${s.tool}${colors.reset}${argsStr}`;
        });
        printDetailBlock(`生成 ${event.stepCount} 步执行计划`, items);
      } else if (event.needsClarification) {
        printAgentAction(AgentName.PLANNER, `${colors.yellow}需要澄清用户意图${colors.reset}`);
        // 显示缺失的地图点位（如果有）
        if (event.missingLocations && event.missingLocations.length > 0) {
          console.log(`${colors.dim}    └─ 缺失点位: ${colors.red}${event.missingLocations.join(', ')}${colors.reset}`);
        }
      }
      printReturn(AgentName.ORCHESTRATOR, AgentName.PLANNER, `${event.stepCount} 个步骤`, event.durationMs);
      break;

    // ===== Executor 开始 =====
    case LogEventType.EXECUTOR_START:
      printAgentAction(AgentName.EXECUTOR, `开始执行 ${event.totalSteps} 个步骤`);
      break;

    // ===== Executor 步骤开始 =====
    case LogEventType.EXECUTOR_STEP_START:
      console.log('');
      printFlow(AgentName.EXECUTOR, 'MCP', `Step ${event.stepIndex + 1}: ${event.tool}`);
      if (event.args && Object.keys(event.args).length > 0) {
        const argsStr = Object.entries(event.args)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(', ');
        console.log(`${colors.dim}    └─ 参数: ${argsStr}${colors.reset}`);
      }
      if (event.description) {
        console.log(`${colors.dim}    └─ ${event.description}${colors.reset}`);
      }
      break;

    // ===== Executor 步骤结束 =====
    case LogEventType.EXECUTOR_STEP_END:
      if (event.success) {
        printReturn(AgentName.EXECUTOR, 'MCP', `${colors.green}✓ 成功${colors.reset}`, event.durationMs);
      } else {
        printReturn(AgentName.EXECUTOR, 'MCP', `${colors.red}✗ 失败: ${event.error}${colors.reset}`, event.durationMs);
      }
      break;

    // ===== Executor 完成 =====
    case LogEventType.EXECUTOR_RESULT:
      console.log('');
      printReturn(
        AgentName.ORCHESTRATOR, 
        AgentName.EXECUTOR, 
        `${event.completedSteps}/${event.totalSteps} 步骤完成`, 
        event.durationMs
      );
      break;

    // ===== ReAct 反思开始 =====
    case LogEventType.REFLECT_START:
      console.log('');
      printAgentAction(AgentName.PLANNER, `${colors.magenta}🔄 开始 ReAct 反思${colors.reset}`, `第 ${event.iteration} 轮验证`);
      break;

    // ===== ReAct 反思结果 =====
    case LogEventType.REFLECT_RESULT:
      const goalIcon = event.goalAchieved ? '✅' : '🔄';
      const goalStatus = event.goalAchieved ? '目标已达成' : '目标未达成';
      const confidenceStr = `置信度 ${(event.confidence * 100).toFixed(0)}%`;
      
      printAgentAction(AgentName.PLANNER, `${goalIcon} ${colors.bright}${goalStatus}${colors.reset}`, confidenceStr);
      
      // 显示观察和推理
      if (event.observation) {
        console.log(`${colors.dim}    └─ 观察: ${event.observation}${colors.reset}`);
      }
      if (event.reasoning) {
        console.log(`${colors.dim}    └─ 推理: ${event.reasoning}${colors.reset}`);
      }
      
      // 如果目标未达成且有补救步骤
      if (!event.goalAchieved && event.nextStepsCount > 0) {
        const items = event.nextSteps.map((s, i) => 
          `${colors.yellow}补救 ${i + 1}:${colors.reset} ${colors.green}${s.tool}${colors.reset} ${s.description || ''}`
        );
        printDetailBlock(`生成 ${event.nextStepsCount} 个补救步骤`, items);
      }
      
      // 显示总结
      if (event.summary) {
        console.log(`${colors.cyan}    └─ 总结: ${event.summary}${colors.reset}`);
      }
      
      console.log(`${colors.dim}    └─ 反思耗时: ${event.durationMs}ms${colors.reset}`);
      break;

    // ===== 请求结束 =====
    case LogEventType.REQUEST_END:
      console.log('');
      printAgentAction(
        AgentName.ORCHESTRATOR, 
        `${colors.bright}${event.success ? '✅ 系统协作结束' : '❌ 系统协作失败'}${colors.reset}`,
        `总耗时 ${event.durationMs}ms`
      );
      break;

    // ===== 错误 =====
    case LogEventType.AGENT_CALL_ERROR:
      printAgentAction(event.agent, `${colors.red}✗ 错误: ${event.error}${colors.reset}`);
      break;
  }
}

// 流式日志开关
let streamLoggingEnabled = true;

// MCP 图标（用于展示与 MCP Server 的交互）
agentIcons['MCP'] = '🔌';
agentColors['MCP'] = colors.blue;

async function main() {
  printHeader();

  // 创建 Orchestrator（直接使用，不需要 A2A Server）
  const orchestrator = new OrchestratorAgent();

  // ===== 订阅流式日志事件 =====
  let currentRequestId = null;
  
  streamLogger.on('*', (event) => {
    if (!streamLoggingEnabled) return;
    if (!currentRequestId) return;
    if (event.requestId !== currentRequestId) return;
    
    // 只处理我们关心的事件类型
    const showEvents = [
      LogEventType.REQUEST_START,
      LogEventType.AGENT_CALL_START,
      LogEventType.AGENT_CALL_ERROR,
      LogEventType.RAG_RESULT,
      LogEventType.RAG_INTENT_PARSED,    // 智能检索意图解析
      LogEventType.RAG_RETRY_START,      // RAG 重试开始
      LogEventType.RAG_RETRY_RESULT,     // RAG 重试结果
      LogEventType.PLANNER_RESULT,
      LogEventType.REFLECT_START,
      LogEventType.REFLECT_RESULT,
      LogEventType.EXECUTOR_START,
      LogEventType.EXECUTOR_STEP_START,
      LogEventType.EXECUTOR_STEP_END,
      LogEventType.EXECUTOR_RESULT,
      LogEventType.REQUEST_END,
    ];
    
    if (!showEvents.includes(event.type)) return;
    
    // 使用详细格式处理事件
    handleStreamEvent(event);
  });

  // 检查依赖
  // print('正在检查系统状态...', colors.yellow);
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
    print('✅ All Agents are ready', colors.green);
    // console.log('');
  }

  // 创建会话
  const sessionId = uuidv4();
  print(`session ID: ${sessionId}`, colors.dim);
  // print(`流式日志: ${streamLoggingEnabled ? '已开启' : '已关闭'} (使用 /stream 切换)`, colors.dim);
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
      await handleCommand(input, orchestrator, sessionId, rl, () => currentRequestId);
      rl.prompt();
      return;
    }

    // 处理用户消息
    try {
      print('', colors.reset);
      
      if (streamLoggingEnabled) {
        print('═'.repeat(70), colors.cyan);
        print('  🌍 Multi-Agent 协作链路', colors.cyan);
        print('═'.repeat(70), colors.cyan);
      } else {
        print('思考中...', colors.dim);
      }

      // 生成一个临时 requestId 用于匹配日志事件
      // 实际的 requestId 会在 chat 方法内部生成，我们通过事件来捕获
      let capturedRequestId = null;
      const captureListener = (event) => {
        if (event.type === LogEventType.REQUEST_START && !capturedRequestId) {
          capturedRequestId = event.requestId;
          currentRequestId = capturedRequestId;
        }
      };
      streamLogger.on(LogEventType.REQUEST_START, captureListener);

      const response = await orchestrator.chat({
        message: input,
        sessionId,
      });

      // 移除监听器
      streamLogger.off(LogEventType.REQUEST_START, captureListener);
      currentRequestId = null;

      // 如果没有流式日志，清除 "思考中..."
      if (!streamLoggingEnabled) {
        process.stdout.write('\x1b[1A\x1b[2K');
      }

      // 显示分隔线
      if (streamLoggingEnabled) {
        print('═'.repeat(70), colors.cyan);
      }

      // 显示最终回答
      // print('');
      // print('Agent 概括:', colors.blue);
      // const answerLines = response.answer.split('\n');
      // for (const line of answerLines) {
      //   print(`  ${line}`, colors.reset);
      // }

      // 如果不是流式模式，显示详细信息
      if (!streamLoggingEnabled) {
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
          print('📍 RAG 检索结果:', colors.cyan);
          for (const hit of response.ragHits.slice(0, 3)) {
            const name = hit.chunkText ? hit.chunkText.substring(0, 50) + '...' : '未命名';
            const score = (hit.score * 100).toFixed(0);
            print(`   - ${name} (${score}%)`, colors.dim);
          }
        }

        print('');
        print(`⏱️  总耗时: ${response.durationMs}ms`, colors.dim);
      }
      
      print('');

    } catch (error) {
      currentRequestId = null;
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

async function handleCommand(input, orchestrator, sessionId, rl, getCurrentRequestId) {
  const [cmd, ...args] = input.slice(1).split(' ');

  switch (cmd.toLowerCase()) {
    case 'help':
      print('');
      print('可用命令:', colors.cyan);
      print('  /help              - 显示帮助', colors.reset);
      print('  /status            - 检查系统状态', colors.reset);
      print('  /stream            - 切换流式日志显示', colors.reset);
      print('  /clear             - 清除会话历史', colors.reset);
      print('  /history           - 显示会话历史', colors.reset);
      print('  /quit, /exit, /q   - 退出', colors.reset);
      print('');
      print('示例对话:', colors.cyan);
      print('  "让无人机起飞到1.5米"', colors.reset);
      print('  "飞到起点位置"', colors.reset);
      print('  "执行巡逻任务"', colors.reset);
      print('');
      print('架构说明:', colors.cyan);
      print('  本系统采用多 Agent 架构 + ReAct 模式：', colors.reset);
      print('  1. Orchestrator Agent - 核心编排，接收请求并调度其他Agent', colors.dim);
      print('  2. RAG Agent - 向量检索，从 Supabase 检索地图点位信息', colors.dim);
      print('  3. Planner Agent - 任务规划 + 反思验证，使用 Gemini LLM', colors.dim);
      print('  4. Executor Agent - 执行器，通过 MCP 协议控制无人机', colors.dim);
      print('');
      print('ReAct 循环 (最多3轮):', colors.cyan);
      print('  Plan   → 根据用户意图生成执行计划', colors.dim);
      print('  Act    → 执行计划中的工具调用', colors.dim);
      print('  Observe→ 获取执行后的无人机状态', colors.dim);
      print('  Reflect→ LLM 反思是否达成目标，未达成则继续循环', colors.dim);
      print('');
      break;

    case 'stream':
      streamLoggingEnabled = !streamLoggingEnabled;
      print('');
      print(`流式日志已${streamLoggingEnabled ? '开启' : '关闭'}`, streamLoggingEnabled ? colors.green : colors.yellow);
      if (streamLoggingEnabled) {
        print('现在可以实时看到 Agent 调用链路', colors.dim);
      }
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

