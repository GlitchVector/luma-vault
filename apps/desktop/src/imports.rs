//! Importing ratings from a Stable Diffusion Image Browser database.
//!
//! The AUTOMATIC1111 "Image Browser" extension keeps a SQLite file — `wib.sqlite3`
//! — beside itself, holding a `ranking` table of 1-5 star ratings the user gave
//! their generations. That judgement exists nowhere else: it is not in the PNG,
//! so unlike the prompt and the seed it cannot be recovered from the file.
//! Everything else that database stores *is* in the file, which is why only the
//! ratings are read here.
//!
//! # Why this stages rather than applies
//!
//! Ratings are recorded against absolute paths from wherever the webui lived at
//! the time. By the time anyone imports one, that tree has usually been archived
//! to another drive, and the folder it now lives in may not have been scanned
//! yet. So an import writes to `imported_stars` keyed by the part of the path
//! that survives a move, and rows collect their rating as they are indexed.
//!
//! # What to expect from a real database
//!
//! Measured against two, from installs going back to 2023:
//!
//! ```text
//!            ratings   files that still exist
//! E_webui      2,204                    2,204   (100%)
//! __big        5,309                      838   (15.8%)
//! ```
//!
//! The gap is not a matching failure. Those files were rated, curated, and then
//! deleted on purpose. An import that names a file which no longer exists is
//! the normal case, not an error — the row costs nothing and is simply never
//! claimed.

use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::db::Db;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    /// Ratings found in the source database.
    pub found: i64,
    /// Ratings staged — those whose path could be reduced to a match key.
    pub staged: i64,
    /// Rows in *this* library that gained a rating as a result, right now.
    /// The rest attach later, as the folders they name are scanned.
    pub applied: i64,
    /// Rows skipped because their path had no recognisable `outputs` segment.
    pub unrecognised: i64,
}

/// Import every rating database a scan turned up, skipping ones already read.
///
/// Called from the glob phase rather than left to a button, because these files
/// live *inside* the folders being scanned — the extension keeps its database
/// next to itself, under the webui it belongs to. Anyone adding a Stable
/// Diffusion output folder is adding its ratings at the same time, and having
/// to know that and go looking for a `.sqlite3` afterwards is a step that
/// should not exist.
///
/// Never fatal. A database that cannot be read, or turns out not to be an
/// Image Browser database at all, is one log line and nothing else: this runs
/// on every scan of every folder, and a bad file must not cost a library its
/// scan.
pub fn import_discovered(db: &Db, found: &[std::path::PathBuf], now: i64) -> u64 {
    let mut staged_total = 0;
    for path in found {
        let Ok(metadata) = std::fs::metadata(path) else {
            continue;
        };
        let size = metadata.len() as i64;
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);
        let key = path.to_string_lossy().to_string();

        match db.database_already_imported(&key, size, modified) {
            Ok(true) => continue,
            Ok(false) => {}
            Err(_) => continue,
        }

        match import_image_browser(db, path, now) {
            Ok(summary) => {
                eprintln!(
                    "[luma] imported {} ratings from {} ({} applied now)",
                    summary.staged,
                    path.display(),
                    summary.applied
                );
                staged_total += summary.staged as u64;
                let _ = db.record_database_import(&key, size, modified, summary.staged, now);
            }
            Err(error) => {
                // Deliberately *not* recorded. Marking a failure as done means
                // it is never retried, and the reasons an import fails are
                // mostly transient or fixable: an unreachable share, a file
                // being written, a bug in this code. Exactly that happened —
                // extended-length paths failed to open, were recorded as
                // imported, and would have stayed silently empty forever.
                //
                // The cost of retrying is one failed open per scan, which is
                // also what any other `wib*.sqlite3` on disk costs.
                eprintln!("[luma] not importing {}: {error:#}", path.display());
            }
        }
    }
    staged_total
}

/// Read the `ranking` table out of an Image Browser database and stage it.
///
/// Opened read-only and never written to: this is somebody's live application
/// data, and an import must not be able to damage it.
pub fn import_image_browser(db: &Db, source: &Path, now: i64) -> Result<ImportSummary> {
    if !source.is_file() {
        anyhow::bail!("no such file: {}", source.display());
    }

    // A plain path, not a `file:` URI.
    //
    // The index stores canonicalized paths, which on Windows means the
    // extended-length form `\\?\UNC\server\share\...`. Pasting that into a URI
    // produces `file://?/UNC/...`, which SQLite rejects outright — and the
    // read-only guarantee the URI was there for is what the flag already says.
    //
    // Third time this prefix has caught something: ffmpeg misdetects the
    // container through it and the Windows shell cannot resolve it at all. See
    // `paths::external_path`.
    let readable = crate::paths::external_path(&source.to_string_lossy());
    let conn = rusqlite::Connection::open_with_flags(
        &readable,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .with_context(|| format!("cannot open {}", source.display()))?;

    let has_ranking: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='ranking'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;
    if !has_ranking {
        anyhow::bail!(
            "{} has no `ranking` table — is it a Stable Diffusion Image Browser database?",
            source.display()
        );
    }

    let mut stmt = conn.prepare("SELECT file, ranking FROM ranking")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    let mut entries: Vec<(String, i64)> = Vec::new();
    let mut found = 0_i64;
    let mut unrecognised = 0_i64;
    for row in rows.filter_map(Result::ok) {
        let (file, ranking) = row;
        // The extension stores the rating as text and writes "None" for
        // cleared ones, so this is a parse rather than a cast.
        let stars = match ranking.trim().parse::<i64>() {
            Ok(stars) if (1..=5).contains(&stars) => stars,
            _ => continue,
        };
        found += 1;
        match crate::db::outputs_match_key(&file) {
            Some(key) => entries.push((key, stars)),
            None => unrecognised += 1,
        }
    }

    let label = source.to_string_lossy().to_string();
    let staged = db.stage_imported_stars(&entries, &label, now)? as i64;
    let applied = db.apply_all_imported_stars()? as i64;

    Ok(ImportSummary {
        found,
        staged,
        applied,
        unrecognised,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a miniature Image Browser database on disk.
    fn fake_wib(dir: &Path, rows: &[(&str, &str)]) -> std::path::PathBuf {
        let path = dir.join("wib.sqlite3");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE ranking (file TEXT, name TEXT, ranking TEXT,
                                   created TEXT, updated TEXT);",
        )
        .unwrap();
        for (file, ranking) in rows {
            conn.execute(
                "INSERT INTO ranking (file, name, ranking) VALUES (?1, ?2, ?3)",
                rusqlite::params![file, "n.png", ranking],
            )
            .unwrap();
        }
        drop(conn);
        path
    }

    #[test]
    fn stars_survive_the_tree_being_moved_and_renamed() {
        let dir = tempfile::tempdir().unwrap();
        // Exactly the shape a real database records: an absolute path into an
        // install directory that no longer exists under that name.
        let source = fake_wib(
            dir.path(),
            &[
                (r"D:\Development\__big_stable-diffusion-webui\outputs\txt2img-images\2023-05-08\00043-2571709213.png", "5"),
                (r"D:\Development\stable-diffusion-webui\outputs\txt2img-images\2023-10-25\00041-3764052225.png", "4"),
                // Cleared and out-of-range ratings are not ratings.
                (r"D:\Development\stable-diffusion-webui\outputs\txt2img-images\2023-10-25\00099-1.png", "None"),
                (r"D:\Development\stable-diffusion-webui\outputs\txt2img-images\2023-10-25\00098-2.png", "0"),
                // Nothing recognisable to key on.
                (r"C:\Users\someone\Pictures\holiday.png", "5"),
            ],
        );

        let db = Db::open_in_memory().unwrap();
        let folder = db.add_folder("/archive", 1).unwrap();
        db.insert_media_batch(
            folder,
            &[
                // The same two files, now on another drive, under an install
                // directory that was renamed on the way.
                crate::db::ScannedFile {
                    path: r"X:\AI\backups\__big_stable-diffusion-webui\outputs\txt2img-images\2023-05-08\00043-2571709213.png".into(),
                    name: "00043-2571709213.png".into(),
                    kind: crate::types::MediaKind::Image,
                    size_bytes: 1,
                    modified_at: 1,
                },
                crate::db::ScannedFile {
                    path: r"X:\AI\backups\E_stable-diffusion-webui\outputs\txt2img-images\2023-10-25\00041-3764052225.png".into(),
                    name: "00041-3764052225.png".into(),
                    kind: crate::types::MediaKind::Image,
                    size_bytes: 1,
                    modified_at: 2,
                },
            ],
            1,
        )
        .unwrap();

        let summary = import_image_browser(&db, &source, 10).unwrap();
        assert_eq!(summary.found, 3, "'None' and '0' are not ratings");
        assert_eq!(summary.unrecognised, 1, "the holiday photo has no outputs segment");
        assert_eq!(summary.staged, 2);
        assert_eq!(summary.applied, 2, "both indexed rows claimed their rating");

        let page = db
            .query_media(&crate::types::MediaQuery {
                min_stars: Some(5),
                ..test_query()
            })
            .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].stars, Some(5));
    }

    #[test]
    fn a_rating_waits_for_the_scan_that_gives_it_a_row() {
        // The order this is actually used in: import first, scan later.
        let dir = tempfile::tempdir().unwrap();
        let source = fake_wib(
            dir.path(),
            &[(r"D:\old\webui\outputs\txt2img-images\2023-01-01\00001-42.png", "4")],
        );

        let db = Db::open_in_memory().unwrap();
        let summary = import_image_browser(&db, &source, 10).unwrap();
        assert_eq!(summary.staged, 1);
        assert_eq!(summary.applied, 0, "nothing indexed yet to apply it to");

        let folder = db.add_folder("/archive", 1).unwrap();
        db.insert_media_batch(
            folder,
            &[crate::db::ScannedFile {
                path: r"E:\archive\webui\outputs\txt2img-images\2023-01-01\00001-42.png".into(),
                name: "00001-42.png".into(),
                kind: crate::types::MediaKind::Image,
                size_bytes: 1,
                modified_at: 1,
            }],
            1,
        )
        .unwrap();

        let id = db.query_media(&test_query()).unwrap().items[0].id;
        assert!(db
            .apply_imported_stars(
                id,
                r"E:\archive\webui\outputs\txt2img-images\2023-01-01\00001-42.png"
            )
            .unwrap());
        assert_eq!(db.media_by_id(id).unwrap().unwrap().stars, Some(4));
    }

    #[test]
    fn an_import_never_overwrites_a_rating_made_here() {
        let dir = tempfile::tempdir().unwrap();
        let source = fake_wib(
            dir.path(),
            &[(r"D:\old\webui\outputs\txt2img-images\2023-01-01\00001-42.png", "1")],
        );
        let db = Db::open_in_memory().unwrap();
        let folder = db.add_folder("/archive", 1).unwrap();
        db.insert_media_batch(
            folder,
            &[crate::db::ScannedFile {
                path: r"E:\webui\outputs\txt2img-images\2023-01-01\00001-42.png".into(),
                name: "00001-42.png".into(),
                kind: crate::types::MediaKind::Image,
                size_bytes: 1,
                modified_at: 1,
            }],
            1,
        )
        .unwrap();
        let id = db.query_media(&test_query()).unwrap().items[0].id;
        db.set_stars(id, Some(5)).unwrap();

        import_image_browser(&db, &source, 10).unwrap();
        assert_eq!(
            db.media_by_id(id).unwrap().unwrap().stars,
            Some(5),
            "an old 1-star from a 2023 install must not undo a 5-star given here"
        );
    }

    #[cfg(windows)]
    #[test]
    fn an_extended_length_path_can_still_be_opened() {
        // The index stores canonicalized paths, so this is the *only* form a
        // discovered database ever arrives in. Building a `file:` URI out of
        // one produced `file://?/UNC/...` and SQLite answered "invalid uri" —
        // every rating on a network share silently failed to import while the
        // scan reported success.
        let dir = tempfile::tempdir().unwrap();
        let source = fake_wib(
            dir.path(),
            &[(r"D:\webui\outputs\txt2img-images\2023-01-01\00001-42.png", "5")],
        );
        let extended = std::path::PathBuf::from(format!(r"\\?\{}", source.display()));
        assert!(extended.is_file(), "the prefixed path must still resolve");

        let db = Db::open_in_memory().unwrap();
        let summary = import_image_browser(&db, &extended, 1).expect("opens through the prefix");
        assert_eq!(summary.staged, 1);
    }

    #[test]
    fn a_database_that_is_not_an_image_browser_is_refused_clearly() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("something-else.sqlite3");
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch("CREATE TABLE unrelated (a TEXT)")
            .unwrap();
        let db = Db::open_in_memory().unwrap();
        let error = import_image_browser(&db, &path, 1).unwrap_err().to_string();
        assert!(error.contains("ranking"), "{error}");
    }

    fn test_query() -> crate::types::MediaQuery {
        crate::types::MediaQuery {
            folder_id: None,
            kind: None,
            rating: None,
            set: None,
            sexy_only: false,
            search: String::new(),
            search_paths: false,
            tag: None,
            min_stars: None,
            max_stars: None,
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
            sort: crate::types::SortOrder::Recent,
            limit: 100,
            offset: 0,
        }
    }
}
