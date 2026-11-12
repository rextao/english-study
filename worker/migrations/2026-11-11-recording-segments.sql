-- 课堂录音分段：同一次学习可能因为关页面 / 切后台录成多段，需要按时间顺序拼回整段。
-- 已在用的库只跑这一个文件即可（新库直接跑 worker/schema.sql）。
--   npx wrangler d1 execute english-study-sync --remote --file=worker/migrations/2026-11-11-recording-segments.sql

-- 片段的上传幂等键：本地缓存补传时不会重复入库
ALTER TABLE recite_recordings ADD COLUMN client_key TEXT;
-- 片段开始录制的时间（客户端毫秒）与会话内序号，用于按时间拼回整段
ALTER TABLE recite_recordings ADD COLUMN recorded_at INTEGER;
ALTER TABLE recite_recordings ADD COLUMN segment_index INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_recite_recordings_client_key ON recite_recordings(client_key);