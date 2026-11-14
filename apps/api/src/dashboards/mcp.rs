//! The MCP server: tools, resources and a prompt for building dashboards and saved views.
//!
//! Every tool calls the same functions the HTTP handlers call (`routes`, `views`, `catalog`,
//! `run`), so validation, the save bench, the write limit, conflicts and live hints behave
//! identically. A failing tool returns the HTTP error body as a tool result with `is_error`, so
//! an agent can read the JSON paths and hints and fix its document; JSON-RPC errors are only for
//! unknown tools and malformed arguments.
use super::{
    error::DashboardError,
    routes,
    run::{RunRequest, run_widget},
    spec,
    storage::Origin,
    suggest::missing_hint,
    validate::Issue,
};
use crate::{
    AppState,
    error::ApiError,
    store,
    views::{self, ViewKind},
};
use axum::http::StatusCode;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        CallToolResult, ContentBlock, GetPromptRequestParams, GetPromptResponse, GetPromptResult,
        Implementation, ListPromptsResult, ListResourcesResult, PaginatedRequestParams, Prompt,
        PromptArgument, PromptMessage, ReadResourceRequestParams, ReadResourceResponse,
        ReadResourceResult, Resource, ResourceContents, Role, ServerCapabilities, ServerConfig,
    },
    schemars::JsonSchema,
    service::RequestContext,
    tool, tool_handler, tool_router,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};
use serde::Deserialize;
use serde_json::{Value, json};

const INSTRUCTIONS: &str = "Piko builds dashboards and saved views from typed queries over a project's events and logs. Call describe_project first to see event names, properties, log services, SQL columns and limits. Preview every widget with run_widget before saving. Use formulas such as `errors / requests * 100` for ratios. SQL widgets are a single read-only SELECT over the project's own events or logs table, using only the parameters $from, $to, $bucket and $source. Stat and chart widgets compare with the previous period unless `compare` is `none`; set `better` to `down` when lower is better. Colors are yellow, violet, aqua, green, red and neutral. Every save is checked and timed; errors carry JSON paths and hints, so fix them and save again. Saved dashboards appear under Overview in Piko's sidebar, and saved views under Events or Logs.";

const SCHEMA_URI: &str = "piko://schema/dashboard.v1";
const GUIDE_URI: &str = "piko://docs/dashboards";
const GUIDE: &str = include_str!("guide.md");

/// Points kept per series by `run_widget`; a long series is trimmed to its newest points.
const MAX_POINTS: usize = 200;
/// Rows a sample tool returns at most.
const MAX_SAMPLE_ROWS: u8 = 20;
/// How far back `run_widget` and the sample tools look when no range is given.
const DEFAULT_DAYS: i64 = 7;

/// The service to mount. `writes` adds the tools that change anything.
pub fn service(
    state: AppState,
    writes: bool,
) -> StreamableHttpService<PikoMcp, LocalSessionManager> {
    StreamableHttpService::new(
        move || Ok(PikoMcp::new(state.clone(), writes)),
        Default::default(),
        StreamableHttpServerConfig::default()
            .with_legacy_session_mode(false)
            .with_json_response(true)
            // The same cap as every other API request.
            .with_max_request_body_bytes(256 * 1024)
            // The deployment edge owns host checks.
            .disable_allowed_hosts()
            // No browser may call MCP: any request that carries an Origin is refused.
            .enforce_origin_validation(),
    )
}

#[derive(Clone)]
pub struct PikoMcp {
    state: AppState,
    tool_router: ToolRouter<Self>,
}

impl PikoMcp {
    fn new(state: AppState, writes: bool) -> Self {
        let mut tool_router = Self::read_tools();
        if writes {
            tool_router.merge(Self::write_tools());
        }
        Self { state, tool_router }
    }

    /// The id of the project named by id or slug. A miss names the nearest slugs.
    async fn project(&self, key: &str) -> Result<String, DashboardError> {
        let key = key.to_string();
        self.state
            .store
            .state(move |db| match store::resolve_product(db, &key) {
                Ok(product) => Ok(Ok(product.id)),
                Err(ApiError(StatusCode::NOT_FOUND, _)) => {
                    let slugs: Vec<String> =
                        store::products(db)?.into_iter().map(|p| p.slug).collect();
                    Ok(Err(DashboardError::not_found(
                        "Project",
                        Some(missing_hint(&key, &slugs, "projects")),
                    )))
                }
                Err(e) => Err(e),
            })
            .await?
    }
}

/// A tool result: the JSON as text, or the error body (with `retry_after_secs` where HTTP would
/// send `Retry-After`) marked as an error.
fn reply(result: Result<Value, DashboardError>) -> Result<CallToolResult, ErrorData> {
    Ok(match result {
        Ok(value) => CallToolResult::success(vec![ContentBlock::text(value.to_string())]),
        Err(error) => {
            let (_, mut body, retry_after) = error.into_parts();
            if let Some(seconds) = retry_after {
                body["retry_after_secs"] = json!(seconds);
            }
            CallToolResult::error(vec![ContentBlock::text(body.to_string())])
        }
    })
}

/// A 400 about one argument, with a hint on how to fix it.
fn bad_argument(path: &str, message: String, hint: String) -> DashboardError {
    DashboardError::Detailed {
        status: StatusCode::BAD_REQUEST,
        message: "Invalid argument".into(),
        code: "invalid_argument",
        errors: vec![Issue {
            path: path.into(),
            message,
            hint: Some(hint),
        }],
    }
}

/// An RFC 3339 time, or a date meaning midnight UTC.
fn time(field: &str, text: &str) -> Result<DateTime<Utc>, DashboardError> {
    text.parse::<DateTime<Utc>>()
        .ok()
        .or_else(|| {
            NaiveDate::parse_from_str(text, "%Y-%m-%d")
                .ok()
                .and_then(|d| d.and_hms_opt(0, 0, 0))
                .map(|t| t.and_utc())
        })
        .ok_or_else(|| {
            bad_argument(
                field,
                format!("`{text}` is not a time"),
                "Use an RFC 3339 time such as 2026-11-01T00:00:00Z, or a date such as 2026-11-01"
                    .into(),
            )
        })
}

/// The range to run over: `from` and `to`, else the last seven days up to now.
fn range(
    from: Option<&str>,
    to: Option<&str>,
) -> Result<(DateTime<Utc>, DateTime<Utc>), DashboardError> {
    let to = match to {
        Some(text) => time("to", text)?,
        None => Utc::now(),
    };
    let from = match from {
        Some(text) => time("from", text)?,
        None => to - Duration::days(DEFAULT_DAYS),
    };
    Ok((from, to))
}

/// Keeps the newest `MAX_POINTS` of every series, and says so in the warnings.
fn trim_points(run: &mut Value) {
    let mut trimmed = Vec::new();
    if let Some(series) = run["series"].as_array_mut() {
        for (i, series) in series.iter_mut().enumerate() {
            let mut longest = 0;
            for key in ["points", "previous_points"] {
                if let Some(points) = series.get_mut(key).and_then(Value::as_array_mut)
                    && points.len() > MAX_POINTS
                {
                    longest = longest.max(points.len());
                    points.drain(..points.len() - MAX_POINTS);
                }
            }
            if longest > 0 {
                trimmed.push(json!({
                    "path": format!("/series/{i}/points"),
                    "message": format!("Showing the newest {MAX_POINTS} of {longest} points"),
                    "hint": "Narrow from and to, or use a coarser bucket, to see the rest",
                }));
            }
        }
    }
    if let Some(warnings) = run["warnings"].as_array_mut() {
        warnings.extend(trimmed);
    }
}

/// The saved dashboard as a tool returns it: where it is and how it fared, not its document.
fn saved_summary(saved: &Value) -> Value {
    json!({
        "id": saved["id"],
        "slug": saved["slug"],
        "revision": saved["revision"],
        "warnings": saved["warnings"],
        "bench": saved["bench"],
    })
}

/// A confirmation that does not equal the slug of what would be deleted.
fn confirm_mismatch(what: &str, slug: &str) -> DashboardError {
    DashboardError::Detailed {
        status: StatusCode::BAD_REQUEST,
        message: "Confirmation does not match".into(),
        code: "confirm_mismatch",
        errors: vec![Issue {
            path: "confirm".into(),
            message: format!("`confirm` must equal the {what}'s slug, `{slug}`"),
            hint: Some(format!(
                "Pass confirm: \"{slug}\" to delete this {what}; it cannot be undone"
            )),
        }],
    }
}

#[derive(Deserialize, JsonSchema)]
struct ProjectParams {
    /// The project's id or slug.
    project: String,
}
#[derive(Deserialize, JsonSchema)]
struct RunWidgetParams {
    /// The project's id or slug.
    project: String,
    /// One widget of the dashboard document, exactly as it would be saved.
    widget: Value,
    /// Start of the range, RFC 3339 or a date. Defaults to seven days before `to`.
    from: Option<String>,
    /// End of the range, RFC 3339 or a date. Defaults to now.
    to: Option<String>,
    /// Limits every query of the widget to one source (a source id).
    source_id: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
struct SampleEventsParams {
    /// The project's id or slug.
    project: String,
    /// Only events with this name.
    event: Option<String>,
    /// How many rows, at most 20 (the default).
    limit: Option<u8>,
}
#[derive(Deserialize, JsonSchema)]
struct SampleLogsParams {
    /// The project's id or slug.
    project: String,
    /// Only logs at exactly this level: trace, debug, info, warn, error or fatal.
    level: Option<String>,
    /// Only logs from this service.
    service: Option<String>,
    /// Only logs whose message contains this text.
    search: Option<String>,
    /// How many rows, at most 20 (the default).
    limit: Option<u8>,
}
#[derive(Deserialize, JsonSchema)]
struct DashboardParams {
    /// The project's id or slug.
    project: String,
    /// The dashboard's id or slug.
    dashboard: String,
}
#[derive(Deserialize, JsonSchema)]
struct DocumentParams {
    /// The project's id or slug.
    project: String,
    /// The `piko.dashboard/v1` document; see the piko://schema/dashboard.v1 resource.
    document: Value,
}
#[derive(Deserialize, JsonSchema)]
struct SaveDashboardParams {
    /// The project's id or slug.
    project: String,
    /// The `piko.dashboard/v1` document; see the piko://schema/dashboard.v1 resource.
    document: Value,
    /// The id or slug of the dashboard to replace. Omit it to create a new dashboard.
    dashboard: Option<String>,
    /// The revision you read before changing the dashboard. The save is refused with
    /// `revision_conflict` when the dashboard has moved on; omit it to replace whatever is
    /// current.
    base_revision: Option<i64>,
}
#[derive(Deserialize, JsonSchema)]
struct RestoreParams {
    /// The project's id or slug.
    project: String,
    /// The dashboard's id or slug.
    dashboard: String,
    /// The revision to bring back as a new revision.
    revision: i64,
}
#[derive(Deserialize, JsonSchema)]
struct DeleteDashboardParams {
    /// The project's id or slug.
    project: String,
    /// The dashboard's id or slug.
    dashboard: String,
    /// The dashboard's slug, repeated to confirm that it and its revisions may be deleted.
    confirm: String,
}
#[derive(Deserialize, JsonSchema)]
struct ListViewsParams {
    /// The project's id or slug.
    project: String,
    /// Only views of this kind.
    kind: Option<ViewKind>,
}
#[derive(Deserialize, JsonSchema)]
struct ViewParams {
    /// The project's id or slug.
    project: String,
    /// The view's id or slug.
    view: String,
    /// `events` or `logs`; needed only when both kinds have a view with this slug.
    kind: Option<ViewKind>,
}
#[derive(Deserialize, JsonSchema)]
struct SaveViewParams {
    /// The project's id or slug.
    project: String,
    /// The view document. Its `kind` (`events` by default) says which page it belongs to.
    document: Value,
    /// The id or slug of the view to replace in full. Omit it to create a new view. When both
    /// kinds have a view with this slug, the document must state its `kind`.
    view: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
struct DeleteViewParams {
    /// The project's id or slug.
    project: String,
    /// The view's id or slug.
    view: String,
    /// `events` or `logs`; needed only when both kinds have a view with this slug.
    kind: Option<ViewKind>,
    /// The view's slug, repeated to confirm that it may be deleted.
    confirm: String,
}

#[tool_router(router = read_tools)]
impl PikoMcp {
    #[tool(
        description = "Lists the projects: id, slug, name and event retention in days. Every other tool takes a project's id or slug.",
        annotations(read_only_hint = true)
    )]
    async fn list_projects(&self) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let projects = self.state.store.state(store::products).await?;
                Ok(json!(
                    projects
                        .iter()
                        .map(|p| json!({
                            "id": p.id,
                            "slug": p.slug,
                            "name": p.name,
                            "retention_days": p.retention_days,
                        }))
                        .collect::<Vec<_>>()
                ))
            }
            .await,
        )
    }

    #[tool(
        description = "Describes a project: event names and property keys, log services and levels, sources, retention, the SQL tables with their columns and parameters, and the document limits. Call this first.",
        annotations(read_only_hint = true)
    )]
    async fn describe_project(
        &self,
        Parameters(p): Parameters<ProjectParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                Ok(super::catalog::catalog(&self.state, &id).await?)
            }
            .await,
        )
    }

    #[tool(
        description = "Runs one widget definition and returns its series (or rows and columns for lists and tables), the range actually used, any warnings and elapsed_ms. Series are trimmed to their newest 200 points. Use it to preview every widget before saving.",
        annotations(read_only_hint = true)
    )]
    async fn run_widget(
        &self,
        Parameters(p): Parameters<RunWidgetParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                let (from, to) = range(p.from.as_deref(), p.to.as_deref())?;
                let request = RunRequest {
                    widget: p.widget,
                    from,
                    to,
                    bucket: None,
                    source_id: p.source_id,
                };
                let mut run = run_widget(&self.state, &id, request).await?;
                trim_points(&mut run);
                Ok(run)
            }
            .await,
        )
    }

    #[tool(
        description = "Shows up to 20 of the newest events of the last 7 days, to see real names and property shapes. These are raw events.",
        annotations(read_only_hint = true)
    )]
    async fn sample_events(
        &self,
        Parameters(p): Parameters<SampleEventsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let mut query = json!({"signal": "events"});
                if let Some(event) = p.event {
                    query["event"] = json!(event);
                }
                self.sample(&p.project, query, p.limit).await
            }
            .await,
        )
    }

    #[tool(
        description = "Shows up to 20 of the newest logs of the last 7 days, to see real services, levels and messages. These are raw logs.",
        annotations(read_only_hint = true)
    )]
    async fn sample_logs(
        &self,
        Parameters(p): Parameters<SampleLogsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let mut query = json!({"signal": "logs"});
                for (key, value) in [
                    ("level", p.level),
                    ("service", p.service),
                    ("search", p.search),
                ] {
                    if let Some(value) = value {
                        query[key] = json!(value);
                    }
                }
                self.sample(&p.project, query, p.limit).await
            }
            .await,
        )
    }

    #[tool(
        description = "Lists a project's dashboards: id, slug, name, revision and widget count.",
        annotations(read_only_hint = true)
    )]
    async fn list_dashboards(
        &self,
        Parameters(p): Parameters<ProjectParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                routes::list_dashboards(&self.state, id).await
            }
            .await,
        )
    }

    #[tool(
        description = "Returns a dashboard with its document and current revision. Read it before changing it, and pass the revision as base_revision when saving.",
        annotations(read_only_hint = true)
    )]
    async fn get_dashboard(
        &self,
        Parameters(p): Parameters<DashboardParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                routes::get_dashboard(&self.state, id, p.dashboard).await
            }
            .await,
        )
    }

    #[tool(
        description = "Lists the kept revisions of a dashboard, newest first, with who wrote each (dashboard, mcp or api).",
        annotations(read_only_hint = true)
    )]
    async fn list_revisions(
        &self,
        Parameters(p): Parameters<DashboardParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                routes::list_revisions(&self.state, id, p.dashboard).await
            }
            .await,
        )
    }

    #[tool(
        description = "Checks a dashboard document without saving it. Returns {valid, errors, warnings}; each issue has a JSON path, a message and often a hint. Unknown event names and properties only warn.",
        annotations(read_only_hint = true)
    )]
    async fn validate_dashboard(
        &self,
        Parameters(p): Parameters<DocumentParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                routes::validate_document(&self.state, &id, p.document).await
            }
            .await,
        )
    }

    #[tool(
        description = "Lists a project's saved views (named queries for the Events and Logs pages), optionally of one kind.",
        annotations(read_only_hint = true)
    )]
    async fn list_views(
        &self,
        Parameters(p): Parameters<ListViewsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                views::list_views(&self.state, id, p.kind).await
            }
            .await,
        )
    }

    #[tool(
        description = "Returns a saved view with its document. Pass kind when an events view and a logs view share the slug.",
        annotations(read_only_hint = true)
    )]
    async fn get_view(
        &self,
        Parameters(p): Parameters<ViewParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                views::get_view(&self.state, id, p.view, p.kind).await
            }
            .await,
        )
    }
}

#[tool_router(router = write_tools)]
impl PikoMcp {
    #[tool(
        description = "Saves a dashboard document. Without `dashboard` it creates one; with it, it replaces that dashboard (pass base_revision from get_dashboard to avoid overwriting someone else's change). The document is validated and every widget is timed first; errors carry JSON paths and hints. Returns {id, slug, revision, warnings, bench}.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn save_dashboard(
        &self,
        Parameters(p): Parameters<SaveDashboardParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                let saved = match p.dashboard {
                    None => {
                        if p.base_revision.is_some() {
                            return Err(bad_argument(
                                "base_revision",
                                "base_revision applies to updates".into(),
                                "Pass `dashboard` as well to update one, or drop base_revision to create".into(),
                            ));
                        }
                        routes::create_dashboard(&self.state, &id, p.document, Origin::Mcp).await?
                    }
                    Some(key) => {
                        routes::update_dashboard(
                            &self.state,
                            &id,
                            &key,
                            p.base_revision,
                            p.document,
                            Origin::Mcp,
                        )
                        .await?
                    }
                };
                Ok(saved_summary(&saved))
            }
            .await,
        )
    }

    #[tool(
        description = "Brings back an earlier revision of a dashboard as a new revision: the undo for a save. Returns {id, slug, revision, warnings, bench}.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn restore_revision(
        &self,
        Parameters(p): Parameters<RestoreParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                let saved = routes::restore_dashboard(
                    &self.state,
                    &id,
                    &p.dashboard,
                    p.revision,
                    Origin::Mcp,
                )
                .await?;
                Ok(saved_summary(&saved))
            }
            .await,
        )
    }

    #[tool(
        description = "Permanently deletes a dashboard and its revisions. `confirm` must equal the dashboard's slug.",
        annotations(read_only_hint = false, destructive_hint = true)
    )]
    async fn delete_dashboard(
        &self,
        Parameters(p): Parameters<DeleteDashboardParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                let stored = routes::get_dashboard(&self.state, id.clone(), p.dashboard).await?;
                let slug = stored["slug"].as_str().unwrap_or_default().to_string();
                if p.confirm != slug {
                    return Err(confirm_mismatch("dashboard", &slug));
                }
                let key = stored["id"].as_str().unwrap_or_default();
                routes::remove_dashboard(&self.state, &id, key).await?;
                Ok(json!({"deleted": slug}))
            }
            .await,
        )
    }

    #[tool(
        description = "Saves a view document (a named query for the Events or Logs page; its `kind` says which, events by default). Without `view` it creates one; with it, it replaces that view in full and keeps its slug. Returns the stored view.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn save_view(
        &self,
        Parameters(p): Parameters<SaveViewParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                match p.view {
                    None => views::create_view(&self.state, &id, p.document).await,
                    Some(key) => views::replace_view(&self.state, &id, &key, p.document).await,
                }
            }
            .await,
        )
    }

    #[tool(
        description = "Permanently deletes a saved view. `confirm` must equal the view's slug. Pass kind when an events view and a logs view share the slug.",
        annotations(read_only_hint = false, destructive_hint = true)
    )]
    async fn delete_view(
        &self,
        Parameters(p): Parameters<DeleteViewParams>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let id = self.project(&p.project).await?;
                let stored = views::get_view(&self.state, id.clone(), p.view, p.kind).await?;
                let slug = stored["slug"].as_str().unwrap_or_default().to_string();
                if p.confirm != slug {
                    return Err(confirm_mismatch("view", &slug));
                }
                let key = stored["id"].as_str().unwrap_or_default();
                views::delete_view(&self.state, &id, key, None).await?;
                Ok(json!({"deleted": slug}))
            }
            .await,
        )
    }
}

impl PikoMcp {
    /// The newest rows of one events or logs list over the default range, at most `limit`.
    async fn sample(
        &self,
        project: &str,
        query: Value,
        limit: Option<u8>,
    ) -> Result<Value, DashboardError> {
        let id = self.project(project).await?;
        let view = if query["signal"] == "logs" {
            "logs"
        } else {
            "events"
        };
        let (from, to) = range(None, None)?;
        let request = RunRequest {
            widget: json!({
                "id": "sample", "title": "Sample", "view": {"type": view},
                "queries": {"rows": query},
            }),
            from,
            to,
            bucket: None,
            source_id: None,
        };
        let mut run = run_widget(&self.state, &id, request).await?;
        let limit = usize::from(limit.unwrap_or(MAX_SAMPLE_ROWS).clamp(1, MAX_SAMPLE_ROWS));
        let rows: Vec<Value> = run["rows"]
            .as_array()
            .map(|rows| rows.iter().take(limit).cloned().collect())
            .unwrap_or_default();
        Ok(json!({
            "rows": rows,
            "range": run["range"].take(),
            "warnings": run["warnings"].take(),
        }))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for PikoMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .enable_prompts()
                .build(),
        )
        .with_server_info(Implementation::new("piko", env!("CARGO_PKG_VERSION")))
        .with_instructions(INSTRUCTIONS)
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        Ok(ListResourcesResult::with_all_items(vec![
            Resource::new(SCHEMA_URI, "Dashboard JSON Schema")
                .with_description("The JSON Schema of a piko.dashboard/v1 document")
                .with_mime_type("application/json"),
            Resource::new(GUIDE_URI, "Dashboards guide")
                .with_description(
                    "How to write dashboards: queries, series, formulas, views, limits and examples",
                )
                .with_mime_type("text/markdown"),
        ]))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        let (text, mime) = match request.uri.as_str() {
            SCHEMA_URI => (spec::schema().to_string(), "application/json"),
            GUIDE_URI => (GUIDE.to_string(), "text/markdown"),
            other => {
                return Err(ErrorData::resource_not_found(
                    format!("No resource {other}"),
                    None,
                ));
            }
        };
        Ok(ReadResourceResult::new(vec![
            ResourceContents::text(text, request.uri).with_mime_type(mime),
        ])
        .into())
    }

    async fn list_prompts(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListPromptsResult, ErrorData> {
        Ok(ListPromptsResult::with_all_items(vec![Prompt::new(
            "build_dashboard",
            Some("Build and save a dashboard for a goal, checking each step"),
            Some(vec![
                PromptArgument::new("goal")
                    .with_description("What the dashboard should show")
                    .with_required(true),
            ]),
        )]))
    }

    async fn get_prompt(
        &self,
        request: GetPromptRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<GetPromptResponse, ErrorData> {
        if request.name != "build_dashboard" {
            return Err(ErrorData::invalid_params(
                format!("No prompt {}", request.name),
                None,
            ));
        }
        let goal = request
            .arguments
            .as_ref()
            .and_then(|a| a.get("goal"))
            .and_then(Value::as_str)
            .ok_or_else(|| ErrorData::invalid_params("The goal argument is required", None))?;
        let text = format!(
            "Build a Piko dashboard for this goal: {goal}\n\n\
             1. Call describe_project to see the project's event names, properties, log services, \
             SQL columns and limits. Read the piko://docs/dashboards resource if you have not.\n\
             2. Draft the widgets. Call run_widget for each one and look at the series or rows; \
             use sample_events or sample_logs if a name or property is unclear. Fix anything that \
             comes back empty, with a warning or too slow.\n\
             3. Assemble the document and call validate_dashboard. Fix every error at its JSON path.\n\
             4. Call save_dashboard. If it returns errors, fix them and save again. Tell the user \
             the dashboard's slug and that it appears under Overview in Piko's sidebar."
        );
        Ok(
            GetPromptResult::new(vec![PromptMessage::new_text(Role::User, text)])
                .with_description("Build and save a dashboard")
                .into(),
        )
    }
}
