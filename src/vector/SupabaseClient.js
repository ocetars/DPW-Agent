/**
 * Supabase Vector Store Client
 * 对接 Supabase RPC (match_documents) 进行向量检索
 * 极简结构：chunk_text + embedding + map_id
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
   * @param {number} [options.topK=5] - 返回数量
   * @param {number} [options.threshold=0.5] - 相似度阈值
   * @returns {Promise<Array>} - 检索结果
   */
  async search(queryEmbedding, options = {}) {
    const {
      mapId,
      topK = 5,
      threshold = 0.5,
    } = options;

    this.logger.debug(`Searching with topK=${topK}, threshold=${threshold}, mapId=${mapId}`);

    try {
      // 调用 Supabase RPC 函数
      const { data, error } = await this.client.rpc(this.rpcFunction, {
        query_embedding: queryEmbedding,
        match_count: topK,
        filter_map_id: mapId || null,
        filter_tags: null, // 不再使用 tags
        match_threshold: threshold,
      });

      if (error) {
        this.logger.error('Supabase RPC error:', error);
        throw new Error(`Supabase RPC failed: ${error.message}`);
      }

      // 规范化返回结构（极简）
      const results = this._normalizeResults(data || []);
      this.logger.debug(`Found ${results.length} results`);
      
      return results;
    } catch (error) {
      this.logger.error('Search failed:', error.message);
      throw error;
    }
  }

  /**
   * 规范化检索结果（极简结构）
   * @private
   */
  _normalizeResults(data) {
    return data.map(item => ({
      id: item.id,
      chunkText: item.chunk_text || '',
      score: item.similarity || 0,
      mapId: item.map_id || null,
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
   * 插入文档（用于导入数据）
   * @param {Object} doc - 文档
   * @param {string} doc.chunkText - 文本内容
   * @param {number[]} doc.embedding - 向量
   * @param {string} [doc.mapId] - 地图 ID
   * @returns {Promise<Object>}
   */
  async insert(doc) {
    const { chunkText, embedding, mapId } = doc;

    const { data, error } = await this.client
      .from('documents')
      .insert({
        chunk_text: chunkText,
        embedding: `[${embedding.join(',')}]`,
        map_id: mapId || null,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Insert failed: ${error.message}`);
    }

    return data;
  }

  /**
   * 批量插入文档
   * @param {Array<Object>} docs - 文档数组
   * @returns {Promise<Array>}
   */
  async insertBatch(docs) {
    const rows = docs.map(doc => ({
      chunk_text: doc.chunkText,
      embedding: `[${doc.embedding.join(',')}]`,
      map_id: doc.mapId || null,
    }));

    const { data, error } = await this.client
      .from('documents')
      .insert(rows)
      .select();

    if (error) {
      throw new Error(`Batch insert failed: ${error.message}`);
    }

    return data;
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
