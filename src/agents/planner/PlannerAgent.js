/**
 * Planner Agent
 * 将用户需求 + RAG 知识 转换为可执行的无人机控制步骤
 */

import { getGeminiProvider } from '../../llm/GeminiProvider.js';
import { createLogger } from '../../utils/logger.js';

// 可用工具定义
const AVAILABLE_TOOLS = {
  'drone.get_state': {
    description: '获取无人机当前状态（位置、是否活跃等）',
    args: {},
  },
  'drone.take_off': {
    description: '无人机起飞到指定高度',
    args: {
      altitude: { type: 'number', default: 1.0, description: '目标高度（米）' },
    },
  },
  'drone.land': {
    description: '无人机降落到地面',
    args: {},
  },
  'drone.hover': {
    description: '无人机悬停，取消当前所有任务',
    args: {},
  },
  'drone.move_to': {
    description: '移动无人机到指定3D坐标位置',
    args: {
      x: { type: 'number', required: true, description: 'X坐标' },
      y: { type: 'number', description: 'Y坐标（高度），不指定则保持当前高度' },
      z: { type: 'number', required: true, description: 'Z坐标' },
      maxSpeed: { type: 'number', description: '最大飞行速度（米/秒）' },
    },
  },
  'drone.move_relative': {
    description: '相对移动（支持 world/body 两种参考系，默认 world：+X向右、+Z向下、+Y向上）',
    args: {
      frame: { type: 'string', description: "参考系：'world'(默认) 或 'body'(相对无人机朝向)" },
      forward: { type: 'number', description: '前进距离（米，正=前进，负=后退）' },
      right: { type: 'number', description: '右移距离（米，正=向右，负=向左）' },
      up: { type: 'number', description: '上升距离（米，正=上升，负=下降）' },
      maxSpeed: { type: 'number', description: '最大飞行速度（米/秒）' },
    },
  },
  'drone.run_mission': {
    description: '执行航线任务，按顺序飞过一系列航点。每个航点是一个对象，必须包含 type 字段',
    args: {
      waypoints: {
        type: 'array',
        required: true,
        description: `航点数组。每个航点必须包含 type 字段，支持以下类型：
  - { type: "moveTo", x: number, y: number, z: number } - 移动到指定坐标
  - { type: "takeOff", altitude: number } - 起飞到指定高度
  - { type: "land" } - 降落
  - { type: "hover", durationMs: number } - 悬停指定时间(毫秒)
示例: [{ "type": "moveTo", "x": 2, "y": 1, "z": -2 }, { "type": "moveTo", "x": 4, "y": 1, "z": -2 }]`,
      },
    },
  },
  'drone.cancel': {
    description: '取消当前所有任务并悬停',
    args: {},
  },
  'drone.pause': {
    description: '暂停当前任务执行',
    args: {},
  },
  'drone.resume': {
    description: '继续执行暂停的任务',
    args: {},
  },
};

// 系统提示词
const SYSTEM_PROMPT = `你是一个无人机飞行任务规划助手。你的任务是根据用户的自然语言请求和提供的地图点位信息，生成可执行的无人机控制步骤。

## 可用工具

${Object.entries(AVAILABLE_TOOLS).map(([name, info]) => {
  const argsDesc = Object.entries(info.args)
    .map(([argName, argInfo]) => `    - ${argName}: ${argInfo.description}${argInfo.required ? ' (必填)' : ''}`)
    .join('\n');
  return `### ${name}
${info.description}
${argsDesc ? '参数:\n' + argsDesc : '无参数'}`;
}).join('\n\n')}

## 输出格式

请严格按照以下 JSON 格式输出：

{
  "reasoning": "你的思考过程，解释为什么这样规划",
  "needsClarification": false,
  "clarificationQuestion": null,
  "steps": [
    {
      "tool": "drone.xxx",
      "args": { ... },
      "description": "这一步做什么"
    }
  ]
}

## 规划原则

1. **安全第一**：如果无人机在地面，必须先起飞再移动
2. **坐标/相对移动**：
   - **坐标系约定**：地面平面以中轴交点为原点，**+X 向右、+Z 向下、+Y 向上**；在 frame="world" 下，用户说“前进/向前”默认对应 **-Z（屏幕向上）**。
   - 如果用户给出“向右/向左/向上/向下/前进/后退”等指令但未明确“相对于朝向”，优先用 **drone.move_relative** 且设置 frame="world"，不要要求用户提供绝对坐标。
   - 如果用户明确说“相对于无人机当前朝向”，使用 **drone.move_relative** 且设置 frame="body"。
   - 如果用户提到具体点位（如“去起点/去A点”），优先使用 RAG 检索到的世界坐标（worldX/worldY/worldZ）配合 **drone.move_to**。
   - 如果用户要求“画形状/走三角形/走正方形”等但未给出尺寸，默认采用 **2 米边长**（安全、可控），并用 move_relative 或 run_mission 实现；仅在确实无法推断时才澄清。
3. **合理高度**：默认飞行高度 1.0 米，除非用户或点位信息指定其他高度
4. **路径优化**：如果有多个目标点，考虑最短路径
5. **任务结束**：除非用户要求降落，否则保持悬停状态

## 特殊情况处理

- 如果用户请求不明确（如"去那边"但没有具体位置），设置 needsClarification = true 并提出问题
- 如果没有找到匹配的地图点位，告知用户并建议使用具体坐标
- 如果用户要求去的地点标记为"危险区"，在 reasoning 中说明风险`;

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
   * @returns {Promise<Object>} - 执行计划
   */
  async plan(userRequest, ragHits = [], droneState = null) {
    const startTime = Date.now();
    this.logger.info(`Planning for: "${userRequest.substring(0, 50)}..."`);

    try {
      // 构建提示词
      const prompt = this._buildPrompt(userRequest, ragHits, droneState);

      // 调用 Gemini 生成计划
      const result = await this.gemini.generateJSON(prompt, {
        temperature: 0.3, // 规划用较低温度保证稳定性
      });

      // 验证和清洗结果
      const plan = this._validatePlan(result);

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
  _buildPrompt(userRequest, ragHits, droneState) {
    const parts = [SYSTEM_PROMPT, '', '---', '', '## 当前任务'];

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
   * 验证和清洗计划
   * @private
   */
  _validatePlan(result) {
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
        if (!step.tool || !AVAILABLE_TOOLS[step.tool]) {
          this.logger.warn(`Invalid tool: ${step.tool}, skipping`);
          continue;
        }

        plan.steps.push({
          tool: step.tool,
          args: step.args || {},
          description: step.description || '',
        });
      }
    }

    return plan;
  }

  /**
   * 获取可用工具列表
   * @returns {Object}
   */
  getAvailableTools() {
    return AVAILABLE_TOOLS;
  }
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

