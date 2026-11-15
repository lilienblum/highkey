//! A small client for ClickHouse's HTTP interface. Values travel as bound query parameters.
use crate::config::ClickHouseConfig;
use reqwest::{Client, Url};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::time::Duration;

/// Codes that mean "try again later" rather than "this request is wrong".
const TRANSIENT_CODES: [u32; 6] = [159, 202, 209, 210, 241, 252];

#[derive(Debug, Clone)]
pub struct ChError {
    pub transient: bool,
    pub code: Option<u32>,
    pub message: String,
}

impl ChError {
    pub fn transient(message: impl Into<String>) -> Self {
        Self {
            transient: true,
            code: None,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ChError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ChError {}

#[derive(Clone)]
pub struct ClickHouse {
    client: Client,
    url: Url,
    user: String,
    password: String,
}

impl ClickHouse {
    pub fn new(config: &ClickHouseConfig) -> anyhow::Result<Self> {
        let mut url = Url::parse(&config.url)?;
        url.set_path("/");
        Ok(Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            url,
            user: config.user.clone(),
            password: config.password.clone(),
        })
    }

    async fn send(&self, url: Url, body: String) -> Result<String, ChError> {
        let response = self
            .client
            .post(url)
            .header("X-ClickHouse-User", &self.user)
            .header("X-ClickHouse-Key", &self.password)
            .body(body)
            .send()
            .await
            .map_err(|e| ChError::transient(format!("ClickHouse is unreachable: {e}")))?;
        let status = response.status();
        let header = response
            .headers()
            .get("x-clickhouse-exception-code")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u32>().ok());
        let text = response
            .text()
            .await
            .map_err(|e| ChError::transient(format!("ClickHouse response was cut off: {e}")))?;
        if status.is_success() {
            return Ok(text);
        }
        let code = header.or_else(|| {
            text.strip_prefix("Code: ")
                .and_then(|rest| rest.split('.').next())
                .and_then(|n| n.parse().ok())
        });
        let transient =
            status.is_server_error() && code.is_none_or(|code| TRANSIENT_CODES.contains(&code));
        Err(ChError {
            transient,
            code,
            message: text.trim().to_string(),
        })
    }

    /// Runs a query and returns its rows, deserialized from ClickHouse's JSON format.
    pub async fn select_json<T: DeserializeOwned>(
        &self,
        sql: &str,
        params: &[(&str, String)],
    ) -> Result<Vec<T>, ChError> {
        let mut url = self.url.clone();
        url.query_pairs_mut()
            .append_pair("default_format", "JSON")
            .append_pair("wait_end_of_query", "1");
        for (name, value) in params {
            url.query_pairs_mut()
                .append_pair(&format!("param_{name}"), value);
        }
        let text = self.send(url, sql.to_string()).await?;
        #[derive(serde::Deserialize)]
        struct Body<T> {
            data: Vec<T>,
        }
        serde_json::from_str::<Body<T>>(&text)
            .map(|body| body.data)
            .map_err(|e| ChError {
                transient: false,
                code: None,
                message: format!("Unexpected ClickHouse response: {e}"),
            })
    }

    /// Inserts rows as JSONEachRow into the named columns.
    pub async fn insert_json_each_row(
        &self,
        table: &str,
        columns: &[&str],
        rows: &[Value],
        settings: &[(&str, &str)],
    ) -> Result<(), ChError> {
        if rows.is_empty() {
            return Ok(());
        }
        let mut url = self.url.clone();
        for (name, value) in settings {
            url.query_pairs_mut().append_pair(name, value);
        }
        let mut body = format!(
            "INSERT INTO {table} ({}) FORMAT JSONEachRow\n",
            columns.join(", ")
        );
        for row in rows {
            body.push_str(&row.to_string());
            body.push('\n');
        }
        self.send(url, body).await.map(|_| ())
    }
}

/// An `Array(String)` query parameter in ClickHouse's quoted text form.
pub fn array_param(values: &[&str]) -> String {
    let quoted: Vec<String> = values
        .iter()
        .map(|value| format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'")))
        .collect();
    format!("[{}]", quoted.join(","))
}

/// A UTC time as ClickHouse's `DateTime64(3)` text form.
pub fn datetime64(time: chrono::DateTime<chrono::Utc>) -> String {
    time.format("%Y-%m-%d %H:%M:%S%.3f").to_string()
}

/// A UTC time as ClickHouse's `DateTime` text form.
pub fn datetime(time: chrono::DateTime<chrono::Utc>) -> String {
    time.format("%Y-%m-%d %H:%M:%S").to_string()
}
