-- 英语学习 · 云端应用库 schema（D1 = SQLite，与原本地 study-history.sqlite 的表结构保持一致）
--
-- 本地版的建表语句分散在 server/study-lists.mjs / server/kv.mjs / server/study-history.mjs 里、
-- 启动时按需执行；上云后 schema 固定在这一份文件里，由
--   npx wrangler d1 execute <库名> --remote --file=worker/schema.sql
-- 一次性建好，Worker 运行时不再做 DDL。
-- 旧的 sync_snapshot 表（快照同步时代）不再使用，这里顺手清掉。

CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL,
  position INTEGER NOT NULL, batch_names_json TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS list_words (
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE, word TEXT NOT NULL,
  position INTEGER NOT NULL, type TEXT NOT NULL, display_text TEXT,
  source_ids_json TEXT NOT NULL, added_at INTEGER NOT NULL, phonetic TEXT, translation TEXT,
  sense_ids_json TEXT NOT NULL, translation_ids_json TEXT NOT NULL,
  custom_translations_json TEXT NOT NULL, started_at INTEGER, stage INTEGER,
  reviewed_json TEXT NOT NULL, last_done_at INTEGER, review_scope TEXT,
  mark_count INTEGER NOT NULL DEFAULT 0, review_count INTEGER NOT NULL DEFAULT 0,
  spelling_count INTEGER NOT NULL DEFAULT 0, reading_count INTEGER NOT NULL DEFAULT 0,
  remembered_count INTEGER NOT NULL DEFAULT 0, forgotten_count INTEGER NOT NULL DEFAULT 0,
  processed_review_keys_json TEXT NOT NULL, batch_key TEXT,
  PRIMARY KEY (list_id, word)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_list_words_added ON list_words(added_at);

CREATE TABLE IF NOT EXISTS meaning_profiles (
  meaning_key TEXT PRIMARY KEY,
  word_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  language TEXT NOT NULL,
  pos TEXT NOT NULL,
  text_snapshot TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS learning_events (
  id TEXT PRIMARY KEY,
  event_key TEXT UNIQUE,
  word_key TEXT NOT NULL,
  word_snapshot TEXT NOT NULL,
  action TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  scope TEXT,
  stage INTEGER,
  list_id TEXT,
  list_name_snapshot TEXT,
  source_ids_json TEXT NOT NULL,
  translation_ids_json TEXT NOT NULL,
  sense_ids_json TEXT NOT NULL,
  meaning_snapshot TEXT,
  request_id TEXT UNIQUE,
  metadata_json TEXT NOT NULL,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_learning_events_word_time
  ON learning_events(word_key, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_learning_events_action_time
  ON learning_events(action, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_learning_events_active_time
  ON learning_events(deleted_at, occurred_at DESC);

CREATE TABLE IF NOT EXISTS learning_event_meanings (
  event_id TEXT NOT NULL REFERENCES learning_events(id),
  meaning_key TEXT NOT NULL REFERENCES meaning_profiles(meaning_key),
  PRIMARY KEY (event_id, meaning_key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_event_meanings_meaning
  ON learning_event_meanings(meaning_key, event_id);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS dict_cache (
  word TEXT PRIMARY KEY, entry_json TEXT NOT NULL
) STRICT;

-- 快照同步机制已随「后端上云」退役，旧表直接丢弃
DROP TABLE IF EXISTS sync_snapshot;
