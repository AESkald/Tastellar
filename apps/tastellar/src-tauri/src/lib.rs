use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tastellar_domain::{
    BinaryPlacementResult, CriterionInput, DuelAnswer, EntryInput, HomeState, LibraryState,
    MediaTypeInput, Preferences, ProfileInput, RankingPosition, RankingState, TagInput, Workspace,
};
use tastellar_storage::{
    catalog_capabilities as get_catalog_capabilities,
    configure_provider_credentials as configure_catalog_credentials,
    search_catalog as perform_catalog_search, ExportResult, ImportCommitInput, ImportCommitResult,
    ImportCoverFailure, ImportPreview, ImportUndoResult, PrepareImportInput,
    ProviderCredentialInput, ProviderCredentialState, ProviderSession, ResetWorkspaceResult,
    SearchCatalogInput, SearchCatalogResult, Storage, StorageError,
};
use tauri::Manager;

const EXTERNAL_LINK_HOSTS: &[&str] = &[
    "boosty.to",
    "www.themoviedb.org",
    "openlibrary.org",
    "books.google.com",
    "developers.google.com",
    "www.igdb.com",
    "api-docs.igdb.com",
    "dev.twitch.tv",
    "console.cloud.google.com",
    "steamcommunity.com",
];

fn validate_external_url(value: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(value).map_err(|_| "Invalid external URL".to_owned())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !url
            .host_str()
            .is_some_and(|host| EXTERNAL_LINK_HOSTS.contains(&host))
    {
        return Err("This external link is not allowed".into());
    }
    Ok(url)
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let url = validate_external_url(&url)?.to_string();

    let result: std::io::Result<()> = {
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg(&url)
                .spawn()
                .map(|_| ())
        }

        #[cfg(target_os = "linux")]
        {
            std::process::Command::new("xdg-open")
                .arg(&url)
                .spawn()
                .map(|_| ())
        }

        #[cfg(target_os = "windows")]
        {
            use std::{ffi::OsStr, os::windows::ffi::OsStrExt, ptr};

            #[link(name = "shell32")]
            extern "system" {
                fn ShellExecuteW(
                    hwnd: *mut std::ffi::c_void,
                    operation: *const u16,
                    file: *const u16,
                    parameters: *const u16,
                    directory: *const u16,
                    show_command: i32,
                ) -> *mut std::ffi::c_void;
            }

            let operation: Vec<u16> = OsStr::new("open").encode_wide().chain(Some(0)).collect();
            let file: Vec<u16> = OsStr::new(&url).encode_wide().chain(Some(0)).collect();
            let result = unsafe {
                ShellExecuteW(
                    ptr::null_mut(),
                    operation.as_ptr(),
                    file.as_ptr(),
                    ptr::null(),
                    ptr::null(),
                    1,
                )
            };
            if result as usize <= 32 {
                Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "Windows could not open the link",
                ))
            } else {
                Ok(())
            }
        }
    };

    result.map_err(|error| error.to_string())
}

#[cfg(test)]
mod external_link_tests {
    use super::validate_external_url;

    #[test]
    fn allows_trusted_https_provider_links() {
        assert!(validate_external_url("https://boosty.to/tastellar").is_ok());
        assert!(validate_external_url("https://books.google.com/books?id=123").is_ok());
        assert!(validate_external_url("https://dev.twitch.tv/console/apps").is_ok());
        assert!(validate_external_url("https://console.cloud.google.com/apis/credentials").is_ok());
    }

    #[test]
    fn rejects_untrusted_or_unsafe_urls() {
        assert!(validate_external_url("http://boosty.to/tastellar").is_err());
        assert!(validate_external_url("https://boosty.to.evil.test/").is_err());
        assert!(validate_external_url("https://boosty.to@evil.test/").is_err());
        assert!(validate_external_url("https://boosty.to:444/").is_err());
        assert!(validate_external_url("https://dev.twitch.tv.evil.test/").is_err());
        assert!(validate_external_url("https://console.cloud.google.com@evil.test/").is_err());
        assert!(validate_external_url("file:///etc/passwd").is_err());
    }
}

struct AppStorage(Arc<Mutex<Storage>>);
struct AppProviderSession(Arc<ProviderSession>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandError {
    code: &'static str,
    message: String,
}

impl From<StorageError> for CommandError {
    fn from(value: StorageError) -> Self {
        let code = value.code();
        let message = if code == "Internal" {
            "The local data operation failed. Your changes were not saved.".into()
        } else {
            value.to_string()
        };
        Self { code, message }
    }
}

async fn with_storage<T: Send + 'static>(
    state: tauri::State<'_, AppStorage>,
    operation: impl FnOnce(&mut Storage) -> Result<T, StorageError> + Send + 'static,
) -> Result<T, CommandError> {
    let shared = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let mut storage = shared.lock().map_err(|_| CommandError {
            code: "Internal",
            message: "Storage lock was interrupted".into(),
        })?;
        operation(&mut storage).map_err(Into::into)
    })
    .await
    .map_err(|_| CommandError {
        code: "Internal",
        message: "The data operation was interrupted. Please try again.".into(),
    })?
}

async fn render_cover(
    job: Option<tastellar_storage::CoverImageJob>,
) -> Result<Option<String>, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        job.map(|job| job.render())
            .transpose()
            .map_err(CommandError::from)
    })
    .await
    .map_err(|_| CommandError {
        code: "Internal",
        message: "The cover operation was interrupted.".into(),
    })?
}

#[tauri::command]
async fn load_home(state: tauri::State<'_, AppStorage>) -> Result<HomeState, CommandError> {
    with_storage(state, move |storage| storage.load_home()).await
}

#[tauri::command]
async fn load_recap_cover(
    state: tauri::State<'_, AppStorage>,
    asset_id: String,
) -> Result<Option<String>, CommandError> {
    let job = with_storage(state, move |storage| storage.prepare_recap_cover(&asset_id)).await?;
    render_cover(job).await
}

#[tauri::command]
async fn load_recap_remote_cover(
    provider: String,
    url: String,
) -> Result<Option<String>, CommandError> {
    let cover = tauri::async_runtime::spawn_blocking(move || {
        tastellar_storage::download_catalog_cover(&provider, &url).map_err(CommandError::from)
    })
    .await
    .map_err(|_| CommandError {
        code: "Internal",
        message: "The cover download was interrupted.".into(),
    })??;
    Ok(Some(format!(
        "data:{};base64,{}",
        cover.mime_type,
        BASE64.encode(cover.bytes),
    )))
}

#[tauri::command]
async fn export_recap_image(
    state: tauri::State<'_, AppStorage>,
    path: String,
    base64: String,
) -> Result<ExportResult, CommandError> {
    with_storage(state, move |storage| {
        storage.export_recap_image(&path, &base64)
    })
    .await
}

#[tauri::command]
async fn reset_workspace(
    state: tauri::State<'_, AppStorage>,
    provider_state: tauri::State<'_, AppProviderSession>,
    expected_version: i64,
) -> Result<ResetWorkspaceResult, CommandError> {
    let storage = Arc::clone(&state.0);
    let session = Arc::clone(&provider_state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let mut storage = storage.lock().map_err(|_| CommandError {
            code: "Internal",
            message: "Storage lock was interrupted".into(),
        })?;
        match storage.reset_workspace(expected_version) {
            Ok(result) => {
                let credentials = storage
                    .load_provider_credentials()
                    .map_err(CommandError::from)?;
                session
                    .replace_saved_credentials(credentials)
                    .map_err(CommandError::from)?;
                Ok(result)
            }
            Err(error) if matches!(&error, StorageError::ResetCommittedCleanupPending) => {
                let credentials = storage
                    .load_provider_credentials()
                    .map_err(CommandError::from)?;
                session
                    .replace_saved_credentials(credentials)
                    .map_err(CommandError::from)?;
                Err(CommandError::from(error))
            }
            Err(error) => Err(CommandError::from(error)),
        }
    })
    .await
    .map_err(|_| CommandError {
        code: "Internal",
        message: "The data operation was interrupted. Please try again.".into(),
    })?
}

#[tauri::command]
async fn save_home(
    state: tauri::State<'_, AppStorage>,
    expected_version: i64,
    profile: ProfileInput,
    guidelines: BTreeMap<String, String>,
    taste_inputs: BTreeMap<String, i32>,
) -> Result<HomeState, CommandError> {
    with_storage(state, move |storage| {
        storage.save_home(expected_version, profile, guidelines, taste_inputs)
    })
    .await
}

#[tauri::command]
async fn save_preferences(
    state: tauri::State<'_, AppStorage>,
    expected_version: i64,
    preferences: Preferences,
) -> Result<HomeState, CommandError> {
    with_storage(state, move |storage| {
        storage.save_preferences(expected_version, preferences)
    })
    .await
}

#[tauri::command]
async fn save_workspace(
    state: tauri::State<'_, AppStorage>,
    expected_version: i64,
    workspace: Workspace,
) -> Result<HomeState, CommandError> {
    with_storage(state, move |storage| {
        storage.save_workspace(expected_version, workspace)
    })
    .await
}

#[tauri::command]
async fn save_avatar(
    state: tauri::State<'_, AppStorage>,
    expected_version: i64,
    mime_type: String,
    base64: String,
) -> Result<HomeState, CommandError> {
    with_storage(state, move |storage| {
        storage.save_avatar(expected_version, &mime_type, &base64)
    })
    .await
}

#[tauri::command]
async fn remove_avatar(
    state: tauri::State<'_, AppStorage>,
    expected_version: i64,
) -> Result<HomeState, CommandError> {
    with_storage(state, move |storage| {
        storage.remove_avatar(expected_version)
    })
    .await
}

#[tauri::command]
async fn load_avatar(state: tauri::State<'_, AppStorage>) -> Result<Option<String>, CommandError> {
    with_storage(state, move |storage| storage.load_avatar()).await
}

#[tauri::command]
async fn export_home_backup(
    state: tauri::State<'_, AppStorage>,
    path: String,
) -> Result<ExportResult, CommandError> {
    with_storage(state, move |storage| storage.export_home_backup(&path)).await
}

#[tauri::command]
async fn import_home_backup(
    state: tauri::State<'_, AppStorage>,
    path: String,
    expected_version: i64,
) -> Result<HomeState, CommandError> {
    with_storage(state, move |storage| {
        storage.import_home_backup(&path, expected_version)
    })
    .await
}

#[tauri::command]
async fn export_library_archive(
    state: tauri::State<'_, AppStorage>,
    path: String,
) -> Result<ExportResult, CommandError> {
    with_storage(state, move |storage| storage.export_library_archive(&path)).await
}

#[tauri::command]
async fn import_library_archive(
    state: tauri::State<'_, AppStorage>,
    provider_state: tauri::State<'_, AppProviderSession>,
    path: String,
    expected_version: i64,
) -> Result<HomeState, CommandError> {
    let storage = Arc::clone(&state.0);
    let session = Arc::clone(&provider_state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let mut storage = storage.lock().map_err(|_| CommandError {
            code: "Internal",
            message: "Storage lock was interrupted".into(),
        })?;
        let restored = storage
            .import_library_archive(&path, expected_version)
            .map_err(CommandError::from)?;
        let credentials = storage
            .load_provider_credentials()
            .map_err(CommandError::from)?;
        session
            .replace_saved_credentials(credentials)
            .map_err(CommandError::from)?;
        Ok(restored)
    })
    .await
    .map_err(|_| CommandError {
        code: "Internal",
        message: "The data operation was interrupted. Please try again.".into(),
    })?
}

#[tauri::command]
async fn load_library(state: tauri::State<'_, AppStorage>) -> Result<LibraryState, CommandError> {
    with_storage(state, move |storage| storage.load_library()).await
}

#[tauri::command]
async fn load_ranking(state: tauri::State<'_, AppStorage>) -> Result<RankingState, CommandError> {
    with_storage(state, move |storage| storage.load_ranking()).await
}

#[tauri::command]
async fn move_ranking_entry(
    state: tauri::State<'_, AppStorage>,
    expected_revision: i64,
    entry_id: String,
    score: i32,
    ranked: bool,
    position: RankingPosition,
) -> Result<RankingState, CommandError> {
    with_storage(state, move |storage| {
        storage.move_ranking_entry(expected_revision, &entry_id, score, ranked, position)
    })
    .await
}

#[tauri::command]
async fn undo_last_ranking_move(
    state: tauri::State<'_, AppStorage>,
    expected_revision: i64,
) -> Result<RankingState, CommandError> {
    with_storage(state, move |storage| {
        storage.undo_last_ranking_move(expected_revision)
    })
    .await
}

#[tauri::command]
async fn start_duel_session(
    state: tauri::State<'_, AppStorage>,
    expected_revision: i64,
    score: i32,
    filter_media_type_ids: Vec<String>,
    candidate_entry_id: Option<String>,
    candidate_entry_ids: Option<Vec<String>>,
    eligible_unplaced_entry_ids: Option<Vec<String>>,
    intent: String,
) -> Result<tastellar_domain::DuelSession, CommandError> {
    with_storage(state, move |storage| {
        storage.start_duel_session_with_eligible_unplaced(
            expected_revision,
            score,
            filter_media_type_ids,
            candidate_entry_id,
            candidate_entry_ids,
            eligible_unplaced_entry_ids,
            intent,
        )
    })
    .await
}

#[tauri::command]
async fn next_duel(
    state: tauri::State<'_, AppStorage>,
    session_id: String,
    revisit: bool,
) -> Result<Option<tastellar_domain::DuelPrompt>, CommandError> {
    with_storage(state, move |storage| {
        storage.next_duel(&session_id, revisit)
    })
    .await
}

#[tauri::command]
async fn answer_duel(
    state: tauri::State<'_, AppStorage>,
    expected_revision: i64,
    session_id: String,
    duel_id: String,
    answer: DuelAnswer,
) -> Result<RankingState, CommandError> {
    with_storage(state, move |storage| {
        storage.answer_duel(expected_revision, &session_id, &duel_id, answer)
    })
    .await
}

#[tauri::command]
async fn latest_retractable_judgment_id(
    state: tauri::State<'_, AppStorage>,
    session_id: String,
) -> Result<Option<String>, CommandError> {
    with_storage(state, move |storage| {
        storage.latest_retractable_judgment_id(&session_id)
    })
    .await
}

#[tauri::command]
async fn retract_duel_judgment(
    state: tauri::State<'_, AppStorage>,
    expected_revision: i64,
    judgment_id: String,
) -> Result<RankingState, CommandError> {
    with_storage(state, move |storage| {
        storage.retract_duel_judgment(expected_revision, &judgment_id)
    })
    .await
}

#[tauri::command]
async fn confirm_binary_placement(
    state: tauri::State<'_, AppStorage>,
    expected_revision: i64,
    session_id: String,
    accepted: bool,
) -> Result<BinaryPlacementResult, CommandError> {
    with_storage(state, move |storage| {
        storage.confirm_binary_placement(expected_revision, &session_id, accepted)
    })
    .await
}

#[tauri::command]
async fn pause_duel_session(
    state: tauri::State<'_, AppStorage>,
    session_id: String,
) -> Result<tastellar_domain::DuelSession, CommandError> {
    with_storage(state, move |storage| {
        storage.pause_duel_session(&session_id)
    })
    .await
}

#[tauri::command]
async fn end_duel_session(
    state: tauri::State<'_, AppStorage>,
    session_id: String,
) -> Result<tastellar_domain::DuelSession, CommandError> {
    with_storage(state, move |storage| storage.end_duel_session(&session_id)).await
}

#[tauri::command]
async fn reset_media_ranking(
    state: tauri::State<'_, AppStorage>,
    expected_revision: i64,
) -> Result<LibraryState, CommandError> {
    with_storage(state, move |storage| {
        storage.reset_media_ranking(expected_revision)
    })
    .await
}

#[tauri::command]
async fn save_entry(
    state: tauri::State<'_, AppStorage>,
    expected_revision: i64,
    entry: EntryInput,
) -> Result<LibraryState, CommandError> {
    let shared = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let downloaded_cover = entry
            .remote_cover
            .as_ref()
            .map(|cover| tastellar_storage::download_catalog_cover(&cover.provider, &cover.url))
            .transpose()
            .map_err(CommandError::from)?;
        let mut storage = shared.lock().map_err(|_| CommandError {
            code: "Internal",
            message: "Storage lock was interrupted".into(),
        })?;
        match downloaded_cover {
            Some(cover) => storage.save_entry_with_cover_bytes(
                expected_revision,
                entry,
                &cover.mime_type,
                &cover.bytes,
            ),
            None => storage.save_entry(expected_revision, entry),
        }
        .map_err(CommandError::from)
    })
    .await
    .map_err(|_| CommandError {
        code: "Internal",
        message: "The data operation was interrupted. Please try again.".into(),
    })?
}

#[tauri::command]
async fn prepare_library_import(
    state: tauri::State<'_, AppStorage>,
    provider_state: tauri::State<'_, AppProviderSession>,
    mut input: PrepareImportInput,
) -> Result<ImportPreview, CommandError> {
    let (extra_rows, extra_sources) = if let Some(options) = input.steam.take() {
        let session = Arc::clone(&provider_state.0);
        let games = tauri::async_runtime::spawn_blocking(move || {
            tastellar_storage::steam_owned_games(&session, &options)
        })
        .await
        .map_err(|_| CommandError {
            code: "Internal",
            message: "Steam library import was interrupted.".into(),
        })?
        .map_err(CommandError::from)?;
        let count = games.len();
        let rows = games
            .into_iter()
            .map(tastellar_storage::import::ImportSourceRow::from_steam_owned_game)
            .collect();
        let sources = vec![tastellar_storage::import::ImportSourceSummary {
            provider: "steam".into(),
            source_name: "Steam owned games".into(),
            row_count: count,
            warnings: Vec::new(),
        }];
        (rows, sources)
    } else {
        (Vec::new(), Vec::new())
    };
    with_storage(state, move |storage| {
        storage.prepare_library_import_with_rows(input, extra_rows, extra_sources)
    })
    .await
}

#[tauri::command]
async fn commit_library_import(
    state: tauri::State<'_, AppStorage>,
    input: ImportCommitInput,
) -> Result<ImportCommitResult, CommandError> {
    let checks_for_existing_cover = input.decisions.iter().any(|decision| {
        decision.action == "link"
            && decision.enrichments.iter().any(|enrichment| {
                !enrichment.overwrite_existing_metadata && enrichment.remote_cover.is_some()
            })
    });
    let entries_with_cover = if checks_for_existing_cover {
        let shared_storage = Arc::clone(&state.0);
        tauri::async_runtime::spawn_blocking(move || {
            let storage = shared_storage.lock().map_err(|_| CommandError {
                code: "Internal",
                message: "Storage lock was interrupted".into(),
            })?;
            let library = storage.load_library().map_err(CommandError::from)?;
            Ok::<_, CommandError>(
                library
                    .entries
                    .into_iter()
                    .filter(|entry| entry.cover_asset_id.is_some())
                    .map(|entry| entry.id)
                    .collect::<std::collections::HashSet<_>>(),
            )
        })
        .await
        .map_err(|_| CommandError {
            code: "Internal",
            message: "The current covers could not be checked.".into(),
        })??
    } else {
        std::collections::HashSet::new()
    };
    let requested_covers = input
        .decisions
        .iter()
        .filter(|decision| decision.action != "skip")
        .flat_map(|decision| {
            decision.enrichments.iter().filter_map(|enrichment| {
                let cover_applies = decision.action != "link"
                    || enrichment.overwrite_existing_metadata
                    || decision
                        .target_entry_id
                        .as_ref()
                        .is_some_and(|entry_id| !entries_with_cover.contains(entry_id));
                cover_applies.then_some(())?;
                enrichment.remote_cover.as_ref().map(|cover| {
                    (
                        enrichment.source_row_id.clone(),
                        cover.provider.clone(),
                        cover.url.clone(),
                        enrichment.title.clone(),
                    )
                })
            })
        })
        .collect::<Vec<_>>();
    let covers = tauri::async_runtime::spawn_blocking(move || {
        const MAX_IMPORTED_COVER_BYTES: usize = 80 * 1024 * 1024;
        let mut covers = std::collections::HashMap::new();
        let mut cover_failures = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut total_bytes = 0usize;
        for (source_row_id, provider, url, title) in requested_covers {
            if !seen.insert(source_row_id.clone()) {
                continue;
            }
            let cover = match tastellar_storage::download_catalog_cover(&provider, &url) {
                Ok(cover) => cover,
                Err(error) => {
                    cover_failures.push(ImportCoverFailure {
                        source_row_id,
                        title,
                        message: error.to_string(),
                        provider,
                        url,
                        entry_id: None,
                    });
                    continue;
                }
            };
            if total_bytes.saturating_add(cover.bytes.len()) > MAX_IMPORTED_COVER_BYTES {
                cover_failures.push(ImportCoverFailure {
                    source_row_id,
                    title,
                    message: "Selected covers exceed the 80 MB batch limit.".into(),
                    provider,
                    url,
                    entry_id: None,
                });
                continue;
            }
            total_bytes = total_bytes.saturating_add(cover.bytes.len());
            covers.insert(source_row_id, cover);
        }
        Ok::<_, CommandError>((covers, cover_failures))
    })
    .await
    .map_err(|_| CommandError {
        code: "Internal",
        message: "Cover downloads were interrupted. Please retry the import.".into(),
    })??;
    let (covers, cover_failures) = covers;
    with_storage(state, move |storage| {
        storage.commit_library_import_with_catalog_covers_and_failures(
            input,
            covers,
            cover_failures,
        )
    })
    .await
}

#[tauri::command]
async fn retry_import_cover(
    state: tauri::State<'_, AppStorage>,
    expected_revision: i64,
    entry_id: String,
    batch_id: String,
    provider: String,
    url: String,
) -> Result<LibraryState, CommandError> {
    let cover = tauri::async_runtime::spawn_blocking(move || {
        tastellar_storage::download_catalog_cover(&provider, &url).map_err(CommandError::from)
    })
    .await
    .map_err(|_| CommandError {
        code: "Internal",
        message: "The cover retry was interrupted.".into(),
    })??;
    with_storage(state, move |storage| {
        storage.save_entry_cover_with_bytes(
            expected_revision,
            &entry_id,
            &batch_id,
            &cover.mime_type,
            &cover.bytes,
        )
    })
    .await
}

#[tauri::command]
async fn cancel_library_import(
    state: tauri::State<'_, AppStorage>,
    session_id: String,
) -> Result<(), CommandError> {
    with_storage(state, move |storage| {
        storage.cancel_library_import(&session_id);
        Ok(())
    })
    .await
}

#[tauri::command]
async fn undo_library_import(
    state: tauri::State<'_, AppStorage>,
    batch_id: String,
    expected_revision: i64,
) -> Result<ImportUndoResult, CommandError> {
    with_storage(state, move |storage| {
        storage.undo_library_import(&batch_id, expected_revision)
    })
    .await
}

#[tauri::command]
async fn configure_provider_credentials(
    state: tauri::State<'_, AppProviderSession>,
    storage_state: tauri::State<'_, AppStorage>,
    input: ProviderCredentialInput,
) -> Result<ProviderCredentialState, CommandError> {
    let session = Arc::clone(&state.0);
    let storage = Arc::clone(&storage_state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let mut storage = storage.lock().map_err(|_| CommandError {
            code: "Internal",
            message: "Storage lock was interrupted".into(),
        })?;
        storage
            .save_provider_credential(input.clone())
            .map_err(CommandError::from)?;
        configure_catalog_credentials(&session, input).map_err(CommandError::from)
    })
    .await
    .map_err(|_| CommandError {
        code: "Internal",
        message: "Provider setup was interrupted.".into(),
    })?
}

#[tauri::command]
fn catalog_capabilities(
    state: tauri::State<'_, AppProviderSession>,
) -> Vec<tastellar_storage::CatalogCapability> {
    get_catalog_capabilities(&state.0)
}

#[tauri::command]
async fn search_catalog(
    state: tauri::State<'_, AppProviderSession>,
    input: SearchCatalogInput,
) -> Result<SearchCatalogResult, CommandError> {
    let session = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || perform_catalog_search(&session, input))
        .await
        .map_err(|_| CommandError {
            code: "Internal",
            message: "Catalog search was interrupted.".into(),
        })?
        .map_err(Into::into)
}

#[tauri::command]
async fn delete_entry(
    state: tauri::State<'_, AppStorage>,
    expected_revision: i64,
    entry_id: String,
) -> Result<LibraryState, CommandError> {
    with_storage(state, move |storage| {
        storage.delete_entry(expected_revision, &entry_id)
    })
    .await
}

#[tauri::command]
async fn batch_update_entries(
    state: tauri::State<'_, AppStorage>,
    input: tastellar_domain::BatchEntryUpdateInput,
) -> Result<LibraryState, CommandError> {
    with_storage(state, move |storage| storage.batch_update_entries(input)).await
}

#[tauri::command]
async fn save_media_type(
    state: tauri::State<'_, AppStorage>,
    expected_revision: i64,
    media_type: MediaTypeInput,
) -> Result<LibraryState, CommandError> {
    with_storage(state, move |storage| {
        storage.save_media_type(expected_revision, media_type)
    })
    .await
}

#[tauri::command]
async fn archive_media_type(
    state: tauri::State<'_, AppStorage>,
    expected_revision: i64,
    type_id: String,
    confirm_clear_entries: bool,
) -> Result<LibraryState, CommandError> {
    with_storage(state, move |storage| {
        storage.archive_media_type(expected_revision, &type_id, confirm_clear_entries)
    })
    .await
}

#[tauri::command]
async fn save_criterion(
    state: tauri::State<'_, AppStorage>,
    expected_revision: i64,
    criterion: CriterionInput,
) -> Result<LibraryState, CommandError> {
    with_storage(state, move |storage| {
        storage.save_criterion(expected_revision, criterion)
    })
    .await
}

#[tauri::command]
async fn archive_criterion(
    state: tauri::State<'_, AppStorage>,
    expected_revision: i64,
    criterion_id: String,
    confirm_remove_from_types: bool,
) -> Result<LibraryState, CommandError> {
    with_storage(state, move |storage| {
        storage.archive_criterion(expected_revision, &criterion_id, confirm_remove_from_types)
    })
    .await
}

#[tauri::command]
async fn save_tag(
    state: tauri::State<'_, AppStorage>,
    expected_revision: i64,
    tag: TagInput,
) -> Result<LibraryState, CommandError> {
    with_storage(state, move |storage| {
        storage.save_tag(expected_revision, tag)
    })
    .await
}

#[tauri::command]
async fn merge_tags(
    state: tauri::State<'_, AppStorage>,
    expected_revision: i64,
    source_id: String,
    target_id: String,
) -> Result<LibraryState, CommandError> {
    with_storage(state, move |storage| {
        storage.merge_tags(expected_revision, &source_id, &target_id)
    })
    .await
}

#[tauri::command]
async fn delete_tag(
    state: tauri::State<'_, AppStorage>,
    expected_revision: i64,
    tag_id: String,
) -> Result<LibraryState, CommandError> {
    with_storage(state, move |storage| {
        storage.delete_tag(expected_revision, &tag_id)
    })
    .await
}

#[tauri::command]
async fn save_entry_cover(
    state: tauri::State<'_, AppStorage>,
    expected_revision: i64,
    entry_id: String,
    mime_type: String,
    base64: String,
) -> Result<LibraryState, CommandError> {
    with_storage(state, move |storage| {
        storage.save_entry_cover(expected_revision, &entry_id, &mime_type, &base64)
    })
    .await
}

#[tauri::command]
async fn load_entry_cover(
    state: tauri::State<'_, AppStorage>,
    entry_id: String,
) -> Result<Option<String>, CommandError> {
    let job = with_storage(state, move |storage| storage.prepare_entry_cover(&entry_id)).await?;
    render_cover(job).await
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_window_event(|window, event| {
            // macOS keeps an app process alive after its final window closes.
            // Tastellar has a single primary window, so exit after its native
            // window has actually been destroyed (the frontend flushes saves first).
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
        })
        .setup(|app| {
            let root = if let Ok(override_dir) = std::env::var("TASTELLAR_DATA_DIR") {
                let path = PathBuf::from(override_dir);
                if !path.is_absolute() {
                    return Err("TASTELLAR_DATA_DIR must be absolute".into());
                }
                path
            } else {
                app.path().app_data_dir()?
            };
            let storage = Storage::open(root)?;
            let provider_session =
                ProviderSession::from_saved_credentials(storage.load_provider_credentials()?)?;
            app.manage(AppStorage(Arc::new(Mutex::new(storage))));
            app.manage(AppProviderSession(Arc::new(provider_session)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_external_url,
            load_home,
            load_recap_cover,
            load_recap_remote_cover,
            export_recap_image,
            reset_workspace,
            save_home,
            save_preferences,
            save_workspace,
            save_avatar,
            remove_avatar,
            load_avatar,
            export_home_backup,
            import_home_backup,
            export_library_archive,
            import_library_archive,
            load_library,
            load_ranking,
            move_ranking_entry,
            undo_last_ranking_move,
            start_duel_session,
            next_duel,
            answer_duel,
            latest_retractable_judgment_id,
            retract_duel_judgment,
            confirm_binary_placement,
            pause_duel_session,
            end_duel_session,
            reset_media_ranking,
            save_entry,
            prepare_library_import,
            commit_library_import,
            retry_import_cover,
            cancel_library_import,
            undo_library_import,
            configure_provider_credentials,
            catalog_capabilities,
            search_catalog,
            delete_entry,
            batch_update_entries,
            save_media_type,
            archive_media_type,
            save_criterion,
            archive_criterion,
            save_tag,
            merge_tags,
            delete_tag,
            save_entry_cover,
            load_entry_cover
        ])
        .run(tauri::generate_context!())
        .expect("Failed to start Tastellar");
}
