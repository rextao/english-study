-- 学习数据的定向读索引：列表词查找、在学计划、缺字段修复、周期打卡聚合。
-- 新建 D1 已由 schema.sql 创建；已有 D1 在部署依赖这些查询的新 Worker 前执行一次。
-- 同时确保默认列表作为 D1 中的真实行存在（旧整库读取路径曾仅在内存中兜底）。
INSERT OR IGNORE INTO lists (id, name, created_at, position, batch_names_json)
VALUES ('default', '默认列表', 0, 0, '{}');

CREATE INDEX IF NOT EXISTS idx_list_words_word ON list_words(word, list_id);
CREATE INDEX IF NOT EXISTS idx_list_words_started ON list_words(list_id, started_at)
  WHERE started_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_list_words_repair_phonetic ON list_words(word)
  WHERE phonetic IS NULL OR phonetic = '';
CREATE INDEX IF NOT EXISTS idx_list_words_repair_translation ON list_words(word)
  WHERE translation IS NULL OR translation = '';
CREATE INDEX IF NOT EXISTS idx_learning_events_tally_period
  ON learning_events(deleted_at, action, occurred_at, list_id, word_key)
  WHERE action IN ('spelling', 'reading', 'meaning');
