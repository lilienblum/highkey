//! Changes to projects, sources and ingestion keys, shared by the HTTP handlers and the MCP
//! tools. Every change tells open dashboards through the dashboards live signal, so a sidebar
//! showing the project refreshes without a reload.
use crate::{
    AppState,
    changes::Signal,
    error::{ApiError, ApiResult},
    model::{Product, ProductInput, Source, SourceInput},
    sources, store, website,
};
use serde_json::Value;

fn changed(state: &AppState, product: &str) {
    state.store.changes.changed(product, Signal::Dashboards);
}

async fn with_favicon(state: &AppState, product: Product) -> Product {
    let Some(website) = product
        .website_url
        .clone()
        .filter(|_| product.favicon_version.is_none())
    else {
        return product;
    };
    let Ok(_permit) = state.favicon_slots.try_acquire() else {
        return product;
    };
    let Some(bytes) = website::fetch_icon(&website).await else {
        return product;
    };
    let id = product.id.clone();
    // A concurrent website edit must never receive the old site's icon.
    state
        .store
        .state(move |db| store::cache_favicon(db, &id, &website, &bytes))
        .await
        .unwrap_or(product)
}

pub async fn create_project(state: &AppState, input: ProductInput) -> ApiResult<Product> {
    let product = state
        .store
        .state(move |db| store::save_product(db, None, input))
        .await?;
    changed(state, &product.id);
    Ok(with_favicon(state, product).await)
}
pub async fn update_project(
    state: &AppState,
    id: String,
    input: ProductInput,
) -> ApiResult<Product> {
    let product = state
        .store
        .state(move |db| store::save_product(db, Some(id), input))
        .await?;
    changed(state, &product.id);
    Ok(with_favicon(state, product).await)
}

pub async fn create_source(
    state: &AppState,
    project: String,
    input: SourceInput,
) -> ApiResult<Source> {
    let id = project.clone();
    let source = state
        .store
        .state(move |db| sources::save(db, &id, None, input))
        .await?;
    changed(state, &project);
    Ok(source)
}
pub async fn update_source(
    state: &AppState,
    project: String,
    source: String,
    input: SourceInput,
) -> ApiResult<Source> {
    let id = project.clone();
    let source = state
        .store
        .state(move |db| sources::save(db, &id, Some(source), input))
        .await?;
    changed(state, &project);
    Ok(source)
}

pub async fn create_key(
    state: &AppState,
    project: String,
    label: String,
    source_id: Option<String>,
    allowed_origins: Vec<String>,
) -> ApiResult<Value> {
    let id = project.clone();
    let key = state
        .store
        .state(move |db| store::create_key(db, &id, &label, source_id.as_deref(), &allowed_origins))
        .await?;
    changed(state, &project);
    Ok(key)
}

/// Creates a source and an ingestion key bound to it, or neither. Returns the source and the
/// key as `create_key` does.
pub async fn connect_source(
    state: &AppState,
    project: String,
    input: SourceInput,
    label: Option<String>,
    allowed_origins: Vec<String>,
) -> ApiResult<(Source, Value)> {
    let id = project.clone();
    let result = state
        .store
        .state(move |db| {
            input.validate()?;
            let label = label.unwrap_or_else(|| input.name.trim().to_string());
            if label.trim().is_empty() || label.len() > 80 {
                return Err(ApiError::bad("Key label must be 1–80 bytes"));
            }
            crate::origins::normalize(&allowed_origins)?;
            let tx = db.unchecked_transaction().map_err(anyhow::Error::from)?;
            let source = sources::save(db, &id, None, input)?;
            let key = store::create_key(db, &id, &label, Some(&source.id), &allowed_origins)?;
            tx.commit().map_err(anyhow::Error::from)?;
            Ok((source, key))
        })
        .await?;
    changed(state, &project);
    Ok(result)
}

pub async fn update_key_origins(
    state: &AppState,
    project: String,
    key: String,
    allowed_origins: Vec<String>,
) -> ApiResult<Vec<String>> {
    let id = project.clone();
    let allowed = state
        .store
        .state(move |db| store::update_key_origins(db, &id, &key, &allowed_origins))
        .await?;
    changed(state, &project);
    Ok(allowed)
}
pub async fn revoke_key(state: &AppState, project: String, key: String) -> ApiResult<()> {
    let id = project.clone();
    state
        .store
        .state(move |db| store::revoke_key(db, &id, &key))
        .await?;
    changed(state, &project);
    Ok(())
}

/// Setup snippets for one ingestion key, with `PIKO_URL` standing for the Piko origin and
/// `secret` for the key. They mirror the `snippet` block in
/// `apps/dashboard/src/components/settings.tsx` and `docs/collection.md`; change them together.
/// `integration` is one of `browser`, `typescript`, `http` and `rust`; `None` returns all four.
pub fn snippets(integration: Option<&str>, secret: &str) -> Option<Vec<(&'static str, String)>> {
    const URL: &str = "PIKO_URL";
    let all: [(&'static str, String); 4] = [
        (
            "browser",
            format!(
                "<script type=\"module\" referrerpolicy=\"no-referrer\">\n  import {{ startBrowserTracker }} from \"{URL}/tracker.js\";\n\n  const tracker = startBrowserTracker({{\n    endpoint: \"{URL}\",\n    key: \"{secret}\",\n    identity: \"none\",\n  }});\n\n  tracker.track(\"signup\", {{ plan: \"pro\", trial: true, seats: 3 }});\n</script>"
            ),
        ),
        (
            "typescript",
            format!(
                "import {{ Piko }} from \"./sdk/typescript/client\";\n\nconst piko = new Piko({{\n  endpoint: \"{URL}\",\n  key: \"{secret}\",\n  timeoutMs: 800,\n}});\n\nawait piko.send({{\n  name: \"build_complete\", source: \"server\",\n  properties: {{ duration_ms: 142, success: true, version: \"1.2.0\" }},\n}});"
            ),
        ),
        (
            "http",
            format!(
                "POST {URL}/api/ingest\nAuthorization: Bearer {secret}\nContent-Type: application/json\n\n{{\n  \"event_id\": \"GENERATE_A_UUID_ONCE\",\n  \"name\": \"screen_view\",\n  \"source\": \"mobile\",\n  \"timestamp\": \"UTC_ISO_TIMESTAMP\",\n  \"properties\": {{\n    \"screen\": \"home\",\n    \"version\": \"1.0.0\",\n    \"subscribed\": false\n  }}\n}}"
            ),
        ),
        (
            "rust",
            format!(
                "PIKO_TELEMETRY=1 \\\nPIKO_ENDPOINT=\"{URL}\" \\\nPIKO_INGESTION_KEY=\"{secret}\" \\\ncargo run -p piko --example cli -- build\n\n# Explicit telemetry opt-in; no installation ID is sent.\n# DO_NOT_TRACK=1 disables collection.\n# Delivery has an 800 ms timeout and 900 ms shutdown deadline."
            ),
        ),
    ];
    match integration {
        None => Some(all.into()),
        Some(name) => {
            let picked: Vec<_> = all.into_iter().filter(|(n, _)| *n == name).collect();
            (!picked.is_empty()).then_some(picked)
        }
    }
}
