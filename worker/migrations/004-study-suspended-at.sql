-- 暂时移出学习计划：只隐藏计划展示，不清除原有学习进度。
ALTER TABLE list_words ADD COLUMN suspended_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_list_words_active_plan ON list_words(list_id, started_at, suspended_at)
  WHERE started_at IS NOT NULL AND suspended_at IS NULL;
