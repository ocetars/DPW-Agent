/**
 * Gemini Provider
 * 统一封装 Google Gemini API 的文本生成和 Embedding 功能
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { createLogger } from '../utils/logger.js';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';
const DEFAULT_EMBEDDING_DIMENSIONS = 768; // gemini-embedding-001 支持 128-3072，推荐 768
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

export class GeminiProvider {
  /**
   * @param {Object} config
   * @param {string} config.apiKey - Gemini API Key
   * @param {string} [config.model] - 生成模型名称
   * @param {string} [config.embeddingModel] - Embedding 模型名称
   * @param {number} [config.maxRetries] - 最大重试次数
   */
  constructor(config = {}) {
    const apiKey = config.apiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is required');
    }

    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelName = config.model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
    this.embeddingModelName = config.embeddingModel || process.env.GEMINI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
    this.maxRetries = config.maxRetries || MAX_RETRIES;
    this.logger = createLogger('GeminiProvider');

    this.logger.info(`Initialized with model: ${this.modelName}, embedding: ${this.embeddingModelName}`);
  }

  /**
   * 带重试的请求包装
   * @private
   */
  async _withRetry(fn, operationName) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        this.logger.warn(`${operationName} attempt ${attempt} failed: ${error.message}`);
        
        if (attempt < this.maxRetries) {
          const delay = RETRY_DELAY_MS * attempt;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError;
  }

  /**
   * 生成文本
   * @param {string} prompt - 提示词
   * @param {Object} [options] - 生成选项
   * @returns {Promise<string>} - 生成的文本
   */
  async generateText(prompt, options = {}) {
    return this._withRetry(async () => {
      const model = this.genAI.getGenerativeModel({
        model: options.model || this.modelName,
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: options.maxTokens ?? 4096,
          topP: options.topP ?? 0.95,
        },
      });

      const result = await model.generateContent(prompt);
      const response = result.response;
      const text = response.text();
      
      this.logger.debug(`Generated ${text.length} chars`);
      return text;
    }, 'generateText');
  }

  /**
   * 生成结构化输出（JSON）
   * @param {string} prompt - 提示词
   * @param {Object} [options] - 生成选项
   * @returns {Promise<Object>} - 解析后的 JSON 对象
   */
  async generateJSON(prompt, options = {}) {
    const fullPrompt = `${prompt}

请仅返回有效的 JSON 格式，不要包含任何其他文本、markdown 代码块或解释。`;

    const text = await this.generateText(fullPrompt, {
      ...options,
      temperature: options.temperature ?? 0.3, // JSON 生成用较低温度
    });

    // 尝试提取 JSON
    let jsonText = text.trim();
    
    // 移除可能的 markdown 代码块
    if (jsonText.startsWith('```')) {
      const lines = jsonText.split('\n');
      lines.shift(); // 移除开头的 ```json 或 ```
      if (lines[lines.length - 1] === '```') {
        lines.pop(); // 移除结尾的 ```
      }
      jsonText = lines.join('\n');
    }

    try {
      return JSON.parse(jsonText);
    } catch (parseError) {
      this.logger.error('Failed to parse JSON:', jsonText.substring(0, 200));
      throw new Error(`Invalid JSON response: ${parseError.message}`);
    }
  }

  /**
   * 生成 Embedding 向量
   * @param {string} text - 输入文本
   * @param {Object} [options] - 选项
   * @param {number} [options.dimensions=768] - 输出维度 (128-3072)
   * @returns {Promise<number[]>} - Embedding 向量
   */
  async embed(text, options = {}) {
    const dimensions = options.dimensions || DEFAULT_EMBEDDING_DIMENSIONS;
    
    return this._withRetry(async () => {
      const model = this.genAI.getGenerativeModel({
        model: this.embeddingModelName,
      });

      const result = await model.embedContent({
        content: { parts: [{ text }] },
        outputDimensionality: dimensions,
      });
      const embedding = result.embedding.values;
      
      this.logger.debug(`Generated embedding with ${embedding.length} dimensions`);
      return embedding;
    }, 'embed');
  }

  /**
   * 批量生成 Embedding 向量
   * @param {string[]} texts - 输入文本数组
   * @param {Object} [options] - 选项
   * @param {number} [options.dimensions=768] - 输出维度 (128-3072)
   * @returns {Promise<number[][]>} - Embedding 向量数组
   */
  async embedBatch(texts, options = {}) {
    const dimensions = options.dimensions || DEFAULT_EMBEDDING_DIMENSIONS;
    
    return this._withRetry(async () => {
      const model = this.genAI.getGenerativeModel({
        model: this.embeddingModelName,
      });

      const result = await model.batchEmbedContents({
        requests: texts.map(text => ({
          content: { parts: [{ text }] },
          outputDimensionality: dimensions,
        })),
      });

      const embeddings = result.embeddings.map(e => e.values);
      this.logger.debug(`Generated ${embeddings.length} embeddings`);
      return embeddings;
    }, 'embedBatch');
  }

  /**
   * 带工具调用的生成（Function Calling）
   * @param {string} prompt - 提示词
   * @param {Object[]} tools - 工具定义
   * @param {Object} [options] - 生成选项
   * @returns {Promise<Object>} - 包含 text 和 functionCalls 的结果
   */
  async generateWithTools(prompt, tools, options = {}) {
    return this._withRetry(async () => {
      const model = this.genAI.getGenerativeModel({
        model: options.model || this.modelName,
        tools: tools,
        generationConfig: {
          temperature: options.temperature ?? 0.5,
          maxOutputTokens: options.maxTokens ?? 4096,
        },
      });

      const result = await model.generateContent(prompt);
      const response = result.response;
      
      // 提取文本和函数调用
      const text = response.text?.() || '';
      const functionCalls = [];
      
      for (const candidate of response.candidates || []) {
        for (const part of candidate.content?.parts || []) {
          if (part.functionCall) {
            functionCalls.push({
              name: part.functionCall.name,
              args: part.functionCall.args,
            });
          }
        }
      }

      this.logger.debug(`Generated response with ${functionCalls.length} function calls`);
      return { text, functionCalls };
    }, 'generateWithTools');
  }

  /**
   * 多轮对话
   * @param {Array} history - 对话历史 [{ role: 'user'|'model', parts: [{ text }] }]
   * @param {string} userMessage - 用户消息
   * @param {Object} [options] - 生成选项
   * @returns {Promise<string>} - 模型回复
   */
  async chat(history, userMessage, options = {}) {
    return this._withRetry(async () => {
      const model = this.genAI.getGenerativeModel({
        model: options.model || this.modelName,
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: options.maxTokens ?? 4096,
        },
      });

      const chat = model.startChat({ history });
      const result = await chat.sendMessage(userMessage);
      const response = result.response;
      
      return response.text();
    }, 'chat');
  }
}

// 单例实例
let instance = null;

/**
 * 获取 GeminiProvider 单例
 * @param {Object} [config] - 配置（仅首次调用时生效）
 * @returns {GeminiProvider}
 */
export function getGeminiProvider(config) {
  if (!instance) {
    instance = new GeminiProvider(config);
  }
  return instance;
}

/**
 * 重置单例（用于测试）
 */
export function resetGeminiProvider() {
  instance = null;
}

