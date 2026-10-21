CREATE TABLE IF NOT EXISTS study_tally_operations (
  request_id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
