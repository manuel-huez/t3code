//! Disk space and per-directory allocated size for the T3 home directory.

use ignore::{DirEntry, ParallelVisitor, ParallelVisitorBuilder, WalkBuilder, WalkState};
use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Set when the server closes our stdin, so a running walk stops instead of outliving it.
pub static SHUTDOWN: AtomicBool = AtomicBool::new(false);

const MAX_SCAN_THREADS: usize = 8;

#[derive(Debug, PartialEq, Eq)]
pub struct VolumeSpace {
    pub total_bytes: u64,
    pub available_bytes: u64,
}

pub struct ScanResult {
    pub total_bytes: u64,
    /// Allocated bytes per path relative to the root, with `/` separators.
    pub entries: Vec<(String, u64)>,
}

/// Asks the kernel about `path` itself. Mount-point matching would report macOS's sealed system
/// volume instead of the data volume, because firmlinks hide the real mount from the path.
#[cfg(unix)]
pub fn volume_space(path: &Path) -> Option<VolumeSpace> {
    let stats = rustix::fs::statvfs(path).ok()?;
    let block_size = if stats.f_frsize > 0 {
        stats.f_frsize
    } else {
        stats.f_bsize
    };
    Some(VolumeSpace {
        total_bytes: stats.f_blocks.saturating_mul(block_size),
        available_bytes: stats.f_bavail.saturating_mul(block_size),
    })
}

#[cfg(not(unix))]
pub fn volume_space(path: &Path) -> Option<VolumeSpace> {
    let canonical = path.canonicalize().ok()?;
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let disk = disks
        .list()
        .iter()
        .filter(|disk| canonical.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())?;
    Some(VolumeSpace {
        total_bytes: disk.total_space(),
        available_bytes: disk.available_space(),
    })
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

#[derive(Default)]
struct Totals {
    total_bytes: u64,
    by_path: HashMap<String, u64>,
}

struct Shared {
    root: PathBuf,
    depth: usize,
    seen_links: Mutex<HashSet<(u64, u64)>>,
    totals: Mutex<Totals>,
}

struct Visitor {
    shared: Arc<Shared>,
    local: Totals,
}

impl Visitor {
    fn add(&mut self, entry: &DirEntry, bytes: u64, is_dir: bool) {
        self.local.total_bytes += bytes;
        let Ok(relative) = entry.path().strip_prefix(&self.shared.root) else {
            return;
        };
        // Directories are keyed down to `depth`, files one level shallower, so a folder of
        // thousands of files adds one key rather than thousands.
        let own_depth = entry.depth();
        let mut key = String::new();
        for (index, component) in relative.components().enumerate() {
            let level = index + 1;
            if level > self.shared.depth
                || (level == own_depth && !is_dir && level == self.shared.depth)
            {
                break;
            }
            if !key.is_empty() {
                key.push('/');
            }
            key.push_str(&component.as_os_str().to_string_lossy());
            *self.local.by_path.entry(key.clone()).or_insert(0) += bytes;
        }
    }
}

impl ParallelVisitor for Visitor {
    fn visit(&mut self, entry: Result<DirEntry, ignore::Error>) -> WalkState {
        if SHUTDOWN.load(Ordering::Relaxed) {
            return WalkState::Quit;
        }
        let Ok(entry) = entry else {
            return WalkState::Continue;
        };
        let Ok(metadata) = entry.metadata() else {
            return WalkState::Continue;
        };
        if entry.depth() == 0 {
            self.local.total_bytes += allocated_bytes(&metadata);
            return WalkState::Continue;
        }
        let is_dir = metadata.is_dir();
        if !is_dir
            && let Some(identity) = hardlink_identity(&metadata)
            && !self
                .shared
                .seen_links
                .lock()
                .is_ok_and(|mut seen| seen.insert(identity))
        {
            return WalkState::Continue;
        }
        self.add(&entry, allocated_bytes(&metadata), is_dir);
        WalkState::Continue
    }
}

impl Drop for Visitor {
    fn drop(&mut self) {
        let Ok(mut totals) = self.shared.totals.lock() else {
            return;
        };
        totals.total_bytes += self.local.total_bytes;
        for (path, bytes) in self.local.by_path.drain() {
            *totals.by_path.entry(path).or_insert(0) += bytes;
        }
    }
}

struct VisitorBuilder {
    shared: Arc<Shared>,
}

impl<'s> ParallelVisitorBuilder<'s> for VisitorBuilder {
    fn build(&mut self) -> Box<dyn ParallelVisitor + 's> {
        Box::new(Visitor {
            shared: Arc::clone(&self.shared),
            local: Totals::default(),
        })
    }
}

/// Sums allocated bytes under `root` like `du`: hardlinked files count once, symlinks are not
/// followed, and the walk stays on the root's filesystem. Unreadable entries are skipped.
/// APFS clones share blocks but report them per file, so macOS totals can overcount.
pub fn scan(root: &Path, depth: usize) -> io::Result<ScanResult> {
    std::fs::symlink_metadata(root)?;
    let shared = Arc::new(Shared {
        root: root.to_path_buf(),
        depth,
        seen_links: Mutex::new(HashSet::new()),
        totals: Mutex::new(Totals::default()),
    });
    let threads = std::thread::available_parallelism()
        .map_or(2, |count| count.get())
        .min(MAX_SCAN_THREADS);
    WalkBuilder::new(root)
        .standard_filters(false)
        .follow_links(false)
        .same_file_system(true)
        .threads(threads)
        .build_parallel()
        .visit(&mut VisitorBuilder {
            shared: Arc::clone(&shared),
        });
    if SHUTDOWN.load(Ordering::Relaxed) {
        return Err(io::Error::new(io::ErrorKind::Interrupted, "scan cancelled"));
    }
    let totals = std::mem::take(
        &mut *shared
            .totals
            .lock()
            .map_err(|_| io::Error::other("poisoned"))?,
    );
    Ok(ScanResult {
        total_bytes: totals.total_bytes,
        entries: totals.by_path.into_iter().collect(),
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

    #[test]
    fn reports_space_for_an_existing_path() {
        let temp = tempfile::tempdir().unwrap();
        let space = volume_space(temp.path()).unwrap();
        assert!(space.total_bytes > 0 && space.available_bytes <= space.total_bytes);
    }
}
