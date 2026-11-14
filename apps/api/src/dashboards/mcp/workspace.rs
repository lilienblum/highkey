//! The workspace tools: projects, sources, ingestion keys, log keys and log settings. Like the
//! dashboard tools they call the functions the HTTP handlers call (`crate::workspace`, `store`,
//! `sources`, `logs::keys`); this file only handles arguments and turns `ApiError`s into tool
//! errors that name the argument at fault.
use super::{PikoMcp, bad_argument, confirm_mismatch, reply};
use crate::{
    dashboards::{error::DashboardError, suggest::missing_hint, validate::Issue},
    error::ApiError,
    logs::keys as log_keys,
    model::{ProductInput, SOURCE_ICONS, SourceInput},
    sources, store, workspace,
};
use axum::http::StatusCode;
use rmcp::{
    ErrorData, handler::server::wrapper::Parameters, model::CallToolResult, schemars::JsonSchema,
    tool, tool_router,
};
use serde::Deserialize;
use serde_json::{Value, json};

const URL_NOTE: &str = "Replace PIKO_URL with the origin of the Piko URL this MCP server is reached at. The secret is shown only once.";
const LOGS_NOTE: &str = "For logs, call create_log_key.";
const INTEGRATIONS: [&str; 4] = ["browser", "typescript", "http", "rust"];

/// The tool error for an `ApiError`: `{error, code, errors}`, with the argument at fault in
/// `errors` when the message names one.
fn tool_error(error: ApiError) -> DashboardError {
    let ApiError(status, message) = error;
    let code = match status {
        StatusCode::BAD_REQUEST => "invalid_input",
        StatusCode::NOT_FOUND => "not_found",
        StatusCode::CONFLICT => "conflict",
        StatusCode::TOO_MANY_REQUESTS => "rate_limited",
        StatusCode::SERVICE_UNAVAILABLE => "busy",
        _ => "internal",
    };
    let errors = field_hint(&message)
        .map(|(path, hint)| {
            vec![Issue {
                path: path.into(),
                message: message.clone(),
                hint: Some(hint),
            }]
        })
        .unwrap_or_default();
    DashboardError::Detailed {
        status,
        message,
        code,
        errors,
    }
}

/// The argument a validation message is about, and how to fix it.
fn field_hint(message: &str) -> Option<(&'static str, String)> {
    let found: (&'static str, String) = if message.contains("source icon") {
        (
            "/icon",
            format!(
                "Use one of: {}. Omit icon to pick one automatically",
                SOURCE_ICONS.join(", ")
            ),
        )
    } else if message.contains("source name") {
        ("/name", "Use 1–80 bytes".into())
    } else if message.contains("source with that name") {
        (
            "/name",
            "Names are unique per project, ignoring case; pick another or call list_sources".into(),
        )
    } else if message.contains("project name") {
        ("/name", "Use 1–80 bytes".into())
    } else if message.contains("retention_days") {
        (
            "/retention_days",
            "Use a whole number of days from 1 to 3650".into(),
        )
    } else if message.contains("Log retention") {
        (
            "/retention_days",
            "Use a whole number of days from 1 to 365".into(),
        )
    } else if message.contains("label") {
        ("/label", "Use 1–80 bytes".into())
    } else if message.contains("origin") {
        (
            "/allowed_origins",
            "Use at most 16 origins such as https://example.com or https://*.example.com, each without a path, query or credentials".into(),
        )
    } else if message.contains("website") {
        (
            "/website_url",
            "Use an HTTP(S) address such as https://example.com; pass \"\" to clear it".into(),
        )
    } else {
        return None;
    };
    Some(found)
}

/// Like `tool_error`, but a 404 is a `not_found` for `what` with a hint.
fn tool_error_or_missing(error: ApiError, what: &str, hint: &str) -> DashboardError {
    if error.0 == StatusCode::NOT_FOUND {
        DashboardError::not_found(what, Some(hint.into()))
    } else {
        tool_error(error)
    }
}

impl PikoMcp {
    /// The id of the source of project `project` named by id or slug. A miss names the nearest
    /// slugs.
    async fn source(&self, project: &str, key: &str) -> Result<String, DashboardError> {
        let (project, key) = (project.to_string(), key.to_string());
        self.state
            .store
            .state(move |db| match sources::resolve(db, &project, &key) {
                Ok(source) => Ok(Ok(source.id)),
                Err(ApiError(StatusCode::NOT_FOUND, _)) => {
                    let slugs: Vec<String> = sources::list(db, &project)?
                        .into_iter()
                        .map(|s| s.slug)
                        .collect();
                    Ok(Err(DashboardError::not_found(
                        "Source",
                        Some(missing_hint(&key, &slugs, "sources")),
                    )))
                }
                Err(e) => Err(e),
            })
            .await?
    }
}

fn source_input(name: String, icon: Option<String>) -> SourceInput {
    SourceInput { name, icon }
}

#[derive(Deserialize, JsonSchema)]
struct ProjectOnly {
    /// The project's id or slug.
    project: String,
}
#[derive(Deserialize, JsonSchema)]
struct CreateProjectParams {
    /// The project's name, 1–80 bytes.
    name: String,
    /// The project's website, such as https://example.com. Piko fetches its icon.
    website_url: Option<String>,
    /// How many days events are kept, 1–3650. Defaults to 365.
    retention_days: Option<i64>,
}
#[derive(Deserialize, JsonSchema)]
struct UpdateProjectParams {
    /// The project's id or slug.
    project: String,
    /// A new name, 1–80 bytes.
    name: Option<String>,
    /// A new website; `""` removes it.
    website_url: Option<String>,
    /// A new event retention, 1–3650 days.
    retention_days: Option<i64>,
}
#[derive(Deserialize, JsonSchema)]
struct CreateSourceParams {
    /// The project's id or slug.
    project: String,
    /// The source's name, 1–80 bytes, unique in the project.
    name: String,
    /// One of website, ios, android, mobile, terminal, desktop, server, code, package, game or
    /// generic. Omit it to pick one automatically.
    icon: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
struct UpdateSourceParams {
    /// The project's id or slug.
    project: String,
    /// The source's id or slug.
    source: String,
    /// A new name. The slug stays the same.
    name: Option<String>,
    /// A new icon. Omit it to keep the current one.
    icon: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
struct ConnectSourceParams {
    /// The project's id or slug.
    project: String,
    /// The new source's name.
    name: String,
    /// The source's icon, as for create_source.
    icon: Option<String>,
    /// The key's label. Defaults to the source name.
    label: Option<String>,
    /// Origins the key accepts events from, such as https://example.com or
    /// https://*.example.com. Empty accepts any origin.
    allowed_origins: Option<Vec<String>>,
    /// `browser`, `typescript`, `http` or `rust`. Omit it for all four snippets.
    integration: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
struct CreateKeyParams {
    /// The project's id or slug.
    project: String,
    /// The key's label, 1–80 bytes.
    label: String,
    /// The source the key sends to (id or slug). Defaults to the project's initial source.
    source: Option<String>,
    /// Origins the key accepts events from. Empty accepts any origin.
    allowed_origins: Option<Vec<String>>,
}
#[derive(Deserialize, JsonSchema)]
struct UpdateKeyOriginsParams {
    /// The project's id or slug.
    project: String,
    /// The ingestion key's id, from list_keys.
    key: String,
    /// The complete new list of allowed origins; empty accepts any origin.
    allowed_origins: Vec<String>,
}
#[derive(Deserialize, JsonSchema)]
struct RevokeKeyParams {
    /// The project's id or slug.
    project: String,
    /// The key's id, from list_keys or list_log_keys.
    key: String,
    /// The key's id again, to confirm that it stops working for good.
    confirm: String,
}
#[derive(Deserialize, JsonSchema)]
struct CreateLogKeyParams {
    /// The project's id or slug.
    project: String,
    /// The key's label, 1–80 bytes.
    label: String,
    /// The source the key writes logs for (id or slug). Defaults to the initial source.
    source: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
struct UpdateLogSettingsParams {
    /// The project's id or slug.
    project: String,
    /// How many days logs are kept, 1–365. Omit it to leave the settings as they are.
    retention_days: Option<i64>,
}

#[tool_router(router = workspace_read_tools, vis = "pub(super)")]
impl PikoMcp {
    #[tool(
        description = "Lists a project's sources: id, slug, name and icon.",
        annotations(read_only_hint = true)
    )]
    async fn list_sources(
        &self,
        Parameters(p): Parameters<ProjectOnly>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                let sources = self
                    .state
                    .store
                    .state(move |db| sources::list(db, &id))
                    .await?;
                Ok(json!(sources))
            }
            .await,
        )
    }

    #[tool(
        description = "Reads a project's log settings: {retention_days}. Logs are kept 7 days unless changed.",
        annotations(read_only_hint = true)
    )]
    async fn get_log_settings(
        &self,
        Parameters(p): Parameters<ProjectOnly>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                Ok(self
                    .state
                    .store
                    .state(move |db| log_keys::settings(db, &id))
                    .await?)
            }
            .await,
        )
    }
}

#[tool_router(router = workspace_write_tools, vis = "pub(super)")]
impl PikoMcp {
    #[tool(
        description = "Creates a project with its initial `events` source. retention_days defaults to 365. Returns the project.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn create_project(
        &self,
        Parameters(p): Parameters<CreateProjectParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let input = ProductInput {
                    name: p.name,
                    website_url: p.website_url,
                    retention_days: p.retention_days.unwrap_or(365),
                };
                let product = workspace::create_project(&self.state, input)
                    .await
                    .map_err(tool_error)?;
                Ok(json!(product))
            }
            .await,
        )
    }

    #[tool(
        description = "Changes a project's name, website or event retention. Only the given fields change; website_url \"\" removes the website. Returns the project.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true
        )
    )]
    async fn update_project(
        &self,
        Parameters(p): Parameters<UpdateProjectParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                let lookup = id.clone();
                let current = self
                    .state
                    .store
                    .state(move |db| store::product(db, &lookup))
                    .await?;
                let input = ProductInput {
                    name: p.name.unwrap_or(current.name),
                    // No website argument keeps the current one (the store treats None so).
                    website_url: p.website_url,
                    retention_days: p.retention_days.unwrap_or(current.retention_days),
                };
                let product = workspace::update_project(&self.state, id, input)
                    .await
                    .map_err(tool_error)?;
                Ok(json!(product))
            }
            .await,
        )
    }

    #[tool(
        description = "Adds a source (a place events come from, such as a website or an app) to a project. icon is one of website, ios, android, mobile, terminal, desktop, server, code, package, game, generic. Returns the source.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn create_source(
        &self,
        Parameters(p): Parameters<CreateSourceParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                let source =
                    workspace::create_source(&self.state, id, source_input(p.name, p.icon))
                        .await
                        .map_err(tool_error)?;
                Ok(json!(source))
            }
            .await,
        )
    }

    #[tool(
        description = "Renames a source or changes its icon; only the given fields change and the slug stays. Returns the source.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true
        )
    )]
    async fn update_source(
        &self,
        Parameters(p): Parameters<UpdateSourceParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                let source_id = self.source(&id, &p.source).await?;
                let (project, source) = (id.clone(), source_id.clone());
                let current = self
                    .state
                    .store
                    .state(move |db| sources::get(db, &project, &source))
                    .await?;
                let input = source_input(p.name.unwrap_or(current.name), p.icon.or(current.icon));
                let source = workspace::update_source(&self.state, id, source_id, input)
                    .await
                    .map_err(tool_error)?;
                Ok(json!(source))
            }
            .await,
        )
    }

    #[tool(
        description = "Connects a new source in one step: creates the source and an ingestion key bound to it, and returns {source, key: {id, prefix, secret}, setup} where setup holds ready-to-paste snippets (integration: browser, typescript, http or rust; omit for all four). The secret is shown only once.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn connect_source(
        &self,
        Parameters(p): Parameters<ConnectSourceParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                if let Some(name) = p.integration.as_deref()
                    && !INTEGRATIONS.contains(&name)
                {
                    return Err(bad_argument(
                        "/integration",
                        format!("`{name}` is not an integration"),
                        format!(
                            "Use one of: {}, or omit it for all",
                            INTEGRATIONS.join(", ")
                        ),
                    ));
                }
                let id = self.project(&p.project).await?;
                let (source, key) = workspace::connect_source(
                    &self.state,
                    id,
                    source_input(p.name, p.icon),
                    p.label,
                    p.allowed_origins.unwrap_or_default(),
                )
                .await
                .map_err(tool_error)?;
                let secret = key["key"].as_str().unwrap_or_default().to_string();
                let snippets = workspace::snippets(p.integration.as_deref(), &secret)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(name, text)| (name.to_string(), Value::String(text)))
                    .collect::<serde_json::Map<_, _>>();
                Ok(json!({
                    "source": source,
                    "key": {
                        "id": key["id"],
                        "prefix": secret.chars().take(11).collect::<String>(),
                        "secret": secret,
                        "allowed_origins": key["allowed_origins"],
                    },
                    "setup": {
                        "instructions": URL_NOTE,
                        "snippets": snippets,
                        "logs": LOGS_NOTE,
                    },
                }))
            }
            .await,
        )
    }

    #[tool(
        description = "Lists a project's ingestion keys: id, label, prefix, source_id, allowed_origins, revoked. Secrets are never shown again.",
        annotations(read_only_hint = true)
    )]
    async fn list_keys(
        &self,
        Parameters(p): Parameters<ProjectOnly>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                let keys = self
                    .state
                    .store
                    .state(move |db| store::keys(db, &id))
                    .await?;
                Ok(json!(keys))
            }
            .await,
        )
    }

    #[tool(
        description = "Creates an ingestion key for a source (default: the initial source) and returns {id, key, source_id, allowed_origins}. The key is shown only once. For a new source, connect_source does both steps.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn create_key(
        &self,
        Parameters(p): Parameters<CreateKeyParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                let source = match p.source {
                    Some(key) => Some(self.source(&id, &key).await?),
                    None => None,
                };
                let key = workspace::create_key(
                    &self.state,
                    id,
                    p.label,
                    source,
                    p.allowed_origins.unwrap_or_default(),
                )
                .await
                .map_err(tool_error)?;
                Ok(key)
            }
            .await,
        )
    }

    #[tool(
        description = "Replaces the origins an ingestion key accepts events from; an empty list accepts any origin. Returns {id, allowed_origins} as normalized.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true
        )
    )]
    async fn update_key_origins(
        &self,
        Parameters(p): Parameters<UpdateKeyOriginsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                let allowed = workspace::update_key_origins(
                    &self.state,
                    id,
                    p.key.clone(),
                    p.allowed_origins,
                )
                .await
                .map_err(|e| {
                    tool_error_or_missing(e, "Key", "Call list_keys for the ids of the active keys")
                })?;
                Ok(json!({"id": p.key, "allowed_origins": allowed}))
            }
            .await,
        )
    }

    #[tool(
        description = "Revokes an ingestion key for good: events sent with it are rejected from now on. `confirm` must equal the key id. Returns {id, revoked}.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = true
        )
    )]
    async fn revoke_key(
        &self,
        Parameters(p): Parameters<RevokeKeyParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                if p.confirm != p.key {
                    return Err(confirm_mismatch("revoke", "key", "id", &p.key));
                }
                workspace::revoke_key(&self.state, id, p.key.clone())
                    .await
                    .map_err(|e| {
                        tool_error_or_missing(e, "Key", "Call list_keys for the key ids")
                    })?;
                Ok(json!({"id": p.key, "revoked": true}))
            }
            .await,
        )
    }

    #[tool(
        description = "Lists a project's log keys: id, source_id, label, prefix, revoked.",
        annotations(read_only_hint = true)
    )]
    async fn list_log_keys(
        &self,
        Parameters(p): Parameters<ProjectOnly>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                let keys = self
                    .state
                    .store
                    .state(move |db| log_keys::list(db, &id))
                    .await?;
                Ok(json!(keys))
            }
            .await,
        )
    }

    #[tool(
        description = "Creates a log key (a `pl_` key for /api/logs/ingest) and returns {id, key, source_id}. The key is shown only once.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn create_log_key(
        &self,
        Parameters(p): Parameters<CreateLogKeyParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                let source_id = match p.source {
                    Some(key) => Some(self.source(&id, &key).await?),
                    None => None,
                };
                let input = log_keys::KeyInput {
                    label: p.label,
                    source_id,
                };
                let key = self
                    .state
                    .store
                    .state(move |db| log_keys::create(db, &id, input))
                    .await
                    .map_err(tool_error)?;
                Ok(key)
            }
            .await,
        )
    }

    #[tool(
        description = "Revokes a log key for good. `confirm` must equal the key id. Returns {id, revoked}.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = true
        )
    )]
    async fn revoke_log_key(
        &self,
        Parameters(p): Parameters<RevokeKeyParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                if p.confirm != p.key {
                    return Err(confirm_mismatch("revoke", "log key", "id", &p.key));
                }
                let key = p.key.clone();
                self.state
                    .store
                    .state(move |db| log_keys::revoke(db, &id, &key))
                    .await
                    .map_err(|e| {
                        tool_error_or_missing(e, "Key", "Call list_log_keys for the key ids")
                    })?;
                Ok(json!({"id": p.key, "revoked": true}))
            }
            .await,
        )
    }

    #[tool(
        description = "Changes a project's log settings. Only the given fields change (today: retention_days, 1–365). Returns the settings.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true
        )
    )]
    async fn update_log_settings(
        &self,
        Parameters(p): Parameters<UpdateLogSettingsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                let settings = self
                    .state
                    .store
                    .state(move |db| match p.retention_days {
                        Some(days) => log_keys::set_retention(db, &id, days),
                        None => log_keys::settings(db, &id),
                    })
                    .await
                    .map_err(tool_error)?;
                Ok(settings)
            }
            .await,
        )
    }
}
