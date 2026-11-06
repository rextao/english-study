-- 开始背单词任务、学习会话和卡片状态。
-- 上线顺序：先执行本迁移，再部署使用 /api/recite 的 Worker。

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
