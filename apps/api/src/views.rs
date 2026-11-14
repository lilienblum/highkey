//! Saved views: a named, typed query for the Events page (`events`) or the Logs page (`logs`).
//!
//! A view is small and recreatable, so it has no revisions: a write replaces the document.
//! Slugs are unique per project and kind, and a project holds at most 100 views of both kinds.
use crate::{
    AppState,
    dashboards::{
        error::DashboardError,
        routes::{Body, body, changed, throttle},
        spec::{EventsQuery, LogFilter, LogMeasure, LogsQuery},
        suggest::missing_hint,
        validate::{Issue, Limits, Report, check_events, check_logs, parse, text_len},
    },
    error::ApiError,
    model::ViewLink,
    store,
};
use axum::{
    Json, Router,
    extract::{Path, Query, State, rejection::QueryRejection},
    http::StatusCode,
    routing::{get, post, put},
};
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

type Result<T> = std::result::Result<T, DashboardError>;

/// Views per project, across both kinds.
pub const MAX_VIEWS_PER_PROJECT: usize = 100;
/// Slugs that collide with a static route segment under `/views`.
const RESERVED_SLUGS: [&str; 1] = ["validate"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ViewKind {
    Events,
    Logs,
}
impl ViewKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Events => "events",
            Self::Logs => "logs",
        }
    }
    fn parse(value: &str) -> Option<Self> {
        match value {
            "events" => Some(Self::Events),
            "logs" => Some(Self::Logs),
            _ => None,
        }
    }
}
fn events_kind() -> ViewKind {
    ViewKind::Events
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventView {
    pub version: u32,
    #[serde(default = "events_kind")]
    pub kind: ViewKind,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub query: EventsQuery,
}

/// The dashboards `LogsQuery` filter fields; there is no measure, attribute or grouping.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LogViewQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub filters: Vec<LogFilter>,
}
impl LogViewQuery {
    /// The dashboards logs query these filters mean, which the logs rules validate.
    fn as_logs_query(&self) -> LogsQuery {
        LogsQuery {
            level: self.level.clone(),
            min_level: self.min_level.clone(),
            service: self.service.clone(),
            environment: self.environment.clone(),
            source_id: self.source_id.clone(),
            search: self.search.clone(),
            filters: self.filters.clone(),
            measure: LogMeasure::Count,
            attribute: None,
            group_by: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum LogWindow {
    #[serde(rename = "15m")]
    Minutes15,
    #[serde(rename = "1h")]
    Hour1,
    #[serde(rename = "6h")]
    Hours6,
    #[serde(rename = "24h")]
    Hours24,
    #[serde(rename = "7d")]
    Days7,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LogView {
    pub version: u32,
    pub kind: ViewKind,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub query: LogViewQuery,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<LogWindow>,
}

/// A saved view document, by `kind`. A document without `kind` is an event view.
#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum ViewDocument {
    Events(EventView),
    Logs(LogView),
}
impl ViewDocument {
    pub fn kind(&self) -> ViewKind {
        match self {
            Self::Events(_) => ViewKind::Events,
            Self::Logs(_) => ViewKind::Logs,
        }
    }
    pub fn name(&self) -> &str {
        match self {
            Self::Events(v) => &v.name,
            Self::Logs(v) => &v.name,
        }
    }
}

fn issue(path: &str, message: &str) -> Report {
    let mut report = Report::default();
    report.error(path, message);
    report
}

/// Parses a document, reporting the JSON Pointer of the first fault.
pub fn parse_view(value: Value) -> std::result::Result<ViewDocument, Report> {
    let kind = match value.get("kind") {
        None => ViewKind::Events,
        Some(kind) => kind
            .as_str()
            .and_then(ViewKind::parse)
            .ok_or_else(|| issue("/kind", "kind must be events or logs"))?,
    };
    Ok(match kind {
        ViewKind::Events => ViewDocument::Events(parse(value)?),
        ViewKind::Logs => ViewDocument::Logs(parse(value)?),
    })
}

/// Every rule a document must satisfy before it is stored.
pub fn check_view(doc: &ViewDocument) -> Report {
    let mut r = Report::default();
    let (version, name, description) = match doc {
        ViewDocument::Events(v) => (v.version, &v.name, &v.description),
        ViewDocument::Logs(v) => (v.version, &v.name, &v.description),
    };
    if version != 1 {
        r.error("/version", "version must be 1");
    }
    text_len(
        &mut r,
        "/name".into(),
        name,
        1,
        Limits::MAX_NAME_CHARS,
        "name",
    );
    if description
        .as_ref()
        .is_some_and(|d| d.chars().count() > Limits::MAX_DESCRIPTION_CHARS)
    {
        r.error(
            "/description",
            format!(
                "description must be at most {} characters",
                Limits::MAX_DESCRIPTION_CHARS
            ),
        );
    }
    match doc {
        ViewDocument::Events(v) => check_events(&v.query, "/query", &mut r),
        ViewDocument::Logs(v) => check_logs(&v.query.as_logs_query(), "/query", &mut r),
    }
    r
}

#[derive(Debug, Serialize)]
pub struct Stored {
    pub id: String,
    pub slug: String,
    pub kind: ViewKind,
    pub created_at: String,
    pub updated_at: String,
    pub document: ViewDocument,
}
#[derive(Debug, Serialize)]
pub struct Summary {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub kind: ViewKind,
    pub description: Option<String>,
    pub updated_at: String,
}

pub fn migrate(db: &rusqlite::Connection) -> anyhow::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS views(id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('events','logs')), slug TEXT NOT NULL, name TEXT NOT NULL, document TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(product_id, kind, slug));",
    )?;
    Ok(())
}

fn db_error(e: rusqlite::Error) -> DashboardError {
    ApiError::from(anyhow::Error::from(e)).into()
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
/// The JSON that is stored.
fn validated(doc: &ViewDocument) -> Result<String> {
    let report = check_view(doc);
    if !report.is_ok() {
        return Err(DashboardError::InvalidView(report));
    }
    serde_json::to_string(doc).map_err(|e| ApiError::from(anyhow::Error::from(e)).into())
}
/// A stored document, whose `kind` may be missing in rows written before it existed.
fn from_stored(text: &str) -> Result<ViewDocument> {
    let value: Value =
        serde_json::from_str(text).map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    parse_view(value).map_err(|report| {
        let message = report
            .errors
            .first()
            .map_or_else(String::new, |e| format!("{}: {}", e.path, e.message));
        ApiError::from(anyhow::anyhow!("Stored view is invalid: {message}")).into()
    })
}
fn begin(db: &rusqlite::Connection) -> Result<Transaction<'_>> {
    Transaction::new_unchecked(db, TransactionBehavior::Immediate).map_err(db_error)
}

/// A project's view by id or slug, as `(id, kind)`. An id is always exact. A slug shared by
/// both kinds needs `kind`; without it the lookup is ambiguous and says so.
fn resolve(
    db: &rusqlite::Connection,
    product: &str,
    key: &str,
    kind: Option<ViewKind>,
) -> Result<(String, ViewKind)> {
    let exact = db
        .query_row(
            "SELECT id,kind FROM views WHERE product_id=?1 AND id=?2",
            params![product, key],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    if let Some((id, found)) = exact {
        return Ok((id, ViewKind::parse(&found).unwrap_or(ViewKind::Events)));
    }
    let mut q = db
        .prepare("SELECT id,kind FROM views WHERE product_id=?1 AND slug=?2 ORDER BY kind")
        .map_err(db_error)?;
    let shared = q
        .query_map(params![product, key], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(db_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_error)?
        .into_iter()
        .map(|(id, k)| (id, ViewKind::parse(&k).unwrap_or(ViewKind::Events)))
        .collect::<Vec<_>>();
    match (kind, shared.as_slice()) {
        (Some(kind), shared) => {
            if let Some((id, _)) = shared.iter().find(|(_, k)| *k == kind) {
                return Ok((id.clone(), kind));
            }
            match shared.first() {
                Some((_, other)) => Err(DashboardError::not_found(
                    "View",
                    Some(format!(
                        "`{key}` exists as a {} view; use kind `{}`",
                        other.as_str(),
                        other.as_str()
                    )),
                )),
                None => Err(unknown(db, product, key, Some(kind))?),
            }
        }
        (None, [(id, kind)]) => Ok((id.clone(), *kind)),
        (None, []) => Err(unknown(db, product, key, None)?),
        (None, _) => Err(DashboardError::Detailed {
            status: StatusCode::CONFLICT,
            message: "More than one view has that slug".into(),
            code: "ambiguous_view",
            errors: vec![Issue {
                path: "view".into(),
                message: format!("`{key}` is both an events view and a logs view"),
                hint: Some("Pass ?kind=events or ?kind=logs (the `kind` argument over MCP)".into()),
            }],
        }),
    }
}
/// The not-found error for a view that exists under no kind, with the nearest slugs.
fn unknown(
    db: &rusqlite::Connection,
    product: &str,
    key: &str,
    kind: Option<ViewKind>,
) -> Result<DashboardError> {
    let slugs = summaries(db, product, kind)?
        .into_iter()
        .map(|v| v.slug)
        .collect::<Vec<_>>();
    Ok(DashboardError::not_found(
        "View",
        Some(missing_hint(key, &slugs, "views")),
    ))
}
fn load(db: &rusqlite::Connection, id: &str) -> Result<Stored> {
    let (id, slug, kind, created_at, updated_at, document): (
        String,
        String,
        String,
        String,
        String,
        String,
    ) = db
        .query_row(
            "SELECT id,slug,kind,created_at,updated_at,document FROM views WHERE id=?",
            [id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .map_err(db_error)?;
    Ok(Stored {
        id,
        slug,
        kind: ViewKind::parse(&kind).unwrap_or(ViewKind::Events),
        created_at,
        updated_at,
        document: from_stored(&document)?,
    })
}

/// A project's views by name, optionally of one kind.
pub fn summaries(
    db: &rusqlite::Connection,
    product: &str,
    kind: Option<ViewKind>,
) -> Result<Vec<Summary>> {
    store::product(db, product)?;
    let mut q = db
        .prepare(
            "SELECT id,slug,name,kind,updated_at,document FROM views WHERE product_id=?1 AND (?2 IS NULL OR kind=?2) ORDER BY name,id",
        )
        .map_err(db_error)?;
    let rows = q
        .query_map(params![product, kind.map(ViewKind::as_str)], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })
        .map_err(db_error)?;
    let mut out = Vec::new();
    for row in rows {
        let (id, slug, name, kind, updated_at, document) = row.map_err(db_error)?;
        let document: Value =
            serde_json::from_str(&document).map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
        out.push(Summary {
            id,
            slug,
            name,
            kind: ViewKind::parse(&kind).unwrap_or(ViewKind::Events),
            description: document["description"].as_str().map(String::from),
            updated_at,
        });
    }
    Ok(out)
}
pub fn fetch(
    db: &rusqlite::Connection,
    product: &str,
    key: &str,
    kind: Option<ViewKind>,
) -> Result<Stored> {
    store::product(db, product)?;
    let (id, _) = resolve(db, product, key, kind)?;
    load(db, &id)
}

/// A slug for a view name, by the project rule. Only a name that rule empties becomes `view`.
fn view_slug(name: &str) -> String {
    if name.chars().any(|c| c.is_ascii_alphanumeric()) {
        store::project_slug(name)
    } else {
        "view".into()
    }
}

pub fn create(db: &rusqlite::Connection, product: &str, doc: &ViewDocument) -> Result<Stored> {
    let json = validated(doc)?;
    store::product(db, product)?;
    let tx = begin(db)?;
    let count: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM views WHERE product_id=?",
            [product],
            |r| r.get(0),
        )
        .map_err(db_error)?;
    if count as usize >= MAX_VIEWS_PER_PROJECT {
        return Err(DashboardError::Limit(format!(
            "A project holds at most {MAX_VIEWS_PER_PROJECT} views"
        )));
    }
    let id = uuid::Uuid::now_v7().to_string();
    let at = now();
    let base = view_slug(doc.name());
    let mut slug = base.clone();
    let mut suffix = 2;
    loop {
        // The unique index arbitrates the slug per kind; the immediate transaction already
        // serializes writers. A reserved slug counts as taken.
        let inserted = if RESERVED_SLUGS.contains(&slug.as_str()) {
            0
        } else {
            tx.execute(
                "INSERT INTO views(id,product_id,kind,slug,name,document,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?7) ON CONFLICT(product_id,kind,slug) DO NOTHING",
                params![id, product, doc.kind().as_str(), slug, doc.name(), json, at],
            )
            .map_err(db_error)?
        };
        if inserted == 1 {
            break;
        }
        slug = format!("{base}-{suffix}");
        suffix += 1;
    }
    tx.commit().map_err(db_error)?;
    load(db, &id)
}

/// Replaces the whole document of a view. A view keeps its kind and its slug. `kind_written`
/// says whether the document named its kind: a slug shared by both kinds is only unambiguous
/// when it did, and a document that did not is an events view.
pub fn replace(
    db: &rusqlite::Connection,
    product: &str,
    key: &str,
    doc: &ViewDocument,
    kind_written: bool,
) -> Result<Stored> {
    let json = validated(doc)?;
    store::product(db, product)?;
    let tx = begin(db)?;
    let (id, kind) = resolve(&tx, product, key, kind_written.then(|| doc.kind())).map_err(|e| {
        // A replace takes its kind from the document, not from `?kind=`.
        match e {
            DashboardError::Detailed {
                status,
                message,
                code: "ambiguous_view",
                mut errors,
            } => {
                for issue in &mut errors {
                    issue.hint = Some(
                        "Write \"kind\": \"events\" or \"kind\": \"logs\" in the document".into(),
                    );
                }
                DashboardError::Detailed {
                    status,
                    message,
                    code: "ambiguous_view",
                    errors,
                }
            }
            e => e,
        }
    })?;
    if kind != doc.kind() {
        return Err(if id == key {
            DashboardError::InvalidView(issue(
                "/kind",
                &format!("This is a {} view; its kind cannot change", kind.as_str()),
            ))
        } else {
            DashboardError::not_found(
                "View",
                Some(format!(
                    "`{key}` exists as a {} view; write `\"kind\": \"{}\"` in the document",
                    kind.as_str(),
                    kind.as_str()
                )),
            )
        });
    }
    tx.execute(
        "UPDATE views SET name=?1,document=?2,updated_at=?3 WHERE id=?4",
        params![doc.name(), json, now(), id],
    )
    .map_err(db_error)?;
    tx.commit().map_err(db_error)?;
    load(db, &id)
}

pub fn delete(
    db: &rusqlite::Connection,
    product: &str,
    key: &str,
    kind: Option<ViewKind>,
) -> Result<()> {
    store::product(db, product)?;
    let tx = begin(db)?;
    let (id, _) = resolve(&tx, product, key, kind)?;
    tx.execute("DELETE FROM views WHERE id=?", [&id])
        .map_err(db_error)?;
    tx.commit().map_err(db_error)?;
    Ok(())
}

/// The sidebar links of a project's views, by name.
pub fn links(db: &rusqlite::Connection, product: &str) -> crate::error::ApiResult<Vec<ViewLink>> {
    let mut q = db
        .prepare("SELECT id,slug,name,kind FROM views WHERE product_id=? ORDER BY name,id")
        .map_err(anyhow::Error::from)?;
    let links = q
        .query_map([product], |r| {
            Ok(ViewLink {
                id: r.get(0)?,
                slug: r.get(1)?,
                name: r.get(2)?,
                kind: r.get(3)?,
            })
        })
        .map_err(anyhow::Error::from)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(anyhow::Error::from)?;
    Ok(links)
}

// ---- routes ----

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Write {
    document: Value,
}
#[derive(Deserialize)]
struct KindParam {
    kind: Option<String>,
}
fn kind_param(
    query: std::result::Result<Query<KindParam>, QueryRejection>,
) -> Result<Option<ViewKind>> {
    let Query(KindParam { kind }) = query.map_err(|e| ApiError(e.status(), e.body_text()))?;
    kind.map(|k| {
        ViewKind::parse(&k).ok_or_else(|| DashboardError::Detailed {
            status: StatusCode::BAD_REQUEST,
            message: "kind must be events or logs".into(),
            code: "invalid_kind",
            errors: vec![Issue {
                path: "kind".into(),
                message: format!("`{k}` is not a view kind"),
                hint: Some("Use `events` or `logs`".into()),
            }],
        })
    })
    .transpose()
}
fn document(value: Value) -> Result<ViewDocument> {
    parse_view(value).map_err(DashboardError::InvalidView)
}

pub fn read_routes() -> Router<AppState> {
    Router::new()
        .route("/products/{project}/views", get(list_handler))
        .route("/products/{project}/views/{key}", get(show))
}
pub fn write_routes() -> Router<AppState> {
    Router::new()
        .route("/api/products/{id}/views", post(create_handler))
        .route(
            "/api/products/{id}/views/{key}",
            put(replace_handler).delete(remove),
        )
}

/// A project's views (by id or slug), optionally of one kind.
pub(crate) async fn list_views(
    state: &AppState,
    project: String,
    kind: Option<ViewKind>,
) -> Result<Value> {
    let views = state
        .store
        .state(move |db| {
            let id = store::resolve_product(db, &project)?.id;
            Ok(summaries(db, &id, kind))
        })
        .await??;
    Ok(json!(views))
}
/// One view of a project (by id or slug), by id or slug.
pub(crate) async fn get_view(
    state: &AppState,
    project: String,
    key: String,
    kind: Option<ViewKind>,
) -> Result<Value> {
    let stored = state
        .store
        .state(move |db| {
            let id = store::resolve_product(db, &project)?.id;
            Ok(fetch(db, &id, &key, kind))
        })
        .await??;
    Ok(json!(stored))
}
/// Creates a view in project `product` (an id).
pub(crate) async fn create_view(state: &AppState, product: &str, document: Value) -> Result<Value> {
    throttle(state, product)?;
    let doc = self::document(document)?;
    let id = product.to_string();
    let stored = state
        .store
        .state(move |db| Ok(create(db, &id, &doc)))
        .await??;
    changed(state, product);
    Ok(json!(stored))
}
/// Replaces the view `key` of project `product` (an id) with `document`.
pub(crate) async fn replace_view(
    state: &AppState,
    product: &str,
    key: &str,
    document: Value,
) -> Result<Value> {
    throttle(state, product)?;
    let kind_written = document.get("kind").is_some();
    let doc = self::document(document)?;
    let (id, key) = (product.to_string(), key.to_string());
    let stored = state
        .store
        .state(move |db| Ok(replace(db, &id, &key, &doc, kind_written)))
        .await??;
    changed(state, product);
    Ok(json!(stored))
}
/// Deletes the view `key` of project `product` (an id).
pub(crate) async fn delete_view(
    state: &AppState,
    product: &str,
    key: &str,
    kind: Option<ViewKind>,
) -> Result<()> {
    throttle(state, product)?;
    let (id, key) = (product.to_string(), key.to_string());
    state
        .store
        .state(move |db| Ok(delete(db, &id, &key, kind)))
        .await??;
    changed(state, product);
    Ok(())
}

async fn list_handler(
    State(state): State<AppState>,
    Path(project): Path<String>,
    query: std::result::Result<Query<KindParam>, QueryRejection>,
) -> Result<Json<Value>> {
    Ok(Json(list_views(&state, project, kind_param(query)?).await?))
}
async fn show(
    State(state): State<AppState>,
    Path((project, key)): Path<(String, String)>,
    query: std::result::Result<Query<KindParam>, QueryRejection>,
) -> Result<Json<Value>> {
    let kind = kind_param(query)?;
    Ok(Json(get_view(&state, project, key, kind).await?))
}
async fn create_handler(
    State(state): State<AppState>,
    Path(product): Path<String>,
    request: Body<Write>,
) -> Result<Json<Value>> {
    Ok(Json(
        create_view(&state, &product, body(request)?.document).await?,
    ))
}
async fn replace_handler(
    State(state): State<AppState>,
    Path((product, key)): Path<(String, String)>,
    request: Body<Write>,
) -> Result<Json<Value>> {
    Ok(Json(
        replace_view(&state, &product, &key, body(request)?.document).await?,
    ))
}
async fn remove(
    State(state): State<AppState>,
    Path((product, key)): Path<(String, String)>,
    query: std::result::Result<Query<KindParam>, QueryRejection>,
) -> Result<StatusCode> {
    let kind = kind_param(query)?;
    delete_view(&state, &product, &key, kind).await?;
    Ok(StatusCode::NO_CONTENT)
}
