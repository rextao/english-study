-- 背词课堂录音：孩子在背词页学完一次后自动上传一段音频，最多保留 15 天。
-- 音频按 400KB 一片上传（断网只重传那一片），所以分片要单独存表。
-- 新建 D1 已由 schema.sql 创建；已有 D1 在上线带录音的 Worker 前执行一次：
--   npx wrangler d1 execute english-study-sync --remote --file=worker/migrations/007-recite-recordings.sql
-- 不跑也能用：接口读不到这张表时按「没有录音」处理，只是上传会失败。

CREATE TABLE IF NOT EXISTS recite_recordings (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  week_start INTEGER,
  session_index INTEGER,
  mime TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  -- uploading = 分片还没传齐，ready = 可播放；只有 ready 的出现在列表里
  status TEXT NOT NULL DEFAULT 'ready',
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_recite_recordings_created_at ON recite_recordings(created_at);

-- 音频按段存：D1 单行有大小上限，整段 base64 塞一行会写不进去
CREATE TABLE IF NOT EXISTS recite_recording_chunks (
  recording_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data_base64 TEXT NOT NULL,
  PRIMARY KEY (recording_id, idx)
) STRICT;
