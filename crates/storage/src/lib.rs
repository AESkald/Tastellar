use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::{ImageFormat, ImageReader};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tastellar_domain::{
    blank_guidelines, validate_criterion, validate_entry, validate_guidelines, validate_media_type,
    validate_preferences, validate_profile, validate_tag, validate_taste_inputs,
    validate_workspace, Criterion, CriterionInput, Entry, EntryInput, HomeState, LibraryState,
    MediaType, MediaTypeInput, Preferences, Profile, ProfileInput, ReleaseDate, Tag, TagInput,
    Workspace,
};
use thiserror::Error;

pub mod portable_backup;
pub(crate) mod ranking;

const SCHEMA_VERSION: i64 = 9;
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const MAX_IMAGE_PIXELS: u64 = 40_000_000;
const MAX_BACKUP_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("{0}")]
    Validation(String),
    #[error("Saved data changed in another tab. Reload and retry.")]
    Conflict,
    #[error("Unsupported database or backup version")]
    UnsupportedVersion,
    #[error("Avatar file is missing or damaged")]
    AssetUnavailable,
    #[error("Workspace reset is complete, but secure cleanup must be retried after restart")]
    ResetCommittedCleanupPending,
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
}

impl StorageError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Validation(_) => "Validation",
            Self::Conflict => "Conflict",
            Self::UnsupportedVersion => "UnsupportedVersion",
            Self::AssetUnavailable => "AssetUnavailable",
            Self::ResetCommittedCleanupPending => "ResetCommittedCleanupPending",
            Self::Io(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                "PermissionDenied"
            }
            Self::Io(error) if error.raw_os_error() == Some(28) => "DiskFull",
            _ => "Internal",
        }
    }
}

impl From<tastellar_domain::ValidationError> for StorageError {
    fn from(value: tastellar_domain::ValidationError) -> Self {
        Self::Validation(value.to_string())
    }
}

pub struct Storage {
    root: PathBuf,
    conn: Connection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetWorkspaceResult {
    pub home: HomeState,
    pub library: LibraryState,
}

const RESET_PREFIX: &str = ".tastellar-reset-";
const RESET_JOURNAL: &str = ".tastellar-reset-journal.json";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResetJournal {
    suffix: String,
    expected_version: i64,
    had_backups: bool,
}

/// Keeps app-owned files recoverable until the database transaction commits.
/// The durable journal plus hard-link snapshots allow startup to finish or roll
/// back a reset if the process exits between filesystem and SQLite operations.
struct ResetFileSet {
    root: PathBuf,
    journal: ResetJournal,
    journal_written: bool,
    database_committed: bool,
    finalized: bool,
}

impl ResetFileSet {
    fn prepare(root: &Path, expected_version: i64) -> Result<Self, StorageError> {
        if path_exists(&root.join(RESET_JOURNAL))? {
            return Err(StorageError::Validation(
                "An earlier workspace reset needs recovery before another reset".into(),
            ));
        }
        cleanup_reset_artifacts(root)?;
        let suffix = format!("{}-{}", std::process::id(), now_nanos());
        let mut files = Self {
            root: root.to_path_buf(),
            journal: ResetJournal {
                suffix,
                expected_version,
                had_backups: false,
            },
            journal_written: false,
            database_committed: false,
            finalized: false,
        };
        let assets = files.path("assets");
        let backups = files.path("backups");
        if !fs::symlink_metadata(&assets)?.file_type().is_dir() {
            return Err(StorageError::Validation(
                "Managed data directory is unsafe to reset".into(),
            ));
        }
        copy_tree_hardlinks(&assets, &files.artifact("assets-snapshot"))?;
        sync_tree_directories(&files.artifact("assets-snapshot"))?;
        match fs::symlink_metadata(&backups) {
            Ok(metadata) => {
                if !metadata.file_type().is_dir() {
                    return Err(StorageError::Validation(
                        "Managed backup directory is unsafe to reset".into(),
                    ));
                }
                files.journal.had_backups = true;
                copy_tree_hardlinks(&backups, &files.artifact("backups-snapshot"))?;
                sync_tree_directories(&files.artifact("backups-snapshot"))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        sync_directory(root)?;

        files.write_journal()?;
        fs::rename(&assets, files.artifact("assets-old"))?;
        fs::create_dir(&assets)?;
        sync_directory(root)?;
        if files.journal.had_backups {
            fs::rename(&backups, files.artifact("backups-old"))?;
            fs::create_dir(&backups)?;
            sync_directory(root)?;
        }
        Ok(files)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    fn artifact(&self, role: &str) -> PathBuf {
        self.root
            .join(format!("{RESET_PREFIX}{}-{role}", self.journal.suffix))
    }

    fn journal_temp(&self) -> PathBuf {
        self.artifact("journal.tmp")
    }

    fn write_journal(&mut self) -> Result<(), StorageError> {
        let temp = self.journal_temp();
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(&serde_json::to_vec(&self.journal)?)?;
        file.sync_all()?;
        fs::hard_link(&temp, self.path(RESET_JOURNAL))?;
        self.journal_written = true;
        fs::remove_file(temp)?;
        sync_directory(&self.root)?;
        Ok(())
    }

    /// Delete old directory names before committing SQLite. If deletion fails,
    /// the durable journal lets Drop restore the active directories.
    fn purge_staged(&self) -> Result<(), StorageError> {
        fs::remove_dir_all(self.artifact("assets-old"))?;
        if self.journal.had_backups {
            fs::remove_dir_all(self.artifact("backups-old"))?;
        }
        sync_directory(&self.root)?;
        Ok(())
    }

    fn finalize_after_commit(mut self, conn: &Connection) -> Result<(), StorageError> {
        self.database_committed = true;
        let cleanup = scrub_reset_database(conn).and_then(|()| {
            finish_committed_reset_files(&self.root, &self.journal).map_err(StorageError::Io)
        });
        match cleanup {
            Ok(()) => {
                self.finalized = true;
                Ok(())
            }
            Err(_) => Err(StorageError::ResetCommittedCleanupPending),
        }
    }
}

impl Drop for ResetFileSet {
    fn drop(&mut self) {
        if self.database_committed || self.finalized {
            return;
        }
        if self.journal_written {
            if restore_reset_files(&self.root, &self.journal).is_ok() {
                let _ = fs::remove_file(self.path(RESET_JOURNAL));
                let _ = sync_directory(&self.root);
            }
        } else {
            let _ = remove_if_present(&self.artifact("assets-snapshot"));
            let _ = remove_if_present(&self.artifact("backups-snapshot"));
            let _ = remove_if_present(&self.journal_temp());
        }
    }
}

fn copy_tree_hardlinks(source: &Path, destination: &Path) -> Result<(), StorageError> {
    fs::create_dir(destination)?;
    for item in fs::read_dir(source)? {
        let item = item?;
        let source_path = item.path();
        let destination_path = destination.join(item.file_name());
        let kind = item.file_type()?;
        if kind.is_dir() {
            copy_tree_hardlinks(&source_path, &destination_path)?;
        } else if kind.is_file() {
            fs::hard_link(source_path, destination_path)?;
        } else {
            return Err(StorageError::Validation(
                "Managed data contains an unsupported file type".into(),
            ));
        }
    }
    Ok(())
}

fn artifact_path(root: &Path, suffix: &str, role: &str) -> PathBuf {
    root.join(format!("{RESET_PREFIX}{suffix}-{role}"))
}

fn path_exists(path: &Path) -> Result<bool, std::io::Error> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn remove_if_present(path: &Path) -> Result<(), std::io::Error> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn require_real_directory(path: &Path) -> Result<(), std::io::Error> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_dir() {
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Reset recovery path is not a real directory",
        ))
    }
}

fn require_real_directory_if_present(path: &Path) -> Result<bool, std::io::Error> {
    if path_exists(path)? {
        require_real_directory(path)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), std::io::Error> {
    fs::File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), std::io::Error> {
    Ok(())
}

fn sync_tree_directories(path: &Path) -> Result<(), std::io::Error> {
    for item in fs::read_dir(path)? {
        let item = item?;
        if item.file_type()?.is_dir() {
            sync_tree_directories(&item.path())?;
        }
    }
    sync_directory(path)
}

fn valid_reset_suffix(suffix: &str) -> bool {
    let mut parts = suffix.split('-');
    matches!((parts.next(), parts.next(), parts.next()), (Some(pid), Some(clock), None)
        if !pid.is_empty() && !clock.is_empty()
            && pid.bytes().all(|byte| byte.is_ascii_digit())
            && clock.bytes().all(|byte| byte.is_ascii_digit()))
}

fn reset_artifact_parts(name: &str) -> Option<(String, String)> {
    let rest = name.strip_prefix(RESET_PREFIX)?;
    let mut parts = rest.splitn(3, '-');
    let (Some(pid), Some(clock), Some(role)) = (parts.next(), parts.next(), parts.next()) else {
        return None;
    };
    let suffix = format!("{pid}-{clock}");
    if valid_reset_suffix(&suffix)
        && matches!(
            role,
            "assets-snapshot"
                | "backups-snapshot"
                | "assets-old"
                | "backups-old"
                | "assets-displaced"
                | "backups-displaced"
                | "journal.tmp"
        )
    {
        Some((suffix, role.to_owned()))
    } else {
        None
    }
}

fn cleanup_reset_artifacts(root: &Path) -> Result<(), std::io::Error> {
    let mut paths_to_remove = Vec::new();
    for item in fs::read_dir(root)? {
        let item = item?;
        let Some(name) = item.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if let Some((_, role)) = reset_artifact_parts(&name) {
            if role.ends_with("-old") || role.ends_with("-displaced") {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Reset staging directory has no recovery journal",
                ));
            }
            paths_to_remove.push(item.path());
        }
    }
    for path in paths_to_remove {
        remove_if_present(&path)?;
    }
    sync_directory(root)
}

fn restore_reset_directory(root: &Path, suffix: &str, name: &str) -> Result<(), std::io::Error> {
    let active = root.join(name);
    let snapshot = artifact_path(
        root,
        suffix,
        if name == "assets" {
            "assets-snapshot"
        } else {
            "backups-snapshot"
        },
    );
    let staged = artifact_path(
        root,
        suffix,
        if name == "assets" {
            "assets-old"
        } else {
            "backups-old"
        },
    );
    let displaced = artifact_path(
        root,
        suffix,
        if name == "assets" {
            "assets-displaced"
        } else {
            "backups-displaced"
        },
    );
    require_real_directory_if_present(&displaced)?;

    if path_exists(&snapshot)? {
        require_real_directory(&snapshot)?;
        if require_real_directory_if_present(&active)? {
            remove_if_present(&displaced)?;
            fs::rename(&active, &displaced)?;
        }
        if let Err(error) = fs::rename(&snapshot, &active) {
            if path_exists(&displaced)? && !path_exists(&active)? {
                let _ = fs::rename(&displaced, &active);
            }
            return Err(error);
        }
    } else if !path_exists(&active)? {
        // This is possible only if recovery itself was interrupted after
        // moving the original directory aside but before moving its snapshot.
        require_real_directory(&staged)?;
        fs::rename(&staged, &active)?;
    } else {
        require_real_directory(&active)?;
    }
    require_real_directory_if_present(&staged)?;
    require_real_directory_if_present(&displaced)?;
    remove_if_present(&staged)?;
    remove_if_present(&displaced)?;
    Ok(())
}

fn restore_reset_files(root: &Path, journal: &ResetJournal) -> Result<(), std::io::Error> {
    restore_reset_directory(root, &journal.suffix, "assets")?;
    if journal.had_backups {
        restore_reset_directory(root, &journal.suffix, "backups")?;
    }
    remove_if_present(&artifact_path(root, &journal.suffix, "journal.tmp"))?;
    sync_directory(root)
}

fn finish_committed_reset_files(root: &Path, journal: &ResetJournal) -> Result<(), std::io::Error> {
    for name in ["assets", "backups"] {
        if name == "backups" && !journal.had_backups {
            continue;
        }
        let active = root.join(name);
        if !fs::symlink_metadata(&active)?.file_type().is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Reset directory is not a real directory",
            ));
        }
        for item in fs::read_dir(&active)? {
            remove_if_present(&item?.path())?;
        }
    }
    for role in [
        "assets-old",
        "backups-old",
        "assets-snapshot",
        "backups-snapshot",
        "assets-displaced",
        "backups-displaced",
        "journal.tmp",
    ] {
        remove_if_present(&artifact_path(root, &journal.suffix, role))?;
    }
    sync_directory(root)?;
    fs::remove_file(root.join(RESET_JOURNAL))?;
    sync_directory(root)
}

fn scrub_reset_database(conn: &Connection) -> Result<(), StorageError> {
    fn truncate_wal(conn: &Connection) -> Result<(), StorageError> {
        let busy: i64 = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))?;
        if busy != 0 {
            return Err(StorageError::ResetCommittedCleanupPending);
        }
        Ok(())
    }

    truncate_wal(conn)?;
    conn.execute_batch("VACUUM")?;
    truncate_wal(conn)
}

fn recover_interrupted_reset(root: &Path, conn: &Connection) -> Result<(), StorageError> {
    let journal_path = root.join(RESET_JOURNAL);
    match fs::symlink_metadata(&journal_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            cleanup_reset_artifacts(root)?;
            return Ok(());
        }
        Err(error) => return Err(error.into()),
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err(StorageError::Validation(
                "Workspace reset recovery journal is unsafe".into(),
            ));
        }
        Ok(_) => {}
    }
    let journal: ResetJournal = serde_json::from_slice(&fs::read(&journal_path)?)?;
    if !valid_reset_suffix(&journal.suffix) || journal.expected_version < 0 {
        return Err(StorageError::Validation(
            "Workspace reset recovery journal is invalid".into(),
        ));
    }
    let version: i64 = conn.query_row("SELECT version FROM metadata WHERE id=1", [], |row| {
        row.get(0)
    })?;
    let committed_version = journal.expected_version.checked_add(1).ok_or_else(|| {
        StorageError::Validation("Workspace reset recovery revision is invalid".into())
    })?;
    if version == journal.expected_version {
        restore_reset_files(root, &journal)?;
        fs::remove_file(&journal_path)?;
        sync_directory(root)?;
    } else if version == committed_version {
        scrub_reset_database(conn).map_err(|_| StorageError::ResetCommittedCleanupPending)?;
        finish_committed_reset_files(root, &journal)
            .map_err(|_| StorageError::ResetCommittedCleanupPending)?;
    } else {
        return Err(StorageError::Validation(
            "Workspace reset recovery does not match the saved revision".into(),
        ));
    }
    cleanup_reset_artifacts(root)?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HomeBackup {
    format: String,
    format_version: i64,
    state: HomeState,
    avatar: Option<BackupAvatar>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupAvatar {
    mime_type: String,
    sha256: String,
    base64: String,
}

impl Storage {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, StorageError> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root)?;
        fs::create_dir_all(root.join("assets"))?;
        if !root.join("assets").symlink_metadata()?.file_type().is_dir() {
            return Err(StorageError::AssetUnavailable);
        }
        let db_path = root.join("tastellar.sqlite3");
        let is_new = !db_path.exists();
        let mut conn = Connection::open(db_path)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "secure_delete", "ON")?;
        let mut version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > SCHEMA_VERSION || (version == 0 && !is_new) {
            return Err(StorageError::UnsupportedVersion);
        }
        if version == 0 {
            let tx = conn.transaction()?;
            tx.execute_batch("\
                CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version>=0));
                CREATE TABLE profile (id INTEGER PRIMARY KEY CHECK(id=1), nickname TEXT NOT NULL, stated_tastes TEXT NOT NULL, avatar_asset_id TEXT REFERENCES assets(hash));
                CREATE TABLE guideline (score INTEGER PRIMARY KEY CHECK(score BETWEEN 1 AND 10), description TEXT NOT NULL);
                CREATE TABLE taste_input (criterion_id TEXT PRIMARY KEY, importance INTEGER NOT NULL CHECK(importance BETWEEN 1 AND 10));
                CREATE TABLE preference (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, json TEXT NOT NULL);
                CREATE TABLE workspace (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, json TEXT NOT NULL);
                CREATE TABLE assets (hash TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL, byte_length INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, created_at INTEGER NOT NULL);
                INSERT INTO metadata(id,version) VALUES(1,0);
                INSERT INTO profile(id,nickname,stated_tastes,avatar_asset_id) VALUES(1,'','',NULL);
                PRAGMA user_version=1;
            ")?;
            for score in 1..=10 {
                tx.execute(
                    "INSERT INTO guideline(score, description) VALUES(?1, '')",
                    [score],
                )?;
            }
            tx.execute(
                "INSERT INTO preference(id,schema_version,json) VALUES(1,1,?1)",
                [serde_json::to_string(&Preferences::default())?],
            )?;
            tx.execute(
                "INSERT INTO workspace(id,schema_version,json) VALUES(1,1,?1)",
                [serde_json::to_string(&Workspace::default())?],
            )?;
            tx.commit()?;
            version = 1;
        }
        if version == 1 {
            let tx = conn.transaction()?;
            tx.execute_batch("\
                CREATE TABLE media_type (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    normalized_name TEXT NOT NULL,
                    sort_order INTEGER NOT NULL CHECK(sort_order>=0),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    archived_at TEXT,
                    version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)
                );
                CREATE UNIQUE INDEX media_type_active_name ON media_type(normalized_name) WHERE archived_at IS NULL;
                CREATE TABLE criterion (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    normalized_name TEXT NOT NULL,
                    description TEXT,
                    sort_order INTEGER NOT NULL CHECK(sort_order>=0),
                    default_key TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    archived_at TEXT,
                    version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)
                );
                CREATE UNIQUE INDEX criterion_active_name ON criterion(normalized_name) WHERE archived_at IS NULL;
                CREATE TABLE media_type_criterion (
                    type_id TEXT NOT NULL REFERENCES media_type(id),
                    criterion_id TEXT NOT NULL REFERENCES criterion(id),
                    display_order INTEGER NOT NULL CHECK(display_order>=0),
                    PRIMARY KEY(type_id,criterion_id),
                    UNIQUE(type_id,display_order)
                );
                CREATE TABLE tag (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    normalized_name TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)
                );
                CREATE TABLE entry (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL CHECK(length(trim(title))>0),
                    disposition TEXT NOT NULL CHECK(disposition IN ('experienced','planned','dropped')),
                    media_type_id TEXT REFERENCES media_type(id),
                    overall_rating INTEGER CHECK(overall_rating BETWEEN 1 AND 10),
                    cover_asset_id TEXT REFERENCES assets(hash),
                    release_year INTEGER,
                    release_month INTEGER,
                    release_day INTEGER,
                    release_precision TEXT,
                    review_text TEXT NOT NULL DEFAULT '',
                    notes_text TEXT NOT NULL DEFAULT '',
                    short_label TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
                    trashed_at TEXT,
                    CHECK(overall_rating IS NULL OR disposition='experienced'),
                    CHECK((release_precision IS NULL AND release_year IS NULL AND release_month IS NULL AND release_day IS NULL)
                       OR (release_precision='year' AND release_year BETWEEN 1 AND 9999 AND release_month IS NULL AND release_day IS NULL)
                       OR (release_precision='month' AND release_year BETWEEN 1 AND 9999 AND release_month BETWEEN 1 AND 12 AND release_day IS NULL)
                       OR (release_precision='day' AND release_year BETWEEN 1 AND 9999 AND release_month BETWEEN 1 AND 12 AND release_day BETWEEN 1 AND 31))
                );
                CREATE TABLE criterion_rating (
                    entry_id TEXT NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
                    criterion_id TEXT NOT NULL REFERENCES criterion(id),
                    score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 10),
                    recorded_at TEXT NOT NULL,
                    PRIMARY KEY(entry_id,criterion_id)
                );
                CREATE TABLE entry_tag (
                    entry_id TEXT NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
                    tag_id TEXT NOT NULL REFERENCES tag(id),
                    PRIMARY KEY(entry_id,tag_id)
                );
                CREATE TABLE entry_event (
                    id TEXT PRIMARY KEY,
                    entry_id TEXT NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
                    kind TEXT NOT NULL,
                    occurred_at TEXT NOT NULL,
                    recorded_at TEXT NOT NULL,
                    source TEXT NOT NULL DEFAULT 'user',
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE group_order (
                    entry_id TEXT PRIMARY KEY REFERENCES entry(id) ON DELETE CASCADE,
                    group_id TEXT NOT NULL,
                    order_key TEXT NOT NULL COLLATE BINARY,
                    UNIQUE(group_id,order_key)
                );
                CREATE INDEX entry_active_disposition ON entry(disposition,overall_rating) WHERE trashed_at IS NULL;
                CREATE INDEX entry_active_type ON entry(media_type_id) WHERE trashed_at IS NULL;
                CREATE INDEX entry_release_year ON entry(release_year) WHERE trashed_at IS NULL;
                CREATE INDEX entry_tag_tag ON entry_tag(tag_id,entry_id);
                PRAGMA user_version=2;
            ")?;
            seed_default_vocabulary(&tx)?;
            tx.commit()?;
            version = 2;
        }
        if version == 2 {
            let tx = conn.transaction()?;
            tx.execute_batch(
                "\
                ALTER TABLE media_type ADD COLUMN icon_key TEXT NOT NULL DEFAULT 'shape-circle';
                ALTER TABLE entry DROP COLUMN notes_text;
                PRAGMA user_version=3;
            ",
            )?;
            let now = now_rfc3339();
            upgrade_seeded_vocabulary_to_current(&tx, &now)?;
            tx.execute("UPDATE metadata SET version=version+1 WHERE id=1", [])?;
            tx.commit()?;
            version = 3;
        }
        if version == 3 {
            let tx = conn.transaction()?;
            let old_preferences_json: String = tx.query_row(
                "SELECT json FROM preference WHERE id=1 AND schema_version=1",
                [],
                |row| row.get(0),
            )?;
            let mut preferences: Preferences = serde_json::from_str(&old_preferences_json)?;
            let mut changed = false;
            if preferences.previous_tab_shortcut == "Control+ArrowLeft" {
                preferences.previous_tab_shortcut = "Alt+ArrowLeft".into();
                changed = true;
            }
            if preferences.next_tab_shortcut == "Control+ArrowRight" {
                preferences.next_tab_shortcut = "Alt+ArrowRight".into();
                changed = true;
            }
            if changed {
                tx.execute(
                    "UPDATE preference SET json=?1 WHERE id=1",
                    [serde_json::to_string(&preferences)?],
                )?;
                tx.execute("UPDATE metadata SET version=version+1 WHERE id=1", [])?;
            }
            tx.execute_batch("PRAGMA user_version=4;")?;
            tx.commit()?;
            version = 4;
        }
        if version == 4 {
            let tx = conn.transaction()?;
            tx.execute_batch("\
                CREATE TABLE ranking_tier_state (
                    score INTEGER PRIMARY KEY CHECK(score BETWEEN 1 AND 10),
                    input_sequence INTEGER NOT NULL DEFAULT 0 CHECK(input_sequence>=0),
                    fitted_sequence INTEGER NOT NULL DEFAULT 0 CHECK(fitted_sequence>=0 AND fitted_sequence<=input_sequence),
                    pending_reconcile INTEGER NOT NULL DEFAULT 0 CHECK(pending_reconcile IN (0,1)),
                    order_revision INTEGER NOT NULL DEFAULT 0 CHECK(order_revision>=0)
                );
                CREATE TABLE ranking_entry (
                    entry_id TEXT PRIMARY KEY REFERENCES entry(id) ON DELETE CASCADE,
                    score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 10),
                    placed INTEGER NOT NULL CHECK(placed IN (0,1))
                );
                CREATE INDEX ranking_entry_score_placed ON ranking_entry(score,placed,entry_id);
                CREATE TABLE ranking_session (
                    id TEXT PRIMARY KEY,
                    score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 10),
                    status TEXT NOT NULL CHECK(status IN ('active','paused','ended')),
                    mode TEXT NOT NULL CHECK(mode IN ('binary','normal','confirm')),
                    intent TEXT NOT NULL CHECK(intent IN ('auto','binary','normal')),
                    filter_json TEXT NOT NULL,
                    seed INTEGER NOT NULL,
                    snapshot_order_json TEXT NOT NULL,
                    snapshot_order_revision INTEGER NOT NULL,
                    candidate_id TEXT REFERENCES entry(id) ON DELETE SET NULL,
                    low_bound INTEGER NOT NULL DEFAULT 0,
                    high_bound INTEGER NOT NULL DEFAULT 0,
                    current_pivot_id TEXT REFERENCES entry(id) ON DELETE SET NULL,
                    answered_count INTEGER NOT NULL DEFAULT 0,
                    presented_duel_id TEXT,
                    presented_left_id TEXT REFERENCES entry(id) ON DELETE SET NULL,
                    presented_right_id TEXT REFERENCES entry(id) ON DELETE SET NULL,
                    presented_step INTEGER,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE UNIQUE INDEX ranking_one_active_session ON ranking_session((1)) WHERE status='active';
                CREATE TABLE ranking_judgment (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES ranking_session(id) ON DELETE CASCADE,
                    score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 10),
                    duel_id TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('binary','normal')),
                    left_id TEXT NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
                    right_id TEXT NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
                    answer TEXT NOT NULL CHECK(answer IN ('leftWin','rightWin','tie','skip')),
                    retracted INTEGER NOT NULL DEFAULT 0 CHECK(retracted IN (0,1)),
                    occurred_at TEXT NOT NULL,
                    UNIQUE(session_id,duel_id)
                );
                CREATE INDEX ranking_judgment_pair ON ranking_judgment(score,left_id,right_id,retracted);
                CREATE TABLE ranking_boundary (
                    id TEXT PRIMARY KEY,
                    score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 10),
                    first_id TEXT NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
                    second_id TEXT NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
                    preferred_id TEXT NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
                    weight REAL NOT NULL CHECK(weight>0 AND weight<=1),
                    protected INTEGER NOT NULL CHECK(protected IN (0,1)),
                    UNIQUE(score,first_id,second_id),
                    CHECK(first_id<second_id)
                );
                CREATE TABLE ranking_order_event (
                    id TEXT PRIMARY KEY,
                    score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 10),
                    kind TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    occurred_at TEXT NOT NULL
                );
                CREATE TABLE ranking_fit (
                    score INTEGER PRIMARY KEY CHECK(score BETWEEN 1 AND 10),
                    input_sequence INTEGER NOT NULL,
                    entry_ids_json TEXT NOT NULL,
                    means_json TEXT NOT NULL,
                    covariance_json TEXT NOT NULL,
                    model_version INTEGER NOT NULL
                );
                INSERT INTO ranking_tier_state(score) VALUES(1),(2),(3),(4),(5),(6),(7),(8),(9),(10);
                INSERT INTO ranking_entry(entry_id,score,placed)
                    SELECT id,overall_rating,1 FROM entry
                    WHERE disposition='experienced' AND overall_rating IS NOT NULL AND trashed_at IS NULL;
                UPDATE ranking_tier_state SET order_revision=1;
                PRAGMA user_version=5;
            ")?;
            tx.commit()?;
            version = 5;
        }
        if version == 5 {
            let tx = conn.transaction()?;
            tx.execute_batch("CREATE TABLE ranking_order_key_meta (id INTEGER PRIMARY KEY CHECK(id=1), algorithm_version INTEGER NOT NULL CHECK(algorithm_version>=1));")?;
            crate::ranking::migrate_order_keys(&tx)?;
            tx.execute(
                "INSERT INTO ranking_order_key_meta(id,algorithm_version) VALUES(1,?1)",
                [crate::ranking::ORDER_KEY_ALGORITHM_VERSION],
            )?;
            tx.execute_batch("PRAGMA user_version=6;")?;
            tx.commit()?;
            version = 6;
        }
        if version == 6 {
            let tx = conn.transaction()?;
            tx.execute_batch("\
                ALTER TABLE ranking_boundary ADD COLUMN legacy_unlock INTEGER NOT NULL DEFAULT 0 CHECK(legacy_unlock IN (0,1));
                UPDATE ranking_boundary SET legacy_unlock=1 WHERE protected=0;
                CREATE TABLE ranking_boundary_unlock (
                    boundary_id TEXT NOT NULL REFERENCES ranking_boundary(id) ON DELETE CASCADE,
                    judgment_id TEXT NOT NULL REFERENCES ranking_judgment(id) ON DELETE CASCADE,
                    PRIMARY KEY(boundary_id,judgment_id)
                );
                CREATE INDEX ranking_boundary_unlock_judgment ON ranking_boundary_unlock(judgment_id);
                PRAGMA user_version=7;
            ")?;
            tx.commit()?;
            version = 7;
        }
        if version == 7 {
            let tx = conn.transaction()?;
            tx.execute_batch("\
                ALTER TABLE ranking_boundary ADD COLUMN created_sequence INTEGER NOT NULL DEFAULT 0 CHECK(created_sequence>=0);
                ALTER TABLE ranking_judgment ADD COLUMN input_sequence INTEGER NOT NULL DEFAULT 0 CHECK(input_sequence>=0);
                ALTER TABLE ranking_session ADD COLUMN explicit_subset INTEGER NOT NULL DEFAULT 0 CHECK(explicit_subset IN (0,1));
                UPDATE ranking_boundary SET legacy_unlock=1 WHERE protected=0;
                DELETE FROM ranking_boundary_unlock;
                UPDATE ranking_boundary SET created_sequence=COALESCE((SELECT input_sequence FROM ranking_tier_state WHERE score=ranking_boundary.score),0);
                PRAGMA user_version=8;
            ")?;
            tx.commit()?;
            version = 8;
        }
        if version == 8 {
            let has_import_order: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('entry') WHERE name='import_order')",
                [],
                |row| row.get(0),
            )?;
            let tx = conn.transaction()?;
            if !has_import_order {
                tx.execute_batch(
                    "ALTER TABLE entry ADD COLUMN import_order INTEGER NOT NULL DEFAULT 0; UPDATE entry SET import_order=rowid;",
                )?;
            }
            tx.execute_batch(
                "CREATE UNIQUE INDEX IF NOT EXISTS entry_import_order_unique ON entry(import_order); PRAGMA user_version=9;",
            )?;
            tx.commit()?;
            version = 9;
        }
        debug_assert_eq!(version, SCHEMA_VERSION);
        recover_interrupted_reset(&root, &conn)?;
        let mut storage = Self { root, conn };
        storage.recover_ranking_state()?;
        Ok(storage)
    }

    pub fn reset_workspace(
        &mut self,
        expected_version: i64,
    ) -> Result<ResetWorkspaceResult, StorageError> {
        let preferences = Preferences::default();
        let workspace = Workspace::default();
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_version)?;
        let reset_files = ResetFileSet::prepare(&self.root, expected_version)?;
        tx.execute(
            "UPDATE profile SET nickname='',stated_tastes='',avatar_asset_id=NULL WHERE id=1",
            [],
        )?;
        tx.execute("UPDATE guideline SET description=''", [])?;
        tx.execute("DELETE FROM taste_input", [])?;
        tx.execute(
            "UPDATE preference SET json=?1 WHERE id=1",
            [serde_json::to_string(&preferences)?],
        )?;
        tx.execute(
            "UPDATE workspace SET json=?1 WHERE id=1",
            [serde_json::to_string(&workspace)?],
        )?;

        tx.execute("DELETE FROM entry", [])?;
        tx.execute("DELETE FROM media_type_criterion", [])?;
        tx.execute("DELETE FROM tag", [])?;
        tx.execute("DELETE FROM media_type", [])?;
        tx.execute("DELETE FROM criterion", [])?;
        tx.execute("DELETE FROM assets", [])?;
        seed_default_vocabulary(&tx)?;
        upgrade_seeded_vocabulary_to_current(&tx, &now_rfc3339())?;
        // The seeded-vocabulary migration restores this legacy type as archived,
        // along with its criterion links. Remove those links before the type.
        tx.execute(
            "DELETE FROM media_type_criterion
             WHERE type_id='animated-films-series'
               AND EXISTS (
                   SELECT 1 FROM media_type
                   WHERE id='animated-films-series' AND archived_at IS NOT NULL
               )",
            [],
        )?;
        tx.execute(
            "DELETE FROM media_type WHERE id='animated-films-series' AND archived_at IS NOT NULL",
            [],
        )?;
        tx.execute("UPDATE metadata SET version=version+1 WHERE id=1", [])?;
        reset_files.purge_staged()?;
        tx.commit()?;
        reset_files.finalize_after_commit(&self.conn)?;
        Ok(ResetWorkspaceResult {
            home: self.load_home()?,
            library: self.load_library()?,
        })
    }

    pub fn load_home(&self) -> Result<HomeState, StorageError> {
        let tx = self.conn.unchecked_transaction()?;
        let version = tx.query_row("SELECT version FROM metadata WHERE id=1", [], |row| {
            row.get(0)
        })?;
        let profile = tx.query_row(
            "SELECT nickname, stated_tastes, avatar_asset_id FROM profile WHERE id=1",
            [],
            |row| {
                Ok(Profile {
                    nickname: row.get(0)?,
                    stated_tastes: row.get(1)?,
                    avatar_asset_id: row.get(2)?,
                })
            },
        )?;
        let mut guidelines = blank_guidelines();
        let mut stmt = tx.prepare("SELECT score, description FROM guideline")?;
        for row in stmt.query_map([], |row| {
            Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?))
        })? {
            let (score, description) = row?;
            guidelines.insert(score.to_string(), description);
        }
        let mut taste_inputs = BTreeMap::new();
        drop(stmt);
        let mut stmt = tx.prepare("SELECT criterion_id, importance FROM taste_input")?;
        for row in stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?))
        })? {
            let (id, importance) = row?;
            taste_inputs.insert(id, importance);
        }
        drop(stmt);
        let preferences_json: String = tx.query_row(
            "SELECT json FROM preference WHERE id=1 AND schema_version=1",
            [],
            |row| row.get(0),
        )?;
        let workspace_json: String = tx.query_row(
            "SELECT json FROM workspace WHERE id=1 AND schema_version=1",
            [],
            |row| row.get(0),
        )?;
        let preferences = serde_json::from_str(&preferences_json)?;
        let workspace = serde_json::from_str(&workspace_json)?;
        tx.commit()?;
        Ok(HomeState {
            version,
            profile,
            guidelines,
            taste_inputs,
            preferences,
            workspace,
        })
    }

    pub fn load_library(&self) -> Result<LibraryState, StorageError> {
        let revision: i64 =
            self.conn
                .query_row("SELECT version FROM metadata WHERE id=1", [], |row| {
                    row.get(0)
                })?;
        let mut media_types = Vec::new();
        {
            let mut stmt = self.conn.prepare(
                "SELECT id,name,sort_order,icon_key,archived_at,version,created_at,updated_at FROM media_type ORDER BY sort_order,name,id",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i32>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })?;
            for row in rows {
                let (id, name, sort_order, icon_key, archived_at, version, created_at, updated_at) =
                    row?;
                let mut criterion_ids = Vec::new();
                let mut criteria = self.conn.prepare(
                    "SELECT criterion_id FROM media_type_criterion WHERE type_id=?1 ORDER BY display_order,criterion_id",
                )?;
                for criterion in criteria.query_map([&id], |row| row.get::<_, String>(0))? {
                    criterion_ids.push(criterion?);
                }
                media_types.push(MediaType {
                    id,
                    name,
                    sort_order,
                    icon_key,
                    criterion_ids,
                    archived_at,
                    version,
                    created_at,
                    updated_at,
                });
            }
        }
        let mut criteria = Vec::new();
        {
            let mut stmt = self.conn.prepare(
                "SELECT id,name,description,sort_order,archived_at,version,created_at,updated_at FROM criterion ORDER BY sort_order,name,id",
            )?;
            for row in stmt.query_map([], |row| {
                Ok(Criterion {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    sort_order: row.get(3)?,
                    archived_at: row.get(4)?,
                    version: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })? {
                criteria.push(row?);
            }
        }
        let mut tags = Vec::new();
        {
            let mut stmt = self.conn.prepare(
                "SELECT id,name,created_at,updated_at,version FROM tag ORDER BY name,id",
            )?;
            for row in stmt.query_map([], |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    version: row.get(4)?,
                })
            })? {
                tags.push(row?);
            }
        }
        let mut entries = Vec::new();
        {
            let mut stmt = self.conn.prepare(
                "SELECT e.id,e.version,e.title,e.disposition,e.media_type_id,e.overall_rating,e.cover_asset_id,e.release_year,e.release_month,e.release_day,e.release_precision,e.review_text,e.short_label,e.created_at,e.updated_at,e.import_order FROM entry AS e LEFT JOIN group_order AS position ON position.entry_id=e.id WHERE e.trashed_at IS NULL ORDER BY CASE WHEN e.disposition='experienced' AND e.overall_rating IS NOT NULL THEN 0 WHEN e.disposition='planned' THEN 1 WHEN e.disposition='dropped' THEN 2 ELSE 3 END, e.overall_rating DESC, position.order_key IS NULL, position.order_key, e.created_at, e.id",
            )?;
            let rows = stmt.query_map([], |row| {
                let year: Option<i32> = row.get(7)?;
                let month: Option<u8> = row.get(8)?;
                let day: Option<u8> = row.get(9)?;
                let precision: Option<String> = row.get(10)?;
                let release_date = match (year, precision) {
                    (Some(year), Some(precision)) => Some(ReleaseDate {
                        year,
                        month,
                        day,
                        precision,
                    }),
                    _ => None,
                };
                Ok((Entry {
                    id: row.get(0)?,
                    import_order: Some(row.get(15)?),
                    version: row.get(1)?,
                    title: row.get(2)?,
                    disposition: row.get(3)?,
                    media_type_id: row.get(4)?,
                    overall_rating: row.get(5)?,
                    cover_asset_id: row.get(6)?,
                    release_date,
                    review_text: row.get(11)?,
                    legacy_notes_text: None,
                    legacy_notes_text_snake_case: None,
                    short_label: row.get(12)?,
                    criterion_ratings: BTreeMap::new(),
                    tag_ids: Vec::new(),
                    created_at: row.get(13)?,
                    updated_at: row.get(14)?,
                },))
            })?;
            for row in rows {
                let (mut entry,) = row?;
                {
                    let mut ratings = self.conn.prepare(
                        "SELECT criterion_id,score FROM criterion_rating WHERE entry_id=?1 ORDER BY criterion_id",
                    )?;
                    for rating in ratings.query_map([&entry.id], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?))
                    })? {
                        let (criterion_id, score) = rating?;
                        entry.criterion_ratings.insert(criterion_id, score);
                    }
                }
                {
                    let mut tags = self.conn.prepare(
                        "SELECT tag_id FROM entry_tag WHERE entry_id=?1 ORDER BY tag_id",
                    )?;
                    for tag in tags.query_map([&entry.id], |row| row.get::<_, String>(0))? {
                        entry.tag_ids.push(tag?);
                    }
                }
                entries.push(entry);
            }
        }
        Ok(LibraryState {
            revision,
            entries,
            media_types,
            criteria,
            tags,
        })
    }

    pub fn save_entry(
        &mut self,
        expected_revision: i64,
        entry: EntryInput,
    ) -> Result<LibraryState, StorageError> {
        validate_entry(&entry)?;
        let now = now_rfc3339();
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_revision)?;
        if let Some(type_id) = &entry.media_type_id {
            let active: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM media_type WHERE id=?1 AND archived_at IS NULL)",
                [type_id],
                |row| row.get(0),
            )?;
            if !active {
                return Err(StorageError::Validation(
                    "Choose an active media type".into(),
                ));
            }
        }
        if let Some(asset_id) = &entry.cover_asset_id {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM assets WHERE hash=?1)",
                [asset_id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(StorageError::AssetUnavailable);
            }
        }
        for (criterion_id, score) in &entry.criterion_ratings {
            if score.is_some() {
                let exists: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM criterion WHERE id=?1)",
                    [criterion_id],
                    |row| row.get(0),
                )?;
                if !exists {
                    return Err(StorageError::Validation("Unknown criterion".into()));
                }
            }
        }
        for tag_id in &entry.tag_ids {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM tag WHERE id=?1)",
                [tag_id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(StorageError::Validation("Unknown tag".into()));
            }
        }
        let is_trashed: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM entry WHERE id=?1 AND trashed_at IS NOT NULL)",
            [&entry.id],
            |row| row.get(0),
        )?;
        if is_trashed {
            return Err(StorageError::Validation(
                "Restore this entry from trash before editing it".into(),
            ));
        }
        let previous: Option<(i64, Option<i32>, String, Option<String>, String, i64)> = tx
            .query_row(
                "SELECT version,overall_rating,disposition,media_type_id,created_at,import_order FROM entry WHERE id=?1 AND trashed_at IS NULL",
                [&entry.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
            .optional()?;
        let import_order = if let Some(previous) = &previous {
            previous.5
        } else {
            tx.query_row(
                "SELECT COALESCE(MAX(import_order),-1)+1 FROM entry",
                [],
                |row| row.get(0),
            )?
        };
        let release = entry.release_date.as_ref();
        tx.execute(
            "INSERT INTO entry(id,title,disposition,media_type_id,overall_rating,cover_asset_id,release_year,release_month,release_day,release_precision,review_text,short_label,created_at,updated_at,version,trashed_at,import_order)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,1,NULL,?15)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title,disposition=excluded.disposition,media_type_id=excluded.media_type_id,overall_rating=excluded.overall_rating,cover_asset_id=excluded.cover_asset_id,release_year=excluded.release_year,release_month=excluded.release_month,release_day=excluded.release_day,release_precision=excluded.release_precision,review_text=excluded.review_text,short_label=excluded.short_label,updated_at=excluded.updated_at,version=entry.version+1,trashed_at=NULL",
            params![entry.id,entry.title.trim(),entry.disposition,entry.media_type_id,entry.overall_rating,entry.cover_asset_id,release.map(|d|d.year),release.and_then(|d|d.month),release.and_then(|d|d.day),release.map(|d|d.precision.as_str()),entry.review_text,entry.short_label,previous.as_ref().map(|row| row.4.as_str()).unwrap_or(&now),now,import_order],
        )?;
        for (criterion_id, score) in &entry.criterion_ratings {
            let previous_score: Option<i32> = tx
                .query_row(
                    "SELECT score FROM criterion_rating WHERE entry_id=?1 AND criterion_id=?2",
                    params![entry.id, criterion_id],
                    |row| row.get(0),
                )
                .optional()?;
            if previous_score != *score {
                write_entry_event(
                    &tx,
                    &entry.id,
                    "criterion_score_changed",
                    &now,
                    serde_json::json!({
                        "criterionId": criterion_id,
                        "oldScore": previous_score,
                        "newScore": score,
                    }),
                )?;
            }
            match score {
                Some(score) => {
                    tx.execute(
                        "INSERT INTO criterion_rating(entry_id,criterion_id,score,recorded_at) VALUES(?1,?2,?3,?4) ON CONFLICT(entry_id,criterion_id) DO UPDATE SET score=excluded.score,recorded_at=excluded.recorded_at",
                        params![entry.id,criterion_id,score,now],
                    )?;
                }
                None => {
                    tx.execute(
                        "DELETE FROM criterion_rating WHERE entry_id=?1 AND criterion_id=?2",
                        params![entry.id, criterion_id],
                    )?;
                }
            }
        }
        tx.execute("DELETE FROM entry_tag WHERE entry_id=?1", [&entry.id])?;
        for tag_id in &entry.tag_ids {
            tx.execute(
                "INSERT INTO entry_tag(entry_id,tag_id) VALUES(?1,?2)",
                params![entry.id, tag_id],
            )?;
        }
        let group_id = entry_group(&entry.disposition, entry.overall_rating);
        let order_key = crate::ranking::next_order_key(&tx, &group_id)?;
        tx.execute(
            "INSERT INTO group_order(entry_id,group_id,order_key) VALUES(?1,?2,?3) ON CONFLICT(entry_id) DO UPDATE SET group_id=excluded.group_id,order_key=CASE WHEN group_order.group_id=excluded.group_id THEN group_order.order_key ELSE excluded.order_key END",
            params![entry.id,group_id,order_key],
        )?;
        let existing_ranking: Option<(i32, bool)> = tx
            .query_row(
                "SELECT score,placed FROM ranking_entry WHERE entry_id=?1",
                [&entry.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let prior_score = previous
            .as_ref()
            .and_then(|row| row.1)
            .or(existing_ranking.map(|row| row.0));
        let prior_placed = existing_ranking.map(|row| row.1);
        let keep_placed = entry.overall_rating.is_some()
            && prior_score == entry.overall_rating
            && prior_placed.unwrap_or(false);
        if let Some(score) = entry.overall_rating {
            tx.execute(
                "INSERT INTO ranking_entry(entry_id,score,placed) VALUES(?1,?2,?3) ON CONFLICT(entry_id) DO UPDATE SET score=excluded.score,placed=excluded.placed",
                params![entry.id, score, keep_placed],
            )?;
        } else {
            tx.execute("DELETE FROM ranking_entry WHERE entry_id=?1", [&entry.id])?;
        }
        let restored_ranking = previous.is_none() && existing_ranking.is_some();
        if prior_score != entry.overall_rating || restored_ranking {
            let mut dirty_scores = Vec::new();
            if let Some(old_score) = prior_score.filter(|old| Some(*old) != entry.overall_rating) {
                dirty_scores.push(old_score);
            }
            if let Some(new_score) = entry.overall_rating.filter(|new| Some(*new) != prior_score) {
                dirty_scores.push(new_score);
            }
            if restored_ranking && dirty_scores.is_empty() {
                if let Some(score) = entry.overall_rating {
                    dirty_scores.push(score);
                }
            }
            dirty_scores.sort_unstable();
            dirty_scores.dedup();
            for score in dirty_scores {
                tx.execute("DELETE FROM ranking_fit WHERE score=?1", [score])?;
                tx.execute("UPDATE ranking_tier_state SET input_sequence=input_sequence+1,fitted_sequence=0,pending_reconcile=0,order_revision=order_revision+1 WHERE score=?1", [score])?;
            }
            tx.execute(
                "DELETE FROM ranking_boundary WHERE first_id=?1 OR second_id=?1",
                [&entry.id],
            )?;
        }
        match previous {
            None => write_entry_event(
                &tx,
                &entry.id,
                "created",
                &now,
                serde_json::json!({"title": entry.title, "disposition": entry.disposition}),
            )?,
            Some((_, old_rating, old_disposition, old_type, _, _)) => {
                if old_rating != entry.overall_rating || old_disposition != entry.disposition {
                    write_entry_event(
                        &tx,
                        &entry.id,
                        "rating_changed",
                        &now,
                        serde_json::json!({"oldRating": old_rating, "newRating": entry.overall_rating, "oldDisposition": old_disposition, "newDisposition": entry.disposition}),
                    )?;
                }
                if old_type != entry.media_type_id {
                    write_entry_event(
                        &tx,
                        &entry.id,
                        "type_changed",
                        &now,
                        serde_json::json!({"oldTypeId": old_type, "newTypeId": entry.media_type_id}),
                    )?;
                }
            }
        }
        Self::commit_version(tx)?;
        self.load_library()
    }

    pub fn delete_entry(
        &mut self,
        expected_revision: i64,
        entry_id: &str,
    ) -> Result<LibraryState, StorageError> {
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_revision)?;
        let score: Option<i32> = tx
            .query_row(
                "SELECT overall_rating FROM entry WHERE id=?1 AND trashed_at IS NULL",
                [entry_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let now = now_rfc3339();
        let changed = tx.execute(
            "UPDATE entry SET trashed_at=?1,updated_at=?1,version=version+1 WHERE id=?2 AND trashed_at IS NULL",
            params![now,entry_id],
        )?;
        if changed == 0 {
            return Err(StorageError::Validation("Entry was not found".into()));
        }
        if let Some(score) = score {
            tx.execute("DELETE FROM ranking_fit WHERE score=?1", [score])?;
            tx.execute(
                "DELETE FROM ranking_boundary WHERE first_id=?1 OR second_id=?1",
                [entry_id],
            )?;
            tx.execute("UPDATE ranking_tier_state SET input_sequence=input_sequence+1,fitted_sequence=0,pending_reconcile=0,order_revision=order_revision+1 WHERE score=?1",[score])?;
        }
        write_entry_event(&tx, entry_id, "trashed", &now, serde_json::json!({}))?;
        Self::commit_version(tx)?;
        self.load_library()
    }

    pub fn save_media_type(
        &mut self,
        expected_revision: i64,
        media_type: MediaTypeInput,
    ) -> Result<LibraryState, StorageError> {
        validate_media_type(&media_type)?;
        let now = now_rfc3339();
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_revision)?;
        ensure_unique_name(&tx, "media_type", &media_type.id, &media_type.name)?;
        for criterion_id in &media_type.criterion_ids {
            let active: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM criterion WHERE id=?1 AND archived_at IS NULL)",
                [criterion_id],
                |row| row.get(0),
            )?;
            if !active {
                return Err(StorageError::Validation("Choose active criteria".into()));
            }
        }
        tx.execute(
            "INSERT INTO media_type(id,name,normalized_name,sort_order,created_at,updated_at,archived_at,version,icon_key) VALUES(?1,?2,?3,?4,?5,?5,NULL,1,?6)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,normalized_name=excluded.normalized_name,sort_order=excluded.sort_order,icon_key=excluded.icon_key,updated_at=excluded.updated_at,archived_at=NULL,version=media_type.version+1",
            params![media_type.id,media_type.name.trim(),normalize_name(&media_type.name),media_type.sort_order,now,media_type.icon_key],
        )?;
        tx.execute(
            "DELETE FROM media_type_criterion WHERE type_id=?1",
            [&media_type.id],
        )?;
        for (order, criterion_id) in media_type.criterion_ids.iter().enumerate() {
            tx.execute(
                "INSERT INTO media_type_criterion(type_id,criterion_id,display_order) VALUES(?1,?2,?3)",
                params![media_type.id,criterion_id,order as i32],
            )?;
        }
        Self::commit_version(tx)?;
        self.load_library()
    }

    pub fn archive_media_type(
        &mut self,
        expected_revision: i64,
        type_id: &str,
        confirm_clear_entries: bool,
    ) -> Result<LibraryState, StorageError> {
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_revision)?;
        let affected: i64 = tx.query_row(
            "SELECT COUNT(*) FROM entry WHERE media_type_id=?1 AND trashed_at IS NULL",
            [type_id],
            |row| row.get(0),
        )?;
        if affected > 0 && !confirm_clear_entries {
            return Err(StorageError::Validation(format!(
                "This type is used by {affected} entries. Confirm to clear their type."
            )));
        }
        let now = now_rfc3339();
        let exists = tx.execute(
            "UPDATE media_type SET archived_at=?1,updated_at=?1,version=version+1 WHERE id=?2 AND archived_at IS NULL",
            params![now,type_id],
        )?;
        if exists == 0 {
            return Err(StorageError::Validation("Media type was not found".into()));
        }
        tx.execute(
            "UPDATE entry SET media_type_id=NULL,updated_at=?1,version=version+1 WHERE media_type_id=?2 AND trashed_at IS NULL",
            params![now,type_id],
        )?;
        Self::commit_version(tx)?;
        self.load_library()
    }

    pub fn save_criterion(
        &mut self,
        expected_revision: i64,
        criterion: CriterionInput,
    ) -> Result<LibraryState, StorageError> {
        validate_criterion(&criterion)?;
        let now = now_rfc3339();
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_revision)?;
        ensure_unique_name(&tx, "criterion", &criterion.id, &criterion.name)?;
        tx.execute(
            "INSERT INTO criterion(id,name,normalized_name,description,sort_order,default_key,created_at,updated_at,archived_at,version) VALUES(?1,?2,?3,?4,?5,NULL,?6,?6,NULL,1)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,normalized_name=excluded.normalized_name,description=excluded.description,sort_order=excluded.sort_order,updated_at=excluded.updated_at,archived_at=NULL,version=criterion.version+1",
            params![criterion.id,criterion.name.trim(),normalize_name(&criterion.name),criterion.description,criterion.sort_order,now],
        )?;
        Self::commit_version(tx)?;
        self.load_library()
    }

    pub fn archive_criterion(
        &mut self,
        expected_revision: i64,
        criterion_id: &str,
        confirm_remove_from_types: bool,
    ) -> Result<LibraryState, StorageError> {
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_revision)?;
        let affected: i64 = tx.query_row(
            "SELECT COUNT(DISTINCT e.id) FROM entry e JOIN media_type mt ON mt.id=e.media_type_id AND mt.archived_at IS NULL JOIN media_type_criterion mc ON mc.type_id=mt.id AND mc.criterion_id=?1 WHERE e.trashed_at IS NULL",
            [criterion_id],
            |row| row.get(0),
        )?;
        if affected > 0 && !confirm_remove_from_types {
            return Err(StorageError::Validation(format!(
                "This criterion is used by entries in active types ({affected} entries). Confirm to remove it from those types."
            )));
        }
        let now = now_rfc3339();
        let exists = tx.execute(
            "UPDATE criterion SET archived_at=?1,updated_at=?1,version=version+1 WHERE id=?2 AND archived_at IS NULL",
            params![now,criterion_id],
        )?;
        if exists == 0 {
            return Err(StorageError::Validation("Criterion was not found".into()));
        }
        tx.execute(
            "DELETE FROM media_type_criterion WHERE criterion_id=?1 AND type_id IN (SELECT id FROM media_type WHERE archived_at IS NULL)",
            [criterion_id],
        )?;
        Self::commit_version(tx)?;
        self.load_library()
    }

    pub fn save_tag(
        &mut self,
        expected_revision: i64,
        tag: TagInput,
    ) -> Result<LibraryState, StorageError> {
        validate_tag(&tag)?;
        let now = now_rfc3339();
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_revision)?;
        ensure_unique_name(&tx, "tag", &tag.id, &tag.name)?;
        tx.execute(
            "INSERT INTO tag(id,name,normalized_name,created_at,updated_at,version) VALUES(?1,?2,?3,?4,?4,1)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,normalized_name=excluded.normalized_name,updated_at=excluded.updated_at,version=tag.version+1",
            params![tag.id,tag.name.trim(),normalize_name(&tag.name),now],
        )?;
        Self::commit_version(tx)?;
        self.load_library()
    }

    pub fn merge_tags(
        &mut self,
        expected_revision: i64,
        source_id: &str,
        target_id: &str,
    ) -> Result<LibraryState, StorageError> {
        if source_id == target_id {
            return Err(StorageError::Validation("Choose two different tags".into()));
        }
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_revision)?;
        let source_exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM tag WHERE id=?1)",
            [source_id],
            |row| row.get(0),
        )?;
        let target_exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM tag WHERE id=?1)",
            [target_id],
            |row| row.get(0),
        )?;
        if !source_exists || !target_exists {
            return Err(StorageError::Validation("Tag was not found".into()));
        }
        tx.execute(
            "INSERT OR IGNORE INTO entry_tag(entry_id,tag_id) SELECT entry_id,?1 FROM entry_tag WHERE tag_id=?2",
            params![target_id,source_id],
        )?;
        tx.execute("DELETE FROM entry_tag WHERE tag_id=?1", [source_id])?;
        tx.execute("DELETE FROM tag WHERE id=?1", [source_id])?;
        Self::commit_version(tx)?;
        self.load_library()
    }

    pub fn delete_tag(
        &mut self,
        expected_revision: i64,
        tag_id: &str,
    ) -> Result<LibraryState, StorageError> {
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_revision)?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM tag WHERE id=?1)",
            [tag_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(StorageError::Validation("Tag was not found".into()));
        }
        tx.execute("DELETE FROM entry_tag WHERE tag_id=?1", [tag_id])?;
        tx.execute("DELETE FROM tag WHERE id=?1", [tag_id])?;
        Self::commit_version(tx)?;
        self.load_library()
    }

    pub fn save_entry_cover(
        &mut self,
        expected_revision: i64,
        entry_id: &str,
        mime_type: &str,
        base64: &str,
    ) -> Result<LibraryState, StorageError> {
        self.ensure_version(expected_revision)?;
        if base64.len() > (MAX_IMAGE_BYTES + 2).div_ceil(3) * 4 {
            return Err(StorageError::Validation(
                "Cover must be 25 MB or smaller".into(),
            ));
        }
        let bytes = BASE64
            .decode(base64)
            .map_err(|_| StorageError::Validation("Cover is not valid base64".into()))?;
        let (extension, width, height) = validate_image(mime_type, &bytes)?;
        let hash = hex_hash(&bytes);
        let relative = format!("assets/{hash}.{extension}");
        self.stage_asset(&relative, &bytes)?;
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_revision)?;
        let entry_exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM entry WHERE id=?1 AND trashed_at IS NULL)",
            [entry_id],
            |row| row.get(0),
        )?;
        if !entry_exists {
            return Err(StorageError::Validation("Entry was not found".into()));
        }
        tx.execute("INSERT OR IGNORE INTO assets(hash,relative_path,mime_type,byte_length,width,height,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![hash,relative,mime_type,bytes.len() as i64,width as i64,height as i64,now_epoch()])?;
        let now = now_rfc3339();
        tx.execute(
            "UPDATE entry SET cover_asset_id=?1,updated_at=?2,version=version+1 WHERE id=?3",
            params![hash, now, entry_id],
        )?;
        Self::commit_version(tx)?;
        self.load_library()
    }

    pub fn load_entry_cover(&self, entry_id: &str) -> Result<Option<String>, StorageError> {
        let asset: Option<(String, String)> = self.conn.query_row(
            "SELECT a.hash,a.relative_path FROM assets a JOIN entry e ON e.cover_asset_id=a.hash WHERE e.id=?1 AND e.trashed_at IS NULL",
            [entry_id],
            |row| Ok((row.get(0)?,row.get(1)?)),
        ).optional()?;
        match asset {
            Some((hash, relative)) => {
                let bytes = self.read_asset(&hash, &relative)?;
                let image =
                    image::load_from_memory(&bytes).map_err(|_| StorageError::AssetUnavailable)?;
                let mut derivative = Cursor::new(Vec::new());
                image
                    .thumbnail(900, 1200)
                    .write_to(&mut derivative, ImageFormat::Png)
                    .map_err(|_| StorageError::AssetUnavailable)?;
                Ok(Some(format!(
                    "data:image/png;base64,{}",
                    BASE64.encode(derivative.into_inner())
                )))
            }
            None => Ok(None),
        }
    }

    pub fn save_home(
        &mut self,
        expected_version: i64,
        profile: ProfileInput,
        guidelines: BTreeMap<String, String>,
        taste_inputs: BTreeMap<String, i32>,
    ) -> Result<HomeState, StorageError> {
        validate_profile(&profile)?;
        validate_guidelines(&guidelines)?;
        validate_taste_inputs(&taste_inputs)?;
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_version)?;
        tx.execute(
            "UPDATE profile SET nickname=?1, stated_tastes=?2 WHERE id=1",
            params![profile.nickname, profile.stated_tastes],
        )?;
        for (score, text) in guidelines {
            tx.execute(
                "UPDATE guideline SET description=?1 WHERE score=?2",
                params![
                    text,
                    score
                        .parse::<i32>()
                        .map_err(|_| StorageError::Validation("Invalid guideline score".into()))?
                ],
            )?;
        }
        tx.execute("DELETE FROM taste_input", [])?;
        for (id, importance) in taste_inputs {
            tx.execute(
                "INSERT INTO taste_input(criterion_id,importance) VALUES(?1,?2)",
                params![id, importance],
            )?;
        }
        Self::commit_version(tx)?;
        self.load_home()
    }

    pub fn save_preferences(
        &mut self,
        expected_version: i64,
        preferences: Preferences,
    ) -> Result<HomeState, StorageError> {
        validate_preferences(&preferences)?;
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_version)?;
        tx.execute(
            "UPDATE preference SET json=?1 WHERE id=1",
            [serde_json::to_string(&preferences)?],
        )?;
        Self::commit_version(tx)?;
        self.load_home()
    }

    pub fn save_workspace(
        &mut self,
        expected_version: i64,
        workspace: Workspace,
    ) -> Result<HomeState, StorageError> {
        validate_workspace(&workspace)?;
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_version)?;
        tx.execute(
            "UPDATE workspace SET json=?1 WHERE id=1",
            [serde_json::to_string(&workspace)?],
        )?;
        Self::commit_version(tx)?;
        self.load_home()
    }

    pub fn save_avatar(
        &mut self,
        expected_version: i64,
        mime_type: &str,
        base64: &str,
    ) -> Result<HomeState, StorageError> {
        self.ensure_version(expected_version)?;
        if base64.len() > (MAX_IMAGE_BYTES + 2).div_ceil(3) * 4 {
            return Err(StorageError::Validation(
                "Avatar must be 25 MB or smaller".into(),
            ));
        }
        let bytes = BASE64
            .decode(base64)
            .map_err(|_| StorageError::Validation("Avatar is not valid base64".into()))?;
        let (extension, width, height) = validate_avatar(mime_type, &bytes)?;
        let hash = hex_hash(&bytes);
        let relative = format!("assets/{hash}.{extension}");
        self.stage_asset(&relative, &bytes)?;
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_version)?;
        tx.execute("INSERT OR IGNORE INTO assets(hash,relative_path,mime_type,byte_length,width,height,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![hash, relative, mime_type, bytes.len() as i64, width as i64, height as i64, now_epoch()])?;
        tx.execute("UPDATE profile SET avatar_asset_id=?1 WHERE id=1", [&hash])?;
        Self::commit_version(tx)?;
        self.load_home()
    }

    pub fn remove_avatar(&mut self, expected_version: i64) -> Result<HomeState, StorageError> {
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_version)?;
        tx.execute("UPDATE profile SET avatar_asset_id=NULL WHERE id=1", [])?;
        Self::commit_version(tx)?;
        self.load_home()
    }

    pub fn load_avatar(&self) -> Result<Option<String>, StorageError> {
        let asset: Option<(String,String,String)> = self.conn.query_row("SELECT a.hash,a.relative_path,a.mime_type FROM assets a JOIN profile p ON p.avatar_asset_id=a.hash WHERE p.id=1", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
        match asset {
            Some((hash, relative, _mime)) => {
                let bytes = self.read_asset(&hash, &relative)?;
                let image =
                    image::load_from_memory(&bytes).map_err(|_| StorageError::AssetUnavailable)?;
                let mut derivative = Cursor::new(Vec::new());
                image
                    .thumbnail(512, 512)
                    .write_to(&mut derivative, ImageFormat::Png)
                    .map_err(|_| StorageError::AssetUnavailable)?;
                Ok(Some(format!(
                    "data:image/png;base64,{}",
                    BASE64.encode(derivative.into_inner())
                )))
            }
            None => Ok(None),
        }
    }

    pub fn export_home_backup(&self, path: impl AsRef<Path>) -> Result<ExportResult, StorageError> {
        let path = path.as_ref();
        if path.exists() {
            return Err(StorageError::Validation(
                "Destination already exists".into(),
            ));
        }
        let state = self.load_home()?;
        let avatar = if let Some(hash) = &state.profile.avatar_asset_id {
            let (relative, mime): (String, String) = self.conn.query_row(
                "SELECT relative_path,mime_type FROM assets WHERE hash=?1",
                [hash],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let bytes = self.read_asset(hash, &relative)?;
            Some(BackupAvatar {
                mime_type: mime,
                sha256: hash.clone(),
                base64: BASE64.encode(bytes),
            })
        } else {
            None
        };
        let backup = HomeBackup {
            format: "tastellar-home".into(),
            format_version: 1,
            state,
            avatar,
        };
        let bytes = serde_json::to_vec_pretty(&backup)?;
        if bytes.len() as u64 > MAX_BACKUP_BYTES {
            return Err(StorageError::Validation("Home backup exceeds 50 MB".into()));
        }
        let parent = path
            .parent()
            .ok_or_else(|| StorageError::Validation("Choose a destination folder".into()))?;
        let temp = parent.join(format!(
            ".tastellar-home-{}-{}.tmp",
            std::process::id(),
            now_nanos()
        ));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        if let Err(error) = (|| -> Result<(), std::io::Error> {
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::hard_link(&temp, path)?;
            fs::remove_file(&temp)?;
            Ok(())
        })() {
            let _ = fs::remove_file(&temp);
            return Err(error.into());
        }
        Ok(ExportResult {
            path: path.to_string_lossy().into_owned(),
        })
    }

    pub fn import_home_backup(
        &mut self,
        path: impl AsRef<Path>,
        expected_version: i64,
    ) -> Result<HomeState, StorageError> {
        self.ensure_version(expected_version)?;
        let path = path.as_ref();
        if fs::metadata(path)?.len() > MAX_BACKUP_BYTES {
            return Err(StorageError::Validation("Home backup exceeds 50 MB".into()));
        }
        let bytes = fs::read(path)?;
        let backup: HomeBackup = serde_json::from_slice(&bytes)?;
        if backup.format != "tastellar-home" || backup.format_version != 1 {
            return Err(StorageError::UnsupportedVersion);
        }
        validate_profile(&ProfileInput {
            nickname: backup.state.profile.nickname.clone(),
            stated_tastes: backup.state.profile.stated_tastes.clone(),
        })?;
        validate_guidelines(&backup.state.guidelines)?;
        validate_taste_inputs(&backup.state.taste_inputs)?;
        validate_preferences(&backup.state.preferences)?;
        validate_workspace(&backup.state.workspace)?;
        let avatar = match backup.avatar {
            Some(avatar) => {
                let bytes = BASE64
                    .decode(&avatar.base64)
                    .map_err(|_| StorageError::Validation("Invalid backup avatar".into()))?;
                let (ext, w, h) = validate_avatar(&avatar.mime_type, &bytes)?;
                let hash = hex_hash(&bytes);
                if hash != avatar.sha256
                    || backup.state.profile.avatar_asset_id.as_deref() != Some(&hash)
                {
                    return Err(StorageError::Validation(
                        "Backup avatar hash does not match profile".into(),
                    ));
                }
                Some((
                    hash,
                    format!("assets/{}.{}", avatar.sha256, ext),
                    avatar.mime_type,
                    bytes,
                    w,
                    h,
                ))
            }
            None => {
                if backup.state.profile.avatar_asset_id.is_some() {
                    return Err(StorageError::Validation("Backup avatar is missing".into()));
                }
                None
            }
        };
        let backups = self.root.join("backups");
        fs::create_dir_all(&backups)?;
        self.export_home_backup(backups.join(format!(
            "pre-import-{}-{}.json",
            std::process::id(),
            now_nanos()
        )))?;
        if let Some((_, relative, _, bytes, _, _)) = &avatar {
            self.stage_asset(relative, bytes)?;
        }
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_version)?;
        if let Some((hash, relative, mime, bytes, w, h)) = &avatar {
            tx.execute("INSERT OR IGNORE INTO assets(hash,relative_path,mime_type,byte_length,width,height,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![hash,relative,mime,bytes.len() as i64,*w as i64,*h as i64,now_epoch()])?;
        }
        tx.execute(
            "UPDATE profile SET nickname=?1, stated_tastes=?2, avatar_asset_id=?3 WHERE id=1",
            params![
                backup.state.profile.nickname,
                backup.state.profile.stated_tastes,
                backup.state.profile.avatar_asset_id
            ],
        )?;
        for (score, text) in backup.state.guidelines {
            tx.execute(
                "UPDATE guideline SET description=?1 WHERE score=?2",
                params![
                    text,
                    score
                        .parse::<i32>()
                        .map_err(|_| StorageError::Validation("Invalid score".into()))?
                ],
            )?;
        }
        tx.execute("DELETE FROM taste_input", [])?;
        for (id, importance) in backup.state.taste_inputs {
            tx.execute(
                "INSERT INTO taste_input(criterion_id,importance) VALUES(?1,?2)",
                params![id, importance],
            )?;
        }
        tx.execute(
            "UPDATE preference SET json=?1 WHERE id=1",
            [serde_json::to_string(&backup.state.preferences)?],
        )?;
        tx.execute(
            "UPDATE workspace SET json=?1 WHERE id=1",
            [serde_json::to_string(&backup.state.workspace)?],
        )?;
        Self::commit_version(tx)?;
        self.load_home()
    }

    fn ensure_version(&self, expected: i64) -> Result<(), StorageError> {
        let current: i64 =
            self.conn
                .query_row("SELECT version FROM metadata WHERE id=1", [], |row| {
                    row.get(0)
                })?;
        if current != expected {
            Err(StorageError::Conflict)
        } else {
            Ok(())
        }
    }

    fn check_version(tx: &Transaction<'_>, expected: i64) -> Result<(), StorageError> {
        let current: i64 = tx.query_row("SELECT version FROM metadata WHERE id=1", [], |row| {
            row.get(0)
        })?;
        if current != expected {
            Err(StorageError::Conflict)
        } else {
            Ok(())
        }
    }

    fn commit_version(tx: Transaction<'_>) -> Result<(), StorageError> {
        tx.execute("UPDATE metadata SET version=version+1 WHERE id=1", [])?;
        tx.commit()?;
        Ok(())
    }

    fn stage_asset(&self, relative: &str, bytes: &[u8]) -> Result<(), StorageError> {
        let path = self.root.join(relative);
        if path.exists() {
            if path.symlink_metadata()?.file_type().is_file()
                && hex_hash(&fs::read(&path)?) == hex_hash(bytes)
            {
                return Ok(());
            }
            return Err(StorageError::AssetUnavailable);
        }
        let temp = self.root.join("assets").join(format!(
            ".asset-{}-{}.tmp",
            std::process::id(),
            now_nanos()
        ));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        if let Err(error) = (|| -> Result<(), std::io::Error> {
            file.write_all(bytes)?;
            file.sync_all()?;
            // A rename can replace a destination created after the check above.
            // Linking creates the final path only when it is still absent.
            fs::hard_link(&temp, &path)?;
            Ok(())
        })() {
            let _ = fs::remove_file(&temp);
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                if path.symlink_metadata()?.file_type().is_file()
                    && hex_hash(&fs::read(&path)?) == hex_hash(bytes)
                {
                    return Ok(());
                }
                return Err(StorageError::AssetUnavailable);
            }
            return Err(error.into());
        }
        fs::remove_file(&temp)?;
        Ok(())
    }

    fn read_asset(&self, hash: &str, relative: &str) -> Result<Vec<u8>, StorageError> {
        let filename = Path::new(relative);
        if hash.len() != 64
            || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            || filename.components().count() != 2
            || filename.parent() != Some(Path::new("assets"))
            || !filename.file_name().is_some_and(|name| {
                ["png", "jpg", "webp"]
                    .iter()
                    .any(|ext| name == format!("{hash}.{ext}").as_str())
            })
            || !self
                .root
                .join(filename)
                .symlink_metadata()
                .is_ok_and(|metadata| metadata.file_type().is_file())
        {
            return Err(StorageError::AssetUnavailable);
        }
        let bytes =
            fs::read(self.root.join(filename)).map_err(|_| StorageError::AssetUnavailable)?;
        if hex_hash(&bytes) != hash {
            return Err(StorageError::AssetUnavailable);
        }
        Ok(bytes)
    }
}

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn now_rfc3339() -> String {
    let seconds = now_epoch();
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}
fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}
fn normalize_name(value: &str) -> String {
    value.trim().to_lowercase()
}
fn ensure_unique_name(
    tx: &Transaction<'_>,
    table: &str,
    id: &str,
    name: &str,
) -> Result<(), StorageError> {
    let sql = match table {
        "media_type" => "SELECT EXISTS(SELECT 1 FROM media_type WHERE normalized_name=?1 AND id<>?2 AND archived_at IS NULL)",
        "criterion" => "SELECT EXISTS(SELECT 1 FROM criterion WHERE normalized_name=?1 AND id<>?2 AND archived_at IS NULL)",
        "tag" => "SELECT EXISTS(SELECT 1 FROM tag WHERE normalized_name=?1 AND id<>?2)",
        _ => return Err(StorageError::Validation("Unknown vocabulary".into())),
    };
    let duplicate: bool = tx.query_row(sql, params![normalize_name(name), id], |row| row.get(0))?;
    if duplicate {
        return Err(StorageError::Validation(
            "An active item already uses this name".into(),
        ));
    }
    Ok(())
}
fn entry_group(disposition: &str, rating: Option<i32>) -> String {
    match (disposition, rating) {
        ("planned", _) => "planned".into(),
        ("dropped", _) => "dropped".into(),
        ("experienced", Some(rating)) => format!("rating-{rating:02}"),
        _ => "unrated".into(),
    }
}
fn write_entry_event(
    tx: &Transaction<'_>,
    entry_id: &str,
    kind: &str,
    occurred_at: &str,
    payload: serde_json::Value,
) -> Result<(), StorageError> {
    tx.execute(
        "INSERT INTO entry_event(id,entry_id,kind,occurred_at,recorded_at,source,payload_json) VALUES(?1,?2,?3,?4,?4,'user',?5)",
        params![format!("event-{}",now_nanos()),entry_id,kind,occurred_at,serde_json::to_string(&payload)?],
    )?;
    Ok(())
}
fn seed_default_vocabulary(tx: &Transaction<'_>) -> Result<(), StorageError> {
    const CRITERIA: [(&str, &str); 10] = [
        ("plot", "Plot"),
        ("world", "World"),
        ("characters", "Characters"),
        ("audiovisual", "Audiovisual presentation"),
        ("atmosphere", "Atmosphere"),
        ("gameplay", "Gameplay"),
        ("direction", "Direction"),
        ("acting", "Acting"),
        ("animation", "Animation"),
        ("writing-style", "Writing style"),
    ];
    let now = now_rfc3339();
    for (order, (id, name)) in CRITERIA.iter().enumerate() {
        tx.execute(
            "INSERT INTO criterion(id,name,normalized_name,description,sort_order,default_key,created_at,updated_at,archived_at,version) VALUES(?1,?2,?3,NULL,?4,?1,?5,?5,NULL,1)",
            params![id,name,normalize_name(name),order as i32,now],
        )?;
    }
    const TYPES: [(&str, &str, &[&str]); 6] = [
        (
            "literature",
            "Literature",
            &["plot", "world", "characters", "atmosphere", "writing-style"],
        ),
        (
            "anime",
            "Anime",
            &[
                "plot",
                "world",
                "characters",
                "audiovisual",
                "atmosphere",
                "direction",
                "animation",
            ],
        ),
        (
            "games",
            "Games",
            &[
                "gameplay",
                "plot",
                "world",
                "characters",
                "audiovisual",
                "atmosphere",
            ],
        ),
        (
            "films",
            "Films",
            &[
                "plot",
                "world",
                "characters",
                "audiovisual",
                "atmosphere",
                "direction",
                "acting",
            ],
        ),
        (
            "tv-series",
            "TV series",
            &[
                "plot",
                "world",
                "characters",
                "audiovisual",
                "atmosphere",
                "direction",
                "acting",
            ],
        ),
        (
            "animated-films-series",
            "Animated films or series",
            &[
                "plot",
                "world",
                "characters",
                "audiovisual",
                "atmosphere",
                "direction",
                "animation",
            ],
        ),
    ];
    for (sort_order, (id, name, criterion_ids)) in TYPES.iter().enumerate() {
        tx.execute(
            "INSERT INTO media_type(id,name,normalized_name,sort_order,created_at,updated_at,archived_at,version) VALUES(?1,?2,?3,?4,?5,?5,NULL,1)",
            params![id,name,normalize_name(name),sort_order as i32,now],
        )?;
        for (display_order, criterion_id) in criterion_ids.iter().enumerate() {
            tx.execute(
                "INSERT INTO media_type_criterion(type_id,criterion_id,display_order) VALUES(?1,?2,?3)",
                params![id,criterion_id,display_order as i32],
            )?;
        }
    }
    Ok(())
}

fn upgrade_seeded_vocabulary_to_current(
    tx: &Transaction<'_>,
    now: &str,
) -> Result<(), StorageError> {
    tx.execute(
        "UPDATE media_type SET icon_key=CASE id
            WHEN 'literature' THEN 'book-open'
            WHEN 'anime' THEN 'clapperboard'
            WHEN 'games' THEN 'gamepad-2'
            WHEN 'films' THEN 'film'
            WHEN 'tv-series' THEN 'tv'
            WHEN 'animated-films-series' THEN 'clapperboard'
            ELSE icon_key END",
        [],
    )?;
    tx.execute(
        "UPDATE media_type SET name='Animation',normalized_name='animation',updated_at=?1,version=version+1 WHERE id='anime' AND archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM media_type WHERE id<>'anime' AND normalized_name='animation' AND archived_at IS NULL)",
        [now],
    )?;
    tx.execute(
        "UPDATE entry SET media_type_id=NULL,updated_at=?1,version=version+1 WHERE media_type_id='animated-films-series' AND trashed_at IS NULL",
        [now],
    )?;
    tx.execute(
        "UPDATE media_type SET archived_at=?1,updated_at=?1,version=version+1 WHERE id='animated-films-series' AND archived_at IS NULL",
        [now],
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO criterion(id,name,normalized_name,description,sort_order,default_key,created_at,updated_at,archived_at,version)
         SELECT 'ideas-message','Ideas/Message','ideas/message',NULL,10,'ideas-message',?1,?1,NULL,1
         WHERE NOT EXISTS(SELECT 1 FROM criterion WHERE id='ideas-message' OR (normalized_name='ideas/message' AND archived_at IS NULL))",
        [now],
    )?;
    tx.execute(
        "INSERT INTO media_type(id,name,normalized_name,sort_order,created_at,updated_at,archived_at,version,icon_key)
         SELECT 'comic','Comic','comic',5,?1,?1,NULL,1,'messages-square'
         WHERE NOT EXISTS(SELECT 1 FROM media_type WHERE id='comic' OR (normalized_name='comic' AND archived_at IS NULL))",
        [now],
    )?;
    for criterion_id in ["plot", "world", "characters", "writing-style"] {
        tx.execute(
            "INSERT OR IGNORE INTO media_type_criterion(type_id,criterion_id,display_order)
             SELECT 'comic',id,?1 FROM criterion WHERE id=?2 AND archived_at IS NULL AND EXISTS(SELECT 1 FROM media_type WHERE id='comic' AND archived_at IS NULL)",
            params![
                match criterion_id {
                    "plot" => 0,
                    "world" => 1,
                    "characters" => 2,
                    _ => 3,
                },
                criterion_id
            ],
        )?;
    }
    let ideas_criterion: Option<String> = tx
        .query_row(
            "SELECT id FROM criterion WHERE id='ideas-message' AND archived_at IS NULL UNION ALL SELECT id FROM criterion WHERE normalized_name='ideas/message' AND archived_at IS NULL LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(criterion_id) = ideas_criterion {
        for id in [
            "literature",
            "anime",
            "games",
            "films",
            "tv-series",
            "comic",
        ] {
            tx.execute(
                "INSERT OR IGNORE INTO media_type_criterion(type_id,criterion_id,display_order)
                 SELECT ?1,id,(SELECT COALESCE(MAX(display_order)+1,0) FROM media_type_criterion WHERE type_id=?1)
                 FROM criterion WHERE id=?2 AND archived_at IS NULL
                   AND EXISTS(SELECT 1 FROM media_type WHERE id=?1 AND archived_at IS NULL)",
                params![id, criterion_id],
            )?;
        }
    }
    Ok(())
}

fn hex_hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn validate_avatar(mime: &str, bytes: &[u8]) -> Result<(&'static str, u32, u32), StorageError> {
    validate_supported_image(mime, bytes, "Avatar")
}

fn validate_image(mime: &str, bytes: &[u8]) -> Result<(&'static str, u32, u32), StorageError> {
    validate_supported_image(mime, bytes, "Cover")
}

fn validate_supported_image(
    mime: &str,
    bytes: &[u8],
    label: &str,
) -> Result<(&'static str, u32, u32), StorageError> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(StorageError::Validation(format!(
            "{label} must be 25 MB or smaller"
        )));
    }
    let (expected, ext) = match mime {
        "image/png" => (ImageFormat::Png, "png"),
        "image/jpeg" => (ImageFormat::Jpeg, "jpg"),
        "image/webp" => (ImageFormat::WebP, "webp"),
        _ => {
            return Err(StorageError::Validation(format!(
                "{label} must be PNG, JPEG, or WebP"
            )))
        }
    };
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| StorageError::Validation(format!("{label} file is not a supported image")))?;
    if reader.format() != Some(expected) {
        return Err(StorageError::Validation(format!(
            "{label} content does not match its type"
        )));
    }
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| StorageError::Validation(format!("{label} dimensions could not be read")))?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
        return Err(StorageError::Validation(format!(
            "{label} exceeds 40 megapixels; resize it first"
        )));
    }
    image::load_from_memory_with_format(bytes, expected)
        .map_err(|_| StorageError::Validation(format!("{label} image is damaged")))?;
    Ok((ext, width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(label: &str) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.runtime/native-tests")
            .join(format!(
                "{label}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn drop_test_ranking_schema(connection: &Connection) {
        connection
            .execute_batch(
                "\
            DROP TABLE IF EXISTS ranking_boundary_unlock;
            DROP TABLE IF EXISTS ranking_judgment;
            DROP TABLE IF EXISTS ranking_session;
            DROP TABLE IF EXISTS ranking_boundary;
            DROP TABLE IF EXISTS ranking_order_event;
            DROP TABLE IF EXISTS ranking_fit;
            DROP TABLE IF EXISTS ranking_entry;
            DROP TABLE IF EXISTS ranking_tier_state;
            DROP TABLE IF EXISTS ranking_order_key_meta;
        ",
            )
            .unwrap();
    }

    #[test]
    fn home_persists_and_rejects_stale_writes() {
        let root = test_root("persistence");
        let mut storage = Storage::open(&root).unwrap();
        let initial = storage.load_home().unwrap();
        assert_eq!(initial.guidelines.len(), 10);
        let initial_version = initial.version;
        let mut guidelines = initial.guidelines;
        guidelines.insert("10".into(), "A personal favorite".into());
        let saved = storage
            .save_home(
                initial_version,
                ProfileInput {
                    nickname: "Ada".into(),
                    stated_tastes: "Thoughtful stories".into(),
                },
                guidelines,
                BTreeMap::new(),
            )
            .unwrap();
        assert_eq!(saved.version, initial_version + 1);
        assert!(matches!(
            storage.save_preferences(initial_version, Preferences::default()),
            Err(StorageError::Conflict)
        ));
        drop(storage);
        let reopened = Storage::open(&root).unwrap().load_home().unwrap();
        assert_eq!(reopened.profile.nickname, "Ada");
        assert_eq!(reopened.guidelines["10"], "A personal favorite");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_reset_clears_owned_data_and_restores_only_current_defaults() {
        let root = test_root("workspace-reset");
        let mut storage = Storage::open(&root).unwrap();
        let initial = storage.load_home().unwrap();
        let hash = "a".repeat(64);
        let asset_path = root.join("assets").join(format!("{hash}.png"));
        fs::write(&asset_path, b"managed image").unwrap();
        fs::create_dir_all(root.join("backups")).unwrap();
        fs::write(root.join("backups/pre-import.json"), b"private backup").unwrap();
        storage
            .conn
            .execute(
                "INSERT INTO assets(hash,relative_path,mime_type,byte_length,width,height,created_at) VALUES(?1,?2,'image/png',12,1,1,0)",
                params![hash, format!("assets/{hash}.png")],
            )
            .unwrap();
        storage
            .conn
            .execute(
                "UPDATE profile SET nickname='Ada',stated_tastes='Personal note',avatar_asset_id=?1 WHERE id=1",
                [&hash],
            )
            .unwrap();
        storage
            .conn
            .execute(
                "UPDATE guideline SET description='Private guideline' WHERE score=10",
                [],
            )
            .unwrap();
        storage
            .conn
            .execute(
                "INSERT INTO tag(id,name,normalized_name,created_at,updated_at,version) VALUES('custom-tag','Custom','custom','now','now',1)",
                [],
            )
            .unwrap();
        storage
            .conn
            .execute(
                "INSERT INTO media_type(id,name,normalized_name,sort_order,created_at,updated_at,archived_at,version,icon_key) VALUES('custom-type','Custom type','custom type',99,'now','now',NULL,1,'shape-circle')",
                [],
            )
            .unwrap();
        let revision = initial.version;

        let reset = storage.reset_workspace(revision).unwrap();

        assert_eq!(reset.home.version, revision + 1);
        assert_eq!(reset.library.revision, reset.home.version);
        assert_eq!(reset.home.profile.nickname, "");
        assert!(reset.home.profile.avatar_asset_id.is_none());
        assert_eq!(reset.home.guidelines["10"], "");
        assert_eq!(reset.home.preferences, Preferences::default());
        assert!(reset.library.entries.is_empty());
        assert!(reset.library.tags.is_empty());
        assert!(!reset
            .library
            .media_types
            .iter()
            .any(|item| item.id == "custom-type"));
        assert!(!reset
            .library
            .media_types
            .iter()
            .any(|item| item.id == "animated-films-series"));
        let active_types: Vec<_> = reset
            .library
            .media_types
            .iter()
            .filter(|item| item.archived_at.is_none())
            .collect();
        assert!(active_types.iter().any(|item| item.id == "comic"));
        assert!(active_types
            .iter()
            .any(|item| item.id == "anime" && item.name == "Animation"));
        assert!(reset
            .library
            .criteria
            .iter()
            .any(|item| item.name == "Ideas/Message"));
        for media_type in active_types {
            assert!(media_type.criterion_ids.iter().any(|id| {
                reset
                    .library
                    .criteria
                    .iter()
                    .any(|criterion| criterion.id == *id && criterion.name == "Ideas/Message")
            }));
        }
        assert!(!asset_path.exists());
        assert!(fs::read_dir(root.join("assets")).unwrap().next().is_none());
        assert!(!root.join("backups").join("pre-import.json").exists());
        assert!(fs::read_dir(root.join("backups")).unwrap().next().is_none());
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn workspace_reset_rejects_symlinked_backup_directory_without_touching_data() {
        use std::os::unix::fs::symlink;

        let root = test_root("workspace-reset-symlink");
        let outside = test_root("workspace-reset-sentinel");
        fs::write(outside.join("keep.json"), b"must survive").unwrap();
        let mut storage = Storage::open(&root).unwrap();
        let initial = storage.load_home().unwrap();
        storage
            .conn
            .execute("UPDATE profile SET nickname='Ada' WHERE id=1", [])
            .unwrap();
        fs::remove_dir_all(root.join("backups")).unwrap_or(());
        symlink(&outside, root.join("backups")).unwrap();

        assert!(matches!(
            storage.reset_workspace(initial.version),
            Err(StorageError::Validation(_))
        ));
        assert_eq!(storage.load_home().unwrap().profile.nickname, "Ada");
        assert_eq!(
            fs::read(outside.join("keep.json")).unwrap(),
            b"must survive"
        );
        drop(storage);
        fs::remove_file(root.join("backups")).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn interrupted_reset_recovers_by_comparing_the_saved_revision() {
        for committed in [false, true] {
            let root = test_root(if committed {
                "workspace-reset-recover-committed"
            } else {
                "workspace-reset-recover-rollback"
            });
            let storage = Storage::open(&root).unwrap();
            let old_revision = storage.load_home().unwrap().version;
            fs::write(root.join("assets/original.bin"), b"original asset").unwrap();
            fs::create_dir_all(root.join("backups")).unwrap();
            fs::write(root.join("backups/original.json"), b"original backup").unwrap();
            let suffix = format!("{}-{}", std::process::id(), now_nanos());
            let journal = ResetJournal {
                suffix: suffix.clone(),
                expected_version: old_revision,
                had_backups: true,
            };
            copy_tree_hardlinks(
                &root.join("assets"),
                &artifact_path(&root, &suffix, "assets-snapshot"),
            )
            .unwrap();
            copy_tree_hardlinks(
                &root.join("backups"),
                &artifact_path(&root, &suffix, "backups-snapshot"),
            )
            .unwrap();
            fs::write(
                root.join(RESET_JOURNAL),
                serde_json::to_vec(&journal).unwrap(),
            )
            .unwrap();
            fs::rename(
                root.join("assets"),
                artifact_path(&root, &suffix, "assets-old"),
            )
            .unwrap();
            fs::create_dir(root.join("assets")).unwrap();
            fs::rename(
                root.join("backups"),
                artifact_path(&root, &suffix, "backups-old"),
            )
            .unwrap();
            fs::create_dir(root.join("backups")).unwrap();
            if committed {
                storage
                    .conn
                    .execute("UPDATE metadata SET version=version+1 WHERE id=1", [])
                    .unwrap();
            }
            drop(storage);

            let reopened = Storage::open(&root).unwrap();
            if committed {
                assert!(!root.join("assets/original.bin").exists());
                assert!(!root.join("backups/original.json").exists());
            } else {
                assert_eq!(
                    fs::read(root.join("assets/original.bin")).unwrap(),
                    b"original asset"
                );
                assert_eq!(
                    fs::read(root.join("backups/original.json")).unwrap(),
                    b"original backup"
                );
            }
            assert!(!root.join(RESET_JOURNAL).exists());
            assert!(fs::read_dir(&root).unwrap().all(|item| !item
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(RESET_PREFIX)));
            drop(reopened);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn interrupted_reset_will_not_restore_from_a_symlinked_snapshot() {
        use std::os::unix::fs::symlink;

        let root = test_root("workspace-reset-symlink-snapshot");
        let outside = test_root("workspace-reset-symlink-snapshot-target");
        let storage = Storage::open(&root).unwrap();
        let old_revision = storage.load_home().unwrap().version;
        fs::write(root.join("assets/original.bin"), b"original asset").unwrap();
        fs::write(outside.join("keep.bin"), b"outside asset").unwrap();
        let suffix = format!("{}-{}", std::process::id(), now_nanos());
        let journal = ResetJournal {
            suffix: suffix.clone(),
            expected_version: old_revision,
            had_backups: false,
        };
        let snapshot = artifact_path(&root, &suffix, "assets-snapshot");
        copy_tree_hardlinks(&root.join("assets"), &snapshot).unwrap();
        fs::write(
            root.join(RESET_JOURNAL),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();
        fs::rename(
            root.join("assets"),
            artifact_path(&root, &suffix, "assets-old"),
        )
        .unwrap();
        fs::create_dir(root.join("assets")).unwrap();
        drop(storage);
        fs::remove_dir_all(&snapshot).unwrap();
        symlink(&outside, &snapshot).unwrap();

        assert!(matches!(
            Storage::open(&root),
            Err(StorageError::Io(error)) if error.kind() == std::io::ErrorKind::InvalidData
        ));
        assert!(root.join(RESET_JOURNAL).exists());
        assert_eq!(
            fs::read(outside.join("keep.bin")).unwrap(),
            b"outside asset"
        );
        assert_eq!(
            fs::read(artifact_path(&root, &suffix, "assets-old/original.bin")).unwrap(),
            b"original asset"
        );

        fs::remove_file(&snapshot).unwrap();
        copy_tree_hardlinks(&artifact_path(&root, &suffix, "assets-old"), &snapshot).unwrap();
        let recovered = Storage::open(&root).unwrap();
        assert_eq!(
            fs::read(root.join("assets/original.bin")).unwrap(),
            b"original asset"
        );
        assert!(!root.join(RESET_JOURNAL).exists());
        drop(recovered);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn reset_cleanup_pending_is_retried_before_storage_opens() {
        use std::os::unix::fs::symlink;

        let root = test_root("workspace-reset-cleanup-pending");
        let outside = test_root("workspace-reset-cleanup-sentinel");
        let storage = Storage::open(&root).unwrap();
        let old_revision = storage.load_home().unwrap().version;
        fs::write(root.join("assets/original.bin"), b"original asset").unwrap();
        let suffix = format!("{}-{}", std::process::id(), now_nanos());
        let journal = ResetJournal {
            suffix: suffix.clone(),
            expected_version: old_revision,
            had_backups: true,
        };
        copy_tree_hardlinks(
            &root.join("assets"),
            &artifact_path(&root, &suffix, "assets-snapshot"),
        )
        .unwrap();
        fs::create_dir(&artifact_path(&root, &suffix, "backups-snapshot")).unwrap();
        fs::write(
            artifact_path(&root, &suffix, "assets-snapshot/original.bin"),
            b"original asset",
        )
        .unwrap();
        fs::write(
            root.join(RESET_JOURNAL),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();
        drop(storage);
        fs::write(outside.join("keep.json"), b"outside data").unwrap();
        symlink(&outside, root.join("backups")).unwrap();

        let mut connection = Connection::open(root.join("tastellar.sqlite3")).unwrap();
        connection
            .execute("UPDATE metadata SET version=version+1 WHERE id=1", [])
            .unwrap();
        drop(connection);
        assert!(matches!(
            Storage::open(&root),
            Err(StorageError::ResetCommittedCleanupPending)
        ));
        assert!(root.join(RESET_JOURNAL).exists());
        assert_eq!(
            fs::read(outside.join("keep.json")).unwrap(),
            b"outside data"
        );

        fs::remove_file(root.join("backups")).unwrap();
        fs::create_dir(root.join("backups")).unwrap();
        let reopened = Storage::open(&root).unwrap();
        assert!(!root.join("assets/original.bin").exists());
        assert!(!root.join(RESET_JOURNAL).exists());
        assert!(fs::read_dir(&root).unwrap().all(|item| !item
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(RESET_PREFIX)));
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn v3_shortcut_migration_changes_only_previous_default_chords() {
        let cases = [
            (
                "workspace-shortcut-defaults",
                "Control+ArrowLeft",
                "Control+ArrowRight",
                "Alt+ArrowLeft",
                "Alt+ArrowRight",
                8_i64,
            ),
            (
                "workspace-shortcut-custom",
                "Meta+ArrowUp",
                "Shift+ArrowRight",
                "Meta+ArrowUp",
                "Shift+ArrowRight",
                7_i64,
            ),
        ];
        for (label, previous, next, expected_previous, expected_next, expected_version) in cases {
            let root = test_root(label);
            let storage = Storage::open(&root).unwrap();
            drop_test_ranking_schema(&storage.conn);
            let mut preferences = Preferences::default();
            preferences.previous_tab_shortcut = previous.into();
            preferences.next_tab_shortcut = next.into();
            storage
                .conn
                .execute(
                    "UPDATE preference SET json=?1 WHERE id=1",
                    [serde_json::to_string(&preferences).unwrap()],
                )
                .unwrap();
            storage
                .conn
                .execute("UPDATE metadata SET version=7 WHERE id=1", [])
                .unwrap();
            storage.conn.pragma_update(None, "user_version", 3).unwrap();
            drop(storage);

            let reopened = Storage::open(&root).unwrap();
            let migrated = reopened.load_home().unwrap();
            assert_eq!(
                migrated.preferences.previous_tab_shortcut,
                expected_previous
            );
            assert_eq!(migrated.preferences.next_tab_shortcut, expected_next);
            assert_eq!(migrated.version, expected_version);
            drop(reopened);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn avatar_and_backup_round_trip() {
        let root = test_root("backup-source");
        let destination = test_root("backup-destination");
        let backup_path = root.join("home.tastellar-home.json");
        let image = image::DynamicImage::new_rgba8(1, 1);
        let mut cursor = Cursor::new(Vec::new());
        image.write_to(&mut cursor, ImageFormat::Png).unwrap();
        let encoded = BASE64.encode(cursor.into_inner());
        let mut source = Storage::open(&root).unwrap();
        let source_revision = source.load_home().unwrap().version;
        source
            .save_avatar(source_revision, "image/png", &encoded)
            .unwrap();
        source.export_home_backup(&backup_path).unwrap();
        let mut target = Storage::open(&destination).unwrap();
        let target_revision = target.load_home().unwrap().version;
        let imported = target
            .import_home_backup(&backup_path, target_revision)
            .unwrap();
        assert!(imported.profile.avatar_asset_id.is_some());
        assert!(target
            .load_avatar()
            .unwrap()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert!(matches!(
            target.import_home_backup(&backup_path, target_revision),
            Err(StorageError::Conflict)
        ));
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn image_type_and_size_are_checked() {
        assert!(validate_avatar("image/svg+xml", b"<svg/>").is_err());
        assert!(validate_avatar("image/png", b"not a png").is_err());
    }

    #[test]
    fn invalid_import_keeps_active_home_unchanged() {
        let root = test_root("invalid-import");
        let path = root.join("bad.json");
        let mut storage = Storage::open(&root).unwrap();
        let mut before = storage.load_home().unwrap();
        before.preferences.theme = "forest".into();
        let saved = storage
            .save_preferences(before.version, before.preferences)
            .unwrap();
        fs::write(&path, br#"{"format":"tastellar-home","formatVersion":99}"#).unwrap();
        assert!(matches!(
            storage.import_home_backup(&path, saved.version),
            Err(StorageError::Json(_))
        ));
        let after = storage.load_home().unwrap();
        assert_eq!(after.version, saved.version);
        assert_eq!(after.preferences.theme, "forest");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn library_seeds_vocabulary_and_type_archive_preserves_scores_and_entries() {
        let root = test_root("library-vocabulary");
        let mut storage = Storage::open(&root).unwrap();
        let initial = storage.load_library().unwrap();
        assert_eq!(initial.media_types.len(), 7);
        assert_eq!(initial.criteria.len(), 11);
        assert_eq!(
            initial
                .media_types
                .iter()
                .find(|item| item.id == "anime")
                .unwrap()
                .name,
            "Animation"
        );
        for (id, icon_key) in [
            ("literature", "book-open"),
            ("anime", "clapperboard"),
            ("games", "gamepad-2"),
            ("films", "film"),
            ("tv-series", "tv"),
            ("comic", "messages-square"),
        ] {
            assert_eq!(
                initial
                    .media_types
                    .iter()
                    .find(|item| item.id == id)
                    .unwrap()
                    .icon_key,
                icon_key
            );
        }
        assert!(initial
            .media_types
            .iter()
            .any(|item| item.id == "animated-films-series" && item.archived_at.is_some()));
        assert!(initial
            .criteria
            .iter()
            .any(|item| item.id == "ideas-message" && item.name == "Ideas/Message"));
        for id in [
            "literature",
            "anime",
            "games",
            "films",
            "tv-series",
            "comic",
        ] {
            let media_type = initial
                .media_types
                .iter()
                .find(|item| item.id == id)
                .unwrap();
            assert!(media_type.criterion_ids.contains(&"ideas-message".into()));
        }
        assert!(initial.tags.is_empty());

        let initial = storage
            .save_entry(
                initial.revision,
                EntryInput {
                    id: "entry-anime".into(),
                    title: "A text-only anime".into(),
                    disposition: "experienced".into(),
                    media_type_id: Some("anime".into()),
                    overall_rating: None,
                    cover_asset_id: None,
                    release_date: Some(ReleaseDate {
                        year: 2016,
                        month: None,
                        day: None,
                        precision: "year".into(),
                    }),
                    review_text: String::new(),
                    short_label: None,
                    criterion_ratings: BTreeMap::from([("animation".into(), Some(9))]),
                    tag_ids: Vec::new(),
                },
            )
            .unwrap();
        assert_eq!(
            initial.entries[0].criterion_ratings.get("animation"),
            Some(&9)
        );

        assert!(storage
            .archive_media_type(initial.revision, "anime", false)
            .is_err());
        let archived = storage
            .archive_media_type(initial.revision, "anime", true)
            .unwrap();
        assert_eq!(archived.entries[0].media_type_id, None);
        assert_eq!(
            archived.entries[0].criterion_ratings.get("animation"),
            Some(&9)
        );
        assert!(archived
            .media_types
            .iter()
            .find(|item| item.id == "anime")
            .unwrap()
            .archived_at
            .is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn v2_migration_archives_only_seeded_animated_type() {
        let root = test_root("animated-type-migration");
        let storage = Storage::open(&root).unwrap();
        drop(storage);

        // Reconstruct the relevant v2 shape and a user-created type sharing
        // the seeded type's old name. Its different ID must keep it intact.
        let conn = Connection::open(root.join("tastellar.sqlite3")).unwrap();
        drop_test_ranking_schema(&conn);
        conn.execute(
            "UPDATE media_type SET name='Legacy animation default',normalized_name='legacy animation default',archived_at=NULL WHERE id='animated-films-series'",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO media_type(id,name,normalized_name,sort_order,created_at,updated_at,archived_at,version)
             VALUES('user-animated-films-series','Animated films or series','animated films or series',99,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z',NULL,1)",
            [],
        )
        .unwrap();
        conn.execute_batch(
            "ALTER TABLE entry ADD COLUMN notes_text TEXT NOT NULL DEFAULT '';\
             ALTER TABLE media_type DROP COLUMN icon_key;\
             PRAGMA user_version=2;",
        )
        .unwrap();
        drop(conn);

        let migrated = Storage::open(&root).unwrap().load_library().unwrap();
        let seeded = migrated
            .media_types
            .iter()
            .find(|item| item.id == "animated-films-series")
            .unwrap();
        let custom = migrated
            .media_types
            .iter()
            .find(|item| item.id == "user-animated-films-series")
            .unwrap();
        assert!(seeded.archived_at.is_some());
        assert_eq!(custom.name, "Animated films or series");
        assert!(custom.archived_at.is_none());
        let notes_column_exists: bool = Connection::open(root.join("tastellar.sqlite3"))
            .unwrap()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('entry') WHERE name='notes_text')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!notes_column_exists);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tag_merge_redirects_and_deduplicates_entry_links() {
        let root = test_root("tag-merge");
        let mut storage = Storage::open(&root).unwrap();
        let state = storage.load_library().unwrap();
        let state = storage
            .save_tag(
                state.revision,
                TagInput {
                    id: "tag-a".into(),
                    name: "Favourite".into(),
                },
            )
            .unwrap();
        let state = storage
            .save_tag(
                state.revision,
                TagInput {
                    id: "tag-b".into(),
                    name: "Rewatch".into(),
                },
            )
            .unwrap();
        let state = storage
            .save_entry(
                state.revision,
                EntryInput {
                    id: "entry-tags".into(),
                    title: "Tagged work".into(),
                    disposition: "planned".into(),
                    media_type_id: None,
                    overall_rating: None,
                    cover_asset_id: None,
                    release_date: None,
                    review_text: String::new(),
                    short_label: None,
                    criterion_ratings: BTreeMap::new(),
                    tag_ids: vec!["tag-a".into(), "tag-b".into()],
                },
            )
            .unwrap();
        let merged = storage
            .merge_tags(state.revision, "tag-a", "tag-b")
            .unwrap();
        assert_eq!(merged.tags.len(), 1);
        assert_eq!(merged.entries[0].tag_ids, vec!["tag-b"]);
        let deleted = storage.delete_tag(merged.revision, "tag-b").unwrap();
        assert!(deleted.tags.is_empty());
        assert!(deleted.entries[0].tag_ids.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn version_one_home_data_survives_library_schema_migration() {
        let root = test_root("library-migration-v1");
        let connection = Connection::open(root.join("tastellar.sqlite3")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version>=0));
                 CREATE TABLE profile (id INTEGER PRIMARY KEY CHECK(id=1), nickname TEXT NOT NULL, stated_tastes TEXT NOT NULL, avatar_asset_id TEXT REFERENCES assets(hash));
                 CREATE TABLE guideline (score INTEGER PRIMARY KEY CHECK(score BETWEEN 1 AND 10), description TEXT NOT NULL);
                 CREATE TABLE taste_input (criterion_id TEXT PRIMARY KEY, importance INTEGER NOT NULL CHECK(importance BETWEEN 1 AND 10));
                 CREATE TABLE preference (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, json TEXT NOT NULL);
                 CREATE TABLE workspace (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, json TEXT NOT NULL);
                 CREATE TABLE assets (hash TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL, byte_length INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, created_at INTEGER NOT NULL);
                 INSERT INTO metadata(id,version) VALUES(1,7);
                 INSERT INTO profile(id,nickname,stated_tastes,avatar_asset_id) VALUES(1,'Mira','Quiet character dramas',NULL);
                 INSERT INTO guideline(score,description) VALUES(1,'Not for me'),(2,''),(3,''),(4,''),(5,''),(6,''),(7,''),(8,''),(9,''),(10,'A favorite');
                 INSERT INTO taste_input(criterion_id,importance) VALUES('story',9);
                 PRAGMA user_version=1;",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO preference(id,schema_version,json) VALUES(1,1,?1)",
                [serde_json::to_string(&Preferences::default()).unwrap()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO workspace(id,schema_version,json) VALUES(1,1,?1)",
                [serde_json::to_string(&Workspace::default()).unwrap()],
            )
            .unwrap();
        drop(connection);

        let storage = Storage::open(&root).unwrap();
        let home = storage.load_home().unwrap();
        let library = storage.load_library().unwrap();
        assert_eq!(home.version, 8);
        assert_eq!(home.profile.nickname, "Mira");
        assert_eq!(home.profile.stated_tastes, "Quiet character dramas");
        assert_eq!(home.guidelines["1"], "Not for me");
        assert_eq!(home.guidelines["10"], "A favorite");
        assert_eq!(home.taste_inputs.get("story"), Some(&9));
        assert_eq!(library.media_types.len(), 7);
        assert_eq!(library.criteria.len(), 11);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn home_and_library_writes_share_the_committed_revision_token() {
        let root = test_root("shared-home-library-revision");
        let mut storage = Storage::open(&root).unwrap();
        let home_before = storage.load_home().unwrap();
        let library_before = storage.load_library().unwrap();
        assert_eq!(home_before.version, library_before.revision);

        let mut workspace = home_before.workspace;
        workspace.rail_collapsed = true;
        let home_after = storage
            .save_workspace(home_before.version, workspace)
            .unwrap();
        assert_eq!(home_after.version, library_before.revision + 1);
        assert_eq!(storage.load_library().unwrap().revision, home_after.version);

        let entry = EntryInput {
            id: "entry-after-workspace-save".into(),
            title: "A work saved after navigation".into(),
            disposition: "planned".into(),
            media_type_id: None,
            overall_rating: None,
            cover_asset_id: None,
            release_date: None,
            review_text: String::new(),
            short_label: None,
            criterion_ratings: BTreeMap::new(),
            tag_ids: Vec::new(),
        };
        assert!(matches!(
            storage.save_entry(library_before.revision, entry.clone()),
            Err(StorageError::Conflict)
        ));
        assert!(storage.load_library().unwrap().entries.is_empty());

        let library_after_workspace_save = storage.load_library().unwrap();
        let library_after_entry = storage
            .save_entry(library_after_workspace_save.revision, entry)
            .unwrap();
        assert_eq!(library_after_entry.revision, home_after.version + 1);
        assert_eq!(
            storage.load_home().unwrap().version,
            library_after_entry.revision
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_accepts_rank_sort_snapshots_from_the_library_view() {
        let root = test_root("workspace-library-rank-sort");
        let mut storage = Storage::open(&root).unwrap();
        let mut home = storage.load_home().unwrap();

        for table_sort in ["rank", "canonical"] {
            let mut workspace = home.workspace.clone();
            workspace.tabs[0].library_view = Some(tastellar_domain::LibraryViewSnapshot {
                active_group_id: "all".into(),
                selected_entry_id: None,
                list_mode: "covers".into(),
                search_text: String::new(),
                include_review_search: false,
                include_tag_search: false,
                within_current_filters: false,
                filters: tastellar_domain::LibraryViewFilters {
                    media_types: Vec::new(),
                    tags: Vec::new(),
                    tag_mode: "any".into(),
                    min_year: String::new(),
                    max_year: String::new(),
                    cover: "any".into(),
                    criteria_complete: false,
                },
                table_columns: Vec::new(),
                table_sort: table_sort.into(),
                panel_mode: "details".into(),
                scroll_top: 0.0,
            });
            home = storage.save_workspace(home.version, workspace).unwrap();
            assert_eq!(
                home.workspace.tabs[0]
                    .library_view
                    .as_ref()
                    .unwrap()
                    .table_sort,
                table_sort
            );
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn vocabulary_saves_keep_order_and_reject_name_conflicts_without_committing() {
        let root = test_root("vocabulary-save-atomic");
        let mut storage = Storage::open(&root).unwrap();
        let initial = storage.load_library().unwrap();
        let state = storage
            .save_criterion(
                initial.revision,
                CriterionInput {
                    id: "criterion-focus".into(),
                    name: "Focus".into(),
                    description: Some("How focused the work feels".into()),
                    sort_order: 12,
                },
            )
            .unwrap();
        let state = storage
            .save_media_type(
                state.revision,
                MediaTypeInput {
                    id: "media-novels".into(),
                    name: "Graphic novels".into(),
                    sort_order: 6,
                    icon_key: "shape-circle".into(),
                    criterion_ids: vec!["criterion-focus".into(), "plot".into()],
                },
            )
            .unwrap();
        let media_type = state
            .media_types
            .iter()
            .find(|item| item.id == "media-novels")
            .unwrap();
        assert_eq!(media_type.criterion_ids, vec!["criterion-focus", "plot"]);

        let before_conflict = state.clone();
        assert!(storage
            .save_criterion(
                state.revision,
                CriterionInput {
                    id: "criterion-plot-copy".into(),
                    name: "  PLOT  ".into(),
                    description: None,
                    sort_order: 13,
                },
            )
            .is_err());
        assert_eq!(storage.load_library().unwrap(), before_conflict);

        let state = storage
            .save_tag(
                state.revision,
                TagInput {
                    id: "tag-later".into(),
                    name: "Read later".into(),
                },
            )
            .unwrap();
        let before_tag_conflict = state.clone();
        assert!(storage
            .save_tag(
                state.revision,
                TagInput {
                    id: "tag-later-copy".into(),
                    name: "  READ LATER ".into(),
                },
            )
            .is_err());
        assert_eq!(storage.load_library().unwrap(), before_tag_conflict);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn criterion_archive_impact_uses_type_membership_and_keeps_saved_scores() {
        let root = test_root("criterion-archive-impact");
        let mut storage = Storage::open(&root).unwrap();
        let initial = storage.load_library().unwrap();
        let state = storage
            .save_entry(
                initial.revision,
                EntryInput {
                    id: "entry-unscored-axis".into(),
                    title: "Entry with an unused axis".into(),
                    disposition: "experienced".into(),
                    media_type_id: Some("anime".into()),
                    overall_rating: Some(7),
                    cover_asset_id: None,
                    release_date: None,
                    review_text: String::new(),
                    short_label: None,
                    criterion_ratings: BTreeMap::new(),
                    tag_ids: Vec::new(),
                },
            )
            .unwrap();

        assert!(storage
            .archive_criterion(state.revision, "animation", false)
            .is_err());
        assert_eq!(storage.load_library().unwrap(), state);

        let state = storage
            .save_entry(
                state.revision,
                EntryInput {
                    id: "entry-unscored-axis".into(),
                    title: "Entry with an unused axis".into(),
                    disposition: "experienced".into(),
                    media_type_id: Some("anime".into()),
                    overall_rating: Some(7),
                    cover_asset_id: None,
                    release_date: None,
                    review_text: String::new(),
                    short_label: None,
                    criterion_ratings: BTreeMap::from([("animation".into(), Some(8))]),
                    tag_ids: Vec::new(),
                },
            )
            .unwrap();

        let archived = storage
            .archive_criterion(state.revision, "animation", true)
            .unwrap();
        assert!(archived
            .criteria
            .iter()
            .find(|item| item.id == "animation")
            .unwrap()
            .archived_at
            .is_some());
        assert!(!archived
            .media_types
            .iter()
            .find(|item| item.id == "anime")
            .unwrap()
            .criterion_ids
            .contains(&"animation".to_string()));
        assert_eq!(archived.entries[0].title, "Entry with an unused axis");
        assert_eq!(
            archived.entries[0].criterion_ratings.get("animation"),
            Some(&8)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn entry_metadata_and_cover_survive_reopening_storage() {
        let root = test_root("entry-cover-persistence");
        let mut storage = Storage::open(&root).unwrap();
        let initial = storage.load_library().unwrap();
        let state = storage
            .save_tag(
                initial.revision,
                TagInput {
                    id: "tag-cozy".into(),
                    name: "Cozy".into(),
                },
            )
            .unwrap();
        let state = storage
            .save_entry(
                state.revision,
                EntryInput {
                    id: "entry-cover".into(),
                    title: "  The Amber Library  ".into(),
                    disposition: "experienced".into(),
                    media_type_id: Some("literature".into()),
                    overall_rating: Some(9),
                    cover_asset_id: None,
                    release_date: Some(ReleaseDate {
                        year: 2024,
                        month: Some(2),
                        day: Some(29),
                        precision: "day".into(),
                    }),
                    review_text: "A gentle favorite.".into(),
                    short_label: Some("Amber".into()),
                    criterion_ratings: BTreeMap::from([("plot".into(), Some(8))]),
                    tag_ids: vec!["tag-cozy".into()],
                },
            )
            .unwrap();

        let image = image::DynamicImage::new_rgba8(2, 3);
        let mut cursor = Cursor::new(Vec::new());
        image.write_to(&mut cursor, ImageFormat::Png).unwrap();
        let image_bytes = cursor.into_inner();
        let state = storage
            .save_entry_cover(
                state.revision,
                "entry-cover",
                "image/png",
                &BASE64.encode(&image_bytes),
            )
            .unwrap();
        let stored = state
            .entries
            .iter()
            .find(|entry| entry.id == "entry-cover")
            .unwrap();
        let cover_hash = hex_hash(&image_bytes);
        assert_eq!(stored.cover_asset_id.as_deref(), Some(cover_hash.as_str()));
        assert!(storage
            .load_entry_cover("entry-cover")
            .unwrap()
            .unwrap()
            .starts_with("data:image/png;base64,"));

        drop(storage);
        let reopened = Storage::open(&root).unwrap();
        let saved = reopened
            .load_library()
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.id == "entry-cover")
            .unwrap();
        assert_eq!(saved.title, "The Amber Library");
        assert_eq!(saved.disposition, "experienced");
        assert_eq!(saved.media_type_id.as_deref(), Some("literature"));
        assert_eq!(saved.overall_rating, Some(9));
        assert_eq!(saved.cover_asset_id.as_deref(), Some(cover_hash.as_str()));
        assert_eq!(
            saved.release_date,
            Some(ReleaseDate {
                year: 2024,
                month: Some(2),
                day: Some(29),
                precision: "day".into(),
            })
        );
        assert_eq!(saved.review_text, "A gentle favorite.");
        assert_eq!(saved.short_label.as_deref(), Some("Amber"));
        assert_eq!(saved.criterion_ratings.get("plot"), Some(&8));
        assert_eq!(saved.tag_ids, vec!["tag-cozy"]);
        assert!(reopened
            .load_entry_cover("entry-cover")
            .unwrap()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn asset_staging_never_replaces_an_existing_file() {
        let root = test_root("asset-no-clobber");
        let storage = Storage::open(&root).unwrap();
        let relative = "assets/existing.bin";
        let path = root.join(relative);
        fs::write(&path, b"original").unwrap();
        assert!(matches!(
            storage.stage_asset(relative, b"replacement"),
            Err(StorageError::AssetUnavailable)
        ));
        assert_eq!(fs::read(&path).unwrap(), b"original");
        fs::remove_dir_all(root).unwrap();
    }
}
