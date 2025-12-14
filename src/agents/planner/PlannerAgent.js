/**
 * Planner Agent
 * 将用户需求 + RAG 知识 转换为可执行的无人机控制步骤
 */

import { getGeminiProvider } from '../../llm/GeminiProvider.js';
import { createLogger } from '../../utils/logger.js';

// 系统提示词（工具列表由上游通过 MCP 协议动态注入）
const SYSTEM_PROMPT = `你是一个无人机飞行任务规划助手。你的任务是根据用户的自然语言请求、地图点位信息、无人机状态，以及“可用工具列表”，生成可执行的无人机控制步骤。

## 关键约束（必须遵守）

1. **只能使用输入里提供的可用工具列表**（工具名称必须完全匹配，不要自行发明工具名）
2. **参数必须符合对应工具的 inputSchema**（字段名/类型尽量匹配；缺少必要信息时再澄清）
3. **输出必须是严格 JSON**，不要输出任何额外文字

## 输出格式（严格遵守）

{
  "reasoning": "你的思考过程，解释为什么这样规划",
  "needsClarification": false,
  "clarificationQuestion": null,
  "steps": [
    {
      "tool": "tool.name",
      "args": { },
      "description": "这一步做什么"
    }
  ]
}

## 规划原则

1. **安全第一**：如果无人机在地面，必须先起飞再移动（除非工具/状态明确允许地面移动）
2. **坐标/相对移动**：
   - **坐标系约定**：地面平面以中轴交点为原点，**+X 向右、+Z 向下、+Y 向上**；若所选工具采用 world 参考系，用户说“前进/向前”默认对应 **-Z（屏幕向上）**。
   - 如果用户给出“向右/向左/向上/向下/前进/后退”等指令但未明确“相对于朝向”，优先选择“相对移动”类工具；如果该工具的 inputSchema 支持参考系参数（例如 world/body），则优先选择 world 参考系。
   - 如果用户明确说“相对于无人机当前朝向”，优先选择“相对移动”类工具；如果该工具支持 body 参考系，则使用 body。
   - 如果用户提到具体点位（如“去起点/去A点”），优先从 RAG 检索结果中抽取世界坐标并使用“移动到坐标”类工具。
   - 如果用户要求“画形状/走三角形/走正方形”等但未给出尺寸，默认采用 **2 米边长**（安全、可控）；仅在确实无法推断时才澄清。
3. **合理高度**：默认飞行高度 1.0 米，除非用户或点位信息指定其他高度
4. **任务结束**：除非用户要求降落，否则保持悬停/保持当前位置（按可用工具选择）

## 特殊情况处理

- 如果用户请求不明确（如"去那边"但没有具体位置），设置 needsClarification = true 并提出问题
- 如果没有找到匹配的地图点位，告知用户并建议使用更具体的地点名或坐标`;

export class PlannerAgent {
  /**
   * @param {Object} [config]
   * @param {GeminiProvider} [config.geminiProvider]
   */
  constructor(config = {}) {
    this.gemini = config.geminiProvider || getGeminiProvider();
    this.logger = createLogger('PlannerAgent');
  }

  /**
   * 生成执行计划
   * @param {string} userRequest - 用户请求
   * @param {Array} ragHits - RAG 检索结果
   * @param {Object} [droneState] - 无人机当前状态
   * @param {Array} [availableTools] - MCP Server 动态发现的可用工具列表
   * @returns {Promise<Object>} - 执行计划
   */
  async plan(userRequest, ragHits = [], droneState = null, availableTools = []) {
    const startTime = Date.now();
    this.logger.info(`Planning for: "${userRequest.substring(0, 50)}..."`);

    try {
      // 构建提示词
      const prompt = this._buildPrompt(userRequest, ragHits, droneState, availableTools);

      // 调用 Gemini 生成计划
      const result = await this.gemini.generateJSON(prompt, {
        temperature: 0.3, // 规划用较低温度保证稳定性
      });

      // 验证和清洗结果
      const plan = this._validatePlan(result, availableTools);

      const durationMs = Date.now() - startTime;
      this.logger.info(`Generated plan with ${plan.steps?.length || 0} steps in ${durationMs}ms`);

      return {
        ...plan,
        durationMs,
      };
    } catch (error) {
      this.logger.error('Planning failed:', error.message);
      throw error;
    }
  }

  /**
   * 构建规划提示词
   * @private
   */
  _buildPrompt(userRequest, ragHits, droneState, availableTools) {
    const parts = [SYSTEM_PROMPT, '', '---', '', '## 当前任务'];

    // 可用工具（来自 MCP listTools）
    parts.push('**可用工具列表（来自 MCP Server / listTools）**:');
    parts.push(this._formatToolsForPrompt(availableTools));
    parts.push('');

    // 用户请求
    parts.push(`**用户请求**: ${userRequest}`);
    parts.push('');

    // RAG 知识
    if (ragHits && ragHits.length > 0) {
      parts.push('**地图点位信息**:');
      for (let i = 0; i < ragHits.length; i++) {
        const hit = ragHits[i];
        const { chunkText, score } = hit;
        if (chunkText) {
          parts.push(`- **检索结果 ${i + 1}** (相似度: ${(score * 100).toFixed(0)}%)`);
          parts.push(`  ${chunkText}`);
        }
      }
      parts.push('');
      parts.push('**注意**: 请从上述检索结果中提取坐标信息。坐标格式通常为 (x, z) 或包含 x=, z= 的描述。');
      parts.push('');
    } else {
      parts.push('**地图点位信息**: 未找到相关点位');
      parts.push('');
    }

    // 无人机状态
    if (droneState) {
      parts.push('**无人机当前状态**:');
      parts.push(`- 位置: x=${droneState.position?.x?.toFixed(2) || 0}, y=${droneState.position?.y?.toFixed(2) || 0}, z=${droneState.position?.z?.toFixed(2) || 0}`);
      parts.push(`- 状态: ${droneState.isActive ? '执行中' : '空闲'}`);
      parts.push('');
    }

    parts.push('请根据以上信息生成执行计划（JSON 格式）:');

    return parts.join('\n');
  }

  /**
   * 格式化可用工具列表供提示词使用
   * @private
   */
  _formatToolsForPrompt(availableTools) {
    if (!Array.isArray(availableTools) || availableTools.length === 0) {
      return '（未提供可用工具；请设置 needsClarification=true 并说明无法规划）';
    }

    const lines = [];
    for (const tool of availableTools) {
      const name = tool?.name ? String(tool.name) : null;
      if (!name) continue;

      const description = tool?.description ? String(tool.description) : '';
      const inputSchema = tool?.inputSchema ?? tool?.parameters ?? tool?.schema ?? null;

      lines.push(`- name: ${name}`);
      if (description) lines.push(`  description: ${description}`);
      if (inputSchema) lines.push(`  inputSchema: ${JSON.stringify(inputSchema)}`);
    }

    return lines.join('\n') || '（可用工具列表为空）';
  }

  /**
   * 验证和清洗计划
   * @private
   */
  _validatePlan(result, availableTools) {
    const allowedToolNames = new Set(
      (Array.isArray(availableTools) ? availableTools : [])
        .map(t => t?.name)
        .filter(Boolean)
        .map(String)
    );

    if (allowedToolNames.size === 0) {
      // 没有工具列表就无法保证协议一致性，直接失败让上游处理
      throw new Error('No availableTools provided; cannot generate a valid plan');
    }

    // 确保必要字段存在
    const plan = {
      reasoning: result.reasoning || '',
      needsClarification: Boolean(result.needsClarification),
      clarificationQuestion: result.clarificationQuestion || null,
      steps: [],
    };

    // 验证步骤
    if (Array.isArray(result.steps)) {
      for (const step of result.steps) {
        const toolName = step?.tool ? String(step.tool) : '';
        if (!toolName || !allowedToolNames.has(toolName)) {
          this.logger.warn(`Invalid tool (not in availableTools): ${toolName || '(empty)'}, skipping`);
          continue;
        }

        plan.steps.push({
          tool: toolName,
          args: (step.args && typeof step.args === 'object') ? step.args : {},
          description: step.description ? String(step.description) : '',
        });
      }
    }

    return plan;
  }

  // 不再暴露硬编码工具列表；工具由 MCP Server 动态发现并注入
}

// 单例
let instance = null;

export function getPlannerAgent(config) {
  if (!instance) {
    instance = new PlannerAgent(config);
  }
  return instance;
}

export function resetPlannerAgent() {
  instance = null;
}

