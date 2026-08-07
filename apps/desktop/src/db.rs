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

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::generated::Generation;
use crate::pipeline::now_ms;
use crate::types::{
    DeviantArtPost, Folder, LibraryStats, MediaFrame, MediaItem, MediaKind, MediaPage, MediaQuery,
    MediaVerdict, Rating, SortOrder,
};

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    /// The index connection, taken even if a previous holder panicked.
    ///
    /// `Mutex::lock` returns `Err` **forever** once any thread has panicked
    /// while holding it, so unwrapping that turns one failure into a permanent
    /// one — every later call panics too, whatever it was going to do.
    ///
    /// On the LAN server that is fatal and completely silent. Its eight worker
    /// threads take a request each, panic on the poisoned lock, and unwind out
    /// of their accept loop one at a time until none are left. The listener
    /// stays bound — `Running` still holds it — so the other machine's
    /// connections are still accepted, and then nothing ever answers them. The
    /// grid over there simply stops updating, with no error anywhere.
    ///
    /// Recovering is sound *here* specifically, and not as a general habit: the
    /// guarded value is a SQLite connection, an unfinished transaction rolls
    /// itself back when its guard drops, and this whole index is a rebuildable
    /// cache of the filesystem rather than anything anyone would mourn. A
    /// poisoned connection is still a connection.
    fn connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

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
        // `mut` for the one backfill below that needs a transaction: 155,000
        // single-statement updates in autocommit would each be their own fsync.
        let mut conn = self.connection();

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

            -- Characters a generated image depicts, detected from its prompt.
            -- Its own table rather than rows in media_tags: those are
            -- structural ("document", "generated") and feed the hide filters,
            -- and a character in that pipeline would become hideable-by-tag in
            -- ways nothing intends.
            CREATE TABLE IF NOT EXISTS media_characters (
                media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
                name     TEXT    NOT NULL,
                PRIMARY KEY (media_id, name)
            );
            CREATE INDEX IF NOT EXISTS characters_by_name ON media_characters(name, media_id);

            -- Every label the detector found, not merely the one that won.
            --
            -- `media.verdict_json` keeps a single `topLabel`, chosen by rating
            -- weight — so a picture showing three things records one, and six
            -- labels can never appear there at all because they carry no weight
            -- and cannot win: FACE_FEMALE is on 85,000 images and was
            -- unfilterable. The detections themselves were never lost, only
            -- unindexed; they sit in `media_frames.verdict_json`, one frame row
            -- per image and several per video.
            --
            -- Derived from those rows rather than from the model again. The
            -- score is the best that label scored on any frame, so a video is
            -- described by its strongest moment the way its verdict is.
            CREATE TABLE IF NOT EXISTS media_labels (
                media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
                label    TEXT    NOT NULL,
                score    REAL    NOT NULL,
                PRIMARY KEY (media_id, label)
            );
            CREATE INDEX IF NOT EXISTS labels_by_label ON media_labels(label, score);

            /* What has already gone to DeviantArt.
             *
             * Keyed on the **path**, not on `media.id`, and with no foreign key
             * to cascade. A media row's id does not survive the index being
             * rebuilt — which is a thing that happens deliberately here — and
             * losing this would silently un-post pictures that are demonstrably
             * public, sending someone to upload them a second time. The path
             * survives a rebuild of the same tree; it does not survive the
             * files being moved, which is the trade, and the far rarer half. */
            CREATE TABLE IF NOT EXISTS deviantart_posts (
                path         TEXT PRIMARY KEY,
                item_id      INTEGER,
                deviation_id TEXT,
                url          TEXT,
                /* Staged in Sta.sh but not posted is a real state, and the one
                 * the badge has to distinguish — it means "go finish this". */
                published    INTEGER NOT NULL DEFAULT 0,
                posted_at    INTEGER NOT NULL
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

        // The picture an upscaled variant came from, derived from its filename
        // at insert. Backfilled below rather than left to the next scan: the
        // grid hides a superseded original, and a library that already holds
        // variants would otherwise keep showing both until every folder had
        // been walked again.
        let has_upscaled_from = conn
            .prepare("PRAGMA table_info(media)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "upscaled_from");
        if !has_upscaled_from {
            conn.execute_batch("ALTER TABLE media ADD COLUMN upscaled_from TEXT")?;
        }
        // The index the "is this one superseded" check runs against, once per
        // queried row. Partial, because almost no row is a variant.
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS media_upscaled_from ON media(upscaled_from)
             WHERE upscaled_from IS NOT NULL",
        )?;
        if !has_upscaled_from {
            Self::backfill_upscaled_from(&conn)?;
        }

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
            // How far this picture is from monochrome: the mean per-cell gap
            // between the strongest and weakest channel of `colour_sig`, 0-255.
            // Derived from bytes already stored, so it costs no decoding. A
            // measure rather than a flag, because where black-and-white ends is
            // a query-time question and a stored boolean would freeze it.
            ("chroma", "REAL"),
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

        // The folder a file sits in, so the search index can hold it as a
        // column of its own — see `fts_expression`.
        //
        // Generated rather than written at insert: `name` is always the tail of
        // `path`, so a stored copy would be a third spelling of a fact already
        // recorded twice, and one more thing every writer of `path` would have
        // to remember. VIRTUAL because `ALTER TABLE` cannot add a STORED
        // generated column, and because nothing reads this except the index.
        //
        // Checked with `table_xinfo`, **not** `table_info`. The latter lists
        // only columns whose hidden flag is zero and a generated column's is
        // two, so this is never found, the ALTER runs on every launch, and the
        // second one fails with "duplicate column name" — taking every
        // migration below it down with it.
        let has_dir = conn
            .prepare("PRAGMA table_xinfo(media)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "dir");
        if !has_dir {
            conn.execute_batch(
                "ALTER TABLE media ADD COLUMN dir TEXT
                 GENERATED ALWAYS AS (substr(path, 1, length(path) - length(name))) VIRTUAL",
            )?;
        }

        // Full-text search over filenames, prompts and folder paths.
        //
        // **Trigram, not the default tokenizer.** The default indexes whole
        // words, and a booru prompt is full of `1girl`, `2girls`,
        // `moona_hoshinova` — searching "girl" against it finds 9,517 rows
        // where a substring search finds 45,966. Trigram gives `LIKE '%x%'`
        // semantics, which is what someone typing into a search box means.
        //
        // Measured on this library, 160,901 rows: `LIKE` needs 183-230ms for a
        // count, which is far too slow to type against. Trigram answers the
        // same queries in 0-7ms and builds once in 2.4s. The folder search is
        // in here for that reason and no other — `path LIKE '%moona%'` is the
        // obvious implementation and it is the slow one.
        //
        // Three columns, and every query names which of them it means. A bare
        // MATCH searches all three, which would silently fold folder names into
        // the ordinary search the moment `dir` was added.
        //
        // `content='media'` so the text is not stored twice; the triggers below
        // are what an external-content table requires to stay in step.
        //
        // Read the version before the table is created, because on an upgrade
        // it decides whether the existing one is thrown away.
        let built: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = 'fts_version'", [], |row| row.get(0))
            .optional()?;
        let stale = built.as_deref() != Some(FTS_VERSION);
        if stale {
            // `IF NOT EXISTS` cannot add a column to an index that already
            // exists, and the triggers are `IF NOT EXISTS` too — so an upgraded
            // library would keep a two-column index, keep writing two columns
            // into it, and answer every folder search with nothing. Both go;
            // the rebuild below refills the new shape.
            conn.execute_batch(
                "DROP TRIGGER IF EXISTS media_fts_insert;
                 DROP TRIGGER IF EXISTS media_fts_delete;
                 DROP TRIGGER IF EXISTS media_fts_update;
                 DROP TABLE IF EXISTS media_fts;",
            )?;
        }
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS media_fts USING fts5(
                 name, prompt, dir, content='media', content_rowid='id', tokenize='trigram'
             )",
        )?;
        conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS media_fts_insert AFTER INSERT ON media BEGIN
                 INSERT INTO media_fts(rowid, name, prompt, dir)
                 VALUES (new.id, new.name, new.prompt, new.dir);
             END;
             CREATE TRIGGER IF NOT EXISTS media_fts_delete AFTER DELETE ON media BEGIN
                 INSERT INTO media_fts(media_fts, rowid, name, prompt, dir)
                 VALUES ('delete', old.id, old.name, old.prompt, old.dir);
             END;
             CREATE TRIGGER IF NOT EXISTS media_fts_update AFTER UPDATE ON media BEGIN
                 INSERT INTO media_fts(media_fts, rowid, name, prompt, dir)
                 VALUES ('delete', old.id, old.name, old.prompt, old.dir);
                 INSERT INTO media_fts(rowid, name, prompt, dir)
                 VALUES (new.id, new.name, new.prompt, new.dir);
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
        if stale {
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

        // Last, because it reads `settings` and rewrites `media`: every table
        // has to exist by the time it runs.
        //
        // Variants indexed under an older rule keep whatever the rule was then.
        // The inheritance at insert cannot reach them — that deliberately skips
        // a row which already has a thumbnail — so they are repaired once here.
        //
        // Dates, so they sit beside the picture they replace rather than at the
        // front of a newest-first grid. And the judgements: a variant left
        // unrated while its original was a favourite disappears entirely under
        // the favourites filter, hidden by its own existence on one side and
        // filtered out on the other.
        //
        // `COALESCE(m.x, ...)` rather than a plain assignment: a rating given to
        // the variant *since* it was indexed is newer than the original's and
        // must not be overwritten by a repair.
        let repaired: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'variant_inheritance'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if repaired.as_deref() != Some(VARIANT_INHERITANCE_VERSION) {
            conn.execute(
                "UPDATE media AS m
                    SET modified_at = (SELECT o.modified_at FROM media o WHERE o.path = m.upscaled_from),
                        added_at = (SELECT o.added_at FROM media o WHERE o.path = m.upscaled_from),
                        stars = COALESCE(
                            m.stars,
                            (SELECT o.stars FROM media o WHERE o.path = m.upscaled_from)
                        ),
                        verdict_json = COALESCE(
                            m.verdict_json,
                            (SELECT o.verdict_json FROM media o WHERE o.path = m.upscaled_from)
                        ),
                        classified_at = COALESCE(
                            m.classified_at,
                            (SELECT o.classified_at FROM media o WHERE o.path = m.upscaled_from)
                        ),
                        generation_json = COALESCE(
                            m.generation_json,
                            (SELECT o.generation_json FROM media o WHERE o.path = m.upscaled_from)
                        ),
                        prompt = COALESCE(
                            m.prompt,
                            (SELECT o.prompt FROM media o WHERE o.path = m.upscaled_from)
                        )
                  WHERE m.upscaled_from IS NOT NULL
                    AND EXISTS (SELECT 1 FROM media o WHERE o.path = m.upscaled_from)",
                [],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO media_characters (media_id, name)
                 SELECT m.id, c.name FROM media m
                 JOIN media o ON o.path = m.upscaled_from
                 JOIN media_characters c ON c.media_id = o.id
                 WHERE m.upscaled_from IS NOT NULL",
                [],
            )?;
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('variant_inheritance', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![VARIANT_INHERITANCE_VERSION],
            )?;
        }

        // Characters for rows labelled before detection existed. New prompts
        // get theirs in `set_generation`; the library already scanned would
        // otherwise stay uncounted forever, since a rescan deliberately leaves
        // existing rows alone. Versioned so a rule change (a new exclusion, a
        // fixed parser) can re-run it once — bump the version to invalidate.
        let detected: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'character_detection'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if detected.as_deref() != Some(CHARACTER_DETECTION_VERSION) {
            conn.execute("DELETE FROM media_characters", [])?;
            {
                let mut read = conn.prepare(
                    "SELECT id, prompt FROM media WHERE prompt IS NOT NULL AND prompt != ''",
                )?;
                let mut write = conn.prepare(
                    "INSERT OR IGNORE INTO media_characters (media_id, name) VALUES (?1, ?2)",
                )?;
                let rows: Vec<(i64, String)> = read
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<rusqlite::Result<_>>()?;
                for (id, prompt) in rows {
                    for name in crate::generated::characters_of(&prompt) {
                        write.execute(params![id, name])?;
                    }
                }
            }
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('character_detection', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![CHARACTER_DETECTION_VERSION],
            )?;
        }

        // Chroma for every row that already has a colour signature.
        //
        // Rust rather than SQL because SQLite cannot reduce a blob, but still
        // no file is opened: the 8x8 signature was written during the same pass
        // as the perceptual hash, so this reads 192 bytes a row out of the
        // database and writes a number back.
        let chroma_done: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'chroma_index'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if chroma_done.as_deref() != Some(CHROMA_INDEX_VERSION) {
            let pending: Vec<(i64, Vec<u8>)> = conn
                .prepare("SELECT id, colour_sig FROM media WHERE colour_sig IS NOT NULL")?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .filter_map(Result::ok)
                .collect();
            let tx = conn.transaction()?;
            {
                let mut stmt = tx.prepare("UPDATE media SET chroma = ?2 WHERE id = ?1")?;
                for (id, signature) in &pending {
                    stmt.execute(params![id, crate::dupes::chroma(signature)])?;
                }
            }
            tx.commit()?;
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('chroma_index', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![CHROMA_INDEX_VERSION],
            )?;
        }

        // Labels for everything classified before the table existed.
        //
        // Pure SQL over `media_frames`: the detections have been written on
        // every classified row all along, so this is an index being built, not
        // a model being re-run. 155,000 images and 660,000 detections, no GPU
        // and no file touched — the alternative reading of "we never stored
        // them" would have cost hours of classification for data already here.
        let labels_done: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'label_index'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if labels_done.as_deref() != Some(LABEL_INDEX_VERSION) {
            conn.execute(
                "INSERT OR REPLACE INTO media_labels (media_id, label, score)
                 SELECT f.media_id,
                        json_extract(d.value, '$.label'),
                        MAX(json_extract(d.value, '$.score'))
                   FROM media_frames f,
                        json_each(json_extract(f.verdict_json, '$.detections')) d
                  WHERE json_extract(d.value, '$.score') >= ?1
                  GROUP BY f.media_id, json_extract(d.value, '$.label')",
                params![LABEL_STORE_FLOOR],
            )?;
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('label_index', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![LABEL_INDEX_VERSION],
            )?;
        }

        // The `postprocessed` flag for rows labelled before it existed. A
        // rescan deliberately leaves existing rows alone, so without this the
        // extras filter finds nothing in a library scanned last week — which
        // is exactly what happened. Pure SQL, because the old parser stored
        // the postprocess line AS the prompt (an extras block has no settings
        // line to anchor on), so the prompt itself carries the evidence the
        // parser would otherwise re-read from the file.
        let extras_done: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'extras_detection'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if extras_done.as_deref() != Some(EXTRAS_DETECTION_VERSION) {
            conn.execute(
                "UPDATE media
                 SET generation_json =
                     json_set(generation_json, '$.postprocessed', json('true'))
                 WHERE generation_json IS NOT NULL
                   AND (prompt LIKE '%Postprocess upscale%'
                        OR prompt LIKE '%Postprocess upscaler%')",
                [],
            )?;
            // The metadata-less era: the folder is the signal, and a file
            // with no block at all gets a minimal one to hang the flag on.
            // LIKE is case-insensitive for ASCII, which suits Windows paths.
            for segment in ["\\extras\\", "/extras/", "\\extras-images\\", "/extras-images/"] {
                let pattern = format!("%{segment}%");
                conn.execute(
                    "UPDATE media
                     SET generation_json = CASE
                         WHEN generation_json IS NULL
                             THEN '{\"tool\":\"Stable Diffusion\",\"postprocessed\":true}'
                         ELSE json_set(generation_json, '$.postprocessed', json('true'))
                     END
                     WHERE path LIKE ?1",
                    params![pattern],
                )?;
            }
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('extras_detection', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![EXTRAS_DETECTION_VERSION],
            )?;
        }

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Folders
    // -----------------------------------------------------------------------

    pub fn add_folder(&self, path: &str, now: i64) -> Result<i64> {
        let conn = self.connection();
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
        let conn = self.connection();
        // ON DELETE CASCADE clears media and frames. Generated thumbnails are
        // left behind deliberately: they are content-addressed, so re-adding
        // the same folder reuses them instead of regenerating thousands of
        // files. `vacuum_thumbnails` sweeps orphans on demand.
        conn.execute("DELETE FROM folders WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn list_folders(&self) -> Result<Vec<Folder>> {
        let conn = self.connection();
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
        let conn = self.connection();
        let mut stmt = conn.prepare("SELECT path FROM folders")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(PathBuf::from)
            .collect())
    }

    pub fn mark_scanned(&self, folder_id: i64, now: i64) -> Result<()> {
        let conn = self.connection();
        conn.execute(
            "UPDATE folders SET last_scan_at = ?2 WHERE id = ?1",
            params![folder_id, now],
        )?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Media
    // -----------------------------------------------------------------------

    /// Name the original for every variant already indexed.
    ///
    /// Runs once, when the column is added. Everything after that is handled at
    /// insert, so this is a migration rather than a phase.
    fn backfill_upscaled_from(conn: &Connection) -> Result<()> {
        let rows: Vec<(i64, String)> = {
            let mut stmt = conn.prepare(&format!(
                "SELECT id, path FROM media WHERE path LIKE '%{}%'",
                crate::upscales::UPSCALE_SUFFIX
            ))?;
            let found = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            found.collect::<rusqlite::Result<Vec<_>>>()?
        };

        let mut stmt = conn.prepare("UPDATE media SET upscaled_from = ?2 WHERE id = ?1")?;
        for (id, path) in rows {
            // The LIKE above is a coarse prefilter; `original_of` is the rule,
            // and it rejects a name that merely contains the suffix.
            if let Some(original) = crate::upscales::original_of(&path) {
                stmt.execute(params![id, original])?;
            }
        }
        Ok(())
    }

    /// Insert newly-seen files in one transaction, returning how many were new.
    ///
    /// Existing rows are left completely alone rather than updated: a file whose
    /// mtime changed is handled by the watcher, and re-touching every row on
    /// every rescan would blow away thumbnails and verdicts for an entire
    /// library because someone's backup tool rewrote the timestamps.
    pub fn insert_media_batch(&self, folder_id: i64, entries: &[ScannedFile], now: i64) -> Result<usize> {
        let mut conn = self.connection();
        let tx = conn.transaction()?;
        let mut inserted = 0_usize;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO media
                     (folder_id, path, name, kind, size_bytes, modified_at, added_at, upscaled_from)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
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
                    // Derived from the name, so the pair is established the
                    // moment the variant is seen — the original may not even be
                    // indexed yet, and does not need to be.
                    crate::upscales::original_of(&entry.path),
                ])?;
            }
        }

        // A variant takes the thumbnail its original already has.
        //
        // It is the same picture — that is the entire premise of the pairing —
        // so generating a second one would decode a 12MB, 2627x3840 file off a
        // network share to arrive at an image already sitting on local disk.
        // Inheriting also closes the window where the variant is indexed but
        // not yet drawable, which is what made three pictures vanish out of the
        // grid: it is showable the moment it is inserted.
        //
        // The content key comes with it, and has to. Derived files are addressed
        // by key and deleted when no row claims them any more, so a variant
        // pointing at a thumbnail it does not claim would lose its picture the
        // moment the original was deleted.
        //
        // Both dates come with it too. A variant that stands in for a picture
        // has to stand where that picture stood: written today, it would
        // otherwise jump to the front of a newest-first grid and drag itself out
        // of the run of images it belongs to, so upscaling a handful quietly
        // reshuffles the library. `added_at` for the same reason under
        // "Recently added".
        //
        // And every judgement made about the picture, because they are about
        // the picture rather than the file.
        //
        // Stars are the one that bites hardest. A variant inserted without them
        // is unrated while its original was a favourite — so with the
        // favourites filter on, the original is hidden *because the variant
        // exists* and the variant is filtered out *because it has no stars*,
        // and a picture someone deliberately marked disappears from the library
        // entirely.
        //
        // The verdict comes too, and is provably the same answer: the
        // classifier reads the thumbnail, and the variant shares the original's
        // thumbnail. Re-running it would spend a NudeNet pass and an anime
        // tagger pass to arrive at the identical result.
        //
        // Dimensions are deliberately *not* inherited: the variant's own size is
        // the whole point of it, and it earns a 4K badge the original cannot.
        tx.execute(
            "UPDATE media AS m
                SET thumb_path = (SELECT o.thumb_path FROM media o WHERE o.path = m.upscaled_from),
                    thumb_width = (SELECT o.thumb_width FROM media o WHERE o.path = m.upscaled_from),
                    thumb_height = (SELECT o.thumb_height FROM media o WHERE o.path = m.upscaled_from),
                    content_key = (SELECT o.content_key FROM media o WHERE o.path = m.upscaled_from),
                    modified_at = (SELECT o.modified_at FROM media o WHERE o.path = m.upscaled_from),
                    added_at = (SELECT o.added_at FROM media o WHERE o.path = m.upscaled_from),
                    stars = (SELECT o.stars FROM media o WHERE o.path = m.upscaled_from),
                    verdict_json = (SELECT o.verdict_json FROM media o WHERE o.path = m.upscaled_from),
                    classified_at = (SELECT o.classified_at FROM media o WHERE o.path = m.upscaled_from),
                    generation_json = (SELECT o.generation_json FROM media o WHERE o.path = m.upscaled_from),
                    prompt = (SELECT o.prompt FROM media o WHERE o.path = m.upscaled_from)
              WHERE m.upscaled_from IS NOT NULL
                AND m.thumb_path IS NULL
                AND EXISTS (
                    SELECT 1 FROM media o
                     WHERE o.path = m.upscaled_from AND o.thumb_path IS NOT NULL
                )",
            [],
        )?;

        // The characters ride with the prompt: the variant stands in for its
        // original in the grid, so it has to answer the same leaderboard and
        // the same click-through search the original answered.
        tx.execute(
            "INSERT OR IGNORE INTO media_characters (media_id, name)
             SELECT m.id, c.name FROM media m
             JOIN media o ON o.path = m.upscaled_from
             JOIN media_characters c ON c.media_id = o.id
             WHERE m.upscaled_from IS NOT NULL",
            [],
        )?;

        tx.commit()?;
        Ok(inserted)
    }

    /// Rows in a folder whose file no longer exists, so the watcher can drop them.
    pub fn delete_media_by_path(&self, path: &str) -> Result<()> {
        let conn = self.connection();
        conn.execute("DELETE FROM media WHERE path = ?1", params![path])?;
        Ok(())
    }

    /// Images with a thumbnail but no perceptual hash yet.
    ///
    /// Images only: a video's duplicates are found by its content key, which
    /// the scan already computed, so hashing poster frames would be work with
    /// no question behind it.
    pub fn pending_hashes(&self, limit: i64) -> Result<Vec<PendingFile>> {
        let conn = self.connection();
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
        let conn = self.connection();
        conn.execute(
            // Chroma alongside them rather than in a pass of its own: it is a
            // reduction of the signature being written on this very line, so
            // computing it anywhere else would mean reading the blob back.
            "UPDATE media SET phash = ?2, colour_sig = ?3, chroma = ?4 WHERE id = ?1",
            params![id, hash as i64, colour, crate::dupes::chroma(colour)],
        )?;
        Ok(())
    }

    pub fn all_fingerprints(&self) -> Result<Vec<(i64, u64, Vec<u8>)>> {
        let conn = self.connection();
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
        let conn = self.connection();
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
        let mut conn = self.connection();
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
        let conn = self.connection();
        let mut stmt =
            conn.prepare("SELECT path FROM excluded_folders ORDER BY added_at DESC")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn add_excluded_folder(&self, path: &str, now: i64) -> Result<()> {
        let conn = self.connection();
        conn.execute(
            "INSERT INTO excluded_folders (path, added_at) VALUES (?1, ?2)
             ON CONFLICT(path) DO NOTHING",
            params![path, now],
        )?;
        Ok(())
    }

    pub fn remove_excluded_folder(&self, path: &str) -> Result<()> {
        let conn = self.connection();
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
        let mut conn = self.connection();
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

    /// Drop every row whose path `should_drop` rejects.
    ///
    /// For rules that are *about the path*, applied to an index that already
    /// exists. Adding a directory name to the walk's ignore list only stops
    /// future walks; everything indexed under that name before it was added
    /// stays until something prunes it, and a rescan will not — the scan's own
    /// pruning is a set difference against what the walk returned, and a walk
    /// that now skips a directory reports nothing about it either way.
    ///
    /// The predicate is passed in rather than expressed in SQL so the rule
    /// lives in exactly one place: whatever the walk skips is what this drops,
    /// and the two cannot drift into disagreeing.
    ///
    /// One table scan of `path`, which is the price of asking a question no
    /// index can answer. Rows are filtered as they stream, so only the matches
    /// are ever held in memory — on a clean library that is none of them.
    pub fn prune_media_where<F>(&self, should_drop: F) -> Result<Pruned>
    where
        F: Fn(&str) -> bool,
    {
        let mut conn = self.connection();
        let tx = conn.transaction()?;

        let doomed: Vec<(String, Option<String>)> = {
            let mut stmt = tx.prepare("SELECT path, content_key FROM media")?;
            let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            let mut doomed = Vec::new();
            for row in rows {
                let (path, key): (String, Option<String>) = row?;
                if should_drop(&path) {
                    doomed.push((path, key));
                }
            }
            doomed
        };

        {
            let mut stmt = tx.prepare("DELETE FROM media WHERE path = ?1")?;
            for (path, _) in &doomed {
                stmt.execute(params![path])?;
            }
        }
        tx.commit()?;

        // Keys, not rows: derived files are addressed by content, so the same
        // thumbnail can belong to a copy of the file that is still indexed
        // elsewhere. The caller decides which are orphaned now that the rows
        // are gone.
        let mut keys: Vec<String> = doomed.iter().filter_map(|(_, key)| key.clone()).collect();
        keys.sort();
        keys.dedup();

        Ok(Pruned {
            rows: doomed.len(),
            keys,
        })
    }

    /// Whether any row still uses this content key. See [`Db::delete_media_under`].
    pub fn content_key_is_orphaned(&self, key: &str) -> Result<bool> {
        let conn = self.connection();
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM media WHERE content_key = ?1",
            params![key],
            |row| row.get::<_, i64>(0),
        )? == 0)
    }

    pub fn media_paths_in_folder(&self, folder_id: i64) -> Result<Vec<String>> {
        let conn = self.connection();
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
        let conn = self.connection();
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
        let conn = self.connection();
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
        let conn = self.connection();
        Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?)
    }

    pub fn set_rating_version(&self, version: i64) -> Result<()> {
        let conn = self.connection();
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
        let conn = self.connection();
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
        let conn = self.connection();
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
        let conn = self.connection();
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
        let conn = self.connection();
        Ok(conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.connection();
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
        let conn = self.connection();

        // The Extras era wrote no distinguishing metadata — old A1111 copied
        // the ORIGINAL's block into the upscale — so the path is the signal.
        // Applied here, at the one funnel, so scans and rescans agree with
        // the backfill; a file in an extras folder is postprocessed whatever
        // its copied block claims, and one with no block at all still gets a
        // minimal generation to hang the flag on.
        let path: String =
            conn.query_row("SELECT path FROM media WHERE id = ?1", params![id], |row| row.get(0))?;
        let from_extras = crate::generated::extras_path(&path);
        let mut owned;
        let generation = match (generation, from_extras) {
            (Some(found), true) if !found.postprocessed => {
                owned = found.clone();
                owned.postprocessed = true;
                Some(&owned)
            }
            (None, true) => {
                owned = Generation {
                    tool: "Stable Diffusion".to_string(),
                    postprocessed: true,
                    ..Default::default()
                };
                Some(&owned)
            }
            (found, _) => found,
        };

        let json = match generation {
            Some(generation) => Some(serde_json::to_string(generation)?),
            None => None,
        };
        conn.execute(
            "UPDATE media SET generation_json = ?2, prompt = ?3 WHERE id = ?1",
            params![id, json, generation.and_then(|g| g.prompt.clone())],
        )?;

        // Characters ride along with the prompt: this is the one funnel every
        // prompt passes through, so detection can live nowhere else and still
        // cover scans, rescans and retries alike. Replace-then-insert, so a
        // relabel of a file whose prompt changed does not accumulate the old
        // cast.
        conn.execute("DELETE FROM media_characters WHERE media_id = ?1", params![id])?;
        if let Some(prompt) = generation.and_then(|g| g.prompt.as_deref()) {
            let mut stmt = conn.prepare(
                "INSERT OR IGNORE INTO media_characters (media_id, name) VALUES (?1, ?2)",
            )?;
            for name in crate::generated::characters_of(prompt) {
                stmt.execute(params![id, name])?;
            }
        }
        Ok(())
    }

    /// The most-depicted characters across the current library, biggest first.
    ///
    /// Grid semantics, not raw rows: a picture hidden behind its upscaled
    /// variant must not count twice, or every upscaled character doubles.
    pub fn top_characters(
        &self,
        query: &MediaQuery,
        limit: i64,
    ) -> Result<Vec<crate::types::CharacterCount>> {
        let conn = self.connection();
        // The same predicates the grid runs, range included -- the leaderboard
        // describes what is on screen, and a filter added to one and not the
        // other breaks that silently. Same argument as the timeline, except
        // this one *does* honour the date range: narrowing to a fortnight
        // should rank that fortnight's cast.
        let (where_parts, binds) = Self::media_filter(query, true);
        let sql = format!(
            "SELECT c.name, COUNT(*) AS n FROM media_characters c
             JOIN media ON media.id = c.media_id
             WHERE {} GROUP BY c.name ORDER BY n DESC, c.name ASC LIMIT ?{}",
            where_parts.join(" AND "),
            binds.len() + 1
        );
        let mut refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
        refs.push(&limit);
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(refs.as_slice(), |row| {
            Ok(crate::types::CharacterCount { name: row.get(0)?, count: row.get(1)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
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
        let conn = self.connection();
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
        let conn = self.connection();
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
        let conn = self.connection();
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
        let mut conn = self.connection();
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
        let conn = self.connection();
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
        let conn = self.connection();
        conn.execute(
            "UPDATE media SET stars = ?2 WHERE id = ?1",
            params![id, stars.filter(|s| (1..=5).contains(s))],
        )?;
        Ok(())
    }

    /// Rate many rows at once. Returns how many actually changed.
    ///
    /// One transaction rather than a call per id: a selection can be hundreds,
    /// and the same reasoning that made `delete_media` a batch applies — that
    /// many round trips is slow, and a partial failure halfway through is
    /// impossible to report on sensibly. Here it is also atomic, so a rating
    /// applied to a selection either lands on all of it or on none.
    pub fn set_stars_many(&self, ids: &[i64], stars: Option<i64>) -> Result<usize> {
        let mut conn = self.connection();
        let value = stars.filter(|s| (1..=5).contains(s));
        let tx = conn.transaction()?;
        let mut changed = 0;
        {
            let mut stmt = tx.prepare("UPDATE media SET stars = ?2 WHERE id = ?1")?;
            for id in ids {
                changed += stmt.execute(params![id, value])?;
            }
        }
        tx.commit()?;
        Ok(changed)
    }

    /// Rows that have never been examined for structural tags.
    ///
    /// Unlike the classification queue this does not require a verdict: a
    /// document is a document whether or not anything has rated it, and the
    /// generator metadata sits in the file itself.
    pub fn pending_labels(&self, limit: i64) -> Result<Vec<PendingFile>> {
        let conn = self.connection();
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
        let mut conn = self.connection();
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
        let conn = self.connection();
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
        let conn = self.connection();
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
        let conn = self.connection();
        conn.execute(
            // `COALESCE(content_key, ?5)`, not the other way round: the key
            // already on the row wins.
            //
            // For an ordinary row this is identical — the key is NULL until
            // something measures it. It matters for an upscaled variant, which
            // inherits its original's key at insert *because it shares its
            // original's thumbnail file*. Letting the measure phase replace
            // that with a hash of the variant's own bytes leaves it pointing at
            // derived data it no longer claims, and deleting the original then
            // takes the variant's picture with it.
            //
            // A file whose contents change never reaches this with a stale key:
            // the watcher drops the row and re-inserts it.
            "UPDATE media SET width = ?2, height = ?3,
                 duration_sec = COALESCE(?4, duration_sec),
                 content_key = COALESCE(content_key, ?5)
             WHERE id = ?1",
            params![id, width, height, duration_sec, content_key],
        )?;
        Ok(())
    }

    /// The content key recorded for a path, if the measure phase reached it.
    pub fn content_key_for_path(&self, path: &str) -> Result<Option<String>> {
        let conn = self.connection();
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
        let conn = self.connection();
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM media WHERE content_key = ?1",
            params![key],
            |row| row.get(0),
        )?)
    }

    /// Swap a video's provisional poster for the frame the rollup chose.
    pub fn update_poster(&self, id: i64, thumb_path: &str) -> Result<()> {
        let conn = self.connection();
        conn.execute(
            "UPDATE media SET thumb_path = ?2 WHERE id = ?1",
            params![id, thumb_path],
        )?;
        Ok(())
    }

    pub fn update_thumbnail(&self, id: i64, update: &ThumbnailUpdate) -> Result<()> {
        let conn = self.connection();
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
        let conn = self.connection();
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
        let conn = self.connection();
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
        let mut conn = self.connection();
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
        // Rebuilt here rather than by the pipeline, because this is the one
        // place frames are ever written: a row that is re-classified cannot
        // then disagree with its own labels, and nothing has to remember to
        // call a second function.
        rebuild_labels(&tx, media_id, frames.iter().map(|frame| frame.verdict_json.as_str()))?;
        tx.commit()?;
        Ok(())
    }

    /// Every label a row's frames carry, best score first.
    ///
    /// The detail panel's answer to "what else is in this picture" — the
    /// verdict names one label, and this is the rest of what was found.
    pub fn labels_for_media(&self, media_id: i64) -> Result<Vec<(String, f64)>> {
        let conn = self.connection();
        let mut stmt = conn.prepare(
            "SELECT label, score FROM media_labels WHERE media_id = ?1 ORDER BY score DESC",
        )?;
        let rows = stmt
            .query_map(params![media_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn frames_for_media(&self, media_id: i64) -> Result<Vec<MediaFrame>> {
        let conn = self.connection();
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

    /// One row by its exact stored path.
    ///
    /// For reaching a picture the grid is deliberately not showing — the
    /// original behind an upscaled variant, which no list contains and so no
    /// id is to hand for.
    pub fn media_by_path(&self, path: &str) -> Result<Option<MediaItem>> {
        let conn = self.connection();
        let item = conn
            .query_row(
                &format!("SELECT {MEDIA_COLUMNS} FROM media WHERE path = ?1"),
                params![path],
                map_media_row,
            )
            .optional()?;
        Ok(item)
    }

    pub fn media_by_id(&self, id: i64) -> Result<Option<MediaItem>> {
        let conn = self.connection();
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
    // DeviantArt
    // -----------------------------------------------------------------------

    /// Record that a picture has gone to DeviantArt.
    ///
    /// Upsert rather than insert: uploading the same picture again is a thing
    /// people do — a better crop, a retitle — and the second attempt's result
    /// is the one worth keeping. Publishing a previously-staged item therefore
    /// upgrades the row rather than colliding with it.
    pub fn record_deviantart_post(
        &self,
        path: &str,
        item_id: Option<i64>,
        deviation_id: Option<&str>,
        url: Option<&str>,
        published: bool,
    ) -> Result<()> {
        let conn = self.connection();
        conn.execute(
            "INSERT INTO deviantart_posts (path, item_id, deviation_id, url, published, posted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(path) DO UPDATE SET
                 item_id      = COALESCE(excluded.item_id, item_id),
                 deviation_id = COALESCE(excluded.deviation_id, deviation_id),
                 url          = COALESCE(excluded.url, url),
                 -- Never demote. A row that is public stays public even if a
                 -- later staging of the same file reports otherwise.
                 published    = MAX(published, excluded.published),
                 posted_at    = excluded.posted_at",
            params![
                path,
                item_id,
                deviation_id,
                url,
                i64::from(published),
                now_ms()
            ],
        )?;
        Ok(())
    }

    /// Mark or unmark rows by hand.
    ///
    /// The escape hatch for everything this app did not do itself: pictures
    /// posted before it could record them, posted from the website, or recorded
    /// wrongly. Marking by hand knows the picture is up but not where, so the
    /// url stays null and the badge has no link — which is honest.
    pub fn set_deviantart_posted(&self, ids: &[i64], posted: bool) -> Result<usize> {
        let mut conn = self.connection();
        let transaction = conn.transaction()?;
        let mut changed = 0;
        for id in ids {
            let path: Option<String> = transaction
                .query_row("SELECT path FROM media WHERE id = ?1", params![id], |row| {
                    row.get(0)
                })
                .optional()?;
            let Some(path) = path else { continue };
            changed += if posted {
                transaction.execute(
                    "INSERT INTO deviantart_posts (path, published, posted_at)
                     VALUES (?1, 1, ?2)
                     ON CONFLICT(path) DO UPDATE SET published = 1",
                    params![path, now_ms()],
                )?
            } else {
                transaction.execute(
                    "DELETE FROM deviantart_posts WHERE path = ?1",
                    params![path],
                )?
            };
        }
        transaction.commit()?;
        Ok(changed)
    }

    // -----------------------------------------------------------------------
    // Query
    // -----------------------------------------------------------------------

    /// The WHERE clause a query implies, shared by the grid and the timeline.
    ///
    /// One builder rather than two, because the timeline's whole claim is
    /// "these bars describe the grid you are looking at" — a predicate added to
    /// one and forgotten in the other breaks that silently.
    ///
    /// `include_range` is the one deliberate divergence: the histogram must
    /// ignore `modified_after`/`modified_before` or selecting a range would
    /// collapse the timeline to only the bars inside it, and there would be no
    /// way to see — or grab — anything outside the current selection.
    fn media_filter(
        query: &MediaQuery,
        include_range: bool,
    ) -> (Vec<String>, Vec<Box<dyn rusqlite::ToSql>>) {
        let mut where_parts: Vec<String> = Vec::new();
        let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        // A picture that has been upscaled is represented by its variant, not by
        // both. Unconditional rather than a filter: two rows of the same picture
        // at different resolutions is not a view anyone wants, and the original
        // stays reachable from the variant's own footer.
        //
        // **Only once the variant has a thumbnail.** A variant is indexed the
        // moment it is written — the watcher sees the file immediately — but it
        // cannot be *drawn* until the pipeline has thumbnailed it, and a tile
        // with no thumbnail renders as empty space. Hiding on the row alone
        // therefore takes the original away before its replacement can stand in,
        // and the picture simply vanishes from the grid for as long as the
        // thumbnail queue takes to reach it. Standing in is the whole claim, so
        // it has to be true before it is acted on.
        //
        // Correlated, but against a partial index over the handful of rows that
        // are variants at all, so it costs a lookup per candidate row.
        where_parts.push(
            "NOT EXISTS (SELECT 1 FROM media v \
             WHERE v.upscaled_from = media.path AND v.thumb_path IS NOT NULL)"
                .to_string(),
        );

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
            //
            // Which columns is the whole of the folder-search mode: the same
            // term, the same index, aimed at the directory instead. Nothing
            // else about the query changes, so a folder search still composes
            // with the rating pills and the timeline the way any other does.
            let columns = if query.search_paths { PATH_COLUMNS } else { TEXT_COLUMNS };
            match fts_expression(query.search.trim(), columns) {
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
        if query.unstarred {
            // `stars` is NULL until somebody rates a row, and `0` is not used —
            // clearing a rating writes NULL back. So this is the triage queue:
            // everything nobody has judged yet.
            where_parts.push("stars IS NULL".to_string());
        }
        match query.has_prompt {
            // Empty counts as absent: `set_generation` writes the prompt
            // column from an Option, but an A1111 block with a blank prompt
            // stores an empty string, and "has a prompt" promises words.
            Some(true) => where_parts.push("(prompt IS NOT NULL AND prompt != '')".to_string()),
            Some(false) => where_parts.push("(prompt IS NULL OR prompt = '')".to_string()),
            None => {}
        }
        match query.extras {
            Some(true) => where_parts.push(
                "json_extract(generation_json, '$.postprocessed') = 1".to_string(),
            ),
            Some(false) => where_parts.push(
                "(generation_json IS NULL OR json_extract(generation_json, '$.postprocessed') IS NOT 1)"
                    .to_string(),
            ),
            None => {}
        }
        match query.img2img {
            // Through JSON1 rather than a LIKE over the blob: the field name
            // could legitimately appear inside a prompt's text, and
            // `json_extract` reads the claim where it actually lives.
            Some(true) => where_parts.push(
                "json_extract(generation_json, '$.needsSourceImage') = 1".to_string(),
            ),
            Some(false) => where_parts.push(
                "(generation_json IS NULL OR json_extract(generation_json, '$.needsSourceImage') IS NOT 1)"
                    .to_string(),
            ),
            None => {}
        }
        if let Some(label) = query.label.as_deref().filter(|label| !label.is_empty()) {
            where_parts.push(format!(
                "EXISTS (SELECT 1 FROM media_labels l
                          WHERE l.media_id = media.id AND l.label = ?{} AND l.score >= ?{})",
                binds.len() + 1,
                binds.len() + 2,
            ));
            binds.push(Box::new(label.to_string()));
            binds.push(Box::new(LABEL_MIN_SCORE));
        }
        if let Some(animated) = query.animated {
            // Built from one list so the two directions cannot drift apart, and
            // matching `isAnimatedImage` in `@luma/core` — the UI badges what
            // this filters.
            let clauses: Vec<String> = ANIMATED_EXTENSIONS
                .iter()
                .map(|extension| format!("lower(media.name) LIKE '%{extension}'"))
                .collect();
            let any = clauses.join(" OR ");
            where_parts.push(if animated {
                format!("({any})")
            } else {
                // A video is not an animated *image*, so it is left to the kind
                // filter: "no GIFs" and "no videos" are two questions, and
                // answering both here would make the second unaskable.
                format!("NOT ({any})")
            });
        }
        if let Some(greyscale) = query.greyscale {
            // An unmeasured row cannot support either claim, so NULL is
            // excluded from both — the same reading as the 4K filter below.
            where_parts.push(format!(
                "media.chroma IS NOT NULL AND media.chroma {} ?{}",
                if greyscale { "<=" } else { ">" },
                binds.len() + 1,
            ));
            binds.push(Box::new(MAX_GREYSCALE_CHROMA));
        }
        if let Some(min) = query.min_longest_edge {
            // A row the measure phase has not reached yet has no dimensions, so
            // `MAX` is NULL and the comparison excludes it — which is right.
            // "At least 4K" is a claim, and an unmeasured row cannot support it.
            where_parts.push(format!("MAX(width, height) >= ?{}", binds.len() + 1));
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

        if include_range {
            // Half-open, so two adjacent weeks share a boundary without
            // double-counting the file sitting exactly on it.
            if let Some(after) = query.modified_after {
                where_parts.push(format!("modified_at >= ?{}", binds.len() + 1));
                binds.push(Box::new(after));
            }
            if let Some(before) = query.modified_before {
                where_parts.push(format!("modified_at < ?{}", binds.len() + 1));
                binds.push(Box::new(before));
            }
        }

        (where_parts, binds)
    }

    pub fn query_media(&self, query: &MediaQuery) -> Result<MediaPage> {
        let conn = self.connection();

        let (where_parts, binds) = Self::media_filter(query, true);
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

    /// How many rows the current filters match, per week.
    ///
    /// Applies every predicate the grid does **except** the date range — the
    /// bars have to keep showing the whole span while a selection narrows the
    /// grid, or there would be nothing outside the selection left to grab.
    ///
    /// Weeks start Monday 00:00 UTC. `modified_at` is unix ms, so the epoch
    /// shift aligns the integer division to Monday: day 0 of the epoch —
    /// Thursday, 1 January 1970 — belongs to the week that began Monday,
    /// 29 December 1969, three days earlier, so shifting by 3 days makes the
    /// division land its boundaries on Mondays. (Pinned by a test against
    /// 2024-07-01, a known Monday: 4 puts every boundary on Sunday.) UTC rather
    /// than local time, deliberately — a fixed arithmetic is stable across DST
    /// changes and machines, and being an hour "off" at a bar boundary is
    /// invisible at a week's width.
    ///
    /// Empty weeks are not returned; the frontend rebuilds gaps from the range.
    pub fn media_timeline(&self, query: &MediaQuery) -> Result<Vec<crate::types::TimelineBucket>> {
        const WEEK_MS: i64 = 7 * 24 * 60 * 60 * 1000;
        const EPOCH_TO_MONDAY_MS: i64 = 3 * 24 * 60 * 60 * 1000;

        let conn = self.connection();
        let (mut where_parts, binds) = Self::media_filter(query, false);
        // A file with no sensible mtime — 0 is what a broken copy tool writes —
        // would otherwise put a 1970 bar on the axis and flatten five decades
        // of real bars into hairlines.
        where_parts.push("modified_at > 0".to_string());

        let sql = format!(
            "SELECT ((modified_at + {EPOCH_TO_MONDAY_MS}) / {WEEK_MS}) AS week, COUNT(*)
             FROM media WHERE {} GROUP BY week ORDER BY week",
            where_parts.join(" AND ")
        );
        let bind_refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(bind_refs.as_slice(), |row| {
            let week: i64 = row.get(0)?;
            Ok(crate::types::TimelineBucket {
                start: week * WEEK_MS - EPOCH_TO_MONDAY_MS,
                count: row.get(1)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The picture an Extras-tab upscale was made from, when it can be found.
    ///
    /// The Extras block names no source file, so the link is *perceptual*:
    /// an upscale and its original are the same picture at two sizes, which
    /// is exactly what the duplicate grouping already detects. Within the
    /// group, the original is the member that is not itself postprocessed —
    /// preferring one whose prompt survived, then the smallest, since the
    /// source of an upscale is by definition the smaller file.
    ///
    /// `None` when the row has no dupe group yet — Find Duplicates has not
    /// run since it was indexed — which the caller reports as "unlinked", not
    /// as an error.
    /// What an img2img was made from, as far back as the trail leads.
    ///
    /// The rule, its thresholds and the measurements behind them live in
    /// [`crate::origin`]. This is the I/O half: which rows are candidates, and
    /// where their colour signatures come from.
    pub fn source_origin(&self, id: i64) -> Result<Option<(MediaItem, crate::origin::Origin)>> {
        let origin = {
            let conn = self.connection();

            // Only what the walk compares on. The colour signatures stay out:
            // 155,000 of them is 30MB of blob to answer a question about a
            // handful of rows, and this runs every time a picture is opened.
            let mut stmt = conn.prepare(
                "SELECT id, phash, modified_at,
                        COALESCE(json_extract(generation_json, '$.needsSourceImage'), 0)
                 FROM media
                 WHERE phash IS NOT NULL AND colour_sig IS NOT NULL AND error IS NULL",
            )?;
            let rows: Vec<crate::origin::Candidate> = stmt
                .query_map([], |row| {
                    Ok(crate::origin::Candidate {
                        id: row.get(0)?,
                        // Stored signed because SQLite has no unsigned integer.
                        // The bits are the hash either way.
                        phash: row.get::<_, i64>(1)? as u64,
                        modified_at: row.get(2)?,
                        img2img: row.get::<_, i64>(3)? == 1,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;

            let mut signature = conn.prepare("SELECT colour_sig FROM media WHERE id = ?1")?;
            // Cached because a walk asks about the same row on consecutive
            // hops, and because the row it is standing on is asked for twice.
            let mut cache: HashMap<i64, Option<Vec<u8>>> = HashMap::new();
            let mut colour_of = |want: i64| -> Option<Vec<u8>> {
                if let Some(hit) = cache.get(&want) {
                    return hit.clone();
                }
                let got = signature
                    .query_row(params![want], |row| row.get::<_, Option<Vec<u8>>>(0))
                    .optional()
                    .ok()
                    .flatten()
                    .flatten();
                cache.insert(want, got.clone());
                got
            };

            crate::origin::walk(&rows, id, &mut colour_of)
        };

        let Some(origin) = origin else {
            return Ok(None);
        };
        // The lock is released above: `media_by_id` takes it again, and the
        // mutex is not reentrant.
        Ok(self.media_by_id(origin.id)?.map(|item| (item, origin)))
    }

    pub fn extras_original(&self, id: i64) -> Result<Option<MediaItem>> {
        let Some(row) = self.media_by_id(id)? else { return Ok(None) };

        // Filename first: A1111's extras output commonly keeps the original's
        // filename, sometimes behind a `00000-` counter prefix — so the link
        // is often sitting in the name, needing no duplicate scan at all.
        let mut candidates: Vec<String> = vec![row.name.clone()];
        if let Some((prefix, rest)) = row.name.split_once('-') {
            if !rest.is_empty() && prefix.chars().all(|c| c.is_ascii_digit()) {
                candidates.push(rest.to_string());
            }
        }
        {
            let conn = self.connection();
            for name in &candidates {
                let sql = format!(
                    "SELECT {MEDIA_COLUMNS} FROM media
                     WHERE name = ?1 AND id != ?2
                       AND (generation_json IS NULL
                            OR json_extract(generation_json, '$.postprocessed') IS NOT 1)
                     ORDER BY (prompt IS NOT NULL AND prompt != '') DESC, width * height ASC
                     LIMIT 1"
                );
                let mut stmt = conn.prepare(&sql)?;
                let found = stmt
                    .query_map(params![name, id], map_media_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                if let Some(item) = found.into_iter().next() {
                    return Ok(Some(item));
                }
            }
        }

        // Perceptual fallback: an upscale and its original are the same
        // picture at two sizes, which the duplicate grouping detects — for
        // extras whose filename kept nothing of the source.
        let Some(group) = row.dupe_group else { return Ok(None) };
        let conn = self.connection();
        let sql = format!(
            "SELECT {MEDIA_COLUMNS} FROM media
             WHERE dupe_group = ?1 AND id != ?2
               AND (generation_json IS NULL
                    OR json_extract(generation_json, '$.postprocessed') IS NOT 1)
             ORDER BY (prompt IS NOT NULL AND prompt != '') DESC, width * height ASC
             LIMIT 1"
        );
        let mut stmt = conn.prepare(&sql)?;
        let found = stmt
            .query_map(params![group, id], map_media_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(found.into_iter().next())
    }

    /// Newest files across every folder — the strip pinned above the grid once
    /// a scan finishes.
    pub fn recent_media(&self, limit: i64) -> Result<Vec<MediaItem>> {
        let conn = self.connection();
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
        let conn = self.connection();
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

/// What the search box means by default: the filename and the prompt.
///
/// Named explicitly rather than left to a bare MATCH, which searches every
/// column there is. `dir` is a column now, so "every column" and "what this
/// field promises" are no longer the same set.
const TEXT_COLUMNS: &str = "{name prompt}";

/// The folder-search mode: the directory, without the filename on the end of
/// it. See [`crate::types::MediaQuery::search_paths`] for why it replaces the
/// default rather than adding to it.
const PATH_COLUMNS: &str = "{dir}";

/// An FTS5 MATCH expression for text a person typed, restricted to `columns`.
///
/// Everything is quoted, so `(` `"` `*` and `-` are searched for rather than
/// parsed as query syntax — typing `(wide hips:1.3)` should find that text, not
/// raise "fts5: syntax error near". Terms are ANDed, so word order does not
/// matter but every word must appear.
///
/// The column filter wraps the whole conjunction rather than each term, because
/// FTS5 applies a bare `{cols} : x AND y` to `x` only — which would leave the
/// second word of a two-word folder search matching filenames and prompts as
/// well, and the mode leaking exactly where a search is most specific.
///
/// Returns `None` for input the trigram tokenizer cannot answer: it indexes
/// three-character sequences, so nothing shorter than three characters can be
/// looked up.
fn fts_expression(input: &str, columns: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split_whitespace()
        .filter(|term| term.chars().count() >= 3)
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect();
    if terms.is_empty() {
        return None;
    }
    Some(format!("{columns} : ({})", terms.join(" AND ")))
}

/// Bumping this rebuilds the search index once, on the next launch. Change it
/// whenever the tokenizer or the indexed columns change, or an existing library
/// keeps an index that no longer matches the queries run against it.
/// The floor under which a detection is the model saying "not this".
///
/// The detector's own NMS already drops anything below 0.25, so this is not
/// about box noise — it is where a label stops being a claim about the picture
/// worth indexing. Kept low deliberately: what counts as *present enough* to
/// filter on is a query-time question ([`LABEL_MIN_SCORE`]), and baking a high
/// floor in here would mean a re-backfill every time that answer changed.
const LABEL_STORE_FLOOR: f64 = 0.25;

/// How confident a detection must be for the filter to call the label present.
///
/// Measured on this library: at 0.5, 63.7% of images carry at least one label,
/// against 70.4% at the storage floor — the difference is largely the detector
/// listing what it considered and rejected.
pub const LABEL_MIN_SCORE: f64 = 0.5;

/// Replace one row's labels from the verdicts of its frames.
///
/// A video is described by its strongest moment, the same way its verdict is:
/// the score kept per label is the best that label reached on any frame.
fn rebuild_labels<'a>(
    tx: &rusqlite::Transaction<'_>,
    media_id: i64,
    verdicts: impl Iterator<Item = &'a str>,
) -> Result<()> {
    let mut best: HashMap<String, f64> = HashMap::new();
    for verdict in verdicts {
        // A frame whose verdict will not parse is a row, not an exception —
        // it costs this one row its labels and nothing else.
        let Ok(parsed) = serde_json::from_str::<crate::types::FrameVerdict>(verdict) else {
            continue;
        };
        for detection in parsed.detections {
            if detection.score < LABEL_STORE_FLOOR {
                continue;
            }
            let slot = best.entry(detection.label).or_insert(detection.score);
            if detection.score > *slot {
                *slot = detection.score;
            }
        }
    }

    tx.execute("DELETE FROM media_labels WHERE media_id = ?1", params![media_id])?;
    let mut stmt = tx.prepare(
        "INSERT OR REPLACE INTO media_labels (media_id, label, score) VALUES (?1, ?2, ?3)",
    )?;
    for (label, score) in best {
        stmt.execute(params![media_id, label, score])?;
    }
    Ok(())
}

const FTS_VERSION: &str = "2-trigram-name-prompt-dir";

/// Bump when what an upscaled variant inherits from its original changes.
///
/// Rows indexed under an older rule are repaired once on the next launch.
/// Without it, only variants created *after* the change behave correctly and the
/// grid is inconsistent in a way nothing on screen explains.
const VARIANT_INHERITANCE_VERSION: &str = "3-searchable-identity";

/// Bump to re-run character detection over every stored prompt on next open.
const CHARACTER_DETECTION_VERSION: &str = "4-dictionary";

/// Bump to re-mark Extras-tab upscales across every stored row on next open.
const EXTRAS_DETECTION_VERSION: &str = "2-by-path";

/// Bumping this rebuilds `media_labels` from the frames on next launch.
const LABEL_INDEX_VERSION: &str = "1-from-frames";

/// Bumping this recomputes `media.chroma` from the stored signatures.
const CHROMA_INDEX_VERSION: &str = "1-mean-channel-spread";

/// How little colour a picture may carry and still be black and white.
///
/// Measured, not chosen: the median picture in this library scores 29.7 and the
/// 90th percentile 58.3, while 6.5% sit at or under 3. Monochrome is a tight
/// cluster with a wide empty gap above it, which is what makes the exact value
/// unimportant — 1 and 5 select 5.3% and 7.6% of the same population.
const MAX_GREYSCALE_CHROMA: f64 = 3.0;

/// The image containers that can hold an animation.
///
/// Mirrors `isAnimatedImage` in `@luma/core`. A *static* WebP is caught by this
/// too: the name is all there is short of decoding every file, and a filter
/// that opens 155,000 images to answer is not a filter.
const ANIMATED_EXTENSIONS: [&str; 3] = [".gif", ".webp", ".avif"];

const MEDIA_COLUMNS: &str = "id, folder_id, path, name, kind, width, height, size_bytes, \
                             modified_at, added_at, thumb_path, thumb_width, thumb_height, \
                             duration_sec, verdict_json, classified_at, stars, generation_json, dupe_group, \n                             upscaled_from, \n                             (SELECT v.path FROM media v WHERE v.upscaled_from = media.path LIMIT 1) \n                             AS upscaled_to, \n                             (SELECT p.url FROM deviantart_posts p WHERE p.path = media.path) \n                             AS deviantart_url, \n                             (SELECT p.published FROM deviantart_posts p WHERE p.path = media.path) \n                             AS deviantart_published, \n                             (SELECT p.posted_at FROM deviantart_posts p WHERE p.path = media.path) \n                             AS deviantart_posted_at";

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
        upscaled_from: row.get(19)?,
        upscaled_to: row.get(20)?,
        // Absent unless there is a row in `deviantart_posts`, which is what the
        // grid's badge reads. `posted_at` carries the presence, because it is
        // the one column of the three that is never null.
        deviant_art: row
            .get::<_, Option<i64>>(23)?
            .map(|posted_at| DeviantArtPost {
                url: row.get(21).unwrap_or(None),
                published: row.get::<_, Option<i64>>(22).unwrap_or(None).unwrap_or(0) != 0,
                posted_at,
            }),
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

/// What one sweep of [`Db::prune_media_where`] removed.
#[derive(Debug, Clone, Default)]
pub struct Pruned {
    pub rows: usize,
    /// Content keys the dropped rows used, deduped. Some may still be claimed
    /// by rows elsewhere, so these are candidates rather than garbage.
    pub keys: Vec<String>,
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
            search_paths: false,
            tag: None,
            min_stars: None,
            unstarred: false,
            has_prompt: None,
            img2img: None,
            extras: None,
            label: None,
            animated: None,
            greyscale: None,
            min_longest_edge: None,
            modified_after: None,
            modified_before: None,
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

    /// Monday 2024-07-01 00:00 UTC — a known week boundary to build cases on.
    #[cfg(test)]
    const A_MONDAY_MS: i64 = 1_719_792_000_000;

    #[test]
    fn the_timeline_buckets_by_week_and_honours_the_filters() {
        const WEEK: i64 = 7 * 24 * 60 * 60 * 1000;
        let db = Db::open_in_memory().expect("in-memory index");
        let folder = db.add_folder("/media", 1).expect("add folder");
        db.insert_media_batch(
            folder,
            &[
                // Two in the first week, one the week after.
                file("/media/a.jpg", MediaKind::Image, A_MONDAY_MS + 1000),
                file("/media/b.jpg", MediaKind::Image, A_MONDAY_MS + WEEK - 1),
                file("/media/c.mp4", MediaKind::Video, A_MONDAY_MS + WEEK + 1000),
            ],
            1,
        )
        .expect("insert");

        let buckets = db.media_timeline(&query()).expect("timeline");
        assert_eq!(
            buckets,
            vec![
                crate::types::TimelineBucket { start: A_MONDAY_MS, count: 2 },
                crate::types::TimelineBucket { start: A_MONDAY_MS + WEEK, count: 1 },
            ]
        );

        // The kind filter reaches the bars: the histogram describes the grid.
        let images_only = MediaQuery { kind: Some(MediaKind::Image), ..query() };
        let buckets = db.media_timeline(&images_only).expect("timeline");
        assert_eq!(buckets.iter().map(|b| b.count).sum::<i64>(), 2);
    }

    #[test]
    fn the_timeline_ignores_its_own_range_but_the_grid_applies_it() {
        // The one deliberate divergence between the two: bars keep showing the
        // whole span while a selection narrows the grid — otherwise selecting
        // a range would leave nothing outside it to grab.
        const WEEK: i64 = 7 * 24 * 60 * 60 * 1000;
        let db = Db::open_in_memory().expect("in-memory index");
        let folder = db.add_folder("/media", 1).expect("add folder");
        db.insert_media_batch(
            folder,
            &[
                file("/media/a.jpg", MediaKind::Image, A_MONDAY_MS + 1000),
                file("/media/b.jpg", MediaKind::Image, A_MONDAY_MS + WEEK + 1000),
            ],
            1,
        )
        .expect("insert");

        let narrowed = MediaQuery {
            modified_after: Some(A_MONDAY_MS),
            modified_before: Some(A_MONDAY_MS + WEEK),
            ..query()
        };

        let page = db.query_media(&narrowed).expect("query");
        assert_eq!(page.total, 1, "the grid must narrow to the selected week");

        let buckets = db.media_timeline(&narrowed).expect("timeline");
        assert_eq!(buckets.len(), 2, "the bars must keep showing the whole span");
    }

    #[test]
    fn a_file_with_a_zero_mtime_stays_off_the_timeline() {
        // 0 is what a broken copy tool writes. A 1970 bar would flatten five
        // decades of real bars into hairlines.
        let db = Db::open_in_memory().expect("in-memory index");
        let folder = db.add_folder("/media", 1).expect("add folder");
        db.insert_media_batch(
            folder,
            &[
                file("/media/broken.jpg", MediaKind::Image, 0),
                file("/media/fine.jpg", MediaKind::Image, A_MONDAY_MS + 1000),
            ],
            1,
        )
        .expect("insert");

        let buckets = db.media_timeline(&query()).expect("timeline");
        assert_eq!(buckets.len(), 1);
        assert_eq!(buckets[0].start, A_MONDAY_MS);
    }

    #[test]
    fn the_prompt_filter_separates_recovered_from_stripped() {
        let (db, _) = seeded();
        let ids: Vec<i64> =
            db.query_media(&query()).expect("query").items.iter().map(|i| i.id).collect();
        db.set_generation(
            ids[0],
            Some(&crate::generated::Generation {
                tool: "Stable Diffusion".to_string(),
                prompt: Some("1girl, ocean".to_string()),
                ..Default::default()
            }),
        )
        .expect("set");
        // Generated, but the block did not survive: a marker with no prompt.
        // This is the row that keeps "has a prompt" a different question from
        // the AI tag.
        db.set_generation(
            ids[1],
            Some(&crate::generated::Generation {
                tool: "Stable Diffusion".to_string(),
                prompt: None,
                ..Default::default()
            }),
        )
        .expect("set");

        let with = db
            .query_media(&MediaQuery { has_prompt: Some(true), ..query() })
            .expect("query");
        assert_eq!(with.total, 1);
        assert_eq!(with.items[0].id, ids[0]);

        let without = db
            .query_media(&MediaQuery { has_prompt: Some(false), ..query() })
            .expect("query");
        assert_eq!(without.total, 2, "the markered-but-promptless row counts as without");
    }

    #[test]
    fn an_upscaled_variant_still_answers_the_search_its_original_matched() {
        // The reported failure: filters plus a search term, upscale three,
        // close the results — gone. The original is hidden unconditionally
        // once its variant stands in, but the variant was a fresh file with
        // no prompt, so the search rejected it and the picture vanished from
        // the filtered grid entirely. Same class as the stars case the
        // insert-time comment documents; the searchable identity has to
        // travel too.
        let db = Db::open_in_memory().expect("in-memory index");
        let folder = db.add_folder("/media", 1).expect("folder");
        db.insert_media_batch(
            folder,
            &[super::tests::file("/media/00042-girl.png", MediaKind::Image, 100)],
            1,
        )
        .expect("insert original");
        let original = db.query_media(&query()).expect("q").items[0].id;
        db.set_generation(
            original,
            Some(&crate::generated::Generation {
                tool: "Stable Diffusion".to_string(),
                prompt: Some("aqua (konosuba), ocean, huge ass".to_string()),
                ..Default::default()
            }),
        )
        .expect("set");
        // The original needs a thumbnail for the variant to inherit — that is
        // the stand-in gate.
        db.update_thumbnail(
            original,
            &ThumbnailUpdate {
                thumb_path: "/thumbs/aa/bb.jpg".to_string(),
                thumb_width: 512,
                thumb_height: 512,
                width: 1024,
                height: 1024,
                duration_sec: None,
            },
        )
        .expect("thumb");

        // The upscaled variant lands, exactly as the upscale command inserts it.
        db.insert_media_batch(
            folder,
            &[super::tests::file("/media/00042-girl_upscaled_4k.png", MediaKind::Image, 100)],
            1,
        )
        .expect("insert variant");

        let searched = MediaQuery { search: "aqua".to_string(), ..query() };
        let found = db.query_media(&searched).expect("q");
        assert_eq!(found.total, 1, "the picture must not vanish from the search");
        assert!(
            found.items[0].upscaled_from.is_some(),
            "and the one shown is the variant standing in"
        );
        // The leaderboard link survives too.
        let top = db.top_characters(&query(), 10).expect("top");
        assert_eq!(top[0].count, 1, "one picture, not two, and not zero");
    }

    #[test]
    fn an_extras_upscale_links_to_its_original_by_filename_first() {
        // A1111's extras output keeps the original's filename, sometimes
        // behind a counter prefix — no duplicate scan needed for those.
        let db = Db::open_in_memory().expect("in-memory index");
        let folder = db.add_folder("/media", 1).expect("folder");
        db.insert_media_batch(
            folder,
            &[
                super::tests::file("/media/txt2img/00042-girl.png", MediaKind::Image, 100),
                super::tests::file("/media/extras/00001-00042-girl.png", MediaKind::Image, 200),
            ],
            1,
        )
        .expect("insert");
        let rows = db.query_media(&query()).expect("q").items;
        let (original, upscale) = (rows[1].id, rows[0].id);
        db.set_generation(
            original,
            Some(&crate::generated::Generation {
                tool: "Stable Diffusion".to_string(),
                prompt: Some("1girl, ocean".to_string()),
                ..Default::default()
            }),
        )
        .expect("set");
        db.set_generation(
            upscale,
            Some(&crate::generated::Generation {
                tool: "Stable Diffusion".to_string(),
                postprocessed: true,
                ..Default::default()
            }),
        )
        .expect("set");

        // No dupe groups anywhere — the counter-stripped filename is the link.
        let found = db.extras_original(upscale).expect("q").expect("linked");
        assert_eq!(found.id, original);
    }

    #[test]
    fn rows_labelled_before_extras_detection_are_marked_on_open() {
        // The reported failure: a fully scanned library, the new filter, zero
        // results — because a rescan leaves labelled rows alone. The old
        // parser stored the postprocess line as the prompt, which is evidence
        // enough to repair in SQL.
        let file = tempfile::NamedTempFile::new().expect("temp");
        let path = file.path().to_path_buf();
        drop(file);
        {
            let db = Db::open(&path).expect("open");
            let folder = db.add_folder("/media", 1).expect("folder");
            db.insert_media_batch(
                folder,
                &[super::tests::file("/media/up.png", MediaKind::Image, 100)],
                1,
            )
            .expect("insert");
            let id = db.query_media(&query()).expect("q").items[0].id;
            // What the old parser wrote: the postprocess line as prompt, no
            // postprocessed flag.
            db.set_generation(
                id,
                Some(&crate::generated::Generation {
                    tool: "Stable Diffusion".to_string(),
                    prompt: Some(
                        "Postprocess upscale by: 2, Postprocess upscaler: 4x-UltraSharp"
                            .to_string(),
                    ),
                    ..Default::default()
                }),
            )
            .expect("set");
            let conn = rusqlite::Connection::open(&path).expect("raw");
            conn.execute("DELETE FROM settings WHERE key = 'extras_detection'", [])
                .expect("unmark");
        }

        let db = Db::open(&path).expect("reopen");
        let found = db.query_media(&MediaQuery { extras: Some(true), ..query() }).expect("q");
        assert_eq!(found.total, 1, "the repaired row answers the extras filter");
        assert!(found.items[0].generation.as_ref().expect("gen").postprocessed);
    }

    #[test]
    fn the_new_filters_survive_the_queries_that_share_the_where_builder() {
        // The bug this exists for. `query_media` selects `FROM media`, but the
        // same clauses are pasted into the character leaderboard, which reads
        // `FROM media_characters c JOIN media` — and `media_characters` has a
        // `name` column too. An unqualified `lower(name)` is ambiguous there,
        // SQLite refuses the statement, and because the UI asks for the grid
        // and the leaderboard in one `Promise.all`, the leaderboard's failure
        // empties the grid. The grid's own query was never wrong.
        //
        // Testing `query_media` alone could not see it, which is exactly why
        // this drives every consumer of the builder.
        let (db, _) = seeded();
        let filters = [
            MediaQuery { animated: Some(true), ..query() },
            MediaQuery { animated: Some(false), ..query() },
            MediaQuery { greyscale: Some(true), ..query() },
            MediaQuery { greyscale: Some(false), ..query() },
            MediaQuery { label: Some("FACE_FEMALE".to_string()), ..query() },
        ];

        for filter in filters {
            db.query_media(&filter).expect("the grid query");
            // The one that was broken.
            db.top_characters(&filter, 10).expect("the character leaderboard");
            db.media_timeline(&filter).expect("the timeline histogram");
        }
    }

    #[test]
    fn a_label_filter_finds_what_the_verdict_never_named() {
        // The point of the labels table. `topLabel` is chosen by rating weight,
        // so FACE_FEMALE — which carries none — can never be the top label
        // however many pictures show a face. On this library that is 85,000
        // rows that were unfilterable.
        let (db, _) = seeded();
        let ids: Vec<i64> =
            db.query_media(&query()).expect("query").items.iter().map(|i| i.id).collect();

        db.replace_frames(
            ids[0],
            &[NewFrame {
                frame_index: 0,
                timestamp_sec: 0.0,
                path: "/thumbs/a.jpg".to_string(),
                verdict_json: serde_json::json!({
                    "person": true, "sexy": true, "nude": false, "rating": "suggestive",
                    "topLabel": "BUTTOCKS_EXPOSED", "topLabelTitle": "exposed buttocks",
                    "topScore": 0.9,
                    "detections": [
                        { "label": "BUTTOCKS_EXPOSED", "score": 0.9, "box": [0.0, 0.0, 1.0, 1.0] },
                        { "label": "FACE_FEMALE", "score": 0.8, "box": [0.0, 0.0, 1.0, 1.0] },
                        { "label": "ANUS_EXPOSED", "score": 0.02, "box": [0.0, 0.0, 1.0, 1.0] }
                    ]
                })
                .to_string(),
            }],
        )
        .expect("frames");

        let by_label = |label: &str| {
            db.query_media(&MediaQuery { label: Some(label.to_string()), ..query() })
                .expect("query")
                .items
                .len()
        };
        assert_eq!(by_label("FACE_FEMALE"), 1, "a label the verdict never names");
        assert_eq!(by_label("BUTTOCKS_EXPOSED"), 1);
        assert_eq!(by_label("ANUS_EXPOSED"), 0, "under the floor is not a finding");
        assert_eq!(by_label("FEET_EXPOSED"), 0, "never detected at all");
    }

    #[test]
    fn re_classifying_a_row_replaces_its_labels_rather_than_adding_to_them() {
        // `replace_frames` is the only place frames are written, which is why
        // the labels are rebuilt there: a row cannot end up disagreeing with
        // its own detections.
        let (db, _) = seeded();
        let id = db.query_media(&query()).expect("query").items[0].id;
        let frame = |label: &str| NewFrame {
            frame_index: 0,
            timestamp_sec: 0.0,
            path: "/thumbs/a.jpg".to_string(),
            verdict_json: serde_json::json!({
                "person": true, "sexy": false, "nude": false, "rating": "sfw",
                "topLabel": null, "topLabelTitle": null, "topScore": 0.0,
                "detections": [{ "label": label, "score": 0.9, "box": [0.0, 0.0, 1.0, 1.0] }]
            })
            .to_string(),
        };

        db.replace_frames(id, &[frame("FACE_FEMALE")]).expect("first");
        db.replace_frames(id, &[frame("FACE_MALE")]).expect("second");

        let labels = db.labels_for_media(id).expect("labels");
        assert_eq!(labels.len(), 1, "the old label is gone, not kept alongside");
        assert_eq!(labels[0].0, "FACE_MALE");
    }

    #[test]
    fn a_video_is_labelled_by_its_strongest_frame() {
        // The same rule its verdict follows: one sexy frame makes the video
        // sexy, so the best a label reaches on any frame is what it carries.
        let (db, _) = seeded();
        let id = db.query_media(&query()).expect("query").items[1].id;
        let frame = |index: i64, score: f64| NewFrame {
            frame_index: index,
            timestamp_sec: index as f64,
            path: format!("/frames/{index}.jpg"),
            verdict_json: serde_json::json!({
                "person": true, "sexy": false, "nude": false, "rating": "sfw",
                "topLabel": null, "topLabelTitle": null, "topScore": 0.0,
                "detections": [
                    { "label": "FACE_FEMALE", "score": score, "box": [0.0, 0.0, 1.0, 1.0] }
                ]
            })
            .to_string(),
        };
        db.replace_frames(id, &[frame(0, 0.30), frame(1, 0.95), frame(2, 0.10)])
            .expect("frames");

        let labels = db.labels_for_media(id).expect("labels");
        assert_eq!(labels.len(), 1);
        assert!((labels[0].1 - 0.95).abs() < 1e-9, "the best frame, not the last");
    }

    #[test]
    fn the_animated_filter_splits_gifs_from_stills_without_touching_kind() {
        // "Everything except videos and GIFs" is two questions — this one and
        // the kind filter — so they have to compose rather than overlap.
        let db = Db::open_in_memory().expect("in-memory index");
        let folder = db.add_folder("/media", 1).expect("add folder");
        db.insert_media_batch(
            folder,
            &[
                file("/media/still.png", MediaKind::Image, 300),
                file("/media/moving.GIF", MediaKind::Image, 200),
                file("/media/maybe.webp", MediaKind::Image, 150),
                file("/media/clip.mp4", MediaKind::Video, 100),
            ],
            1,
        )
        .expect("insert");

        let names = |q: MediaQuery| {
            let mut found: Vec<String> =
                db.query_media(&q).expect("query").items.iter().map(|i| i.name.clone()).collect();
            found.sort();
            found
        };

        assert_eq!(
            names(MediaQuery { animated: Some(true), ..query() }),
            ["maybe.webp", "moving.GIF"],
            "case-insensitive, and webp counts because the container can animate",
        );
        // The filter the request called "all but videos and gifs".
        assert_eq!(
            names(MediaQuery { animated: Some(false), kind: Some(MediaKind::Image), ..query() }),
            ["still.png"],
        );
        // On its own it says nothing about videos, which is what lets the two
        // compose.
        assert_eq!(
            names(MediaQuery { animated: Some(false), ..query() }),
            ["clip.mp4", "still.png"],
        );
    }

    #[test]
    fn the_greyscale_filter_reads_the_signature_already_stored() {
        // No decoding: chroma is a reduction of the colour signature written
        // during fingerprinting. A row never fingerprinted supports neither
        // claim and is excluded from both.
        let (db, _) = seeded();
        let ids: Vec<i64> =
            db.query_media(&query()).expect("query").items.iter().map(|i| i.id).collect();

        // Flat grey: every channel equal, so no colour at any brightness.
        db.set_fingerprint(ids[0], 1, &[128; 192]).expect("grey");
        let mut colour = vec![0_u8; 192];
        for cell in colour.chunks_exact_mut(3) {
            cell[0] = 200;
            cell[2] = 20;
        }
        db.set_fingerprint(ids[1], 2, &colour).expect("colour");

        let ids_for = |q: MediaQuery| {
            db.query_media(&q).expect("query").items.iter().map(|i| i.id).collect::<Vec<_>>()
        };
        assert_eq!(ids_for(MediaQuery { greyscale: Some(true), ..query() }), vec![ids[0]]);
        assert_eq!(ids_for(MediaQuery { greyscale: Some(false), ..query() }), vec![ids[1]]);
    }

    #[test]
    fn the_extras_filter_and_original_link_through_the_dupe_group() {
        let (db, _) = seeded();
        let ids: Vec<i64> =
            db.query_media(&query()).expect("query").items.iter().map(|i| i.id).collect();
        // ids[0]: the original, with a prompt. ids[1]: its Extras upscale.
        db.set_generation(
            ids[0],
            Some(&crate::generated::Generation {
                tool: "Stable Diffusion".to_string(),
                prompt: Some("aqua (konosuba), ocean".to_string()),
                ..Default::default()
            }),
        )
        .expect("set");
        db.set_generation(
            ids[1],
            Some(&crate::generated::Generation {
                tool: "Stable Diffusion".to_string(),
                postprocessed: true,
                ..Default::default()
            }),
        )
        .expect("set");

        let only = db.query_media(&MediaQuery { extras: Some(true), ..query() }).expect("q");
        assert_eq!(only.total, 1);
        assert_eq!(only.items[0].id, ids[1]);
        let none = db.query_media(&MediaQuery { extras: Some(false), ..query() }).expect("q");
        assert_eq!(none.total, 2, "originals and never-generated both count as not-extras");

        // Unlinked until Find Duplicates has grouped them — reported as None,
        // never an error. (The seeded names share nothing, so the filename
        // path finds nothing either.)
        assert!(db.extras_original(ids[1]).expect("q").is_none());

        db.set_duplicate_groups(&[(1, ids[0]), (1, ids[1])]).expect("group");
        let original = db.extras_original(ids[1]).expect("q").expect("linked");
        assert_eq!(original.id, ids[0], "the non-extras, prompt-bearing member");
    }

    #[test]
    fn the_img2img_filter_reads_the_blocks_own_claim() {
        let (db, _) = seeded();
        let ids: Vec<i64> =
            db.query_media(&query()).expect("query").items.iter().map(|i| i.id).collect();
        let gen = |from_image: bool| crate::generated::Generation {
            tool: "Stable Diffusion".to_string(),
            needs_source_image: from_image,
            ..Default::default()
        };
        db.set_generation(ids[0], Some(&gen(true))).expect("set");
        db.set_generation(ids[1], Some(&gen(false))).expect("set");
        // ids[2] has no generation at all — it must count as not-img2img.

        let only = db.query_media(&MediaQuery { img2img: Some(true), ..query() }).expect("q");
        assert_eq!(only.total, 1);
        assert_eq!(only.items[0].id, ids[0]);

        let none = db.query_media(&MediaQuery { img2img: Some(false), ..query() }).expect("q");
        assert_eq!(none.total, 2, "txt2img and never-generated both count as not-img2img");
    }

    #[test]
    fn characters_rank_by_how_many_pictures_carry_them() {
        let (db, _) = seeded();
        let ids: Vec<i64> = db.query_media(&query()).expect("query").items.iter().map(|i| i.id).collect();
        let gen = |prompt: &str| crate::generated::Generation {
            tool: "Stable Diffusion".to_string(),
            prompt: Some(prompt.to_string()),
            ..Default::default()
        };
        // Two of aqua, one of megumin — and detection happens on the same call
        // that stores the prompt, which is the whole design.
        db.set_generation(ids[0], Some(&gen("aqua (konosuba), ocean"))).expect("set");
        db.set_generation(ids[1], Some(&gen("Aqua (Konosuba), beach"))).expect("set");
        db.set_generation(ids[2], Some(&gen("megumin (konosuba), staff"))).expect("set");

        let top = db.top_characters(&query(), 10).expect("top");
        assert_eq!(top[0].name, "aqua (konosuba)");
        // The leaderboard follows the grid: narrowed to videos, only the
        // video's aqua remains — the image copies leave the ranking with the
        // filter, which is the whole point of it following.
        let narrowed = MediaQuery { kind: Some(MediaKind::Video), ..query() };
        let ranked = db.top_characters(&narrowed, 10).expect("top");
        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0].count, 1, "one of aqua's two is a video");
        assert_eq!(top[0].count, 2);
        assert_eq!(top[1].count, 1);

        // A prompt that changes loses its old cast rather than accumulating.
        db.set_generation(ids[2], Some(&gen("landscape, no one"))).expect("set");
        let top = db.top_characters(&query(), 10).expect("top");
        assert_eq!(top.len(), 1, "megumin left with the prompt that named her");
    }

    #[test]
    fn a_library_that_predates_detection_is_backfilled_on_open() {
        // A rescan deliberately leaves existing rows alone, so without this the
        // whole already-scanned library would stay uncounted forever.
        let file = tempfile::NamedTempFile::new().expect("temp");
        let path = file.path().to_path_buf();
        drop(file);

        {
            let db = Db::open(&path).expect("open");
            let folder = db.add_folder("/media", 1).expect("folder");
            db.insert_media_batch(
                folder,
                &[super::tests::file("/media/a.png", MediaKind::Image, 100)],
                1,
            )
            .expect("insert");
            let id = db.query_media(&query()).expect("q").items[0].id;
            db.set_generation(
                id,
                Some(&crate::generated::Generation {
                    tool: "Stable Diffusion".to_string(),
                    prompt: Some("aqua (konosuba), ocean".to_string()),
                    ..Default::default()
                }),
            )
            .expect("set");
            // Put the file in the state a pre-detection library is in: prompt
            // stored, characters absent, no marker saying they were looked for.
            let conn = rusqlite::Connection::open(&path).expect("raw");
            conn.execute("DELETE FROM media_characters", []).expect("clear");
            conn.execute("DELETE FROM settings WHERE key = 'character_detection'", [])
                .expect("unmark");
        }

        let db = Db::open(&path).expect("reopen");
        let top = db.top_characters(&query(), 10).expect("top");
        assert_eq!(top.len(), 1);
        assert_eq!(top[0].name, "aqua (konosuba)");
    }

    #[test]
    fn unstarred_finds_exactly_what_nobody_has_judged() {
        // The triage queue behind the "AI Unrated" filter. `min_stars` cannot
        // express it: that comparison is *at least*, so `Some(0)` would match
        // every row including the rated ones and quietly do nothing.
        let (db, _) = seeded();
        let all = db.query_media(&query()).expect("query");
        let first = all.items[0].id;
        db.set_stars(first, Some(4)).expect("rate one");

        let unstarred = MediaQuery {
            unstarred: true,
            ..query()
        };
        let found = db.query_media(&unstarred).expect("query");

        assert_eq!(found.total, all.total - 1, "the rated row should be gone");
        assert!(
            found.items.iter().all(|item| item.stars.is_none()),
            "every row returned must be unrated"
        );
        assert!(!found.items.iter().any(|item| item.id == first));
    }

    #[test]
    fn clearing_a_rating_returns_a_row_to_the_triage_queue() {
        // `set_stars(None)` writes NULL rather than 0, which is what makes
        // `stars IS NULL` the right predicate. A zero would leave the row
        // invisible to both this filter and the "4+" one.
        let (db, _) = seeded();
        let id = db.query_media(&query()).expect("query").items[0].id;
        db.set_stars(id, Some(5)).expect("rate");
        db.set_stars(id, None).expect("clear");

        let found = db
            .query_media(&MediaQuery {
                unstarred: true,
                ..query()
            })
            .expect("query");
        assert!(found.items.iter().any(|item| item.id == id));
    }

    #[test]
    fn variants_indexed_under_the_old_rule_are_repaired_on_open() {
        // A variant created before dates were inherited keeps the date it was
        // written with, and sits at the front of a newest-first grid instead of
        // beside the picture it replaces. The inheritance at insert cannot fix
        // it — that skips a row which already has a thumbnail — so opening the
        // index repairs it once.
        let file = tempfile::NamedTempFile::new().expect("temp");
        let path = file.path().to_path_buf();
        drop(file);

        {
            let db = Db::open(&path).expect("open");
            let folder = db.add_folder("/out", 1).expect("add folder");
            db.insert_media_batch(
                folder,
                &[super::tests::file("/out/00091.png", MediaKind::Image, 111)],
                222,
            )
            .expect("insert");
            let original = db.media_by_path("/out/00091.png").expect("lookup").expect("row");
            db.update_poster(original.id, "/thumbs/o.jpg").expect("thumb");
            db.set_stars(original.id, Some(5)).expect("stars");

            // Written as the old code would have: its own dates, its own
            // thumbnail, so nothing at insert will touch it again.
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO media
                     (folder_id, path, name, kind, size_bytes, modified_at, added_at,
                      upscaled_from, thumb_path)
                 VALUES (?1, '/out/00091_upscaled_4k.png', '00091_upscaled_4k.png', 'image',
                         1, 999999, 999999, '/out/00091.png', '/thumbs/v.jpg')",
                params![folder],
            )
            .expect("insert variant");

            // An index that predates the rule has no such setting at all. The
            // first open above recorded one before this row existed, so it is
            // cleared to put the file in the state a real library is in.
            conn.execute("DELETE FROM settings WHERE key = 'variant_inheritance'", [])
                .expect("clear the marker");
        }

        // Reopened: the repair runs.
        let db = Db::open(&path).expect("reopen");
        let variant = db
            .media_by_path("/out/00091_upscaled_4k.png")
            .expect("lookup")
            .expect("row");
        assert_eq!(variant.modified_at, 111);
        assert_eq!(variant.added_at, 222);
        assert_eq!(
            variant.stars,
            Some(5),
            "an unrated variant of a favourite vanishes under the favourites              filter — hidden by its own existence, filtered out for having no              rating of its own",
        );

        // And once only — a second open must not undo a later legitimate edit.
        drop(db);
        let db = Db::open(&path).expect("third open");
        assert_eq!(
            db.media_by_path("/out/00091_upscaled_4k.png")
                .unwrap()
                .unwrap()
                .modified_at,
            111
        );
    }

    #[test]
    fn a_variant_takes_its_originals_thumbnail_and_place() {
        // What the user should see: select, upscale, come back, and the picture
        // is exactly where it was with a 4K badge on it. That needs three things
        // inherited — the thumbnail (so it is drawable at once and nothing is
        // decoded twice), and both dates (so it does not jump to the front of a
        // newest-first grid and drag itself out of the run it belongs to).
        let db = Db::open_in_memory().expect("in-memory index");
        let folder = db.add_folder("/out", 1).expect("add folder");
        db.insert_media_batch(folder, &[file("/out/00091.png", MediaKind::Image, 111)], 222)
            .expect("insert original");

        let original = db.media_by_path("/out/00091.png").expect("lookup").expect("row");
        db.update_thumbnail(
            original.id,
            &ThumbnailUpdate {
                thumb_path: "/thumbs/ab/cd/original.jpg".to_string(),
                thumb_width: 360,
                thumb_height: 512,
                width: 1040,
                height: 1520,
                duration_sec: None,
            },
        )
        .expect("thumbnail");
        db.set_stars(original.id, Some(5)).expect("stars");

        // The variant arrives later, with today's dates.
        db.insert_media_batch(
            folder,
            &[file("/out/00091_upscaled_4k.png", MediaKind::Image, 999_999)],
            999_999,
        )
        .expect("insert variant");

        let variant = db
            .media_by_path("/out/00091_upscaled_4k.png")
            .expect("lookup")
            .expect("row");
        assert_eq!(
            variant.thumb_path.as_deref(),
            Some("/thumbs/ab/cd/original.jpg"),
            "the same picture, so the same thumbnail rather than a second decode",
        );
        assert_eq!(variant.thumb_width, Some(360));
        assert_eq!(variant.modified_at, 111, "sorts where the original sorted");
        assert_eq!(variant.added_at, 222);
        assert_eq!(
            variant.stars,
            Some(5),
            "a rating is about the picture, and the favourites filter would              otherwise drop a variant whose original was a favourite — while              that original is hidden precisely because the variant exists",
        );

        // And it is the one shown, immediately — no window where neither is.
        let page = db.query_media(&query()).expect("query");
        let names: Vec<&str> = page.items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, vec!["00091_upscaled_4k.png"]);
    }

    #[test]
    fn each_half_of_a_pair_names_the_other() {
        // What `with_counterparts` walks to delete both. The variant names its
        // original directly; the original only learns about the variant through
        // the derived `upscaled_to`, so both directions have to work or a
        // delete started from the wrong end strands a file.
        let db = Db::open_in_memory().expect("in-memory index");
        let folder = db.add_folder("/out", 1).expect("add folder");
        db.insert_media_batch(
            folder,
            &[
                file("/out/00021.png", MediaKind::Image, 1),
                file("/out/00021_upscaled_4k.png", MediaKind::Image, 2),
                file("/out/00099.png", MediaKind::Image, 3),
            ],
            1,
        )
        .expect("insert");

        let variant = db
            .media_by_path("/out/00021_upscaled_4k.png")
            .expect("lookup")
            .expect("row");
        assert_eq!(variant.upscaled_from.as_deref(), Some("/out/00021.png"));
        assert_eq!(variant.upscaled_to, None);

        let original = db.media_by_path("/out/00021.png").expect("lookup").expect("row");
        assert_eq!(original.upscaled_from, None);
        assert_eq!(
            original.upscaled_to.as_deref(),
            Some("/out/00021_upscaled_4k.png"),
            "the original has to be able to reach its variant, not only the reverse",
        );

        // A picture with no variant names nothing, so a delete of it takes one file.
        let lone = db.media_by_path("/out/00099.png").expect("lookup").expect("row");
        assert_eq!(lone.upscaled_from, None);
        assert_eq!(lone.upscaled_to, None);
    }

    #[test]
    fn a_variants_own_size_can_be_recorded_without_losing_the_shared_key() {
        // The upscaler already knows what it produced, so the size is written
        // straight from the run rather than measured again. It must not take
        // the inherited content key with it — that is what the shared thumbnail
        // is addressed by, and losing it orphans the variant's picture the
        // moment the original is deleted.
        let db = Db::open_in_memory().expect("in-memory index");
        let folder = db.add_folder("/out", 1).expect("add folder");
        db.insert_media_batch(folder, &[file("/out/00021.png", MediaKind::Image, 1)], 1)
            .expect("insert original");
        let original = db.media_by_path("/out/00021.png").expect("lookup").expect("row");
        db.update_thumbnail(
            original.id,
            &ThumbnailUpdate {
                thumb_path: "/thumbs/ab/cd/o.jpg".to_string(),
                thumb_width: 360,
                thumb_height: 512,
                width: 1040,
                height: 1520,
                duration_sec: None,
            },
        )
        .expect("thumbnail");
        db.update_dimensions(original.id, 1040, 1520, None, Some("sharedkey"))
            .expect("key");

        db.insert_media_batch(
            folder,
            &[file("/out/00021_upscaled_4k.png", MediaKind::Image, 2)],
            2,
        )
        .expect("insert variant");
        let variant = db
            .media_by_path("/out/00021_upscaled_4k.png")
            .expect("lookup")
            .expect("row");
        assert_eq!(variant.width, 0, "nothing has measured it yet");
        assert_eq!(
            db.content_key_for_path("/out/00021_upscaled_4k.png").unwrap().as_deref(),
            Some("sharedkey"),
            "inherited with the thumbnail it addresses",
        );

        // The measure phase passes a key computed from the variant's own
        // bytes. It must lose to the inherited one, or the shared thumbnail is
        // left claimed by nobody.
        db.update_dimensions(variant.id, 2627, 3840, None, Some("itsownhash"))
            .expect("size");

        let variant = db
            .media_by_path("/out/00021_upscaled_4k.png")
            .expect("lookup")
            .expect("row");
        assert_eq!((variant.width, variant.height), (2627, 3840));
        assert_eq!(variant.thumb_path.as_deref(), Some("/thumbs/ab/cd/o.jpg"));
        assert_eq!(
            db.content_key_for_path("/out/00021_upscaled_4k.png").unwrap().as_deref(),
            Some("sharedkey"),
            "the inherited key has to survive, or the shared thumbnail is orphaned",
        );
    }

    #[test]
    fn a_variant_without_a_thumbnail_does_not_hide_anything_yet() {
        // The bug this exists for: the watcher indexes a variant the instant it
        // is written, seconds before the pipeline can thumbnail it. Hiding on
        // the row alone took the original away while its replacement was still
        // an undrawable empty tile, so three pictures vanished out of the grid.
        let db = Db::open_in_memory().expect("in-memory index");
        let folder = db.add_folder("/out", 1).expect("add folder");
        db.insert_media_batch(
            folder,
            &[
                file("/out/00091.png", MediaKind::Image, 300),
                file("/out/00091_upscaled_4k.png", MediaKind::Image, 200),
            ],
            1,
        )
        .expect("insert");

        // Nothing thumbnailed: both are visible, because hiding one would leave
        // a hole rather than a substitution.
        let names = |page: MediaPage| {
            let mut names: Vec<String> = page.items.iter().map(|i| i.name.clone()).collect();
            names.sort();
            names
        };
        assert_eq!(
            names(db.query_media(&query()).expect("query")),
            vec!["00091.png", "00091_upscaled_4k.png"],
        );

        // The variant becomes drawable, and only now stands in.
        let variant = db
            .media_by_path("/out/00091_upscaled_4k.png")
            .expect("lookup")
            .expect("row");
        db.update_poster(variant.id, "/thumbs/ab/cd/variant.jpg").expect("thumb");

        assert_eq!(
            names(db.query_media(&query()).expect("query")),
            vec!["00091_upscaled_4k.png"],
        );
    }

    #[test]
    fn an_upscaled_variant_stands_in_for_what_it_came_from() {
        // The grid shows one row per picture. Both would be the same picture at
        // two resolutions, which is not a view anyone asked for.
        let db = Db::open_in_memory().expect("in-memory index");
        let folder = db.add_folder("/out", 1).expect("add folder");
        db.insert_media_batch(
            folder,
            &[
                file("/out/00118.png", MediaKind::Image, 300),
                file("/out/00118_upscaled_4k.png", MediaKind::Image, 200),
                file("/out/00119.png", MediaKind::Image, 100),
            ],
            1,
        )
        .expect("insert");

        // Thumbnailed, because a variant only stands in once it can be drawn —
        // see `a_variant_without_a_thumbnail_does_not_hide_anything_yet`.
        let variant = db
            .media_by_path("/out/00118_upscaled_4k.png")
            .expect("lookup")
            .expect("row");
        db.update_poster(variant.id, "/thumbs/ab/cd/v.jpg").expect("thumb");

        let page = db.query_media(&query()).expect("query");
        let mut names: Vec<&str> = page.items.iter().map(|i| i.name.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["00118_upscaled_4k.png", "00119.png"]);
        assert_eq!(page.total, 2, "the count has to agree with the rows");

        // And the variant names its original, which is the only route back.
        let variant = page
            .items
            .iter()
            .find(|i| i.name == "00118_upscaled_4k.png")
            .expect("variant");
        assert_eq!(variant.upscaled_from.as_deref(), Some("/out/00118.png"));
    }

    #[test]
    fn a_posted_picture_carries_its_deviantart_row() {
        let db = Db::open_in_memory().expect("in-memory index");
        let folder = db.add_folder("/out", 1).expect("add folder");
        db.insert_media_batch(folder, &[file("/out/00242.png", MediaKind::Image, 300)], 1)
            .expect("insert");

        assert!(db.media_by_path("/out/00242.png").unwrap().unwrap().deviant_art.is_none());

        // Staged, then published — the two calls `send` makes for one file.
        db.record_deviantart_post("/out/00242.png", Some(88), None, None, false)
            .expect("stage");
        let staged = db.media_by_path("/out/00242.png").unwrap().unwrap();
        let staged = staged.deviant_art.expect("a row after staging");
        assert!(!staged.published, "staging is not posting");
        assert_eq!(staged.url, None);

        db.record_deviantart_post(
            "/out/00242.png",
            Some(88),
            Some("abc-123"),
            Some("https://www.deviantart.com/jebaz/art/x-1"),
            true,
        )
        .expect("publish");
        let posted = db.media_by_path("/out/00242.png").unwrap().unwrap();
        let posted = posted.deviant_art.expect("a row after publishing");
        assert!(posted.published);
        assert_eq!(posted.url.as_deref(), Some("https://www.deviantart.com/jebaz/art/x-1"));
    }

    #[test]
    fn a_second_staging_never_un_posts_something_public() {
        // Re-uploading a picture that is already public — a better crop, a
        // retitle — stages first, and that staging reports `published: false`.
        // Taking it at its word would clear the badge on a deviation that is
        // demonstrably still up, which is the one direction that misleads.
        let db = Db::open_in_memory().expect("in-memory index");
        let folder = db.add_folder("/out", 1).expect("add folder");
        db.insert_media_batch(folder, &[file("/out/00242.png", MediaKind::Image, 300)], 1)
            .expect("insert");

        db.record_deviantart_post("/out/00242.png", Some(1), None, Some("https://d/1"), true)
            .expect("publish");
        db.record_deviantart_post("/out/00242.png", Some(2), None, None, false)
            .expect("stage again");

        let row = db.media_by_path("/out/00242.png").unwrap().unwrap();
        let row = row.deviant_art.expect("still recorded");
        assert!(row.published, "a public deviation must not be demoted");
        assert_eq!(row.url.as_deref(), Some("https://d/1"), "nor lose its link");
    }

    #[test]
    fn marking_by_hand_sets_and_clears_the_badge() {
        // The back-fill path: pictures posted before anything recorded them.
        let db = Db::open_in_memory().expect("in-memory index");
        let folder = db.add_folder("/out", 1).expect("add folder");
        db.insert_media_batch(
            folder,
            &[
                file("/out/00242.png", MediaKind::Image, 300),
                file("/out/00239.png", MediaKind::Image, 200),
            ],
            1,
        )
        .expect("insert");
        let ids: Vec<i64> = ["/out/00242.png", "/out/00239.png"]
            .iter()
            .map(|path| db.media_by_path(path).unwrap().unwrap().id)
            .collect();

        assert_eq!(db.set_deviantart_posted(&ids, true).expect("mark"), 2);
        for path in ["/out/00242.png", "/out/00239.png"] {
            let row = db.media_by_path(path).unwrap().unwrap();
            let post = row.deviant_art.expect("marked");
            assert!(post.published);
            // Marked by hand knows the picture is up but not where. A link it
            // cannot know is worse than no link.
            assert_eq!(post.url, None);
        }

        assert_eq!(db.set_deviantart_posted(&ids[..1], false).expect("unmark"), 1);
        assert!(db.media_by_path("/out/00242.png").unwrap().unwrap().deviant_art.is_none());
        assert!(db.media_by_path("/out/00239.png").unwrap().unwrap().deviant_art.is_some());
    }

    #[test]
    fn the_deviantart_record_outlives_the_row_it_was_made_for() {
        // Keyed on the path and not on `media.id`, because the id does not
        // survive the index being rebuilt — and losing this would silently
        // un-post pictures that are demonstrably public.
        let path = tempfile::tempdir().unwrap().path().join("index.db");
        {
            let db = Db::open(&path).unwrap();
            let folder = db.add_folder("/out", 1).unwrap();
            db.insert_media_batch(folder, &[file("/out/00242.png", MediaKind::Image, 300)], 1)
                .unwrap();
            let id = db.media_by_path("/out/00242.png").unwrap().unwrap().id;
            db.set_deviantart_posted(&[id], true).unwrap();
            db.delete_media_by_path("/out/00242.png").unwrap();
        }

        // Re-indexed from scratch: new folder, new row, new id.
        let db = Db::open(&path).unwrap();
        let folder = db.add_folder("/out2", 1).unwrap();
        db.insert_media_batch(folder, &[file("/out/00242.png", MediaKind::Image, 300)], 1)
            .unwrap();
        assert!(
            db.media_by_path("/out/00242.png").unwrap().unwrap().deviant_art.is_some(),
            "the badge must survive a rebuild",
        );
    }

    #[test]
    fn the_hidden_original_is_still_reachable_by_path() {
        // It is in no list, so `media_by_path` is the only way the lightbox can
        // offer it. If this stops working the footer label goes nowhere.
        let db = Db::open_in_memory().expect("in-memory index");
        let folder = db.add_folder("/out", 1).expect("add folder");
        db.insert_media_batch(
            folder,
            &[
                file("/out/00118.png", MediaKind::Image, 300),
                file("/out/00118_upscaled_4k.png", MediaKind::Image, 200),
            ],
            1,
        )
        .expect("insert");

        let original = db.media_by_path("/out/00118.png").expect("lookup").expect("row");
        assert_eq!(original.name, "00118.png");
        assert_eq!(original.upscaled_from, None);
        assert!(db.media_by_path("/out/nope.png").expect("lookup").is_none());
    }

    #[test]
    fn a_variant_whose_original_was_never_indexed_still_shows() {
        // Upscale a folder, then stop watching the one the sources were in.
        // Hiding on a name that matches nothing would hide nothing, and the
        // variant must not disappear along with it.
        let db = Db::open_in_memory().expect("in-memory index");
        let folder = db.add_folder("/out", 1).expect("add folder");
        db.insert_media_batch(
            folder,
            &[file("/out/00118_upscaled_4k.png", MediaKind::Image, 200)],
            1,
        )
        .expect("insert");

        let page = db.query_media(&query()).expect("query");
        assert_eq!(page.total, 1);
    }

    #[test]
    fn filtering_by_longest_edge_reads_either_orientation() {
        // The filter the grid's 4K badge is paired with. Both have to agree, so
        // this pins the half that lives in SQL: the comparison is against the
        // *longer* side, because a library is not all landscape.
        let (db, _folder) = seeded();
        let pending = db.pending_dimensions(10).expect("queue");
        let by_path = |path: &str| pending.iter().find(|p| p.path == path).expect(path).id;

        // Landscape 4K, portrait 4K, and one below it.
        db.update_dimensions(by_path("/media/a.jpg"), 4000, 2500, None, None).unwrap();
        db.update_dimensions(by_path("/media/b.mp4"), 2160, 3840, None, None).unwrap();
        db.update_dimensions(by_path("/media/c_100%.png"), 1920, 1080, None, None).unwrap();

        let four_k = MediaQuery {
            min_longest_edge: Some(3840),
            ..query()
        };
        let page = db.query_media(&four_k).expect("query");
        let mut names: Vec<&str> = page.items.iter().map(|item| item.name.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["a.jpg", "b.mp4"], "portrait counts too");

        // And the filter absent means the filter is absent.
        assert_eq!(db.query_media(&query()).unwrap().total, 3);
    }

    #[test]
    fn an_unmeasured_row_cannot_claim_to_be_4k() {
        // Mid-scan a row has no dimensions. "At least 4K" is a claim, and a row
        // that has not been measured cannot support it — so it is excluded
        // rather than let through on a NULL comparison.
        let (db, _folder) = seeded();
        let four_k = MediaQuery {
            min_longest_edge: Some(3840),
            ..query()
        };
        assert_eq!(db.query_media(&four_k).unwrap().total, 0);
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
            fts_expression("(wide hips:1.3)", TEXT_COLUMNS).as_deref(),
            Some(r#"{name prompt} : ("(wide" AND "hips:1.3)")"#)
        );
        // A quote in the input must not end the quoted term.
        assert_eq!(
            fts_expression(r#"say "hi""#, TEXT_COLUMNS).as_deref(),
            Some(r#"{name prompt} : ("say" AND """hi""")"#)
        );
    }

    #[test]
    fn fts_expressions_drop_terms_the_trigram_index_cannot_answer() {
        // Trigram indexes three-character sequences, so a shorter term matches
        // nothing at all — silently returning zero results for `a girl` would
        // be worse than searching for `girl`.
        assert_eq!(
            fts_expression("a girl", TEXT_COLUMNS).as_deref(),
            Some(r#"{name prompt} : ("girl")"#)
        );
        assert_eq!(fts_expression("of", TEXT_COLUMNS), None);
        assert_eq!(fts_expression("   ", TEXT_COLUMNS), None);
    }

    #[test]
    fn the_column_filter_covers_every_term_not_only_the_first() {
        // FTS5 binds `{cols} : x AND y` to `x` alone, so an unparenthesised
        // expression would leave the second word of a two-word folder search
        // matching filenames and prompts — the mode leaking on exactly the
        // searches specific enough to be typed deliberately.
        assert_eq!(
            fts_expression("art moona", PATH_COLUMNS).as_deref(),
            Some(r#"{dir} : ("art" AND "moona")"#)
        );
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

    /// How many rows the folder-search mode finds for `text`.
    fn found_by_path(db: &Db, text: &str) -> i64 {
        let q = MediaQuery { search: text.to_string(), search_paths: true, ..query() };
        db.query_media(&q).unwrap().total
    }

    #[test]
    fn the_folder_mode_searches_the_directory_and_only_the_directory() {
        // A library filed by character, which is the layout this mode is for:
        // the term is in the path of every file in the folder and in the
        // prompt of most of them, so "did it match" is not enough to tell the
        // two modes apart. Each assertion below is one that fails if the
        // column filter is dropped or applied to the wrong set.
        let db = Db::open_in_memory().expect("in-memory index");
        let folder = db.add_folder("/media", 1).expect("add folder");
        db.insert_media_batch(
            folder,
            &[
                file("/media/aqua/00166-3997412987.png", MediaKind::Image, 1),
                file("/media/moona/00200-1234567890.png", MediaKind::Image, 2),
                // The name carries "moona" while the folder does not. This is
                // the row that catches a folder search still reading filenames.
                file("/media/misc/moona-wallpaper.png", MediaKind::Image, 3),
            ],
            1,
        )
        .expect("insert");
        // And a prompt naming a folder nothing is filed under, for the other
        // direction: the prompt must not answer a folder search either.
        let id = db
            .query_media(&MediaQuery { search: "00166".to_string(), ..query() })
            .unwrap()
            .items[0]
            .id;
        db.set_generation(
            id,
            Some(&crate::generated::Generation {
                tool: "Stable Diffusion".into(),
                prompt: Some("moona hoshinova, 1girl".to_string()),
                ..Default::default()
            }),
        )
        .expect("set generation");

        assert_eq!(found_by_path(&db, "aqua"), 1, "a folder name matches");
        // Two of the three rows say "moona" somewhere; exactly one says it in
        // its folder.
        assert_eq!(found(&db, "moona"), 2, "filename and prompt, as ever");
        assert_eq!(found_by_path(&db, "moona"), 1, "the folder, and nothing else");
        assert_eq!(found_by_path(&db, "wallpaper"), 0, "the filename is not the folder");
        assert_eq!(found_by_path(&db, "hoshinova"), 0, "and neither is the prompt");
        // A path fragment rather than one component, which is the point of
        // matching a substring of the whole directory.
        assert_eq!(found_by_path(&db, "media/moona"), 1, "a run of the path");
        // The default mode must not have quietly gained a third column.
        assert_eq!(found(&db, "misc"), 0, "the folder stays out of the plain search");
    }

    #[test]
    fn a_library_indexed_before_folder_search_gains_it_on_the_next_open() {
        // The upgrade every existing library takes, and the one nothing else
        // here covers: the in-memory cases all start at the current shape.
        //
        // `CREATE VIRTUAL TABLE IF NOT EXISTS` cannot widen an index that
        // already exists, and `CREATE TRIGGER IF NOT EXISTS` cannot widen what
        // feeds it. Without the version bump doing the dropping, an upgraded
        // library keeps a two-column index, keeps writing two columns into it,
        // and answers every folder search with nothing — while looking
        // completely healthy from the outside.
        let file = tempfile::NamedTempFile::new().expect("temp");
        let path = file.path().to_path_buf();
        drop(file);

        {
            let db = Db::open(&path).expect("open");
            let folder = db.add_folder("/media", 1).expect("add folder");
            db.insert_media_batch(
                folder,
                // Qualified, because the temp-file binding above shadows the
                // helper's name for the rest of this block.
                &[super::tests::file("/media/moona/00166.png", MediaKind::Image, 1)],
                1,
            )
            .expect("insert");

            // Rewound to exactly what the previous version left behind: no
            // `dir` column, a two-column index over it, and its own version
            // recorded so this open looks like the last one it did.
            let conn = db.conn.lock().unwrap();
            conn.execute_batch(
                "DROP TRIGGER media_fts_insert;
                 DROP TRIGGER media_fts_delete;
                 DROP TRIGGER media_fts_update;
                 DROP TABLE media_fts;
                 ALTER TABLE media DROP COLUMN dir;
                 CREATE VIRTUAL TABLE media_fts USING fts5(
                     name, prompt, content='media', content_rowid='id', tokenize='trigram');
                 CREATE TRIGGER media_fts_insert AFTER INSERT ON media BEGIN
                     INSERT INTO media_fts(rowid, name, prompt)
                     VALUES (new.id, new.name, new.prompt);
                 END;
                 INSERT INTO media_fts(media_fts) VALUES ('rebuild');
                 UPDATE settings SET value = '1-trigram-name-prompt'
                  WHERE key = 'fts_version';",
            )
            .expect("rewind to the previous shape");
        }

        let db = Db::open(&path).expect("reopen");
        assert_eq!(found_by_path(&db, "moona"), 1, "searchable without a rescan");
        assert_eq!(found(&db, "00166"), 1, "and the old search still answers");

        // Twice, because the "does this column exist" check is the trap: read
        // with `table_info` it never finds a generated column, and this open is
        // the one that would fail on a duplicate `dir`.
        drop(db);
        let db = Db::open(&path).expect("third open");
        assert_eq!(found_by_path(&db, "moona"), 1);
    }

    #[test]
    fn a_rule_added_after_the_scan_still_reaches_what_it_indexed() {
        // The case this exists for: files were indexed, *then* the directory
        // holding them joined the walk's ignore list. A rescan cannot fix that
        // — its pruning is a set difference against what the walk returned, and
        // the walk no longer reports the directory at all — so the rows would
        // sit in the grid forever.
        let db = Db::open_in_memory().expect("in-memory index");
        let folder = db.add_folder("/out", 1).expect("add folder");
        db.insert_media_batch(
            folder,
            &[
                file("/out/txt2img-images/2026-08-04/00166.png", MediaKind::Image, 1),
                file("/out/txt2img-grids/2026-08-04/grid-0008.png", MediaKind::Image, 2),
                file("/out/txt2img-grids/2026-08-05/grid-0009.png", MediaKind::Image, 3),
            ],
            1,
        )
        .expect("insert");

        let pruned = db
            .prune_media_where(crate::scan::is_in_ignored_dir)
            .expect("prune");
        assert_eq!(pruned.rows, 2);

        let left: Vec<String> = db
            .media_paths_in_folder(folder)
            .expect("paths")
            .into_iter()
            .collect();
        assert_eq!(left, vec!["/out/txt2img-images/2026-08-04/00166.png"]);

        // Idempotent: the second launch after a rule change has nothing to do,
        // which is what lets this run unconditionally at every startup.
        let again = db
            .prune_media_where(crate::scan::is_in_ignored_dir)
            .expect("prune");
        assert_eq!(again.rows, 0);
        assert!(again.keys.is_empty());
    }

    #[test]
    fn pruning_reports_the_content_keys_it_orphaned() {
        // Derived files are addressed by content, so the caller has to be told
        // which keys the dropped rows were using — it cannot work them out
        // afterwards, because the rows are gone.
        let db = Db::open_in_memory().expect("in-memory index");
        let folder = db.add_folder("/out", 1).expect("add folder");
        db.insert_media_batch(
            folder,
            &[file("/out/txt2img-grids/grid-0008.png", MediaKind::Image, 1)],
            1,
        )
        .expect("insert");
        let id = db.pending_dimensions(10).expect("queue")[0].id;
        db.update_dimensions(id, 2080, 3040, None, Some("deadbeef"))
            .expect("key");

        let pruned = db
            .prune_media_where(crate::scan::is_in_ignored_dir)
            .expect("prune");
        assert_eq!(pruned.rows, 1);
        assert_eq!(pruned.keys, vec!["deadbeef".to_string()]);
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
