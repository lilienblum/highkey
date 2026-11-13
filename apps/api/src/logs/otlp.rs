//! Bounded OTLP/HTTP JSON and Protobuf log ingestion.
use super::model::{Log, MAX_BATCH};
use crate::error::{ApiError, ApiResult};
use axum::{
    body::Body,
    http::{HeaderMap, StatusCode},
    response::Response,
};
use base64::Engine;
use chrono::DateTime;
use prost::Message;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::io::Read;

#[derive(Clone, Message, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExportRequest {
    #[prost(message, repeated, tag = "1")]
    pub resource_logs: Vec<ResourceLogs>,
}
#[derive(Clone, Message, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ResourceLogs {
    #[prost(message, optional, tag = "1")]
    pub resource: Option<Resource>,
    #[prost(message, repeated, tag = "2")]
    pub scope_logs: Vec<ScopeLogs>,
}
#[derive(Clone, Message, Deserialize)]
#[serde(default)]
pub struct Resource {
    #[prost(message, repeated, tag = "1")]
    pub attributes: Vec<KeyValue>,
}
#[derive(Clone, Message, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ScopeLogs {
    #[prost(message, repeated, tag = "2")]
    pub log_records: Vec<Record>,
}
#[derive(Clone, Message, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Record {
    #[prost(fixed64, tag = "1")]
    #[serde(deserialize_with = "integer")]
    pub time_unix_nano: u64,
    #[prost(int32, tag = "2")]
    pub severity_number: i32,
    #[prost(string, tag = "3")]
    pub severity_text: String,
    #[prost(message, optional, tag = "5")]
    pub body: Option<AnyValue>,
    #[prost(message, repeated, tag = "6")]
    pub attributes: Vec<KeyValue>,
    #[prost(bytes = "vec", tag = "9")]
    #[serde(deserialize_with = "hex")]
    pub trace_id: Vec<u8>,
    #[prost(bytes = "vec", tag = "10")]
    #[serde(deserialize_with = "hex")]
    pub span_id: Vec<u8>,
    #[prost(fixed64, tag = "11")]
    #[serde(deserialize_with = "integer")]
    pub observed_time_unix_nano: u64,
}
#[derive(Clone, Message, Deserialize)]
#[serde(default)]
pub struct KeyValue {
    #[prost(string, tag = "1")]
    pub key: String,
    #[prost(message, optional, tag = "2")]
    pub value: Option<AnyValue>,
}
#[derive(Clone, Message, Deserialize)]
#[serde(default)]
pub struct AnyValue {
    #[prost(oneof = "ValueKind", tags = "1,2,3,4,5,6,7")]
    #[serde(flatten)]
    pub value: Option<ValueKind>,
}
#[derive(Clone, prost::Oneof, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ValueKind {
    #[prost(string, tag = "1")]
    StringValue(String),
    #[prost(bool, tag = "2")]
    BoolValue(bool),
    #[prost(int64, tag = "3")]
    IntValue(#[serde(deserialize_with = "signed_integer")] i64),
    #[prost(double, tag = "4")]
    DoubleValue(f64),
    #[prost(message, tag = "5")]
    ArrayValue(ArrayValue),
    #[prost(message, tag = "6")]
    KvlistValue(KeyValueList),
    #[prost(bytes, tag = "7")]
    BytesValue(#[serde(deserialize_with = "bytes")] Vec<u8>),
}
#[derive(Clone, Message, Deserialize)]
#[serde(default)]
pub struct ArrayValue {
    #[prost(message, repeated, tag = "1")]
    pub values: Vec<AnyValue>,
}
#[derive(Clone, Message, Deserialize)]
#[serde(default)]
pub struct KeyValueList {
    #[prost(message, repeated, tag = "1")]
    pub values: Vec<KeyValue>,
}
#[derive(Message)]
struct Status {
    #[prost(int32, tag = "1")]
    code: i32,
    #[prost(string, tag = "2")]
    message: String,
}

fn integer<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    let value = Value::deserialize(d)?;
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        .ok_or_else(|| serde::de::Error::custom("Expected an unsigned integer"))
}
fn signed_integer<'de, D: serde::Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    let value = Value::deserialize(d)?;
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        .ok_or_else(|| serde::de::Error::custom("Expected a signed integer"))
}
fn hex<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
    let value = String::deserialize(d)?;
    if value.len() % 2 != 0 {
        return Err(serde::de::Error::custom("Invalid hex ID"));
    }
    value
        .as_bytes()
        .chunks(2)
        .map(|pair| {
            std::str::from_utf8(pair)
                .ok()
                .and_then(|s| u8::from_str_radix(s, 16).ok())
                .ok_or_else(|| serde::de::Error::custom("Invalid hex ID"))
        })
        .collect()
}
fn bytes<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
    base64::engine::general_purpose::STANDARD
        .decode(String::deserialize(d)?)
        .map_err(serde::de::Error::custom)
}
fn attributes(items: Vec<KeyValue>, depth: usize) -> ApiResult<Map<String, Value>> {
    if items.len() > 64 || depth > 4 {
        return Err(ApiError::bad(
            "OTLP attributes exceed nesting or count limits",
        ));
    }
    items
        .into_iter()
        .map(|item| Ok((item.key, value(item.value.unwrap_or_default(), depth + 1)?)))
        .collect()
}
fn value(item: AnyValue, depth: usize) -> ApiResult<Value> {
    if depth > 5 {
        return Err(ApiError::bad("OTLP attributes exceed nesting limit"));
    }
    Ok(match item.value {
        None => Value::Null,
        Some(ValueKind::StringValue(s)) => Value::String(s),
        Some(ValueKind::BoolValue(v)) => Value::Bool(v),
        Some(ValueKind::IntValue(v)) => Value::from(v),
        Some(ValueKind::DoubleValue(v)) => {
            if !v.is_finite() {
                return Err(ApiError::bad("OTLP attributes must contain finite numbers"));
            }
            Value::from(v)
        }
        Some(ValueKind::ArrayValue(v)) => {
            if v.values.len() > 64 {
                return Err(ApiError::bad("OTLP array is too large"));
            }
            Value::Array(
                v.values
                    .into_iter()
                    .map(|v| value(v, depth + 1))
                    .collect::<ApiResult<_>>()?,
            )
        }
        Some(ValueKind::KvlistValue(v)) => Value::Object(attributes(v.values, depth + 1)?),
        Some(ValueKind::BytesValue(v)) => {
            Value::String(base64::engine::general_purpose::STANDARD.encode(v))
        }
    })
}
pub fn decode(headers: &HeaderMap, body: &[u8]) -> ApiResult<Vec<Log>> {
    let decoded;
    let body = match headers
        .get("content-encoding")
        .and_then(|s| s.to_str().ok())
    {
        None | Some("identity") => body,
        Some("gzip") => {
            let mut bytes = Vec::new();
            flate2::read::GzDecoder::new(body)
                .take(262_145)
                .read_to_end(&mut bytes)
                .map_err(|_| ApiError::bad("Invalid gzip body"))?;
            if bytes.len() > 262_144 {
                return Err(ApiError(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Decoded OTLP body exceeds 256 KiB".into(),
                ));
            }
            decoded = bytes;
            &decoded
        }
        _ => {
            return Err(ApiError(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "Supported content encodings: identity, gzip".into(),
            ));
        }
    };
    let content = headers
        .get("content-type")
        .and_then(|s| s.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("");
    let export: ExportRequest = match content {
        "application/json" => {
            serde_json::from_slice(body).map_err(|_| ApiError::bad("Invalid OTLP JSON"))?
        }
        "application/x-protobuf" => {
            ExportRequest::decode(body).map_err(|_| ApiError::bad("Invalid OTLP Protobuf"))?
        }
        _ => {
            return Err(ApiError(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "Use application/json or application/x-protobuf".into(),
            ));
        }
    };
    let mut logs = Vec::new();
    for resource in export.resource_logs {
        let resource_attributes = attributes(resource.resource.unwrap_or_default().attributes, 0)?;
        for scope in resource.scope_logs {
            for record in scope.log_records {
                if logs.len() >= MAX_BATCH {
                    return Err(ApiError::bad("Maximum 100 OTLP log records per request"));
                }
                let mut attrs = resource_attributes.clone();
                attrs.extend(attributes(record.attributes, 0)?);
                let text = |key: &str| attrs.get(key).and_then(Value::as_str).map(str::to_owned);
                let nanos = if record.time_unix_nano == 0 {
                    record.observed_time_unix_nano
                } else {
                    record.time_unix_nano
                };
                let timestamp = if nanos == 0 {
                    None
                } else {
                    Some(
                        DateTime::from_timestamp(
                            (nanos / 1_000_000_000) as i64,
                            (nanos % 1_000_000_000) as u32,
                        )
                        .ok_or_else(|| ApiError::bad("Invalid OTLP timestamp"))?,
                    )
                };
                let message = value(record.body.unwrap_or_default(), 0)?;
                let id = |bytes: Vec<u8>| {
                    if bytes.iter().any(|b| *b != 0) {
                        Some(bytes.iter().map(|b| format!("{b:02x}")).collect::<String>())
                    } else {
                        None
                    }
                };
                let level = match record.severity_number {
                    1..=4 => "trace",
                    5..=8 => "debug",
                    0 | 9..=12 => "info",
                    13..=16 => "warn",
                    17..=20 => "error",
                    21..=24 => "fatal",
                    _ => return Err(ApiError::bad("Invalid OTLP severity number")),
                };
                logs.push(Log {
                    log_id: text("log.record.uid")
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                    timestamp,
                    level: level.into(),
                    message: message
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| message.to_string()),
                    service: text("service.name").unwrap_or_else(|| "unknown_service".into()),
                    environment: text("deployment.environment.name")
                        .or_else(|| text("deployment.environment")),
                    trace_id: id(record.trace_id),
                    span_id: id(record.span_id),
                    request_id: text("request.id"),
                    attributes: attrs,
                });
            }
        }
    }
    Ok(logs)
}
pub fn response(result: ApiResult<()>, protobuf: bool) -> Response {
    let (status, body) = match result {
        Ok(()) => (
            StatusCode::OK,
            if protobuf { Vec::new() } else { b"{}".to_vec() },
        ),
        Err(error) => {
            let code = match error.0 {
                StatusCode::UNAUTHORIZED => 16,
                StatusCode::SERVICE_UNAVAILABLE => 14,
                status if status.is_server_error() => 13,
                _ => 3,
            };
            let body = if protobuf {
                Status {
                    code,
                    message: error.1,
                }
                .encode_to_vec()
            } else {
                serde_json::json!({"code":code,"message":error.1})
                    .to_string()
                    .into_bytes()
            };
            (error.0, body)
        }
    };
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    response.headers_mut().insert(
        "content-type",
        if protobuf {
            "application/x-protobuf"
        } else {
            "application/json"
        }
        .parse()
        .expect("static content type"),
    );
    if status == StatusCode::SERVICE_UNAVAILABLE {
        response
            .headers_mut()
            .insert("retry-after", "1".parse().expect("static retry delay"));
    }
    response
}
