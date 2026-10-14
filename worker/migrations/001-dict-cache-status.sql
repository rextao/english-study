-- dict_cache 增加 status 列（给缓存统计用，避免 /api/dict/sources 读整张表解析 JSON）
--
-- 什么时候要跑：D1 里的 dict_cache 还是「只有 word / entry_json」两列的旧结构时。
-- 新库不用跑——worker/schema.sql 建表时已经带上这一列和索引。
--
-- 一次性执行（重复跑会因为列已存在而报 duplicate column name，属预期）：
--   npx wrangler d1 execute english-study-sync --remote --file=worker/migrations/001-dict-cache-status.sql
--
-- 必须在上线带 status 写入的版本之前执行：那之后 UPSERT 会写三列，列不存在会直接报错。
-- 如果顺序是「先 schema.sql 再 migration.sql（数据导入）」，注意 migration.sql 生成的
-- INSERT 只有 word / entry_json 两列，导完后再跑一次本文件的 UPDATE 部分即可。

ALTER TABLE dict_cache ADD COLUMN status TEXT NOT NULL DEFAULT 'partial';

-- 回填：优先用词条里已存的 status；旧数据（本地版迁移过来的）没有这个字段，
-- 按 normalizeEntry 的规则近似推导——有中文翻译，且拿到了音标或英文释义，才算抓齐。
-- 近似之处只有短语：代码里短语即使没有音标/释义也算 ok，SQL 判不出来，
-- 这类行会被记成 partial，只影响统计数字，不影响查词行为。
UPDATE dict_cache
SET status = CASE
  WHEN json_extract(entry_json, '$.status') IN ('ok', 'partial')
    THEN json_extract(entry_json, '$.status')
  WHEN coalesce(json_extract(entry_json, '$.translation'), '') <> ''
   AND (coalesce(json_extract(entry_json, '$.phonetic'), '') <> ''
        OR (json_type(entry_json, '$.senses') = 'array'
            AND json_array_length(json_extract(entry_json, '$.senses')) > 0))
    THEN 'ok'
  ELSE 'partial'
END
WHERE json_valid(entry_json);

CREATE INDEX IF NOT EXISTS idx_dict_cache_status ON dict_cache(status);
