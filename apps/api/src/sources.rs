use crate::{
    error::{ApiError, ApiResult},
    model::{Product, Source, SourceInput},
};
use rusqlite::{OptionalExtension, params};

pub fn migrate(db: &mut rusqlite::Connection) -> anyhow::Result<()> {
    let version: i64 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    anyhow::ensure!(
        version <= 7,
        "Catalog schema is newer than this API supports"
    );
    if version == 7 {
        return Ok(());
    }
    let tx = db.transaction()?;
    if version < 3 {
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS sources(
        id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
        name TEXT NOT NULL COLLATE NOCASE, kind TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(product_id,name));",
        )?;
        let has_source = tx
            .prepare("PRAGMA table_info(ingestion_keys)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|name| name == "source_id");
        if !has_source {
            tx.execute_batch(
                "ALTER TABLE ingestion_keys ADD COLUMN source_id TEXT REFERENCES sources(id);",
            )?;
        }
        // The project ID is the stable initial source ID, including for historical event rows.
        tx.execute_batch("INSERT OR IGNORE INTO sources(id,product_id,name,kind,created_at)
        SELECT id,id,CASE kind WHEN 'website' THEN 'Website' WHEN 'tool' THEN 'CLI' WHEN 'mobile' THEN 'Mobile app' ELSE 'Events' END,kind,created_at FROM products;
        UPDATE ingestion_keys SET source_id=product_id WHERE source_id IS NULL;
        ALTER TABLE sources ADD COLUMN icon TEXT;
        ALTER TABLE sources DROP COLUMN kind;
        ALTER TABLE products DROP COLUMN kind;
        PRAGMA user_version=3;")?;
    }
    if version < 4 {
        tx.execute_batch(
            "ALTER TABLE ingestion_keys ADD COLUMN allowed_origins TEXT NOT NULL DEFAULT '[]';",
        )?;
    }
    if version < 5 {
        tx.execute_batch("ALTER TABLE products ADD COLUMN website_url TEXT; ALTER TABLE products ADD COLUMN favicon BLOB; ALTER TABLE products ADD COLUMN favicon_version TEXT;")?;
    }
    if version < 6 {
        tx.execute_batch("ALTER TABLE products ADD COLUMN slug TEXT NOT NULL DEFAULT '';")?;
        let projects = tx
            .prepare("SELECT id,name FROM products ORDER BY created_at,id")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, name) in projects {
            let base = crate::store::project_slug(&name);
            let mut slug = base.clone();
            let mut suffix = 2;
            while tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM products WHERE slug=?)",
                [&slug],
                |r| r.get::<_, bool>(0),
            )? {
                slug = format!("{base}-{suffix}");
                suffix += 1;
            }
            tx.execute("UPDATE products SET slug=? WHERE id=?", params![slug, id])?;
        }
        tx.execute_batch(
            "CREATE UNIQUE INDEX products_slug ON products(slug); PRAGMA user_version=6;",
        )?;
    }
    tx.execute_batch("ALTER TABLE sources ADD COLUMN slug TEXT NOT NULL DEFAULT '';")?;
    let sources = tx
        .prepare("SELECT id,product_id,name FROM sources ORDER BY created_at,id")?
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, product_id, name) in sources {
        let base = source_slug(&name);
        let mut slug = base.clone();
        let mut suffix = 2;
        while slug == ALL_SOURCES
            || tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM sources WHERE product_id=? AND slug=?)",
                [&product_id, &slug],
                |r| r.get::<_, bool>(0),
            )?
        {
            slug = suffixed(&base, suffix);
            suffix += 1;
        }
        tx.execute("UPDATE sources SET slug=? WHERE id=?", params![slug, id])?;
    }
    tx.execute_batch(
        "CREATE UNIQUE INDEX sources_slug ON sources(product_id,slug); PRAGMA user_version=7;",
    )?;
    tx.commit()?;
    Ok(())
}
/// Workspace URLs use `?source=all` for the combined view, so no source may take this slug.
const ALL_SOURCES: &str = "all";
/// Source slugs follow project slug rules with their own fallback.
fn source_slug(name: &str) -> String {
    if name.chars().any(|c| c.is_ascii_alphanumeric()) {
        crate::store::project_slug(name)
    } else {
        "source".into()
    }
}
/// Suffixed source slugs stay within the 64 characters workspace URLs accept.
fn suffixed(base: &str, suffix: u32) -> String {
    let suffix = format!("-{suffix}");
    let base = &base[..base.len().min(64 - suffix.len())];
    format!("{}{suffix}", base.trim_end_matches('-'))
}
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Source> {
    Ok(Source {
        id: r.get(0)?,
        product_id: r.get(1)?,
        name: r.get(2)?,
        icon: r.get(3)?,
        created_at: r.get(4)?,
        slug: r.get(5)?,
    })
}
pub fn list(db: &rusqlite::Connection, product_id: &str) -> ApiResult<Vec<Source>> {
    db.prepare("SELECT id,product_id,name,icon,created_at,slug FROM sources WHERE product_id=? ORDER BY created_at,id")
        .map_err(anyhow::Error::from)?.query_map([product_id], row).map_err(anyhow::Error::from)?
        .collect::<rusqlite::Result<_>>().map_err(|e| anyhow::Error::from(e).into())
}
pub fn get(db: &rusqlite::Connection, product_id: &str, id: &str) -> ApiResult<Source> {
    db.query_row(
        "SELECT id,product_id,name,icon,created_at,slug FROM sources WHERE product_id=? AND id=?",
        [product_id, id],
        row,
    )
    .optional()
    .map_err(anyhow::Error::from)?
    .ok_or_else(ApiError::missing)
}
/// A source of the project by id, or else by slug.
pub fn resolve(db: &rusqlite::Connection, product_id: &str, key: &str) -> ApiResult<Source> {
    db.query_row(
        "SELECT id,product_id,name,icon,created_at,slug FROM sources WHERE product_id=?1 AND (id=?2 OR slug=?2) ORDER BY id=?2 DESC",
        [product_id, key],
        row,
    )
    .optional()
    .map_err(anyhow::Error::from)?
    .ok_or_else(ApiError::missing)
}
pub fn key_source<'a>(product: &'a Product, id: Option<&str>) -> ApiResult<&'a Source> {
    if let Some(id) = id {
        return product
            .sources
            .iter()
            .find(|source| source.id == id)
            .ok_or_else(ApiError::missing);
    }
    // Preserve the historical initial source for existing clients; new projects use their first named source.
    product
        .sources
        .iter()
        .find(|source| source.id == product.id)
        .or_else(|| product.sources.first())
        .ok_or_else(|| ApiError::bad("Create a source before creating a key"))
}
pub fn save(
    db: &rusqlite::Connection,
    product_id: &str,
    id: Option<String>,
    input: SourceInput,
) -> ApiResult<Source> {
    input.validate()?;
    crate::store::product(db, product_id)?;
    let name = input.name.trim();
    if let Some(id) = id {
        get(db, product_id, &id)?;
        // Renames keep the slug so workspace links stay valid.
        db.execute(
            "UPDATE sources SET name=?3,icon=?4 WHERE product_id=?1 AND id=?2",
            params![product_id, id, name, input.icon],
        )
        .map_err(duplicate_name)?;
        return get(db, product_id, &id);
    }
    let id = uuid::Uuid::now_v7().to_string();
    let base = source_slug(name);
    let mut slug = base.clone();
    let mut suffix = 2;
    loop {
        if slug != ALL_SOURCES {
            // The unique index arbitrates concurrent creators, as for project slugs.
            let inserted = db.execute("INSERT INTO sources(id,product_id,name,icon,created_at,slug) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(product_id,slug) DO NOTHING", params![id,product_id,name,input.icon,chrono::Utc::now().to_rfc3339(),slug]).map_err(duplicate_name)?;
            if inserted == 1 {
                break;
            }
        }
        slug = suffixed(&base, suffix);
        suffix += 1;
    }
    get(db, product_id, &id)
}
fn duplicate_name(error: rusqlite::Error) -> ApiError {
    match &error {
        rusqlite::Error::SqliteFailure(code, _)
            if code.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
        {
            ApiError::bad("A source with that name already exists in this project")
        }
        _ => ApiError::from(anyhow::Error::from(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user_version(db: &rusqlite::Connection) -> i64 {
        db.query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap()
    }
    fn slugs(db: &rusqlite::Connection, product_id: &str) -> Vec<(String, String)> {
        list(db, product_id)
            .unwrap()
            .into_iter()
            .map(|source| (source.id, source.slug))
            .collect()
    }

    #[test]
    fn typed_catalog_migration_preserves_sources_keys_and_pinned_icons_on_restart() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;
          CREATE TABLE products(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,retention_days INTEGER NOT NULL,created_at TEXT NOT NULL);
          CREATE TABLE sources(id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id),name TEXT NOT NULL COLLATE NOCASE,kind TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(product_id,name));
          CREATE TABLE ingestion_keys(id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id),source_id TEXT REFERENCES sources(id),label TEXT NOT NULL,prefix TEXT NOT NULL,hash TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,revoked INTEGER NOT NULL);
          INSERT INTO products VALUES ('project','Orbit','website',90,'2026-01-01');
          INSERT INTO sources VALUES ('project','project','Website','website','2026-01-01'),('mobile','project','iOS app','mobile','2026-01-02');
          PRAGMA user_version=2;").unwrap();
        db.execute("INSERT INTO ingestion_keys VALUES ('key','project','mobile','Release','pk_existing',?,'2026-01-02',0)", [crate::store::hash("pk_existing")]).unwrap();
        migrate(&mut db).unwrap();
        // `Store::open` creates this table next; `store::product` reads them.
        crate::dashboards::storage::migrate(&db).unwrap();
        crate::views::migrate(&db).unwrap();
        assert_eq!(user_version(&db), 7);
        let sources = list(&db, "project").unwrap();
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].slug, "website");
        assert_eq!(sources[1].id, "mobile");
        assert_eq!(sources[1].name, "iOS app");
        assert_eq!(sources[1].slug, "ios-app");
        assert_eq!(sources[1].icon, None);
        assert_eq!(
            crate::store::resolve_key(&db, "pk_existing", None)
                .unwrap()
                .1,
            "mobile"
        );
        for table in ["products", "sources"] {
            let columns = db
                .prepare(&format!("PRAGMA table_info({table})"))
                .unwrap()
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            assert!(!columns.iter().any(|name| name == "kind"));
        }
        save(
            &db,
            "project",
            Some("mobile".into()),
            SourceInput {
                name: "Android app".into(),
                icon: Some("ios".into()),
            },
        )
        .unwrap();
        migrate(&mut db).unwrap();
        assert_eq!(
            get(&db, "project", "mobile").unwrap().icon.as_deref(),
            Some("ios")
        );
        assert_eq!(
            crate::store::resolve_key(&db, "pk_existing", None)
                .unwrap()
                .1,
            "mobile"
        );
        save(
            &db,
            "project",
            Some("mobile".into()),
            SourceInput {
                name: "Android app".into(),
                icon: None,
            },
        )
        .unwrap();
        assert_eq!(get(&db, "project", "mobile").unwrap().icon, None);
        assert_eq!(get(&db, "project", "mobile").unwrap().slug, "ios-app");
        assert_eq!(
            db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            0
        );
    }

    #[test]
    fn migration_backfills_unique_source_slugs() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;
          CREATE TABLE products(id TEXT PRIMARY KEY,name TEXT NOT NULL,retention_days INTEGER NOT NULL,created_at TEXT NOT NULL,website_url TEXT,favicon BLOB,favicon_version TEXT,slug TEXT NOT NULL DEFAULT '');
          CREATE UNIQUE INDEX products_slug ON products(slug);
          CREATE TABLE sources(id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id),name TEXT NOT NULL COLLATE NOCASE,created_at TEXT NOT NULL,icon TEXT,UNIQUE(product_id,name));
          INSERT INTO products(id,name,retention_days,created_at,slug) VALUES ('orbit','Orbit',90,'2026-01-01','orbit'),('atlas','Atlas',90,'2026-01-02','atlas');
          INSERT INTO sources(id,product_id,name,created_at) VALUES ('b','orbit','web-app','2026-01-02'),('a','orbit','Web App','2026-01-01'),('c','orbit','東京','2026-01-03'),('d','atlas','Web App','2026-01-01'),('e','atlas','All','2026-01-02');
          PRAGMA user_version=6;").unwrap();
        migrate(&mut db).unwrap();
        migrate(&mut db).unwrap();
        assert_eq!(user_version(&db), 7);
        // Older sources keep the plain slug; later ones take the next free suffix.
        assert_eq!(
            slugs(&db, "orbit"),
            [
                ("a".into(), "web-app".into()),
                ("b".into(), "web-app-2".into()),
                ("c".into(), "source".into())
            ]
        );
        // `all` names the combined view in workspace URLs, so a source never takes it.
        assert_eq!(
            slugs(&db, "atlas"),
            [("d".into(), "web-app".into()), ("e".into(), "all-2".into())]
        );
        assert!(
            db.execute("UPDATE sources SET slug='web-app' WHERE id='b'", [])
                .is_err()
        );
    }
    #[test]
    fn new_sources_get_unique_slugs_and_renames_keep_them() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path(), 2).unwrap();
        let db = store.sqlite().unwrap();
        let product = |name: &str| {
            crate::store::save_product(
                &db,
                None,
                crate::model::ProductInput {
                    name: name.into(),
                    website_url: None,
                    retention_days: 365,
                },
            )
            .unwrap()
        };
        let source = |product_id: &str, id: Option<&str>, name: &str| {
            save(
                &db,
                product_id,
                id.map(str::to_owned),
                SourceInput {
                    name: name.into(),
                    icon: None,
                },
            )
        };
        let orbit = product("Orbit");
        assert_eq!(orbit.sources[0].slug, "events");
        let web = source(&orbit.id, None, "Web App").unwrap();
        assert_eq!(web.slug, "web-app");
        assert_eq!(
            source(&orbit.id, None, "web-app").unwrap().slug,
            "web-app-2"
        );
        assert_eq!(source(&orbit.id, None, "東京").unwrap().slug, "source");
        assert_eq!(
            source(&orbit.id, None, "WEB APP").unwrap_err().0,
            axum::http::StatusCode::BAD_REQUEST
        );
        let renamed = source(&orbit.id, Some(&web.id), "Marketing").unwrap();
        assert_eq!(
            (renamed.name.as_str(), renamed.slug.as_str()),
            ("Marketing", "web-app")
        );
        assert_eq!(
            source(&orbit.id, None, "Web App").unwrap().slug,
            "web-app-3"
        );
        // Suffixed slugs stay within the 64 characters workspace URLs accept.
        let long = "a".repeat(80);
        assert_eq!(source(&orbit.id, None, &long).unwrap().slug, "a".repeat(64));
        assert_eq!(
            source(&orbit.id, None, &format!("{}!", &long[1..]))
                .unwrap()
                .slug,
            format!("{}-2", "a".repeat(62))
        );
        assert_eq!(source(&orbit.id, None, "All").unwrap().slug, "all-2");
        assert_eq!(source(&orbit.id, None, "all!").unwrap().slug, "all-3");
        let atlas = product("Atlas");
        assert_eq!(source(&atlas.id, None, "Web App").unwrap().slug, "web-app");
        drop(db);
        drop(store);
        let reopened = crate::store::Store::open(dir.path(), 2).unwrap();
        assert_eq!(
            get(&reopened.sqlite().unwrap(), &orbit.id, &web.id)
                .unwrap()
                .slug,
            "web-app"
        );
    }
}
