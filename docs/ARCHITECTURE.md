## DPW-Agent 多 Agent 协作设计

### Agent 角色分工

系统由 4 个核心 Agent 组成，通过 A2A (Agent-to-Agent) 协议协作：

- **Orchestrator Agent** ：总指挥，管理对话上下文与 ReAct 循环控制
- **RAG Agent** ：知识检索，将用户查询转为可信的地图点位信息  
- **Planner Agent** ：LLM 推理，生成可执行计划并反思验证
- **Executor Agent** ：工具执行，通过 MCP 协议调用无人机控制命令

### 协作流程（ReAct 循环）

一次完整请求（例如"飞到起点"）的处理链路：

1. **初始化阶段**：
   - Orchestrator 接收用户请求 → 创建/获取 Session
   - 并行调用 RAG Agent 检索点位信息 + Executor Agent 获取当前无人机状态

2. **ReAct 循环**（最多 3 轮 Plan-Act-Observe-Reflect）：
   - **Plan**: Planner Agent 生成执行步骤（基于 RAG 命中 + 状态 + 可用工具）
   - **Act**: Executor Agent 按步骤调用 MCP 工具执行（起飞/移动等）
   - **Observe**: Executor 再次获取执行后状态
   - **Reflect**: Planner 判断目标达成度（confidence ≥ 0.8 则完成，否则进入下一轮）

3. **最终响应**：Orchestrator 聚合结果返回给用户

### Agent 技能定义

| Agent | 核心技能 | 输入 | 输出 |
|-------|----------|------|------|
| Orchestrator | `chat` | 用户自然语言请求 | 编排结果（包含规划/执行/反思） |
| RAG | `retrieve` | 用户查询意图 | 向量检索命中（含坐标元数据） |
| Planner | `plan`<br>`reflect` | 用户请求+RAG+状态+工具<br>执行结果+当前状态 | 执行步骤列表+推理<br>达成判断+总结+补救步骤 |
| Executor | `execute`<br>`listTools`<br>`getDroneState` | 执行步骤<br>无<br>无 | 执行结果<br>可用工具列表<br>无人机当前状态 |