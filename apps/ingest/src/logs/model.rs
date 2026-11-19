use crate::error::{ApiError, ApiResult};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const MAX_BATCH: usize = 100;
pub const LEVELS: [&str; 6] = ["trace", "debug", "info", "warn", "error", "fatal"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Log {
    #[serde(default = "new_id")]
    pub log_id: String,
    pub timestamp: Option<DateTime<Utc>>,
    #[serde(default = "info")]
    pub level: String,
    pub message: String,
    pub service: String,
    pub environment: Option<String>,
    pub trace_id: Option<String>,
    pub span_id: Option<String>,
    pub request_id: Option<String>,
    #[serde(default)]
    pub attributes: Map<String, Value>,
}
fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}
fn info() -> String {
    "info".into()
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum Payload {
    Batch { logs: Vec<Log> },
    Single(Box<Log>),
}
impl Payload {
    pub fn records(self) -> Vec<Log> {
        match self {
            Self::Batch { logs } => logs,
            Self::Single(log) => vec![*log],
        }
    }
}
impl Log {
    pub fn validate(&mut self, now: DateTime<Utc>, retention: i64) -> ApiResult<()> {
        if !crate::model::valid_key(&self.log_id) {
            return Err(ApiError::bad(
                "log_id requires 1–64 ASCII letters, digits, _, -, . or /",
            ));
        }
        if !LEVELS.contains(&self.level.as_str()) {
            return Err(ApiError::bad(
                "level must be trace, debug, info, warn, error, or fatal",
            ));
        }
        if self.message.is_empty()
            || self.message.len() > 16_384
            || self.service.trim().is_empty()
            || self.service.len() > 128
        {
            return Err(ApiError::bad(
                "message requires 1–16384 bytes and service requires 1–128 bytes",
            ));
        }
        let timestamp = self.timestamp.get_or_insert(now);
        if *timestamp > now + chrono::Duration::minutes(5)
            || *timestamp < now - chrono::Duration::days(retention)
        {
            return Err(ApiError::bad(
                "timestamp is outside log retention or more than 5 minutes in the future",
            ));
        }
        for (name, value, length) in [
            ("trace_id", &self.trace_id, 32),
            ("span_id", &self.span_id, 16),
        ] {
            if value.as_ref().is_some_and(|s| {
                s.len() != length
                    || !s.bytes().all(|b| b.is_ascii_hexdigit())
                    || s.bytes().all(|b| b == b'0')
            }) {
                return Err(ApiError::bad(format!(
                    "{name} must be a nonzero {length}-character hex ID"
                )));
            }
        }
        if self.span_id.is_some() && self.trace_id.is_none() {
            return Err(ApiError::bad("span_id requires trace_id"));
        }
        if self
            .environment
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.len() > 128)
            || self
                .request_id
                .as_ref()
                .is_some_and(|s| s.is_empty() || s.len() > 128)
        {
            return Err(ApiError::bad(
                "environment and request_id require 1–128 bytes",
            ));
        }
        if self.attributes.len() > 64
            || serde_json::to_vec(&self.attributes)
                .map_err(anyhow::Error::from)?
                .len()
                > 16_384
        {
            return Err(ApiError::bad(
                "Maximum 64 attributes and 16 KiB of attribute data",
            ));
        }
        if !self
            .attributes
            .iter()
            .all(|(k, v)| !k.is_empty() && k.len() <= 128 && attribute(v, 0))
        {
            return Err(ApiError::bad(
                "Attributes require finite JSON values, keys up to 128 bytes, and at most four nested levels",
            ));
        }
        self.service = self.service.trim().into();
        self.trace_id = self.trace_id.take().map(|s| s.to_ascii_lowercase());
        self.span_id = self.span_id.take().map(|s| s.to_ascii_lowercase());
        Ok(())
    }
}
fn attribute(value: &Value, depth: usize) -> bool {
    if depth > 4 {
        return false;
    }
    match value {
        Value::String(s) => s.len() <= 16_384,
        Value::Array(items) => items.len() <= 64 && items.iter().all(|v| attribute(v, depth + 1)),
        Value::Object(items) => {
            items.len() <= 64
                && items
                    .iter()
                    .all(|(k, v)| !k.is_empty() && k.len() <= 128 && attribute(v, depth + 1))
        }
        _ => true,
    }
}

impl crate::writer::Row for Log {
    const TABLE: &'static str = "highkey.logs";
    const ID_COLUMN: &'static str = "log_id";
    const COLUMNS: &'static [&'static str] = &[
        "product_id",
        "source_id",
        "log_id",
        "timestamp",
        "received_at",
        "level",
        "message",
        "service",
        "environment",
        "trace_id",
        "span_id",
        "request_id",
        "attributes",
        "expires_at",
    ];
    const SIGNAL: crate::changes::Signal = crate::changes::Signal::Logs;

    fn id(&self) -> &str {
        &self.log_id
    }

    /// Call only after `validate`, which fills in the timestamp.
    fn json(&self, context: &crate::writer::RowContext) -> Value {
        use crate::clickhouse::{datetime, datetime64};
        let time = self.timestamp.unwrap_or(context.received_at);
        serde_json::json!({
            "product_id": context.product,
            "source_id": context.source,
            "log_id": self.log_id,
            "timestamp": datetime64(time),
            "received_at": datetime64(context.received_at),
            "level": self.level,
            "message": self.message,
            "service": self.service,
            "environment": self.environment,
            "trace_id": self.trace_id,
            "span_id": self.span_id,
            "request_id": self.request_id,
            "attributes": self.attributes,
            "expires_at": datetime(time + chrono::Duration::days(i64::from(context.retention_days))),
        })
    }
}
