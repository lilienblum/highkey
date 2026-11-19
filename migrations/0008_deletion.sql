-- A deleted project is hidden and its keys stop at once; it can be restored for 7 days, then the
-- reconcile enqueues its wipe. Never edit an applied migration; add a new numbered file.
ALTER TABLE products ADD COLUMN deleted_at TEXT;
CREATE INDEX products_deleted_at ON products(deleted_at) WHERE deleted_at IS NOT NULL;
