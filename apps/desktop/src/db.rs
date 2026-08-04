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

use crate::generated::Generation;
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
                classified_at INTEGER,
                error         TEXT
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

            CREATE TABLE IF NOT EXISTS media_tags (
                media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
                tag      TEXT    NOT NULL,
                PRIMARY KEY (media_id, tag)
            );

            CREATE INDEX IF NOT EXISTS tags_by_tag       ON media_tags(tag, media_id);
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

        // Additive migration for indexes created before `error` existed.
        // Checked rather than blindly attempted, because a failing ALTER inside
        // a batch would abort the rest of the migration.
        let has_error_column = conn
            .prepare("PRAGMA table_info(media)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "error");
        if !has_error_column {
            conn.execute_batch("ALTER TABLE media ADD COLUMN error TEXT")?;
        }

        // Content key: what a derived file is addressed by. Nullable, and
        // deliberately not backfilled — rows indexed before this existed keep
        // the `thumb_path` they already recorded, so nothing regenerates. The
        // measure phase fills the column in as it goes.
        let has_content_key = conn
            .prepare("PRAGMA table_info(media)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "content_key");
        if !has_content_key {
            conn.execute_batch("ALTER TABLE media ADD COLUMN content_key TEXT")?;
        }
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS media_content_key ON media(content_key)
             WHERE content_key IS NOT NULL",
        )?;

        // Partial index over exactly the rows the thumbnail queue scans.
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS media_thumb_queue
             ON media(modified_at DESC) WHERE thumb_path IS NULL AND error IS NULL",
        )?;

        // When the anime tagger last had an opinion about this row.
        //
        // Its own column rather than a flag on `classified_at`, because the two
        // passes are independent: NudeNet decides every file, the tagger only
        // revisits the ones NudeNet called SFW. A row can be fully classified
        // and still be waiting for its second opinion.
        let has_anime_at = conn
            .prepare("PRAGMA table_info(media)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "anime_at");
        if !has_anime_at {
            conn.execute_batch("ALTER TABLE media ADD COLUMN anime_at INTEGER")?;

            // Backfill rows that were classified while the tagger ran inline.
            // Their detections already carry `ANIME_*` findings, so leaving
            // them queued would append a second copy and double-count them.
            // Matching on the stored JSON is exact here: no other producer
            // writes that prefix.
            conn.execute_batch(
                "UPDATE media SET anime_at = classified_at
                 WHERE classified_at IS NOT NULL
                   AND verdict_json IS NOT NULL
                   AND EXISTS (
                       SELECT 1 FROM media_frames f
                       WHERE f.media_id = media.id AND f.verdict_json LIKE '%ANIME\\_%' ESCAPE '\\'
                   )",
            )?;
        }
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS media_anime_queue ON media(rating)
             WHERE anime_at IS NULL AND classified_at IS NOT NULL",
        )?;

        // Small, durable app settings. A table rather than a file beside the
        // index so a setting cannot survive a deleted index and reappear
        // describing a library that no longer exists.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS settings (
                 key   TEXT NOT NULL PRIMARY KEY,
                 value TEXT NOT NULL
             );",
        )?;

        // Stars (1-5) and what the file says about its own generation.
        //
        // `stars` is a *user* judgement and deliberately separate from
        // `rating`: one says "I like this", the other says "this is explicit".
        // Nothing in the pipeline ever writes `stars` from a model.
        for (column, decl) in [
            ("stars", "INTEGER"),
            ("prompt", "TEXT"),
            ("generation_json", "TEXT"),
            // Perceptual hash of the thumbnail, images only. See `dupes`.
            ("phash", "INTEGER"),
            // 8x8 RGB alongside it: the hash is greyscale and cannot tell two
            // differently-lit photographs apart on its own.
            ("colour_sig", "BLOB"),
            // Which set of duplicates this row belongs to, or NULL for none.
            ("dupe_group", "INTEGER"),
        ] {
            let present = conn
                .prepare("PRAGMA table_info(media)")?
                .query_map([], |row| row.get::<_, String>(1))?
                .filter_map(Result::ok)
                .any(|name| name == column);
            if !present {
                conn.execute_batch(&format!("ALTER TABLE media ADD COLUMN {column} {decl}"))?;
            }
        }
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS media_stars ON media(stars) WHERE stars IS NOT NULL",
        )?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS media_dupes ON media(dupe_group, id)
             WHERE dupe_group IS NOT NULL",
        )?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS media_unhashed ON media(id)
             WHERE phash IS NULL AND thumb_path IS NOT NULL AND kind = 'image'",
        )?;

        // Full-text search over filenames and prompts.
        //
        // **Trigram, not the default tokenizer.** The default indexes whole
        // words, and a booru prompt is full of `1girl`, `2girls`,
        // `moona_hoshinova` — searching "girl" against it finds 9,517 rows
        // where a substring search finds 45,966. Trigram gives `LIKE '%x%'`
        // semantics, which is what someone typing into a search box means.
        //
        // Measured on this library, 160,901 rows: `LIKE` needs 183-230ms for a
        // count, which is far too slow to type against. Trigram answers the
        // same queries in 0-7ms and builds once in 2.4s.
        //
        // `content='media'` so the text is not stored twice; the triggers below
        // are what an external-content table requires to stay in step.
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS media_fts USING fts5(
                 name, prompt, content='media', content_rowid='id', tokenize='trigram'
             )",
        )?;
        conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS media_fts_insert AFTER INSERT ON media BEGIN
                 INSERT INTO media_fts(rowid, name, prompt) VALUES (new.id, new.name, new.prompt);
             END;
             CREATE TRIGGER IF NOT EXISTS media_fts_delete AFTER DELETE ON media BEGIN
                 INSERT INTO media_fts(media_fts, rowid, name, prompt)
                 VALUES ('delete', old.id, old.name, old.prompt);
             END;
             CREATE TRIGGER IF NOT EXISTS media_fts_update AFTER UPDATE ON media BEGIN
                 INSERT INTO media_fts(media_fts, rowid, name, prompt)
                 VALUES ('delete', old.id, old.name, old.prompt);
                 INSERT INTO media_fts(rowid, name, prompt) VALUES (new.id, new.name, new.prompt);
             END;",
        )?;
        // Backfill once, recorded by a flag rather than by inspecting the table.
        //
        // Counting rows does not work here and fails in the direction that
        // looks fine: on an external-content table `SELECT count(*) FROM
        // media_fts` is answered from `media`, so a *completely empty* index
        // reports the full row count. The obvious guard — "rebuild when the
        // index has fewer rows than the library" — is therefore never true, and
        // every search silently returns nothing.
        //
        // The version lets a tokenizer or column change force one rebuild
        // later; rebuilding every launch would cost 3.7s on this library.
        let built: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = 'fts_version'", [], |row| row.get(0))
            .optional()?;
        if built.as_deref() != Some(FTS_VERSION) {
            conn.execute_batch("INSERT INTO media_fts(media_fts) VALUES ('rebuild')")?;
            conn.execute(
                "INSERT INTO settings(key, value) VALUES ('fts_version', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [FTS_VERSION],
            )?;
        }

        // Ratings lifted out of a Stable Diffusion Image Browser database.
        //
        // Kept as their own table rather than written straight onto `media`,
        // because an import usually happens *before* the folder it describes
        // has been scanned — and because the files it names may not exist at
        // all. Measured against two real databases: of 7,513 ratings, 3,042
        // pointed at files that still existed and the rest had been deleted
        // deliberately. Holding them here means the survivors attach to rows
        // as those rows appear, and the others cost nothing but a row.
        //
        // `match_key` is the path from `outputs\` onwards, lowercased. That
        // survives the whole tree being moved to another drive *and* the
        // install directory being renamed, both of which had happened.
        // Folders the scanner walks straight past.
        //
        // The app-managed twin of dropping a `.lumaignore` into a directory.
        // Both exist because they suit different situations: the marker file
        // travels with the folder and survives a reinstall, while this one can
        // be set from the grid the moment you notice a texture pack in it —
        // which is when you actually find out you wanted it.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS excluded_folders (
                 path       TEXT    NOT NULL PRIMARY KEY,
                 added_at   INTEGER NOT NULL
             );",
        )?;

        // Which rating databases have already been read, so a scan that finds
        // the same file again does not re-read 2 million rows every launch.
        //
        // Keyed on size and mtime as well as path: an Image Browser database
        // belonging to a webui someone still uses gains ratings over time, and
        // the point of importing automatically is that new ones arrive without
        // being asked for.
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS imported_databases (
                path        TEXT    NOT NULL PRIMARY KEY,
                size_bytes  INTEGER NOT NULL,
                modified_at INTEGER NOT NULL,
                imported_at INTEGER NOT NULL,
                staged      INTEGER NOT NULL
            );
            "#,
        )?;

        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS imported_stars (
                match_key TEXT    NOT NULL PRIMARY KEY,
                stars     INTEGER NOT NULL,
                source    TEXT    NOT NULL,
                imported_at INTEGER NOT NULL
            );
            "#,
        )?;

        // When this row was last examined for structural tags. Same shape as
        // `anime_at` and for the same reason: the queue is a query, so the
        // pass is restartable and a row is never examined twice.
        let has_labelled_at = conn
            .prepare("PRAGMA table_info(media)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "labelled_at");
        if !has_labelled_at {
            conn.execute_batch("ALTER TABLE media ADD COLUMN labelled_at INTEGER")?;
        }
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS media_label_queue
             ON media(modified_at DESC) WHERE labelled_at IS NULL AND error IS NULL",
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

    /// Images with a thumbnail but no perceptual hash yet.
    ///
    /// Images only: a video's duplicates are found by its content key, which
    /// the scan already computed, so hashing poster frames would be work with
    /// no question behind it.
    pub fn pending_hashes(&self, limit: i64) -> Result<Vec<PendingFile>> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, path, kind, thumb_path, content_key FROM media
             WHERE (phash IS NULL OR colour_sig IS NULL)
               AND thumb_path IS NOT NULL AND error IS NULL
               AND kind = 'image'
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(PendingFile {
                id: row.get(0)?,
                path: row.get(1)?,
                kind: MediaKind::Image,
                thumb_path: row.get(3)?,
                content_key: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Stored as a signed integer because SQLite has no unsigned type. The bit
    /// pattern round-trips exactly, which is all the Hamming distance needs.
    pub fn set_fingerprint(&self, id: i64, hash: u64, colour: &[u8]) -> Result<()> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        conn.execute(
            "UPDATE media SET phash = ?2, colour_sig = ?3 WHERE id = ?1",
            params![id, hash as i64, colour],
        )?;
        Ok(())
    }

    pub fn all_fingerprints(&self) -> Result<Vec<(i64, u64, Vec<u8>)>> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, phash, colour_sig FROM media
             WHERE phash IS NOT NULL AND colour_sig IS NOT NULL AND error IS NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)? as u64,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Videos that share a content key, as `(group id, row id)` pairs.
    ///
    /// The key is size plus a hash of the first and last 64KB, so this is an
    /// exact match rather than a perceptual one — two videos with the same key
    /// are the same file. Stronger than comparing sizes, which two unrelated
    /// videos can share, and it costs nothing because the scan already
    /// computed it.
    pub fn video_duplicates(&self) -> Result<Vec<(i64, i64)>> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT MIN(id) OVER (PARTITION BY content_key), id FROM media
             WHERE kind = 'video' AND content_key IS NOT NULL AND error IS NULL
               AND content_key IN (
                   SELECT content_key FROM media
                   WHERE kind = 'video' AND content_key IS NOT NULL AND error IS NULL
                   GROUP BY content_key HAVING COUNT(*) > 1
               )",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Replace every duplicate grouping in one transaction.
    ///
    /// Cleared first, so a row that stopped having a twin — because the other
    /// copy was deleted, or excluded — stops being shown as one.
    pub fn set_duplicate_groups(&self, pairs: &[(i64, i64)]) -> Result<()> {
        let mut conn = self.conn.lock().expect("index mutex poisoned");
        let tx = conn.transaction()?;
        tx.execute("UPDATE media SET dupe_group = NULL WHERE dupe_group IS NOT NULL", [])?;
        {
            let mut stmt = tx.prepare("UPDATE media SET dupe_group = ?2 WHERE id = ?1")?;
            for (group, id) in pairs {
                stmt.execute(params![id, group])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Folders the scanner must walk straight past, newest first.
    pub fn excluded_folders(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        let mut stmt =
            conn.prepare("SELECT path FROM excluded_folders ORDER BY added_at DESC")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn add_excluded_folder(&self, path: &str, now: i64) -> Result<()> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        conn.execute(
            "INSERT INTO excluded_folders (path, added_at) VALUES (?1, ?2)
             ON CONFLICT(path) DO NOTHING",
            params![path, now],
        )?;
        Ok(())
    }

    pub fn remove_excluded_folder(&self, path: &str) -> Result<()> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        conn.execute("DELETE FROM excluded_folders WHERE path = ?1", params![path])?;
        Ok(())
    }

    /// Drop every indexed row under `prefix`, returning their content keys.
    ///
    /// Excluding a folder has to remove what is already indexed as well as stop
    /// future walks, or the texture pack you just excluded stays in the grid
    /// until something else happens to prune it.
    ///
    /// The keys come back so the caller can delete the thumbnails those rows
    /// were the last owner of — a key shared with a file elsewhere must keep
    /// its derived data, which is why this cannot just delete by row.
    pub fn delete_media_under(&self, prefix: &str) -> Result<Vec<String>> {
        let mut conn = self.conn.lock().expect("index mutex poisoned");
        let tx = conn.transaction()?;
        let keys: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT DISTINCT content_key FROM media
                 WHERE content_key IS NOT NULL AND (path = ?1 OR path LIKE ?2 ESCAPE '\\')",
            )?;
            let pattern = format!("{}%", escape_like(prefix));
            let rows = stmt.query_map(params![prefix, pattern], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        tx.execute(
            "DELETE FROM media WHERE path = ?1 OR path LIKE ?2 ESCAPE '\\'",
            params![prefix, format!("{}%", escape_like(prefix))],
        )?;
        tx.commit()?;
        Ok(keys)
    }

    /// Whether any row still uses this content key. See [`Db::delete_media_under`].
    pub fn content_key_is_orphaned(&self, key: &str) -> Result<bool> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM media WHERE content_key = ?1",
            params![key],
            |row| row.get::<_, i64>(0),
        )? == 0)
    }

    pub fn media_paths_in_folder(&self, folder_id: i64) -> Result<Vec<String>> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        let mut stmt = conn.prepare("SELECT path FROM media WHERE folder_id = ?1")?;
        let rows = stmt.query_map(params![folder_id], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Files that still need a thumbnail (and therefore dimensions).
    ///
    /// **`error IS NULL` is load-bearing.** This query is the thumbnail phase's
    /// loop condition, so a row it keeps returning is a row the phase keeps
    /// retrying. Marking a failure only as "classified" — which is what the
    /// first version did — leaves `thumb_path` NULL and spins forever on the
    /// first unreadable file. Anything that gives up on a row must set `error`.
    pub fn pending_thumbnails(&self, limit: i64) -> Result<Vec<PendingFile>> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        // Images first, then videos — the `kind = 'video'` sort key.
        //
        // One image thumbnail takes a fraction of a second; one video takes an
        // ffprobe plus 25 ffmpeg seeks, which on a 4K file over SMB is ~12
        // seconds. Interleaved by mtime, a handful of videos occupy every
        // worker and tens of thousands of images sit behind them — a real scan
        // produced 33 thumbnails in 20 minutes while grinding through 4K MKVs.
        //
        // Ordering this way fills the grid with the whole image library first
        // and leaves the videos to grind afterwards. Same total work, but the
        // app becomes useful hours earlier.
        let mut stmt = conn.prepare(
            "SELECT id, path, kind, content_key FROM media
             WHERE thumb_path IS NULL AND error IS NULL
             ORDER BY kind = 'video', modified_at DESC
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
                content_key: row.get(3)?,
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
        // Images first here too: an image is one classifier call, a video is 25.
        let mut stmt = conn.prepare(
            "SELECT id, path, kind, thumb_path, content_key FROM media
             WHERE classified_at IS NULL AND thumb_path IS NOT NULL AND error IS NULL
             ORDER BY kind = 'video', modified_at DESC
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
                content_key: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The rating rules this index's verdicts were produced by.
    ///
    /// Stored in SQLite's own `user_version` rather than a settings table: it
    /// is one integer, it needs no schema, and it travels with the file.
    pub fn rating_version(&self) -> Result<i64> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?)
    }

    pub fn set_rating_version(&self, version: i64) -> Result<()> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        // PRAGMA will not take a bound parameter.
        conn.execute_batch(&format!("PRAGMA user_version = {version}"))?;
        Ok(())
    }

    /// Every classified row that still has the detections it was rated from.
    ///
    /// The queue for re-rating after a rule change. Rows with no frames cannot
    /// be re-rated without running the model again, so they are left alone and
    /// keep whatever verdict they have.
    pub fn rows_with_frames(&self) -> Result<Vec<PendingFile>> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT m.id, m.path, m.kind, m.thumb_path, m.content_key FROM media m
             WHERE m.error IS NULL
               AND EXISTS (SELECT 1 FROM media_frames f WHERE f.media_id = m.id)",
        )?;
        let rows = stmt.query_map([], |row| {
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
                content_key: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// How many rows a phase has already finished, so progress can be reported
    /// against the library rather than against one run of the app.
    ///
    /// Without this, `done` restarts at zero every launch while `total` shrinks
    /// to whatever is still outstanding — so resuming a 90%-complete scan
    /// renders as `0 / 6,000` and reads as though the work was thrown away. It
    /// was not; the queues are `IS NULL` predicates and finished rows never
    /// come back. This makes the display say what the index already knows.
    pub fn completed_in_phase(&self, phase: PhaseQueue) -> Result<i64> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        let sql = match phase {
            PhaseQueue::Dimensions => {
                "SELECT COUNT(*) FROM media WHERE width > 0 AND content_key IS NOT NULL"
            }
            PhaseQueue::Thumbnails => "SELECT COUNT(*) FROM media WHERE thumb_path IS NOT NULL",
            PhaseQueue::Classification => {
                "SELECT COUNT(*) FROM media WHERE classified_at IS NOT NULL"
            }
            // Documents are outside this phase's universe entirely — neither
            // queued nor counted as finished — so the two halves of `total`
            // are drawn from the same population and the bar cannot exceed 100%.
            PhaseQueue::AnimeReview => {
                "SELECT COUNT(*) FROM media WHERE anime_at IS NOT NULL AND rating = 'sfw'
                 AND NOT EXISTS (
                     SELECT 1 FROM media_tags t
                     WHERE t.media_id = media.id AND t.tag = 'document'
                 )"
            }
            PhaseQueue::Labels => "SELECT COUNT(*) FROM media WHERE labelled_at IS NOT NULL",
        };
        Ok(conn.query_row(sql, [], |row| row.get(0))?)
    }

    /// Rows NudeNet called SFW that the anime tagger has not yet seen.
    ///
    /// SFW only, and that is the whole point of the phase: the tagger exists to
    /// catch drawn content NudeNet under-fires on, so it can only ever *raise*
    /// a rating. Running it on something already flagged spends the most
    /// expensive model in the app to confirm a decision that has been made.
    ///
    /// Documents are excluded for the same reason. A Danbooru-trained tagger
    /// has no useful opinion about a scanned payslip, and the label phase runs
    /// first in every path that reaches here, so the tag is already known.
    ///
    /// Newest first, matching every other queue — the part of the library on
    /// screen settles first.
    pub fn pending_anime(&self, limit: i64) -> Result<Vec<PendingFile>> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, path, kind, thumb_path, content_key FROM media
             WHERE anime_at IS NULL
               AND classified_at IS NOT NULL
               AND rating = 'sfw'
               AND thumb_path IS NOT NULL
               AND error IS NULL
               AND NOT EXISTS (
                   SELECT 1 FROM media_tags t
                   WHERE t.media_id = media.id AND t.tag = 'document'
               )
             ORDER BY kind = 'video', modified_at DESC
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
                content_key: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        Ok(conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Record what a file says about how it was generated.
    ///
    /// The prompt is duplicated into its own column rather than only living in
    /// the JSON, so searching for a prompt cannot also match a model hash or a
    /// seed that happens to contain the same digits.
    pub fn set_generation(&self, id: i64, generation: Option<&Generation>) -> Result<()> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        let json = match generation {
            Some(generation) => Some(serde_json::to_string(generation)?),
            None => None,
        };
        conn.execute(
            "UPDATE media SET generation_json = ?2, prompt = ?3 WHERE id = ?1",
            params![id, json, generation.and_then(|g| g.prompt.clone())],
        )?;
        Ok(())
    }

    /// Attach an imported star rating to a row, if one was recorded for it.
    ///
    /// Never overwrites a rating already on the row: an import is a one-time
    /// recovery of somebody's past judgement, and re-running it must not undo
    /// a newer one made here.
    pub fn apply_imported_stars(&self, id: i64, path: &str) -> Result<bool> {
        let Some(key) = outputs_match_key(path) else {
            return Ok(false);
        };
        let conn = self.conn.lock().expect("index mutex poisoned");
        let changed = conn.execute(
            "UPDATE media SET stars = (SELECT stars FROM imported_stars WHERE match_key = ?2)
             WHERE id = ?1
               AND stars IS NULL
               AND EXISTS (SELECT 1 FROM imported_stars WHERE match_key = ?2)",
            params![id, key],
        )?;
        Ok(changed > 0)
    }

    /// Has this database already been read, exactly as it is now?
    ///
    /// A changed size or mtime means the webui has been used since, so it is
    /// read again — the ratings are staged with `ON CONFLICT DO UPDATE`, so a
    /// re-read refreshes rather than duplicates.
    pub fn database_already_imported(
        &self,
        path: &str,
        size_bytes: i64,
        modified_at: i64,
    ) -> Result<bool> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        Ok(conn
            .query_row(
                "SELECT 1 FROM imported_databases
                 WHERE path = ?1 AND size_bytes = ?2 AND modified_at = ?3",
                params![path, size_bytes, modified_at],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    pub fn record_database_import(
        &self,
        path: &str,
        size_bytes: i64,
        modified_at: i64,
        staged: i64,
        now: i64,
    ) -> Result<()> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        conn.execute(
            "INSERT INTO imported_databases (path, size_bytes, modified_at, imported_at, staged)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(path) DO UPDATE SET
                 size_bytes = excluded.size_bytes,
                 modified_at = excluded.modified_at,
                 imported_at = excluded.imported_at,
                 staged = excluded.staged",
            params![path, size_bytes, modified_at, now, staged],
        )?;
        Ok(())
    }

    /// Stage ratings read out of an Image Browser database.
    ///
    /// Returns how many were stored. Replaces on conflict, so re-importing a
    /// database that has since been updated refreshes rather than duplicates.
    pub fn stage_imported_stars(
        &self,
        entries: &[(String, i64)],
        source: &str,
        now: i64,
    ) -> Result<usize> {
        let mut conn = self.conn.lock().expect("index mutex poisoned");
        let tx = conn.transaction()?;
        let mut stored = 0;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO imported_stars (match_key, stars, source, imported_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(match_key) DO UPDATE SET
                     stars = excluded.stars,
                     source = excluded.source,
                     imported_at = excluded.imported_at",
            )?;
            for (key, stars) in entries {
                stmt.execute(params![key, stars, source, now])?;
                stored += 1;
            }
        }
        tx.commit()?;
        Ok(stored)
    }

    /// Apply every staged rating to rows already in the index.
    ///
    /// Returns how many rows gained a rating. Runs as one statement rather
    /// than a row-by-row loop because the join is what SQLite is for.
    pub fn apply_all_imported_stars(&self) -> Result<usize> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        let mut stmt = conn.prepare("SELECT id, path FROM media WHERE stars IS NULL")?;
        let rows: Vec<(i64, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .filter_map(Result::ok)
            .collect();
        drop(stmt);

        let mut update = conn.prepare(
            "UPDATE media SET stars = (SELECT stars FROM imported_stars WHERE match_key = ?2)
             WHERE id = ?1 AND EXISTS (SELECT 1 FROM imported_stars WHERE match_key = ?2)",
        )?;
        let mut applied = 0;
        for (id, path) in rows {
            if let Some(key) = outputs_match_key(&path) {
                applied += update.execute(params![id, key])?;
            }
        }
        Ok(applied)
    }

    /// Set or clear a row's star rating. The one place a person's judgement
    /// is written; nothing in the pipeline calls this.
    pub fn set_stars(&self, id: i64, stars: Option<i64>) -> Result<()> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        conn.execute(
            "UPDATE media SET stars = ?2 WHERE id = ?1",
            params![id, stars.filter(|s| (1..=5).contains(s))],
        )?;
        Ok(())
    }

    /// Rows that have never been examined for structural tags.
    ///
    /// Unlike the classification queue this does not require a verdict: a
    /// document is a document whether or not anything has rated it, and the
    /// generator metadata sits in the file itself.
    pub fn pending_labels(&self, limit: i64) -> Result<Vec<PendingFile>> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, path, kind, thumb_path, content_key FROM media
             WHERE labelled_at IS NULL AND error IS NULL
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
                content_key: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Replace a row's tags and stamp it as examined, in one transaction.
    ///
    /// Replace rather than insert, so re-running the pass after a rule change
    /// corrects a row instead of accumulating both answers.
    pub fn set_tags(&self, id: i64, tags: &[String], now: i64) -> Result<()> {
        let mut conn = self.conn.lock().expect("index mutex poisoned");
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM media_tags WHERE media_id = ?1", params![id])?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR IGNORE INTO media_tags (media_id, tag) VALUES (?1, ?2)",
            )?;
            for tag in tags {
                stmt.execute(params![id, tag])?;
            }
        }
        tx.execute(
            "UPDATE media SET labelled_at = ?2 WHERE id = ?1",
            params![id, now],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Record that the tagger has seen this row, whatever it concluded.
    ///
    /// Stamped even when the tagger found nothing, so a file it has no opinion
    /// about leaves the queue instead of being re-examined on every launch.
    pub fn mark_anime_done(&self, id: i64, now: i64) -> Result<()> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        conn.execute("UPDATE media SET anime_at = ?2 WHERE id = ?1", params![id, now])?;
        Ok(())
    }

    /// Files whose shape is not known yet.
    ///
    /// This queue is what keeps the grid still. A tile is laid out from
    /// `width`/`height`, so a row without them has no size — and every one that
    /// gains a size later reflows the whole `flex-wrap` wall. Filling these
    /// takes a header read per file rather than a decode, so the layout settles
    /// long before the thumbnails do.
    pub fn pending_dimensions(&self, limit: i64) -> Result<Vec<PendingFile>> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        // Newest first, matching the grid's default sort: the tiles the user is
        // actually looking at stop moving first.
        let mut stmt = conn.prepare(
            "SELECT id, path, kind FROM media
             WHERE (width IS NULL OR width = 0 OR content_key IS NULL) AND error IS NULL
             ORDER BY kind = 'video', modified_at DESC
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
                content_key: None,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Record a source's shape without touching anything else about the row.
    ///
    /// Deliberately not `mark_failed` on error: a file whose header will not
    /// read may still thumbnail through the ffmpeg fallback, and failing it
    /// here would deny it that chance.
    pub fn update_dimensions(
        &self,
        id: i64,
        width: i64,
        height: i64,
        duration_sec: Option<f64>,
        content_key: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        conn.execute(
            "UPDATE media SET width = ?2, height = ?3,
                 duration_sec = COALESCE(?4, duration_sec),
                 content_key = COALESCE(?5, content_key)
             WHERE id = ?1",
            params![id, width, height, duration_sec, content_key],
        )?;
        Ok(())
    }

    /// The content key recorded for a path, if the measure phase reached it.
    pub fn content_key_for_path(&self, path: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        let mut stmt = conn.prepare("SELECT content_key FROM media WHERE path = ?1")?;
        let mut rows = stmt.query(params![path])?;
        match rows.next()? {
            Some(row) => Ok(row.get(0)?),
            None => Ok(None),
        }
    }

    /// How many rows still point at a content key.
    ///
    /// Content addressing means duplicates share one derived file, so this is
    /// what makes deleting them safe: zero means the last referent is gone.
    pub fn rows_with_content_key(&self, key: &str) -> Result<i64> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM media WHERE content_key = ?1",
            params![key],
            |row| row.get(0),
        )?)
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

    /// Give up on a file, recording why.
    ///
    /// This is the **only** correct way to drop a row out of the pipeline: it
    /// sets `error`, which is what both pending queues filter on. Setting just
    /// `classified_at` leaves the row in the thumbnail queue and the phase spins
    /// on it forever.
    ///
    /// The message is kept so the UI can explain a missing tile rather than
    /// silently omitting the file.
    pub fn mark_failed(&self, id: i64, message: &str, now: i64) -> Result<()> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        conn.execute(
            "UPDATE media
             SET error = ?2, classified_at = ?3, rating = 'unrated'
             WHERE id = ?1",
            // Truncated: an ffmpeg failure can carry kilobytes of stderr, and
            // the whole row is read on every grid query.
            params![id, truncate(message, 400), now],
        )?;
        Ok(())
    }

    /// Clear every recorded failure so a rescan retries them.
    ///
    /// Failures are usually permanent (a corrupt file), but not always — an
    /// unmounted share or a missing ffmpeg fails everything it touches, and
    /// after fixing that the user needs a way to say "try again".
    pub fn clear_errors(&self, folder_id: Option<i64>) -> Result<usize> {
        let conn = self.conn.lock().expect("index mutex poisoned");
        let cleared = match folder_id {
            Some(id) => conn.execute(
                "UPDATE media SET error = NULL, classified_at = NULL
                 WHERE error IS NOT NULL AND folder_id = ?1",
                params![id],
            )?,
            None => conn.execute(
                "UPDATE media SET error = NULL, classified_at = NULL WHERE error IS NOT NULL",
                [],
            )?,
        };
        Ok(cleared)
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
            // Filename *or* prompt. Searching a generated library by what was
            // asked for is the point of keeping the prompt, and nobody wants
            // two search boxes to choose between. The prompt is its own column
            // rather than part of the generation blob so that searching for
            // "euler" finds a prompt about Euler and not every image made with
            // that sampler.
            // Through the FTS index rather than `LIKE`, so it composes with the
            // folder, kind and rating filters *and* answers in single-digit
            // milliseconds. Measured on 160,901 rows: `LIKE '%moona%'` needs
            // 230ms for the count this query also runs — far too slow for a
            // field that filters the grid as you type.
            //
            // A term the index cannot answer yields nothing rather than
            // everything: typing "ab" should show an empty grid, not the whole
            // library, because the next keystroke is about to make it useful.
            match fts_expression(query.search.trim()) {
                Some(expression) => {
                    let at = binds.len() + 1;
                    where_parts.push(format!(
                        "id IN (SELECT rowid FROM media_fts WHERE media_fts MATCH ?{at})"
                    ));
                    binds.push(Box::new(expression));
                }
                None => where_parts.push("0".to_string()),
            }
        }
        if let Some(min) = query.min_stars {
            where_parts.push(format!("stars >= ?{}", binds.len() + 1));
            binds.push(Box::new(min));
        }
        if query.duplicates_only {
            where_parts.push("dupe_group IS NOT NULL".to_string());
        }
        if let Some(tag) = query.tag.as_deref().filter(|tag| !tag.is_empty()) {
            where_parts.push(format!(
                "EXISTS (SELECT 1 FROM media_tags t WHERE t.media_id = media.id AND t.tag = ?{})",
                binds.len() + 1
            ));
            binds.push(Box::new(tag.to_string()));
        }
        for hidden in query.hide_tags.iter().filter(|tag| !tag.is_empty()) {
            // One NOT EXISTS per tag rather than a single `NOT IN (...)`: the
            // list is bound, so it cannot be interpolated as one placeholder,
            // and hiding two tags is an AND of two absences either way.
            where_parts.push(format!(
                "NOT EXISTS (SELECT 1 FROM media_tags t WHERE t.media_id = media.id AND t.tag = ?{})",
                binds.len() + 1
            ));
            binds.push(Box::new(hidden.clone()));
        }

        let where_sql = if where_parts.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_parts.join(" AND "))
        };

        // Duplicates override the sort: the whole point of the view is seeing
        // copies of one picture next to each other, and any other order
        // scatters them through the grid.
        let order_sql = if query.duplicates_only {
            "ORDER BY dupe_group, id"
        } else {
            match query.sort {
            SortOrder::Recent => "ORDER BY modified_at DESC, id DESC",
            SortOrder::Added => "ORDER BY added_at DESC, id DESC",
            SortOrder::Oldest => "ORDER BY modified_at ASC, id ASC",
            SortOrder::Name => "ORDER BY name COLLATE NOCASE ASC, id ASC",
            SortOrder::Largest => "ORDER BY size_bytes DESC, id DESC",
            // A deterministic shuffle rather than RANDOM(): RANDOM() reorders
            // on every query, so page 2 would re-show items from page 1 and
            // silently skip others. This is stable for a given row set.
            SortOrder::Random => "ORDER BY (id * 2654435761) % 2147483647, id",
            }
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
                (SELECT COUNT(*) FROM media WHERE is_sexy = 1),
                (SELECT COUNT(*) FROM media WHERE error IS NOT NULL)",
            [],
            |row| {
                Ok(LibraryStats {
                    folders: row.get(0)?,
                    images: row.get(1)?,
                    videos: row.get(2)?,
                    classified: row.get(3)?,
                    pending: row.get(4)?,
                    sexy: row.get(5)?,
                    failed: row.get(6)?,
                })
            },
        )
        .map_err(Into::into)
    }
}

/// An FTS5 MATCH expression for text a person typed.
///
/// Everything is quoted, so `(` `"` `*` and `-` are searched for rather than
/// parsed as query syntax — typing `(wide hips:1.3)` should find that text, not
/// raise "fts5: syntax error near". Terms are ANDed, so word order does not
/// matter but every word must appear.
///
/// Returns `None` for input the trigram tokenizer cannot answer: it indexes
/// three-character sequences, so nothing shorter than three characters can be
/// looked up.
fn fts_expression(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split_whitespace()
        .filter(|term| term.chars().count() >= 3)
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect();
    if terms.is_empty() {
        return None;
    }
    Some(terms.join(" AND "))
}

/// Bumping this rebuilds the search index once, on the next launch. Change it
/// whenever the tokenizer or the indexed columns change, or an existing library
/// keeps an index that no longer matches the queries run against it.
const FTS_VERSION: &str = "1-trigram-name-prompt";

const MEDIA_COLUMNS: &str = "id, folder_id, path, name, kind, width, height, size_bytes, \
                             modified_at, added_at, thumb_path, thumb_width, thumb_height, \
                             duration_sec, verdict_json, classified_at, stars,                              generation_json, dupe_group";

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
        stars: row.get(16)?,
        generation: row
            .get::<_, Option<String>>(17)?
            .and_then(|json| serde_json::from_str(&json).ok()),
        dupe_group: row.get(18)?,
    })
}

fn truncate(input: &str, max: usize) -> String {
    if input.len() <= max {
        return input.to_string();
    }
    // Respect char boundaries — an error message can contain a non-ASCII path.
    let end = input
        .char_indices()
        .map(|(index, _)| index)
        .take_while(|index| *index <= max)
        .last()
        .unwrap_or(0);
    format!("{}…", &input[..end])
}

/// The portion of a path that survives the tree being moved.
///
/// A Stable Diffusion Image Browser database records absolute paths from
/// whenever the image was made:
///
/// ```text
/// D:\Development\__big_stable-diffusion-webui\outputs\txt2img-images\2023-05-08\00043-2571709213.png
/// ```
///
/// By the time anything imports it, that tree has usually been archived to
/// another drive and often renamed on the way. What does *not* change is
/// everything from `outputs` onwards — that is the webui's own layout, so it
/// travels with the files. Measured against two real databases, keying on this
/// matched 2,204 of 2,204 surviving ratings in one and every survivor in the
/// other, where matching on the recorded install directory matched none.
///
/// `None` for a path with no `outputs` segment, which is every file that did
/// not come out of a webui.
pub fn outputs_match_key(path: &str) -> Option<String> {
    let normalised = path.replace('/', "\\");
    let lower = normalised.to_lowercase();
    let at = lower
        .split('\\')
        .position(|segment| segment == "outputs")?;
    Some(
        lower
            .split('\\')
            .skip(at)
            .collect::<Vec<_>>()
            .join("\\"),
    )
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
    /// What derived files for this row are addressed by. `None` until the
    /// measure phase reaches it, or when its two windows could not be read.
    pub content_key: Option<String>,
}

/// Which phase's queue a count refers to. See [`Db::completed_in_phase`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PhaseQueue {
    Dimensions,
    Thumbnails,
    Classification,
    /// Only SFW rows are ever queued for it, so "completed" counts the rows
    /// that were eligible and are done — not the whole library.
    AnimeReview,
    Labels,
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
            tag: None,
            min_stars: None,
            duplicates_only: false,
            hide_tags: Vec::new(),
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
    fn fts_expressions_are_quoted_so_prompt_punctuation_is_searchable() {
        // `(wide hips:1.3)` is text someone will paste in from a prompt. Left
        // unquoted, FTS5 parses the parentheses and the colon as query syntax
        // and raises "fts5: syntax error near", which reaches the UI as a red
        // toast for a perfectly reasonable search.
        assert_eq!(
            fts_expression("(wide hips:1.3)").as_deref(),
            Some(r#""(wide" AND "hips:1.3)""#)
        );
        // A quote in the input must not end the quoted term.
        assert_eq!(fts_expression(r#"say "hi""#).as_deref(), Some(r#""say" AND """hi""""#));
    }

    #[test]
    fn fts_expressions_drop_terms_the_trigram_index_cannot_answer() {
        // Trigram indexes three-character sequences, so a shorter term matches
        // nothing at all — silently returning zero results for `a girl` would
        // be worse than searching for `girl`.
        assert_eq!(fts_expression("a girl").as_deref(), Some(r#""girl""#));
        assert_eq!(fts_expression("of"), None);
        assert_eq!(fts_expression("   "), None);
    }

    /// How many rows the grid's search finds for `text`.
    fn found(db: &Db, text: &str) -> i64 {
        let mut q = query();
        q.search = text.to_string();
        db.query_media(&q).unwrap().total
    }

    /// One row whose name and prompt are both searchable.
    fn with_prompt(prompt: &str) -> (Db, i64) {
        let db = Db::open_in_memory().expect("in-memory index");
        let folder = db.add_folder("/media", 1).expect("add folder");
        db.insert_media_batch(
            folder,
            &[file("/media/00166-3997412987.png", MediaKind::Image, 1)],
            1,
        )
        .expect("insert");
        let id = db.query_media(&query()).unwrap().items[0].id;
        db.set_generation(
            id,
            Some(&crate::generated::Generation {
                tool: "Stable Diffusion".into(),
                prompt: Some(prompt.to_string()),
                ..Default::default()
            }),
        )
        .expect("set generation");
        (db, id)
    }

    #[test]
    fn searching_finds_a_filename_and_a_prompt_alike() {
        let (db, _) = with_prompt("official art, moona hoshinova, 1girl");

        assert_eq!(found(&db, "00166"), 1, "by filename");
        assert_eq!(found(&db, "hoshinova"), 1, "by prompt");
        // A substring *inside* a token, which a word tokenizer would miss:
        // `1girl` is one word, and this is why the index is trigram.
        assert_eq!(found(&db, "girl"), 1, "inside a token");
        // Terms are ANDed, so word order does not matter but all must appear.
        assert_eq!(found(&db, "hoshinova moona"), 1);
        assert_eq!(found(&db, "hoshinova beach"), 0);
        // Punctuation from a real prompt must not be parsed as query syntax.
        assert_eq!(found(&db, "(wide hips:1.3)"), 0);
    }

    #[test]
    fn a_library_that_predates_the_search_index_gets_one_built() {
        // The case every existing install is in, and the one the in-memory
        // tests cannot reach: rows already present when the FTS table is
        // created. They never pass through the triggers, so without a backfill
        // the index is empty and every search returns nothing.
        //
        // This failed once because the "is it built" check counted rows —
        // and on an external-content table `count(*)` is answered from the
        // *content* table, so an empty index reports the full library.
        let path = std::env::temp_dir().join(format!("luma-fts-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);

        {
            let db = Db::open(&path).unwrap();
            let folder = db.add_folder("/media", 1).unwrap();
            db.insert_media_batch(folder, &[file("/media/moona.png", MediaKind::Image, 1)], 1)
                .unwrap();
        }

        // Put it in the state an upgrading install starts from: rows present,
        // index absent.
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "DROP TABLE media_fts; DELETE FROM settings WHERE key = 'fts_version';",
            )
            .unwrap();
        }

        let db = Db::open(&path).unwrap();
        let mut query = query();
        query.search = "moona".to_string();
        assert_eq!(
            db.query_media(&query).unwrap().total,
            1,
            "an index built after the rows exist must still find them"
        );

        drop(db);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn the_search_index_follows_a_row_that_changes() {
        // An external-content FTS table is only as correct as its triggers.
        let (db, id) = with_prompt("a castle at dusk");
        assert_eq!(found(&db, "castle"), 1);

        // Re-parsed with a different prompt: the old text must stop matching.
        db.set_generation(
            id,
            Some(&crate::generated::Generation {
                tool: "Stable Diffusion".into(),
                prompt: Some("a harbour at dawn".into()),
                ..Default::default()
            }),
        )
        .unwrap();
        assert_eq!(found(&db, "castle"), 0);
        assert_eq!(found(&db, "harbour"), 1);

        db.delete_media_by_path("/media/00166-3997412987.png").unwrap();
        assert_eq!(found(&db, "harbour"), 0);
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
        db.mark_failed(target, "unreadable", 7).unwrap();

        let after = db.stats().unwrap();
        assert_eq!((after.classified, after.pending), (1, 2));
        assert_eq!(after.failed, 1);
    }

    /// The regression test for the bug that spun the first real scan at 40% CPU
    /// for 44 minutes without finishing.
    ///
    /// `thumbnail_phase` loops on `pending_thumbnails` until it comes back
    /// empty. The original failure path set only `classified_at`, leaving
    /// `thumb_path` NULL — so an unreadable file was returned by the very next
    /// call and the phase retried it forever, never reaching classification.
    ///
    /// To watch this fail, change `mark_failed` to set only `classified_at`.
    #[test]
    fn a_file_that_fails_thumbnailing_leaves_the_thumbnail_queue() {
        let (db, _) = seeded();
        let doomed = db.pending_thumbnails(100).unwrap();
        assert_eq!(doomed.len(), 3);

        for file in &doomed {
            db.mark_failed(file.id, "cannot decode image", 1).unwrap();
        }

        assert!(
            db.pending_thumbnails(100).unwrap().is_empty(),
            "a failed file must not come back, or the thumbnail phase never terminates"
        );
        assert!(
            db.pending_classification(100).unwrap().is_empty(),
            "a file with no thumbnail must not reach the classifier either"
        );
    }

    #[test]
    fn draining_the_thumbnail_queue_terminates_when_every_file_fails() {
        let (db, _) = seeded();

        // The exact shape of the phase loop: drain a page at a time until empty.
        let mut rounds = 0;
        loop {
            let batch = db.pending_thumbnails(2).unwrap();
            if batch.is_empty() {
                break;
            }
            rounds += 1;
            assert!(rounds < 10, "the thumbnail queue is not draining");
            for file in batch {
                db.mark_failed(file.id, "boom", 1).unwrap();
            }
        }
        assert_eq!(rounds, 2, "3 files at 2 per page is two rounds");
    }

    #[test]
    fn failures_record_their_reason_and_can_be_retried() {
        let (db, folder) = seeded();
        let target = db.pending_thumbnails(1).unwrap()[0].id;
        db.mark_failed(target, "cannot decode image", 1).unwrap();
        assert_eq!(db.stats().unwrap().failed, 1);

        let cleared = db.clear_errors(Some(folder)).unwrap();
        assert_eq!(cleared, 1);
        assert_eq!(db.stats().unwrap().failed, 0);
        assert_eq!(
            db.pending_thumbnails(100).unwrap().len(),
            3,
            "clearing an error must put the file back in the queue"
        );
    }

    #[test]
    fn a_long_error_message_is_truncated_on_a_char_boundary() {
        let (db, _) = seeded();
        let target = db.pending_thumbnails(1).unwrap()[0].id;
        // Multi-byte, so a naive byte slice would panic.
        let message = "ü".repeat(500);
        db.mark_failed(target, &message, 1).unwrap();
        assert_eq!(db.stats().unwrap().failed, 1);
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
    fn pending_queues_hand_out_images_before_videos() {
        let (db, folder) = seeded();
        // A video newer than every image — mtime order alone would put it first.
        db.insert_media_batch(
            folder,
            &[file("/media/newest.mp4", MediaKind::Video, 9_999)],
            1,
        )
        .unwrap();

        let queue = db.pending_thumbnails(100).unwrap();
        let kinds: Vec<_> = queue.iter().map(|f| f.kind).collect();
        let first_video = kinds.iter().position(|k| *k == MediaKind::Video).unwrap();
        let last_image = kinds.iter().rposition(|k| *k == MediaKind::Image).unwrap();
        assert!(
            last_image < first_video,
            "videos must queue behind every image: one video costs ~25 ffmpeg \
             seeks and would otherwise starve tens of thousands of images"
        );
    }

    #[test]
    fn a_rule_change_can_be_replayed_from_stored_detections() {
        // What makes a threshold change cost seconds instead of an hour: the
        // rows that kept their detections can be re-rated without the model.
        use crate::types::{Detection, FrameVerdict};

        let (db, _) = seeded();
        assert_eq!(db.rating_version().unwrap(), 0, "a fresh index predates any rules");
        assert!(db.rows_with_frames().unwrap().is_empty());

        let target = db.query_media(&query()).unwrap().items[0].id;
        db.replace_frames(
            target,
            &[NewFrame {
                frame_index: 0,
                timestamp_sec: 0.0,
                path: "/thumbs/a.jpg".into(),
                verdict_json: serde_json::to_string(&FrameVerdict {
                    person: true,
                    sexy: false,
                    nude: false,
                    rating: Rating::Sfw,
                    top_label: None,
                    top_label_title: None,
                    top_score: 0.0,
                    // The exact case from the reported file: a covered label
                    // that the old 0.5 bar discarded by five thousandths.
                    detections: vec![Detection {
                        label: "FEMALE_GENITALIA_COVERED".into(),
                        score: 0.495,
                        box_: [0.3, 0.5, 0.1, 0.2],
                    }],
                })
                .unwrap(),
            }],
        )
        .unwrap();

        let replayable = db.rows_with_frames().unwrap();
        assert_eq!(replayable.len(), 1, "only rows that kept their detections");
        assert_eq!(replayable[0].id, target);

        // Replaying through the real rules, not a copy of them.
        let frames = db.frames_for_media(target).unwrap();
        let rated = crate::rating::rate_frame(
            &frames[0].verdict.detections,
            crate::rating::ClassifyOptions::default(),
        );
        assert_eq!(
            rated.rating,
            Rating::Suggestive,
            "0.495 clears the 0.4 suggestive bar it used to miss"
        );

        db.set_rating_version(crate::rating::RATING_VERSION).unwrap();
        assert_eq!(db.rating_version().unwrap(), crate::rating::RATING_VERSION);
    }

    #[test]
    fn an_image_keeps_the_boxes_its_rollup_throws_away() {
        // Why images get a frame row at all. The rolled-up `MediaVerdict` says
        // *what* was found but not *where* — it has no `detections` field — so
        // storing only the rollup left the lightbox with nothing to draw and
        // "Show boxes" inert across every image in a library.
        use crate::types::{Detection, FrameVerdict};

        let (db, _) = seeded();
        let target = db.query_media(&query()).unwrap().items[0].id;

        let frame = FrameVerdict {
            person: true,
            sexy: true,
            nude: false,
            rating: Rating::Suggestive,
            top_label: Some("FEMALE_BREAST_COVERED".into()),
            top_label_title: Some("Covered chest".into()),
            top_score: 0.87,
            detections: vec![Detection {
                label: "FEMALE_BREAST_COVERED".into(),
                score: 0.87,
                box_: [0.41, 0.08, 0.11, 0.14],
            }],
        };

        db.replace_frames(
            target,
            &[NewFrame {
                frame_index: 0,
                timestamp_sec: 0.0,
                path: "/thumbs/ab/cd/x.jpg".into(),
                verdict_json: serde_json::to_string(&frame).unwrap(),
            }],
        )
        .unwrap();

        let frames = db.frames_for_media(target).unwrap();
        assert_eq!(frames.len(), 1, "an image gets exactly one frame row");
        let boxes = &frames[0].verdict.detections;
        assert_eq!(boxes.len(), 1, "the detection must survive the round trip");
        assert_eq!(boxes[0].box_, [0.41, 0.08, 0.11, 0.14]);
        assert_eq!(boxes[0].label, "FEMALE_BREAST_COVERED");

        // And the rollup still has no idea where anything is — which is the
        // whole reason the frame row has to exist.
        let rolled = crate::rating::from_single_frame(&frame);
        let json = serde_json::to_value(&rolled).unwrap();
        assert!(
            json.get("detections").is_none(),
            "a MediaVerdict carries no boxes; only the frame does"
        );
    }

    #[test]
    fn a_resumed_scan_counts_what_the_library_already_has() {
        // The bug this pins: `done` restarted at zero every launch while
        // `total` shrank to whatever was outstanding, so reopening a nearly
        // finished library showed "0 / 2" and read as though every thumbnail
        // had been thrown away. Nothing was lost — the display just refused to
        // say so.
        let (db, _) = seeded();
        assert_eq!(db.completed_in_phase(PhaseQueue::Thumbnails).unwrap(), 0);

        let target = db.query_media(&query()).unwrap().items[0].id;
        db.update_thumbnail(
            target,
            &ThumbnailUpdate {
                thumb_path: "/thumbs/a.jpg".into(),
                thumb_width: 512,
                thumb_height: 384,
                width: 4000,
                height: 3000,
                duration_sec: None,
            },
        )
        .unwrap();

        let already = db.completed_in_phase(PhaseQueue::Thumbnails).unwrap();
        let outstanding = db.pending_thumbnails(i64::MAX).unwrap().len() as i64;
        assert_eq!(already, 1);
        assert_eq!(
            already + outstanding,
            3,
            "the denominator must stay the whole library, not the remainder"
        );
    }

    #[test]
    fn dimensions_are_queued_separately_and_cleared_without_a_thumbnail() {
        // The measure phase exists so tiles have a size before they have a
        // picture; a row it has filled must leave its queue while still
        // awaiting a thumbnail.
        let (db, _) = seeded();
        assert_eq!(db.pending_dimensions(i64::MAX).unwrap().len(), 3);

        let target = db.query_media(&query()).unwrap().items[0].id;
        db.update_dimensions(target, 4000, 3000, None, Some("deadbeef")).unwrap();

        assert_eq!(db.pending_dimensions(i64::MAX).unwrap().len(), 2);
        assert_eq!(
            db.pending_thumbnails(i64::MAX).unwrap().len(),
            3,
            "measuring a row must not remove it from the thumbnail queue"
        );
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

    #[test]
    fn tags_can_both_narrow_and_exclude() {
        let (db, _) = seeded();
        let ids: Vec<i64> = db
            .query_media(&query())
            .unwrap()
            .items
            .iter()
            .map(|item| item.id)
            .collect();

        assert_eq!(db.pending_labels(100).unwrap().len(), 3);
        db.set_tags(ids[0], &["document".to_string()], 5).unwrap();
        db.set_tags(ids[1], &["generated".to_string()], 5).unwrap();
        db.set_tags(ids[2], &[], 5).unwrap();
        assert!(db.pending_labels(100).unwrap().is_empty(), "all three examined");

        let only_docs = MediaQuery { tag: Some("document".into()), ..query() };
        let page = db.query_media(&only_docs).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].id, ids[0]);

        // The case this feature exists for: everything except the scans.
        let no_docs = MediaQuery { hide_tags: vec!["document".into()], ..query() };
        let page = db.query_media(&no_docs).unwrap();
        assert_eq!(page.total, 2);
        assert!(page.items.iter().all(|item| item.id != ids[0]));

        // Untagged rows survive every exclusion — absence of a tag is not a tag.
        let neither = MediaQuery {
            hide_tags: vec!["document".into(), "generated".into()],
            ..query()
        };
        let page = db.query_media(&neither).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].id, ids[2]);

        // Re-labelling replaces rather than accumulates, so a corrected rule
        // fixes a row instead of leaving it in both buckets.
        db.set_tags(ids[0], &["generated".to_string()], 6).unwrap();
        assert_eq!(db.query_media(&only_docs).unwrap().total, 0);
        assert_eq!(
            db.query_media(&MediaQuery { tag: Some("generated".into()), ..query() })
                .unwrap()
                .total,
            2
        );
    }

    #[test]
    fn only_sfw_rows_queue_for_the_anime_tagger() {
        // The economics of the second pass. It is the most expensive model in
        // the app and can only ever *raise* a rating, so every row it looks at
        // that is already flagged is pure waste. This is the query that decides
        // whether the phase costs 70% of the library or all of it.
        let (db, _) = seeded();
        let ids: Vec<i64> = db
            .query_media(&query())
            .unwrap()
            .items
            .iter()
            .map(|item| item.id)
            .collect();

        for (index, id) in ids.iter().enumerate() {
            db.update_thumbnail(
                *id,
                &ThumbnailUpdate {
                    thumb_path: format!("/thumbs/{index}.jpg"),
                    thumb_width: 320,
                    thumb_height: 240,
                    width: 1600,
                    height: 1200,
                    duration_sec: None,
                },
            )
            .unwrap();
        }

        // Nothing is classified yet, so nothing is eligible: the tagger refines
        // a verdict, it does not produce the first one.
        assert!(db.pending_anime(100).unwrap().is_empty());

        let verdict = |rating: Rating| MediaVerdict {
            person: true,
            sexy: rating != Rating::Sfw,
            nude: rating == Rating::Explicit,
            rating,
            top_label: None,
            top_label_title: None,
            top_score: 0.0,
            frame_count: 1,
            sexy_frame_count: 0,
            poster_frame_index: Some(0),
        };
        db.update_verdict(ids[0], &verdict(Rating::Sfw), 10).unwrap();
        db.update_verdict(ids[1], &verdict(Rating::Suggestive), 10).unwrap();
        db.update_verdict(ids[2], &verdict(Rating::Explicit), 10).unwrap();

        let queued = db.pending_anime(100).unwrap();
        assert_eq!(queued.len(), 1, "only the SFW row is worth a second opinion");
        assert_eq!(queued[0].id, ids[0]);

        // A scan is SFW and stays SFW. Running a Danbooru tagger over a payslip
        // is the most expensive model in the app answering a question nobody
        // asked, so a document leaves the queue without being looked at.
        db.set_tags(ids[0], &["document".to_string()], 15).unwrap();
        assert!(
            db.pending_anime(100).unwrap().is_empty(),
            "a document is not worth a second opinion either"
        );
        assert_eq!(
            db.completed_in_phase(PhaseQueue::AnimeReview).unwrap(),
            0,
            "and it is not counted as finished — it was never in this phase"
        );
        db.set_tags(ids[0], &[], 16).unwrap();
        assert_eq!(db.pending_anime(100).unwrap().len(), 1, "untagged, it returns");

        // Stamped even when the tagger concludes nothing, or the row would come
        // back on every launch forever.
        db.mark_anime_done(ids[0], 20).unwrap();
        assert!(db.pending_anime(100).unwrap().is_empty());
        assert_eq!(db.completed_in_phase(PhaseQueue::AnimeReview).unwrap(), 1);
    }
}
