#!/usr/bin/env node
/**
 * 插入知识数据到 Supabase（支持 Markdown 文件切片 + Gemini embedding）
 * 
 * 使用方式：
 *   # 使用内置示例数据
 *   node scripts/seed-demo-data.js
 * 
 *   # 从 Markdown 文件导入
 *   node scripts/seed-demo-data.js --file ./docs/map-info.md
 * 
 *   # 指定 mapId
 *   node scripts/seed-demo-data.js --file ./docs/map-info.md --map-id my-map-001
 * 
 *   # 自定义切片大小
 *   node scripts/seed-demo-data.js --file ./docs/map-info.md --chunk-size 500
 * 
 * 需要配置 .env：
 *   GEMINI_API_KEY=xxx
 *   SUPABASE_URL=xxx
 *   SUPABASE_SERVICE_ROLE_KEY=xxx
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getGeminiProvider } from '../src/llm/GeminiProvider.js';
import { getSupabaseClient } from '../src/vector/SupabaseClient.js';

// ==================== 切片策略 ====================

/**
 * Markdown 切片器
 * 策略：按段落/标题切分，保证每个 chunk 有完整语义
 */
function chunkMarkdown(content, options = {}) {
  const {
    maxChunkSize = 500,    // 每个 chunk 最大字符数
    minChunkSize = 50,     // 最小字符数（太短的丢弃）
    overlapSize = 50,      // 重叠字符数（保持上下文连贯）
  } = options;

  const chunks = [];
  
  // 1. 先按标题分割（## 或 ###）
  const sections = content.split(/(?=^#{1,3}\s)/m);
  
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed || trimmed.length < minChunkSize) continue;

    // 2. 如果 section 太长，按段落再分
    if (trimmed.length <= maxChunkSize) {
      chunks.push(trimmed);
    } else {
      // 按段落分割（空行）
      const paragraphs = trimmed.split(/\n\s*\n/);
      let currentChunk = '';

      for (const para of paragraphs) {
        const paraText = para.trim();
        if (!paraText) continue;

        // 如果当前段落本身就超长，按句子分
        if (paraText.length > maxChunkSize) {
          // 先保存当前累积的 chunk
          if (currentChunk.length >= minChunkSize) {
            chunks.push(currentChunk.trim());
          }
          
          // 按句子分割超长段落
          const sentences = paraText.split(/(?<=[。！？.!?])\s*/);
          currentChunk = '';
          
          for (const sentence of sentences) {
            if ((currentChunk + sentence).length <= maxChunkSize) {
              currentChunk += (currentChunk ? ' ' : '') + sentence;
            } else {
              if (currentChunk.length >= minChunkSize) {
                chunks.push(currentChunk.trim());
              }
              currentChunk = sentence;
            }
          }
        } else if ((currentChunk + '\n\n' + paraText).length <= maxChunkSize) {
          // 可以合并到当前 chunk
          currentChunk += (currentChunk ? '\n\n' : '') + paraText;
        } else {
          // 保存当前 chunk，开始新的
          if (currentChunk.length >= minChunkSize) {
            chunks.push(currentChunk.trim());
          }
          // 添加重叠（取上一个 chunk 的末尾）
          if (overlapSize > 0 && chunks.length > 0) {
            const lastChunk = chunks[chunks.length - 1];
            const overlap = lastChunk.slice(-overlapSize);
            currentChunk = overlap + '... ' + paraText;
          } else {
            currentChunk = paraText;
          }
        }
      }

      // 保存最后一个 chunk
      if (currentChunk.length >= minChunkSize) {
        chunks.push(currentChunk.trim());
      }
    }
  }

  return chunks;
}

// ==================== 内置示例数据 ====================

const DEMO_DATA = [
  {
    mapId: 'demo-map-001',
    chunkText: '起飞点位于地图中央偏左的位置，坐标是 X=0.0, Z=0.0。这是无人机的默认起始位置，也是返航点。起飞点周围是开阔的空地，适合起降操作。',
  },
  {
    mapId: 'demo-map-001',
    chunkText: '仓库A位于地图东北方向，坐标 X=5.5, Y=0, Z=-3.2。仓库是一个红色建筑，高度约2米。仓库门朝南开，可以从南侧进入。仓库里存放着货物。',
  },
  {
    mapId: 'demo-map-001',
    chunkText: '停机坪在地图西南角，具体位置是 X=-4.0, Z=6.0，高度 Y=0.5（有一个小平台）。停机坪是一个圆形区域，直径约3米，地面有黄色标记。这里可以作为备用降落点。',
  },
];

// ==================== CLI 参数解析 ====================

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    file: null,
    mapId: 'demo-map-001',
    chunkSize: 500,
    minChunkSize: 50,
    overlapSize: 50,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--file':
      case '-f':
        options.file = args[++i];
        break;
      case '--map-id':
      case '-m':
        options.mapId = args[++i];
        break;
      case '--chunk-size':
      case '-c':
        options.chunkSize = parseInt(args[++i]) || 500;
        break;
      case '--min-chunk-size':
        options.minChunkSize = parseInt(args[++i]) || 50;
        break;
      case '--overlap':
      case '-o':
        options.overlapSize = parseInt(args[++i]) || 50;
        break;
      case '--help':
      case '-h':
        console.log(`
用法: node scripts/seed-demo-data.js [选项]

选项:
  --file, -f <path>       Markdown 文件路径
  --map-id, -m <id>       地图 ID (默认: demo-map-001)
  --chunk-size, -c <n>    最大切片大小 (默认: 500)
  --min-chunk-size <n>    最小切片大小 (默认: 50)
  --overlap, -o <n>       切片重叠大小 (默认: 50)
  --help, -h              显示帮助

示例:
  node scripts/seed-demo-data.js
  node scripts/seed-demo-data.js --file ./docs/map.md --map-id my-map
        `);
        process.exit(0);
    }
  }

  return options;
}

// ==================== 主函数 ====================

async function main() {
  const options = parseArgs();
  
  console.log('🚀 开始处理知识数据...\n');

  const gemini = getGeminiProvider();
  const supabase = getSupabaseClient();

  let dataToInsert = [];

  // 判断数据来源
  if (options.file) {
    // 从文件读取并切片
    const filePath = path.resolve(options.file);
    
    if (!fs.existsSync(filePath)) {
      console.error(`❌ 文件不存在: ${filePath}`);
      process.exit(1);
    }

    console.log(`📄 读取文件: ${filePath}`);
    const content = fs.readFileSync(filePath, 'utf-8');
    console.log(`   文件大小: ${content.length} 字符\n`);

    console.log(`✂️  切片中 (maxChunkSize=${options.chunkSize}, overlap=${options.overlapSize})...`);
    const chunks = chunkMarkdown(content, {
      maxChunkSize: options.chunkSize,
      minChunkSize: options.minChunkSize,
      overlapSize: options.overlapSize,
    });
    console.log(`   生成 ${chunks.length} 个切片\n`);

    // 预览切片
    console.log('📋 切片预览:');
    chunks.forEach((chunk, i) => {
      console.log(`   [${i + 1}] ${chunk.substring(0, 60).replace(/\n/g, ' ')}...`);
    });
    console.log('');

    dataToInsert = chunks.map(chunkText => ({
      mapId: options.mapId,
      chunkText,
    }));
  } else {
    // 使用内置示例数据
    console.log('📦 使用内置示例数据\n');
    dataToInsert = DEMO_DATA;
  }

  // 插入数据
  console.log(`📤 开始插入 ${dataToInsert.length} 条数据到 Supabase...\n`);

  for (let i = 0; i < dataToInsert.length; i++) {
    const item = dataToInsert[i];
    const preview = item.chunkText.substring(0, 40).replace(/\n/g, ' ');
    console.log(`[${i + 1}/${dataToInsert.length}] ${preview}...`);

    // 生成 embedding
    process.stdout.write('   生成 embedding... ');
    const embedding = await gemini.embed(item.chunkText);
    console.log(`✓ (${embedding.length} 维)`);

    // 插入数据库
    process.stdout.write('   插入 Supabase... ');
    const result = await supabase.insert({
      chunkText: item.chunkText,
      embedding,
      mapId: item.mapId,
    });
    console.log(`✓ (id=${result.id.substring(0, 8)}...)\n`);

    // 避免 API 限流，稍微等一下
    if (i < dataToInsert.length - 1) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log('🎉 全部完成！');
  console.log(`   共插入 ${dataToInsert.length} 条数据`);
  console.log(`   mapId: ${options.mapId}`);
}

main().catch(error => {
  console.error('❌ 错误:', error.message);
  process.exit(1);
});
