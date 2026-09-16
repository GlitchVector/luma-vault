//! Sets: the pictures one command run made, recorded so they can be found
//! together again.
//!
//! A `/shotall` is sixteen angles of one character; a `/photostory` is a shoot
//! in stages. Both land in the same dated Forge output folder as everything
//! else rendered that day, interleaved with unrelated work, and nothing on the
//! files themselves says they belong together — the prompts differ by design,
//! and the seeds are reused across a bracket, so neither can be the key.
//!
//! So the run says so, in a file it writes beside the pictures:
//!
//! ```text
//! …/txt2img-images/2026-09-03/
//!   00905-4090734728.png
//!   00906-1590191850.png
//!   .luma-sets/
//!     shotall-alexstrasza-20260903T1431-7f3a.json
//! ```
//!
//! **A file rather than a call into the app.** The queue drains when the GPU is
//! free, which is the middle of the night by design — there may be no app
//! running to tell, and a set that only exists in a database is lost the next
//! time the index is rebuilt. A manifest on disk survives both, and is re-read
//! by every scan.
//!
//! **Members are bare filenames, resolved against the manifest's own folder.**
//! Two reasons, and either alone would be enough. Forge names its own output
//! (`00905-4090734728.png`) and never tells the API what it called it, so a run
//! cannot write paths it chose. And the two machines disagree about what the
//! path *is*: Forge reports `X:/AI/Stable Diffusion/outputs/…` while the vault
//! indexes the same tree as `\\jebpot\devs\AI\Stable Diffusion\outputs\…`. A
//! name relative to the manifest is the one form both agree on.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The directory a run writes its manifest into, beside the pictures.
pub const MANIFEST_DIR: &str = ".luma-sets";

/// One command run, as its manifest describes it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SetManifest {
    /// Unique across the library, and stable across re-reads: the run names
    /// itself once and appends to the same file as it goes.
    pub run: String,
    /// The command that made it — `shotall`, `photostory`.
    pub command: String,
    /// Who it is of, when the run knows. The sidebar groups by this, and a run
    /// that cannot name a character still lists under "Other".
    #[serde(default)]
    pub character: Option<String>,
    /// What to call it in a list. Absent is fine — the command and the time
    /// make a serviceable name without one.
    #[serde(default)]
    pub title: Option<String>,
    /// When the run started, unix ms.
    pub created_at: i64,
    #[serde(default)]
    pub members: Vec<SetMember>,
}

/// One picture of a run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SetMember {
    /// The file's name in the folder above the manifest. A name, never a path:
    /// see the module note.
    pub file: String,
    /// What the run called this shot — "from below", "stage 3 — undressed".
    #[serde(default)]
    pub label: Option<String>,
}

/// Is this the manifest of a set?
///
/// By its folder, not by its name. A run names its file after itself so two
/// runs on the same day cannot collide, which means the name cannot also be a
/// marker — and a stray `.json` dropped into an output folder must not be read
/// as one.
pub fn is_manifest(path: &Path) -> bool {
    path.extension().and_then(|ext| ext.to_str()).map(str::to_lowercase).as_deref() == Some("json")
        && path
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(MANIFEST_DIR))
}

/// Read a manifest, and say where its pictures are.
///
/// Returns the manifest and the absolute path of each member, in the order the
/// run recorded them — which is the order it shot them, and the order a set
/// should be read in. A member naming anything but a plain filename is dropped
/// rather than resolved: this turns a string from a file into a path the
/// indexer will look up, and `../../` in it has no honest reading.
pub fn read_manifest(path: &Path) -> Result<(SetManifest, Vec<(PathBuf, SetMember)>), String> {
    let text = std::fs::read_to_string(path).map_err(|error| format!("{error}"))?;
    let manifest: SetManifest =
        serde_json::from_str(&text).map_err(|error| format!("unreadable manifest: {error}"))?;
    if manifest.run.trim().is_empty() {
        return Err("manifest names no run".to_string());
    }

    // `.luma-sets/<run>.json` → the folder holding the pictures.
    let Some(folder) = path.parent().and_then(Path::parent) else {
        return Err("manifest is not inside a folder".to_string());
    };

    let members = manifest
        .members
        .iter()
        .filter(|member| is_plain_filename(&member.file))
        .map(|member| (folder.join(&member.file), member.clone()))
        .collect();

    Ok((manifest, members))
}

/// Rewrite a manifest with its members in a new order.
///
/// Members are named by file, and every name given must already be in the
/// manifest: this reorders what a run recorded, it does not add to it or remove
/// from it. Anything the caller does not mention keeps its relative position at
/// the end, so a manifest that grew between the app reading it and the user
/// dragging something is not quietly truncated.
pub fn reorder_members(manifest: &SetManifest, order: &[String]) -> SetManifest {
    let mut moved: Vec<SetMember> = Vec::with_capacity(manifest.members.len());
    for name in order {
        if let Some(member) = manifest.members.iter().find(|each| &each.file == name) {
            if !moved.iter().any(|each| each.file == member.file) {
                moved.push(member.clone());
            }
        }
    }
    for member in &manifest.members {
        if !moved.iter().any(|each| each.file == member.file) {
            moved.push(member.clone());
        }
    }
    SetManifest {
        members: moved,
        ..manifest.clone()
    }
}

/// Write a manifest, atomically.
///
/// Temp file then rename, and the rename is the point rather than tidiness. The
/// app's own watcher is live on this folder, and three STATUS_HEAP_CORRUPTION
/// exits all happened while manifests were being rewritten under it — one of
/// them by a render script that rewrote its manifest forty times in an
/// afternoon. A rename is one event and can never be observed half-written; a
/// truncate-and-write is at least two and can be.
///
/// The temp file is created in the same directory so the rename stays on one
/// filesystem, and it is named to be ignored by [`is_manifest`] — otherwise the
/// watcher would read the half-written file we are trying to hide from it.
pub fn write_manifest(path: &Path, manifest: &SetManifest) -> Result<(), String> {
    let Some(dir) = path.parent() else {
        return Err("manifest has no directory".to_string());
    };
    std::fs::create_dir_all(dir).map_err(|error| format!("{error}"))?;

    let text = serde_json::to_string_pretty(manifest)
        .map_err(|error| format!("cannot serialise manifest: {error}"))?;

    // `.tmp`, not `.json`: `is_manifest` matches on the extension, so a `.json`
    // temp beside the real one would be read as a second set of the same run.
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text.as_bytes()).map_err(|error| format!("{error}"))?;
    std::fs::rename(&temp, path).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("{error}")
    })
}

/// A name that names a file in one folder, and cannot mean anywhere else.
fn is_plain_filename(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains(':')
        && name != "."
        && name != ".."
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_json() -> &'static str {
        r#"{
            "run": "shotall-alexstrasza-20260903T1431-7f3a",
            "command": "shotall",
            "character": "alexstrasza",
            "title": "Alexstrasza — every angle",
            "createdAt": 1772547060000,
            "members": [
                { "file": "00905-4090734728.png", "label": "from below" },
                { "file": "00906-1590191850.png" }
            ]
        }"#
    }

    #[test]
    fn a_manifest_is_recognised_by_its_folder_not_its_name() {
        assert!(is_manifest(Path::new("/out/2026-09-03/.luma-sets/run.json")));
        // The name is the run's, so it cannot also be the marker.
        assert!(!is_manifest(Path::new("/out/2026-09-03/run.json")));
        assert!(!is_manifest(Path::new("/out/2026-09-03/.luma-sets/notes.txt")));
        assert!(!is_manifest(Path::new("/out/.luma-sets")));
    }

    #[test]
    fn members_resolve_against_the_folder_above_the_manifest() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sets = dir.path().join("2026-09-03").join(MANIFEST_DIR);
        std::fs::create_dir_all(&sets).expect("create");
        let path = sets.join("run.json");
        std::fs::write(&path, manifest_json()).expect("write");

        let (manifest, members) = read_manifest(&path).expect("readable");
        assert_eq!(manifest.command, "shotall");
        assert_eq!(manifest.character.as_deref(), Some("alexstrasza"));
        assert_eq!(members.len(), 2);
        assert_eq!(members[0].0, dir.path().join("2026-09-03").join("00905-4090734728.png"));
        assert_eq!(members[0].1.label.as_deref(), Some("from below"));
        // Order is the run's, because it is the order the pictures were shot.
        assert_eq!(members[1].0.file_name().unwrap(), "00906-1590191850.png");
    }

    #[test]
    fn a_member_cannot_name_a_file_outside_the_folder() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sets = dir.path().join("2026-09-03").join(MANIFEST_DIR);
        std::fs::create_dir_all(&sets).expect("create");
        let path = sets.join("run.json");
        std::fs::write(
            &path,
            r#"{"run":"r","command":"shotall","createdAt":1,"members":[
                {"file":"../../../etc/passwd"},
                {"file":"sub/nested.png"},
                {"file":"C:/Windows/win.ini"},
                {"file":".."},
                {"file":"good.png"}
            ]}"#,
        )
        .expect("write");

        let (_, members) = read_manifest(&path).expect("readable");
        let names: Vec<_> =
            members.iter().map(|(path, _)| path.file_name().unwrap().to_owned()).collect();
        assert_eq!(names, vec!["good.png"], "only plain filenames may resolve");
    }

    #[test]
    fn reordering_moves_named_members_and_keeps_the_rest() {
        let manifest = SetManifest {
            run: "r".into(),
            command: "shotall".into(),
            character: None,
            title: None,
            created_at: 1,
            members: vec![
                SetMember { file: "a.png".into(), label: None },
                SetMember { file: "b.png".into(), label: Some("two".into()) },
                SetMember { file: "c.png".into(), label: None },
            ],
        };

        let moved = reorder_members(&manifest, &["c.png".to_string(), "a.png".to_string()]);
        let names: Vec<&str> = moved.members.iter().map(|m| m.file.as_str()).collect();
        // b was not named, so it keeps its place at the end rather than vanishing:
        // a manifest that grew since the app read it must not be truncated.
        assert_eq!(names, vec!["c.png", "a.png", "b.png"]);
        assert_eq!(moved.members[2].label.as_deref(), Some("two"));
        assert_eq!(moved.run, "r");
    }

    #[test]
    fn reordering_ignores_a_name_the_manifest_does_not_have() {
        let manifest = SetManifest {
            run: "r".into(),
            command: "shotall".into(),
            character: None,
            title: None,
            created_at: 1,
            members: vec![SetMember { file: "a.png".into(), label: None }],
        };
        let moved = reorder_members(&manifest, &["ghost.png".to_string(), "a.png".to_string()]);
        assert_eq!(moved.members.len(), 1);
        assert_eq!(moved.members[0].file, "a.png");
    }

    #[test]
    fn writing_round_trips_and_leaves_no_temp_behind() {
        let dir = std::env::temp_dir().join(format!("luma-sets-write-{}", std::process::id()));
        let manifest_dir = dir.join(MANIFEST_DIR);
        std::fs::create_dir_all(&manifest_dir).expect("dirs");
        let path = manifest_dir.join("r.json");

        let manifest = SetManifest {
            run: "r".into(),
            command: "photostory".into(),
            character: Some("Mira".into()),
            title: Some("set 042".into()),
            created_at: 7,
            members: vec![SetMember { file: "a.png".into(), label: Some("one".into()) }],
        };
        write_manifest(&path, &manifest).expect("write");

        let (back, members) = read_manifest(&path).expect("read");
        assert_eq!(back, manifest);
        assert_eq!(members.len(), 1);
        // The temp must not survive, and must never have looked like a manifest.
        assert!(!manifest_dir.join("r.json.tmp").exists());
        assert!(!is_manifest(&manifest_dir.join("r.json.tmp")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_damaged_manifest_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sets = dir.path().join(MANIFEST_DIR);
        std::fs::create_dir_all(&sets).expect("create");

        let truncated = sets.join("truncated.json");
        std::fs::write(&truncated, r#"{"run":"r","command":"shot"#).expect("write");
        assert!(read_manifest(&truncated).is_err());

        let anonymous = sets.join("anonymous.json");
        std::fs::write(&anonymous, r#"{"run":"  ","command":"shotall","createdAt":1}"#)
            .expect("write");
        assert!(read_manifest(&anonymous).is_err(), "a run with no name cannot be recorded");
    }
}
