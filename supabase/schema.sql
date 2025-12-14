-- DPW-Agent Supabase schema for RAG (pgvector)
-- 极简结构：chunk_text + embedding + map_id
--
-- 使用方式：
-- 1) 在 Supabase Dashboard → SQL Editor 执行本文件
-- 2) 确保 GEMINI_EMBEDDING_MODEL 输出维度为 768；若不是，请把本文件里的 768 改成实际维度

-- Extensions
create extension if not exists vector;
create extension if not exists pgcrypto;

-- 主表：知识块（极简：句子 + 向量 + map_id）
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),

  -- 可选过滤维度
  map_id text null,

  -- 文本内容（分片句子，Agent 会从中提取坐标等信息）
  chunk_text text not null,

  -- 向量（注意维度）
  embedding vector(768) not null,

  created_at timestamptz not null default now()
);

-- 索引
create index if not exists idx_documents_map_id on public.documents (map_id);

-- 向量索引（ivfflat + cosine）
create index if not exists idx_documents_embedding_ivfflat
on public.documents
using ivfflat (embedding vector_cosine_ops)
with (lists = 100);

-- RPC: match_documents
-- 入参：query_embedding float8[]（JS 直接传 number[]）
-- 返回：id, chunk_text, map_id, similarity
create or replace function public.match_documents(
  query_embedding float8[],
  match_count int default 5,
  filter_map_id text default null,
  filter_tags text[] default null,  -- 保留参数兼容，但不再使用
  match_threshold double precision default 0.5
)
returns table (
  id uuid,
  chunk_text text,
  map_id text,
  similarity double precision
)
language plpgsql
stable
as $$
declare
  q vector(768);
begin
  if query_embedding is null or array_length(query_embedding, 1) is null then
    raise exception 'query_embedding is required';
  end if;

  -- 将 float8[] 转成 vector(768)
  q := ('[' || array_to_string(query_embedding, ',') || ']')::vector(768);

  return query
  select
    d.id,
    d.chunk_text,
    d.map_id,
    (1 - (d.embedding <=> q))::double precision as similarity
  from public.documents d
  where
    (filter_map_id is null or d.map_id = filter_map_id)
    and (1 - (d.embedding <=> q)) >= match_threshold
  order by d.embedding <=> q asc
  limit greatest(match_count, 1);
end;
$$;

-- RLS（可选）
-- 你们当前用的是 SUPABASE_SERVICE_ROLE_KEY（服务端），会绕过 RLS。
-- alter table public.documents enable row level security;
