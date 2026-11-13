use super::model::Log;
use crate::{
    error::{ApiError, ApiResult},
    model::Ack,
    store::Store,
};
use anyhow::Context;
use duckdb::{Connection, params};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        mpsc::{self, Receiver, SyncSender},
    },
};
use tokio::sync::oneshot;

struct Batch {
    project: String,
    source: String,
    logs: Vec<Log>,
    ack: oneshot::Sender<ApiResult<Ack>>,
}
enum Write {
    Batch(Batch),
    Cleanup(oneshot::Sender<ApiResult<usize>>),
    Stop(oneshot::Sender<()>),
}
#[derive(Clone)]
pub struct Writer {
    tx: SyncSender<Write>,
}
impl Writer {
    pub fn start(store: Arc<Store>) -> anyhow::Result<Self> {
        let (tx, rx) = mpsc::sync_channel(16);
        std::thread::Builder::new()
            .name("piko-log-writer".into())
            .spawn(move || run(&store, rx))?;
        Ok(Self { tx })
    }
    pub async fn ingest(&self, project: String, source: String, logs: Vec<Log>) -> ApiResult<Ack> {
        let (ack, rx) = oneshot::channel();
        self.tx
            .try_send(Write::Batch(Batch {
                project,
                source,
                logs,
                ack,
            }))
            .map_err(|_| ApiError::busy())?;
        tokio::time::timeout(std::time::Duration::from_secs(10), rx)
            .await
            .map_err(|_| ApiError::busy())?
            .map_err(|_| ApiError::busy())?
    }
    pub async fn cleanup(&self) -> ApiResult<usize> {
        let (ack, rx) = oneshot::channel();
        self.tx
            .try_send(Write::Cleanup(ack))
            .map_err(|_| ApiError::busy())?;
        rx.await.map_err(|_| ApiError::busy())?
    }
    pub async fn stop(&self) {
        let (ack, rx) = oneshot::channel();
        let tx = self.tx.clone();
        if tokio::task::spawn_blocking(move || tx.send(Write::Stop(ack)))
            .await
            .is_ok_and(|r| r.is_ok())
        {
            let _ = rx.await;
        }
    }
}
fn run(store: &Store, rx: Receiver<Write>) {
    let mut pending = None;
    while let Some(message) = pending.take().or_else(|| rx.recv().ok()) {
        match message {
            Write::Batch(first) => {
                let mut projects = BTreeMap::<String, Vec<Batch>>::new();
                projects
                    .entry(first.project.clone())
                    .or_default()
                    .push(first);
                // Drain only queued work, with no added wait; controls remain FIFO barriers.
                for _ in 1..16 {
                    match rx.try_recv() {
                        Ok(Write::Batch(batch)) => {
                            projects
                                .entry(batch.project.clone())
                                .or_default()
                                .push(batch);
                        }
                        Ok(control) => {
                            pending = Some(control);
                            break;
                        }
                        Err(_) => break,
                    }
                }
                for (project, batches) in projects {
                    let result = store.logs.connection(&project).and_then(|mut lease| {
                        persist(&mut lease.connection, &batches).map_err(ApiError::from)
                    });
                    match result {
                        Ok(acks) => {
                            for (batch, ack) in batches.into_iter().zip(acks) {
                                let _ = batch.ack.send(Ok(ack));
                            }
                        }
                        Err(error) => {
                            for batch in batches {
                                let _ = batch.ack.send(Err(ApiError(error.0, error.1.clone())));
                            }
                        }
                    }
                }
            }
            Write::Cleanup(ack) => {
                let _ = ack.send(cleanup(store));
            }
            Write::Stop(ack) => {
                let _ = store.logs.checkpoint();
                let _ = ack.send(());
                return;
            }
        }
    }
    let _ = store.logs.checkpoint();
}
fn persist(db: &mut Connection, batches: &[Batch]) -> anyhow::Result<Vec<Ack>> {
    let tx = db.transaction()?;
    tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS log_buffer AS SELECT *, 0::BIGINT AS request_no, 0::BIGINT AS sequence FROM logs WHERE false; DELETE FROM log_buffer;")?;
    let mut acks = Vec::with_capacity(batches.len());
    {
        let mut append = tx.appender("log_buffer")?;
        let received = chrono::Utc::now().timestamp_millis();
        let mut sequence = 0_i64;
        for (request_no, batch) in batches.iter().enumerate() {
            acks.push(Ack {
                accepted: 0,
                duplicates: batch.logs.len(),
            });
            for log in &batch.logs {
                append.append_row(params![
                    log.log_id,
                    batch.source,
                    log.timestamp
                        .context("validated log timestamp")?
                        .timestamp_millis(),
                    received,
                    log.level,
                    log.message,
                    log.service,
                    log.environment,
                    log.trace_id,
                    log.span_id,
                    log.request_id,
                    serde_json::to_string(&log.attributes)?,
                    request_no as i64,
                    sequence
                ])?;
                sequence += 1;
            }
        }
        append.flush()?;
    }
    // First occurrence wins across requests and sources within this project's transaction.
    tx.execute_batch("CREATE OR REPLACE TEMP TABLE accepted_logs AS
        SELECT b.* FROM log_buffer b WHERE NOT EXISTS
        (SELECT 1 FROM logs l WHERE l.log_id=b.log_id)
        QUALIFY row_number() OVER (PARTITION BY log_id ORDER BY sequence)=1;
        INSERT INTO logs SELECT log_id,source_id,timestamp,received_at,level,message,service,environment,trace_id,span_id,request_id,attributes FROM accepted_logs;")?;
    {
        let mut counts =
            tx.prepare("SELECT request_no,count(*) FROM accepted_logs GROUP BY request_no")?;
        for row in counts.query_map([], |r| Ok((r.get::<_, usize>(0)?, r.get::<_, usize>(1)?)))? {
            let (index, count) = row?;
            acks[index].accepted = count;
            acks[index].duplicates -= count;
        }
    }
    tx.commit()?;
    Ok(acks)
}
fn cleanup(store: &Store) -> ApiResult<usize> {
    let db = store.sqlite()?;
    let mut count = 0;
    for project in crate::store::products(&db)? {
        if !store.logs.path(&project.id)?.exists() {
            continue;
        }
        let days = super::keys::retention(&db, &project.id)?;
        let mut lease = store.logs.connection(&project.id)?;
        let tx = lease
            .connection
            .transaction()
            .map_err(anyhow::Error::from)?;
        count += tx
            .execute(
                "DELETE FROM logs WHERE timestamp < ?",
                [chrono::Utc::now().timestamp_millis() - days * 86_400_000],
            )
            .map_err(anyhow::Error::from)?;
        tx.commit().map_err(anyhow::Error::from)?;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn batch(
        project: &str,
        source: &str,
        ids: &[&str],
    ) -> (Write, oneshot::Receiver<ApiResult<Ack>>) {
        let (ack, rx) = oneshot::channel();
        let logs = ids
            .iter()
            .map(|id| {
                serde_json::from_value(json!({
                    "log_id":id,"timestamp":chrono::Utc::now(),"service":"api","message":id
                }))
                .unwrap()
            })
            .collect();
        (
            Write::Batch(Batch {
                project: project.into(),
                source: source.into(),
                logs,
                ack,
            }),
            rx,
        )
    }

    #[test]
    fn queued_batches_preserve_project_deduplication_sources_and_stop_order() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path(), 2).unwrap();
        let a = uuid::Uuid::new_v4().to_string();
        let b = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::sync_channel(16);
        let (first, mut first_ack) = batch(&a, "source-a", &["shared", "first"]);
        let (other, mut other_ack) = batch(&b, "source-b", &["shared"]);
        let (second, mut second_ack) = batch(&a, "source-c", &["shared", "second", "second"]);
        tx.send(first).unwrap();
        tx.send(other).unwrap();
        tx.send(second).unwrap();
        let (stop, mut stopped) = oneshot::channel();
        tx.send(Write::Stop(stop)).unwrap();
        let (late, mut late_ack) = batch(&a, "late", &["after-stop"]);
        tx.send(late).unwrap();
        assert!(matches!(
            first_ack.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        run(&store, rx);
        assert_eq!(first_ack.try_recv().unwrap().unwrap().accepted, 2);
        assert_eq!(other_ack.try_recv().unwrap().unwrap().accepted, 1);
        let second = second_ack.try_recv().unwrap().unwrap();
        assert_eq!((second.accepted, second.duplicates), (1, 2));
        stopped.try_recv().unwrap();
        assert!(matches!(
            late_ack.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
        let lease = store.logs.connection(&a).unwrap();
        let rows: Vec<(String, String)> = lease
            .connection
            .prepare("SELECT log_id,source_id FROM logs ORDER BY log_id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<duckdb::Result<_>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                ("first".into(), "source-a".into()),
                ("second".into(), "source-c".into()),
                ("shared".into(), "source-a".into())
            ]
        );
    }

    #[test]
    fn a_failed_group_rolls_back_and_rejects_every_request_then_writer_recovers() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path(), 2).unwrap();
        let project = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::sync_channel(16);
        let (good, mut good_ack) = batch(&project, "api", &["valid"]);
        let (mut bad, mut bad_ack) = batch(&project, "api", &["invalid"]);
        if let Write::Batch(batch) = &mut bad {
            batch.logs[0].timestamp = None;
        }
        tx.send(good).unwrap();
        tx.send(bad).unwrap();
        let (barrier, mut cleaned) = oneshot::channel();
        tx.send(Write::Cleanup(barrier)).unwrap();
        let (retry, mut retry_ack) = batch(&project, "api", &["valid"]);
        tx.send(retry).unwrap();
        let (stop, _) = oneshot::channel();
        tx.send(Write::Stop(stop)).unwrap();
        run(&store, rx);
        assert!(good_ack.try_recv().unwrap().is_err());
        assert!(bad_ack.try_recv().unwrap().is_err());
        cleaned.try_recv().unwrap().unwrap();
        assert_eq!(retry_ack.try_recv().unwrap().unwrap().accepted, 1);
        let lease = store.logs.connection(&project).unwrap();
        assert_eq!(
            lease
                .connection
                .query_row("SELECT count(*) FROM logs", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}
