DROP TRIGGER IF EXISTS sync_dirty_receivables_ins;

--bun:split
DROP TRIGGER IF EXISTS sync_dirty_receivables_upd;

--bun:split
DROP TRIGGER IF EXISTS sync_dirty_receivables_del;

--bun:split
DROP TABLE IF EXISTS receivables;
