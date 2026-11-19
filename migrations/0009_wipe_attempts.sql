-- When the reconcile last started a deleted project's wipe. A wipe run that fails for good is
-- retried an hour later as a new run, and meanwhile the next due project gets its turn.
ALTER TABLE products ADD COLUMN wipe_attempted_at TEXT;
