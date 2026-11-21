use crate::error::{ApiError, ApiResult};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordType {
    #[default]
    Event,
    Identify,
    Group,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    #[serde(skip)]
    pub request_context: std::sync::Arc<RequestContext>,
    #[serde(skip)]
    pub sdk: &'static str,
    pub event_id: String,
    pub name: String,
    pub source: String,
    pub timestamp: Option<DateTime<Utc>>,
    pub actor_id: Option<String>,
    pub identity_kind: Option<String>,
    pub session_id: Option<String>,
    #[serde(default)]
    pub record_type: RecordType,
    #[serde(default)]
    pub backfill: bool,
    pub profile_id: Option<String>,
    pub group_type: Option<String>,
    pub group_id: Option<String>,
    pub group_name: Option<String>,
    #[serde(default)]
    pub traits: Map<String, Value>,
    #[serde(default)]
    pub increments: Map<String, Value>,
    #[serde(default)]
    pub groups: BTreeMap<String, String>,
    pub ai_prompt: Option<String>,
    #[serde(default)]
    pub properties: Map<String, Value>,
}
#[derive(Default, Clone)]
pub struct RequestContext {
    pub ip: String,
    pub ua: String,
    pub site: String,
    pub web: bool,
    pub fetch: bool,
}
// The transient inputs are never part of debug output.
impl std::fmt::Debug for RequestContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RequestContext")
    }
}
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum IngestPayload {
    Single(Box<Event>),
    Batch { events: Vec<Event> },
}
impl IngestPayload {
    pub fn events(self) -> Vec<Event> {
        match self {
            Self::Single(e) => vec![*e],
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
        if *time > now + chrono::Duration::minutes(1) {
            *time = now;
        }
        if *time < now - chrono::Duration::days(retention) {
            return Err(ApiError::bad("timestamp is outside product retention"));
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
        if self
            .profile_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 128)
        {
            return Err(ApiError::bad("profile_id requires 1–128 bytes"));
        }
        if self.groups.len() > 8
            || self
                .groups
                .iter()
                .any(|(kind, id)| !valid_key(kind) || id.is_empty() || id.len() > 128)
        {
            return Err(ApiError::bad(
                "Use up to 8 groups, with valid types and 1–128 byte ids",
            ));
        }
        match self.record_type {
            RecordType::Identify if self.profile_id.is_none() => {
                return Err(ApiError::bad("Identify requires profile_id"));
            }
            RecordType::Group
                if !self.group_type.as_deref().is_some_and(valid_key)
                    || !self
                        .group_id
                        .as_ref()
                        .is_some_and(|id| !id.is_empty() && id.len() <= 128) =>
            {
                return Err(ApiError::bad(
                    "Group requires a valid group_type and 1–128 byte group_id",
                ));
            }
            _ => {}
        }
        if self
            .group_name
            .as_ref()
            .is_some_and(|name| name.len() > 256)
        {
            return Err(ApiError::bad("group_name must be at most 256 bytes"));
        }
        if self
            .group_type
            .as_deref()
            .is_some_and(|kind| !valid_key(kind))
            || self
                .group_id
                .as_ref()
                .is_some_and(|id| id.is_empty() || id.len() > 128)
        {
            return Err(ApiError::bad(
                "Use a valid group_type and 1–128 byte group_id",
            ));
        }
        if self.record_type != RecordType::Group
            && (self.group_type.is_some() || self.group_id.is_some() || self.group_name.is_some())
        {
            return Err(ApiError::bad("Group fields belong to group records"));
        }
        if self.record_type == RecordType::Event
            && (!self.traits.is_empty() || !self.increments.is_empty())
        {
            return Err(ApiError::bad(
                "Traits and increments belong to identify or group records",
            ));
        }
        if self.increments.len() > 32
            || self
                .increments
                .iter()
                .any(|(key, value)| !valid_key(key) || !value.as_f64().is_some_and(f64::is_finite))
        {
            return Err(ApiError::bad(
                "Increments require up to 32 finite numeric values with valid keys",
            ));
        }
        if self
            .ai_prompt
            .as_ref()
            .is_some_and(|prompt| prompt.len() > 32768)
            || (self.ai_prompt.is_some()
                && (self.record_type != RecordType::Event || self.name != "ai_generation"))
        {
            return Err(ApiError::bad(
                "ai_prompt is limited to 32768 bytes on ai_generation events",
            ));
        }
        if let Some(revenue) = self.properties.get("revenue")
            && (self.record_type != RecordType::Event
                || !revenue.as_i64().is_some_and(|cents| {
                    (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&cents)
                }))
        {
            return Err(ApiError::bad(
                "revenue must be safe integer cents on an event",
            ));
        }
        for properties in [&self.properties, &self.traits] {
            validate_properties(properties)?;
        }
        Ok(())
    }
}

fn validate_properties(properties: &Map<String, Value>) -> ApiResult<()> {
    if properties.len() > 32 {
        return Err(ApiError::bad("Maximum 32 properties"));
    }
    for (key, value) in properties {
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
#[derive(Debug, Serialize, Deserialize)]
pub struct Ack {
    pub accepted: usize,
    pub duplicates: usize,
}

impl crate::writer::Row for Event {
    const TABLE: &'static str = "highkey.events";
    const ID_COLUMN: &'static str = "event_id";
    const COLUMNS: &'static [&'static str] = &[
        "product_id",
        "source_id",
        "event_id",
        "name",
        "source",
        "sdk",
        "request_ip",
        "request_ua",
        "request_site",
        "request_web",
        "request_fetch",
        "event_time",
        "received_at",
        "actor_id",
        "identity_kind",
        "session_id",
        "properties",
        "record_type",
        "backfill",
        "profile_id",
        "group_type",
        "group_id",
        "group_name",
        "traits",
        "increments",
        "groups",
        "ai_prompt",
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
            "sdk": self.sdk,
            "request_ip": self.request_context.ip,"request_ua": self.request_context.ua,
            "request_site":self.request_context.site,"request_web":u8::from(self.request_context.web),"request_fetch":u8::from(self.request_context.fetch),
            "event_time": datetime64(time),
            "received_at": datetime64(context.received_at),
            "actor_id": self.actor_id,
            "identity_kind": self.identity_kind,
            "session_id": self.session_id,
            "properties": self.properties,
            "record_type": self.record_type,
            "backfill": self.backfill,
            "profile_id": self.profile_id,
            "group_type": self.group_type.as_deref().unwrap_or(""),
            "group_id": self.group_id.as_deref().unwrap_or(""),
            "group_name": self.group_name.as_deref().unwrap_or(""),
            "traits": self.traits,
            "increments": self.increments,
            "groups": self.groups,
            "ai_prompt": self.ai_prompt.as_deref().unwrap_or(""),
            "expires_at": datetime(time + chrono::Duration::days(i64::from(context.retention_days))),
        })
    }
}
