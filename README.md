# DPW-Agent

无人机智能控制 Agent 系统，基于 A2A 协议实现多 Agent 协作，集成 RAG 检索和 MCP 工具调用。

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        DPW-Agent                                 │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐         │
│  │ OrchestratorAgent │ ←───────────────────────────────────┐    │
│  │  (调度中心)    │   │              │   │              │   │    │
│  └───────┬──────┘   │  PlannerAgent │   │  ExecutorAgent│   │    │
│          │          │  (任务规划)    │   │  (MCP Client) │   │    │
│          │          └───────┬──────┘   └───────┬──────┘   │    │
│          │                  │                  │          │    │
│          │   ┌──────────────┴──────────────────┘          │    │
│          │   │                                            │    │
│          │   │  ┌──────────────┐                          │    │
│          └───┼──│   RagAgent   │                          │    │
│              │  │ (向量检索)    │                          │    │
│              │  └───────┬──────┘                          │    │
│              │          │                                 │    │
└──────────────┼──────────┼─────────────────────────────────┼────┘
               │          │                                 │
               ▼          ▼                                 ▼
        ┌──────────┐  ┌──────────┐                  ┌──────────────┐
        │  Gemini  │  │ Supabase │                  │  MCP Server  │
        │   API    │  │ (pgvector)│                  │ (drone.*)    │
        └──────────┘  └──────────┘                  └──────────────┘
```

## 快速开始

### 1. 安装依赖

```bash
cd DPW-Agent
npm install
```

### 2. 配置环境变量

复制 `env.example.txt` 为 `.env` 并填写：

```bash
# Google Gemini API
GEMINI_API_KEY=your_gemini_api_key_here

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
```

### 3. 启动服务

**方式一：一键启动所有 Agent**

```bash
npm start
```

**方式二：分别启动各个 Agent**

```bash
# 终端 1 - RAG Agent
npm run agent:rag

# 终端 2 - Planner Agent
npm run agent:planner

# 终端 3 - Executor Agent
npm run agent:executor

# 终端 4 - Orchestrator Agent
npm run agent:orchestrator
```

### 4. 使用

**CLI 模式：**

```bash
npm run agent:cli
```

**Web API 模式：**

```bash
npm run agent:server
```

然后访问 `http://localhost:3000/api/chat`

## API 接口

### POST /api/chat

发送聊天消息，执行无人机控制任务。

**请求：**
```json
{
  "message": "让无人机起飞到1.5米，然后飞到起点位置",
  "sessionId": "可选的会话ID",
  "mapId": "可选的地图ID",
  "filters": {
    "tags": ["起点"],
    "topK": 5
  }
}
```

**响应：**
```json
{
  "success": true,
  "sessionId": "xxx",
  "answer": "已执行...",
  "plan": [
    { "tool": "drone.take_off", "args": { "altitude": 1.5 } },
    { "tool": "drone.move_to", "args": { "x": 0, "z": 0 } }
  ],
  "toolCalls": [...],
  "ragHits": [...],
  "durationMs": 1234
}
```

### GET /api/health

健康检查，返回各 Agent 状态。

### POST /api/sessions

创建新会话。

### GET /api/sessions/:id/history

获取会话历史。

### DELETE /api/sessions/:id

清除会话。

## Agent 说明

### OrchestratorAgent (端口 9000)

- 统一入口，接收用户请求
- 调度其他 Agent 协作
- 管理多轮对话上下文

### PlannerAgent (端口 9001)

- 将自然语言转换为执行计划
- 结合 RAG 知识进行规划
- 生成工具调用序列

### RagAgent (端口 9002)

- 查询向量化（Gemini text-embedding-004）
- Supabase 向量检索
- 结果后处理（去重、过滤、排序）

### ExecutorAgent (端口 9003)

- MCP Client，连接 DronePilotWeb MCP Server
- 执行 drone.* 工具调用
- 错误处理和重试

## 与 DronePilotWeb 集成

1. 确保 DronePilotWeb 的 MCP Server 正在运行
2. 确保浏览器模拟器页面已打开（建立 WebSocket 连接）
3. DPW-Agent 的 ExecutorAgent 会通过 MCP 协议调用无人机工具

## 开发

### 项目结构

```
DPW-Agent/
├── src/
│   ├── a2a/                 # A2A 协议实现
│   │   ├── types.js         # 类型定义
│   │   ├── AgentServer.js   # Agent 服务器
│   │   └── AgentClient.js   # Agent 客户端
│   ├── agents/              # Agent 实现
│   │   ├── definitions.js   # Agent 定义
│   │   ├── orchestrator/    # 编排 Agent
│   │   ├── planner/         # 规划 Agent
│   │   ├── rag/             # RAG Agent
│   │   └── executor/        # 执行 Agent
│   ├── llm/                 # LLM 提供者
│   │   └── GeminiProvider.js
│   ├── vector/              # 向量数据库
│   │   └── SupabaseClient.js
│   ├── interfaces/          # 用户接口
│   │   ├── cli.js           # CLI
│   │   └── webServer.js     # Web API
│   └── utils/               # 工具函数
│       └── logger.js
├── package.json
└── README.md
```

### 添加新 Agent

1. 在 `src/agents/` 下创建新目录
2. 实现 Agent 逻辑和 server.js
3. 在 `src/agents/definitions.js` 中添加 AgentCard
4. 在 `package.json` 中添加启动脚本

## 协议说明

- **A2A (Agent-to-Agent)**: Agent 间通信协议，参考 https://a2a-protocol.org/
- **MCP (Model Context Protocol)**: Agent 到工具的调用协议，用于控制无人机

## License

MIT

