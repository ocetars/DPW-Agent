/**
 * RAG Agent
 * 负责：query → embedding → Supabase RPC 检索 → 结果后处理
 * 
 * 增强模式：
 * 1. 用 LLM 解析用户意图，提取需要查询的关键地标/点位
 * 2. 针对每个关键词分别检索，合并去重
 * 3. 从检索到的句子中用 LLM 提取坐标
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
   * 用 LLM 解析用户请求，提取需要查询的关键地标/点位
   * @param {string} query - 用户原始请求
   * @returns {Promise<Object>} - { targets: string[], reasoning: string }
   */
  async parseQueryIntent(query) {
    const startTime = Date.now();
    this.logger.info(`Parsing query intent: "${query.substring(0, 50)}..."`);

    const prompt = `你是一个地图查询意图解析助手。请分析用户的无人机飞行请求，提取出所有需要查询坐标的地标/点位。

用户请求：${query}

请提取所有需要查询的地点，包括：
- 编号点位（如"1号"、"2号点"、"3号点位"）
- 命名地标（如"起点"、"终点"、"黑白点"、"着陆标"、"起降点"）
- 颜色+形状描述（如"红色圆形"、"绿色三角形"）
- 任何其他需要查找坐标的地点

输出 JSON 格式：
{
  "reasoning": "简短说明你的分析过程",
  "targets": ["目标1", "目标2", ...],
  "originalQuery": "保留原始请求用于兜底搜索"
}

注意：
- 如果用户说"2号,3号,6号"，应拆分为 ["2号", "3号", "6号"]
- "黑白点降"应理解为去"黑白点/着陆标"降落，提取 "黑白点" 或 "着陆标"
- 如果没有明确的地点，targets 可以为空数组
- 只返回 JSON，不要其他文字`;

    try {
      const result = await this.gemini.generateJSON(prompt, { temperature: 0.1 });
      
      const parsed = {
        reasoning: result.reasoning || '',
        targets: Array.isArray(result.targets) ? result.targets.map(String) : [],
        originalQuery: query,
      };

      this.logger.info(`Parsed ${parsed.targets.length} targets in ${Date.now() - startTime}ms: ${parsed.targets.join(', ')}`);
      return parsed;

    } catch (error) {
      this.logger.error('Parse query intent failed:', error.message);
      // 降级：返回原始查询
      return {
        reasoning: 'LLM 解析失败，使用原始查询',
        targets: [],
        originalQuery: query,
      };
    }
  }

  /**
   * 智能检索：先解析意图，再针对每个目标分别检索
   * @param {string} query - 用户原始请求
   * @param {Object} [filters] - 过滤条件
   * @returns {Promise<Object>} - 检索结果
   */
  async smartRetrieve(query, filters = {}) {
    const startTime = Date.now();
    this.logger.info(`Smart retrieving for query: "${query.substring(0, 50)}..."`);

    try {
      // 1. 解析用户意图
      const intent = await this.parseQueryIntent(query);
      
      const {
        mapId,
        topK = 5,
        threshold = 0.5,
      } = filters;

      // 2. 针对每个目标分别检索
      const allResults = [];
      const targetResults = {}; // 记录每个目标的搜索结果
      
      // 2.1 对每个提取的目标进行搜索
      for (const target of intent.targets) {
        const targetHits = await this._searchSingleTarget(target, { mapId, topK: 3, threshold });
        targetResults[target] = targetHits;
        allResults.push(...targetHits);
      }

      // 2.2 用原始查询做兜底搜索
      const originalHits = await this._searchSingleTarget(query, { mapId, topK, threshold });
      allResults.push(...originalHits);

      // 3. 合并去重（按 chunkText 去重，保留最高分）
      const uniqueResults = this._deduplicateResults(allResults);

      // 4. 后处理：排序截取
      const processedResults = this._postProcess(uniqueResults, { topK: topK + intent.targets.length, threshold });

      const durationMs = Date.now() - startTime;
      this.logger.info(`Smart retrieved ${processedResults.length} results in ${durationMs}ms (${intent.targets.length} targets)`);

      return {
        hits: processedResults,
        totalFound: uniqueResults.length,
        query,
        intent,
        targetResults, // 返回每个目标的搜索结果，便于 Planner 判断哪些找到了
        filters,
        durationMs,
      };

    } catch (error) {
      this.logger.error('Smart retrieve failed:', error.message);
      // 降级到普通检索
      return this.retrieve(query, filters);
    }
  }

  /**
   * 针对缺失的具体目标重新检索
   * @param {Array<string>} missingTargets - 缺失的目标列表
   * @param {Object} [filters] - 过滤条件
   * @returns {Promise<Object>} - 检索结果
   */
  async retrieveMissing(missingTargets, filters = {}) {
    const startTime = Date.now();
    this.logger.info(`Retrieving missing targets: ${missingTargets.join(', ')}`);

    try {
      const {
        mapId,
        topK = 3,
        threshold = 0.4, // 降低阈值，更宽容地匹配
      } = filters;

      const allResults = [];
      const targetResults = {};

      for (const target of missingTargets) {
        // 尝试多种搜索策略
        const variations = this._generateSearchVariations(target);
        let bestHits = [];
        
        for (const variation of variations) {
          const hits = await this._searchSingleTarget(variation, { mapId, topK: 3, threshold });
          if (hits.length > bestHits.length || (hits.length > 0 && hits[0].score > (bestHits[0]?.score || 0))) {
            bestHits = hits;
          }
        }
        
        targetResults[target] = bestHits;
        allResults.push(...bestHits);
      }

      const uniqueResults = this._deduplicateResults(allResults);
      const processedResults = this._postProcess(uniqueResults, { topK: topK * missingTargets.length, threshold });

      const durationMs = Date.now() - startTime;
      this.logger.info(`Retrieved ${processedResults.length} results for missing targets in ${durationMs}ms`);

      return {
        hits: processedResults,
        totalFound: uniqueResults.length,
        missingTargets,
        targetResults,
        filters,
        durationMs,
      };

    } catch (error) {
      this.logger.error('Retrieve missing failed:', error.message);
      throw error;
    }
  }

  /**
   * 为目标生成搜索变体（提高召回率）
   * @private
   */
  _generateSearchVariations(target) {
    const variations = [target];
    
    // 数字编号的变体
    const numMatch = target.match(/(\d+)/);
    if (numMatch) {
      const num = numMatch[1];
      variations.push(`${num}号`);
      variations.push(`${num}号点位`);
      variations.push(`编号${num}`);
      variations.push(`ID ${num}`);
      variations.push(`标记点${num}`);
    }
    
    // 着陆相关的变体
    if (target.includes('黑白') || target.includes('着陆') || target.includes('起降') || target.includes('landing')) {
      variations.push('黑白色十字着陆标');
      variations.push('起降点');
      variations.push('landing_pad');
      variations.push('十字圆形标记');
    }

    return [...new Set(variations)]; // 去重
  }

  /**
   * 单目标搜索
   * @private
   */
  async _searchSingleTarget(target, options = {}) {
    const { mapId, topK = 3, threshold = 0.5 } = options;
    
    try {
      const queryEmbedding = await this.gemini.embed(target);
      const rawResults = await this.supabase.search(queryEmbedding, {
        mapId,
        topK: topK + 2,
        threshold,
      });
      return rawResults;
    } catch (error) {
      this.logger.warn(`Search for "${target}" failed:`, error.message);
      return [];
    }
  }

  /**
   * 结果去重（按 chunkText，保留最高分）
   * @private
   */
  _deduplicateResults(results) {
    const seen = new Map();
    
    for (const result of results) {
      const key = result.chunkText || result.id;
      if (!seen.has(key) || seen.get(key).score < result.score) {
        seen.set(key, result);
      }
    }
    
    return Array.from(seen.values());
  }

  /**
   * 执行 RAG 检索（保持向后兼容）
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
