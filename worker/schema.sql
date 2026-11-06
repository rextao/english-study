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

-- 默认列表是系统内建对象；整库读时代码曾在内存兜底，现在由 D1 显式持有。
INSERT OR IGNORE INTO lists (id, name, created_at, position, batch_names_json)
VALUES ('default', '默认列表', 0, 0, '{}');

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
  processed_review_keys_json TEXT NOT NULL, batch_key TEXT, suspended_at INTEGER,
  PRIMARY KEY (list_id, word)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_list_words_added ON list_words(added_at);
CREATE INDEX IF NOT EXISTS idx_list_words_word ON list_words(word, list_id);
CREATE INDEX IF NOT EXISTS idx_list_words_started ON list_words(list_id, started_at)
  WHERE started_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_list_words_active_plan ON list_words(list_id, started_at, suspended_at)
  WHERE started_at IS NOT NULL AND suspended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_list_words_repair_phonetic ON list_words(word)
  WHERE phonetic IS NULL OR phonetic = '';
CREATE INDEX IF NOT EXISTS idx_list_words_repair_translation ON list_words(word)
  WHERE translation IS NULL OR translation = '';

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
CREATE INDEX IF NOT EXISTS idx_learning_events_tally_period
  ON learning_events(deleted_at, action, occurred_at, list_id, word_key)
  WHERE action IN ('spelling', 'reading', 'meaning');

-- 批量熟悉度操作的幂等账本；用于刷新 / 重试后避免同一批操作重复执行。
CREATE TABLE IF NOT EXISTS study_tally_operations (
  request_id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

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
  word TEXT PRIMARY KEY, entry_json TEXT NOT NULL,
  -- 词条完整度。只是给统计 / 运维查询用的冗余列，行为判断仍以 entry_json 里的
  -- status 为准（见 normalizeEntry），由 kv.js 的 UPSERT 随写更新，避免两处真相打架。
  status TEXT NOT NULL DEFAULT 'partial'
) STRICT;

-- 开始背单词：周任务、学习会话和卡片状态。任务词池与学习列表词条分开，
-- 只保存任务快照和会话进度，不替代 list_words 的复习排期。
CREATE TABLE IF NOT EXISTS recite_tasks (
  id TEXT PRIMARY KEY,
  week_start INTEGER NOT NULL UNIQUE,
  week_end INTEGER NOT NULL,
  per_session_count INTEGER NOT NULL,
  session_count INTEGER NOT NULL,
  capacity INTEGER NOT NULL,
  config_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS recite_task_words (
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
  PRIMARY KEY (task_id, word)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_recite_task_words_position ON recite_task_words(task_id, position);

CREATE TABLE IF NOT EXISTS recite_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES recite_tasks(id) ON DELETE CASCADE,
  session_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  card_count INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  completed_at INTEGER,
  completion_request_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(task_id, session_index)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_recite_sessions_task_status ON recite_sessions(task_id, status, session_index);

CREATE TABLE IF NOT EXISTS recite_cards (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES recite_sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  word TEXT NOT NULL,
  list_id TEXT NOT NULL,
  card_type TEXT NOT NULL,
  display_text TEXT,
  translation TEXT,
  answer TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  request_id TEXT UNIQUE,
  answered_at INTEGER,
  UNIQUE(session_id, position)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_recite_cards_session_status ON recite_cards(session_id, status, position);

-- 点「会 / 不会」先落草稿：不推进轮次，家长换设备也能读回计数并确认
CREATE TABLE IF NOT EXISTS recite_card_drafts (
  session_id TEXT NOT NULL REFERENCES recite_sessions(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES recite_cards(id) ON DELETE CASCADE,
  result TEXT NOT NULL,
  answer TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, card_id)
) STRICT;

-- /api/dict/sources 的缓存统计按 status 计数，不必再读整张表的 entry_json 逐条解析
CREATE INDEX IF NOT EXISTS idx_dict_cache_status ON dict_cache(status);

-- 单词发音缓存（Google TTS 合成的 MP3，base64 存一行）；按「音色|文本」命中
CREATE TABLE IF NOT EXISTS tts_cache (
  cache_key TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'audio/mpeg',
  audio_base64 TEXT NOT NULL,
  cached_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tts_cache_cached_at ON tts_cache(cached_at);

-- 快照同步机制已随「后端上云」退役，旧表直接丢弃
DROP TABLE IF EXISTS sync_snapshot;
