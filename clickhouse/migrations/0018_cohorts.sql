-- One replacement row publishes an entire membership atomically. Revision takes priority over
-- refresh time, so a scheduled calculation from an old definition cannot supersede an edit.
CREATE TABLE IF NOT EXISTS highkey.cohort_snapshots (
  product_id UUID, cohort_id UUID, revision UInt32, computed_ms UInt64,
  generation UInt128 MATERIALIZED bitShiftLeft(toUInt128(revision),64)+computed_ms,
  members Array(String)
) ENGINE=ReplacingMergeTree(generation) ORDER BY (product_id,cohort_id);

GRANT SELECT ON highkey.cohort_snapshots TO highkey_definer;
