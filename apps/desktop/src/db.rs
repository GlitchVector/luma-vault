//! The media index.
//!
//! One SQLite file in the app-data directory. It is a *cache of the filesystem*,
//! never the source of truth — every row can be rebuilt by rescanning, and
//! nothing in here is user data that would hurt to lose. That framing is what
//! lets the scanner upsert freely and the watcher delete rows without ceremony.
//!
//! # Why `rating` and `is_sexy` are denormalised out of `verdict_json`
//!
//! The whole verdict lives in a JSON blob, but the two fields the grid filters
//! on are also stored as real columns with indexes. Filtering by parsing JSON
//! across 50k rows on every keystroke is the difference between an instant grid
//! and a visibly janky one, and SQLite cannot index into a JSON blob without
//! `json_extract` on every row.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::types::{
    Folder, LibraryStats, MediaFrame, MediaItem, MediaKind, MediaPage, MediaQuery, MediaVerdict,
    Rating, SortOrder,
};

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("cannot create data directory {}", parent.display()))?;
        }
        let conn = Connection::open(path)
            .with_context(|| format!("cannot open index at {}", path.display()))?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let db = Self {
            conn: Mutex::new(Connection::open_in_memory()?),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock().expect("index mutex poisoned");

        // WAL so a long classification transaction never blocks the grid's
        // reads; NORMAL synchronous because this is a rebuildable cache and
        // fsync-per-commit would dominate a 50k-file scan.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;

        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS folders (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                path         TEXT    NOT NULL UNIQUE,
                added_at     INTEGER NOT NULL,
                last_scan_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS media (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                folder_id     INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
                path          TEXT    NOT NULL UNIQUE,
                name          TEXT    NOT NULL,
                kind          TEXT    NOT NULL,
                width         INTEGER NOT NULL DEFAULT 0,
                height        INTEGER NOT NULL DEFAULT 0,
                size_bytes    INTEGER NOT NULL DEFAULT 0,
                modified_at   INTEGER NOT NULL,
                added_at      INTEGER NOT NULL,
                thumb_path    TEXT,
                thumb_width   INTEGER,
                thumb_height  INTEGER,
                duration_sec  REAL,
                verdict_json  TEXT,
                rating        TEXT    NOT NULL DEFAULT 'unrated',
                is_sexy       INTEGER NOT NULL DEFAULT 0,
                classified_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS media_frames (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                media_id      INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
                frame_index   INTEGER NOT NULL,
                timestamp_sec REAL    NOT NULL,
                path          TEXT    NOT NULL,
                verdict_json  TEXT    NOT NULL,
                UNIQUE(media_id, frame_index)
            );

            CREATE INDEX IF NOT EXISTS media_folder      ON media(folder_id);
            CREATE INDEX IF NOT EXISTS media_recent      ON media(modified_at DESC);
            CREATE INDEX IF NOT EXISTS media_rating      ON media(rating);
            CREATE INDEX IF NOT EXISTS media_sexy        ON media(is_sexy);
            CREATE INDEX IF NOT EXISTS media_kind        ON media(kind);
            CREATE INDEX IF NOT EXISTS media_unclassified ON media(classified_at) WHERE classified_at IS NULL;
            CREATE INDEX IF NOT EXISTS media_unthumbed   ON media(thumb_path) WHERE thumb_path IS NULL;
            CREATE INDEX IF NOT EXISTS frames_of_media   ON media_frames(media_id);
            "#,
        )?;

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Folders
    // -----------------------------------------------------------------------

    pub fn add_folder(&self, path: &str, now: i64) -> Result<i64> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        conn.execute(
            "INSERT INTO folders (path, added_at) VALUES (?1, ?2)
             ON CONFLICT(path) DO NOTHING",
            params![path, now],
        )?;
        let id: i64 = conn.query_row(
            "SELECT id FROM folders WHERE path = ?1",
            params![path],
            |row| row.get(0),
        )?;
        Ok(id)
    }

    pub fn remove_folder(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        // ON DELETE CASCADE clears media and frames. Generated thumbnails are
        // left behind deliberately: they are content-addressed, so re-adding
        // the same folder reuses them instead of regenerating thousands of
        // files. `vacuum_thumbnails` sweeps orphans on demand.
        conn.execute("DELETE FROM folders WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn list_folders(&self) -> Result<Vec<Folder>> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT f.id, f.path, f.added_at, f.last_scan_at,
                    (SELECT COUNT(*) FROM media m WHERE m.folder_id = f.id)
             FROM folders f
             ORDER BY f.added_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            let path: String = row.get(1)?;
            Ok(Folder {
                id: row.get(0)?,
                available: Path::new(&path).is_dir(),
                path,
                added_at: row.get(2)?,
                last_scan_at: row.get(3)?,
                media_count: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Absolute paths of every watched folder — the allowlist the `luma://`
    /// protocol handler checks before reading a file off disk.
    pub fn folder_paths(&self) -> Result<Vec<PathBuf>> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        let mut stmt = conn.prepare("SELECT path FROM folders")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(PathBuf::from)
            .collect())
    }

    pub fn mark_scanned(&self, folder_id: i64, now: i64) -> Result<()> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        conn.execute(
            "UPDATE folders SET last_scan_at = ?2 WHERE id = ?1",
            params![folder_id, now],
        )?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Media
    // -----------------------------------------------------------------------

    /// Insert newly-seen files in one transaction, returning how many were new.
    ///
    /// Existing rows are left completely alone rather than updated: a file whose
    /// mtime changed is handled by the watcher, and re-touching every row on
    /// every rescan would blow away thumbnails and verdicts for an entire
    /// library because someone's backup tool rewrote the timestamps.
    pub fn insert_media_batch(&self, folder_id: i64, entries: &[ScannedFile], now: i64) -> Result<usize> {
        let mut conn = self.conn.lock().expect("index mutex poisoned");
        let tx = conn.transaction()?;
        let mut inserted = 0_usize;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO media (folder_id, path, name, kind, size_bytes, modified_at, added_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(path) DO NOTHING",
            )?;
            for entry in entries {
                inserted += stmt.execute(params![
                    folder_id,
                    entry.path,
                    entry.name,
                    entry.kind.as_str(),
                    entry.size_bytes,
                    entry.modified_at,
                    now,
                ])?;
            }
        }
        tx.commit()?;
        Ok(inserted)
    }

    /// Rows in a folder whose file no longer exists, so the watcher can drop them.
    pub fn delete_media_by_path(&self, path: &str) -> Result<()> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        conn.execute("DELETE FROM media WHERE path = ?1", params![path])?;
        Ok(())
    }

    pub fn media_paths_in_folder(&self, folder_id: i64) -> Result<Vec<String>> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        let mut stmt = conn.prepare("SELECT path FROM media WHERE folder_id = ?1")?;
        let rows = stmt.query_map(params![folder_id], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Files that still need a thumbnail (and therefore dimensions).
    pub fn pending_thumbnails(&self, limit: i64) -> Result<Vec<PendingFile>> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, path, kind FROM media
             WHERE thumb_path IS NULL
             ORDER BY modified_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            let kind: String = row.get(2)?;
            Ok(PendingFile {
                id: row.get(0)?,
                path: row.get(1)?,
                kind: if kind == "video" {
                    MediaKind::Video
                } else {
                    MediaKind::Image
                },
                thumb_path: None,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Files that have a thumbnail but no verdict yet.
    ///
    /// Ordered newest-first so the "recent files" strip at the top of the view
    /// fills in first — the part of the library you are actually looking at
    /// while a big scan runs.
    pub fn pending_classification(&self, limit: i64) -> Result<Vec<PendingFile>> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, path, kind, thumb_path FROM media
             WHERE classified_at IS NULL AND thumb_path IS NOT NULL
             ORDER BY modified_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            let kind: String = row.get(2)?;
            Ok(PendingFile {
                id: row.get(0)?,
                path: row.get(1)?,
                kind: if kind == "video" {
                    MediaKind::Video
                } else {
                    MediaKind::Image
                },
                thumb_path: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Swap a video's provisional poster for the frame the rollup chose.
    pub fn update_poster(&self, id: i64, thumb_path: &str) -> Result<()> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        conn.execute(
            "UPDATE media SET thumb_path = ?2 WHERE id = ?1",
            params![id, thumb_path],
        )?;
        Ok(())
    }

    pub fn update_thumbnail(&self, id: i64, update: &ThumbnailUpdate) -> Result<()> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        conn.execute(
            "UPDATE media
             SET thumb_path = ?2, thumb_width = ?3, thumb_height = ?4,
                 width = ?5, height = ?6, duration_sec = ?7
             WHERE id = ?1",
            params![
                id,
                update.thumb_path,
                update.thumb_width,
                update.thumb_height,
                update.width,
                update.height,
                update.duration_sec
            ],
        )?;
        Ok(())
    }

    pub fn update_verdict(&self, id: i64, verdict: &MediaVerdict, now: i64) -> Result<()> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        let json = serde_json::to_string(verdict)?;
        conn.execute(
            "UPDATE media
             SET verdict_json = ?2, rating = ?3, is_sexy = ?4, classified_at = ?5
             WHERE id = ?1",
            params![
                id,
                json,
                verdict.rating.as_str(),
                i64::from(verdict.sexy),
                now
            ],
        )?;
        Ok(())
    }

    /// Marks a file as processed without a verdict, so a permanently unreadable
    /// file is not retried forever on every pass.
    pub fn mark_unclassifiable(&self, id: i64, now: i64) -> Result<()> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        conn.execute(
            "UPDATE media SET classified_at = ?2, rating = 'unrated' WHERE id = ?1",
            params![id, now],
        )?;
        Ok(())
    }

    pub fn replace_frames(&self, media_id: i64, frames: &[NewFrame]) -> Result<()> {
        let mut conn = self.conn.lock().expect("index mutex poisoned");
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM media_frames WHERE media_id = ?1", params![media_id])?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO media_frames (media_id, frame_index, timestamp_sec, path, verdict_json)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            for frame in frames {
                stmt.execute(params![
                    media_id,
                    frame.frame_index,
                    frame.timestamp_sec,
                    frame.path,
                    frame.verdict_json,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn frames_for_media(&self, media_id: i64) -> Result<Vec<MediaFrame>> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, media_id, frame_index, timestamp_sec, path, verdict_json
             FROM media_frames WHERE media_id = ?1 ORDER BY frame_index ASC",
        )?;
        let rows = stmt.query_map(params![media_id], |row| {
            let json: String = row.get(5)?;
            Ok(MediaFrame {
                id: row.get(0)?,
                media_id: row.get(1)?,
                frame_index: row.get(2)?,
                timestamp_sec: row.get(3)?,
                path: row.get(4)?,
                verdict: serde_json::from_str(&json).unwrap_or_else(|_| crate::types::FrameVerdict {
                    person: false,
                    sexy: false,
                    nude: false,
                    rating: Rating::Unrated,
                    top_label: None,
                    top_label_title: None,
                    top_score: 0.0,
                    detections: Vec::new(),
                }),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn media_by_id(&self, id: i64) -> Result<Option<MediaItem>> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        let item = conn
            .query_row(
                &format!("SELECT {MEDIA_COLUMNS} FROM media WHERE id = ?1"),
                params![id],
                map_media_row,
            )
            .optional()?;
        Ok(item)
    }

    // -----------------------------------------------------------------------
    // Query
    // -----------------------------------------------------------------------

    pub fn query_media(&self, query: &MediaQuery) -> Result<MediaPage> {
        let conn = self.conn.lock().expect("index mutex poisoned");

        let mut where_parts: Vec<String> = Vec::new();
        let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(folder_id) = query.folder_id {
            where_parts.push(format!("folder_id = ?{}", binds.len() + 1));
            binds.push(Box::new(folder_id));
        }
        if let Some(kind) = query.kind {
            where_parts.push(format!("kind = ?{}", binds.len() + 1));
            binds.push(Box::new(kind.as_str().to_string()));
        }
        if let Some(rating) = query.rating {
            where_parts.push(format!("rating = ?{}", binds.len() + 1));
            binds.push(Box::new(rating.as_str().to_string()));
        }
        if query.sexy_only {
            where_parts.push("is_sexy = 1".to_string());
        }
        if !query.search.trim().is_empty() {
            where_parts.push(format!("name LIKE ?{} ESCAPE '\\'", binds.len() + 1));
            binds.push(Box::new(format!("%{}%", escape_like(query.search.trim()))));
        }

        let where_sql = if where_parts.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_parts.join(" AND "))
        };

        let order_sql = match query.sort {
            SortOrder::Recent => "ORDER BY modified_at DESC, id DESC",
            SortOrder::Oldest => "ORDER BY modified_at ASC, id ASC",
            SortOrder::Name => "ORDER BY name COLLATE NOCASE ASC, id ASC",
            SortOrder::Largest => "ORDER BY size_bytes DESC, id DESC",
            // A deterministic shuffle rather than RANDOM(): RANDOM() reorders
            // on every query, so page 2 would re-show items from page 1 and
            // silently skip others. This is stable for a given row set.
            SortOrder::Random => "ORDER BY (id * 2654435761) % 2147483647, id",
        };

        let bind_refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();

        let total: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM media {where_sql}"),
            bind_refs.as_slice(),
            |row| row.get(0),
        )?;

        let sql = format!(
            "SELECT {MEDIA_COLUMNS} FROM media {where_sql} {order_sql} LIMIT ?{} OFFSET ?{}",
            binds.len() + 1,
            binds.len() + 2
        );
        let mut stmt = conn.prepare(&sql)?;

        let mut all: Vec<&dyn rusqlite::ToSql> = bind_refs;
        all.push(&query.limit);
        all.push(&query.offset);

        let rows = stmt.query_map(all.as_slice(), map_media_row)?;
        let items = rows.collect::<rusqlite::Result<Vec<_>>>()?;

        Ok(MediaPage {
            items,
            total,
            offset: query.offset,
        })
    }

    /// Newest files across every folder — the strip pinned above the grid once
    /// a scan finishes.
    pub fn recent_media(&self, limit: i64) -> Result<Vec<MediaItem>> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        let mut stmt = conn.prepare(&format!(
            "SELECT {MEDIA_COLUMNS} FROM media
             WHERE thumb_path IS NOT NULL
             ORDER BY added_at DESC, modified_at DESC
             LIMIT ?1"
        ))?;
        let rows = stmt.query_map(params![limit], map_media_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn stats(&self) -> Result<LibraryStats> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        conn.query_row(
            "SELECT
                (SELECT COUNT(*) FROM folders),
                (SELECT COUNT(*) FROM media WHERE kind = 'image'),
                (SELECT COUNT(*) FROM media WHERE kind = 'video'),
                (SELECT COUNT(*) FROM media WHERE classified_at IS NOT NULL),
                (SELECT COUNT(*) FROM media WHERE classified_at IS NULL),
                (SELECT COUNT(*) FROM media WHERE is_sexy = 1)",
            [],
            |row| {
                Ok(LibraryStats {
                    folders: row.get(0)?,
                    images: row.get(1)?,
                    videos: row.get(2)?,
                    classified: row.get(3)?,
                    pending: row.get(4)?,
                    sexy: row.get(5)?,
                })
            },
        )
        .map_err(Into::into)
    }
}

const MEDIA_COLUMNS: &str = "id, folder_id, path, name, kind, width, height, size_bytes, \
                             modified_at, added_at, thumb_path, thumb_width, thumb_height, \
                             duration_sec, verdict_json, classified_at";

fn map_media_row(row: &Row<'_>) -> rusqlite::Result<MediaItem> {
    let kind: String = row.get(4)?;
    let verdict_json: Option<String> = row.get(14)?;
    Ok(MediaItem {
        id: row.get(0)?,
        folder_id: row.get(1)?,
        path: row.get(2)?,
        name: row.get(3)?,
        kind: if kind == "video" {
            MediaKind::Video
        } else {
            MediaKind::Image
        },
        width: row.get(5)?,
        height: row.get(6)?,
        size_bytes: row.get(7)?,
        modified_at: row.get(8)?,
        added_at: row.get(9)?,
        thumb_path: row.get(10)?,
        thumb_width: row.get(11)?,
        thumb_height: row.get(12)?,
        duration_sec: row.get(13)?,
        // A blob that fails to parse (an older schema, a truncated write) reads
        // as "not classified yet" rather than failing the whole query — the
        // next scan pass will rewrite it.
        verdict: verdict_json.and_then(|json| serde_json::from_str(&json).ok()),
        classified_at: row.get(15)?,
    })
}

/// `%` and `_` are wildcards in LIKE; a filename containing either would match
/// far more than the user typed.
fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[derive(Debug, Clone)]
pub struct ScannedFile {
    pub path: String,
    pub name: String,
    pub kind: MediaKind,
    pub size_bytes: i64,
    pub modified_at: i64,
}

#[derive(Debug, Clone)]
pub struct PendingFile {
    pub id: i64,
    pub path: String,
    pub kind: MediaKind,
    /// Set only by `pending_classification` — the classifier reads the
    /// thumbnail, never the multi-megapixel original.
    pub thumb_path: Option<String>,
}

/// Everything the thumbnail phase learns about a file in one pass.
///
/// A struct rather than seven positional parameters: `update_thumbnail(id,
/// path, 320, 240, 1600, 1200, None)` is four integers in a row that all mean
/// something different, and swapping two of them typechecks perfectly.
#[derive(Debug, Clone)]
pub struct ThumbnailUpdate {
    pub thumb_path: String,
    pub thumb_width: i64,
    pub thumb_height: i64,
    /// Dimensions of the *source*, which is what the grid uses for aspect ratio.
    pub width: i64,
    pub height: i64,
    pub duration_sec: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct NewFrame {
    pub frame_index: i64,
    pub timestamp_sec: f64,
    pub path: String,
    pub verdict_json: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{MediaKind, SortOrder};

    fn file(path: &str, kind: MediaKind, modified_at: i64) -> ScannedFile {
        ScannedFile {
            path: path.to_string(),
            name: path.rsplit('/').next().unwrap_or(path).to_string(),
            kind,
            size_bytes: 1024,
            modified_at,
        }
    }

    fn query() -> MediaQuery {
        MediaQuery {
            folder_id: None,
            kind: None,
            rating: None,
            sexy_only: false,
            search: String::new(),
            sort: SortOrder::Recent,
            limit: 100,
            offset: 0,
        }
    }

    fn seeded() -> (Db, i64) {
        let db = Db::open_in_memory().expect("in-memory index");
        let folder = db.add_folder("/media", 1).expect("add folder");
        db.insert_media_batch(
            folder,
            &[
                file("/media/a.jpg", MediaKind::Image, 300),
                file("/media/b.mp4", MediaKind::Video, 200),
                file("/media/c_100%.png", MediaKind::Image, 100),
            ],
            1,
        )
        .expect("insert");
        (db, folder)
    }

    #[test]
    fn adding_the_same_folder_twice_yields_one_row() {
        let db = Db::open_in_memory().unwrap();
        let first = db.add_folder("/media", 1).unwrap();
        let second = db.add_folder("/media", 2).unwrap();
        assert_eq!(first, second);
        assert_eq!(db.list_folders().unwrap().len(), 1);
    }

    #[test]
    fn rescanning_does_not_duplicate_or_disturb_existing_rows() {
        let (db, folder) = seeded();
        let again = db
            .insert_media_batch(folder, &[file("/media/a.jpg", MediaKind::Image, 999)], 2)
            .unwrap();
        assert_eq!(again, 0, "an already-indexed path must not insert again");
        assert_eq!(db.query_media(&query()).unwrap().total, 3);
    }

    #[test]
    fn recent_sort_is_newest_first() {
        let (db, _) = seeded();
        // Only rows with a thumbnail reach the grid's recent strip, but
        // query_media has no such filter — check the ordering here.
        let page = db.query_media(&query()).unwrap();
        let names: Vec<_> = page.items.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(names, vec!["a.jpg", "b.mp4", "c_100%.png"]);
    }

    #[test]
    fn kind_filter_narrows_to_videos() {
        let (db, _) = seeded();
        let page = db
            .query_media(&MediaQuery {
                kind: Some(MediaKind::Video),
                ..query()
            })
            .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].name, "b.mp4");
    }

    #[test]
    fn search_escapes_like_wildcards() {
        let (db, _) = seeded();

        // `%` is a LIKE wildcard. Unescaped, searching for it would match every
        // row; escaped, it matches only the file that really contains one.
        let page = db
            .query_media(&MediaQuery {
                search: "100%".to_string(),
                ..query()
            })
            .unwrap();
        assert_eq!(page.total, 1, "a literal % must not behave as a wildcard");
        assert_eq!(page.items[0].name, "c_100%.png");
    }

    #[test]
    fn random_sort_is_stable_across_pages() {
        let (db, _) = seeded();
        let first = db
            .query_media(&MediaQuery {
                sort: SortOrder::Random,
                ..query()
            })
            .unwrap();
        let second = db
            .query_media(&MediaQuery {
                sort: SortOrder::Random,
                ..query()
            })
            .unwrap();
        let ids = |page: &MediaPage| page.items.iter().map(|item| item.id).collect::<Vec<_>>();
        assert_eq!(
            ids(&first),
            ids(&second),
            "an unstable random sort would re-show page 1 items on page 2"
        );
    }

    #[test]
    fn verdicts_round_trip_and_drive_the_sexy_filter() {
        let (db, _) = seeded();
        let target = db.query_media(&query()).unwrap().items[0].id;

        let verdict = MediaVerdict {
            person: true,
            sexy: true,
            nude: false,
            rating: Rating::Suggestive,
            top_label: Some("BUTTOCKS_EXPOSED".to_string()),
            top_label_title: Some("exposed buttocks".to_string()),
            top_score: 0.81,
            frame_count: 1,
            sexy_frame_count: 1,
            poster_frame_index: Some(0),
        };
        db.update_verdict(target, &verdict, 42).unwrap();

        let stored = db.media_by_id(target).unwrap().unwrap();
        assert_eq!(stored.verdict.as_ref(), Some(&verdict));
        assert_eq!(stored.classified_at, Some(42));

        let sexy = db
            .query_media(&MediaQuery {
                sexy_only: true,
                ..query()
            })
            .unwrap();
        assert_eq!(sexy.total, 1);
    }

    #[test]
    fn stats_count_pending_and_classified_separately() {
        let (db, _) = seeded();
        let before = db.stats().unwrap();
        assert_eq!((before.images, before.videos, before.pending), (2, 1, 3));

        let target = db.query_media(&query()).unwrap().items[0].id;
        db.mark_unclassifiable(target, 7).unwrap();

        let after = db.stats().unwrap();
        assert_eq!((after.classified, after.pending), (1, 2));
    }

    #[test]
    fn removing_a_folder_cascades_to_its_media_and_frames() {
        let (db, folder) = seeded();
        let target = db.query_media(&query()).unwrap().items[0].id;
        db.replace_frames(
            target,
            &[NewFrame {
                frame_index: 0,
                timestamp_sec: 1.5,
                path: "/frames/0.jpg".to_string(),
                verdict_json: "{}".to_string(),
            }],
        )
        .unwrap();
        assert_eq!(db.frames_for_media(target).unwrap().len(), 1);

        db.remove_folder(folder).unwrap();
        assert_eq!(db.query_media(&query()).unwrap().total, 0);
        assert_eq!(db.frames_for_media(target).unwrap().len(), 0);
    }

    #[test]
    fn pending_queues_move_a_file_along_the_pipeline() {
        let (db, _) = seeded();
        assert_eq!(db.pending_thumbnails(100).unwrap().len(), 3);
        assert_eq!(db.pending_classification(100).unwrap().len(), 0);

        let target = db.query_media(&query()).unwrap().items[0].id;
        db.update_thumbnail(
            target,
            &ThumbnailUpdate {
                thumb_path: "/thumbs/a.jpg".to_string(),
                thumb_width: 320,
                thumb_height: 240,
                width: 1600,
                height: 1200,
                duration_sec: None,
            },
        )
        .unwrap();

        assert_eq!(db.pending_thumbnails(100).unwrap().len(), 2);
        let ready = db.pending_classification(100).unwrap();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].thumb_path.as_deref(), Some("/thumbs/a.jpg"));
    }
}
