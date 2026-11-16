-- Ingestion before dashboards. When ClickHouse's CPU is overloaded, released thread slots go to
-- the ingest app first, and project readers together use at most half the cores. Merges and
-- other background work stay outside these workloads.
CREATE RESOURCE IF NOT EXISTS piko_cpu (MASTER THREAD, WORKER THREAD);
CREATE WORKLOAD IF NOT EXISTS piko SETTINGS max_concurrent_threads_ratio_to_cores = 2;
CREATE WORKLOAD IF NOT EXISTS piko_ingest IN piko SETTINGS priority = -1;
CREATE WORKLOAD IF NOT EXISTS piko_readers IN piko SETTINGS max_concurrent_threads_ratio_to_cores = 0.5;

-- The ingest app's settings: its workload, and buffered inserts flushed within 50 ms, which
-- bounds how long an acknowledgment waits for its commit.
CREATE SETTINGS PROFILE OR REPLACE piko_ingest SETTINGS
    workload = 'piko_ingest' CONST,
    async_insert_busy_timeout_min_ms = 10,
    async_insert_busy_timeout_max_ms = 50;

ALTER SETTINGS PROFILE piko_reader ADD SETTINGS workload = 'piko_readers' CONST;
