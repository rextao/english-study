-- 点「会 / 不会」先落草稿：不推进轮次，家长换设备也能读回计数并确认。
-- 上线顺序：先执行本迁移，再部署使用 /drafts 与 /commit 的 Worker。

CREATE TABLE IF NOT EXISTS recite_card_drafts (
  session_id TEXT NOT NULL REFERENCES recite_sessions(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES recite_cards(id) ON DELETE CASCADE,
  result TEXT NOT NULL,
  answer TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, card_id)
) STRICT;
