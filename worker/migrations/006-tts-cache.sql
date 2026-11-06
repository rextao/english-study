-- 背单词页的喇叭（Google TTS）：合成好的 MP3 按「音色|文本」缓存一行。
-- 新建 D1 已由 schema.sql 创建；已有 D1 在上线带发音的 Worker 前执行一次。
-- 不跑也能用：worker/src/tts.js 读不到这张表时按未命中处理，只是每次都要重新合成。
CREATE TABLE IF NOT EXISTS tts_cache (
  cache_key TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'audio/mpeg',
  audio_base64 TEXT NOT NULL,
  cached_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tts_cache_cached_at ON tts_cache(cached_at);
