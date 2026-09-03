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
