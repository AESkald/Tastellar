use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rusqlite::Connection;
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tastellar_domain::{BatchEntryUpdateInput, RemoteCoverReference, TagInput};
use tastellar_storage::{
    import::{
        parse_import_uploads, ImportCoverFailure, ImportDecision, ImportEnrichment,
        ImportRatingPolicy, ImportRatingSelection, ImportSourceRow, ImportSourceSummary,
        ImportTagMapping, ImportUpload, PrepareImportInput, SourceRating,
    },
    CatalogCoverDownload, ImportCommitInput, Storage,
};

struct TestWorkspace(PathBuf);
static TEST_WORKSPACE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

impl TestWorkspace {
    fn new() -> Self {
        for _ in 0..100 {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let sequence = TEST_WORKSPACE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "tastellar-import-workflow-{}-{timestamp}-{sequence}",
                std::process::id(),
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("failed to create isolated import test workspace: {error}"),
            }
        }
        panic!("could not allocate a unique import test workspace after 100 attempts")
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn input(csv: &str) -> PrepareImportInput {
    PrepareImportInput {
        schema_version: 1,
        uploads: vec![ImportUpload {
            provider: "imdb".into(),
            file_name: "synthetic-imdb.csv".into(),
            content_base64: BASE64.encode(csv.as_bytes()),
        }],
        steam: None,
    }
}

#[test]
fn imdb_animation_defaults_to_experienced_and_can_be_added_again_after_trashing() {
    let workspace = TestWorkspace::new();
    let mut storage = Storage::open(&workspace.0).unwrap();
    let csv = concat!(
        "Const,Title,Title Type,Year,Genres\n",
        "tt11126994,Arcane,TV Series,2021,\"Animation, Action, Adventure\"\n",
    );
    let preview = storage.prepare_library_import(input(csv)).unwrap();
    let row = &preview.rows[0];
    assert_eq!(row.suggested_media_type_id.as_deref(), Some("anime"));
    assert_eq!(row.source_status, None);

    let created = storage
        .commit_library_import(ImportCommitInput {
            schema_version: 1,
            session_id: preview.session_id,
            expected_revision: preview.expected_revision,
            decisions: vec![ImportDecision {
                row_ids: vec![row.row_id.clone()],
                action: "create".into(),
                target_entry_id: None,
                title: None,
                media_type_id: None,
                disposition: None,
                import_reviews: false,
                overwrite_existing_disposition: false,
                overwrite_existing_review: false,
                tag_ids: Vec::new(),
                new_tag_names: Vec::new(),
                manual_overall_rating: None,
                overwrite_existing_metadata: false,
                rating_selections: Vec::new(),
                tag_mappings: Vec::new(),
                enrichments: Vec::new(),
            }],
            rating_policy: ImportRatingPolicy {
                mode: "priority".into(),
                priority: Vec::new(),
                manual_selections: Vec::new(),
            },
        })
        .unwrap();
    assert_eq!(created.library.entries[0].disposition, "experienced");
    let old_entry_id = created.library.entries[0].id.clone();

    let deleted = storage
        .delete_entry(created.library.revision, &old_entry_id)
        .unwrap();
    let next = storage.prepare_library_import(input(csv)).unwrap();
    assert_eq!(next.rows[0].exact_entry_id, None);
    let row_id = next.rows[0].row_id.clone();
    let readded = storage
        .commit_library_import(ImportCommitInput {
            schema_version: 1,
            session_id: next.session_id,
            expected_revision: deleted.revision,
            decisions: vec![ImportDecision {
                row_ids: vec![row_id],
                action: "create".into(),
                target_entry_id: None,
                title: None,
                media_type_id: None,
                disposition: None,
                import_reviews: false,
                overwrite_existing_disposition: false,
                overwrite_existing_review: false,
                tag_ids: Vec::new(),
                new_tag_names: Vec::new(),
                manual_overall_rating: None,
                overwrite_existing_metadata: false,
                rating_selections: Vec::new(),
                tag_mappings: Vec::new(),
                enrichments: Vec::new(),
            }],
            rating_policy: ImportRatingPolicy {
                mode: "priority".into(),
                priority: Vec::new(),
                manual_selections: Vec::new(),
            },
        })
        .unwrap();
    assert_eq!(readded.library.entries.len(), 1);
    assert_ne!(readded.library.entries[0].id, old_entry_id);
    assert_eq!(
        readded.library.entries[0].media_type_id.as_deref(),
        Some("anime")
    );
}

#[test]
fn steam_source_activity_survives_portable_restore_and_remains_idempotent() {
    let source_workspace = TestWorkspace::new();
    let mut source = Storage::open(&source_workspace.0).unwrap();
    let steam_row = || {
        ImportSourceRow::from_steam_owned_game(tastellar_storage::SteamOwnedGame {
            app_id: "62002".into(),
            name: "Synthetic Portable Steam Work".into(),
            playtime_forever: Some(120),
            playtime_2weeks: Some(0),
            free_to_play: None,
        })
    };
    let initial = stage_rows(&mut source, vec![steam_row()]);
    let created = commit_one(&mut source, initial, "create", None);
    let entry_id = created.library.entries[0].id.clone();
    let archive_path = source_workspace.0.join("steam-roundtrip.tastellar.json");
    source.export_library_archive(&archive_path).unwrap();

    let restored_workspace = TestWorkspace::new();
    let mut restored = Storage::open(&restored_workspace.0).unwrap();
    let revision = restored.load_home().unwrap().version;
    restored
        .import_library_archive(&archive_path, revision)
        .unwrap();
    let library = restored.load_library().unwrap();
    assert_eq!(library.entries.len(), 1);
    assert_eq!(library.entries[0].id, entry_id);
    let repeat = stage_rows(&mut restored, vec![steam_row()]);
    let reimported = commit_one(&mut restored, repeat, "link", Some(entry_id));
    assert_eq!(reimported.library.revision, library.revision);
}

#[test]
fn imdb_fixture_with_local_cover_round_trips_and_reimports_without_duplicate_source_event() {
    let source_workspace = TestWorkspace::new();
    let mut source = Storage::open(&source_workspace.0).unwrap();
    let fixture = include_str!("../../../tests/fixtures/imports/imdb-source-only-synthetic.csv");
    let (_, parsed, _) = parse_import_uploads(&[ImportUpload {
        provider: "imdb".into(),
        file_name: "fixture.csv".into(),
        content_base64: BASE64.encode(fixture.as_bytes()),
    }])
    .unwrap();
    let row = parsed
        .into_iter()
        .find(|row| row.external_id.as_deref() == Some("tt99000001"))
        .unwrap();
    let preview = stage_rows(&mut source, vec![row.clone()]);
    let created = commit_one(&mut source, preview, "create", None);

    let image = image::DynamicImage::new_rgba8(1, 1);
    let mut image_cursor = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut image_cursor, image::ImageFormat::Png)
        .unwrap();
    let image_base64 = BASE64.encode(image_cursor.into_inner());
    let covered = source
        .save_entry_cover(
            created.library.revision,
            &created.library.entries[0].id,
            "image/png",
            &image_base64,
        )
        .unwrap();
    let cover_id = covered.entries[0].cover_asset_id.clone().unwrap();
    let archive_path = source_workspace.0.join("imdb-fixture.tastellar.json");
    source.export_library_archive(&archive_path).unwrap();

    let restored_workspace = TestWorkspace::new();
    let mut restored = Storage::open(&restored_workspace.0).unwrap();
    let revision = restored.load_home().unwrap().version;
    restored
        .import_library_archive(&archive_path, revision)
        .unwrap();
    let library = restored.load_library().unwrap();
    assert_eq!(library.entries.len(), 1);
    assert_eq!(
        library.entries[0].cover_asset_id.as_deref(),
        Some(cover_id.as_str())
    );
    assert!(restored
        .load_entry_cover(&library.entries[0].id)
        .unwrap()
        .is_some());

    let repeat = stage_rows(&mut restored, vec![row]);
    let reimported = commit_one(
        &mut restored,
        repeat,
        "link",
        Some(library.entries[0].id.clone()),
    );
    assert_eq!(reimported.library.revision, library.revision);
}

#[test]
fn selected_import_cover_is_saved_locally_in_the_same_import_revision() {
    let workspace = TestWorkspace::new();
    let mut storage = Storage::open(&workspace.0).unwrap();
    let preview = stage_rows(
        &mut storage,
        vec![staged_row(
            "imdb",
            "tt99000803",
            "Atomic cover import",
            7.0,
            "1-10",
        )],
    );
    let expected_revision = preview.expected_revision;
    let source_row_id = preview.rows[0].row_id.clone();
    let mut decision = create_decision(&preview.rows, &[0]);
    decision.enrichments.push(ImportEnrichment {
        source_row_id: source_row_id.clone(),
        title: "Atomic cover import".into(),
        release_date: None,
        external_identities: Vec::new(),
        remote_cover: Some(RemoteCoverReference {
            provider: "tmdb".into(),
            url: "https://image.tmdb.org/t/p/w500/fixture.jpg".into(),
            source_url: None,
            attribution: None,
        }),
        overwrite_existing_metadata: true,
    });
    let mut cursor = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(1, 1)
        .write_to(&mut cursor, image::ImageFormat::Png)
        .unwrap();
    let result = storage
        .commit_library_import_with_catalog_covers(
            ImportCommitInput {
                schema_version: 1,
                session_id: preview.session_id,
                expected_revision: preview.expected_revision,
                decisions: vec![decision],
                rating_policy: ImportRatingPolicy {
                    mode: "priority".into(),
                    priority: Vec::new(),
                    manual_selections: Vec::new(),
                },
            },
            [(
                source_row_id,
                CatalogCoverDownload {
                    mime_type: "image/png".into(),
                    bytes: cursor.into_inner(),
                },
            )]
            .into_iter()
            .collect(),
        )
        .unwrap();

    let entry = &result.library.entries[0];
    assert!(entry.cover_asset_id.is_some());
    assert!(entry.remote_cover.is_none());
    assert!(storage.load_entry_cover(&entry.id).unwrap().is_some());
    assert_eq!(result.library.revision, expected_revision + 1);
}

#[test]
fn failed_selected_cover_does_not_abort_import_and_can_be_retried_without_entry_changes() {
    let workspace = TestWorkspace::new();
    let mut storage = Storage::open(&workspace.0).unwrap();
    let preview = stage_rows(
        &mut storage,
        vec![staged_row(
            "imdb",
            "tt99000804",
            "Cover Retry Work",
            7.0,
            "1-10",
        )],
    );
    let row_id = preview.rows[0].row_id.clone();
    let mut decision = create_decision(&preview.rows, &[0]);
    decision.enrichments.push(ImportEnrichment {
        source_row_id: row_id.clone(),
        title: "Cover Retry Work".into(),
        release_date: None,
        external_identities: Vec::new(),
        remote_cover: Some(RemoteCoverReference {
            provider: "tmdb".into(),
            url: "https://image.tmdb.org/t/p/w500/fixture.jpg".into(),
            source_url: None,
            attribution: None,
        }),
        overwrite_existing_metadata: true,
    });
    let result = storage
        .commit_library_import_with_catalog_covers_and_failures(
            ImportCommitInput {
                schema_version: 1,
                session_id: preview.session_id,
                expected_revision: preview.expected_revision,
                decisions: vec![decision],
                rating_policy: ImportRatingPolicy {
                    mode: "priority".into(),
                    priority: vec!["imdb".into()],
                    manual_selections: Vec::new(),
                },
            },
            std::collections::HashMap::new(),
            vec![ImportCoverFailure {
                source_row_id: row_id,
                title: "Cover Retry Work".into(),
                message: "The cover provider did not return an image".into(),
                provider: "tmdb".into(),
                url: "https://image.tmdb.org/t/p/w500/fixture.jpg".into(),
                entry_id: None,
            }],
        )
        .unwrap();

    assert_eq!(result.created, 1);
    assert_eq!(result.cover_failures.len(), 1);
    let entry = &result.library.entries[0];
    assert_eq!(
        result.cover_failures[0].entry_id.as_deref(),
        Some(entry.id.as_str())
    );
    assert!(entry.cover_asset_id.is_none());
    assert!(entry.remote_cover.is_none());
    assert_eq!(entry.overall_rating, Some(7));
    assert_eq!(entry.disposition, "experienced");

    let mut cursor = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(1, 1)
        .write_to(&mut cursor, image::ImageFormat::Png)
        .unwrap();
    let saved = storage
        .save_entry_cover_with_bytes(
            result.library.revision,
            &entry.id,
            &result.batch_id,
            "image/png",
            &cursor.into_inner(),
        )
        .unwrap();
    let retried_entry = &saved.entries[0];
    assert!(retried_entry.cover_asset_id.is_some());
    assert!(retried_entry.remote_cover.is_none());
    assert_eq!(retried_entry.title, entry.title);
    assert_eq!(retried_entry.overall_rating, entry.overall_rating);
    assert_eq!(retried_entry.disposition, entry.disposition);
    assert!(storage.load_entry_cover(&entry.id).unwrap().is_some());
    let undone = storage
        .undo_library_import(&result.batch_id, saved.revision)
        .unwrap();
    assert!(undone.library.entries.is_empty());
}

#[test]
fn imported_local_cover_replaces_a_legacy_remote_reference_on_a_reviewed_link() {
    let workspace = TestWorkspace::new();
    let mut storage = Storage::open(&workspace.0).unwrap();
    let first = stage_rows(
        &mut storage,
        vec![staged_row(
            "imdb",
            "tt99000806",
            "Legacy Remote Cover Work",
            7.0,
            "1-10",
        )],
    );
    let first_row_id = first.rows[0].row_id.clone();
    let mut first_decision = create_decision(&first.rows, &[0]);
    first_decision.enrichments.push(ImportEnrichment {
        source_row_id: first_row_id,
        title: "Legacy Remote Cover Work".into(),
        release_date: None,
        external_identities: Vec::new(),
        remote_cover: Some(RemoteCoverReference {
            provider: "tmdb".into(),
            url: "https://image.tmdb.org/t/p/w500/old.jpg".into(),
            source_url: None,
            attribution: None,
        }),
        overwrite_existing_metadata: true,
    });
    let first_result = storage
        .commit_library_import(ImportCommitInput {
            schema_version: 1,
            session_id: first.session_id,
            expected_revision: first.expected_revision,
            decisions: vec![first_decision],
            rating_policy: ImportRatingPolicy {
                mode: "priority".into(),
                priority: vec!["imdb".into()],
                manual_selections: Vec::new(),
            },
        })
        .unwrap();
    let entry = &first_result.library.entries[0];
    assert!(entry.cover_asset_id.is_none());
    assert!(entry.remote_cover.is_some());

    let second = stage_rows(
        &mut storage,
        vec![staged_row(
            "letterboxd",
            "https://letterboxd.com/film/legacy-remote-cover-work/",
            "Legacy Remote Cover Work",
            3.5,
            "0.5-5",
        )],
    );
    let second_row_id = second.rows[0].row_id.clone();
    let mut second_decision = create_decision(&second.rows, &[0]);
    second_decision.action = "link".into();
    second_decision.target_entry_id = Some(entry.id.clone());
    second_decision.enrichments.push(ImportEnrichment {
        source_row_id: second_row_id.clone(),
        title: "Legacy Remote Cover Work".into(),
        release_date: None,
        external_identities: Vec::new(),
        remote_cover: Some(RemoteCoverReference {
            provider: "tmdb".into(),
            url: "https://image.tmdb.org/t/p/w500/new.jpg".into(),
            source_url: None,
            attribution: None,
        }),
        overwrite_existing_metadata: false,
    });
    let mut cursor = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(1, 1)
        .write_to(&mut cursor, image::ImageFormat::Png)
        .unwrap();
    let result = storage
        .commit_library_import_with_catalog_covers(
            ImportCommitInput {
                schema_version: 1,
                session_id: second.session_id,
                expected_revision: second.expected_revision,
                decisions: vec![second_decision],
                rating_policy: ImportRatingPolicy {
                    mode: "priority".into(),
                    priority: vec!["letterboxd".into()],
                    manual_selections: Vec::new(),
                },
            },
            [(
                second_row_id,
                CatalogCoverDownload {
                    mime_type: "image/png".into(),
                    bytes: cursor.into_inner(),
                },
            )]
            .into_iter()
            .collect(),
        )
        .unwrap();
    assert_eq!(result.library.entries.len(), 1);
    assert_eq!(result.library.entries[0].id, entry.id);
    assert!(result.library.entries[0].cover_asset_id.is_some());
    assert!(result.library.entries[0].remote_cover.is_none());
    assert_eq!(result.library.entries[0].overall_rating, Some(7));
}

#[test]
fn mal_sized_batch_keeps_all_covers_when_duplicate_tmdb_identity_is_filtered() {
    let workspace = TestWorkspace::new();
    let mut storage = Storage::open(&workspace.0).unwrap();
    let rows = (0..161)
        .map(|index| {
            let mut row = staged_row(
                "myAnimeList",
                &format!("mal-{index:03}"),
                &format!("MAL imported work {index:03}"),
                7.0,
                "1-10",
            );
            row.provider_media_type = Some("TV".into());
            row.source_identities = vec![tastellar_domain::ExternalIdentity {
                provider: "myanimelist".into(),
                entity_kind: "anime".into(),
                external_id: format!("mal-{index:03}"),
                source_url: None,
            }];
            row.suggested_media_type_id = Some("anime".into());
            row
        })
        .collect::<Vec<_>>();
    let preview = stage_rows(&mut storage, rows);
    let mut cursor = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(1, 1)
        .write_to(&mut cursor, image::ImageFormat::Png)
        .unwrap();
    let image_bytes = cursor.into_inner();
    let mut covers = std::collections::HashMap::new();
    let decisions = preview
        .rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let mut decision = create_decision(&preview.rows, &[index]);
            decision.media_type_id = Some("anime".into());
            decision.rating_selections.clear();
            decision.enrichments.push(ImportEnrichment {
                source_row_id: row.row_id.clone(),
                title: row.title.clone(),
                release_date: None,
                // The UI retains the first TMDB identity and filters that
                // duplicate from later rows, while leaving their covers selected.
                external_identities: (index == 0)
                    .then(|| tastellar_domain::ExternalIdentity {
                        provider: "tmdb".into(),
                        entity_kind: "tv".into(),
                        external_id: "same-mal-show-fixture".into(),
                        source_url: None,
                    })
                    .into_iter()
                    .collect(),
                remote_cover: Some(RemoteCoverReference {
                    provider: "tmdb".into(),
                    url: format!("https://image.tmdb.org/t/p/w500/fixture-{index:03}.jpg"),
                    source_url: None,
                    attribution: None,
                }),
                overwrite_existing_metadata: true,
            });
            covers.insert(
                row.row_id.clone(),
                CatalogCoverDownload {
                    mime_type: "image/png".into(),
                    bytes: image_bytes.clone(),
                },
            );
            decision
        })
        .collect();
    let result = storage
        .commit_library_import_with_catalog_covers(
            ImportCommitInput {
                schema_version: 1,
                session_id: preview.session_id,
                expected_revision: preview.expected_revision,
                decisions,
                rating_policy: ImportRatingPolicy {
                    mode: "priority".into(),
                    priority: Vec::new(),
                    manual_selections: Vec::new(),
                },
            },
            covers,
        )
        .unwrap();

    assert_eq!(result.created, 161);
    assert!(result
        .library
        .entries
        .iter()
        .all(|entry| entry.cover_asset_id.is_some()));
    assert_eq!(
        result
            .library
            .entries
            .iter()
            .filter(|entry| entry.external_identities.iter().any(|identity| {
                identity.provider == "tmdb" && identity.external_id == "same-mal-show-fixture"
            }))
            .count(),
        1
    );
}

#[test]
fn catalog_identity_collision_across_imdb_and_letterboxd_is_a_reviewable_conflict() {
    let workspace = TestWorkspace::new();
    let mut storage = Storage::open(&workspace.0).unwrap();
    let mut source = staged_row("imdb", "tt99000805", "Shared Catalog Work", 7.0, "1-10");
    source.review_text = Some("Keep this existing review".into());
    let first = stage_rows(&mut storage, vec![source]);
    let mut first_decision = create_decision(&first.rows, &[0]);
    first_decision.import_reviews = true;
    let catalog_identity = tastellar_domain::ExternalIdentity {
        provider: "tmdb".into(),
        entity_kind: "movie".into(),
        external_id: "catalog-fixture-805".into(),
        source_url: None,
    };
    first_decision.enrichments.push(ImportEnrichment {
        source_row_id: first.rows[0].row_id.clone(),
        title: "Shared Catalog Work".into(),
        release_date: None,
        external_identities: vec![catalog_identity.clone()],
        remote_cover: None,
        overwrite_existing_metadata: true,
    });
    let first_result = storage
        .commit_library_import(ImportCommitInput {
            schema_version: 1,
            session_id: first.session_id,
            expected_revision: first.expected_revision,
            decisions: vec![first_decision],
            rating_policy: ImportRatingPolicy {
                mode: "priority".into(),
                priority: vec!["imdb".into()],
                manual_selections: Vec::new(),
            },
        })
        .unwrap();
    assert_eq!(first_result.created, 1);
    let existing = &first_result.library.entries[0];
    assert!(existing.external_identities.iter().any(|identity| {
        identity.provider == "tmdb" && identity.external_id == "catalog-fixture-805"
    }));

    let second = stage_rows(
        &mut storage,
        vec![staged_row(
            "letterboxd",
            "https://letterboxd.com/film/shared-catalog-work/",
            "Shared Catalog Work",
            4.0,
            "0.5-5",
        )],
    );
    let mut second_decision = create_decision(&second.rows, &[0]);
    second_decision.enrichments.push(ImportEnrichment {
        source_row_id: second.rows[0].row_id.clone(),
        title: "Shared Catalog Work".into(),
        release_date: None,
        external_identities: vec![catalog_identity],
        remote_cover: None,
        overwrite_existing_metadata: true,
    });
    let error = storage
        .commit_library_import(ImportCommitInput {
            schema_version: 1,
            session_id: second.session_id,
            expected_revision: second.expected_revision,
            decisions: vec![second_decision],
            rating_policy: ImportRatingPolicy {
                mode: "priority".into(),
                priority: vec!["letterboxd".into()],
                manual_selections: Vec::new(),
            },
        })
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("Review the matching item or remove the duplicate catalog match"));

    let unchanged = storage.load_library().unwrap();
    assert_eq!(unchanged.entries.len(), 1);
    assert_eq!(unchanged.entries[0].id, existing.id);
    assert_eq!(unchanged.entries[0].overall_rating, Some(7));
    assert_eq!(
        unchanged.entries[0].review_text,
        "Keep this existing review"
    );
}

#[test]
fn duplicate_catalog_identity_in_goodreads_batch_requires_a_reviewed_merge() {
    let workspace = TestWorkspace::new();
    let mut storage = Storage::open(&workspace.0).unwrap();
    let mut first = staged_row("goodreads", "book-805-a", "Shared Book Work", 4.0, "0-5");
    first.source_identities = vec![
        tastellar_domain::ExternalIdentity {
            provider: "goodreads".into(),
            entity_kind: "book".into(),
            external_id: "book-805-a".into(),
            source_url: None,
        },
        tastellar_domain::ExternalIdentity {
            provider: "isbn".into(),
            entity_kind: "edition".into(),
            external_id: "9780306406157".into(),
            source_url: None,
        },
    ];
    let mut second = staged_row("goodreads", "book-805-b", "Shared Book Work", 4.0, "0-5");
    second.source_identities = vec![
        tastellar_domain::ExternalIdentity {
            provider: "goodreads".into(),
            entity_kind: "book".into(),
            external_id: "book-805-b".into(),
            source_url: None,
        },
        tastellar_domain::ExternalIdentity {
            provider: "isbn".into(),
            entity_kind: "edition".into(),
            external_id: "9780306406164".into(),
            source_url: None,
        },
    ];
    let preview = stage_rows(&mut storage, vec![first, second]);
    let shared_identity = tastellar_domain::ExternalIdentity {
        provider: "openlibrary".into(),
        entity_kind: "work".into(),
        external_id: "OL-fixture-W805W".into(),
        source_url: None,
    };
    let decisions = preview
        .rows
        .iter()
        .map(|row| {
            let mut decision = create_decision(
                &preview.rows,
                &[if row.row_id == preview.rows[0].row_id {
                    0
                } else {
                    1
                }],
            );
            decision.enrichments.push(ImportEnrichment {
                source_row_id: row.row_id.clone(),
                title: row.title.clone(),
                release_date: None,
                external_identities: vec![shared_identity.clone()],
                remote_cover: None,
                overwrite_existing_metadata: true,
            });
            decision
        })
        .collect();
    let error = storage
        .commit_library_import(ImportCommitInput {
            schema_version: 1,
            session_id: preview.session_id,
            expected_revision: preview.expected_revision,
            decisions,
            rating_policy: ImportRatingPolicy {
                mode: "priority".into(),
                priority: vec!["goodreads".into()],
                manual_selections: Vec::new(),
            },
        })
        .unwrap_err();
    assert!(error.to_string().contains("duplicate catalog match"));
    assert!(storage.load_library().unwrap().entries.is_empty());
}

#[test]
fn batch_edit_clears_ratings_before_moving_to_planned_and_trashes_atomically() {
    let workspace = TestWorkspace::new();
    let mut storage = Storage::open(&workspace.0).unwrap();
    let first_preview = stage_rows(
        &mut storage,
        vec![staged_row("imdb", "tt99000801", "Batch one", 8.0, "1-10")],
    );
    let first = commit_one(&mut storage, first_preview, "create", None);
    let second_preview = stage_rows(
        &mut storage,
        vec![staged_row("imdb", "tt99000802", "Batch two", 7.0, "1-10")],
    );
    let second = commit_one(&mut storage, second_preview, "create", None);
    let entry_ids = vec![
        first.library.entries[0].id.clone(),
        second
            .library
            .entries
            .iter()
            .find(|entry| entry.title == "Batch two")
            .unwrap()
            .id
            .clone(),
    ];

    let edited = storage
        .batch_update_entries(BatchEntryUpdateInput {
            expected_revision: second.library.revision,
            entry_ids: entry_ids.clone(),
            media_type_id: Some("anime".into()),
            disposition: Some("planned".into()),
            remove_covers: true,
            trash: false,
        })
        .unwrap();
    assert_eq!(edited.entries.len(), 2);
    assert!(edited.entries.iter().all(|entry| {
        entry.disposition == "planned"
            && entry.overall_rating.is_none()
            && entry.media_type_id.as_deref() == Some("anime")
            && entry.cover_asset_id.is_none()
            && entry.remote_cover.is_none()
    }));
    let ranking = storage.load_ranking().unwrap();
    assert!(ranking
        .tiers
        .iter()
        .all(|tier| { tier.placed_ids.is_empty() && tier.unplaced_ids.is_empty() }));

    let stale_delete = storage.batch_update_entries(BatchEntryUpdateInput {
        expected_revision: edited.revision - 1,
        entry_ids: entry_ids.clone(),
        media_type_id: None,
        disposition: None,
        remove_covers: false,
        trash: true,
    });
    assert!(matches!(
        stale_delete,
        Err(tastellar_storage::StorageError::Conflict)
    ));
    assert_eq!(storage.load_library().unwrap().entries.len(), 2);

    let trashed = storage
        .batch_update_entries(BatchEntryUpdateInput {
            expected_revision: edited.revision,
            entry_ids,
            media_type_id: None,
            disposition: None,
            remove_covers: false,
            trash: true,
        })
        .unwrap();
    assert!(trashed.entries.is_empty());
}

#[test]
fn explicit_bulk_import_status_applies_to_linked_entries_and_clears_rating() {
    let workspace = TestWorkspace::new();
    let mut storage = Storage::open(&workspace.0).unwrap();
    let source = staged_row("imdb", "tt99000811", "Bulk disposition", 8.0, "1-10");
    let initial = stage_rows(&mut storage, vec![source.clone()]);
    let created = commit_one(&mut storage, initial, "create", None);
    let entry_id = created.library.entries[0].id.clone();

    let preview = stage_rows(&mut storage, vec![source]);
    let row = &preview.rows[0];
    let linked = storage
        .commit_library_import(ImportCommitInput {
            schema_version: 1,
            session_id: preview.session_id,
            expected_revision: preview.expected_revision,
            decisions: vec![ImportDecision {
                row_ids: vec![row.row_id.clone()],
                action: "link".into(),
                target_entry_id: Some(entry_id),
                title: None,
                media_type_id: None,
                disposition: Some("planned".into()),
                import_reviews: false,
                overwrite_existing_disposition: true,
                overwrite_existing_review: false,
                tag_ids: Vec::new(),
                new_tag_names: Vec::new(),
                manual_overall_rating: None,
                overwrite_existing_metadata: false,
                rating_selections: vec![ImportRatingSelection {
                    source_row_id: row.row_id.clone(),
                    accept_native: true,
                    overwrite_existing_rating: false,
                }],
                tag_mappings: Vec::new(),
                enrichments: Vec::new(),
            }],
            rating_policy: ImportRatingPolicy {
                mode: "priority".into(),
                priority: vec!["imdb".into()],
                manual_selections: Vec::new(),
            },
        })
        .unwrap();
    assert_eq!(linked.library.entries[0].disposition, "planned");
    assert_eq!(linked.library.entries[0].overall_rating, None);
}

#[test]
fn reviewed_import_preserves_source_identity_and_rated_year_and_reimport_is_idempotent() {
    let workspace = TestWorkspace::new();
    let mut storage = Storage::open(&workspace.0).unwrap();
    let csv = concat!(
        "Const,Title,OriginalTitle,Title Type,Year,IMDb Rating,Your Rating,Date Rated\n",
        "tt99000001,Glass Harbour,The Glass Harbour,Movie,2019,8.2,7,2026-10-02\n",
    );

    let preview = storage.prepare_library_import(input(csv)).unwrap();
    assert_eq!(preview.rows.len(), 1);
    let source = &preview.rows[0];
    assert_eq!(source.title, "Glass Harbour");
    assert_eq!(source.original_title.as_deref(), Some("The Glass Harbour"));
    assert_eq!(source.year, Some(2019));
    assert_eq!(
        source.source_rating.as_ref().map(|rating| rating.value),
        Some(7.0)
    );
    assert_eq!(
        source
            .source_rating
            .as_ref()
            .map(|rating| rating.scale.as_str()),
        Some("1-10")
    );
    assert_eq!(source.source_identities.len(), 1);
    assert_eq!(source.source_identities[0].provider, "imdb");
    assert_eq!(source.source_identities[0].entity_kind, "title");
    assert_eq!(source.source_identities[0].external_id, "tt99000001");

    let source_row_id = source.row_id.clone();
    let first = storage
        .commit_library_import(ImportCommitInput {
            schema_version: 1,
            session_id: preview.session_id,
            expected_revision: preview.expected_revision,
            decisions: vec![ImportDecision {
                row_ids: vec![source_row_id.clone()],
                action: "create".into(),
                target_entry_id: None,
                title: None,
                media_type_id: Some("films".into()),
                disposition: Some("experienced".into()),
                import_reviews: false,
                overwrite_existing_disposition: false,
                overwrite_existing_review: false,
                tag_ids: Vec::new(),
                new_tag_names: Vec::new(),
                manual_overall_rating: None,
                overwrite_existing_metadata: false,
                rating_selections: vec![ImportRatingSelection {
                    source_row_id: source_row_id.clone(),
                    accept_native: true,
                    overwrite_existing_rating: false,
                }],
                tag_mappings: Vec::new(),
                enrichments: Vec::new(),
            }],
            rating_policy: ImportRatingPolicy {
                mode: "priority".into(),
                priority: vec!["imdb".into()],
                manual_selections: Vec::new(),
            },
        })
        .unwrap();
    assert_eq!(first.created, 1);
    assert_eq!(first.library.entries.len(), 1);
    let imported = &first.library.entries[0];
    assert_eq!(imported.title, "Glass Harbour");
    assert_eq!(imported.overall_rating, Some(7));
    assert_eq!(
        imported.release_date.as_ref().map(|date| date.year),
        Some(2019)
    );
    assert!(imported
        .external_identities
        .iter()
        .any(|identity| identity.provider == "imdb"
            && identity.entity_kind == "title"
            && identity.external_id == "tt99000001"));

    let second_preview = storage.prepare_library_import(input(csv)).unwrap();
    assert_eq!(second_preview.rows.len(), 1);
    let second_row = &second_preview.rows[0];
    assert_eq!(
        second_row.exact_entry_id.as_deref(),
        Some(imported.id.as_str())
    );
    let second = storage
        .commit_library_import(ImportCommitInput {
            schema_version: 1,
            session_id: second_preview.session_id,
            expected_revision: second_preview.expected_revision,
            decisions: vec![ImportDecision {
                row_ids: vec![second_row.row_id.clone()],
                action: "link".into(),
                target_entry_id: Some(imported.id.clone()),
                title: None,
                media_type_id: None,
                disposition: None,
                import_reviews: false,
                overwrite_existing_disposition: false,
                overwrite_existing_review: false,
                tag_ids: Vec::new(),
                new_tag_names: Vec::new(),
                manual_overall_rating: None,
                overwrite_existing_metadata: false,
                rating_selections: vec![ImportRatingSelection {
                    source_row_id: second_row.row_id.clone(),
                    accept_native: true,
                    overwrite_existing_rating: false,
                }],
                tag_mappings: Vec::new(),
                enrichments: Vec::new(),
            }],
            rating_policy: ImportRatingPolicy {
                mode: "priority".into(),
                priority: vec!["imdb".into()],
                manual_selections: Vec::new(),
            },
        })
        .unwrap();
    assert_eq!(
        second.library.entries.len(),
        1,
        "reimport must not create a duplicate"
    );
    assert_eq!(second.library.entries[0].overall_rating, Some(7));
    assert_eq!(
        second.library.revision, first.library.revision,
        "a no-op reimport must not bump the library revision"
    );

    // Portable backups retain both source identities and source activity. Reimporting
    // after restore must consult the preserved event payload when the local index is new.
    let archive = workspace.0.join("roundtrip.tastellar");
    storage.export_library_archive(&archive).unwrap();
    let restored_root = workspace.0.join("restored");
    let mut restored = Storage::open(&restored_root).unwrap();
    let restored_version = restored.load_home().unwrap().version;
    restored
        .import_library_archive(&archive, restored_version)
        .unwrap();
    let restored_library = restored.load_library().unwrap();
    assert_eq!(restored_library.entries.len(), 1);
    assert!(restored_library.entries[0]
        .external_identities
        .iter()
        .any(|identity| identity.provider == "imdb" && identity.external_id == "tt99000001"));
    let restored_preview = restored.prepare_library_import(input(csv)).unwrap();
    let restored_row = &restored_preview.rows[0];
    let restored_commit = restored
        .commit_library_import(ImportCommitInput {
            schema_version: 1,
            session_id: restored_preview.session_id,
            expected_revision: restored_preview.expected_revision,
            decisions: vec![ImportDecision {
                row_ids: vec![restored_row.row_id.clone()],
                action: "link".into(),
                target_entry_id: Some(restored_library.entries[0].id.clone()),
                title: None,
                media_type_id: None,
                disposition: None,
                import_reviews: false,
                overwrite_existing_disposition: false,
                overwrite_existing_review: false,
                tag_ids: Vec::new(),
                new_tag_names: Vec::new(),
                manual_overall_rating: None,
                overwrite_existing_metadata: false,
                rating_selections: vec![ImportRatingSelection {
                    source_row_id: restored_row.row_id.clone(),
                    accept_native: true,
                    overwrite_existing_rating: false,
                }],
                tag_mappings: Vec::new(),
                enrichments: Vec::new(),
            }],
            rating_policy: ImportRatingPolicy {
                mode: "priority".into(),
                priority: vec!["imdb".into()],
                manual_selections: Vec::new(),
            },
        })
        .unwrap();
    assert_eq!(
        restored_commit.library.revision, restored_library.revision,
        "backup reimport should not add a duplicate event or mutate the entry"
    );

    let before_undo_activity_count: i64 = Connection::open(workspace.0.join("tastellar.sqlite3"))
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM entry_event WHERE kind='external_source_activity'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        before_undo_activity_count, 1,
        "reimport must not duplicate source activity"
    );
    let undo = storage
        .undo_library_import(&first.batch_id, second.library.revision)
        .unwrap();
    assert!(
        undo.library.entries.is_empty(),
        "a newly created import can be safely undone after a no-op reimport"
    );

    drop(storage);
    let connection = Connection::open(workspace.0.join("tastellar.sqlite3")).unwrap();
    let activity_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM entry_event WHERE kind='external_source_activity'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        activity_count, 0,
        "undo removes the activity belonging to the newly created entry"
    );
}

#[test]
fn mal_xml_keeps_anime_and_manga_types_scores_and_large_progress_separate() {
    let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<myanimelist>
 <anime><series_animedb_id>12345</series_animedb_id><series_title>Test Space Saga</series_title><series_type>TV</series_type><series_episodes>24</series_episodes><my_id>0</my_id><my_watched_episodes>24</my_watched_episodes><my_score>8</my_score><my_status>2</my_status><my_start_date>2025-01-01</my_start_date><my_finish_date>2025-02-01</my_finish_date></anime>
 <manga><series_mangadb_id>67890</series_mangadb_id><series_title>Test Paper Kingdom</series_title><series_type>Manga</series_type><series_chapters>200</series_chapters><my_read_chapters>154</my_read_chapters><my_score>0</my_score><my_status>1</my_status></manga>
</myanimelist>"#;
    let (_, rows, _) = parse_import_uploads(&[ImportUpload {
        provider: "myAnimeList".into(),
        file_name: "list.xml".into(),
        content_base64: BASE64.encode(xml.as_bytes()),
    }])
    .unwrap();
    assert_eq!(rows.len(), 2);
    let anime = &rows[0];
    assert_eq!(anime.provider_media_type.as_deref(), Some("anime"));
    assert_eq!(anime.suggested_media_type_id.as_deref(), Some("anime"));
    assert_eq!(
        anime.source_rating.as_ref().map(|rating| rating.value),
        Some(8.0)
    );
    assert_eq!(
        anime.progress.as_ref().map(|progress| progress.current),
        Some(24.0)
    );
    assert_eq!(
        anime
            .progress
            .as_ref()
            .map(|progress| progress.unit.as_str()),
        Some("episodes")
    );
    let manga = &rows[1];
    assert_eq!(manga.provider_media_type.as_deref(), Some("manga"));
    assert_eq!(manga.suggested_media_type_id.as_deref(), Some("comic"));
    assert!(
        manga.source_rating.is_none(),
        "MAL zero is an unrated sentinel"
    );
    assert_eq!(
        manga.progress.as_ref().map(|progress| progress.current),
        Some(154.0)
    );
    assert_eq!(
        manga
            .progress
            .as_ref()
            .map(|progress| progress.unit.as_str()),
        Some("chapters")
    );
}

#[test]
fn mal_xml_rejects_dtd_and_external_entities() {
    let xml = r#"<?xml version="1.0"?><!DOCTYPE myanimelist [<!ENTITY external SYSTEM "file:///etc/passwd">]><myanimelist><anime><series_animedb_id>1</series_animedb_id><series_title>&external;</series_title></anime></myanimelist>"#;
    let error = parse_import_uploads(&[ImportUpload {
        provider: "myAnimeList".into(),
        file_name: "mal.xml".into(),
        content_base64: BASE64.encode(xml.as_bytes()),
    }])
    .unwrap_err();
    assert!(error.to_string().contains("DTD") || error.to_string().contains("MAL XML"));
}

#[test]
fn mal_sized_batch_can_create_one_normalized_tag_and_reuse_it_across_rows() {
    let workspace = TestWorkspace::new();
    let mut storage = Storage::open(&workspace.0).unwrap();
    let preview = stage_rows(&mut storage, mal_import_tag_rows(161));
    let decisions = preview
        .rows
        .iter()
        .enumerate()
        .map(|(index, _row)| {
            let mut decision = create_decision(&preview.rows, &[index]);
            decision.media_type_id = Some("anime".into());
            decision.new_tag_names = vec![if index == 0 {
                "anime".into()
            } else {
                "  ANIME  ".into()
            }];
            decision
        })
        .collect();
    let result = storage
        .commit_library_import(ImportCommitInput {
            schema_version: 1,
            session_id: preview.session_id,
            expected_revision: preview.expected_revision,
            decisions,
            rating_policy: ImportRatingPolicy {
                mode: "preserveOnly".into(),
                priority: Vec::new(),
                manual_selections: Vec::new(),
            },
        })
        .unwrap();

    assert_eq!(result.created, 161);
    assert_eq!(result.library.tags.len(), 1);
    let tag = &result.library.tags[0];
    assert_eq!(tag.name, "anime");
    assert!(result
        .library
        .entries
        .iter()
        .all(|entry| entry.tag_ids == [tag.id.as_str()]));
}

#[test]
fn mal_sized_batch_reuses_selected_existing_tag_by_normalized_name() {
    let workspace = TestWorkspace::new();
    let mut storage = Storage::open(&workspace.0).unwrap();
    let revision = storage.load_library().unwrap().revision;
    let existing = storage
        .save_tag(
            revision,
            TagInput {
                id: "tag-anime".into(),
                name: "anime".into(),
            },
        )
        .unwrap();
    let preview = stage_rows(&mut storage, mal_import_tag_rows(161));
    let decisions = preview
        .rows
        .iter()
        .enumerate()
        .map(|(index, _row)| {
            let mut decision = create_decision(&preview.rows, &[index]);
            decision.media_type_id = Some("anime".into());
            decision.tag_ids = vec!["tag-anime".into()];
            decision.new_tag_names = vec!["  ANIME  ".into()];
            decision
        })
        .collect();
    let result = storage
        .commit_library_import(ImportCommitInput {
            schema_version: 1,
            session_id: preview.session_id,
            expected_revision: preview.expected_revision,
            decisions,
            rating_policy: ImportRatingPolicy {
                mode: "preserveOnly".into(),
                priority: Vec::new(),
                manual_selections: Vec::new(),
            },
        })
        .unwrap();

    assert_eq!(result.created, 161);
    assert_eq!(result.library.tags.len(), 1);
    assert_eq!(result.library.tags[0].id, existing.tags[0].id);
    assert!(result
        .library
        .entries
        .iter()
        .all(|entry| entry.tag_ids == ["tag-anime"]));
}

#[test]
fn source_tag_mapping_creates_a_normalized_tag() {
    let workspace = TestWorkspace::new();
    let mut storage = Storage::open(&workspace.0).unwrap();
    let rows = mal_import_tag_rows(1);
    let preview = stage_rows(&mut storage, rows);
    let mut decision = create_decision(&preview.rows, &[0]);
    decision.media_type_id = Some("anime".into());
    decision.tag_mappings.push(ImportTagMapping {
        row_id: preview.rows[0].row_id.clone(),
        source_tag: "source label".into(),
        action: "create".into(),
        tag_id: None,
        new_tag_name: Some("Mapped Tag".into()),
    });
    let result = storage
        .commit_library_import(ImportCommitInput {
            schema_version: 1,
            session_id: preview.session_id,
            expected_revision: preview.expected_revision,
            decisions: vec![decision],
            rating_policy: ImportRatingPolicy {
                mode: "preserveOnly".into(),
                priority: Vec::new(),
                manual_selections: Vec::new(),
            },
        })
        .unwrap();

    assert_eq!(result.library.tags.len(), 1);
    assert_eq!(result.library.tags[0].name, "Mapped Tag");
    assert_eq!(
        result.library.entries[0].tag_ids,
        vec![result.library.tags[0].id.clone()]
    );
}

fn mal_import_tag_rows(count: usize) -> Vec<ImportSourceRow> {
    (0..count)
        .map(|index| {
            let external_id = format!("mal-tag-{index:03}");
            let mut row = staged_row(
                "myAnimeList",
                &external_id,
                &format!("MAL tag fixture {index:03}"),
                7.0,
                "1-10",
            );
            row.row_id = format!("myAnimeList:tag-test:{index}");
            row.provider_media_type = Some("TV".into());
            row.source_identities = vec![tastellar_domain::ExternalIdentity {
                provider: "myanimelist".into(),
                entity_kind: "anime".into(),
                external_id,
                source_url: None,
            }];
            row.suggested_media_type_id = Some("anime".into());
            row.tags = vec!["source label".into()];
            row
        })
        .collect()
}

fn staged_row(provider: &str, id: &str, title: &str, rating: f64, scale: &str) -> ImportSourceRow {
    ImportSourceRow {
        row_id: format!("{provider}:{id}"),
        provider: provider.into(),
        provider_media_type: Some("movie".into()),
        external_id: Some(id.into()),
        source_identities: vec![tastellar_domain::ExternalIdentity {
            provider: provider.into(),
            entity_kind: if provider == "imdb" { "title" } else { "film" }.into(),
            external_id: id.into(),
            source_url: None,
        }],
        source_url: None,
        title: title.into(),
        original_title: None,
        creators: Vec::new(),
        year: Some(2019),
        release_date: None,
        source_status: Some("watched".into()),
        source_rating: Some(SourceRating {
            value: rating,
            scale: scale.into(),
        }),
        source_dates: Default::default(),
        source_activities: Vec::new(),
        source_metadata: Default::default(),
        review_text: None,
        tags: Vec::new(),
        progress: None,
        suggested_media_type_id: Some("films".into()),
        exact_entry_id: None,
        candidates: Vec::new(),
        warnings: Vec::new(),
    }
}

fn create_decision(rows: &[ImportSourceRow], indices: &[usize]) -> ImportDecision {
    let row_ids = indices
        .iter()
        .map(|index| rows[*index].row_id.clone())
        .collect::<Vec<_>>();
    ImportDecision {
        row_ids: row_ids.clone(),
        action: "create".into(),
        target_entry_id: None,
        title: None,
        media_type_id: Some("films".into()),
        disposition: Some("experienced".into()),
        import_reviews: false,
        overwrite_existing_disposition: false,
        overwrite_existing_review: false,
        tag_ids: Vec::new(),
        new_tag_names: Vec::new(),
        manual_overall_rating: None,
        overwrite_existing_metadata: false,
        rating_selections: row_ids
            .into_iter()
            .map(|source_row_id| ImportRatingSelection {
                source_row_id,
                accept_native: true,
                overwrite_existing_rating: false,
            })
            .collect(),
        tag_mappings: Vec::new(),
        enrichments: Vec::new(),
    }
}

fn stage_rows(
    storage: &mut Storage,
    rows: Vec<ImportSourceRow>,
) -> tastellar_storage::import::ImportPreview {
    let sources = rows
        .iter()
        .map(|row| row.provider.clone())
        .collect::<std::collections::BTreeSet<_>>();
    storage
        .prepare_library_import_with_rows(
            PrepareImportInput {
                schema_version: 1,
                uploads: Vec::new(),
                steam: None,
            },
            rows.clone(),
            sources
                .into_iter()
                .map(|provider| ImportSourceSummary {
                    provider: provider.clone(),
                    source_name: "synthetic test rows".into(),
                    row_count: rows.iter().filter(|row| row.provider == provider).count(),
                    warnings: Vec::new(),
                })
                .collect(),
        )
        .unwrap()
}

fn commit_one(
    storage: &mut Storage,
    preview: tastellar_storage::import::ImportPreview,
    action: &str,
    target_entry_id: Option<String>,
) -> tastellar_storage::import::ImportCommitResult {
    let row = &preview.rows[0];
    let row_id = row.row_id.clone();
    let rating_selections = row
        .source_rating
        .as_ref()
        .map(|_| ImportRatingSelection {
            source_row_id: row_id.clone(),
            accept_native: true,
            overwrite_existing_rating: false,
        })
        .into_iter()
        .collect();
    let decision = ImportDecision {
        row_ids: vec![row_id],
        action: action.into(),
        target_entry_id,
        title: None,
        media_type_id: Some(
            row.suggested_media_type_id
                .clone()
                .unwrap_or_else(|| "films".into()),
        ),
        disposition: Some("experienced".into()),
        import_reviews: false,
        overwrite_existing_disposition: false,
        overwrite_existing_review: false,
        tag_ids: Vec::new(),
        new_tag_names: Vec::new(),
        manual_overall_rating: None,
        overwrite_existing_metadata: false,
        rating_selections,
        tag_mappings: Vec::new(),
        enrichments: Vec::new(),
    };
    let provider = row.provider.clone();
    storage
        .commit_library_import(ImportCommitInput {
            schema_version: 1,
            session_id: preview.session_id,
            expected_revision: preview.expected_revision,
            decisions: vec![decision],
            rating_policy: ImportRatingPolicy {
                mode: "priority".into(),
                priority: vec![provider],
                manual_selections: Vec::new(),
            },
        })
        .unwrap()
}

#[test]
fn conflicting_source_scores_require_an_explicit_choice_and_normalize_to_ten_point_scale() {
    let workspace = TestWorkspace::new();
    let mut storage = Storage::open(&workspace.0).unwrap();
    let rows = vec![
        staged_row("imdb", "tt99000011", "Harbor of Glass", 7.0, "1-10"),
        staged_row(
            "letterboxd",
            "https://letterboxd.com/film/harbor-glass/",
            "Harbor of Glass",
            4.5,
            "0.5-5",
        ),
        staged_row("imdb", "tt99000012", "A Quiet Orbit", 7.0, "1-10"),
        staged_row(
            "letterboxd",
            "https://letterboxd.com/film/a-quiet-orbit/",
            "A Quiet Orbit",
            3.5,
            "0.5-5",
        ),
    ];
    let preview = storage
        .prepare_library_import_with_rows(
            PrepareImportInput {
                schema_version: 1,
                uploads: Vec::new(),
                steam: None,
            },
            rows.clone(),
            vec![ImportSourceSummary {
                provider: "test-fixture".into(),
                source_name: "synthetic conflicting scores".into(),
                row_count: rows.len(),
                warnings: Vec::new(),
            }],
        )
        .unwrap();
    let conflict = create_decision(&rows, &[0, 1]);
    let equal = create_decision(&rows, &[2, 3]);
    let failed = storage.commit_library_import(ImportCommitInput {
        schema_version: 1,
        session_id: preview.session_id.clone(),
        expected_revision: preview.expected_revision,
        decisions: vec![conflict.clone(), equal.clone()],
        rating_policy: ImportRatingPolicy {
            mode: "manual".into(),
            priority: Vec::new(),
            manual_selections: Vec::new(),
        },
    });
    assert!(failed
        .unwrap_err()
        .to_string()
        .contains("Resolve the rating conflict"));

    let committed = storage
        .commit_library_import(ImportCommitInput {
            schema_version: 1,
            session_id: preview.session_id,
            expected_revision: preview.expected_revision,
            decisions: vec![conflict, equal],
            rating_policy: ImportRatingPolicy {
                mode: "manual".into(),
                priority: Vec::new(),
                manual_selections: vec![tastellar_storage::import::ManualRatingSelection {
                    row_ids: vec![rows[0].row_id.clone(), rows[1].row_id.clone()],
                    source_row_id: rows[1].row_id.clone(),
                }],
            },
        })
        .unwrap();
    let harbor = committed
        .library
        .entries
        .iter()
        .find(|entry| entry.title == "Harbor of Glass")
        .unwrap();
    let orbit = committed
        .library
        .entries
        .iter()
        .find(|entry| entry.title == "A Quiet Orbit")
        .unwrap();
    assert_eq!(
        harbor.overall_rating,
        Some(9),
        "Letterboxd 4.5/5 maps to 9/10 when the user explicitly selects it"
    );
    assert_eq!(
        orbit.overall_rating,
        Some(7),
        "Letterboxd 3.5/5 and IMDb 7/10 agree after normalization"
    );
    assert_eq!(
        harbor.external_identities.len(),
        2,
        "both provider identifiers remain attached to the one grouped work"
    );
}

#[test]
fn changed_mal_progress_and_steam_playtime_each_create_one_new_source_snapshot() {
    let workspace = TestWorkspace::new();
    let mut storage = Storage::open(&workspace.0).unwrap();

    let mal_xml = |episodes: u32| {
        format!(
            r#"<?xml version="1.0"?><myanimelist><anime><series_animedb_id>12345</series_animedb_id><series_title>Test Space Saga</series_title><series_type>TV</series_type><series_episodes>26</series_episodes><my_watched_episodes>{episodes}</my_watched_episodes><my_score>8</my_score><my_status>1</my_status></anime></myanimelist>"#
        )
    };
    let parse_mal = |episodes| {
        let xml = mal_xml(episodes);
        parse_import_uploads(&[ImportUpload {
            provider: "myAnimeList".into(),
            file_name: "list.xml".into(),
            content_base64: BASE64.encode(xml.as_bytes()),
        }])
        .unwrap()
        .1
    };
    let initial = stage_rows(&mut storage, parse_mal(4));
    let created = commit_one(&mut storage, initial, "create", None);
    let entry_id = created.library.entries[0].id.clone();
    let next = stage_rows(&mut storage, parse_mal(5));
    let changed = commit_one(&mut storage, next, "link", Some(entry_id.clone()));
    let stable = stage_rows(&mut storage, parse_mal(5));
    let no_op = commit_one(&mut storage, stable, "link", Some(entry_id));
    assert_eq!(
        changed.library.revision,
        created.library.revision + 1,
        "new MAL progress should be a library change"
    );
    assert_eq!(
        no_op.library.revision, changed.library.revision,
        "repeating identical MAL progress should be idempotent"
    );

    let steam_row = |minutes| {
        ImportSourceRow::from_steam_owned_game(tastellar_storage::SteamOwnedGame {
            app_id: "62001".into(),
            name: "Synthetic Steam Test".into(),
            playtime_forever: Some(minutes),
            playtime_2weeks: Some(0),
            free_to_play: None,
        })
    };
    let first_steam = stage_rows(&mut storage, vec![steam_row(35)]);
    let created_steam = commit_one(&mut storage, first_steam, "create", None);
    let steam_id = created_steam
        .library
        .entries
        .iter()
        .find(|entry| entry.title == "Synthetic Steam Test")
        .unwrap()
        .id
        .clone();
    let changed_steam = stage_rows(&mut storage, vec![steam_row(80)]);
    let updated_steam = commit_one(&mut storage, changed_steam, "link", Some(steam_id.clone()));
    let repeated_steam = stage_rows(&mut storage, vec![steam_row(80)]);
    let repeated = commit_one(&mut storage, repeated_steam, "link", Some(steam_id));
    assert_eq!(
        updated_steam.library.revision,
        created_steam.library.revision + 1,
        "changed playtime should be an import event"
    );
    assert_eq!(
        repeated.library.revision, updated_steam.library.revision,
        "repeated Steam playtime should not create another event"
    );

    let connection = Connection::open(workspace.0.join("tastellar.sqlite3")).unwrap();
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM entry_event WHERE kind='external_source_activity'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 4, "initial + changed MAL and Steam snapshots only");
}

/// Run with `TASTELLAR_PRIVATE_IMPORT_FIXTURES` pointing at the user's local
/// export directory. It intentionally emits no filenames or imported titles.
#[test]
#[ignore = "requires user-owned local export files; never run in CI"]
fn private_user_exports_stage_expected_rows_without_aggregating_ratings() {
    let directory =
        std::path::PathBuf::from(std::env::var("TASTELLAR_PRIVATE_IMPORT_FIXTURES").unwrap());
    let mut uploads = Vec::new();
    for path in fs::read_dir(directory)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
    {
        if !path.is_file() {
            continue;
        }
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let bytes = fs::read(&path).unwrap();
        let provider = if extension == "zip" {
            Some("letterboxd")
        } else if extension == "csv" {
            let header = bytes
                .split(|byte| *byte == b'\n')
                .next()
                .unwrap_or_default();
            let header = String::from_utf8_lossy(header).to_ascii_lowercase();
            if header.contains("const") && header.contains("your rating") {
                Some("imdb")
            } else if header.contains("book id")
                && (header.contains("isbn") || header.contains("my rating"))
            {
                Some("goodreads")
            } else {
                None
            }
        } else {
            None
        };
        if let Some(provider) = provider {
            uploads.push(ImportUpload {
                provider: provider.into(),
                file_name: path.file_name().unwrap().to_string_lossy().into_owned(),
                content_base64: BASE64.encode(bytes),
            });
        }
    }
    assert_eq!(
        uploads.len(),
        3,
        "expected one export from each of the three tested services"
    );
    let (sources, rows, _) = parse_import_uploads(&uploads).unwrap();
    assert_eq!(rows.len(), 28);
    assert_eq!(
        sources.iter().map(|source| source.row_count).sum::<usize>(),
        rows.len()
    );
    assert!(rows.iter().any(|row| row.provider == "letterboxd"));
    assert!(rows.iter().any(|row| row.provider == "imdb"));
    assert!(rows.iter().any(|row| row.provider == "goodreads"));
    assert!(rows
        .iter()
        .filter(|row| row.provider == "imdb")
        .all(|row| row
            .source_rating
            .as_ref()
            .is_none_or(|score| score.scale == "1-10")));
    assert!(rows
        .iter()
        .filter(|row| row.provider == "goodreads")
        .all(|row| row
            .source_rating
            .as_ref()
            .is_none_or(|score| score.scale == "0-5")));
    assert!(rows
        .iter()
        .filter(|row| row.provider == "letterboxd")
        .all(|row| row
            .source_rating
            .as_ref()
            .is_none_or(|score| score.scale == "0.5-5")));
}

#[test]
fn rating_priority_and_latest_require_reviewed_comparable_sources() {
    let workspace = TestWorkspace::new();
    let mut storage = Storage::open(&workspace.0).unwrap();
    let mut rows = vec![
        staged_row("imdb", "tt99000301", "Shared work", 7.0, "1-10"),
        staged_row(
            "letterboxd",
            "https://letterboxd.com/film/shared-work/",
            "Shared work",
            4.5,
            "0.5-5",
        ),
    ];
    rows[0]
        .source_dates
        .insert("date rated".into(), "2026-01-02".into());
    rows[1]
        .source_dates
        .insert("date".into(), "2026-10-04".into());
    let preview = stage_rows(&mut storage, rows.clone());
    let make_input = |mode: &str| ImportCommitInput {
        schema_version: 1,
        session_id: preview.session_id.clone(),
        expected_revision: preview.expected_revision,
        decisions: vec![create_decision(&rows, &[0, 1])],
        rating_policy: ImportRatingPolicy {
            mode: mode.into(),
            priority: vec!["letterboxd".into(), "imdb".into()],
            manual_selections: Vec::new(),
        },
    };
    assert!(
        storage
            .commit_library_import(make_input("latestComparable"))
            .is_err(),
        "Letterboxd Date is not a comparable rating date"
    );
    assert!(
        storage.load_library().unwrap().entries.is_empty(),
        "failed review must commit nothing"
    );
    let committed = storage
        .commit_library_import(make_input("priority"))
        .unwrap();
    assert_eq!(committed.library.entries[0].overall_rating, Some(9));
    storage
        .undo_library_import(&committed.batch_id, committed.library.revision)
        .unwrap();

    rows[1] = staged_row("imdb", "tt99000302", "Shared work", 9.0, "1-10");
    rows[1]
        .source_dates
        .insert("date rated".into(), "2026-01-03".into());
    let preview = stage_rows(&mut storage, rows.clone());
    let committed = storage
        .commit_library_import(ImportCommitInput {
            schema_version: 1,
            session_id: preview.session_id,
            expected_revision: preview.expected_revision,
            decisions: vec![create_decision(&rows, &[0, 1])],
            rating_policy: ImportRatingPolicy {
                mode: "latestComparable".into(),
                priority: Vec::new(),
                manual_selections: Vec::new(),
            },
        })
        .unwrap();
    assert_eq!(committed.library.entries[0].overall_rating, Some(9));
}

#[test]
fn undo_refuses_later_order_changes_even_without_an_entry_version_change() {
    let workspace = TestWorkspace::new();
    let mut storage = Storage::open(&workspace.0).unwrap();
    let preview = stage_rows(
        &mut storage,
        vec![staged_row("imdb", "tt99000303", "Order guard", 7.0, "1-10")],
    );
    let committed = commit_one(&mut storage, preview, "create", None);
    let entry = &committed.library.entries[0];
    let connection = Connection::open(workspace.0.join("tastellar.sqlite3")).unwrap();
    let original: String = connection
        .query_row(
            "SELECT order_key FROM group_order WHERE entry_id=?1",
            [&entry.id],
            |row| row.get(0),
        )
        .unwrap();
    connection
        .execute(
            "UPDATE group_order SET order_key='zz' WHERE entry_id=?1",
            [&entry.id],
        )
        .unwrap();
    assert_eq!(
        storage.load_library().unwrap().entries[0].version,
        entry.version
    );
    assert!(matches!(
        storage.undo_library_import(&committed.batch_id, committed.library.revision),
        Err(tastellar_storage::StorageError::Conflict)
    ));
    assert_eq!(storage.load_library().unwrap().entries.len(), 1);
    connection
        .execute(
            "UPDATE group_order SET order_key=?1 WHERE entry_id=?2",
            rusqlite::params![original, entry.id],
        )
        .unwrap();
    assert!(storage
        .undo_library_import(&committed.batch_id, committed.library.revision)
        .unwrap()
        .library
        .entries
        .is_empty());
}
