/**
 * Agent 定义 - AgentCards 和 Skills
 * 定义各个 Agent 的元数据、技能和端口配置
 */

import { createAgentCard } from '../a2a/types.js';

// 默认端口配置
export const DEFAULT_PORTS = {
  orchestrator: parseInt(process.env.A2A_ORCHESTRATOR_PORT) || 9000,
  planner: parseInt(process.env.A2A_PLANNER_PORT) || 9001,
  rag: parseInt(process.env.A2A_RAG_PORT) || 9002,
  executor: parseInt(process.env.A2A_EXECUTOR_PORT) || 9003,
};

// Agent URLs
export function getAgentUrl(agentName, port) {
  return `http://localhost:${port || DEFAULT_PORTS[agentName]}`;
}

/**
 * Orchestrator Agent Card
 * 统一入口、对话上下文、调度（RAG→Plan→Execute）
 */
export const OrchestratorAgentCard = createAgentCard({
  name: 'orchestrator',
  description: '无人机控制系统编排 Agent，负责接收用户请求、调度其他 Agent 协作完成任务',
  url: getAgentUrl('orchestrator'),
  version: '1.0.0',
  skills: [
    {
      id: 'chat',
      name: '对话处理',
      description: '处理用户自然语言请求，协调 RAG/Planner/Executor 完成任务',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: '用户消息' },
          sessionId: { type: 'string', description: '会话 ID' },
          mapId: { type: 'string', description: '地图 ID（可选）' },
          filters: { type: 'object', description: '过滤条件（可选）' },
        },
        required: ['message'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          answer: { type: 'string', description: '回答文本' },
          plan: { type: 'array', description: '执行计划' },
          toolCalls: { type: 'array', description: '工具调用记录' },
          ragHits: { type: 'array', description: 'RAG 检索结果' },
        },
      },
    },
  ],
});

/**
 * Planner Agent Card
 * 将需求转成可执行工具调用序列
 */
export const PlannerAgentCard = createAgentCard({
  name: 'planner',
  description: '任务规划 Agent，将用户需求和 RAG 知识转换为可执行的无人机控制步骤',
  url: getAgentUrl('planner'),
  version: '1.0.0',
  skills: [
    {
      id: 'plan',
      name: '任务规划',
      description: '根据用户意图和地图点位知识，生成无人机控制步骤序列',
      inputSchema: {
        type: 'object',
        properties: {
          userRequest: { type: 'string', description: '用户请求' },
          availableTools: {
            type: 'array',
            description: '从 MCP Server 动态发现的可用工具列表（listTools）',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                inputSchema: { type: 'object' },
              },
              required: ['name'],
            },
          },
          ragHits: { 
            type: 'array', 
            description: 'RAG 检索结果，包含点位信息',
            items: {
              type: 'object',
              properties: {
                chunkText: { type: 'string' },
                score: { type: 'number' },
                metadata: { type: 'object' },
              },
            },
          },
          droneState: { type: 'object', description: '无人机当前状态（可选）' },
        },
        required: ['userRequest'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: '执行步骤列表',
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string', description: '工具名称' },
                args: { type: 'object', description: '工具参数' },
                description: { type: 'string', description: '步骤描述' },
              },
            },
          },
          reasoning: { type: 'string', description: '规划推理过程' },
          needsClarification: { type: 'boolean', description: '是否需要用户澄清' },
          clarificationQuestion: { type: 'string', description: '澄清问题' },
        },
      },
    },
    {
      id: 'reflect',
      name: '执行反思',
      description: 'ReAct 模式的反思阶段：检查执行结果是否达成目标，如未达成则生成补救步骤',
      inputSchema: {
        type: 'object',
        properties: {
          originalRequest: { type: 'string', description: '用户原始请求' },
          previousPlan: { type: 'object', description: '之前执行的计划' },
          executionResult: { type: 'object', description: '执行结果' },
          currentDroneState: { type: 'object', description: '执行后的无人机状态' },
          ragHits: { type: 'array', description: 'RAG 检索结果（目标点位信息）' },
          availableTools: { type: 'array', description: '可用工具列表' },
        },
        required: ['originalRequest', 'executionResult'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          observation: { type: 'string', description: '对当前状态的客观描述' },
          reasoning: { type: 'string', description: '分析目标是否达成的推理过程' },
          goalAchieved: { type: 'boolean', description: '目标是否已达成' },
          confidence: { type: 'number', description: '判断置信度 0.0-1.0' },
          nextSteps: {
            type: 'array',
            description: '补救步骤（仅当 goalAchieved=false 时）',
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string' },
                args: { type: 'object' },
                description: { type: 'string' },
              },
            },
          },
          summary: { type: 'string', description: '给用户的简短总结' },
        },
      },
    },
  ],
});

/**
 * RAG Agent Card
 * embedding + Supabase RPC 检索 + 结果清洗/过滤
 */
export const RagAgentCard = createAgentCard({
  name: 'rag',
  description: 'RAG 检索 Agent，负责将查询转为向量并从 Supabase 检索相关地图点位知识',
  url: getAgentUrl('rag'),
  version: '1.0.0',
  skills: [
    {
      id: 'retrieve',
      name: '知识检索',
      description: '根据查询文本检索相关的地图点位知识',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '查询文本' },
          filters: {
            type: 'object',
            properties: {
              mapId: { type: 'string', description: '地图 ID' },
              tags: { type: 'array', items: { type: 'string' }, description: '标签过滤' },
              topK: { type: 'number', description: '返回数量', default: 5 },
              threshold: { type: 'number', description: '相似度阈值', default: 0.5 },
            },
          },
        },
        required: ['query'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          hits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                chunkText: { type: 'string', description: '文档片段' },
                score: { type: 'number', description: '相似度分数' },
                metadata: {
                  type: 'object',
                  properties: {
                    worldX: { type: 'number' },
                    worldY: { type: 'number' },
                    worldZ: { type: 'number' },
                    name: { type: 'string' },
                    tags: { type: 'array' },
                  },
                },
              },
            },
          },
          totalFound: { type: 'number' },
        },
      },
    },
  ],
});

/**
 * Executor Agent Card
 * MCP Client，负责工具执行与错误处理
 */
export const ExecutorAgentCard = createAgentCard({
  name: 'executor',
  description: '执行 Agent，作为 MCP Client 调用无人机控制工具（drone.*）',
  url: getAgentUrl('executor'),
  version: '1.0.0',
  skills: [
    {
      id: 'execute',
      name: '执行控制命令',
      description: '执行一系列无人机控制步骤',
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: '要执行的步骤列表',
            items: {
              type: 'object',
              properties: {
                tool: { 
                  type: 'string',
                  description: '工具名称（必须来自 MCP Server / listTools 暴露的工具名）',
                },
                args: { type: 'object', description: '工具参数' },
              },
              required: ['tool'],
            },
          },
          stopOnError: { type: 'boolean', default: true, description: '遇错是否停止' },
        },
        required: ['steps'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                step: { type: 'number' },
                tool: { type: 'string' },
                success: { type: 'boolean' },
                result: { type: 'object' },
                error: { type: 'string' },
                durationMs: { type: 'number' },
              },
            },
          },
          allSuccess: { type: 'boolean' },
          totalDurationMs: { type: 'number' },
        },
      },
    },
    {
      id: 'listTools',
      name: '发现可用工具',
      description: '从 MCP Server 动态获取可用工具列表（协议发现）',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: {
        type: 'object',
        properties: {
          tools: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                inputSchema: { type: 'object' },
              },
              required: ['name'],
            },
          },
        },
      },
    },
    {
      id: 'getDroneState',
      name: '获取无人机状态',
      description: '获取无人机当前状态（特例：作为规划的重要上下文，通过 MCP 协议调用 drone.get_state）',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: {
        type: 'object',
        properties: {
          position: {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              z: { type: 'number' },
            },
          },
          isActive: { type: 'boolean' },
          queueLength: { type: 'number' },
        },
      },
    },
  ],
});

/**
 * 所有 Agent 配置
 */
export const AGENTS = {
  orchestrator: {
    card: OrchestratorAgentCard,
    port: DEFAULT_PORTS.orchestrator,
  },
  planner: {
    card: PlannerAgentCard,
    port: DEFAULT_PORTS.planner,
  },
  rag: {
    card: RagAgentCard,
    port: DEFAULT_PORTS.rag,
  },
  executor: {
    card: ExecutorAgentCard,
    port: DEFAULT_PORTS.executor,
  },
};

