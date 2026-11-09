-- 只在此前已经执行过旧版 007（recite_recordings 没有 status 列）时才需要补跑。
-- 新的 007 已经包含这一列，新建库 / 首次执行 007 时不用执行本文件。
ALTER TABLE recite_recordings ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';
