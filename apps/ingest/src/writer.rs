//! Writes accepted rows to ClickHouse and acknowledges each request only after ClickHouse has
//! stored them. Each product's requests are written one batch at a time, in arrival order, so
//! a retry always sees the earlier write; different products are written in parallel. While a
//! product's batch is in flight, new requests for it collect into the next one, so batches
//! grow with load.
use crate::{
    changes::{Changes, Signal},
    clickhouse::ClickHouse,
    dedup::{self, DEDUP_WINDOW},
    error::{ApiError, ApiResult},
    model::Ack,
};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    marker::PhantomData,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot};
use uuid::Uuid;

/// Requests drained into one batch.
pub const MAX_BATCH_REQUESTS: usize = 100;
/// Inserts in flight at once, across products.
pub const INSERT_CONCURRENCY: usize = 4;
/// How long a request waits for its acknowledgment.
pub const ACK_TIMEOUT: Duration = Duration::from_secs(10);

/// Where a row came from and how long it is kept.
#[derive(Debug, Clone, Copy)]
pub struct RowContext {
    pub product: Uuid,
    pub source: Uuid,
    pub received_at: DateTime<Utc>,
    pub retention_days: u16,
}

/// A record the writer stores.
pub trait Row: Send + 'static {
    const TABLE: &'static str;
    const ID_COLUMN: &'static str;
    const COLUMNS: &'static [&'static str];
    const SIGNAL: Signal;
    fn id(&self) -> &str;
    /// The row as JSONEachRow, with exactly `COLUMNS`.
    fn json(&self, context: &RowContext) -> Value;
}

struct Job<R> {
    context: RowContext,
    rows: Vec<R>,
    reply: oneshot::Sender<ApiResult<Ack>>,
    _queued: OwnedSemaphorePermit,
}

struct Queue<R> {
    jobs: VecDeque<Job<R>>,
    working: bool,
}

struct Inner<R> {
    clickhouse: ClickHouse,
    changes: Changes,
    queues: Mutex<HashMap<Uuid, Queue<R>>>,
    queued: Arc<Semaphore>,
    inserts: Arc<Semaphore>,
}

pub struct Writer<R> {
    inner: Arc<Inner<R>>,
    _rows: PhantomData<fn() -> R>,
}

impl<R> Clone for Writer<R> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            _rows: PhantomData,
        }
    }
}

impl<R: Row> Writer<R> {
    /// A writer that holds at most `capacity` waiting requests.
    pub fn spawn(clickhouse: ClickHouse, capacity: usize, changes: Changes) -> Self {
        Self {
            inner: Arc::new(Inner {
                clickhouse,
                changes,
                queues: Mutex::default(),
                queued: Arc::new(Semaphore::new(capacity)),
                inserts: Arc::new(Semaphore::new(INSERT_CONCURRENCY)),
            }),
            _rows: PhantomData,
        }
    }

    /// Stores `rows` for the product and returns how many were new. Fails with 503 when the
    /// queue is full or the acknowledgment takes too long; a late write is then deduplicated
    /// when the client retries.
    pub async fn submit(
        &self,
        product: Uuid,
        source: Uuid,
        retention_days: u16,
        rows: Vec<R>,
    ) -> ApiResult<Ack> {
        let queued = self
            .inner
            .queued
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::busy())?;
        let (reply, ack) = oneshot::channel();
        let job = Job {
            context: RowContext {
                product,
                source,
                received_at: Utc::now(),
                retention_days,
            },
            rows,
            reply,
            _queued: queued,
        };
        let start = {
            let mut queues = self.inner.queues.lock().expect("writer queues");
            let queue = queues.entry(product).or_insert_with(|| Queue {
                jobs: VecDeque::new(),
                working: false,
            });
            queue.jobs.push_back(job);
            !std::mem::replace(&mut queue.working, true)
        };
        if start {
            tokio::spawn(work(self.inner.clone(), product));
        }
        match tokio::time::timeout(ACK_TIMEOUT, ack).await {
            Ok(Ok(result)) => result,
            _ => Err(ApiError::busy()),
        }
    }
}

async fn work<R: Row>(inner: Arc<Inner<R>>, product: Uuid) {
    loop {
        let jobs: Vec<Job<R>> = {
            let mut queues = inner.queues.lock().expect("writer queues");
            let Some(queue) = queues.get_mut(&product) else {
                return;
            };
            if queue.jobs.is_empty() {
                queues.remove(&product);
                return;
            }
            let take = queue.jobs.len().min(MAX_BATCH_REQUESTS);
            queue.jobs.drain(..take).collect()
        };
        let _insert = inner.inserts.acquire().await.expect("insert slots");
        write(&inner, product, jobs).await;
    }
}

fn fail<R>(jobs: Vec<Job<R>>, error: impl Fn() -> ApiError) {
    for job in jobs {
        let _ = job.reply.send(Err(error()));
    }
}

async fn write<R: Row>(inner: &Inner<R>, product: Uuid, jobs: Vec<Job<R>>) {
    // The first occurrence of an id wins, within the batch and across its requests.
    let mut first = HashSet::new();
    let mut fresh: Vec<Vec<bool>> = Vec::with_capacity(jobs.len());
    for job in &jobs {
        fresh.push(job.rows.iter().map(|row| first.insert(row.id())).collect());
    }
    let ids: Vec<&str> = first.iter().copied().collect();
    let since = Utc::now()
        - chrono::Duration::from_std(DEDUP_WINDOW).expect("window fits a chrono duration");
    let stored = match dedup::existing(
        &inner.clickhouse,
        R::TABLE,
        R::ID_COLUMN,
        product,
        &ids,
        since,
    )
    .await
    {
        Ok(stored) => stored,
        Err(error) => {
            let error = ApiError::from(error);
            let (status, message) = (error.0, error.1);
            return fail(jobs, || ApiError(status, message.clone()));
        }
    };
    let mut rows = Vec::new();
    let mut acks = Vec::with_capacity(jobs.len());
    for (job, fresh) in jobs.iter().zip(&fresh) {
        let mut ack = Ack {
            accepted: 0,
            duplicates: 0,
        };
        for (row, &fresh) in job.rows.iter().zip(fresh) {
            if fresh && !stored.contains(row.id()) {
                rows.push(row.json(&job.context));
                ack.accepted += 1;
            } else {
                ack.duplicates += 1;
            }
        }
        acks.push(ack);
    }
    if !rows.is_empty() {
        let inserted = inner
            .clickhouse
            .insert_json_each_row(
                R::TABLE,
                R::COLUMNS,
                &rows,
                &[
                    ("async_insert", "1"),
                    ("wait_for_async_insert", "1"),
                    ("json_type_escape_dots_in_keys", "1"),
                    // A string that looks like a date stays the string it was sent as; inference
                    // would store it as a Date, drop its offset, and stop string filters matching.
                    ("input_format_try_infer_dates", "0"),
                    ("input_format_try_infer_datetimes", "0"),
                ],
            )
            .await;
        if let Err(error) = inserted {
            let error = ApiError::from(error);
            let (status, message) = (error.0, error.1);
            return fail(jobs, || ApiError(status, message.clone()));
        }
        inner.changes.changed(&product.to_string(), R::SIGNAL);
    }
    for (job, ack) in jobs.into_iter().zip(acks) {
        let _ = job.reply.send(Ok(ack));
    }
}
