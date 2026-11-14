//! Guarded, read-only DuckDB SQL for dashboard widgets.
//!
//! Every query is verified in three steps before it is saved, validated or run:
//! 1. DuckDB's own parser must report exactly one statement whose root is a SELECT;
//! 2. a walk of the serialized tree refuses table functions off an allowlist, side-effecting
//!    scalar functions, other catalogs and schemas, tables other than the database's own, and
//!    parameters other than `$from`, `$to`, `$bucket` and `$source`;
//! 3. a dry run on the project's database reads the result columns, which must fit the view.
//!
//! Queries then run inside a transaction that is always rolled back, on connections whose
//! settings are locked (see `product_db`), under the widget deadline and the dashboard gate.
use super::{
    error::DashboardError,
    metrics::{Bucket, Window},
    spec::{Document, QuerySpec, SqlDatabase, ViewKind, Widget},
    validate::{Issue, Limits, Report},
};
use crate::{
    AppState,
    error::{ApiError, ApiResult},
};
use axum::http::StatusCode;
use duckdb::{
    Connection, Statement, Transaction,
    core::{LogicalTypeHandle, LogicalTypeId},
    params_from_iter,
    types::Value as DbValue,
};
use indexmap::IndexMap;
use serde_json::{Map, Value};
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};

pub const MAX_SQL_CHARS: usize = 8_000;
pub const MAX_SQL_ROWS: usize = 10_000;
pub const MAX_TABLE_COLUMNS: usize = 50;

/// The parameters a query may use, bound by name.
pub const PARAMETERS: [&str; 4] = ["from", "to", "bucket", "source"];
/// The table functions a query may call. They generate rows from values; none reads files,
/// the network or SQL text (as `query` and `query_table` do).
pub const TABLE_FUNCTIONS: [&str; 5] = [
    "range",
    "generate_series",
    "unnest",
    "json_each",
    "json_tree",
];
/// Scalar functions refused by name: they change state, or hold a query slot doing nothing.
/// File and network scalars already fail with external access off.
pub const BLOCKED_FUNCTIONS: [&str; 5] = ["nextval", "currval", "setseed", "write_log", "sleep_ms"];
/// The warning on a result cut at `MAX_SQL_ROWS`.
pub const TRUNCATED: &str = "Showing the first 10,000 rows";

const PARAMETER_HINT: &str = "Use $from and $to (epoch milliseconds), $bucket (hour, day, week or month) or $source (a source id, or NULL for all sources)";
/// Statement keywords that read, for wording refusals of everything else.
const READS: [&str; 7] = [
    "SELECT", "WITH", "FROM", "VALUES", "TABLE", "PIVOT", "UNPIVOT",
];

/// The DuckDB parser, on a private in-memory database whose settings are locked.
pub struct Parser {
    connection: Mutex<Connection>,
}

/// What verification learned about a query.
#[derive(Debug, Default)]
pub struct Verified {
    /// The parameters the query uses.
    pub parameters: BTreeSet<String>,
}

fn issue(message: impl Into<String>, hint: impl Into<String>) -> Issue {
    Issue {
        path: String::new(),
        message: message.into(),
        hint: Some(hint.into()),
    }
}

fn unavailable() -> Issue {
    issue(
        "The query could not be verified",
        "Try again; if this persists, the API log has the reason",
    )
}

impl Parser {
    pub fn open() -> anyhow::Result<Self> {
        let db = Connection::open_in_memory()?;
        db.execute_batch(&format!(
            "SET threads=1; SET memory_limit='32MB'; {}",
            crate::product_db::LOCKED_SETTINGS
        ))?;
        Ok(Self {
            connection: Mutex::new(db),
        })
    }

    /// Steps 1 and 2. The issue's path is empty; callers set it to the query's `sql` pointer.
    pub fn verify_static(&self, sql: &str) -> Result<(), Issue> {
        self.verify(sql, None).map(|_| ())
    }

    /// Steps 1 and 2, for a query over `database` when it is known, which names the one table
    /// the query may read.
    pub fn verify(&self, sql: &str, database: Option<SqlDatabase>) -> Result<Verified, Issue> {
        let n = sql.chars().count();
        if n > MAX_SQL_CHARS {
            return Err(issue(
                format!("sql is {n} characters; the limit is {MAX_SQL_CHARS}"),
                "Shorten the query, for example by naming repeated parts in a WITH clause",
            ));
        }
        let serialized = self.serialize(sql)?;
        let nodes = scan(&serialized).ok_or_else(|| {
            tracing::error!("Could not read DuckDB's serialized statement");
            unavailable()
        })?;
        check_statement(sql, &nodes)?;
        check_tree(sql, &nodes, database)
    }

    fn serialize(&self, sql: &str) -> Result<String, Issue> {
        let db = self.connection.lock().map_err(|_| unavailable())?;
        db.query_row(
            "SELECT json_serialize_sql(?::VARCHAR)::VARCHAR",
            [sql],
            |r| r.get::<_, String>(0),
        )
        .map_err(|e| {
            tracing::error!(error = %e, "The SQL parser failed");
            unavailable()
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Positions

/// The 1-based line and column (in characters) of a byte offset into `sql`.
fn line_column(sql: &str, offset: usize) -> (usize, usize) {
    let mut end = offset.min(sql.len());
    while !sql.is_char_boundary(end) {
        end -= 1;
    }
    let before = &sql[..end];
    let line = before.matches('\n').count() + 1;
    let start = before.rfind('\n').map_or(0, |i| i + 1);
    (line, before[start..].chars().count() + 1)
}

fn at(sql: &str, offset: usize) -> String {
    let (line, column) = line_column(sql, offset);
    format!("line {line}, column {column}")
}

/// ` (line L, column C)`, or nothing without a position.
fn position(sql: &str, offset: Option<usize>) -> String {
    offset.map_or_else(String::new, |o| format!(" ({})", at(sql, o)))
}

// ---------------------------------------------------------------------------------------------
// Step 1: one SELECT

/// Each statement in `sql` as its byte offset and leading keyword, split at semicolons outside
/// strings, quoted names and comments. It only words refusals: DuckDB's parser decides.
fn statements(sql: &str) -> Vec<(usize, String)> {
    let b = sql.as_bytes();
    let mut out: Vec<(usize, String)> = Vec::new();
    let mut current: Option<(usize, String)> = None;
    let mut depth = 0i32;
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c == b'-' && b.get(i + 1) == Some(&b'-') {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if c == b'/' && b.get(i + 1) == Some(&b'*') {
            let mut nested = 0;
            while i < b.len() {
                if b[i..].starts_with(b"/*") {
                    nested += 1;
                    i += 2;
                } else if b[i..].starts_with(b"*/") {
                    nested -= 1;
                    i += 2;
                    if nested == 0 {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            continue;
        }
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if c == b';' && depth <= 0 {
            out.extend(current.take());
            depth = 0;
            i += 1;
            continue;
        }
        let start = current.get_or_insert_with(|| (i, String::new()));
        match c {
            b'\'' | b'"' => {
                i += 1;
                while i < b.len() {
                    if b[i] == c {
                        if b.get(i + 1) == Some(&c) {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i += 1;
            }
            b'(' => {
                depth += 1;
                i += 1;
            }
            b')' => {
                depth -= 1;
                i += 1;
            }
            c if c.is_ascii_alphabetic() || c == b'_' => {
                let begin = i;
                while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                    i += 1;
                }
                let word = sql[begin..i].to_ascii_uppercase();
                let keyword = &mut start.1;
                // A leading WITH reads until the statement it introduces.
                if keyword.is_empty()
                    || (keyword == "WITH"
                        && depth <= 0
                        && [
                            "SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "FROM", "VALUES",
                        ]
                        .contains(&word.as_str()))
                {
                    *keyword = word;
                }
            }
            _ => i += 1,
        }
    }
    out.extend(current);
    out
}

fn article(word: &str) -> &'static str {
    if word.starts_with(['A', 'E', 'I', 'O', 'U']) {
        "an"
    } else {
        "a"
    }
}

/// Exactly one statement, and it is a SELECT.
fn check_statement(sql: &str, nodes: &[Node]) -> Result<(), Issue> {
    let root = nodes
        .iter()
        .rev()
        .find(|n| n.depth == 0)
        .ok_or_else(unavailable)?;
    if root.get("error") == Some("true") {
        let message = root.get("error_message").unwrap_or("Invalid SQL");
        if root.get("error_type") == Some("parser") {
            let offset = root.get("position").and_then(|p| p.parse().ok());
            return Err(issue(
                format!("{message}{}", position(sql, offset)),
                match offset {
                    Some(o) => format!("Fix the SQL near {}", at(sql, o)),
                    None => "Fix the SQL syntax".into(),
                },
            ));
        }
        if message.contains("Only SELECT statements") {
            let found = statements(sql)
                .into_iter()
                .find(|(_, keyword)| !keyword.is_empty() && !READS.contains(&keyword.as_str()));
            return Err(match found {
                Some((offset, keyword)) => issue(
                    format!(
                        "Only a single SELECT is allowed, not {} {keyword} statement ({})",
                        article(&keyword),
                        at(sql, offset)
                    ),
                    format!(
                        "Dashboard SQL is read-only: remove the {keyword} and write one SELECT"
                    ),
                ),
                None => issue(
                    "Only a single SELECT is allowed",
                    "Dashboard SQL is read-only: write one SELECT",
                ),
            });
        }
        return Err(issue(
            format!("DuckDB could not verify this query: {message}"),
            "Write one SELECT over this project's data",
        ));
    }
    let count = nodes
        .iter()
        .filter(|n| n.depth == 2 && n.member == "statements")
        .count();
    match count {
        1 => Ok(()),
        0 => Err(issue(
            "The query is empty; write one SELECT",
            "For example: SELECT count(*) AS value FROM events WHERE event_time >= $from AND event_time < $to",
        )),
        n => Err(issue(
            format!("Only a single SELECT is allowed; this SQL has {n} statements"),
            match statements(sql).get(1) {
                Some((offset, _)) => format!(
                    "Keep one statement: remove the one that starts at {}",
                    at(sql, *offset)
                ),
                None => "Keep one statement".into(),
            },
        )),
    }
}

// ---------------------------------------------------------------------------------------------
// Step 2: the tree

/// One JSON object of the serialized statement: the scalar members the checks read, and where
/// it sits. The scan is iterative, so any nesting depth DuckDB accepts can be verified.
#[derive(Debug, Default)]
struct Node {
    /// The member this object (or the array holding it) is the value of.
    member: String,
    /// The root object is at depth 0.
    depth: usize,
    fields: Vec<(String, String)>,
    /// Functions directly under this object's `function` member, which table refs hold.
    table_functions: Vec<(String, Option<String>)>,
    /// For a query: the WITH tables it defines, as each definition closes.
    ctes: Vec<String>,
    /// For a table ref: it names a WITH table of an enclosing query, so it reads no table.
    with_table: bool,
}
impl Node {
    fn get(&self, key: &str) -> Option<&str> {
        self.fields
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
    fn location(&self, sql: &str) -> Option<usize> {
        location(self.get("query_location"), sql)
    }
}

fn location(raw: Option<&str>, sql: &str) -> Option<usize> {
    raw.and_then(|v| v.parse::<usize>().ok())
        .filter(|&o| o < sql.len())
}

/// The members the checks read; everything else is skipped (but still walked).
const FIELDS: [&str; 16] = [
    "class",
    "type",
    "function_name",
    "catalog",
    "catalog_name",
    "schema",
    "schema_name",
    "table_name",
    "identifier",
    "query_location",
    "key",
    "show_type",
    "error",
    "error_type",
    "error_message",
    "position",
];

enum Frame {
    Object {
        node: Node,
        /// The member name read, awaiting its value.
        key: Option<String>,
    },
    Array {
        member: String,
    },
}

/// Whether an object pushed at `stack[at]` (or about to close there) is a WITH definition: an
/// entry of the `map` array inside a `cte_map` object.
fn cte_entry(stack: &[Frame], at: usize) -> bool {
    at >= 2
        && matches!(&stack[at - 1], Frame::Array { member } if member == "map")
        && matches!(&stack[at - 2], Frame::Object { node, .. } if node.member == "cte_map")
}

/// Whether `name` is a WITH table in scope: defined by an enclosing query, or the definition
/// being read (so a recursive WITH may name itself). This relies on DuckDB writing a query's
/// `cte_map` before its body and a definition's `key` before its `value`; were that to change,
/// references would only be refused, never let through.
fn in_scope(stack: &[Frame], name: &str) -> bool {
    stack.iter().enumerate().any(|(at, frame)| {
        let Frame::Object { node, .. } = frame else {
            return false;
        };
        node.ctes.iter().any(|c| c == name)
            || (cte_entry(stack, at)
                && node
                    .get("key")
                    .is_some_and(|k| k.eq_ignore_ascii_case(name)))
    })
}

/// Every object of a JSON document, children before parents. `None` when it is not JSON.
fn scan(json: &str) -> Option<Vec<Node>> {
    let b = json.as_bytes();
    let mut stack: Vec<Frame> = Vec::new();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            c if c.is_ascii_whitespace() || c == b',' || c == b':' => i += 1,
            open @ (b'{' | b'[') => {
                let member = match stack.last_mut() {
                    Some(Frame::Object { key, .. }) => key.take()?,
                    Some(Frame::Array { member }) => member.clone(),
                    None => String::new(),
                };
                stack.push(if open == b'{' {
                    Frame::Object {
                        node: Node {
                            member,
                            depth: stack.len(),
                            ..Node::default()
                        },
                        key: None,
                    }
                } else {
                    Frame::Array { member }
                });
                i += 1;
            }
            b'}' => {
                let Some(Frame::Object { mut node, .. }) = stack.pop() else {
                    return None;
                };
                // A WITH definition is an entry of the `map` array of the `cte_map` of a query,
                // which it is in scope for from here on.
                let n = stack.len();
                if n >= 3
                    && cte_entry(&stack, n)
                    && let (Some(name), Frame::Object { node: query, .. }) =
                        (node.get("key"), &mut stack[n - 3])
                {
                    query.ctes.push(name.to_ascii_lowercase());
                }
                if node.get("type") == Some("BASE_TABLE") {
                    let name = node
                        .get("table_name")
                        .unwrap_or_default()
                        .to_ascii_lowercase();
                    node.with_table = in_scope(&stack, &name);
                }
                if node.get("class") == Some("FUNCTION")
                    && node.member == "function"
                    && let Some(Frame::Object { node: parent, .. }) = stack.last_mut()
                {
                    parent.table_functions.push((
                        node.get("function_name").unwrap_or_default().to_string(),
                        node.get("query_location").map(str::to_string),
                    ));
                }
                out.push(node);
                i += 1;
            }
            b']' => {
                let Some(Frame::Array { .. }) = stack.pop() else {
                    return None;
                };
                i += 1;
            }
            b'"' => {
                let (text, next) = string(b, i)?;
                i = next;
                if let Some(Frame::Object { node, key }) = stack.last_mut() {
                    match key.take() {
                        None => *key = Some(text),
                        Some(name) if FIELDS.contains(&name.as_str()) => {
                            node.fields.push((name, text))
                        }
                        Some(_) => {}
                    }
                }
            }
            _ => {
                let start = i;
                while i < b.len()
                    && !matches!(b[i], b',' | b'}' | b']' | b':')
                    && !b[i].is_ascii_whitespace()
                {
                    i += 1;
                }
                if start == i {
                    return None;
                }
                if let Some(Frame::Object { node, key }) = stack.last_mut() {
                    let name = key.take()?;
                    if FIELDS.contains(&name.as_str()) {
                        node.fields.push((name, json[start..i].to_string()));
                    }
                }
            }
        }
    }
    stack.is_empty().then_some(out)
}

/// A JSON string starting at `b[start]` (a quote), unescaped, and the offset after it.
fn string(b: &[u8], start: usize) -> Option<(String, usize)> {
    let hex = |at: usize| -> Option<u32> {
        let digits = std::str::from_utf8(b.get(at..at + 4)?).ok()?;
        u32::from_str_radix(digits, 16).ok()
    };
    let mut out = Vec::new();
    let mut i = start + 1;
    while i < b.len() {
        match b[i] {
            b'"' => return Some((String::from_utf8(out).ok()?, i + 1)),
            b'\\' => {
                let escaped = *b.get(i + 1)?;
                i += 2;
                let simple = match escaped {
                    b'"' => Some(b'"'),
                    b'\\' => Some(b'\\'),
                    b'/' => Some(b'/'),
                    b'b' => Some(8),
                    b'f' => Some(12),
                    b'n' => Some(b'\n'),
                    b'r' => Some(b'\r'),
                    b't' => Some(b'\t'),
                    b'u' => None,
                    _ => return None,
                };
                if let Some(byte) = simple {
                    out.push(byte);
                    continue;
                }
                let high = hex(i)?;
                i += 4;
                let code = if (0xD800..0xDC00).contains(&high) {
                    if b.get(i..i + 2) != Some(b"\\u") {
                        return None;
                    }
                    let low = hex(i + 2)?;
                    i += 6;
                    0x10000 + ((high - 0xD800) << 10) + low.checked_sub(0xDC00)?
                } else {
                    high
                };
                let mut buffer = [0; 4];
                out.extend_from_slice(char::from_u32(code)?.encode_utf8(&mut buffer).as_bytes());
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    None
}

/// The table, or tables, a query may read.
fn tables(database: Option<SqlDatabase>) -> &'static str {
    match database {
        Some(database) => database.table(),
        None => "events or logs",
    }
}

fn table_function(
    sql: &str,
    name: &str,
    offset: Option<usize>,
    database: Option<SqlDatabase>,
) -> Issue {
    let name = if name.is_empty() {
        "This table function"
    } else {
        name
    };
    issue(
        format!("{name} is not allowed{}", position(sql, offset)),
        format!(
            "{name} is not allowed: SQL may only read this project's {} table; table functions are limited to {}",
            tables(database),
            TABLE_FUNCTIONS.join(", ")
        ),
    )
}

/// Refuses whatever reaches past the project's one database, changes state, or cannot be
/// verified, and returns the parameters the query uses.
fn check_tree(sql: &str, nodes: &[Node], database: Option<SqlDatabase>) -> Result<Verified, Issue> {
    let mut verified = Verified::default();
    let mut names = Vec::new();
    for node in nodes {
        let offset = node.location(sql);
        let catalog = node
            .get("catalog")
            .or(node.get("catalog_name"))
            .unwrap_or_default();
        let schema = node
            .get("schema")
            .or(node.get("schema_name"))
            .unwrap_or_default();
        if !catalog.is_empty() || !(schema.is_empty() || schema.eq_ignore_ascii_case("main")) {
            let name = node
                .get("function_name")
                .or(node.get("table_name"))
                .unwrap_or_default();
            let reference = [catalog, schema, name]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(".");
            return Err(issue(
                format!(
                    "References to other catalogs or schemas are not allowed: {reference}{}",
                    position(sql, offset)
                ),
                format!(
                    "SQL may only read this project's {} table: name it alone, as in FROM {}",
                    tables(database),
                    database.map_or("events", SqlDatabase::table)
                ),
            ));
        }
        for (name, own) in &node.table_functions {
            if !TABLE_FUNCTIONS.contains(&name.to_ascii_lowercase().as_str()) {
                let offset = location(own.as_deref(), sql).or(offset);
                return Err(table_function(sql, name, offset, database));
            }
        }
        let class = node.get("class");
        match node.get("type") {
            Some("TABLE_FUNCTION") if node.table_functions.is_empty() => {
                return Err(table_function(sql, "", offset, database));
            }
            Some("SHOW_REF") => {
                return Err(issue(
                    format!(
                        "DESCRIBE, SHOW and SUMMARIZE are not supported{}",
                        position(sql, offset)
                    ),
                    format!(
                        "The catalog's sql section lists the columns of the {} table; select from it instead",
                        tables(database)
                    ),
                ));
            }
            Some("BASE_TABLE") if !node.with_table => {
                names.push((
                    node.get("table_name").unwrap_or_default().to_string(),
                    offset,
                ));
            }
            _ => {}
        }
        if class == Some("PARAMETER") {
            let name = node.get("identifier").unwrap_or_default();
            if name.is_empty() || name.bytes().all(|b| b.is_ascii_digit()) {
                return Err(issue(
                    format!(
                        "Positional parameters ($1, ?) are not supported{}",
                        position(sql, offset)
                    ),
                    PARAMETER_HINT,
                ));
            }
            if !PARAMETERS.contains(&name) {
                return Err(issue(
                    format!("Unknown parameter ${name}{}", position(sql, offset)),
                    PARAMETER_HINT,
                ));
            }
            verified.parameters.insert(name.to_string());
        }
        let table_function = class == Some("FUNCTION") && node.member == "function";
        if let Some(name) = node.get("function_name").filter(|_| !table_function) {
            let lower = name.to_ascii_lowercase();
            if BLOCKED_FUNCTIONS.contains(&lower.as_str()) {
                return Err(issue(
                    format!("{lower} is not allowed{}", position(sql, offset)),
                    format!("Dashboard SQL must not change anything: remove {lower}"),
                ));
            }
        }
    }
    // Tables are checked once every node is read, so a refusal above names the earlier problem.
    for (name, offset) in names {
        let lower = name.to_ascii_lowercase();
        let known = [SqlDatabase::Events, SqlDatabase::Logs]
            .iter()
            .any(|db| db.table() == lower);
        match database {
            _ if !known => {
                return Err(issue(
                    format!("Table {name} is not available{}", position(sql, offset)),
                    format!(
                        "SQL may only read this project's {} table, and tables defined with WITH",
                        tables(database)
                    ),
                ));
            }
            Some(db) if lower != db.table() => {
                return Err(issue(
                    format!(
                        "{name} is not in the {} database{}",
                        db.table(),
                        position(sql, offset)
                    ),
                    format!(
                        "A query reads one database: set \"database\": \"{lower}\" to query {lower}, or read the {} table",
                        db.table()
                    ),
                ));
            }
            _ => {}
        }
    }
    Ok(verified)
}

// ---------------------------------------------------------------------------------------------
// Step 3 and execution

/// The values a query's parameters are bound to.
#[derive(Clone, Debug)]
pub struct SqlParams {
    pub from: i64,
    pub to: i64,
    pub bucket: Bucket,
    pub source: Option<String>,
}
impl SqlParams {
    pub fn new(window: &Window, source: Option<&str>) -> Self {
        Self {
            from: window.from.timestamp_millis(),
            to: window.to.timestamp_millis(),
            bucket: window.bucket,
            source: source.map(str::to_string),
        }
    }
}

fn internal(e: duckdb::Error) -> ApiError {
    anyhow::Error::from(e).into()
}

/// A query's own error, as a 400 that callers place at its `sql` path.
fn refused(sql: &str, e: duckdb::Error) -> ApiError {
    ApiError::bad(duckdb_message(sql, &e.to_string()))
}

/// DuckDB's message on one line, ending with the line and column its caret points at.
fn duckdb_message(sql: &str, message: &str) -> String {
    let (head, context) = match message.split_once("\n\nLINE ") {
        Some((head, context)) => (head, Some(context)),
        None => (message, None),
    };
    let head = head.split_whitespace().collect::<Vec<_>>().join(" ");
    match context.and_then(|c| caret(sql, c)) {
        Some((line, column)) => format!("{head} (line {line}, column {column})"),
        None => head,
    }
}

/// Where DuckDB's caret points, from the context it renders after an error: `LINE n: text`
/// (possibly cut short with `...` at either end), then spaces and `^` under the error.
fn caret(sql: &str, context: &str) -> Option<(usize, usize)> {
    let (number, rest) = context.split_once(": ")?;
    let line: usize = number.trim().parse().ok()?;
    let mut lines = rest.split('\n');
    let shown = lines.next()?;
    let marks = lines.next()?;
    let indent = marks.chars().position(|c| c == '^')?;
    let mut offset = indent.checked_sub(format!("LINE {number}: ").chars().count())?;
    let shown = match shown.strip_prefix("...") {
        Some(rest) => {
            offset = offset.checked_sub(3)?;
            rest
        }
        None => shown,
    };
    let shown = shown.strip_suffix("...").unwrap_or(shown);
    let text = sql.split('\n').nth(line.checked_sub(1)?)?;
    let start = text.find(shown)?;
    Some((line, text[..start].chars().count() + offset + 1))
}

fn bind(statement: &Statement<'_>, params: &SqlParams) -> ApiResult<Vec<DbValue>> {
    (1..=statement.parameter_count())
        .map(|index| {
            let name = statement.parameter_name(index).map_err(internal)?;
            Ok(match name.as_str() {
                "from" => DbValue::BigInt(params.from),
                "to" => DbValue::BigInt(params.to),
                "bucket" => DbValue::Text(params.bucket.as_str().into()),
                "source" => params.source.clone().map_or(DbValue::Null, DbValue::Text),
                other => return Err(ApiError::bad(format!("Unknown parameter ${other}"))),
            })
        })
        .collect()
}

/// Interrupts the connection when dropped. A streaming result that is dropped unread otherwise
/// runs to its end first, so this is declared after the statement and drops before it.
struct Stop(Arc<duckdb::InterruptHandle>);
impl Drop for Stop {
    fn drop(&mut self) {
        self.0.interrupt();
    }
}

/// Prepares `sql` on `tx`, binds its parameters by name and starts it streaming, then lets
/// `read` take what it needs. Rows are produced only as `read` fetches them.
fn stream<T>(
    tx: &Transaction<'_>,
    sql: &str,
    params: &SqlParams,
    read: impl FnOnce(&Statement<'_>) -> ApiResult<T>,
) -> ApiResult<T> {
    let mut statement = tx.prepare(sql).map_err(|e| refused(sql, e))?;
    let _stop = Stop(tx.interrupt_handle());
    let values = bind(&statement, params)?;
    drop(
        statement
            .stream_arrow(params_from_iter(values))
            .map_err(|e| refused(sql, e))?,
    );
    read(&statement)
}

/// Runs `f` in a transaction that is rolled back whatever happens. After a failed query DuckDB
/// may have ended the transaction already, so then the query's own error is what is returned.
fn rolled_back<T>(
    db: &mut Connection,
    f: impl FnOnce(&Transaction<'_>) -> ApiResult<T>,
) -> ApiResult<T> {
    let tx = db.transaction().map_err(internal)?;
    let result = f(&tx);
    let rollback = tx.rollback();
    match (result, rollback) {
        (Ok(_), Err(e)) => Err(internal(e)),
        (result, _) => result,
    }
}

/// DuckDB's name for a type, with `JSON` for JSON columns.
fn type_name(t: &LogicalTypeHandle) -> String {
    if let Some(alias) = t.get_alias() {
        return alias;
    }
    let child = |i: usize| type_name(&t.child(i));
    let named = |kind: &str| {
        let members = (0..t.num_children())
            .map(|i| format!("{} {}", t.child_name(i), child(i)))
            .collect::<Vec<_>>()
            .join(", ");
        format!("{kind}({members})")
    };
    use LogicalTypeId as Id;
    match t.id() {
        Id::Boolean => "BOOLEAN".into(),
        Id::Tinyint => "TINYINT".into(),
        Id::Smallint => "SMALLINT".into(),
        Id::Integer => "INTEGER".into(),
        Id::Bigint => "BIGINT".into(),
        Id::Hugeint => "HUGEINT".into(),
        Id::UTinyint => "UTINYINT".into(),
        Id::USmallint => "USMALLINT".into(),
        Id::UInteger => "UINTEGER".into(),
        Id::UBigint => "UBIGINT".into(),
        Id::UHugeint => "UHUGEINT".into(),
        Id::Float => "FLOAT".into(),
        Id::Double => "DOUBLE".into(),
        Id::Decimal => format!("DECIMAL({},{})", t.decimal_width(), t.decimal_scale()),
        Id::Varchar => "VARCHAR".into(),
        Id::Blob => "BLOB".into(),
        Id::Date => "DATE".into(),
        Id::Time => "TIME".into(),
        Id::TimeNs => "TIME_NS".into(),
        Id::TimeTZ => "TIME WITH TIME ZONE".into(),
        Id::Timestamp => "TIMESTAMP".into(),
        Id::TimestampS => "TIMESTAMP_S".into(),
        Id::TimestampMs => "TIMESTAMP_MS".into(),
        Id::TimestampNs => "TIMESTAMP_NS".into(),
        Id::TimestampTZ => "TIMESTAMP WITH TIME ZONE".into(),
        Id::Interval => "INTERVAL".into(),
        Id::Uuid => "UUID".into(),
        Id::Enum => "ENUM".into(),
        Id::Bit => "BIT".into(),
        Id::Bignum => "BIGNUM".into(),
        Id::SqlNull => "NULL".into(),
        Id::List | Id::Array => format!("{}[]", child(0)),
        Id::Map => format!("MAP({}, {})", child(0), child(1)),
        Id::Struct => named("STRUCT"),
        Id::Union => named("UNION"),
        Id::Geometry => "GEOMETRY".into(),
        Id::Variant => "VARIANT".into(),
        _ => "UNKNOWN".into(),
    }
}

fn result_columns(statement: &Statement<'_>) -> Vec<(String, String)> {
    let schema = statement.schema();
    schema
        .fields()
        .iter()
        .enumerate()
        .map(|(i, field)| {
            (
                field.name().clone(),
                type_name(&statement.column_logical_type(i)),
            )
        })
        .collect()
}

/// Step 3: the result columns and their DuckDB types. The statement is started but no row is
/// fetched, and it is stopped before it can do real work.
pub fn describe(
    db: &mut Connection,
    sql: &str,
    params: &SqlParams,
) -> ApiResult<Vec<(String, String)>> {
    rolled_back(db, |tx| {
        stream(tx, sql, params, |statement| Ok(result_columns(statement)))
    })
}

fn view_name(kind: ViewKind) -> &'static str {
    match kind {
        ViewKind::Stat => "stat",
        ViewKind::Line => "line",
        ViewKind::Area => "area",
        ViewKind::Bar => "bar",
        ViewKind::Ranking => "ranking",
        ViewKind::Events => "events",
        ViewKind::Logs => "logs",
        ViewKind::Text => "text",
        ViewKind::Table => "table",
    }
}

fn numeric(kind: &str) -> bool {
    kind.starts_with("DECIMAL")
        || [
            "TINYINT",
            "SMALLINT",
            "INTEGER",
            "BIGINT",
            "HUGEINT",
            "UTINYINT",
            "USMALLINT",
            "UINTEGER",
            "UBIGINT",
            "UHUGEINT",
            "FLOAT",
            "DOUBLE",
            "NULL",
        ]
        .contains(&kind)
}

fn temporal(kind: &str) -> bool {
    kind.starts_with("TIMESTAMP")
        || kind == "DATE"
        || (numeric(kind) && !kind.starts_with("DECIMAL") && !["FLOAT", "DOUBLE"].contains(&kind))
}

/// A message when `columns` do not fit a `kind` view. Names match without regard to case.
pub fn check_shape(kind: ViewKind, columns: &[(String, String)]) -> Option<String> {
    let find = |name: &str| {
        columns
            .iter()
            .filter(|(n, _)| n.eq_ignore_ascii_case(name))
            .collect::<Vec<_>>()
    };
    let returns = || {
        if columns.is_empty() {
            return "no columns".to_string();
        }
        columns
            .iter()
            .map(|(name, kind)| format!("{name} ({kind})"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let view = view_name(kind);
    let (expected, required, optional): (&str, &[&str], &[&str]) = match kind {
        ViewKind::Stat => ("one column, value (a number)", &["value"], &[]),
        ViewKind::Line | ViewKind::Area | ViewKind::Bar => (
            "columns time and value (a number), and optionally group",
            &["time", "value"],
            &["group"],
        ),
        ViewKind::Ranking => (
            "columns label and value (a number)",
            &["label", "value"],
            &[],
        ),
        ViewKind::Table => {
            return match columns.len() {
                0 => Some("A table widget needs at least one column".into()),
                n if n > MAX_TABLE_COLUMNS => Some(format!(
                    "A table widget shows at most {MAX_TABLE_COLUMNS} columns; this query returns {n}"
                )),
                _ => None,
            };
        }
        ViewKind::Events | ViewKind::Logs | ViewKind::Text => {
            return Some(format!("A {view} widget takes no SQL query"));
        }
    };
    let present = optional.iter().filter(|name| find(name).len() == 1).count();
    let fits = required.iter().all(|name| find(name).len() == 1)
        && optional.iter().all(|name| find(name).len() <= 1)
        && columns.len() == required.len() + present;
    if !fits {
        return Some(format!(
            "A {view} widget needs {expected}; this query returns {}",
            returns()
        ));
    }
    if let Some((_, t)) = find("value").first().filter(|(_, t)| !numeric(t)) {
        return Some(format!(
            "value must be a number; this query returns value ({t})"
        ));
    }
    if let Some((_, t)) = find("time").first().filter(|(_, t)| !temporal(t)) {
        return Some(format!(
            "time must be a TIMESTAMP, a DATE or epoch milliseconds; this query returns time ({t})"
        ));
    }
    None
}

fn shape_hint(kind: ViewKind) -> &'static str {
    match kind {
        ViewKind::Stat => {
            "Return one row: SELECT count(*) AS value FROM events WHERE event_time >= $from AND event_time < $to"
        }
        ViewKind::Line | ViewKind::Area | ViewKind::Bar => {
            "Return a row per bucket: SELECT date_trunc($bucket, epoch_ms(event_time)) AS time, count(*) AS value FROM events WHERE event_time >= $from AND event_time < $to GROUP BY 1; add a group column for one series per group"
        }
        ViewKind::Ranking => {
            "Return a row per label: SELECT name AS label, count(*) AS value FROM events WHERE event_time >= $from AND event_time < $to GROUP BY 1 ORDER BY 2 DESC"
        }
        ViewKind::Table => "Select between 1 and 50 columns",
        ViewKind::Events | ViewKind::Logs | ViewKind::Text => {
            "Use a stat, line, area, bar, ranking or table view for SQL"
        }
    }
}

#[derive(Debug)]
pub struct SqlResult {
    pub columns: Vec<(String, String)>,
    pub rows: Vec<Vec<Value>>,
    pub truncated: bool,
}

fn number(value: f64) -> Value {
    serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
}

fn clock(micros: i64) -> String {
    let (sign, micros) = if micros < 0 {
        ("-", -micros)
    } else {
        ("", micros)
    };
    let seconds = micros / 1_000_000;
    let fraction = micros % 1_000_000;
    let mut text = format!(
        "{sign}{:02}:{:02}:{:02}",
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60
    );
    if fraction != 0 {
        text += &format!(".{fraction:06}");
    }
    text
}

/// An interval the way DuckDB prints one, such as `1 year 2 months 3 days 01:30:00`.
fn interval(months: i32, days: i32, nanos: i64) -> String {
    let unit = |n: i64, name: &str| match n {
        0 => None,
        1 | -1 => Some(format!("{n} {name}")),
        _ => Some(format!("{n} {name}s")),
    };
    let mut parts: Vec<String> = [
        unit(i64::from(months / 12), "year"),
        unit(i64::from(months % 12), "month"),
        unit(i64::from(days), "day"),
    ]
    .into_iter()
    .flatten()
    .collect();
    if nanos != 0 || parts.is_empty() {
        parts.push(clock(nanos / 1000));
    }
    parts.join(" ")
}

/// A DuckDB value as JSON. Times are epoch milliseconds, as everywhere else in the API.
fn json(value: DbValue) -> Value {
    match value {
        DbValue::Null => Value::Null,
        DbValue::Boolean(b) => b.into(),
        DbValue::TinyInt(i) => i.into(),
        DbValue::SmallInt(i) => i.into(),
        DbValue::Int(i) => i.into(),
        DbValue::BigInt(i) => i.into(),
        DbValue::UTinyInt(i) => i.into(),
        DbValue::USmallInt(i) => i.into(),
        DbValue::UInt(i) => i.into(),
        DbValue::UBigInt(i) => i.into(),
        DbValue::HugeInt(i) => i64::try_from(i).map_or_else(|_| number(i as f64), Value::from),
        DbValue::UHugeInt(i) => u64::try_from(i).map_or_else(|_| number(i as f64), Value::from),
        DbValue::Float(f) => number(f64::from(f)),
        DbValue::Double(f) => number(f),
        DbValue::Decimal(d) => number(d.value() as f64 / 10f64.powi(i32::from(d.scale()))),
        DbValue::Timestamp(unit, t) => unit.to_micros(t).div_euclid(1000).into(),
        DbValue::Date32(days) => (i64::from(days) * 86_400_000).into(),
        DbValue::Time64(unit, t) => clock(unit.to_micros(t)).into(),
        DbValue::Interval {
            months,
            days,
            nanos,
        } => interval(months, days, nanos).into(),
        DbValue::Text(s) | DbValue::Enum(s) => s.into(),
        DbValue::Blob(bytes) | DbValue::Geometry(bytes) => {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD
                .encode(bytes)
                .into()
        }
        DbValue::List(items) | DbValue::Array(items) => items.into_iter().map(json).collect(),
        DbValue::Struct(fields) => fields
            .iter()
            .map(|(k, v)| (k.clone(), json(v.clone())))
            .collect::<Map<_, _>>()
            .into(),
        DbValue::Map(entries) => entries
            .iter()
            .map(|(k, v)| {
                let key = match json(k.clone()) {
                    Value::String(s) => s,
                    other => other.to_string(),
                };
                (key, json(v.clone()))
            })
            .collect::<Map<_, _>>()
            .into(),
        DbValue::Union(inner) => json(*inner),
        other => format!("{other:?}").into(),
    }
}

/// One value of a row as JSON, or `None` when DuckDB's value cannot be read. NULL-typed columns
/// are always null; reading them (and a few rare nested types) panics in the driver, which is
/// caught here rather than taking down the request.
fn cell(row: &duckdb::Row<'_>, i: usize, kind: &str) -> Option<Value> {
    if kind == "NULL" {
        return Some(Value::Null);
    }
    let read = std::panic::AssertUnwindSafe(|| row.get_ref(i).map(|v| json(v.to_owned())));
    let value = std::panic::catch_unwind(read).ok()?.ok()?;
    Some(match value {
        Value::String(text) if kind == "JSON" => {
            serde_json::from_str(&text).unwrap_or(Value::String(text))
        }
        value => value,
    })
}

/// Runs a verified query and fetches at most `max_rows` rows, in a transaction that is always
/// rolled back. Rows stream from DuckDB, and fetching stops after `max_rows`.
pub fn execute(
    db: &mut Connection,
    sql: &str,
    params: &SqlParams,
    max_rows: usize,
) -> ApiResult<SqlResult> {
    rolled_back(db, |tx| {
        stream(tx, sql, params, |statement| {
            let columns = result_columns(statement);
            let mut rows = Vec::new();
            let mut truncated = false;
            let mut cursor = statement.raw_query();
            while let Some(row) = cursor.next().map_err(|e| refused(sql, e))? {
                if rows.len() == max_rows {
                    truncated = true;
                    break;
                }
                let mut values = Vec::with_capacity(columns.len());
                for (i, (name, kind)) in columns.iter().enumerate() {
                    values.push(cell(row, i, kind).ok_or_else(|| {
                        ApiError::bad(format!(
                            "Column {name} has type {kind}, which cannot be read; cast it, for example to VARCHAR"
                        ))
                    })?);
                }
                rows.push(values);
            }
            Ok(SqlResult {
                columns,
                rows,
                truncated,
            })
        })
    })
}

// ---------------------------------------------------------------------------------------------
// Widgets and documents

pub fn has_sql(widget: &Widget) -> bool {
    widget
        .queries
        .values()
        .any(|q| matches!(q, QuerySpec::Sql(_)))
}

/// What verifying a widget's SQL found: issues at each query's `sql` path, and the result
/// columns of every SQL query that passed.
#[derive(Debug, Default)]
pub struct WidgetCheck {
    pub errors: Vec<Issue>,
    pub warnings: Vec<Issue>,
    pub columns: IndexMap<String, Vec<(String, String)>>,
}
impl WidgetCheck {
    /// Whether a query returns a `group` column, which draws one series per group.
    pub fn grouped(&self, id: &str) -> bool {
        self.columns
            .get(id)
            .is_some_and(|c| c.iter().any(|(name, _)| name.eq_ignore_ascii_case("group")))
    }
}

fn time_column(database: SqlDatabase) -> &'static str {
    match database {
        SqlDatabase::Events => "event_time",
        SqlDatabase::Logs => "timestamp",
    }
}

/// All three steps for every SQL query of `widget`, on the leased connections, with issues at
/// `{base}/queries/{id}/sql`. Step 3 also checks how the queries group, across the widget.
pub fn verify_widget(
    parser: &Parser,
    widget: &Widget,
    base: &str,
    mut events: Option<&mut Connection>,
    mut logs: Option<&mut Connection>,
    params: &SqlParams,
) -> ApiResult<WidgetCheck> {
    let mut check = WidgetCheck::default();
    for (id, query) in &widget.queries {
        let QuerySpec::Sql(q) = query else {
            continue;
        };
        let path = format!("{base}/queries/{id}/sql");
        let verified = match parser.verify(&q.sql, Some(q.database)) {
            Ok(verified) => verified,
            Err(mut issue) => {
                issue.path = path;
                check.errors.push(issue);
                continue;
            }
        };
        if !verified.parameters.contains("from") && !verified.parameters.contains("to") {
            let column = time_column(q.database);
            check.warnings.push(Issue {
                path: path.clone(),
                message:
                    "This query uses neither $from nor $to, so it ignores the dashboard's range"
                        .into(),
                hint: Some(format!(
                    "Filter by time: WHERE {column} >= $from AND {column} < $to"
                )),
            });
        }
        let db = match q.database {
            SqlDatabase::Events => events.as_deref_mut(),
            SqlDatabase::Logs => logs.as_deref_mut(),
        }
        .ok_or_else(|| {
            ApiError::from(anyhow::anyhow!(
                "The widget run has no connection for a query"
            ))
        })?;
        let columns = match describe(db, &q.sql, params) {
            Ok(columns) => columns,
            Err(ApiError(StatusCode::BAD_REQUEST, message)) => {
                check.errors.push(Issue {
                    path,
                    message,
                    hint: Some(format!(
                        "Names must match the {} table's columns, listed in the catalog's sql.{}",
                        q.database.table(),
                        q.database.table()
                    )),
                });
                continue;
            }
            Err(e) => return Err(e),
        };
        if let Some(message) = check_shape(widget.view.kind, &columns) {
            check.errors.push(Issue {
                path,
                message,
                hint: Some(shape_hint(widget.view.kind).into()),
            });
            continue;
        }
        check.columns.insert(id.clone(), columns);
    }
    if check.errors.is_empty() && has_sql(widget) {
        let errors = grouping(widget, base, &check);
        check.errors.extend(errors);
    }
    Ok(check)
}

/// A time series draws one series per group when its first query is grouped, and then every
/// query must be grouped; otherwise none may be.
fn grouping(widget: &Widget, base: &str, check: &WidgetCheck) -> Vec<Issue> {
    if !matches!(
        widget.view.kind,
        ViewKind::Line | ViewKind::Area | ViewKind::Bar
    ) {
        return Vec::new();
    }
    let grouped = |id: &str, q: &QuerySpec| match q {
        QuerySpec::Sql(_) => check.grouped(id),
        QuerySpec::Events(q) => q.group_by.is_some(),
        QuerySpec::Logs(q) => q.group_by.is_some(),
    };
    let mut queries = widget.queries.iter();
    let Some((first_id, first)) = queries.next() else {
        return Vec::new();
    };
    let first_grouped = grouped(first_id, first);
    let hint = "Group every query of a time series the same way, or none of them";
    let mut errors = Vec::new();
    for (id, q) in queries {
        if grouped(id, q) == first_grouped {
            continue;
        }
        let (path, message) = match (q, first_grouped) {
            (QuerySpec::Sql(_), true) => (
                format!("{base}/queries/{id}/sql"),
                format!(
                    "`{first_id}` draws one series per group, so this query needs a group column"
                ),
            ),
            (QuerySpec::Sql(_), false) => (
                format!("{base}/queries/{id}/sql"),
                format!("`{first_id}` has no groups, so this query must not return a group column"),
            ),
            (_, true) => (
                format!("{base}/queries/{id}/group_by"),
                format!("`{first_id}` draws one series per group, so this query needs a group_by"),
            ),
            (_, false) => (
                format!("{base}/queries/{id}/group_by"),
                format!("`{first_id}` has no groups, so this query must not have a group_by"),
            ),
        };
        errors.push(Issue {
            path,
            message,
            hint: Some(hint.into()),
        });
    }
    if first_grouped && matches!(first, QuerySpec::Sql(_)) && widget.series_or_default().len() > 1 {
        errors.push(Issue {
            path: if widget.series.is_some() {
                format!("{base}/series/1")
            } else {
                format!("{base}/queries")
            },
            message: "A grouped time series allows only one series".into(),
            hint: Some("Remove the extra series, or the group column".into()),
        });
    }
    errors
}

fn in_widget(path: &str, index: usize) -> bool {
    let widget = format!("/widgets/{index}");
    path == widget || path.starts_with(&format!("{widget}/"))
}

/// All three steps for the SQL of every widget in `doc` that has no errors yet, on the
/// project's databases, adding to `report`. `product` must be an existing project's id.
pub async fn verify_document(
    state: &AppState,
    product: &str,
    doc: &Document,
    report: &mut Report,
) -> Result<(), DashboardError> {
    let widgets: Vec<(usize, Widget)> = doc
        .widgets
        .iter()
        .enumerate()
        .filter(|(i, w)| has_sql(w) && !report.errors.iter().any(|e| in_widget(&e.path, *i)))
        .map(|(i, w)| (i, w.clone()))
        .collect();
    if widgets.is_empty() {
        return Ok(());
    }
    let reads = |database: SqlDatabase| {
        widgets.iter().any(|(_, w)| {
            w.queries
                .values()
                .any(|q| matches!(q, QuerySpec::Sql(q) if q.database == database))
        })
    };
    let (events, logs) = (reads(SqlDatabase::Events), reads(SqlDatabase::Logs));
    let parser = state.sql_parser.clone();
    // The dry run binds a recent window; only the column types matter.
    let to = chrono::Utc::now();
    let params = SqlParams {
        from: (to - chrono::Duration::days(7)).timestamp_millis(),
        to: to.timestamp_millis(),
        bucket: Bucket::Day,
        source: None,
    };
    let deadline =
        tokio::time::Instant::now() + std::time::Duration::from_millis(Limits::MAX_TIMEOUT_MS);
    let checks = state
        .store
        .widget_query(
            product.to_string(),
            events,
            logs,
            deadline,
            move |mut e, mut l| {
                widgets
                    .iter()
                    .map(|(i, w)| {
                        verify_widget(
                            &parser,
                            w,
                            &format!("/widgets/{i}"),
                            e.as_deref_mut(),
                            l.as_deref_mut(),
                            &params,
                        )
                    })
                    .collect::<ApiResult<Vec<_>>>()
            },
        )
        .await?;
    for check in checks {
        report.errors.extend(check.errors);
        report.warnings.extend(check.warnings);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product_db::ProductDatabases;

    fn parser() -> Parser {
        Parser::open().unwrap()
    }
    fn refusal(sql: &str) -> Issue {
        match parser().verify_static(sql) {
            Ok(()) => panic!("accepted: {sql}"),
            Err(issue) => issue,
        }
    }
    fn text(issue: &Issue) -> String {
        format!("{} {}", issue.message, issue.hint.as_deref().unwrap_or(""))
    }
    fn params() -> SqlParams {
        SqlParams {
            from: 0,
            to: 10_000,
            bucket: Bucket::Day,
            source: None,
        }
    }
    fn names(columns: &[(String, String)]) -> Vec<&str> {
        columns.iter().map(|(name, _)| name.as_str()).collect()
    }
    fn columns(spec: &[(&str, &str)]) -> Vec<(String, String)> {
        spec.iter()
            .map(|(name, kind)| (name.to_string(), kind.to_string()))
            .collect()
    }
    /// An events database with three rows, through the production opener.
    fn events_db() -> (tempfile::TempDir, ProductDatabases, String) {
        let dir = tempfile::tempdir().unwrap();
        let dbs = ProductDatabases::new(dir.path().join("products")).unwrap();
        let id = uuid::Uuid::now_v7().to_string();
        let lease = dbs.connection(&id).unwrap();
        lease
            .connection
            .execute_batch(&format!(
                "INSERT INTO events VALUES
                    ('{id}','a','visit','web',1000,1000,NULL,NULL,NULL,'{{\"plan\":\"pro\"}}','{id}'),
                    ('{id}','b','visit','web',2000,2000,NULL,NULL,NULL,'{{}}','other'),
                    ('{id}','c','signup','web',20000,20000,NULL,NULL,NULL,'{{}}','{id}');"
            ))
            .unwrap();
        drop(lease);
        (dir, dbs, id)
    }

    #[test]
    fn refuses_every_non_select() {
        for sql in [
            "INSERT INTO events SELECT * FROM events",
            "UPDATE events SET name = 'x'",
            "DELETE FROM events",
            "CREATE TABLE t AS SELECT 1",
            "DROP TABLE events",
            "ALTER TABLE events ADD COLUMN x INTEGER",
            "ATTACH ':memory:' AS x",
            "DETACH x",
            "COPY events TO 'x.csv'",
            "EXPORT DATABASE 'dump'",
            "IMPORT DATABASE 'dump'",
            "INSTALL httpfs",
            "LOAD json",
            "SET threads=8",
            "RESET threads",
            "PRAGMA version",
            "CALL pragma_version()",
            "CHECKPOINT",
            "VACUUM",
            "USE memory",
            "PREPARE p AS SELECT 1",
            "EXECUTE p",
            "BEGIN",
            "ROLLBACK",
            "EXPLAIN SELECT 1",
            "SELECT 1; SELECT 2",
            "SELECT 1 AS value; DROP TABLE events",
            "WITH x AS (SELECT 1) INSERT INTO events SELECT * FROM x",
        ] {
            let issue = refusal(sql);
            assert!(issue.message.contains("single SELECT"), "{sql}: {issue:?}");
            assert!(issue.hint.is_some(), "{sql}");
            assert!(issue.path.is_empty(), "{sql}");
        }
        let issue = refusal("INSERT INTO events SELECT * FROM events");
        assert!(issue.hint.unwrap().contains("remove the INSERT"));
        let issue = refusal("WITH x AS (SELECT 1) DELETE FROM events");
        assert!(issue.hint.unwrap().contains("remove the DELETE"));
        let issue = refusal("SELECT 1 AS value; DROP TABLE events");
        assert!(text(&issue).contains("remove the DROP"), "{issue:?}");
        let issue = refusal("SELECT 1;\n  SELECT 2");
        assert!(issue.message.contains("2 statements"), "{issue:?}");
        assert!(issue.hint.unwrap().contains("line 2, column 3"));
        // A trailing semicolon is still one statement; an empty query is refused.
        assert!(parser().verify_static("SELECT 1 AS value;").is_ok());
        assert!(refusal("  -- nothing\n").message.contains("SELECT"));
    }

    #[test]
    fn refuses_escaping_functions() {
        for (sql, needle) in [
            ("SELECT * FROM read_csv('/etc/passwd')", "read_csv"),
            ("SELECT * FROM read_parquet('x.parquet')", "read_parquet"),
            ("SELECT * FROM glob('*')", "glob"),
            ("SELECT * FROM query('DROP TABLE events')", "query"),
            ("SELECT * FROM query_table('events')", "query_table"),
            (
                "SELECT * FROM events, LATERAL query_table(name)",
                "query_table",
            ),
            ("SELECT (SELECT count(*) FROM glob('*')) AS value", "glob"),
            ("SELECT * FROM duckdb_settings()", "duckdb_settings"),
            ("SELECT * FROM checkpoint()", "checkpoint"),
            ("SELECT nextval('s')", "nextval"),
            ("SELECT currval('s')", "currval"),
            ("SELECT setseed(0.1)", "setseed"),
            ("SELECT NEXTVAL('s')", "nextval"),
            ("SELECT system.main.nextval('s')", "nextval"),
            ("SELECT write_log('x')", "write_log"),
            ("SELECT * FROM system.main.something", "system"),
            ("SELECT * FROM memory.main.events", "memory"),
            ("SELECT * FROM other.events", "other"),
            (
                "SELECT * FROM information_schema.tables",
                "information_schema",
            ),
            ("SELECT * FROM pg_catalog.pg_type", "pg_catalog"),
            ("SELECT x.main.f(1)", "x"),
            ("SELECT * FROM 'data.csv'", "data.csv"),
            ("SELECT * FROM duckdb_databases", "duckdb_databases"),
            // A WITH name covers only its own query, not a same-named table outside it.
            (
                "SELECT * FROM (WITH duckdb_databases AS (SELECT 1) SELECT * FROM duckdb_databases) t, duckdb_databases",
                "duckdb_databases",
            ),
            (
                "WITH a AS (SELECT * FROM sqlite_master) SELECT * FROM a",
                "sqlite_master",
            ),
            (
                "WITH a AS (SELECT * FROM b), b AS (SELECT 1) SELECT * FROM a",
                "b",
            ),
            ("DESCRIBE events", "DESCRIBE"),
            ("SUMMARIZE events", "SUMMARIZE"),
            ("SHOW TABLES", "SHOW"),
        ] {
            let issue = refusal(sql);
            assert!(text(&issue).contains(needle), "{sql}: {issue:?}");
            assert!(issue.hint.is_some(), "{sql}");
        }
        let issue = refusal("SELECT count(*) AS value FROM read_csv('x')");
        assert_eq!(issue.message, "read_csv is not allowed (line 1, column 31)");
        assert!(issue.hint.unwrap().contains("events or logs table"));
        let issue = parser()
            .verify("SELECT * FROM read_csv('x')", Some(SqlDatabase::Events))
            .unwrap_err();
        assert!(
            issue.hint.unwrap().starts_with(
                "read_csv is not allowed: SQL may only read this project's events table"
            )
        );
    }

    #[test]
    fn accepts_read_only_selects() {
        let deep = format!("SELECT {} AS value", vec!["1"; 400].join(" + "));
        for sql in [
            "SELECT epoch_ms(date_trunc($bucket, epoch_ms(event_time))) AS time, count(*) AS value FROM events WHERE event_time >= $from AND event_time < $to GROUP BY 1",
            "SELECT count(*) AS value FROM main.events WHERE ($source IS NULL OR source_id = $source)",
            "FROM events SELECT name",
            "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT * FROM r",
            "WITH a AS (SELECT name FROM events), b AS (SELECT * FROM a) SELECT * FROM b",
            "SELECT * FROM range(3) r(x), generate_series(1, 2), unnest([1, 2]), json_each('[1]'), json_tree('{}')",
            "SELECT name, sum(1) OVER (PARTITION BY source ORDER BY event_time) FROM events QUALIFY row_number() OVER () = 1",
            "SELECT list_transform([1, 2], x -> x + 1), properties->>'$.plan', {'a': 1} FROM \"events\"",
            "SELECT * FROM events PIVOT (count(*) FOR name IN ('a'))",
            "SELECT 1 UNION ALL SELECT 2",
            "VALUES (1), (2)",
            "SELECT 'it''s' AS \"quoted \"\" name\", '\\u00e9t\u{e9}' AS accents",
            "SELECT name FROM events WHERE name IN (SELECT name FROM events) AND EXISTS (SELECT 1 FROM events)",
            "WITH a AS (SELECT name FROM events) SELECT * FROM (SELECT * FROM a) x, (WITH b AS (SELECT * FROM a) SELECT * FROM b) y",
            "WITH a AS (SELECT 1 AS n) SELECT * FROM a UNION ALL SELECT * FROM a",
            "SELECT properties::JSON->>'plan' AS plan, json_extract_string(properties, '$.plan'), name::VARCHAR FROM events",
            deep.as_str(),
        ] {
            if let Err(issue) = parser().verify_static(sql) {
                panic!("{sql}: {issue:?}");
            }
        }
    }

    #[test]
    fn parameters_are_named_and_known() {
        let verified = parser()
            .verify(
                "SELECT $bucket, $to FROM events WHERE event_time >= $from AND $source IS NULL AND $from > 0",
                None,
            )
            .unwrap();
        assert_eq!(
            verified
                .parameters
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["bucket", "from", "source", "to"]
        );
        let issue = refusal("SELECT 1 FROM events WHERE name = $plan");
        assert_eq!(issue.message, "Unknown parameter $plan (line 1, column 35)");
        assert!(issue.hint.unwrap().contains("$from"));
        for sql in ["SELECT ?", "SELECT $1"] {
            assert!(
                refusal(sql).message.contains("Positional parameters"),
                "{sql}"
            );
        }
    }

    #[test]
    fn errors_carry_duckdb_messages_and_positions() {
        let issue = refusal("SELECT count(*) AS value\nFROM events WHERE AND x");
        assert!(issue.message.contains("syntax error"), "{issue:?}");
        assert!(issue.message.ends_with("(line 2, column 19)"), "{issue:?}");
        assert!(issue.hint.unwrap().contains("line 2, column 19"));
        let issue = refusal("SELECT 1 FROM éé, read_csv('x')");
        assert!(issue.message.ends_with("(line 1, column 19)"), "{issue:?}");
    }

    #[test]
    fn tables_follow_the_database() {
        let p = parser();
        let logs = "SELECT count(*) AS value FROM logs";
        let events = "SELECT count(*) AS value FROM events";
        assert!(p.verify(logs, Some(SqlDatabase::Logs)).is_ok());
        assert!(p.verify(events, Some(SqlDatabase::Events)).is_ok());
        let issue = p.verify(events, Some(SqlDatabase::Logs)).unwrap_err();
        assert!(text(&issue).contains("logs database"), "{issue:?}");
        let issue = p.verify(logs, Some(SqlDatabase::Events)).unwrap_err();
        assert!(text(&issue).contains("events database"), "{issue:?}");
        // CTE names may shadow nothing else, but they are tables of their own.
        assert!(
            p.verify(
                "WITH logs AS (SELECT 1) SELECT * FROM logs",
                Some(SqlDatabase::Events)
            )
            .is_ok()
        );
    }

    #[test]
    fn settings_are_locked() {
        let dir = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::now_v7().to_string();
        for dbs in [
            ProductDatabases::new(dir.path().join("products")).unwrap(),
            ProductDatabases::for_logs(dir.path().join("logs")).unwrap(),
        ] {
            let lease = dbs.connection(&id).unwrap();
            let db = &lease.connection;
            for statement in [
                "SET enable_external_access=true",
                "SET autoload_known_extensions=true",
                "SET autoinstall_known_extensions=true",
                "SET lock_configuration=false",
                "SET threads=8",
                "SET memory_limit='4GB'",
                "RESET memory_limit",
            ] {
                let error = db.execute_batch(statement).unwrap_err().to_string();
                assert!(error.contains("locked"), "{statement}: {error}");
            }
            let setting = |name: &str| {
                db.query_row("SELECT current_setting(?)::VARCHAR", [name], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap()
            };
            assert_eq!(setting("lock_configuration"), "true");
            assert_eq!(setting("enable_external_access"), "false");
            assert_eq!(setting("autoload_known_extensions"), "false");
            assert_eq!(setting("autoinstall_known_extensions"), "false");
            // Writers still write, and checkpoints still run.
            db.execute_batch("CREATE TEMP TABLE scratch AS SELECT 1; CHECKPOINT;")
                .unwrap();
        }
        let p = parser();
        let parser_db = p.connection.lock().unwrap();
        assert!(
            parser_db
                .execute_batch("SET enable_external_access=true")
                .unwrap_err()
                .to_string()
                .contains("locked")
        );
    }

    #[test]
    fn describe_reads_columns_and_types_without_running_the_query() {
        let (_dir, dbs, id) = events_db();
        let mut lease = dbs.connection(&id).unwrap();
        let db = &mut lease.connection;
        let described = describe(
            db,
            "SELECT date_trunc($bucket, epoch_ms(event_time)) AS time, name AS \"group\", count(*) AS value
             FROM events WHERE event_time >= $from AND event_time < $to GROUP BY 1, 2",
            &params(),
        )
        .unwrap();
        assert_eq!(
            described,
            columns(&[
                ("time", "TIMESTAMP"),
                ("group", "VARCHAR"),
                ("value", "BIGINT")
            ])
        );
        // A query that would run for minutes describes at once and leaves the connection usable.
        let started = std::time::Instant::now();
        let heavy = describe(
            db,
            "SELECT count(*) AS value FROM range(10000000000) a, range(10) b",
            &params(),
        )
        .unwrap();
        assert_eq!(names(&heavy), ["value"]);
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        let error = describe(db, "SELECT nosuch FROM events", &params()).unwrap_err();
        assert_eq!(error.0, 400);
        assert!(error.1.contains("nosuch"), "{}", error.1);
        assert!(error.1.ends_with("(line 1, column 8)"), "{}", error.1);
        let count: i64 = db
            .query_row("SELECT count(*) FROM events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 3);
    }

    #[test]
    fn execute_binds_by_name_caps_rows_and_converts_values() {
        let (_dir, dbs, id) = events_db();
        let mut lease = dbs.connection(&id).unwrap();
        let db = &mut lease.connection;
        let scoped = SqlParams {
            source: Some(id.clone()),
            ..params()
        };
        let result = execute(
            db,
            "SELECT count(*) AS value, $bucket AS bucket FROM events
             WHERE event_time >= $from AND event_time < $to AND ($source IS NULL OR source_id = $source)",
            &scoped,
            MAX_SQL_ROWS,
        )
        .unwrap();
        assert_eq!(result.rows, vec![vec![Value::from(1), Value::from("day")]]);
        assert!(!result.truncated);

        let result = execute(db, "SELECT * FROM range(25) t(n)", &params(), 10).unwrap();
        assert_eq!(result.rows.len(), 10);
        assert!(result.truncated);
        assert_eq!(result.columns, columns(&[("n", "BIGINT")]));
        let result = execute(db, "SELECT * FROM range(10) t(n)", &params(), 10).unwrap();
        assert_eq!((result.rows.len(), result.truncated), (10, false));
        // Stopping early does not wait for the rest of a long query.
        let started = std::time::Instant::now();
        let result = execute(db, "SELECT * FROM range(10000000000) t(n)", &params(), 3).unwrap();
        assert!(result.truncated);
        assert!(started.elapsed() < std::time::Duration::from_secs(2));

        let result = execute(
            db,
            "SELECT properties, epoch_ms(event_time) AS at, DATE '1970-01-02' AS day, 2.50::DECIMAL(5,2) AS price,
                    [1, 2] AS list, {'a': 'b'} AS struct, NULL AS nothing, 'x'::BLOB AS raw, true AS yes,
                    'inf'::DOUBLE AS inf, 170141183460469231731687303715884105727::HUGEINT AS huge,
                    INTERVAL 90 MINUTE AS span, uuid() IS NOT NULL AS has_uuid
             FROM events WHERE event_id = 'a'",
            &params(),
            MAX_SQL_ROWS,
        )
        .unwrap();
        assert_eq!(
            result.columns,
            columns(&[
                ("properties", "JSON"),
                ("at", "TIMESTAMP"),
                ("day", "DATE"),
                ("price", "DECIMAL(5,2)"),
                ("list", "INTEGER[]"),
                ("struct", "STRUCT(a VARCHAR)"),
                ("nothing", "NULL"),
                ("raw", "BLOB"),
                ("yes", "BOOLEAN"),
                ("inf", "DOUBLE"),
                ("huge", "HUGEINT"),
                ("span", "INTERVAL"),
                ("has_uuid", "BOOLEAN"),
            ])
        );
        assert_eq!(
            Value::Array(result.rows[0].clone()),
            serde_json::json!([
                {"plan": "pro"}, 1000, 86_400_000, 2.5, [1, 2], {"a": "b"}, null, "eA==", true,
                null, 1.7014118346046923e38, "01:30:00", true
            ])
        );
        // Nothing is left open: the next transaction starts cleanly.
        db.transaction().unwrap().commit().unwrap();

        let error = execute(db, "SELECT 1 / 0 AS v, 'x'::INTEGER AS n", &params(), 10).unwrap_err();
        assert_eq!(error.0, 400);
        assert!(error.1.contains("Conversion Error"), "{}", error.1);
        // An error while rows stream is the query's own too, and the connection stays usable.
        let error = execute(
            db,
            "SELECT (name || 'x')::INTEGER AS n FROM events",
            &params(),
            10,
        )
        .unwrap_err();
        assert_eq!(error.0, 400, "{}", error.1);
        assert!(error.1.contains("Conversion Error"), "{}", error.1);
        let result = execute(db, "SELECT count(*) AS n FROM events", &params(), 10).unwrap();
        assert_eq!(result.rows, vec![vec![Value::from(3)]]);
    }

    #[test]
    fn shapes_match_views() {
        let value = columns(&[("value", "BIGINT")]);
        let series = columns(&[("time", "TIMESTAMP"), ("value", "DOUBLE")]);
        let grouped = columns(&[
            ("time", "BIGINT"),
            ("group", "VARCHAR"),
            ("value", "HUGEINT"),
        ]);
        let ranking = columns(&[("label", "VARCHAR"), ("value", "DECIMAL(18,3)")]);
        assert_eq!(check_shape(ViewKind::Stat, &value), None);
        assert_eq!(
            check_shape(ViewKind::Stat, &columns(&[("Value", "INTEGER")])),
            None
        );
        for kind in [ViewKind::Line, ViewKind::Area, ViewKind::Bar] {
            assert_eq!(check_shape(kind, &series), None);
            assert_eq!(check_shape(kind, &grouped), None);
            assert_eq!(
                check_shape(kind, &columns(&[("time", "DATE"), ("value", "INTEGER")])),
                None
            );
        }
        assert_eq!(check_shape(ViewKind::Ranking, &ranking), None);
        assert_eq!(check_shape(ViewKind::Table, &series), None);

        let message = check_shape(ViewKind::Stat, &series).unwrap();
        assert_eq!(
            message,
            "A stat widget needs one column, value (a number); this query returns time (TIMESTAMP), value (DOUBLE)"
        );
        let message = check_shape(
            ViewKind::Ranking,
            &columns(&[("name", "VARCHAR"), ("value", "BIGINT")]),
        )
        .unwrap();
        assert!(message.contains("label and value"), "{message}");
        let message = check_shape(ViewKind::Line, &value).unwrap();
        assert!(message.contains("time and value"), "{message}");
        let message = check_shape(
            ViewKind::Line,
            &columns(&[("time", "VARCHAR"), ("value", "BIGINT")]),
        )
        .unwrap();
        assert!(
            message.contains("time must be a TIMESTAMP, a DATE or epoch milliseconds"),
            "{message}"
        );
        let message = check_shape(ViewKind::Stat, &columns(&[("value", "VARCHAR")])).unwrap();
        assert!(message.contains("value must be a number"), "{message}");
        let message = check_shape(
            ViewKind::Line,
            &columns(&[("time", "BIGINT"), ("value", "BIGINT"), ("value", "BIGINT")]),
        )
        .unwrap();
        assert!(message.contains("value"), "{message}");
        let wide: Vec<(String, String)> = (0..51)
            .map(|i| (format!("c{i}"), "INTEGER".into()))
            .collect();
        let message = check_shape(ViewKind::Table, &wide).unwrap();
        assert_eq!(
            message,
            "A table widget shows at most 50 columns; this query returns 51"
        );
        assert!(check_shape(ViewKind::Table, &[]).is_some());
    }
}
