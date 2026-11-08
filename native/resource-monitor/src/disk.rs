//! Per-directory allocated size for the T3 home directory.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::Path;
use walkdir::WalkDir;

pub struct ScanResult {
    pub total_bytes: u64,
    /// Allocated bytes per path relative to the root, with `/` separators.
    pub entries: Vec<(String, u64)>,
}

#[cfg(unix)]
fn allocated_bytes(metadata: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    metadata.blocks() * 512
}

// Windows reports no block count, so apparent size stands in.
#[cfg(not(unix))]
fn allocated_bytes(metadata: &std::fs::Metadata) -> u64 {
    metadata.len()
}

#[cfg(unix)]
fn hardlink_identity(metadata: &std::fs::Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    (metadata.nlink() > 1).then(|| (metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn hardlink_identity(_metadata: &std::fs::Metadata) -> Option<(u64, u64)> {
    None
}

/// Sums allocated bytes under `root` like `du`: hardlinked files count once, symlinks are not
/// followed, and the walk stays on the root's filesystem. Unreadable entries are skipped.
/// APFS clones share blocks but report them per file, so macOS totals can overcount.
pub fn scan(root: &Path, depth: usize) -> io::Result<ScanResult> {
    std::fs::symlink_metadata(root)?;
    let mut seen_links = HashSet::new();
    let mut total_bytes = 0;
    let mut by_path: HashMap<String, u64> = HashMap::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .same_file_system(true)
    {
        let Ok(entry) = entry else {
            continue;
        };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let is_dir = metadata.is_dir();
        if !is_dir
            && let Some(identity) = hardlink_identity(&metadata)
            && !seen_links.insert(identity)
        {
            continue;
        }
        let bytes = allocated_bytes(&metadata);
        total_bytes += bytes;
        let Ok(relative) = entry.path().strip_prefix(root) else {
            continue;
        };
        // Directories are keyed down to `depth`, files one level shallower, so a folder of
        // thousands of files adds one key rather than thousands.
        let levels = if !is_dir && entry.depth() == depth {
            depth.saturating_sub(1)
        } else {
            depth
        };
        let mut key = String::new();
        for component in relative.components().take(levels) {
            if !key.is_empty() {
                key.push('/');
            }
            key.push_str(&component.as_os_str().to_string_lossy());
            *by_path.entry(key.clone()).or_insert(0) += bytes;
        }
    }
    Ok(ScanResult {
        total_bytes,
        entries: by_path.into_iter().collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const KIB: usize = 1024;

    fn write(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![1u8; bytes]).unwrap();
    }

    fn bytes_at(result: &ScanResult, path: &str) -> u64 {
        result
            .entries
            .iter()
            .find(|(candidate, _)| candidate == path)
            .map_or(0, |(_, bytes)| *bytes)
    }

    // Directory blocks and filesystem rounding add a little to every figure.
    fn assert_near(actual: u64, expected: usize) {
        let expected = expected as u64;
        assert!(
            actual >= expected && actual <= expected + 128 * KIB as u64,
            "{actual} is not within 128 KiB above {expected}"
        );
    }

    #[test]
    fn attributes_bytes_to_directories_and_counts_hardlinks_once() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(&root.join("userdata/attachments/photo.png"), 1024 * KIB);
        write(&root.join("userdata/statev2.sqlite"), 512 * KIB);
        write(&root.join("worktrees/repo/feature/big.bin"), 2048 * KIB);
        write(&root.join("worktrees/repo/other/small.bin"), 256 * KIB);
        #[cfg(unix)]
        {
            fs::hard_link(
                root.join("worktrees/repo/feature/big.bin"),
                root.join("worktrees/repo/feature/same-file.bin"),
            )
            .unwrap();
            // A link to a large directory must not be followed.
            std::os::unix::fs::symlink(
                root.join("userdata/attachments"),
                root.join("worktrees/repo/other/link"),
            )
            .unwrap();
        }

        let result = scan(root, 3).unwrap();

        assert_near(bytes_at(&result, "userdata/attachments"), 1024 * KIB);
        assert_near(bytes_at(&result, "userdata/statev2.sqlite"), 512 * KIB);
        assert_near(bytes_at(&result, "worktrees/repo/feature"), 2048 * KIB);
        assert_near(bytes_at(&result, "worktrees/repo/other"), 256 * KIB);
        assert!(result.total_bytes <= (1024 + 512 + 2048 + 256 + 512) as u64 * KIB as u64);
    }

    #[test]
    fn keys_files_only_above_the_deepest_level() {
        let temp = tempfile::tempdir().unwrap();
        write(&temp.path().join("a/b/c/deep.bin"), 64 * KIB);
        write(&temp.path().join("a/b/leaf.bin"), 64 * KIB);
        write(&temp.path().join("a/shallow.bin"), 64 * KIB);

        let result = scan(temp.path(), 3).unwrap();
        let paths: HashSet<&str> = result
            .entries
            .iter()
            .map(|(path, _)| path.as_str())
            .collect();

        assert!(paths.contains("a/b/c"));
        assert!(paths.contains("a/shallow.bin"));
        assert!(!paths.contains("a/b/leaf.bin"));
        assert!(!paths.contains("a/b/c/deep.bin"));
    }

    #[test]
    fn fails_for_a_missing_root() {
        let temp = tempfile::tempdir().unwrap();
        assert!(scan(&temp.path().join("missing"), 3).is_err());
    }
}
