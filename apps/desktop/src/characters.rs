//! The Characters page's own data: the characters the owner created by hand.
//!
//! One JSON file under the app's data directory, not a table in the index.
//! The index is a rebuildable cache - deleting `index.db` and rescanning is a
//! supported way to recover from a bad scan - and these are the owner's own
//! words, which nothing could rebuild. A file also reads and diffs by eye.
//!
//! The LoRAs a character names live in the catalogue (`packages/core/src/
//! loras.ts`); this module stores their names and never checks them, so a
//! LoRA renamed or retired there shows on her card as missing rather than
//! making the file unreadable.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};

use crate::types::{CustomCharacter, CustomCharacterInput};

/// Read-modify-write of one small file: a lock rather than a database. Two
/// windows saving at once (the desktop and a phone on the LAN) would
/// otherwise each write back the list they read, and one edit would vanish.
static WRITE: Mutex<()> = Mutex::new(());

pub fn file(data_dir: &Path) -> PathBuf {
    data_dir.join("characters.json")
}

/// Every character, oldest first. A missing file is no characters yet.
pub fn list(path: &Path) -> Result<Vec<CustomCharacter>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(path).with_context(|| format!("could not read {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("{} is not a list of characters", path.display()))
}

/// Lower-case letters, digits and dashes from the name; `character` when the
/// name has none of those (a name in another script), then `-2`, `-3` until free.
fn new_id(name: &str, taken: &[CustomCharacter]) -> String {
    let mut base = String::new();
    for c in name.trim().chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            base.push(c);
        } else if !base.ends_with('-') && !base.is_empty() {
            base.push('-');
        }
    }
    let base = base.trim_end_matches('-').to_string();
    let base = if base.is_empty() { "character".to_string() } else { base };
    let free = |id: &str| taken.iter().all(|c| c.id != id);
    if free(&base) {
        return base;
    }
    (2..).map(|n| format!("{base}-{n}")).find(|id| free(id)).expect("an unbounded range always finds a free id")
}

fn write(path: &Path, characters: &[CustomCharacter]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("could not create {}", parent.display()))?;
    }
    // Written beside and renamed over: a crash mid-write leaves the old file,
    // never half of a new one.
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_string_pretty(characters)? + "\n")
        .with_context(|| format!("could not write {}", temp.display()))?;
    std::fs::rename(&temp, path).with_context(|| format!("could not replace {}", path.display()))
}

/// Create her (no id) or replace her fields (her id). The default LoRA is
/// never also listed among her others.
pub fn save(path: &Path, input: CustomCharacterInput, now: i64) -> Result<CustomCharacter> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        anyhow::bail!("a character needs a name");
    }
    let default_lora = input.default_lora.trim().to_string();
    if default_lora.is_empty() {
        anyhow::bail!("pick the LoRA that renders her by default");
    }
    let mut loras: Vec<String> = Vec::new();
    for lora in input.loras.iter().map(|l| l.trim()) {
        if !lora.is_empty() && lora != default_lora && !loras.iter().any(|l| l == lora) {
            loras.push(lora.to_string());
        }
    }

    let _guard = WRITE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut all = list(path)?;
    let saved = match input.id {
        Some(id) => {
            let existing = all
                .iter_mut()
                .find(|c| c.id == id)
                .with_context(|| format!("there is no character \"{id}\" any more"))?;
            existing.name = name;
            existing.description = input.description.trim().to_string();
            existing.default_lora = default_lora;
            existing.loras = loras;
            existing.updated_at = now;
            existing.clone()
        }
        None => {
            if all.iter().any(|c| c.name.eq_ignore_ascii_case(&name)) {
                anyhow::bail!("there is already a character called \"{name}\"");
            }
            let created = CustomCharacter {
                id: new_id(&name, &all),
                name,
                description: input.description.trim().to_string(),
                default_lora,
                loras,
                created_at: now,
                updated_at: now,
            };
            all.push(created.clone());
            created
        }
    };
    write(path, &all)?;
    Ok(saved)
}

/// Forget her. Her LoRAs stay in the catalogue; only the card goes.
pub fn remove(path: &Path, id: &str) -> Result<bool> {
    let _guard = WRITE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut all = list(path)?;
    let before = all.len();
    all.retain(|c| c.id != id);
    if all.len() == before {
        return Ok(false);
    }
    write(path, &all)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str, default_lora: &str, loras: &[&str]) -> CustomCharacterInput {
        CustomCharacterInput {
            id: None,
            name: name.into(),
            description: "  white bob  ".into(),
            default_lora: default_lora.into(),
            loras: loras.iter().map(|l| l.to_string()).collect(),
        }
    }

    #[test]
    fn creates_edits_and_removes_a_character() {
        let dir = tempfile::tempdir().unwrap();
        let path = file(dir.path());
        assert!(list(&path).unwrap().is_empty());

        let ari = save(&path, input("Ari", "ari_gen_v5", &["ari_gen_space_dress_s1", "ari_gen_v5", "ari_gen_space_dress_s1"]), 10).unwrap();
        assert_eq!(ari.id, "ari");
        assert_eq!(ari.description, "white bob");
        // The default is not repeated among her others, and nothing is listed twice.
        assert_eq!(ari.loras, vec!["ari_gen_space_dress_s1".to_string()]);

        let mut edit = input("Ari Vale", "ari_gen_v6", &["ari_gen_space_leotard_s1"]);
        edit.id = Some("ari".into());
        let edited = save(&path, edit, 20).unwrap();
        assert_eq!((edited.id.as_str(), edited.name.as_str(), edited.created_at, edited.updated_at), ("ari", "Ari Vale", 10, 20));
        assert_eq!(list(&path).unwrap(), vec![edited]);

        assert!(remove(&path, "ari").unwrap());
        assert!(!remove(&path, "ari").unwrap());
        assert!(list(&path).unwrap().is_empty());
    }

    #[test]
    fn ids_are_unique_and_names_are_required() {
        let dir = tempfile::tempdir().unwrap();
        let path = file(dir.path());
        save(&path, input("Mira Solen", "mirasolen_v2", &[]), 1).unwrap();
        assert!(save(&path, input("mira solen", "mirasolen_v2", &[]), 2).is_err(), "the same name twice");
        let taken = list(&path).unwrap();
        assert_eq!(new_id("Mira  Solen!", &taken), "mira-solen-2");
        assert_eq!(new_id("ミラ", &taken), "character");
        assert!(save(&path, input("   ", "mirasolen_v2", &[]), 3).is_err());
        assert!(save(&path, input("Kira", " ", &[]), 3).is_err());
        let mut ghost = input("Ghost", "x_v1", &[]);
        ghost.id = Some("nobody".into());
        assert!(save(&path, ghost, 4).is_err(), "an edit of a character that is gone");
    }
}
