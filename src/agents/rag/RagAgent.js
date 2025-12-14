/**
 * RAG Agent
 * 负责：query → embedding → Supabase RPC 检索 → 结果后处理
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
        tags,
        topK = 5,
        threshold = 0.5,
      } = filters;

      const rawResults = await this.supabase.search(queryEmbedding, {
        mapId,
        tags,
        topK: topK + 5, // 多检索一些用于后处理
        threshold,
      });

      // 3. 后处理：去重、过滤、排序
      const processedResults = this._postProcess(rawResults, {
        topK,
        threshold,
        dedupeByName: true,
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
      dedupeByName = true,
    } = options;

    let processed = [...results];

    // 1. 过滤低于阈值的结果
    processed = processed.filter(r => r.score >= threshold);

    // 2. 按名称去重（保留分数最高的）
    if (dedupeByName) {
      const seen = new Map();
      for (const item of processed) {
        const name = item.metadata?.name || item.chunkText?.substring(0, 50);
        if (!name) continue;
        
        const existing = seen.get(name);
        if (!existing || existing.score < item.score) {
          seen.set(name, item);
        }
      }
      processed = Array.from(seen.values());
    }

    // 3. 按分数降序排序
    processed.sort((a, b) => b.score - a.score);

    // 4. 截取 topK
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
      const { metadata, chunkText, score } = hit;
      
      lines.push(`**${i + 1}. ${metadata?.name || '未命名点位'}** (相似度: ${(score * 100).toFixed(1)}%)`);
      
      // 坐标信息
      if (metadata?.worldX != null && metadata?.worldZ != null) {
        const y = metadata.worldY != null ? `, Y=${metadata.worldY.toFixed(2)}` : '';
        lines.push(`   - 坐标: X=${metadata.worldX.toFixed(2)}, Z=${metadata.worldZ.toFixed(2)}${y}`);
      }
      
      // 标签
      if (metadata?.tags && metadata.tags.length > 0) {
        lines.push(`   - 标签: ${metadata.tags.join(', ')}`);
      }
      
      // 描述文本
      if (chunkText) {
        lines.push(`   - 描述: ${chunkText.substring(0, 200)}${chunkText.length > 200 ? '...' : ''}`);
      }
      
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 从检索结果中提取坐标
   * @param {Array} hits - 检索结果
   * @returns {Array<{name: string, x: number, y: number|null, z: number}>}
   */
  extractCoordinates(hits) {
    return hits
      .filter(hit => hit.metadata?.worldX != null && hit.metadata?.worldZ != null)
      .map(hit => ({
        name: hit.metadata.name || 'unnamed',
        x: hit.metadata.worldX,
        y: hit.metadata.worldY,
        z: hit.metadata.worldZ,
        score: hit.score,
      }));
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

