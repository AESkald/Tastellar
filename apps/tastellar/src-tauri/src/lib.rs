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
use tastellar_storage::{ExportResult, ResetWorkspaceResult, Storage, StorageError};
use tauri::Manager;

struct AppStorage(Arc<Mutex<Storage>>);

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

#[tauri::command]
async fn load_home(state: tauri::State<'_, AppStorage>) -> Result<HomeState, CommandError> {
    with_storage(state, move |storage| storage.load_home()).await
}

#[tauri::command]
async fn reset_workspace(
    state: tauri::State<'_, AppStorage>,
    expected_version: i64,
) -> Result<ResetWorkspaceResult, CommandError> {
    with_storage(state, move |storage| {
        storage.reset_workspace(expected_version)
    })
    .await
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
    path: String,
    expected_version: i64,
) -> Result<HomeState, CommandError> {
    with_storage(state, move |storage| {
        storage.import_library_archive(&path, expected_version)
    })
    .await
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
    with_storage(state, move |storage| {
        storage.save_entry(expected_revision, entry)
    })
    .await
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
    with_storage(state, move |storage| storage.load_entry_cover(&entry_id)).await
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
            app.manage(AppStorage(Arc::new(Mutex::new(Storage::open(root)?))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_home,
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
            delete_entry,
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
