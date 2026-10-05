use super::ranking::RankingArchive;
use super::{
    entry_group, hex_hash, normalize_name, now_epoch, now_rfc3339,
    replace_provider_credentials_in_transaction, validate_image, ExportResult,
    ProviderCredentialInput, ProviderSession, Storage, StorageError,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rusqlite::{params, Transaction};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use tastellar_domain::{
    validate_criterion, validate_entry, validate_guidelines, validate_media_type,
    validate_preferences, validate_profile, validate_tag, validate_taste_inputs,
    validate_workspace, CriterionInput, Entry, EntryInput, HomeState, LibraryState,
    LibraryViewSnapshot, MediaTypeInput, Profile, ProfileInput, TagInput,
};

const FORMAT: &str = "tastellar-library";
const LEGACY_FORMAT_VERSION: u32 = 1;
const RANKING_FORMAT_VERSION: u32 = 2;
const SOURCE_ORDER_FORMAT_VERSION: u32 = 3;
const FORMAT_VERSION: u32 = 4;
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_STATE_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_ASSET_BYTES: u64 = 25 * 1024 * 1024;
const MAX_ARCHIVE_FILES: usize = 1_000_010;
const HOME_PATH: &str = "data/home.json";
const LIBRARY_PATH: &str = "data/library.json";
const HISTORY_PATH: &str = "data/history.json";
const README_PATH: &str = "README.txt";
const PROVIDER_CREDENTIALS_PATH: &str = "data/provider-credentials.json";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableManifest {
    format: String,
    format_version: u32,
    producer_app_version: String,
    exported_at_utc: String,
    library_id: String,
    datasets: BTreeMap<String, usize>,
    files: Vec<FileDescriptor>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableArchive {
    manifest: PortableManifest,
    home: HomeState,
    library: LibraryState,
    history: PortableHistory,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    provider_credentials: Vec<ProviderCredentialInput>,
    assets: Vec<PortableAsset>,
    readme: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableAsset {
    path: String,
    sha256: String,
    mime_type: String,
    byte_size: u64,
    base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileDescriptor {
    path: String,
    sha256: String,
    byte_size: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableHistory {
    entry_events: Vec<EntryEvent>,
    group_order: Vec<GroupOrder>,
    criterion_rating_records: Vec<CriterionRatingRecord>,
    trashed_entries: Vec<TrashedEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ranking: Option<RankingArchive>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CriterionRatingRecord {
    entry_id: String,
    criterion_id: String,
    recorded_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrashedEntry {
    entry: Entry,
    trashed_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EntryEvent {
    id: String,
    entry_id: String,
    kind: String,
    occurred_at: String,
    recorded_at: String,
    source: String,
    payload_json: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GroupOrder {
    entry_id: String,
    group_id: String,
    order_key: String,
}

impl Storage {
    /// Export the current Home and Library state to a portable, self-contained JSON archive.
    pub fn export_library_archive(
        &self,
        path: impl AsRef<Path>,
    ) -> Result<ExportResult, StorageError> {
        let path = path.as_ref();
        if path.exists() {
            return Err(StorageError::Validation(
                "Destination already exists".into(),
            ));
        }
        let home = self.load_home()?;
        let library = self.load_library()?;
        if home.version != library.revision {
            return Err(StorageError::Conflict);
        }
        let home_bytes = serde_json::to_vec_pretty(&home)?;
        let library_bytes = serde_json::to_vec_pretty(&library)?;
        let history = self.load_portable_history(&library)?;
        let history_bytes = serde_json::to_vec_pretty(&history)?;
        let provider_credentials = self.load_provider_credentials()?;
        let provider_credentials_bytes = serde_json::to_vec_pretty(&provider_credentials)?;
        let readme = README_V4.as_bytes();
        if home_bytes.len() as u64 > MAX_STATE_FILE_BYTES
            || library_bytes.len() as u64 > MAX_STATE_FILE_BYTES
            || history_bytes.len() as u64 > MAX_STATE_FILE_BYTES
            || provider_credentials_bytes.len() as u64 > MAX_STATE_FILE_BYTES
        {
            return Err(StorageError::Validation(
                "Library data exceeds the supported archive size".into(),
            ));
        }

        let mut files = vec![
            descriptor(HOME_PATH, &home_bytes),
            descriptor(LIBRARY_PATH, &library_bytes),
            descriptor(HISTORY_PATH, &history_bytes),
            descriptor(README_PATH, readme),
            descriptor(PROVIDER_CREDENTIALS_PATH, &provider_credentials_bytes),
        ];
        let mut assets = self.load_referenced_assets(&home, &library, &history)?;
        assets.sort_by(|left, right| left.path.cmp(&right.path));
        for asset in &assets {
            files.push(FileDescriptor {
                path: asset.path.clone(),
                sha256: asset.sha256.clone(),
                byte_size: asset.byte_size,
            });
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let total_expanded = files
            .iter()
            .try_fold(0_u64, |total, file| total.checked_add(file.byte_size));
        if total_expanded.map_or(true, |total| total > MAX_EXPANDED_BYTES) {
            return Err(StorageError::Validation(
                "Library assets exceed the supported archive size".into(),
            ));
        }

        let mut datasets = BTreeMap::new();
        datasets.insert("profile".into(), 1);
        datasets.insert("guidelines".into(), home.guidelines.len());
        datasets.insert("tasteInputs".into(), home.taste_inputs.len());
        datasets.insert("entries".into(), library.entries.len());
        datasets.insert("mediaTypes".into(), library.media_types.len());
        datasets.insert("criteria".into(), library.criteria.len());
        datasets.insert("tags".into(), library.tags.len());
        datasets.insert("entryEvents".into(), history.entry_events.len());
        datasets.insert("groupOrder".into(), history.group_order.len());
        datasets.insert(
            "criterionRatingRecords".into(),
            history.criterion_rating_records.len(),
        );
        datasets.insert("trashedEntries".into(), history.trashed_entries.len());
        add_ranking_dataset_counts(
            &mut datasets,
            history
                .ranking
                .as_ref()
                .expect("new exports include ranking state"),
        );
        datasets.insert("assets".into(), assets.len());
        datasets.insert("providerCredentials".into(), provider_credentials.len());
        let manifest = PortableManifest {
            format: FORMAT.into(),
            format_version: FORMAT_VERSION,
            producer_app_version: env!("CARGO_PKG_VERSION").into(),
            exported_at_utc: now_rfc3339(),
            library_id: "local-library".into(),
            datasets,
            files,
        };
        let current_revision: i64 =
            self.conn
                .query_row("SELECT version FROM metadata WHERE id=1", [], |row| {
                    row.get(0)
                })?;
        if current_revision != home.version {
            return Err(StorageError::Conflict);
        }
        let archive = PortableArchive {
            manifest,
            home,
            library,
            history,
            provider_credentials,
            assets: assets
                .into_iter()
                .map(|asset| PortableAsset {
                    path: asset.path,
                    sha256: asset.sha256,
                    mime_type: asset.mime_type,
                    byte_size: asset.byte_size,
                    base64: BASE64.encode(asset.bytes),
                })
                .collect(),
            readme: README_V4.into(),
        };
        let archive_bytes = serde_json::to_vec_pretty(&archive)?;
        if archive_bytes.len() as u64 > MAX_ARCHIVE_BYTES {
            return Err(StorageError::Validation(
                "Library archive exceeds the supported file size".into(),
            ));
        }

        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .ok_or_else(|| StorageError::Validation("Choose a destination folder".into()))?;
        let filename = path
            .file_name()
            .ok_or_else(|| StorageError::Validation("Choose a destination file".into()))?
            .to_string_lossy();
        let temp = parent.join(format!(
            ".{filename}.{}-{}.tmp",
            std::process::id(),
            now_nanos()
        ));
        let result = (|| -> Result<(), StorageError> {
            let file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            let mut file = file;
            file.write_all(&archive_bytes)?;
            file.sync_all()?;
            fs::hard_link(&temp, path)?;
            fs::remove_file(&temp)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result?;
        Ok(ExportResult {
            path: path.to_string_lossy().into_owned(),
        })
    }

    /// Validate and atomically replace Home and Library from a portable JSON archive.
    pub fn import_library_archive(
        &mut self,
        path: impl AsRef<Path>,
        expected_version: i64,
    ) -> Result<HomeState, StorageError> {
        self.ensure_version(expected_version)?;
        let path = path.as_ref();
        if fs::metadata(path)?.len() > MAX_ARCHIVE_BYTES {
            return Err(StorageError::Validation(
                "Archive is larger than the supported import limit".into(),
            ));
        }
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(MAX_ARCHIVE_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
            return Err(StorageError::Validation(
                "Archive is larger than the supported import limit".into(),
            ));
        }
        let (archive, original_archive): (PortableArchive, _) = deserialize_exact(&bytes)?;
        let manifest = &archive.manifest;
        if manifest.format != FORMAT
            || ![
                LEGACY_FORMAT_VERSION,
                RANKING_FORMAT_VERSION,
                SOURCE_ORDER_FORMAT_VERSION,
                FORMAT_VERSION,
            ]
            .contains(&manifest.format_version)
        {
            return Err(StorageError::UnsupportedVersion);
        }
        if (manifest.format_version == LEGACY_FORMAT_VERSION && archive.history.ranking.is_some())
            || (manifest.format_version >= RANKING_FORMAT_VERSION
                && archive.history.ranking.is_none())
        {
            return Err(StorageError::Validation(
                "Archive ranking data does not match its format version".into(),
            ));
        }
        validate_manifest(
            manifest,
            archive.assets.len(),
            archive.provider_credentials.len(),
            manifest.format_version,
        )?;
        let original_home = original_archive
            .get("home")
            .ok_or_else(|| StorageError::Validation("Archive is missing its Home data".into()))?;
        let home_bytes = serialize_home_for_verification(&archive.home, original_home)?;
        let library_bytes = serde_json::to_vec_pretty(&archive.library)?;
        let history_bytes = serde_json::to_vec_pretty(&archive.history)?;
        verify_virtual_file(manifest, HOME_PATH, &home_bytes)?;
        verify_virtual_file(manifest, LIBRARY_PATH, &library_bytes)?;
        verify_virtual_file(manifest, HISTORY_PATH, &history_bytes)?;
        verify_virtual_file(manifest, README_PATH, archive.readme.as_bytes())?;
        if manifest.format_version >= FORMAT_VERSION {
            let credentials_bytes = serde_json::to_vec_pretty(&archive.provider_credentials)?;
            verify_virtual_file(manifest, PROVIDER_CREDENTIALS_PATH, &credentials_bytes)?;
        } else if !archive.provider_credentials.is_empty() {
            return Err(StorageError::Validation(
                "Legacy archives cannot contain provider credentials".into(),
            ));
        }
        ProviderSession::from_saved_credentials(archive.provider_credentials.clone())?;
        let expected_readme = match manifest.format_version {
            LEGACY_FORMAT_VERSION => README_V1,
            RANKING_FORMAT_VERSION => README_V2,
            SOURCE_ORDER_FORMAT_VERSION => README_V3,
            FORMAT_VERSION => README_V4,
            _ => return Err(StorageError::UnsupportedVersion),
        };
        if archive.readme != expected_readme {
            return Err(StorageError::Validation(
                "Archive README does not match its format version".into(),
            ));
        }
        let home = &archive.home;
        let library = &archive.library;
        let history = &archive.history;
        if home.version != library.revision {
            return Err(StorageError::Validation(
                "Archive contains mismatched Home and Library revisions".into(),
            ));
        }
        validate_portable_state(&home, &library, &history)?;
        validate_import_orders(&library, &history, manifest.format_version)?;
        if manifest.datasets.get("profile") != Some(&1)
            || manifest.datasets.get("guidelines") != Some(&home.guidelines.len())
            || manifest.datasets.get("tasteInputs") != Some(&home.taste_inputs.len())
            || manifest.datasets.get("entries") != Some(&library.entries.len())
            || manifest.datasets.get("mediaTypes") != Some(&library.media_types.len())
            || manifest.datasets.get("criteria") != Some(&library.criteria.len())
            || manifest.datasets.get("tags") != Some(&library.tags.len())
            || manifest.datasets.get("entryEvents") != Some(&history.entry_events.len())
            || manifest.datasets.get("groupOrder") != Some(&history.group_order.len())
            || manifest.datasets.get("criterionRatingRecords")
                != Some(&history.criterion_rating_records.len())
            || manifest.datasets.get("trashedEntries") != Some(&history.trashed_entries.len())
            || (manifest.format_version >= FORMAT_VERSION
                && manifest.datasets.get("providerCredentials")
                    != Some(&archive.provider_credentials.len()))
            || !ranking_dataset_counts_match(
                &manifest.datasets,
                history.ranking.as_ref(),
                manifest.format_version,
            )
        {
            return Err(StorageError::Validation(
                "Archive record counts do not match its manifest".into(),
            ));
        }

        let asset_descriptors = manifest
            .files
            .iter()
            .filter(|item| item.path.starts_with("assets/"))
            .collect::<Vec<_>>();
        let referenced = referenced_asset_ids(&home, &library, &history);
        if archive.assets.len() != referenced.len()
            || asset_descriptors.len() != archive.assets.len()
        {
            return Err(StorageError::Validation(
                "Archive is missing or contains unreferenced image files".into(),
            ));
        }
        let descriptors_by_path: HashMap<&str, &FileDescriptor> = manifest
            .files
            .iter()
            .map(|item| (item.path.as_str(), item))
            .collect();
        let mut staged_assets = Vec::with_capacity(archive.assets.len());
        for asset in &archive.assets {
            let descriptor = descriptors_by_path
                .get(asset.path.as_str())
                .ok_or_else(|| {
                    StorageError::Validation("Archive image is not in the manifest".into())
                })?;
            let (hash, extension) = parse_asset_path(&asset.path)?;
            if !referenced.contains(hash) {
                return Err(StorageError::Validation(
                    "Archive contains an unreferenced image".into(),
                ));
            }
            let bytes = BASE64
                .decode(&asset.base64)
                .map_err(|_| StorageError::Validation("Archive image data is invalid".into()))?;
            if bytes.len() as u64 > MAX_ASSET_BYTES
                || bytes.len() as u64 != asset.byte_size
                || asset.byte_size != descriptor.byte_size
                || asset.sha256 != descriptor.sha256
                || hex_hash(&bytes) != hash
                || hex_hash(&bytes) != asset.sha256
            {
                return Err(StorageError::Validation(
                    "An image is too large or its checksum is invalid".into(),
                ));
            }
            let mime = mime_for_extension(extension)?;
            if asset.mime_type != mime {
                return Err(StorageError::Validation(
                    "Image type does not match its file name".into(),
                ));
            }
            let (actual_extension, width, height) = validate_image(mime, &bytes)?;
            if actual_extension != extension {
                return Err(StorageError::Validation(
                    "An image file type does not match its contents".into(),
                ));
            }
            staged_assets.push(StagedAsset {
                hash: hash.to_string(),
                path: asset.path.clone(),
                mime_type: mime.to_string(),
                byte_length: bytes.len() as u64,
                bytes,
                width,
                height,
            });
        }

        // Keep a complete recovery archive before replacing the active state.
        let backups = self.root.join("backups");
        fs::create_dir_all(&backups)?;
        self.export_library_archive(backups.join(format!(
            "pre-import-{}-{}.tastellar.json",
            std::process::id(),
            now_nanos()
        )))?;

        // Content-addressed assets are immutable. A failed transaction can leave only
        // unreferenced files, which are safe for later orphan collection.
        for asset in &staged_assets {
            self.stage_asset(&asset.path, &asset.bytes)?;
        }

        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_version)?;
        for asset in &staged_assets {
            tx.execute(
                "INSERT OR IGNORE INTO assets(hash,relative_path,mime_type,byte_length,width,height,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![asset.hash,asset.path,asset.mime_type,asset.byte_length as i64,asset.width as i64,asset.height as i64,now_epoch()],
            )?;
        }
        let import_orders = archive_import_orders(&library, &history, manifest.format_version)?;
        replace_state_in_transaction(&tx, &home, &library, &history, &import_orders)?;
        Self::import_ranking_archive(&tx, history.ranking.as_ref())?;
        replace_provider_credentials_in_transaction(&tx, &archive.provider_credentials)?;
        tx.execute("UPDATE metadata SET version=version+1 WHERE id=1", [])?;
        tx.commit()?;
        self.load_home()
    }

    fn load_portable_history(
        &self,
        library: &LibraryState,
    ) -> Result<PortableHistory, StorageError> {
        let mut all_entry_ids: HashSet<String> = library
            .entries
            .iter()
            .map(|entry| entry.id.clone())
            .collect();
        let mut trashed_entries = Vec::new();
        {
            let mut statement = self.conn.prepare(
                "SELECT id,version,title,disposition,media_type_id,overall_rating,cover_asset_id,release_year,release_month,release_day,release_precision,review_text,short_label,created_at,updated_at,import_order,trashed_at FROM entry WHERE trashed_at IS NOT NULL ORDER BY trashed_at,id",
            )?;
            let rows = statement.query_map([], |row| {
                let year: Option<i32> = row.get(7)?;
                let month: Option<u8> = row.get(8)?;
                let day: Option<u8> = row.get(9)?;
                let precision: Option<String> = row.get(10)?;
                let release_date = match (year, precision) {
                    (Some(year), Some(precision)) => Some(tastellar_domain::ReleaseDate {
                        year,
                        month,
                        day,
                        precision,
                    }),
                    _ => None,
                };
                Ok((
                    Entry {
                        id: row.get(0)?,
                        import_order: Some(row.get(15)?),
                        version: row.get(1)?,
                        title: row.get(2)?,
                        disposition: row.get(3)?,
                        media_type_id: row.get(4)?,
                        overall_rating: row.get(5)?,
                        cover_asset_id: row.get(6)?,
                        external_identities: Vec::new(),
                        remote_cover: None,
                        release_date,
                        review_text: row.get(11)?,
                        legacy_notes_text: None,
                        legacy_notes_text_snake_case: None,
                        short_label: row.get(12)?,
                        criterion_ratings: BTreeMap::new(),
                        tag_ids: Vec::new(),
                        created_at: row.get(13)?,
                        updated_at: row.get(14)?,
                    },
                    row.get::<_, String>(16)?,
                ))
            })?;
            for row in rows {
                let (mut entry, trashed_at) = row?;
                entry.external_identities = self.load_external_identities(&entry.id)?;
                entry.remote_cover = self.load_remote_cover(&entry.id)?;
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
                all_entry_ids.insert(entry.id.clone());
                trashed_entries.push(TrashedEntry { entry, trashed_at });
            }
        }
        let mut entry_events = Vec::new();
        let mut group_order = Vec::new();
        let mut criterion_rating_records = Vec::new();
        {
            let mut statement = self.conn.prepare(
                "SELECT id,entry_id,kind,occurred_at,recorded_at,source,payload_json FROM entry_event ORDER BY entry_id,occurred_at,recorded_at,id",
            )?;
            for row in statement.query_map([], |row| {
                Ok(EntryEvent {
                    id: row.get(0)?,
                    entry_id: row.get(1)?,
                    kind: row.get(2)?,
                    occurred_at: row.get(3)?,
                    recorded_at: row.get(4)?,
                    source: row.get(5)?,
                    payload_json: row.get(6)?,
                })
            })? {
                let event = row?;
                if all_entry_ids.contains(event.entry_id.as_str()) {
                    entry_events.push(event);
                }
            }
        }
        {
            let mut statement = self.conn.prepare(
                "SELECT entry_id,group_id,order_key FROM group_order ORDER BY group_id,order_key",
            )?;
            for row in statement.query_map([], |row| {
                Ok(GroupOrder {
                    entry_id: row.get(0)?,
                    group_id: row.get(1)?,
                    order_key: row.get(2)?,
                })
            })? {
                let order = row?;
                if all_entry_ids.contains(order.entry_id.as_str()) {
                    group_order.push(order);
                }
            }
        }
        {
            let mut statement = self.conn.prepare(
                "SELECT entry_id,criterion_id,recorded_at FROM criterion_rating ORDER BY entry_id,criterion_id",
            )?;
            for row in statement.query_map([], |row| {
                Ok(CriterionRatingRecord {
                    entry_id: row.get(0)?,
                    criterion_id: row.get(1)?,
                    recorded_at: row.get(2)?,
                })
            })? {
                let record = row?;
                if all_entry_ids.contains(record.entry_id.as_str()) {
                    criterion_rating_records.push(record);
                }
            }
        }
        Ok(PortableHistory {
            entry_events,
            group_order,
            criterion_rating_records,
            trashed_entries,
            ranking: Some(self.export_ranking_archive()?),
        })
    }

    fn load_referenced_assets(
        &self,
        home: &HomeState,
        library: &LibraryState,
        history: &PortableHistory,
    ) -> Result<Vec<ArchiveAsset>, StorageError> {
        let hashes = referenced_asset_ids(home, library, history);
        let mut assets = Vec::with_capacity(hashes.len());
        for hash in hashes {
            let (relative, mime): (String, String) = self.conn.query_row(
                "SELECT relative_path,mime_type FROM assets WHERE hash=?1",
                [&hash],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if !safe_asset_relative_path(&relative, &hash) {
                return Err(StorageError::AssetUnavailable);
            }
            let bytes = self.read_asset(&hash, &relative)?;
            if bytes.len() as u64 > MAX_ASSET_BYTES || hex_hash(&bytes) != hash {
                return Err(StorageError::AssetUnavailable);
            }
            let extension = relative
                .rsplit_once('.')
                .map(|(_, extension)| extension)
                .ok_or(StorageError::AssetUnavailable)?;
            let expected_mime = mime_for_extension(extension)?;
            let (image_extension, _, _) = validate_image(&mime, &bytes)?;
            if mime != expected_mime || image_extension != extension {
                return Err(StorageError::AssetUnavailable);
            }
            assets.push(ArchiveAsset {
                path: relative,
                sha256: hash,
                mime_type: mime,
                byte_size: bytes.len() as u64,
                bytes,
            });
        }
        Ok(assets)
    }
}

const README_V1: &str = "Tastellar portable library archive, version 1.\n\nThis UTF-8 JSON archive contains your Tastellar profile, preferences, workspace, active and trashed stories, ratings and rating timestamps, media types, criteria, tags, entry history, group order, and referenced original images. Data fields use camelCase names. Partial release dates retain their year, month, day, and precision. Image originals are stored as base64 strings and checked against SHA-256 hashes.\n\nThe archive is intended for inspection and restoration in Tastellar. It stays at the destination you selected; the app does not upload it.\n";
const README_V2: &str = "Tastellar portable library archive, version 2.\n\nThis UTF-8 JSON archive contains your Tastellar profile, preferences, workspace, active and trashed stories, ratings and rating timestamps, media types, criteria, tags, entry history, group order, media ranking placement, ranking sessions and preference evidence, and referenced original images. Data fields use camelCase names. Partial release dates retain their year, month, day, and precision. Image originals are stored as base64 strings and checked against SHA-256 hashes. Rebuildable ranking fit caches are recreated after import.\n\nThe archive is intended for inspection and restoration in Tastellar. It stays at the destination you selected; the app does not upload it.\n";
const README_V3: &str = "Tastellar portable library archive, version 3.\n\nThis UTF-8 JSON archive contains your Tastellar profile, preferences, workspace, active and trashed stories, ratings and rating timestamps, immutable source order, media types, criteria, tags, entry history, group order, media ranking placement, ranking sessions and preference evidence, and referenced original images. Data fields use camelCase names. Partial release dates retain their year, month, day, and precision. Image originals are stored as base64 strings and checked against SHA-256 hashes. Rebuildable ranking fit caches are recreated after import.\n\nThe archive is intended for inspection and restoration in Tastellar. It stays at the destination you selected; the app does not upload it.\n";
const README_V4: &str = "Tastellar portable library archive, version 4.\n\nThis UTF-8 JSON archive contains your Tastellar profile, preferences, workspace, active and trashed stories, ratings and rating timestamps, immutable source order, media types, criteria, tags, entry history, group order, media ranking placement, ranking sessions and preference evidence, configured provider credentials, and referenced original images. Data fields use camelCase names. Partial release dates retain their year, month, day, and precision. Image originals are stored as base64 strings and checked against SHA-256 hashes. Rebuildable ranking fit caches are recreated after import.\n\nProvider credentials are included as plain text when configured. Keep this archive private. The archive stays at the destination you selected; the app does not upload it.\n";

#[derive(Debug)]
struct ArchiveAsset {
    path: String,
    sha256: String,
    mime_type: String,
    byte_size: u64,
    bytes: Vec<u8>,
}

#[derive(Debug)]
struct StagedAsset {
    hash: String,
    path: String,
    mime_type: String,
    byte_length: u64,
    bytes: Vec<u8>,
    width: u32,
    height: u32,
}

fn descriptor(path: &str, bytes: &[u8]) -> FileDescriptor {
    FileDescriptor {
        path: path.to_string(),
        sha256: hex_hash(bytes),
        byte_size: bytes.len() as u64,
    }
}

fn add_ranking_dataset_counts(datasets: &mut BTreeMap<String, usize>, ranking: &RankingArchive) {
    datasets.insert("rankingTiers".into(), ranking.tiers.len());
    datasets.insert("rankingEntries".into(), ranking.entries.len());
    datasets.insert("rankingSessions".into(), ranking.sessions.len());
    datasets.insert("rankingJudgments".into(), ranking.judgments.len());
    datasets.insert("rankingBoundaries".into(), ranking.boundaries.len());
    datasets.insert("rankingOrderEvents".into(), ranking.order_events.len());
}

fn ranking_dataset_counts_match(
    datasets: &BTreeMap<String, usize>,
    ranking: Option<&RankingArchive>,
    format_version: u32,
) -> bool {
    match (format_version, ranking) {
        (LEGACY_FORMAT_VERSION, None) => [
            "rankingTiers",
            "rankingEntries",
            "rankingSessions",
            "rankingJudgments",
            "rankingBoundaries",
            "rankingOrderEvents",
        ]
        .iter()
        .all(|name| !datasets.contains_key(*name)),
        (RANKING_FORMAT_VERSION..=FORMAT_VERSION, Some(ranking)) => {
            let mut expected = BTreeMap::new();
            add_ranking_dataset_counts(&mut expected, ranking);
            expected
                .iter()
                .all(|(name, count)| datasets.get(name) == Some(count))
        }
        _ => false,
    }
}

fn validate_manifest(
    manifest: &PortableManifest,
    asset_count: usize,
    provider_credential_count: usize,
    format_version: u32,
) -> Result<(), StorageError> {
    let additional_file_count = usize::from(format_version >= FORMAT_VERSION);
    if manifest.library_id.trim().is_empty()
        || manifest.library_id.len() > 100
        || manifest.producer_app_version.is_empty()
        || manifest.producer_app_version.len() > 100
        || manifest.exported_at_utc.is_empty()
        || manifest.files.len() != asset_count + 4 + additional_file_count
        || manifest.files.len() > MAX_ARCHIVE_FILES
    {
        return Err(StorageError::Validation(
            "Archive manifest is invalid".into(),
        ));
    }
    let mut known_datasets = vec![
        "profile",
        "guidelines",
        "tasteInputs",
        "entries",
        "mediaTypes",
        "criteria",
        "tags",
        "entryEvents",
        "groupOrder",
        "criterionRatingRecords",
        "trashedEntries",
        "assets",
    ];
    if format_version >= RANKING_FORMAT_VERSION {
        known_datasets.extend([
            "rankingTiers",
            "rankingEntries",
            "rankingSessions",
            "rankingJudgments",
            "rankingBoundaries",
            "rankingOrderEvents",
        ]);
    }
    if format_version >= FORMAT_VERSION {
        known_datasets.push("providerCredentials");
    }
    if manifest.datasets.len() != known_datasets.len()
        || manifest
            .datasets
            .keys()
            .any(|dataset| !known_datasets.contains(&dataset.as_str()))
    {
        return Err(StorageError::Validation(
            "Archive contains unsupported dataset definitions".into(),
        ));
    }
    let mut paths = HashSet::new();
    let mut expanded_size = 0_u64;
    let mut found = HashSet::new();
    for file in &manifest.files {
        if !safe_archive_path(&file.path)
            || file.sha256.len() != 64
            || !file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !paths.insert(file.path.as_str())
        {
            return Err(StorageError::Validation(
                "Archive manifest has an unsafe file entry".into(),
            ));
        }
        let path_limit = if file.path.starts_with("assets/") {
            MAX_ASSET_BYTES
        } else {
            MAX_STATE_FILE_BYTES
        };
        if file.byte_size > path_limit {
            return Err(StorageError::Validation(
                "Archive file exceeds the supported size".into(),
            ));
        }
        expanded_size = expanded_size
            .checked_add(file.byte_size)
            .ok_or_else(|| StorageError::Validation("Archive is too large".into()))?;
        found.insert(file.path.as_str());
    }
    if expanded_size > MAX_EXPANDED_BYTES
        || ![HOME_PATH, LIBRARY_PATH, HISTORY_PATH, README_PATH]
            .iter()
            .all(|path| found.contains(path))
        || manifest.files.iter().any(|file| {
            file.path != HOME_PATH
                && file.path != LIBRARY_PATH
                && file.path != HISTORY_PATH
                && file.path != README_PATH
                && !(format_version >= FORMAT_VERSION && file.path == PROVIDER_CREDENTIALS_PATH)
                && !file.path.starts_with("assets/")
        })
    {
        return Err(StorageError::Validation(
            "Archive manifest is incomplete or too large".into(),
        ));
    }
    let asset_files = manifest
        .files
        .iter()
        .filter(|file| file.path.starts_with("assets/"))
        .count();
    if manifest.datasets.get("assets") != Some(&asset_files)
        || manifest.datasets.get("profile") != Some(&1)
        || (format_version >= FORMAT_VERSION
            && manifest.datasets.get("providerCredentials") != Some(&provider_credential_count))
    {
        return Err(StorageError::Validation(
            "Archive asset count does not match its manifest".into(),
        ));
    }
    Ok(())
}

fn verify_virtual_file(
    manifest: &PortableManifest,
    path: &str,
    bytes: &[u8],
) -> Result<(), StorageError> {
    let descriptor = manifest
        .files
        .iter()
        .find(|item| item.path == path)
        .ok_or_else(|| {
            StorageError::Validation("Archive manifest is missing a data file".into())
        })?;
    if descriptor.byte_size != bytes.len() as u64 || descriptor.sha256 != hex_hash(bytes) {
        return Err(StorageError::Validation(format!(
            "Archive checksum failed for {path}"
        )));
    }
    Ok(())
}

const DEFAULT_RECAP_DRAFTS_FOR_ARCHIVE: &str = r#"{"version":1,"drafts":[]}"#;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HomeForVerification<'a> {
    version: i64,
    profile: &'a Profile,
    guidelines: &'a BTreeMap<String, String>,
    taste_inputs: &'a BTreeMap<String, i32>,
    preferences: PreferencesForVerification<'a>,
    workspace: WorkspaceForVerification<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreferencesForVerification<'a> {
    theme: &'a str,
    text_scale: f64,
    reduced_motion: &'a str,
    graphics: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    scenes_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    remember_sidebars_per_tab: Option<bool>,
    restore_tabs: bool,
    startup_section: &'a str,
    previous_tab_shortcut: &'a str,
    next_tab_shortcut: &'a str,
    radar_mode: &'a str,
    visible_criteria: &'a [String],
    #[serde(skip_serializing_if = "string_slice_is_empty_for_archive")]
    analytics_boundary_reviews: &'a [String],
    #[serde(skip_serializing_if = "is_default_recap_drafts_for_archive")]
    recap_drafts: &'a String,
    #[serde(skip_serializing_if = "is_true_for_archive")]
    recap_watermark: bool,
}

fn is_default_recap_drafts_for_archive(value: &&String) -> bool {
    value.as_str() == DEFAULT_RECAP_DRAFTS_FOR_ARCHIVE
}

fn string_slice_is_empty_for_archive(value: &&[String]) -> bool {
    value.is_empty()
}

fn is_true_for_archive(value: &bool) -> bool {
    *value
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceForVerification<'a> {
    tabs: Vec<WorkspaceTabForVerification<'a>>,
    active_tab_id: &'a Option<String>,
    rail_collapsed: bool,
    details_open: bool,
    details_width: f64,
    folder_open: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceTabForVerification<'a> {
    id: &'a str,
    section: &'a str,
    title: &'a str,
    scroll_top: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    library_view: Option<Option<&'a LibraryViewSnapshot>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    folder_open: Option<Option<bool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    details_open: Option<Option<bool>>,
}

/// Recreates the standalone Home JSON using the fields present in this archive.
/// Older portable exports predate several defaulted preferences and workspace
/// fields; including their newly synthesized defaults would fail their original
/// manifest checksum despite restoring the same state.
fn serialize_home_for_verification(
    home: &HomeState,
    original: &serde_json::Value,
) -> Result<Vec<u8>, StorageError> {
    let original_preferences = original.get("preferences").ok_or_else(|| {
        StorageError::Validation("Archive is missing its Home preferences".into())
    })?;
    let original_workspace = original
        .get("workspace")
        .ok_or_else(|| StorageError::Validation("Archive is missing its workspace".into()))?;
    let original_tabs = original_workspace
        .get("tabs")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| StorageError::Validation("Archive workspace tabs are invalid".into()))?;
    if original_tabs.len() != home.workspace.tabs.len() {
        return Err(StorageError::Validation(
            "Archive workspace tabs are invalid".into(),
        ));
    }
    let preferences = &home.preferences;
    let workspace = &home.workspace;
    let projected = HomeForVerification {
        version: home.version,
        profile: &home.profile,
        guidelines: &home.guidelines,
        taste_inputs: &home.taste_inputs,
        preferences: PreferencesForVerification {
            theme: &preferences.theme,
            text_scale: preferences.text_scale,
            reduced_motion: &preferences.reduced_motion,
            graphics: &preferences.graphics,
            scenes_enabled: original_preferences
                .get("scenesEnabled")
                .map(|_| preferences.scenes_enabled),
            remember_sidebars_per_tab: original_preferences
                .get("rememberSidebarsPerTab")
                .map(|_| preferences.remember_sidebars_per_tab),
            restore_tabs: preferences.restore_tabs,
            startup_section: &preferences.startup_section,
            previous_tab_shortcut: &preferences.previous_tab_shortcut,
            next_tab_shortcut: &preferences.next_tab_shortcut,
            radar_mode: &preferences.radar_mode,
            visible_criteria: &preferences.visible_criteria,
            analytics_boundary_reviews: &preferences.analytics_boundary_reviews,
            recap_drafts: &preferences.recap_drafts,
            recap_watermark: preferences.recap_watermark,
        },
        workspace: WorkspaceForVerification {
            tabs: workspace
                .tabs
                .iter()
                .zip(original_tabs)
                .map(|(tab, original_tab)| WorkspaceTabForVerification {
                    id: &tab.id,
                    section: &tab.section,
                    title: &tab.title,
                    scroll_top: tab.scroll_top,
                    library_view: original_tab
                        .get("libraryView")
                        .map(|_| tab.library_view.as_ref()),
                    folder_open: original_tab.get("folderOpen").map(|_| tab.folder_open),
                    details_open: original_tab.get("detailsOpen").map(|_| tab.details_open),
                })
                .collect(),
            active_tab_id: &workspace.active_tab_id,
            rail_collapsed: workspace.rail_collapsed,
            details_open: workspace.details_open,
            details_width: workspace.details_width,
            folder_open: workspace.folder_open,
        },
    };
    Ok(serde_json::to_vec_pretty(&projected)?)
}

fn json_preserves_input(original: &serde_json::Value, decoded: &serde_json::Value) -> bool {
    match (original, decoded) {
        (serde_json::Value::Object(original), serde_json::Value::Object(decoded)) => {
            original.iter().all(|(key, value)| {
                decoded
                    .get(key)
                    .is_some_and(|decoded| json_preserves_input(value, decoded))
            })
        }
        (serde_json::Value::Array(original), serde_json::Value::Array(decoded)) => {
            original.len() == decoded.len()
                && original
                    .iter()
                    .zip(decoded)
                    .all(|(original, decoded)| json_preserves_input(original, decoded))
        }
        _ => original == decoded,
    }
}

fn deserialize_exact<T: DeserializeOwned + Serialize>(
    bytes: &[u8],
) -> Result<(T, serde_json::Value), StorageError> {
    validate_json_depth(bytes, 20)?;
    let value: serde_json::Value = serde_json::from_slice(bytes)?;
    let decoded: T = serde_json::from_value(value.clone())?;
    if !json_preserves_input(&value, &serde_json::to_value(&decoded)?) {
        return Err(StorageError::Validation(
            "Archive contains fields this version cannot preserve".into(),
        ));
    }
    Ok((decoded, value))
}

fn validate_json_depth(bytes: &[u8], maximum: usize) -> Result<(), StorageError> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for byte in bytes {
        if in_string {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match *byte {
            b'"' => in_string = true,
            b'{' | b'[' => {
                depth += 1;
                if depth > maximum {
                    return Err(StorageError::Validation(
                        "Archive JSON is nested too deeply".into(),
                    ));
                }
            }
            b'}' | b']' => {
                depth = depth.saturating_sub(1);
            }
            _ => {}
        }
    }
    if in_string || depth != 0 {
        return Err(StorageError::Validation("Archive JSON is malformed".into()));
    }
    Ok(())
}

fn safe_archive_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.contains('\\')
        && !path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        && !path.contains('\0')
}

fn safe_asset_relative_path(path: &str, hash: &str) -> bool {
    parse_asset_path(path).is_ok_and(|(asset_hash, _)| asset_hash == hash)
}

fn parse_asset_path(path: &str) -> Result<(&str, &str), StorageError> {
    if !path.starts_with("assets/") || !safe_archive_path(path) {
        return Err(StorageError::Validation(
            "Archive image path is invalid".into(),
        ));
    }
    let filename = &path["assets/".len()..];
    let (hash, extension) = filename
        .rsplit_once('.')
        .ok_or_else(|| StorageError::Validation("Archive image path is invalid".into()))?;
    if hash.len() != 64
        || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !["png", "jpg", "webp"].contains(&extension)
    {
        return Err(StorageError::Validation(
            "Archive image path is invalid".into(),
        ));
    }
    Ok((hash, extension))
}

fn mime_for_extension(extension: &str) -> Result<&'static str, StorageError> {
    match extension {
        "png" => Ok("image/png"),
        "jpg" => Ok("image/jpeg"),
        "webp" => Ok("image/webp"),
        _ => Err(StorageError::Validation(
            "Unsupported archive image type".into(),
        )),
    }
}

fn referenced_asset_ids(
    home: &HomeState,
    library: &LibraryState,
    history: &PortableHistory,
) -> HashSet<String> {
    home.profile
        .avatar_asset_id
        .iter()
        .cloned()
        .chain(
            library
                .entries
                .iter()
                .filter_map(|entry| entry.cover_asset_id.clone()),
        )
        .chain(
            history
                .trashed_entries
                .iter()
                .filter_map(|item| item.entry.cover_asset_id.clone()),
        )
        .chain(recap_cover_asset_ids(&home.preferences.recap_drafts))
        .collect()
}

fn recap_cover_asset_ids(raw: &str) -> Vec<String> {
    let Ok(snapshot) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    snapshot
        .get("drafts")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|draft| {
            draft
                .get("slots")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|slot| {
                    slot.get("entry")?
                        .get("coverAssetId")?
                        .as_str()
                        .map(str::to_owned)
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

fn validate_portable_state(
    home: &HomeState,
    library: &LibraryState,
    history: &PortableHistory,
) -> Result<(), StorageError> {
    validate_profile(&ProfileInput {
        nickname: home.profile.nickname.clone(),
        stated_tastes: home.profile.stated_tastes.clone(),
    })?;
    validate_guidelines(&home.guidelines)?;
    validate_taste_inputs(&home.taste_inputs)?;
    validate_preferences(&home.preferences)?;
    validate_workspace(&home.workspace)?;

    if library.entries.len() > 1_000_000
        || library.media_types.len() > 100_000
        || library.criteria.len() > 100_000
        || library.tags.len() > 1_000_000
    {
        return Err(StorageError::Validation(
            "Archive contains too many records".into(),
        ));
    }
    let mut media_ids = HashSet::new();
    let mut media_names = HashSet::new();
    for media_type in &library.media_types {
        validate_media_type(&MediaTypeInput {
            id: media_type.id.clone(),
            name: media_type.name.clone(),
            sort_order: media_type.sort_order,
            icon_key: media_type.icon_key.clone(),
            criterion_ids: media_type.criterion_ids.clone(),
        })?;
        if !media_ids.insert(media_type.id.as_str())
            || (media_type.archived_at.is_none()
                && !media_names.insert(normalize_name(&media_type.name)))
            || media_type.version < 1
            || media_type.created_at.is_empty()
            || media_type.updated_at.is_empty()
        {
            return Err(StorageError::Validation(
                "Archive has duplicate media types".into(),
            ));
        }
    }
    let mut criterion_ids = HashSet::new();
    let mut criterion_names = HashSet::new();
    for criterion in &library.criteria {
        validate_criterion(&CriterionInput {
            id: criterion.id.clone(),
            name: criterion.name.clone(),
            description: criterion.description.clone(),
            sort_order: criterion.sort_order,
        })?;
        if !criterion_ids.insert(criterion.id.as_str())
            || (criterion.archived_at.is_none()
                && !criterion_names.insert(normalize_name(&criterion.name)))
            || criterion.version < 1
            || criterion.created_at.is_empty()
            || criterion.updated_at.is_empty()
        {
            return Err(StorageError::Validation(
                "Archive has duplicate criteria".into(),
            ));
        }
    }
    for media_type in &library.media_types {
        if media_type
            .criterion_ids
            .iter()
            .any(|id| !criterion_ids.contains(id.as_str()))
        {
            return Err(StorageError::Validation(
                "Media type refers to a missing criterion".into(),
            ));
        }
    }
    let mut tag_ids = HashSet::new();
    let mut tag_names = HashSet::new();
    for tag in &library.tags {
        validate_tag(&TagInput {
            id: tag.id.clone(),
            name: tag.name.clone(),
        })?;
        if !tag_ids.insert(tag.id.as_str())
            || !tag_names.insert(normalize_name(&tag.name))
            || tag.version < 1
            || tag.created_at.is_empty()
            || tag.updated_at.is_empty()
        {
            return Err(StorageError::Validation(
                "Archive has duplicate tags".into(),
            ));
        }
    }
    let active_media_ids: HashSet<&str> = library
        .media_types
        .iter()
        .filter(|media_type| media_type.archived_at.is_none())
        .map(|media_type| media_type.id.as_str())
        .collect();
    let mut entry_ids = HashSet::new();
    for entry in &library.entries {
        let input = EntryInput {
            id: entry.id.clone(),
            title: entry.title.clone(),
            disposition: entry.disposition.clone(),
            media_type_id: entry.media_type_id.clone(),
            overall_rating: entry.overall_rating,
            cover_asset_id: entry.cover_asset_id.clone(),
            external_identities: Some(entry.external_identities.clone()),
            remote_cover: entry.remote_cover.clone(),
            clear_remote_cover: false,
            release_date: entry.release_date.clone(),
            review_text: entry.review_text.clone(),
            short_label: entry.short_label.clone(),
            criterion_ratings: entry
                .criterion_ratings
                .iter()
                .map(|(id, score)| (id.clone(), Some(*score)))
                .collect(),
            tag_ids: entry.tag_ids.clone(),
        };
        validate_entry(&input)?;
        if !entry_ids.insert(entry.id.clone())
            || entry.version < 1
            || entry.created_at.is_empty()
            || entry.updated_at.is_empty()
            || entry
                .media_type_id
                .as_deref()
                .is_some_and(|id| !active_media_ids.contains(id))
            || entry
                .criterion_ratings
                .keys()
                .any(|id| !criterion_ids.contains(id.as_str()))
            || entry
                .tag_ids
                .iter()
                .any(|id| !tag_ids.contains(id.as_str()))
        {
            return Err(StorageError::Validation(
                "Archive contains an invalid story reference".into(),
            ));
        }
    }
    for item in &history.trashed_entries {
        let entry = &item.entry;
        let input = EntryInput {
            id: entry.id.clone(),
            title: entry.title.clone(),
            disposition: entry.disposition.clone(),
            media_type_id: entry.media_type_id.clone(),
            overall_rating: entry.overall_rating,
            cover_asset_id: entry.cover_asset_id.clone(),
            external_identities: Some(entry.external_identities.clone()),
            remote_cover: entry.remote_cover.clone(),
            clear_remote_cover: false,
            release_date: entry.release_date.clone(),
            review_text: entry.review_text.clone(),
            short_label: entry.short_label.clone(),
            criterion_ratings: entry
                .criterion_ratings
                .iter()
                .map(|(id, score)| (id.clone(), Some(*score)))
                .collect(),
            tag_ids: entry.tag_ids.clone(),
        };
        validate_entry(&input)?;
        if !entry_ids.insert(entry.id.clone())
            || item.trashed_at.is_empty()
            || entry.version < 1
            || entry.created_at.is_empty()
            || entry.updated_at.is_empty()
            || entry
                .media_type_id
                .as_deref()
                .is_some_and(|id| !media_ids.contains(id))
            || entry
                .criterion_ratings
                .keys()
                .any(|id| !criterion_ids.contains(id.as_str()))
            || entry
                .tag_ids
                .iter()
                .any(|id| !tag_ids.contains(id.as_str()))
        {
            return Err(StorageError::Validation(
                "Archive contains an invalid trashed story".into(),
            ));
        }
    }
    validate_history(history, &library, &entry_ids)?;
    Ok(())
}

fn validate_history(
    history: &PortableHistory,
    library: &LibraryState,
    entry_ids: &HashSet<String>,
) -> Result<(), StorageError> {
    if history.entry_events.len() > 10_000_000
        || history.group_order.len() != entry_ids.len()
        || history.criterion_rating_records.len() > 10_000_000
        || history.trashed_entries.len() > 1_000_000
    {
        return Err(StorageError::Validation(
            "Archive history is incomplete or too large".into(),
        ));
    }
    let mut event_ids = HashSet::new();
    for event in &history.entry_events {
        let payload = serde_json::from_str::<serde_json::Value>(&event.payload_json).ok();
        let valid_source_activity = event.kind != "external_source_activity"
            || payload
                .as_ref()
                .is_some_and(valid_external_source_activity_payload);
        if event.id.is_empty()
            || event.id.len() > 100
            || !event_ids.insert(event.id.as_str())
            || !entry_ids.contains(&event.entry_id)
            || event.kind.is_empty()
            || event.occurred_at.is_empty()
            || event.recorded_at.is_empty()
            || event.source.is_empty()
            || payload.is_none()
            || !valid_source_activity
        {
            return Err(StorageError::Validation(
                "Archive contains an invalid entry event".into(),
            ));
        }
    }
    let mut entries: HashMap<&str, &Entry> = library
        .entries
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect();
    for item in &history.trashed_entries {
        entries.insert(item.entry.id.as_str(), &item.entry);
    }
    let expected_rating_records: usize = entries
        .values()
        .map(|entry| entry.criterion_ratings.len())
        .sum();
    let mut rating_keys = HashSet::new();
    for record in &history.criterion_rating_records {
        let is_known_rating = entries
            .get(record.entry_id.as_str())
            .is_some_and(|entry| entry.criterion_ratings.contains_key(&record.criterion_id));
        if record.recorded_at.is_empty()
            || !is_known_rating
            || !rating_keys.insert((record.entry_id.as_str(), record.criterion_id.as_str()))
        {
            return Err(StorageError::Validation(
                "Archive contains invalid criterion rating history".into(),
            ));
        }
    }
    if history.criterion_rating_records.len() != expected_rating_records {
        return Err(StorageError::Validation(
            "Archive is missing criterion rating timestamps".into(),
        ));
    }
    let mut ordered_entries = HashSet::new();
    let mut group_keys = HashSet::new();
    for order in &history.group_order {
        let Some(entry) = entries.get(order.entry_id.as_str()) else {
            return Err(StorageError::Validation(
                "Archive order references a missing story".into(),
            ));
        };
        let expected_group = entry_group(&entry.disposition, entry.overall_rating);
        if !ordered_entries.insert(order.entry_id.as_str())
            || order.group_id != expected_group
            || order.order_key.is_empty()
            || order.order_key.len() > 100
            || !group_keys.insert((order.group_id.as_str(), order.order_key.as_str()))
        {
            return Err(StorageError::Validation(
                "Archive contains invalid story ordering".into(),
            ));
        }
    }
    Ok(())
}

fn valid_external_source_activity_payload(payload: &serde_json::Value) -> bool {
    let Some(provider) = payload.get("provider").and_then(serde_json::Value::as_str) else {
        return false;
    };
    let Some(activity) = payload.get("activity") else {
        return false;
    };
    let fingerprint = activity
        .get("fingerprint")
        .and_then(serde_json::Value::as_str);
    let kind = activity.get("kind").and_then(serde_json::Value::as_str);
    !provider.trim().is_empty()
        && provider.chars().count() <= 50
        && fingerprint.is_some_and(|value| !value.trim().is_empty() && value.len() <= 200)
        && kind.is_some_and(|value| !value.trim().is_empty() && value.len() <= 50)
}

fn validate_import_orders(
    library: &LibraryState,
    history: &PortableHistory,
    format_version: u32,
) -> Result<(), StorageError> {
    if format_version < SOURCE_ORDER_FORMAT_VERSION {
        return Ok(());
    }
    let mut orders = HashSet::new();
    let mut check = |entry: &Entry| {
        entry
            .import_order
            .filter(|order| *order >= 0 && orders.insert(*order))
            .is_some()
    };
    if library.entries.iter().any(|entry| !check(entry))
        || history
            .trashed_entries
            .iter()
            .any(|item| !check(&item.entry))
    {
        return Err(StorageError::Validation(
            "Archive contains missing or duplicate source ordering".into(),
        ));
    }
    Ok(())
}

fn archive_import_orders(
    library: &LibraryState,
    history: &PortableHistory,
    format_version: u32,
) -> Result<HashMap<String, i64>, StorageError> {
    let mut orders = HashMap::new();
    if format_version >= SOURCE_ORDER_FORMAT_VERSION {
        for entry in &library.entries {
            let order = entry.import_order.ok_or_else(|| {
                StorageError::Validation("Archive is missing source ordering".into())
            })?;
            orders.insert(entry.id.clone(), order);
        }
        for item in &history.trashed_entries {
            let order = item.entry.import_order.ok_or_else(|| {
                StorageError::Validation("Archive is missing source ordering".into())
            })?;
            orders.insert(item.entry.id.clone(), order);
        }
    } else {
        for (index, entry) in library.entries.iter().enumerate() {
            orders.insert(entry.id.clone(), index as i64);
        }
        let offset = library.entries.len() as i64;
        for (index, item) in history.trashed_entries.iter().enumerate() {
            orders.insert(item.entry.id.clone(), offset + index as i64);
        }
    }
    Ok(orders)
}

fn replace_state_in_transaction(
    tx: &Transaction<'_>,
    home: &HomeState,
    library: &LibraryState,
    history: &PortableHistory,
    import_orders: &HashMap<String, i64>,
) -> Result<(), StorageError> {
    let rating_timestamps: HashMap<(&str, &str), &str> = history
        .criterion_rating_records
        .iter()
        .map(|record| {
            (
                (record.entry_id.as_str(), record.criterion_id.as_str()),
                record.recorded_at.as_str(),
            )
        })
        .collect();
    // Removing entries first clears their dependent ratings, tags, events, and ordering.
    tx.execute("DELETE FROM entry", [])?;
    tx.execute("DELETE FROM tag", [])?;
    tx.execute("DELETE FROM media_type_criterion", [])?;
    tx.execute("DELETE FROM media_type", [])?;
    tx.execute("DELETE FROM criterion", [])?;
    for media_type in &library.media_types {
        tx.execute(
            "INSERT INTO media_type(id,name,normalized_name,sort_order,created_at,updated_at,archived_at,version,icon_key) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![media_type.id,media_type.name.trim(),normalize_name(&media_type.name),media_type.sort_order,media_type.created_at,media_type.updated_at,media_type.archived_at,media_type.version,media_type.icon_key],
        )?;
    }
    for criterion in &library.criteria {
        tx.execute(
            "INSERT INTO criterion(id,name,normalized_name,description,sort_order,default_key,created_at,updated_at,archived_at,version) VALUES(?1,?2,?3,?4,?5,NULL,?6,?7,?8,?9)",
            params![criterion.id,criterion.name.trim(),normalize_name(&criterion.name),criterion.description,criterion.sort_order,criterion.created_at,criterion.updated_at,criterion.archived_at,criterion.version],
        )?;
    }
    for media_type in &library.media_types {
        for (order, criterion_id) in media_type.criterion_ids.iter().enumerate() {
            tx.execute(
                "INSERT INTO media_type_criterion(type_id,criterion_id,display_order) VALUES(?1,?2,?3)",
                params![media_type.id,criterion_id,order as i32],
            )?;
        }
    }
    for tag in &library.tags {
        tx.execute(
            "INSERT INTO tag(id,name,normalized_name,created_at,updated_at,version) VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                tag.id,
                tag.name.trim(),
                normalize_name(&tag.name),
                tag.created_at,
                tag.updated_at,
                tag.version
            ],
        )?;
    }
    for entry in &library.entries {
        let import_order = *import_orders
            .get(&entry.id)
            .ok_or_else(|| StorageError::Validation("Archive is missing source ordering".into()))?;
        insert_entry(tx, entry, None, &rating_timestamps, import_order)?;
    }
    for item in &history.trashed_entries {
        let import_order = *import_orders
            .get(&item.entry.id)
            .ok_or_else(|| StorageError::Validation("Archive is missing source ordering".into()))?;
        insert_entry(
            tx,
            &item.entry,
            Some(&item.trashed_at),
            &rating_timestamps,
            import_order,
        )?;
    }
    for order in &history.group_order {
        tx.execute(
            "INSERT INTO group_order(entry_id,group_id,order_key) VALUES(?1,?2,?3)",
            params![order.entry_id, order.group_id, order.order_key],
        )?;
    }
    for event in &history.entry_events {
        tx.execute(
            "INSERT INTO entry_event(id,entry_id,kind,occurred_at,recorded_at,source,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![event.id,event.entry_id,event.kind,event.occurred_at,event.recorded_at,event.source,event.payload_json],
        )?;
    }
    tx.execute(
        "UPDATE profile SET nickname=?1,stated_tastes=?2,avatar_asset_id=?3 WHERE id=1",
        params![
            home.profile.nickname,
            home.profile.stated_tastes,
            home.profile.avatar_asset_id
        ],
    )?;
    for (score, text) in &home.guidelines {
        let score = score
            .parse::<i32>()
            .map_err(|_| StorageError::Validation("Invalid guideline score".into()))?;
        tx.execute(
            "UPDATE guideline SET description=?1 WHERE score=?2",
            params![text, score],
        )?;
    }
    tx.execute("DELETE FROM taste_input", [])?;
    for (id, importance) in &home.taste_inputs {
        tx.execute(
            "INSERT INTO taste_input(criterion_id,importance) VALUES(?1,?2)",
            params![id, importance],
        )?;
    }
    tx.execute(
        "UPDATE preference SET json=?1 WHERE id=1",
        [serde_json::to_string(&home.preferences)?],
    )?;
    tx.execute(
        "UPDATE workspace SET json=?1 WHERE id=1",
        [serde_json::to_string(&home.workspace)?],
    )?;
    Ok(())
}

fn insert_entry(
    tx: &Transaction<'_>,
    entry: &Entry,
    trashed_at: Option<&str>,
    rating_timestamps: &HashMap<(&str, &str), &str>,
    import_order: i64,
) -> Result<(), StorageError> {
    let release = entry.release_date.as_ref();
    tx.execute(
        "INSERT INTO entry(id,title,disposition,media_type_id,overall_rating,cover_asset_id,release_year,release_month,release_day,release_precision,review_text,short_label,created_at,updated_at,version,trashed_at,import_order,remote_cover_provider,remote_cover_url,remote_cover_source_url,remote_cover_attribution) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)",
        params![entry.id,entry.title.trim(),entry.disposition,entry.media_type_id,entry.overall_rating,entry.cover_asset_id,release.map(|date|date.year),release.and_then(|date|date.month),release.and_then(|date|date.day),release.map(|date|date.precision.as_str()),entry.review_text,entry.short_label,entry.created_at,entry.updated_at,entry.version,trashed_at,import_order,entry.remote_cover.as_ref().map(|cover|cover.provider.as_str()),entry.remote_cover.as_ref().map(|cover|cover.url.as_str()),entry.remote_cover.as_ref().and_then(|cover|cover.source_url.as_deref()),entry.remote_cover.as_ref().and_then(|cover|cover.attribution.as_deref())],
    )?;
    for identity in &entry.external_identities {
        tx.execute(
            "INSERT INTO external_identity(provider,entity_kind,external_id,source_url,entry_id) VALUES(?1,?2,?3,?4,?5)",
            params![identity.provider,identity.entity_kind,identity.external_id,identity.source_url,entry.id],
        )?;
    }
    for (criterion_id, score) in &entry.criterion_ratings {
        let recorded_at = rating_timestamps
            .get(&(entry.id.as_str(), criterion_id.as_str()))
            .ok_or_else(|| {
                StorageError::Validation("Archive is missing a criterion rating timestamp".into())
            })?;
        tx.execute(
            "INSERT INTO criterion_rating(entry_id,criterion_id,score,recorded_at) VALUES(?1,?2,?3,?4)",
            params![entry.id,criterion_id,score,recorded_at],
        )?;
    }
    for tag_id in &entry.tag_ids {
        tx.execute(
            "INSERT INTO entry_tag(entry_id,tag_id) VALUES(?1,?2)",
            params![entry.id, tag_id],
        )?;
    }
    Ok(())
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog_capabilities;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use std::path::PathBuf;
    use tastellar_domain::{
        blank_guidelines, CriterionInput, DuelAnswer, EntryInput, MediaTypeInput, ProfileInput,
        RankingPosition, ReleaseDate, TagInput,
    };

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "tastellar-portable-{label}-{}-{}",
            std::process::id(),
            now_nanos()
        ))
    }

    #[test]
    fn portable_source_activity_events_keep_the_provider_activity_kind_contract() {
        assert!(valid_external_source_activity_payload(&serde_json::json!({
            "provider": "steam",
            "activity": { "kind": "owned", "fingerprint": "steam:62002:120" }
        })));
        assert!(valid_external_source_activity_payload(&serde_json::json!({
            "provider": "imdb",
            "activity": { "kind": "item", "fingerprint": "imdb:tt99000001" }
        })));
        assert!(!valid_external_source_activity_payload(
            &serde_json::json!({
                "provider": "steam",
                "activity": { "kind": "owned" }
            })
        ));
        assert!(!valid_external_source_activity_payload(
            &serde_json::json!({
                "activity": { "kind": "owned", "fingerprint": "steam:62002" }
            })
        ));
    }

    fn png_data(color: [u8; 4]) -> (Vec<u8>, String) {
        let image = image::RgbaImage::from_pixel(1, 1, image::Rgba(color));
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        let bytes = cursor.into_inner();
        let encoded = BASE64.encode(&bytes);
        (bytes, encoded)
    }

    fn simple_entry(id: &str, title: &str) -> EntryInput {
        EntryInput {
            id: id.into(),
            title: title.into(),
            disposition: "planned".into(),
            media_type_id: None,
            overall_rating: None,
            cover_asset_id: None,
            external_identities: None,
            remote_cover: None,
            clear_remote_cover: false,
            release_date: None,
            review_text: String::new(),
            short_label: None,
            criterion_ratings: BTreeMap::new(),
            tag_ids: Vec::new(),
        }
    }

    fn scored_entry(id: &str, title: &str, score: i32) -> EntryInput {
        EntryInput {
            id: id.into(),
            title: title.into(),
            disposition: "experienced".into(),
            media_type_id: None,
            overall_rating: Some(score),
            cover_asset_id: None,
            external_identities: None,
            remote_cover: None,
            clear_remote_cover: false,
            release_date: None,
            review_text: String::new(),
            short_label: None,
            criterion_ratings: BTreeMap::new(),
            tag_ids: Vec::new(),
        }
    }

    fn save_scored_entries(storage: &mut Storage, entries: &[(&str, &str, i32)]) {
        for (id, title, score) in entries {
            let revision = storage.load_library().unwrap().revision;
            storage
                .save_entry(revision, scored_entry(id, title, *score))
                .unwrap();
        }
    }

    fn refresh_virtual_file(archive: &mut PortableArchive, path: &str, bytes: &[u8]) {
        let descriptor = archive
            .manifest
            .files
            .iter_mut()
            .find(|item| item.path == path)
            .unwrap();
        descriptor.sha256 = hex_hash(bytes);
        descriptor.byte_size = bytes.len() as u64;
    }

    fn remove_v4_provider_section_for_legacy_archive(archive: &mut PortableArchive) {
        archive.provider_credentials.clear();
        archive.manifest.datasets.remove("providerCredentials");
        archive
            .manifest
            .files
            .retain(|file| file.path != PROVIDER_CREDENTIALS_PATH);
    }

    fn api_key(provider: &str, key: &str) -> ProviderCredentialInput {
        ProviderCredentialInput {
            provider: provider.into(),
            api_key: Some(key.into()),
            steam_id64: None,
            client_id: None,
            client_secret: None,
            clear: false,
        }
    }

    #[test]
    fn v4_archive_round_trip_restores_provider_keys_and_refreshes_session_status() {
        let source_root = test_root("provider-v4-source");
        let target_root = test_root("provider-v4-target");
        fs::create_dir_all(&source_root).unwrap();
        fs::create_dir_all(&target_root).unwrap();
        let archive_path = source_root.join("provider-v4.tastellar.json");
        let mut source = Storage::open(&source_root).unwrap();
        source
            .save_provider_credential(api_key("tmdb", "synthetic-tmdb-key-123"))
            .unwrap();
        source
            .save_provider_credential(api_key("googleBooks", "synthetic-books-key-123"))
            .unwrap();
        source.export_library_archive(&archive_path).unwrap();

        let exported: PortableArchive =
            serde_json::from_slice(&fs::read(&archive_path).unwrap()).unwrap();
        assert_eq!(exported.manifest.format_version, FORMAT_VERSION);
        assert_eq!(exported.provider_credentials.len(), 2);
        assert_eq!(
            exported.manifest.datasets.get("providerCredentials"),
            Some(&2)
        );
        assert!(exported
            .manifest
            .files
            .iter()
            .any(|file| file.path == PROVIDER_CREDENTIALS_PATH));
        let exported_json = fs::read_to_string(&archive_path).unwrap();
        assert!(exported_json.contains("synthetic-tmdb-key-123"));

        let mut target = Storage::open(&target_root).unwrap();
        target
            .save_provider_credential(api_key("steam", "synthetic-steam-key-123"))
            .unwrap();
        let revision = target.load_home().unwrap().version;
        target
            .import_library_archive(&archive_path, revision)
            .unwrap();
        let restored = target.load_provider_credentials().unwrap();
        assert_eq!(restored, exported.provider_credentials);
        let session = ProviderSession::from_saved_credentials(restored).unwrap();
        assert!(
            catalog_capabilities(&session)
                .into_iter()
                .find(|capability| capability.provider == "tmdb")
                .unwrap()
                .configured
        );
        assert!(
            !catalog_capabilities(&session)
                .into_iter()
                .find(|capability| capability.provider == "igdb")
                .unwrap()
                .configured
        );

        drop(source);
        drop(target);
        fs::remove_dir_all(source_root).unwrap();
        fs::remove_dir_all(target_root).unwrap();
    }

    #[test]
    fn version_three_archive_keeps_checksums_and_order_and_clears_existing_keys() {
        let source_root = test_root("provider-v3-source");
        let target_root = test_root("provider-v3-target");
        fs::create_dir_all(&source_root).unwrap();
        fs::create_dir_all(&target_root).unwrap();
        let archive_path = source_root.join("provider-v3.tastellar.json");
        let mut source = Storage::open(&source_root).unwrap();
        save_scored_entries(
            &mut source,
            &[("ordered-a", "Ordered A", 7), ("ordered-b", "Ordered B", 7)],
        );
        source
            .save_provider_credential(api_key("tmdb", "synthetic-tmdb-key-123"))
            .unwrap();
        let expected_orders: Vec<_> = source
            .load_library()
            .unwrap()
            .entries
            .iter()
            .map(|entry| entry.import_order)
            .collect();
        source.export_library_archive(&archive_path).unwrap();

        let mut legacy: PortableArchive =
            serde_json::from_slice(&fs::read(&archive_path).unwrap()).unwrap();
        remove_v4_provider_section_for_legacy_archive(&mut legacy);
        legacy.manifest.format_version = SOURCE_ORDER_FORMAT_VERSION;
        legacy.readme = README_V3.into();
        refresh_virtual_file(&mut legacy, README_PATH, README_V3.as_bytes());
        fs::write(&archive_path, serde_json::to_vec_pretty(&legacy).unwrap()).unwrap();

        let mut target = Storage::open(&target_root).unwrap();
        target
            .save_provider_credential(api_key("steam", "synthetic-steam-key-123"))
            .unwrap();
        let revision = target.load_home().unwrap().version;
        target
            .import_library_archive(&archive_path, revision)
            .unwrap();
        assert!(target.load_provider_credentials().unwrap().is_empty());
        let restored_orders: Vec<_> = target
            .load_library()
            .unwrap()
            .entries
            .iter()
            .map(|entry| entry.import_order)
            .collect();
        assert_eq!(restored_orders, expected_orders);

        drop(source);
        drop(target);
        fs::remove_dir_all(source_root).unwrap();
        fs::remove_dir_all(target_root).unwrap();
    }

    #[test]
    fn invalid_provider_credentials_in_archive_leave_current_keys_untouched() {
        let source_root = test_root("invalid-provider-archive-source");
        let target_root = test_root("invalid-provider-archive-target");
        fs::create_dir_all(&source_root).unwrap();
        fs::create_dir_all(&target_root).unwrap();
        let archive_path = source_root.join("invalid-provider.tastellar.json");
        let mut source = Storage::open(&source_root).unwrap();
        source
            .save_provider_credential(api_key("tmdb", "synthetic-tmdb-key-123"))
            .unwrap();
        source.export_library_archive(&archive_path).unwrap();
        let mut invalid: PortableArchive =
            serde_json::from_slice(&fs::read(&archive_path).unwrap()).unwrap();
        invalid.provider_credentials[0].provider = "unknown-provider".into();
        let credential_bytes = serde_json::to_vec_pretty(&invalid.provider_credentials).unwrap();
        refresh_virtual_file(&mut invalid, PROVIDER_CREDENTIALS_PATH, &credential_bytes);
        fs::write(&archive_path, serde_json::to_vec_pretty(&invalid).unwrap()).unwrap();

        let mut target = Storage::open(&target_root).unwrap();
        target
            .save_provider_credential(api_key("googleBooks", "synthetic-books-key-123"))
            .unwrap();
        let revision = target.load_home().unwrap().version;
        assert!(target
            .import_library_archive(&archive_path, revision)
            .is_err());
        let current = target.load_provider_credentials().unwrap();
        assert_eq!(current.len(), 1);
        assert_eq!(current[0].provider, "googleBooks");

        drop(source);
        drop(target);
        fs::remove_dir_all(source_root).unwrap();
        fs::remove_dir_all(target_root).unwrap();
    }

    #[test]
    fn source_order_survives_ranking_reorders_and_v4_archive_round_trip() {
        let source_root = test_root("source-order-source");
        let target_root = test_root("source-order-target");
        fs::create_dir_all(&source_root).unwrap();
        fs::create_dir_all(&target_root).unwrap();
        let archive_path = source_root.join("source-order.tastellar.json");
        let mut source = Storage::open(&source_root).unwrap();
        save_scored_entries(
            &mut source,
            &[
                ("source-first", "Source First", 7),
                ("source-second", "Source Second", 7),
                ("source-third", "Source Third", 7),
                ("source-fourth", "Source Fourth", 7),
            ],
        );

        let revision = source.load_library().unwrap().revision;
        let state = source
            .move_ranking_entry(
                revision,
                "source-first",
                7,
                true,
                RankingPosition {
                    kind: "start".into(),
                    anchor_id: None,
                },
            )
            .unwrap();
        let state = source
            .move_ranking_entry(
                state.revision,
                "source-second",
                7,
                true,
                RankingPosition {
                    kind: "start".into(),
                    anchor_id: None,
                },
            )
            .unwrap();
        source
            .move_ranking_entry(
                state.revision,
                "source-third",
                7,
                false,
                RankingPosition {
                    kind: "end".into(),
                    anchor_id: None,
                },
            )
            .unwrap();

        let ranked = source.load_ranking().unwrap();
        let tier = ranked.tiers.iter().find(|tier| tier.score == 7).unwrap();
        assert_eq!(tier.placed_ids, ["source-second", "source-first"]);
        assert_eq!(tier.unplaced_ids, ["source-fourth", "source-third"]);
        let source_orders: HashMap<_, _> = ranked
            .library
            .entries
            .iter()
            .map(|entry| (entry.id.as_str(), entry.import_order.unwrap()))
            .collect();
        assert_eq!(source_orders["source-first"], 0);
        assert_eq!(source_orders["source-second"], 1);
        assert_eq!(source_orders["source-third"], 2);
        assert_eq!(source_orders["source-fourth"], 3);

        source.export_library_archive(&archive_path).unwrap();
        let mut target = Storage::open(&target_root).unwrap();
        let target_revision = target.load_home().unwrap().version;
        target
            .import_library_archive(&archive_path, target_revision)
            .unwrap();
        let restored = target.load_ranking().unwrap();
        let restored_tier = restored.tiers.iter().find(|tier| tier.score == 7).unwrap();
        assert_eq!(restored_tier.placed_ids, tier.placed_ids);
        assert_eq!(restored_tier.unplaced_ids, tier.unplaced_ids);
        let restored_orders: HashMap<_, _> = restored
            .library
            .entries
            .iter()
            .map(|entry| (entry.id.as_str(), entry.import_order.unwrap()))
            .collect();
        assert_eq!(restored_orders, source_orders);

        drop(source);
        drop(target);
        fs::remove_dir_all(source_root).unwrap();
        fs::remove_dir_all(target_root).unwrap();
    }

    #[test]
    fn version_two_archive_import_uses_library_json_array_order() {
        let source_root = test_root("v2-source-order-source");
        let target_root = test_root("v2-source-order-target");
        fs::create_dir_all(&source_root).unwrap();
        fs::create_dir_all(&target_root).unwrap();
        let archive_path = source_root.join("legacy-ranking.tastellar.json");
        let mut source = Storage::open(&source_root).unwrap();
        save_scored_entries(
            &mut source,
            &[("array-a", "Array A", 6), ("array-b", "Array B", 6)],
        );
        source.export_library_archive(&archive_path).unwrap();

        let mut legacy: PortableArchive =
            serde_json::from_slice(&fs::read(&archive_path).unwrap()).unwrap();
        remove_v4_provider_section_for_legacy_archive(&mut legacy);
        legacy.manifest.format_version = RANKING_FORMAT_VERSION;
        legacy.readme = README_V2.into();
        legacy.library.entries.reverse();
        for entry in &mut legacy.library.entries {
            entry.import_order = None;
        }
        for item in &mut legacy.history.trashed_entries {
            item.entry.import_order = None;
        }
        let imported_order: Vec<_> = legacy
            .library
            .entries
            .iter()
            .map(|entry| entry.id.clone())
            .collect();
        let library_bytes = serde_json::to_vec_pretty(&legacy.library).unwrap();
        refresh_virtual_file(&mut legacy, LIBRARY_PATH, &library_bytes);
        refresh_virtual_file(&mut legacy, README_PATH, README_V2.as_bytes());
        fs::write(&archive_path, serde_json::to_vec_pretty(&legacy).unwrap()).unwrap();

        let mut target = Storage::open(&target_root).unwrap();
        let target_revision = target.load_home().unwrap().version;
        target
            .import_library_archive(&archive_path, target_revision)
            .unwrap();
        let restored = target.load_library().unwrap();
        let restored_orders: HashMap<_, _> = restored
            .entries
            .iter()
            .map(|entry| (entry.id.as_str(), entry.import_order.unwrap()))
            .collect();
        for (index, id) in imported_order.iter().enumerate() {
            assert_eq!(restored_orders[id.as_str()], index as i64);
        }

        drop(source);
        drop(target);
        fs::remove_dir_all(source_root).unwrap();
        fs::remove_dir_all(target_root).unwrap();
    }

    #[test]
    fn schema_nine_backfills_source_order_from_rowid_and_appends_new_entries() {
        let root = test_root("import-order-migration");
        fs::create_dir_all(&root).unwrap();
        let mut storage = Storage::open(&root).unwrap();
        save_scored_entries(
            &mut storage,
            &[("old-a", "Old A", 8), ("old-b", "Old B", 8)],
        );
        let old_rows: Vec<(String, i64)> = {
            let mut statement = storage
                .conn
                .prepare("SELECT id,rowid FROM entry ORDER BY rowid")
                .unwrap();
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        storage
            .conn
            .execute_batch(
                "DROP INDEX entry_import_order_unique; ALTER TABLE entry DROP COLUMN import_order; PRAGMA user_version=8;",
            )
            .unwrap();
        drop(storage);

        let mut migrated = Storage::open(&root).unwrap();
        let loaded = migrated.load_library().unwrap();
        let imported: HashMap<_, _> = loaded
            .entries
            .iter()
            .map(|entry| (entry.id.as_str(), entry.import_order.unwrap()))
            .collect();
        for (id, rowid) in &old_rows {
            assert_eq!(imported[id.as_str()], *rowid);
        }

        let revision = loaded.revision;
        migrated
            .save_entry(revision, simple_entry("new-entry", "New entry"))
            .unwrap();
        let appended = migrated
            .load_library()
            .unwrap()
            .entries
            .iter()
            .find(|entry| entry.id == "new-entry")
            .unwrap()
            .import_order
            .unwrap();
        assert_eq!(
            appended,
            old_rows.iter().map(|(_, rowid)| rowid).max().unwrap() + 1
        );

        drop(migrated);
        fs::remove_dir_all(root).unwrap();
    }

    fn restored_asset_bytes(storage: &Storage, hash: &str) -> Vec<u8> {
        let relative_path: String = storage
            .conn
            .query_row(
                "SELECT relative_path FROM assets WHERE hash=?1",
                [hash],
                |row| row.get(0),
            )
            .unwrap();
        fs::read(storage.root.join(relative_path)).unwrap()
    }

    #[test]
    fn version_one_import_marks_rated_entries_placed_and_keeps_group_order() {
        let source_root = test_root("v1-source");
        let target_root = test_root("v1-target");
        fs::create_dir_all(&source_root).unwrap();
        fs::create_dir_all(&target_root).unwrap();
        let archive_path = source_root.join("legacy.tastellar.json");
        let mut source = Storage::open(&source_root).unwrap();
        save_scored_entries(&mut source, &[("zeta", "Zeta", 7), ("alpha", "Alpha", 7)]);
        source
            .conn
            .execute(
                "UPDATE group_order SET order_key='00000000000000000020' WHERE entry_id='zeta'",
                [],
            )
            .unwrap();
        source
            .conn
            .execute(
                "UPDATE group_order SET order_key='00000000000000000040' WHERE entry_id='alpha'",
                [],
            )
            .unwrap();
        source.export_library_archive(&archive_path).unwrap();

        let mut legacy: PortableArchive =
            serde_json::from_slice(&fs::read(&archive_path).unwrap()).unwrap();
        remove_v4_provider_section_for_legacy_archive(&mut legacy);
        legacy.history.ranking = None;
        legacy.manifest.format_version = LEGACY_FORMAT_VERSION;
        legacy.readme = README_V1.into();
        for name in [
            "rankingTiers",
            "rankingEntries",
            "rankingSessions",
            "rankingJudgments",
            "rankingBoundaries",
            "rankingOrderEvents",
        ] {
            legacy.manifest.datasets.remove(name);
        }
        let history_bytes = serde_json::to_vec_pretty(&legacy.history).unwrap();
        for (path, bytes) in [
            (HISTORY_PATH, history_bytes.as_slice()),
            (README_PATH, README_V1.as_bytes()),
        ] {
            let descriptor = legacy
                .manifest
                .files
                .iter_mut()
                .find(|item| item.path == path)
                .unwrap();
            descriptor.sha256 = hex_hash(bytes);
            descriptor.byte_size = bytes.len() as u64;
        }
        let mut legacy_value = serde_json::to_value(&legacy).unwrap();
        let legacy_home = legacy_value["home"].as_object_mut().unwrap();
        let legacy_preferences = legacy_home["preferences"].as_object_mut().unwrap();
        legacy_preferences.remove("scenesEnabled");
        legacy_preferences.remove("rememberSidebarsPerTab");
        for tab in legacy_home["workspace"]["tabs"].as_array_mut().unwrap() {
            let tab = tab.as_object_mut().unwrap();
            tab.remove("folderOpen");
            tab.remove("detailsOpen");
        }
        let home_bytes =
            serialize_home_for_verification(&legacy.home, &legacy_value["home"]).unwrap();
        let descriptor = legacy_value["manifest"]["files"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|file| file["path"] == HOME_PATH)
            .unwrap();
        descriptor["sha256"] = hex_hash(&home_bytes).into();
        descriptor["byteSize"] = home_bytes.len().into();
        fs::write(
            &archive_path,
            serde_json::to_vec_pretty(&legacy_value).unwrap(),
        )
        .unwrap();

        let mut target = Storage::open(&target_root).unwrap();
        let target_revision = target.load_home().unwrap().version;
        target
            .import_library_archive(&archive_path, target_revision)
            .unwrap();
        let restored_home = target.load_home().unwrap();
        assert!(restored_home.preferences.scenes_enabled);
        assert!(restored_home.preferences.remember_sidebars_per_tab);
        assert!(restored_home
            .workspace
            .tabs
            .iter()
            .all(|tab| tab.folder_open.is_none() && tab.details_open.is_none()));
        let ranking = target.load_ranking().unwrap();
        let tier = ranking.tiers.iter().find(|tier| tier.score == 7).unwrap();
        assert_eq!(tier.placed_ids, vec!["zeta", "alpha"]);
        assert!(tier.unplaced_ids.is_empty());
        let restored_group_order: Vec<(String, String)> = {
            let mut statement = target
                .conn
                .prepare("SELECT entry_id,order_key FROM group_order WHERE group_id='rating-07' ORDER BY order_key COLLATE BINARY")
                .unwrap();
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        assert_eq!(
            restored_group_order
                .iter()
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>(),
            vec!["zeta", "alpha"]
        );
        let migrated_ranking = target.export_ranking_archive().unwrap();
        assert_eq!(
            migrated_ranking.order_key_algorithm_version,
            crate::ranking::ORDER_KEY_ALGORITHM_VERSION
        );
        assert!(migrated_ranking.sessions.is_empty());
        assert!(migrated_ranking.judgments.is_empty());
        assert!(migrated_ranking.boundaries.is_empty());
        assert!(migrated_ranking.order_events.is_empty());
        assert!(restored_group_order
            .iter()
            .all(|(_, key)| key != "00000000000000000020" && key != "00000000000000000040"));
    }

    #[test]
    fn version_two_round_trip_preserves_placement_sessions_and_ranking_evidence() {
        let source_root = test_root("v2-source");
        let target_root = test_root("v2-target");
        fs::create_dir_all(&source_root).unwrap();
        fs::create_dir_all(&target_root).unwrap();
        let archive_path = source_root.join("ranking.tastellar.json");
        let mut source = Storage::open(&source_root).unwrap();
        save_scored_entries(
            &mut source,
            &[
                ("placed-a", "Placed A", 8),
                ("placed-b", "Placed B", 8),
                ("unplaced-c", "Unplaced C", 8),
            ],
        );
        for entry_id in ["placed-a", "placed-b"] {
            let revision = source.load_library().unwrap().revision;
            source
                .move_ranking_entry(
                    revision,
                    entry_id,
                    8,
                    true,
                    RankingPosition {
                        kind: "end".into(),
                        anchor_id: None,
                    },
                )
                .unwrap();
        }
        // Keep score 8 fully placed while testing a normal duel. Unplaced
        // works in a tier now require binary placement duels before normal
        // refinement is available.
        let revision = source.load_library().unwrap().revision;
        source
            .move_ranking_entry(
                revision,
                "unplaced-c",
                9,
                false,
                RankingPosition {
                    kind: "end".into(),
                    anchor_id: None,
                },
            )
            .unwrap();
        let revision = source.load_library().unwrap().revision;
        let normal_session = source
            .start_duel_session(revision, 8, Vec::new(), None, "normal".into())
            .unwrap();
        let normal_prompt = source
            .next_duel(&normal_session.id, false)
            .unwrap()
            .unwrap();
        let opposing_answer = if normal_prompt.left_entry_id == "placed-b" {
            DuelAnswer::LeftWin
        } else {
            DuelAnswer::RightWin
        };
        source
            .answer_duel(
                source.load_library().unwrap().revision,
                &normal_session.id,
                &normal_prompt.duel_id,
                opposing_answer,
            )
            .unwrap();
        source.end_duel_session(&normal_session.id).unwrap();
        let revision = source.load_library().unwrap().revision;
        source
            .move_ranking_entry(
                revision,
                "unplaced-c",
                8,
                false,
                RankingPosition {
                    kind: "end".into(),
                    anchor_id: None,
                },
            )
            .unwrap();
        let revision = source.load_library().unwrap().revision;
        let session = source
            .start_duel_session(
                revision,
                8,
                Vec::new(),
                Some("unplaced-c".into()),
                "binary".into(),
            )
            .unwrap();
        let first_prompt = source.next_duel(&session.id, false).unwrap().unwrap();
        let revision = source.load_library().unwrap().revision;
        source
            .answer_duel(
                revision,
                &session.id,
                &first_prompt.duel_id,
                DuelAnswer::LeftWin,
            )
            .unwrap();
        assert!(source.next_duel(&session.id, false).unwrap().is_some());
        let source_ranking_archive = source.export_ranking_archive().unwrap();
        let source_placed_order = source
            .load_ranking()
            .unwrap()
            .tiers
            .iter()
            .find(|tier| tier.score == 8)
            .unwrap()
            .placed_ids
            .clone();
        source.export_library_archive(&archive_path).unwrap();
        let exported: PortableArchive =
            serde_json::from_slice(&fs::read(&archive_path).unwrap()).unwrap();
        assert_eq!(exported.manifest.format_version, FORMAT_VERSION);
        let archived_ranking = exported.history.ranking.as_ref().unwrap();
        assert_eq!(
            archived_ranking.order_key_algorithm_version,
            crate::ranking::ORDER_KEY_ALGORITHM_VERSION
        );
        assert_eq!(archived_ranking.entries.len(), 3);
        assert_eq!(archived_ranking.schema_version, 3);
        assert_eq!(archived_ranking.sessions.len(), 2);
        assert_eq!(archived_ranking.judgments.len(), 2);
        assert!(!archived_ranking.boundaries.is_empty());
        let manual_pair = archived_ranking
            .boundaries
            .iter()
            .find(|boundary| boundary.first_id == "placed-a" && boundary.second_id == "placed-b")
            .unwrap();
        assert!(!manual_pair.protected);
        assert_eq!(manual_pair.unlock_judgment_ids.len(), 1);
        assert_eq!(exported.manifest.datasets["rankingSessions"], 2);

        let mut target = Storage::open(&target_root).unwrap();
        let target_revision = target.load_home().unwrap().version;
        target
            .import_library_archive(&archive_path, target_revision)
            .unwrap();
        let restored_ranking_archive = target.export_ranking_archive().unwrap();
        assert_eq!(
            serde_json::to_value(source_ranking_archive).unwrap(),
            serde_json::to_value(restored_ranking_archive).unwrap()
        );
        let restored = target.load_ranking().unwrap();
        let tier = restored.tiers.iter().find(|tier| tier.score == 8).unwrap();
        assert_eq!(tier.placed_ids, source_placed_order);
        assert_eq!(tier.unplaced_ids, vec!["unplaced-c"]);
        assert_eq!(
            restored
                .active_session
                .as_ref()
                .unwrap()
                .candidate_entry_id
                .as_deref(),
            Some("unplaced-c")
        );

        let unsupported_path = source_root.join("unsupported-order-keys.tastellar.json");
        let mut unsupported: PortableArchive =
            serde_json::from_slice(&fs::read(&archive_path).unwrap()).unwrap();
        unsupported
            .history
            .ranking
            .as_mut()
            .unwrap()
            .order_key_algorithm_version = i64::MAX;
        let history_bytes = serde_json::to_vec_pretty(&unsupported.history).unwrap();
        let history_descriptor = unsupported
            .manifest
            .files
            .iter_mut()
            .find(|item| item.path == HISTORY_PATH)
            .unwrap();
        history_descriptor.sha256 = hex_hash(&history_bytes);
        history_descriptor.byte_size = history_bytes.len() as u64;
        fs::write(
            &unsupported_path,
            serde_json::to_vec_pretty(&unsupported).unwrap(),
        )
        .unwrap();

        let untouched_root = test_root("v2-unsupported-target");
        fs::create_dir_all(&untouched_root).unwrap();
        let mut untouched = Storage::open(&untouched_root).unwrap();
        let before = untouched.load_library().unwrap();
        let before_revision = before.revision;
        assert!(matches!(
            untouched.import_library_archive(&unsupported_path, before_revision),
            Err(StorageError::UnsupportedVersion)
        ));
        assert_eq!(untouched.load_library().unwrap(), before);
    }

    #[test]
    fn archive_round_trip_keeps_profile_story_vocabulary_assets_and_history() {
        let source_root = test_root("source");
        let target_root = test_root("target");
        fs::create_dir_all(&source_root).unwrap();
        fs::create_dir_all(&target_root).unwrap();
        let archive_path = source_root.join("library.tastellar.json");
        let mut source = Storage::open(&source_root).unwrap();
        let source_revision = source.load_home().unwrap().version;
        let home = source
            .save_home(
                source_revision,
                ProfileInput {
                    nickname: "Ada".into(),
                    stated_tastes: "Stories about discovery".into(),
                },
                blank_guidelines(),
                BTreeMap::new(),
            )
            .unwrap();
        let image = image::DynamicImage::new_rgba8(1, 1);
        let mut image_cursor = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut image_cursor, image::ImageFormat::Png)
            .unwrap();
        let image_bytes = image_cursor.into_inner();
        let image_base64 = BASE64.encode(&image_bytes);
        let home = source
            .save_avatar(home.version, "image/png", &image_base64)
            .unwrap();
        let criterion = source
            .save_criterion(
                home.version,
                CriterionInput {
                    id: "story-quality".into(),
                    name: "Story quality".into(),
                    description: Some("How well the story works".into()),
                    sort_order: 0,
                },
            )
            .unwrap();
        let media_type = source
            .save_media_type(
                criterion.revision,
                MediaTypeInput {
                    id: "film".into(),
                    name: "Film".into(),
                    sort_order: 10,
                    icon_key: "shape-hexagon".into(),
                    criterion_ids: vec!["story-quality".into()],
                },
            )
            .unwrap();
        let tagged = source
            .save_tag(
                media_type.revision,
                TagInput {
                    id: "space-opera".into(),
                    name: "Space opera".into(),
                },
            )
            .unwrap();
        let saved = source
            .save_entry(
                tagged.revision,
                EntryInput {
                    id: "story-1".into(),
                    title: "Across the stars".into(),
                    disposition: "experienced".into(),
                    media_type_id: Some("film".into()),
                    overall_rating: Some(9),
                    cover_asset_id: None,
                    external_identities: None,
                    remote_cover: None,
                    clear_remote_cover: false,
                    release_date: None,
                    review_text: "A favorite.".into(),
                    short_label: Some("Stars".into()),
                    criterion_ratings: BTreeMap::from([("story-quality".into(), Some(8))]),
                    tag_ids: vec!["space-opera".into()],
                },
            )
            .unwrap();
        source
            .conn
            .execute(
                "UPDATE criterion_rating SET recorded_at='2025-04-03T10:30:00Z' WHERE entry_id='story-1' AND criterion_id='story-quality'",
                [],
            )
            .unwrap();
        let saved = source
            .save_entry_cover(saved.revision, "story-1", "image/png", &image_base64)
            .unwrap();
        let saved = source
            .save_entry(
                saved.revision,
                EntryInput {
                    id: "story-2".into(),
                    title: "A retired story".into(),
                    disposition: "planned".into(),
                    media_type_id: None,
                    overall_rating: None,
                    cover_asset_id: None,
                    external_identities: None,
                    remote_cover: None,
                    clear_remote_cover: false,
                    release_date: None,
                    review_text: String::new(),
                    short_label: None,
                    criterion_ratings: BTreeMap::new(),
                    tag_ids: Vec::new(),
                },
            )
            .unwrap();
        source.delete_entry(saved.revision, "story-2").unwrap();
        source.export_library_archive(&archive_path).unwrap();
        let current_archive_bytes = fs::read(&archive_path).unwrap();
        let current_archive_text = String::from_utf8(current_archive_bytes.clone()).unwrap();
        assert!(!current_archive_text.contains("notesText"));
        assert!(!current_archive_text.contains("notes_text"));

        // Older archives may use either spelling. Rebuild the virtual library
        // and history checksums so import exercises compatibility parsing and
        // discards both fields during restore.
        let mut legacy_archive: PortableArchive =
            serde_json::from_slice(&current_archive_bytes).unwrap();
        legacy_archive.library.entries[0].legacy_notes_text_snake_case =
            Some("legacy private note".into());
        legacy_archive.history.trashed_entries[0]
            .entry
            .legacy_notes_text = Some("legacy trashed note".into());
        let legacy_library_bytes = serde_json::to_vec_pretty(&legacy_archive.library).unwrap();
        let legacy_history_bytes = serde_json::to_vec_pretty(&legacy_archive.history).unwrap();
        for (path, contents) in [
            (LIBRARY_PATH, legacy_library_bytes.as_slice()),
            (HISTORY_PATH, legacy_history_bytes.as_slice()),
        ] {
            let descriptor = legacy_archive
                .manifest
                .files
                .iter_mut()
                .find(|item| item.path == path)
                .unwrap();
            descriptor.sha256 = hex_hash(contents);
            descriptor.byte_size = contents.len() as u64;
        }
        fs::write(
            &archive_path,
            serde_json::to_vec_pretty(&legacy_archive).unwrap(),
        )
        .unwrap();

        let mut target = Storage::open(&target_root).unwrap();
        let target_revision = target.load_home().unwrap().version;
        let restored = target
            .import_library_archive(&archive_path, target_revision)
            .unwrap();
        let library = target.load_library().unwrap();
        assert_eq!(restored.version, target_revision + 1);
        assert_eq!(restored.profile.nickname, "Ada");
        assert_eq!(library.revision, target_revision + 1);
        assert_eq!(library.entries.len(), 1);
        assert_eq!(library.entries[0].title, "Across the stars");
        assert_eq!(library.entries[0].review_text, "A favorite.");
        assert_eq!(library.entries[0].media_type_id.as_deref(), Some("film"));
        let imported_library_text = serde_json::to_string(&library).unwrap();
        assert!(!imported_library_text.contains("legacy private note"));
        assert!(!imported_library_text.contains("legacy trashed note"));
        assert_eq!(library.entries[0].criterion_ratings["story-quality"], 8);
        let rating_recorded_at: String = target
            .conn
            .query_row(
                "SELECT recorded_at FROM criterion_rating WHERE entry_id='story-1' AND criterion_id='story-quality'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rating_recorded_at, "2025-04-03T10:30:00Z");
        assert_eq!(library.entries[0].tag_ids, vec!["space-opera"]);
        assert_eq!(library.tags[0].name, "Space opera");
        assert_eq!(
            library
                .media_types
                .iter()
                .find(|item| item.id == "film")
                .unwrap()
                .icon_key,
            "shape-hexagon"
        );
        assert_eq!(
            library
                .media_types
                .iter()
                .find(|item| item.id == "film")
                .unwrap()
                .criterion_ids,
            vec!["story-quality"]
        );
        assert_eq!(
            library.entries[0].cover_asset_id,
            restored.profile.avatar_asset_id
        );
        assert!(target.load_avatar().unwrap().is_some());
        let trashed: i64 = target
            .conn
            .query_row(
                "SELECT COUNT(*) FROM entry WHERE id='story-2' AND trashed_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let event_count: i64 = target
            .conn
            .query_row(
                "SELECT COUNT(*) FROM entry_event WHERE entry_id='story-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(trashed, 1);
        assert!(event_count > 0);

        drop(source);
        drop(target);
        fs::remove_dir_all(source_root).unwrap();
        fs::remove_dir_all(target_root).unwrap();
    }

    #[test]
    fn archive_round_trip_preserves_originals_partial_dates_trash_and_exact_history() {
        let source_root = test_root("full-round-trip-source");
        let target_root = test_root("full-round-trip-target");
        fs::create_dir_all(&source_root).unwrap();
        fs::create_dir_all(&target_root).unwrap();
        let archive_path = source_root.join("complete.tastellar.json");
        let (avatar_bytes, avatar_base64) = png_data([240, 20, 30, 255]);
        let (active_cover_bytes, active_cover_base64) = png_data([20, 240, 30, 255]);
        let (replaced_cover_bytes, replaced_cover_base64) = png_data([240, 170, 20, 255]);
        let (trashed_cover_bytes, trashed_cover_base64) = png_data([20, 30, 240, 255]);
        let avatar_hash = hex_hash(&avatar_bytes);
        let active_cover_hash = hex_hash(&active_cover_bytes);
        let replaced_cover_hash = hex_hash(&replaced_cover_bytes);
        let trashed_cover_hash = hex_hash(&trashed_cover_bytes);

        let mut source = Storage::open(&source_root).unwrap();
        let mut guidelines = blank_guidelines();
        guidelines.insert("10".into(), "Stories I carry with me".into());
        let source_revision = source.load_home().unwrap().version;
        let home = source
            .save_home(
                source_revision,
                ProfileInput {
                    nickname: "Ada".into(),
                    stated_tastes: "Stories about discovery".into(),
                },
                guidelines,
                BTreeMap::from([("plot".into(), 8)]),
            )
            .unwrap();
        let home = source
            .save_avatar(home.version, "image/png", &avatar_base64)
            .unwrap();
        let mut preferences = home.preferences.clone();
        preferences.theme = "forest".into();
        preferences.analytics_boundary_reviews = vec![
            "10:upper-a:lower-b:order-17".into(),
            "9:upper-c:lower-d:order-23".into(),
        ];
        preferences.recap_watermark = false;
        preferences.recap_drafts = serde_json::json!({
            "version": 1,
            "drafts": [{
                "id": "draft-canon",
                "version": 1,
                "templateId": "topTen",
                "libraryRevision": home.version,
                "filter": {
                    "kind": "types",
                    "typeIds": ["film"],
                    "tagIds": ["tag-a", "tag-b"],
                    "tagMode": "all"
                },
                "style": "editorial",
                "mode": "mixed",
                "orientation": "portrait",
                "showTitles": true,
                "showMediaTypes": false,
                "watermark": true,
                "heading": "My top ten",
                "caption": "",
                "rankingLabel": "canonical",
                "slots": [{
                    "id": "slot-1",
                    "page": 0,
                    "entry": {
                        "id": "story-1",
                        "title": "Across the stars",
                        "mediaTypeId": "film",
                        "mediaTypeName": "Film",
                        "shortLabel": "Across stars",
                        "iconKey": "film",
                        "year": 2020,
                        "coverAssetId": active_cover_hash
                    },
                    "rank": 1,
                    "label": null,
                    "predicate": { "kind": "any" },
                    "titleOverride": null
                }],
                "createdAt": "2026-10-03T00:00:00.000Z",
                "updatedAt": "2026-10-03T00:00:00.000Z"
            }]
        })
        .to_string();
        let home = source.save_preferences(home.version, preferences).unwrap();
        let criterion = source
            .save_criterion(
                home.version,
                CriterionInput {
                    id: "story-quality".into(),
                    name: "Story quality".into(),
                    description: Some("How well the story works".into()),
                    sort_order: 0,
                },
            )
            .unwrap();
        let media_type = source
            .save_media_type(
                criterion.revision,
                MediaTypeInput {
                    id: "film".into(),
                    name: "Film".into(),
                    sort_order: 10,
                    icon_key: "film".into(),
                    criterion_ids: vec!["story-quality".into()],
                },
            )
            .unwrap();
        let tagged = source
            .save_tag(
                media_type.revision,
                TagInput {
                    id: "space-opera".into(),
                    name: "Space opera".into(),
                },
            )
            .unwrap();
        let retired = source
            .save_media_type(
                tagged.revision,
                MediaTypeInput {
                    id: "retired-format".into(),
                    name: "Retired format".into(),
                    sort_order: 99,
                    icon_key: "shape-circle".into(),
                    criterion_ids: Vec::new(),
                },
            )
            .unwrap();
        let vocabulary = source
            .archive_media_type(retired.revision, "retired-format", true)
            .unwrap();
        let active = source
            .save_entry(
                vocabulary.revision,
                EntryInput {
                    id: "story-1".into(),
                    title: "Across the stars".into(),
                    disposition: "experienced".into(),
                    media_type_id: Some("film".into()),
                    overall_rating: Some(9),
                    cover_asset_id: None,
                    external_identities: None,
                    remote_cover: None,
                    clear_remote_cover: false,
                    release_date: Some(ReleaseDate {
                        year: 2020,
                        month: Some(5),
                        day: None,
                        precision: "month".into(),
                    }),
                    review_text: "A favorite.".into(),
                    short_label: Some("Stars".into()),
                    criterion_ratings: BTreeMap::from([("story-quality".into(), Some(8))]),
                    tag_ids: vec!["space-opera".into()],
                },
            )
            .unwrap();
        source
            .conn
            .execute(
                "UPDATE criterion_rating SET recorded_at='2025-04-03T10:30:00Z' WHERE entry_id='story-1' AND criterion_id='story-quality'",
                [],
            )
            .unwrap();
        let active = source
            .save_entry_cover(
                active.revision,
                "story-1",
                "image/png",
                &active_cover_base64,
            )
            .unwrap();
        let active = source
            .save_entry_cover(
                active.revision,
                "story-1",
                "image/png",
                &replaced_cover_base64,
            )
            .unwrap();
        source
            .conn
            .execute(
                "UPDATE entry SET created_at='2020-05-01T08:00:00Z',updated_at='2025-04-03T10:31:00Z',version=4 WHERE id='story-1'",
                [],
            )
            .unwrap();
        source
            .conn
            .execute(
                "UPDATE group_order SET order_key='00000000000000000042' WHERE entry_id='story-1'",
                [],
            )
            .unwrap();
        source
            .conn
            .execute(
                "UPDATE entry_event SET occurred_at='2020-05-01T08:01:00Z',recorded_at='2020-05-01T08:02:00Z',source='fixture',payload_json='{\"source\":\"portable-test\"}' WHERE entry_id='story-1' AND kind='created'",
                [],
            )
            .unwrap();
        let trashed = source
            .save_entry(
                active.revision,
                EntryInput {
                    id: "story-2".into(),
                    title: "A retired story".into(),
                    disposition: "planned".into(),
                    media_type_id: Some("film".into()),
                    overall_rating: None,
                    cover_asset_id: None,
                    external_identities: None,
                    remote_cover: None,
                    clear_remote_cover: false,
                    release_date: Some(ReleaseDate {
                        year: 2022,
                        month: Some(2),
                        day: Some(3),
                        precision: "day".into(),
                    }),
                    review_text: "Keep the original review".into(),
                    short_label: Some("Retired".into()),
                    criterion_ratings: BTreeMap::from([("story-quality".into(), Some(6))]),
                    tag_ids: vec!["space-opera".into()],
                },
            )
            .unwrap();
        source
            .conn
            .execute(
                "UPDATE criterion_rating SET recorded_at='2022-02-03T09:10:00Z' WHERE entry_id='story-2' AND criterion_id='story-quality'",
                [],
            )
            .unwrap();
        let trashed = source
            .save_entry_cover(
                trashed.revision,
                "story-2",
                "image/png",
                &trashed_cover_base64,
            )
            .unwrap();
        source.delete_entry(trashed.revision, "story-2").unwrap();
        source
            .conn
            .execute(
                "UPDATE entry SET created_at='2022-02-03T09:00:00Z',updated_at='2022-02-04T11:00:00Z',trashed_at='2022-02-04T11:00:00Z',version=5 WHERE id='story-2'",
                [],
            )
            .unwrap();
        source
            .conn
            .execute(
                "UPDATE group_order SET order_key='00000000000000000017' WHERE entry_id='story-2'",
                [],
            )
            .unwrap();
        source
            .conn
            .execute(
                "UPDATE entry_event SET occurred_at='2022-02-04T11:00:00Z',recorded_at='2022-02-04T11:01:00Z',source='fixture',payload_json='{\"reason\":\"test trash\"}' WHERE entry_id='story-2' AND kind='trashed'",
                [],
            )
            .unwrap();

        source.export_library_archive(&archive_path).unwrap();
        let exported: PortableArchive =
            serde_json::from_slice(&fs::read(&archive_path).unwrap()).unwrap();
        assert_eq!(exported.assets.len(), 4);
        assert_eq!(exported.manifest.datasets["trashedEntries"], 1);
        assert_eq!(exported.manifest.datasets["assets"], 4);
        assert!(exported
            .assets
            .iter()
            .any(|asset| asset.sha256 == active_cover_hash));

        let mut target = Storage::open(&target_root).unwrap();
        let target_revision = target.load_home().unwrap().version;
        let restored = target
            .import_library_archive(&archive_path, target_revision)
            .unwrap();
        let library = target.load_library().unwrap();
        assert_eq!(restored.version, target_revision + 1);
        assert_eq!(restored.profile.nickname, "Ada");
        assert_eq!(restored.profile.stated_tastes, "Stories about discovery");
        assert_eq!(
            restored.profile.avatar_asset_id.as_deref(),
            Some(avatar_hash.as_str())
        );
        assert_eq!(restored.guidelines["10"], "Stories I carry with me");
        assert_eq!(restored.taste_inputs["plot"], 8);
        assert_eq!(restored.preferences.theme, "forest");
        assert_eq!(
            restored.preferences.analytics_boundary_reviews,
            ["10:upper-a:lower-b:order-17", "9:upper-c:lower-d:order-23",]
        );
        assert!(!restored.preferences.recap_watermark);
        let recap_drafts: serde_json::Value =
            serde_json::from_str(&restored.preferences.recap_drafts).unwrap();
        assert_eq!(recap_drafts["drafts"][0]["style"], "editorial");
        assert_eq!(recap_drafts["drafts"][0]["mode"], "mixed");
        assert_eq!(recap_drafts["drafts"][0]["showMediaTypes"], false);
        assert_eq!(
            recap_drafts["drafts"][0]["filter"],
            serde_json::json!({
                "kind": "types",
                "typeIds": ["film"],
                "tagIds": ["tag-a", "tag-b"],
                "tagMode": "all"
            })
        );
        assert_eq!(
            recap_drafts["drafts"][0]["slots"][0]["entry"]["shortLabel"],
            "Across stars"
        );
        assert_eq!(
            recap_drafts["drafts"][0]["slots"][0]["entry"]["iconKey"],
            "film"
        );
        assert_eq!(
            recap_drafts["drafts"][0]["slots"][0]["entry"]["coverAssetId"],
            active_cover_hash
        );
        assert!(target
            .load_recap_cover(&active_cover_hash)
            .unwrap()
            .is_some());
        assert_eq!(library.revision, target_revision + 1);
        assert_eq!(library.entries.len(), 1);
        assert_eq!(library.entries[0].title, "Across the stars");
        assert_eq!(library.entries[0].version, 4);
        assert_eq!(library.entries[0].created_at, "2020-05-01T08:00:00Z");
        assert_eq!(library.entries[0].updated_at, "2025-04-03T10:31:00Z");
        assert_eq!(
            library.entries[0].release_date,
            Some(ReleaseDate {
                year: 2020,
                month: Some(5),
                day: None,
                precision: "month".into(),
            })
        );
        assert_eq!(
            library.entries[0].cover_asset_id.as_deref(),
            Some(replaced_cover_hash.as_str())
        );
        assert_eq!(library.entries[0].criterion_ratings["story-quality"], 8);
        assert_eq!(library.entries[0].tag_ids, vec!["space-opera"]);
        assert_eq!(library.tags[0].name, "Space opera");
        assert_eq!(
            library
                .media_types
                .iter()
                .find(|item| item.id == "film")
                .unwrap()
                .criterion_ids,
            vec!["story-quality"]
        );
        assert!(library
            .media_types
            .iter()
            .find(|item| item.id == "retired-format")
            .unwrap()
            .archived_at
            .is_some());
        assert_eq!(restored_asset_bytes(&target, &avatar_hash), avatar_bytes);
        assert_eq!(
            restored_asset_bytes(&target, &active_cover_hash),
            active_cover_bytes
        );
        assert_eq!(
            restored_asset_bytes(&target, &trashed_cover_hash),
            trashed_cover_bytes
        );
        assert!(target.load_avatar().unwrap().is_some());

        let trash: (i64, String, String, String, Option<i32>, Option<String>, String) = target
            .conn
            .query_row(
                "SELECT version,created_at,updated_at,trashed_at,release_month,cover_asset_id,title FROM entry WHERE id='story-2'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(trash.0, 5);
        assert_eq!(trash.1, "2022-02-03T09:00:00Z");
        assert_eq!(trash.2, "2022-02-04T11:00:00Z");
        assert_eq!(trash.3, "2022-02-04T11:00:00Z");
        assert_eq!(trash.4, Some(2));
        assert_eq!(trash.5.as_deref(), Some(trashed_cover_hash.as_str()));
        assert_eq!(trash.6, "A retired story");
        let rating_times: (String, String) = target
            .conn
            .query_row(
                "SELECT (SELECT recorded_at FROM criterion_rating WHERE entry_id='story-1' AND criterion_id='story-quality'),(SELECT recorded_at FROM criterion_rating WHERE entry_id='story-2' AND criterion_id='story-quality')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(rating_times.0, "2025-04-03T10:30:00Z");
        assert_eq!(rating_times.1, "2022-02-03T09:10:00Z");
        let event: (String, String, String, String) = target
            .conn
            .query_row(
                "SELECT occurred_at,recorded_at,source,payload_json FROM entry_event WHERE entry_id='story-1' AND kind='created'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(event.0, "2020-05-01T08:01:00Z");
        assert_eq!(event.1, "2020-05-01T08:02:00Z");
        assert_eq!(event.2, "fixture");
        assert_eq!(event.3, r#"{"source":"portable-test"}"#);
        let order_key: String = target
            .conn
            .query_row(
                "SELECT order_key FROM group_order WHERE entry_id='story-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(order_key, "00000000000000000042");

        drop(source);
        drop(target);
        fs::remove_dir_all(source_root).unwrap();
        fs::remove_dir_all(target_root).unwrap();
    }

    #[test]
    fn checksum_corrupt_archive_leaves_home_library_and_recovery_directory_untouched() {
        let source_root = test_root("corrupt-source");
        let target_root = test_root("corrupt-target");
        fs::create_dir_all(&source_root).unwrap();
        fs::create_dir_all(&target_root).unwrap();
        let archive_path = source_root.join("corrupt.tastellar.json");
        let mut source = Storage::open(&source_root).unwrap();
        let source_revision = source.load_home().unwrap().version;
        let incoming_home = source
            .save_home(
                source_revision,
                ProfileInput {
                    nickname: "Incoming profile".into(),
                    stated_tastes: "Incoming tastes".into(),
                },
                blank_guidelines(),
                BTreeMap::new(),
            )
            .unwrap();
        let incoming_library = source
            .save_entry(
                incoming_home.version,
                simple_entry("incoming", "Incoming story"),
            )
            .unwrap();
        assert_eq!(
            source.load_home().unwrap().version,
            incoming_library.revision
        );
        source.export_library_archive(&archive_path).unwrap();

        let mut target = Storage::open(&target_root).unwrap();
        let target_revision = target.load_home().unwrap().version;
        let current_home = target
            .save_home(
                target_revision,
                ProfileInput {
                    nickname: "Current profile".into(),
                    stated_tastes: "Current tastes".into(),
                },
                blank_guidelines(),
                BTreeMap::new(),
            )
            .unwrap();
        let current_library = target
            .save_entry(
                current_home.version,
                simple_entry("current", "Current story"),
            )
            .unwrap();
        let before_home = target.load_home().unwrap();
        let before_library = target.load_library().unwrap();
        assert_eq!(before_home.version, current_library.revision);

        let mut document: serde_json::Value =
            serde_json::from_slice(&fs::read(&archive_path).unwrap()).unwrap();
        document["library"]["entries"][0]["title"] = "Tampered story".into();
        fs::write(&archive_path, serde_json::to_vec(&document).unwrap()).unwrap();

        assert!(target
            .import_library_archive(&archive_path, before_home.version)
            .is_err());
        assert_eq!(target.load_home().unwrap(), before_home);
        assert_eq!(target.load_library().unwrap(), before_library);
        assert!(!target.root.join("backups").exists());

        drop(source);
        drop(target);
        fs::remove_dir_all(source_root).unwrap();
        fs::remove_dir_all(target_root).unwrap();
    }

    #[test]
    fn failed_import_transaction_rolls_back_and_retains_preimport_recovery_archive() {
        let source_root = test_root("failed-import-source");
        let target_root = test_root("failed-import-target");
        let recovery_root = test_root("failed-import-recovery");
        fs::create_dir_all(&source_root).unwrap();
        fs::create_dir_all(&target_root).unwrap();
        fs::create_dir_all(&recovery_root).unwrap();
        let archive_path = source_root.join("incoming.tastellar.json");
        let (cover_bytes, cover_base64) = png_data([11, 89, 203, 255]);
        let cover_hash = hex_hash(&cover_bytes);
        let mut source = Storage::open(&source_root).unwrap();
        let source_revision = source.load_home().unwrap().version;
        let incoming_home = source
            .save_home(
                source_revision,
                ProfileInput {
                    nickname: "Incoming".into(),
                    stated_tastes: "New data".into(),
                },
                blank_guidelines(),
                BTreeMap::new(),
            )
            .unwrap();
        let incoming_library = source
            .save_entry(
                incoming_home.version,
                simple_entry("incoming-story", "Incoming story"),
            )
            .unwrap();
        source
            .save_entry_cover(
                incoming_library.revision,
                "incoming-story",
                "image/png",
                &cover_base64,
            )
            .unwrap();
        source.export_library_archive(&archive_path).unwrap();

        let mut target = Storage::open(&target_root).unwrap();
        let target_revision = target.load_home().unwrap().version;
        let current_home = target
            .save_home(
                target_revision,
                ProfileInput {
                    nickname: "Current".into(),
                    stated_tastes: "Keep this profile".into(),
                },
                blank_guidelines(),
                BTreeMap::new(),
            )
            .unwrap();
        target
            .save_entry(
                current_home.version,
                simple_entry("current-story", "Current story"),
            )
            .unwrap();
        let before_home = target.load_home().unwrap();
        let before_library = target.load_library().unwrap();
        assert_eq!(before_home.version, before_library.revision);
        target
            .conn
            .execute_batch(
                "CREATE TRIGGER fail_import_profile_update BEFORE UPDATE ON profile BEGIN SELECT RAISE(ABORT, 'injected import failure'); END;",
            )
            .unwrap();

        assert!(target
            .import_library_archive(&archive_path, before_home.version)
            .is_err());
        assert_eq!(target.load_home().unwrap(), before_home);
        assert_eq!(target.load_library().unwrap(), before_library);
        let staged_path = target.root.join("assets").join(format!("{cover_hash}.png"));
        assert!(
            staged_path.is_file(),
            "validated immutable assets may be orphaned after a failed transaction"
        );
        let asset_rows: i64 = target
            .conn
            .query_row(
                "SELECT COUNT(*) FROM assets WHERE hash=?1",
                [&cover_hash],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            asset_rows, 0,
            "the rolled-back row must not reference the staged file"
        );

        let backup_directory = target.root.join("backups");
        let recovery_archive = fs::read_dir(&backup_directory)
            .unwrap()
            .map(|item| item.unwrap().path())
            .find(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .expect("the pre-import recovery archive should survive the failed commit");
        let mut recovery = Storage::open(&recovery_root).unwrap();
        let recovery_revision = recovery.load_home().unwrap().version;
        let recovered_home = recovery
            .import_library_archive(&recovery_archive, recovery_revision)
            .unwrap();
        let recovered_library = recovery.load_library().unwrap();
        assert_eq!(recovered_home.profile.nickname, "Current");
        assert_eq!(recovered_library.entries.len(), 1);
        assert_eq!(recovered_library.entries[0].id, "current-story");

        drop(recovery);
        drop(source);
        drop(target);
        fs::remove_dir_all(source_root).unwrap();
        fs::remove_dir_all(target_root).unwrap();
        fs::remove_dir_all(recovery_root).unwrap();
    }

    #[test]
    fn invalid_archive_does_not_replace_existing_library() {
        let root = test_root("invalid");
        fs::create_dir_all(&root).unwrap();
        let archive_path = root.join("bad.tastellar.json");
        fs::write(&archive_path, b"not a Tastellar JSON archive").unwrap();
        let mut storage = Storage::open(&root).unwrap();
        let before = storage.load_library().unwrap();
        assert!(storage
            .import_library_archive(&archive_path, before.revision)
            .is_err());
        assert_eq!(storage.load_library().unwrap(), before);
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }
}
