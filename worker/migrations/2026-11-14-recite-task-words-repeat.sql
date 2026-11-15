-- 同一周的单词可以在多次学习里重复选：任务词表主键从 (task_id, word) 改成 (task_id, position)。
-- SQLite 改不了主键，重建表再把数据搬过去。
-- 上线顺序：先在本机执行本迁移，再部署支持重复选词的 Worker。

CREATE TABLE IF NOT EXISTS recite_task_words_new (
  task_id TEXT NOT NULL REFERENCES recite_tasks(id) ON DELETE CASCADE,
  word TEXT NOT NULL,
  list_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  type TEXT NOT NULL,
  display_text TEXT,
  translation TEXT,
  source_type TEXT NOT NULL,
  source_group TEXT,
  source_last_at INTEGER,
  spelling_enabled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, position)
) STRICT;

INSERT OR IGNORE INTO recite_task_words_new
  (task_id, word, list_id, position, type, display_text, translation,
   source_type, source_group, source_last_at, spelling_enabled)
SELECT task_id, word, list_id, position, type, display_text, translation,
       source_type, source_group, source_last_at, spelling_enabled
FROM recite_task_words;

DROP TABLE IF EXISTS recite_task_words;
ALTER TABLE recite_task_words_new RENAME TO recite_task_words;
CREATE INDEX IF NOT EXISTS idx_recite_task_words_position ON recite_task_words(task_id, position);
