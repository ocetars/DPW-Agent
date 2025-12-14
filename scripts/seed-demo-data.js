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
 * 从 Markdown 中提取地图点位信息
 * 优先提取每个独立的地标点位，使 RAG 更精准
 */
function extractMapPoints(content) {
  const points = [];
  
  // 匹配模式：ID + 类型 + 颜色 + 坐标
  // 例如：**蓝色圆形 (ID: 7)**\n    *   坐标：`(-0.48, +0.78)`
  const pointPattern = /\*\*([^*]+)\s*\(ID:\s*([^)]+)\)\*\*[\s\S]*?坐标[：:]\s*`?\(?([+-]?\d+\.?\d*)\s*,\s*([+-]?\d+\.?\d*)\)?`?/gi;
  
  let match;
  while ((match = pointPattern.exec(content)) !== null) {
    const [, nameWithType, id, x, z] = match;
    // 解析名称中的颜色和类型
    const colorMatch = nameWithType.match(/(绿色|蓝色|红色|橙色|棕色|黑色|白色|黄色)/);
    const typeMatch = nameWithType.match(/(圆形|三角形|正方形|十字)/);
    
    const color = colorMatch ? colorMatch[1] : '';
    const type = typeMatch ? typeMatch[1] : '';
    const name = nameWithType.trim();
    
    // 生成多种描述方式，便于匹配
    const descriptions = [
      `${id}号点位：${name}，坐标 (${x}, ${z})`,
      `${color}${type} ID=${id}，位置坐标 x=${x}, z=${z}`,
      `地标${id}：${name}，世界坐标 X=${x}, Z=${z}`,
    ];
    
    // 选择最完整的描述
    const chunkText = `${name} (ID: ${id})，坐标：x=${x}, z=${z}。这是一个${color}${type}地标点。`;
    
    points.push({
      id: id.toString(),
      name,
      color,
      type,
      x: parseFloat(x),
      z: parseFloat(z),
      chunkText,
    });
  }
  
  // 也匹配 JSON 格式的 objects 数组
  const jsonMatch = content.match(/"objects"\s*:\s*\[([\s\S]*?)\]/);
  if (jsonMatch) {
    try {
      const objectsStr = `[${jsonMatch[1]}]`;
      const objects = JSON.parse(objectsStr);
      for (const obj of objects) {
        // 避免重复
        if (points.some(p => p.id === String(obj.id))) continue;
        
        const colorMap = { green: '绿色', blue: '蓝色', orange: '橙色', black_white: '黑白色' };
        const typeMap = { circle: '圆形', triangle: '三角形', square: '正方形', cross_circle: '十字圆', marker: '标记点' };
        
        const color = colorMap[obj.color] || obj.color || '';
        const type = typeMap[obj.type] || obj.type || '';
        const name = `${color}${type}`;
        
        points.push({
          id: String(obj.id),
          name,
          color,
          type,
          x: obj.x,
          z: obj.z,
          chunkText: `${name} (ID: ${obj.id})，坐标：x=${obj.x}, z=${obj.z}。`,
        });
      }
    } catch (e) {
      // JSON 解析失败，忽略
    }
  }
  
  return points;
}

/**
 * Markdown 切片器
 * 策略：优先提取独立点位，其余按段落切分
 */
function chunkMarkdown(content, options = {}) {
  const {
    maxChunkSize = 500,    // 每个 chunk 最大字符数
    minChunkSize = 50,     // 最小字符数（太短的丢弃）
    overlapSize = 50,      // 重叠字符数（保持上下文连贯）
    extractPoints = true,  // 是否提取独立点位
  } = options;

  const chunks = [];
  
  // 1. 优先提取地图点位（每个点位一个 chunk）
  if (extractPoints) {
    const points = extractMapPoints(content);
    console.log(`   提取到 ${points.length} 个独立点位`);
    for (const point of points) {
      chunks.push(point.chunkText);
    }
  }
  
  // 2. 按标题分割其余内容
  const sections = content.split(/(?=^#{1,3}\s)/m);
  
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed || trimmed.length < minChunkSize) continue;

    // 如果 section 太长，按段落再分
    if (trimmed.length <= maxChunkSize) {
      // 避免与已提取的点位重复（简单检查）
      if (!chunks.some(c => trimmed.includes(c.substring(0, 30)))) {
        chunks.push(trimmed);
      }
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

// ==================== 内置示例数据（基于 map-info.md）====================

// 直接基于地图 JSON 数据生成精确的点位知识
const MAP_OBJECTS = [
  { id: 1, type: 'triangle', color: 'green', x: -1.34, z: -1.75 },
  { id: 11, type: 'square', color: 'blue', x: 0.37, z: -1.75 },
  { id: 5, type: 'circle', color: 'green', x: 2.11, z: -1.75 },
  { id: 8, type: 'circle', color: 'blue', x: -0.51, z: -0.90 },
  { id: 3, type: 'triangle', color: 'blue', x: 1.22, z: -0.91 },
  { id: 9, type: 'square', color: 'green', x: -1.30, z: -0.07 },
  { id: 2, type: 'triangle', color: 'green', x: 0.40, z: -0.03 },
  { id: 12, type: 'square', color: 'blue', x: 2.09, z: -0.05 },
  { id: 7, type: 'circle', color: 'blue', x: -0.48, z: 0.78 },
  { id: 6, type: 'circle', color: 'orange', x: 1.20, z: 0.78 },
  { id: 'landing_pad', type: 'cross_circle', color: 'black_white', x: -1.88, z: 1.34 },
  { id: 10, type: 'square', color: 'green', x: 0.40, z: 1.61 },
  { id: 4, type: 'triangle', color: 'blue', x: 2.13, z: 1.65 },
];

// 颜色和类型的中文映射
const COLOR_MAP = {
  green: '绿色',
  blue: '蓝色',
  orange: '橙色',
  red: '红色',
  black_white: '黑白色',
};

const TYPE_MAP = {
  circle: '圆形',
  triangle: '三角形',
  square: '正方形',
  cross_circle: '十字着陆标',
  marker: '标记点',
};

// 生成每个点位的知识文本
function generatePointChunks(objects, mapId) {
  const chunks = [];
  
  for (const obj of objects) {
    const color = COLOR_MAP[obj.color] || obj.color;
    const type = TYPE_MAP[obj.type] || obj.type;
    const idStr = String(obj.id);
    
    // 生成丰富的描述，包含多种查询方式
    const chunkText = [
      `${idStr}号${color}${type}`,
      `ID: ${idStr}`,
      `类型: ${type}`,
      `颜色: ${color}`,
      `坐标: x=${obj.x}, z=${obj.z}`,
      `位置描述: 这是地图上的${color}${type}地标，编号为${idStr}。`,
    ].join('，');
    
    chunks.push({
      mapId,
      chunkText,
    });
  }
  
  // 添加一些通用知识
  chunks.push({
    mapId,
    chunkText: '地图坐标系说明：X轴水平向右为正，Z轴垂直向下为正，Y轴表示高度向上为正。原点(0,0)位于地图中心。',
  });
  
  chunks.push({
    mapId,
    chunkText: '着陆标/起降点位于坐标 x=-1.88, z=1.34，是一个黑白色十字圆形标记，可用于无人机起降。',
  });
  
  return chunks;
}

const DEMO_DATA = generatePointChunks(MAP_OBJECTS, 'demo-map-001');

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
