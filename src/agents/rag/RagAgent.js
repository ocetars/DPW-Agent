/**
 * RAG Agent
 * 负责：query → embedding → Supabase RPC 检索 → 结果后处理
 * 极简模式：从检索到的句子中用 LLM 提取坐标
 */

import { getGeminiProvider } from '../../llm/GeminiProvider.js';
import { getSupabaseClient } from '../../vector/SupabaseClient.js';
import { createLogger } from '../../utils/logger.js';

export class RagAgent {
  /**
   * @param {Object} [config]
   * @param {GeminiProvider} [config.geminiProvider]
   * @param {SupabaseVectorClient} [config.supabaseClient]
   */
  constructor(config = {}) {
    this.gemini = config.geminiProvider || getGeminiProvider();
    this.supabase = config.supabaseClient || getSupabaseClient();
    this.logger = createLogger('RagAgent');
  }

  /**
   * 执行 RAG 检索
   * @param {string} query - 查询文本
   * @param {Object} [filters] - 过滤条件
   * @returns {Promise<Object>} - 检索结果
   */
  async retrieve(query, filters = {}) {
    const startTime = Date.now();
    this.logger.info(`Retrieving for query: "${query.substring(0, 50)}..."`);

    try {
      // 1. 生成查询向量
      const queryEmbedding = await this.gemini.embed(query);
      this.logger.debug(`Generated embedding with ${queryEmbedding.length} dimensions`);

      // 2. 向量检索
      const {
        mapId,
        topK = 5,
        threshold = 0.5,
      } = filters;

      const rawResults = await this.supabase.search(queryEmbedding, {
        mapId,
        topK: topK + 3, // 多检索一些用于后处理
        threshold,
      });

      // 3. 后处理：过滤、排序
      const processedResults = this._postProcess(rawResults, {
        topK,
        threshold,
      });

      const durationMs = Date.now() - startTime;
      this.logger.info(`Retrieved ${processedResults.length} results in ${durationMs}ms`);

      return {
        hits: processedResults,
        totalFound: rawResults.length,
        query,
        filters,
        durationMs,
      };
    } catch (error) {
      this.logger.error('Retrieve failed:', error.message);
      throw error;
    }
  }

  /**
   * 后处理检索结果
   * @private
   */
  _postProcess(results, options = {}) {
    const {
      topK = 5,
      threshold = 0.5,
    } = options;

    let processed = [...results];

    // 1. 过滤低于阈值的结果
    processed = processed.filter(r => r.score >= threshold);

    // 2. 按分数降序排序
    processed.sort((a, b) => b.score - a.score);

    // 3. 截取 topK
    processed = processed.slice(0, topK);

    return processed;
  }

  /**
   * 格式化检索结果为文本（供 Planner 使用）
   * @param {Array} hits - 检索结果
   * @returns {string}
   */
  formatHitsAsContext(hits) {
    if (!hits || hits.length === 0) {
      return '（未找到相关地图点位信息）';
    }

    const lines = ['### 相关地图点位信息：', ''];
    
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      const { chunkText, score } = hit;
      
      lines.push(`**${i + 1}.** (相似度: ${(score * 100).toFixed(1)}%)`);
      lines.push(`   ${chunkText}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 从检索结果中用 LLM 提取坐标
   * @param {Array} hits - 检索结果
   * @param {string} [targetName] - 目标名称（可选，帮助 LLM 定位）
   * @returns {Promise<Array<{name: string, x: number, y: number|null, z: number}>>}
   */
  async extractCoordinates(hits, targetName = null) {
    if (!hits || hits.length === 0) {
      return [];
    }

    // 把所有 chunk 拼成上下文
    const context = hits.map((hit, i) => `[${i + 1}] ${hit.chunkText}`).join('\n');

    const prompt = `从以下文本中提取所有提到的地点坐标信息。

文本内容：
${context}

${targetName ? `用户想要找的目标：${targetName}` : ''}

请提取所有能找到的坐标点，返回 JSON 数组格式：
[
  { "name": "地点名称", "x": X坐标数值, "y": Y坐标数值或null, "z": Z坐标数值 }
]

注意：
- 坐标可能以不同格式出现，如 "X=1.5, Z=2.0" 或 "(1.5, 0, 2.0)" 或 "坐标1.5,2.0"
- 如果没有Y坐标（高度），设为 null
- 如果文本中没有任何坐标信息，返回空数组 []
- 只返回 JSON，不要其他文字`;

    try {
      const result = await this.gemini.generateJSON(prompt, { temperature: 0.1 });
      
      // 验证并规范化结果
      if (!Array.isArray(result)) {
        this.logger.warn('LLM returned non-array result for coordinates');
        return [];
      }

      return result.map(item => ({
        name: String(item.name || 'unnamed'),
        x: typeof item.x === 'number' ? item.x : parseFloat(item.x) || 0,
        y: item.y != null ? (typeof item.y === 'number' ? item.y : parseFloat(item.y)) : null,
        z: typeof item.z === 'number' ? item.z : parseFloat(item.z) || 0,
      })).filter(item => !isNaN(item.x) && !isNaN(item.z));

    } catch (error) {
      this.logger.error('Failed to extract coordinates with LLM:', error.message);
      return [];
    }
  }
}

// 单例
let instance = null;

export function getRagAgent(config) {
  if (!instance) {
    instance = new RagAgent(config);
  }
  return instance;
}

export function resetRagAgent() {
  instance = null;
}
