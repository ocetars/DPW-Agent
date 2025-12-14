/**
 * Supabase Vector Store Client
 * 对接 Supabase RPC (match_documents) 进行向量检索
 */

import { createClient } from '@supabase/supabase-js';
import { createLogger } from '../utils/logger.js';

export class SupabaseVectorClient {
  /**
   * @param {Object} config
   * @param {string} config.url - Supabase URL
   * @param {string} config.serviceRoleKey - Supabase Service Role Key
   * @param {string} [config.rpcFunction] - RPC 函数名，默认 'match_documents'
   */
  constructor(config = {}) {
    const url = config.url || process.env.SUPABASE_URL;
    const key = config.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    }

    this.client = createClient(url, key);
    this.rpcFunction = config.rpcFunction || 'match_documents';
    this.logger = createLogger('SupabaseVector');

    this.logger.info(`Initialized with RPC function: ${this.rpcFunction}`);
  }

  /**
   * 向量检索
   * @param {number[]} queryEmbedding - 查询向量
   * @param {Object} [options] - 检索选项
   * @param {string} [options.mapId] - 地图 ID 过滤
   * @param {string[]} [options.tags] - 标签过滤
   * @param {number} [options.topK=5] - 返回数量
   * @param {number} [options.threshold=0.5] - 相似度阈值
   * @returns {Promise<Array>} - 检索结果
   */
  async search(queryEmbedding, options = {}) {
    const {
      mapId,
      tags,
      topK = 5,
      threshold = 0.5,
    } = options;

    this.logger.debug(`Searching with topK=${topK}, threshold=${threshold}, mapId=${mapId}`);

    try {
      // 调用 Supabase RPC 函数
      // 预期 RPC 函数签名: match_documents(query_embedding, match_count, filter_map_id, filter_tags, match_threshold)
      const { data, error } = await this.client.rpc(this.rpcFunction, {
        query_embedding: queryEmbedding,
        match_count: topK,
        filter_map_id: mapId || null,
        filter_tags: tags || null,
        match_threshold: threshold,
      });

      if (error) {
        this.logger.error('Supabase RPC error:', error);
        throw new Error(`Supabase RPC failed: ${error.message}`);
      }

      // 规范化返回结构
      const results = this._normalizeResults(data || []);
      this.logger.debug(`Found ${results.length} results`);
      
      return results;
    } catch (error) {
      this.logger.error('Search failed:', error.message);
      throw error;
    }
  }

  /**
   * 规范化检索结果
   * 将 Supabase 返回的数据转换为统一格式
   * @private
   */
  _normalizeResults(data) {
    return data.map(item => ({
      // 核心字段
      chunkText: item.chunk_text || item.content || item.summary_text || '',
      score: item.similarity || item.score || 0,
      
      // 元数据（包含坐标等）
      metadata: {
        id: item.id,
        name: item.name || item.point_name || '',
        worldX: item.world_x ?? item.x ?? null,
        worldY: item.world_y ?? item.y ?? null,
        worldZ: item.world_z ?? item.z ?? null,
        tags: item.tags || [],
        mapId: item.map_id || null,
        rawNotes: item.raw_notes || item.notes || '',
        // 保留原始数据供调试
        _raw: item,
      },
    }));
  }

  /**
   * 获取 Supabase 客户端实例（用于自定义查询）
   * @returns {SupabaseClient}
   */
  getClient() {
    return this.client;
  }

  /**
   * 直接查询表（不使用向量检索）
   * @param {string} table - 表名
   * @param {Object} filters - 过滤条件
   * @returns {Promise<Array>}
   */
  async queryTable(table, filters = {}) {
    let query = this.client.from(table).select('*');

    if (filters.mapId) {
      query = query.eq('map_id', filters.mapId);
    }
    if (filters.tags && filters.tags.length > 0) {
      query = query.contains('tags', filters.tags);
    }
    if (filters.limit) {
      query = query.limit(filters.limit);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Query failed: ${error.message}`);
    }

    return data || [];
  }
}

// 单例实例
let instance = null;

/**
 * 获取 SupabaseVectorClient 单例
 * @param {Object} [config]
 * @returns {SupabaseVectorClient}
 */
export function getSupabaseClient(config) {
  if (!instance) {
    instance = new SupabaseVectorClient(config);
  }
  return instance;
}

/**
 * 重置单例（用于测试）
 */
export function resetSupabaseClient() {
  instance = null;
}

