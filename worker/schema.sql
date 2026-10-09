-- 云端同步用的 D1 表：只存一份「当前快照」
CREATE TABLE IF NOT EXISTS sync_snapshot (
  id TEXT PRIMARY KEY,
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL DEFAULT '',
  exported_at INTEGER NOT NULL DEFAULT 0,
  device_label TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);

