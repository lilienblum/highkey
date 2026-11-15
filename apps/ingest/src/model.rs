use crate::error::{ApiError, ApiResult};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub event_id: String,
    pub name: String,
    pub source: String,
    pub timestamp: Option<DateTime<Utc>>,
    pub actor_id: Option<String>,
    pub identity_kind: Option<String>,
    pub session_id: Option<String>,
    #[serde(default)]
    pub properties: Map<String, Value>,
}
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum IngestPayload {
    Single(Event),
    Batch { events: Vec<Event> },
}
impl IngestPayload {
    pub fn events(self) -> Vec<Event> {
        match self {
            Self::Single(e) => vec![e],
            Self::Batch { events } => events,
        }
    }
}
pub fn valid_key(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-./".contains(&b))
}
impl Event {
    pub fn validate(&mut self, now: DateTime<Utc>, retention: i64) -> ApiResult<()> {
        if !valid_key(&self.event_id) || !valid_key(&self.name) || !valid_key(&self.source) {
            return Err(ApiError::bad(
                "event_id, name and source require 1–64 ASCII letters, digits, _, -, . or /",
            ));
        }
        let time = self.timestamp.get_or_insert(now);
        if *time > now + chrono::Duration::minutes(5)
            || *time < now - chrono::Duration::days(retention)
        {
            return Err(ApiError::bad(
                "timestamp is outside product retention or more than 5 minutes in the future",
            ));
        }
        if self
            .actor_id
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.len() > 128)
            || self
                .session_id
                .as_ref()
                .is_some_and(|s| s.is_empty() || s.len() > 128)
        {
            return Err(ApiError::bad(
                "actor_id and session_id require 1–128 characters",
            ));
        }
        if self.actor_id.is_some() != self.identity_kind.is_some()
            || self
                .identity_kind
                .as_ref()
                .is_some_and(|s| !["visitor", "installation", "actor"].contains(&s.as_str()))
        {
            return Err(ApiError::bad(
                "actor_id requires identity_kind: visitor, installation or actor (and vice versa)",
            ));
        }
        if self.session_id.is_some() && self.identity_kind.as_deref() != Some("visitor") {
            return Err(ApiError::bad(
                "session_id is only valid with a visitor identity",
            ));
        }
        if self.properties.len() > 32 {
            return Err(ApiError::bad("Maximum 32 properties"));
        }
        for (key, value) in &self.properties {
            if !valid_key(key)
                || !(value.is_boolean()
                    || value.is_number()
                    || value.as_str().is_some_and(|s| s.len() <= 2048))
            {
                return Err(ApiError::bad(
                    "Properties must be flat strings (≤2048 bytes), numbers or booleans, with valid keys",
                ));
            }
        }
        Ok(())
    }
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Ack {
    pub accepted: usize,
    pub duplicates: usize,
}

impl crate::writer::Row for Event {
    const TABLE: &'static str = "piko.events";
    const ID_COLUMN: &'static str = "event_id";
    const COLUMNS: &'static [&'static str] = &[
        "product_id",
        "source_id",
        "event_id",
        "name",
        "source",
        "event_time",
        "received_at",
        "actor_id",
        "identity_kind",
        "session_id",
        "properties",
        "expires_at",
    ];
    const SIGNAL: crate::changes::Signal = crate::changes::Signal::Events;

    fn id(&self) -> &str {
        &self.event_id
    }

    /// Call only after `validate`, which fills in the timestamp.
    fn json(&self, context: &crate::writer::RowContext) -> Value {
        use crate::clickhouse::{datetime, datetime64};
        let time = self.timestamp.unwrap_or(context.received_at);
        serde_json::json!({
            "product_id": context.product,
            "source_id": context.source,
            "event_id": self.event_id,
            "name": self.name,
            "source": self.source,
            "event_time": datetime64(time),
            "received_at": datetime64(context.received_at),
            "actor_id": self.actor_id,
            "identity_kind": self.identity_kind,
            "session_id": self.session_id,
            "properties": self.properties,
            "expires_at": datetime(time + chrono::Duration::days(i64::from(context.retention_days))),
        })
    }
}
