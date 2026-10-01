use rusqlite::Connection;
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tastellar_domain::{DuelAnswer, EntryInput, RankingPosition};
use tastellar_storage::{Storage, StorageError};

struct TestDb(PathBuf);
static TEST_DB_SEQUENCE: AtomicU64 = AtomicU64::new(0);

impl TestDb {
    fn new() -> Self {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = TEST_DB_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "tastellar-ranking-flow-{}-{suffix}-{sequence}",
            std::process::id(),
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn open(&self) -> Storage {
        Storage::open(&self.0).unwrap()
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn add_scored(storage: &mut Storage, id: &str) {
    let library = storage.load_library().unwrap();
    storage
        .save_entry(
            library.revision,
            EntryInput {
                id: id.into(),
                title: id.into(),
                disposition: "experienced".into(),
                media_type_id: None,
                overall_rating: Some(8),
                cover_asset_id: None,
                release_date: None,
                review_text: String::new(),
                short_label: None,
                criterion_ratings: BTreeMap::new(),
                tag_ids: Vec::new(),
            },
        )
        .unwrap();
}

fn place_at_end(storage: &mut Storage, id: &str) {
    let state = storage.load_ranking().unwrap();
    storage
        .move_ranking_entry(
            state.revision,
            id,
            8,
            true,
            RankingPosition {
                kind: "end".into(),
                anchor_id: None,
            },
        )
        .unwrap();
}

fn place_baseline(storage: &mut Storage, ids: &[&str]) {
    for id in ids {
        add_scored(storage, id);
        place_at_end(storage, id);
    }
}

fn start_binary(storage: &mut Storage, candidate: &str) -> tastellar_domain::DuelSession {
    let state = storage.load_ranking().unwrap();
    storage
        .start_duel_session(
            state.revision,
            8,
            vec![],
            Some(candidate.into()),
            "binary".into(),
        )
        .unwrap()
}

fn place_candidate(storage: &mut Storage, candidate: &str) {
    add_scored(storage, candidate);
    // The insertion command itself preserves the binary judgments.
}

#[test]
fn zero_baseline_offers_first_placement_without_a_comparison() {
    let db = TestDb::new();
    let mut storage = db.open();
    place_candidate(&mut storage, "first");

    let session = start_binary(&mut storage, "first");
    assert_eq!(session.mode, "confirm");
    let prompt = storage.next_duel(&session.id, false).unwrap().unwrap();
    assert_eq!(prompt.kind, "confirm");
    assert_eq!(prompt.proposed_position, Some(0));
    assert_eq!(prompt.tier_length, Some(0));
    assert_eq!(prompt.previous_entry_id, None);
    assert_eq!(prompt.next_entry_id, None);

    let revision = storage.load_ranking().unwrap().revision;
    let result = storage
        .confirm_binary_placement(revision, &session.id, true)
        .unwrap();
    assert_eq!(
        result.next_step,
        tastellar_domain::BinaryPlacementNextStep::Done
    );
    let state = result.state;
    let tier = state.tiers.iter().find(|tier| tier.score == 8).unwrap();
    assert_eq!(tier.placed_ids, ["first"]);
    assert!(tier.unplaced_ids.is_empty());
    assert!(state.active_session.is_none());
    assert!(storage.next_duel(&session.id, false).unwrap().is_none());
}

#[test]
fn binary_wins_and_pivot_wins_narrow_into_the_shared_order_and_normal_duels() {
    let db = TestDb::new();
    let mut storage = db.open();
    place_baseline(&mut storage, &["a", "b", "c", "d"]);
    place_candidate(&mut storage, "candidate");

    let session = start_binary(&mut storage, "candidate");
    let first = storage.next_duel(&session.id, false).unwrap().unwrap();
    assert_eq!(first.kind, "binary");
    assert_eq!(first.right_entry_id, "c");
    let revision = storage.load_ranking().unwrap().revision;
    let state = storage
        .answer_duel(revision, &session.id, &first.duel_id, DuelAnswer::LeftWin)
        .unwrap();

    let second = storage.next_duel(&session.id, false).unwrap().unwrap();
    assert_eq!(second.right_entry_id, "b");
    let state = storage
        .answer_duel(
            state.revision,
            &session.id,
            &second.duel_id,
            DuelAnswer::RightWin,
        )
        .unwrap();
    let confirmation = storage.next_duel(&session.id, false).unwrap().unwrap();
    assert_eq!(confirmation.kind, "confirm");
    assert_eq!(confirmation.proposed_position, Some(2));
    assert_eq!(confirmation.previous_entry_id.as_deref(), Some("b"));
    assert_eq!(confirmation.next_entry_id.as_deref(), Some("c"));

    let result = storage
        .confirm_binary_placement(state.revision, &session.id, true)
        .unwrap();
    assert_eq!(
        result.next_step,
        tastellar_domain::BinaryPlacementNextStep::Normal
    );
    let state = result.state;
    let expected = ["a", "b", "candidate", "c", "d"];
    assert_eq!(
        state
            .tiers
            .iter()
            .find(|tier| tier.score == 8)
            .unwrap()
            .placed_ids,
        expected
    );
    assert_eq!(state.active_session.as_ref().unwrap().mode, "normal");

    let normal = storage.next_duel(&session.id, false).unwrap().unwrap();
    assert_eq!(normal.kind, "normal");
    let ranked = &state
        .tiers
        .iter()
        .find(|tier| tier.score == 8)
        .unwrap()
        .placed_ids;
    assert!(ranked.contains(&normal.left_entry_id));
    assert!(ranked.contains(&normal.right_entry_id));

    // The inserted order is persisted and is the same order read by the list
    // after a process restart; normal judgments continue on those same entries.
    let revision = storage.load_ranking().unwrap().revision;
    let judgment = storage
        .answer_duel(revision, &session.id, &normal.duel_id, DuelAnswer::LeftWin)
        .unwrap();
    drop(storage);
    let mut reopened = db.open();
    let after_restart = reopened.load_ranking().unwrap();
    assert_eq!(
        after_restart
            .tiers
            .iter()
            .find(|tier| tier.score == 8)
            .unwrap()
            .placed_ids,
        expected
    );
    assert!(after_restart.active_session.is_some());
    assert!(judgment.revision <= after_restart.revision);
}

#[test]
fn binary_tie_proposes_the_slot_immediately_after_its_pivot() {
    let db = TestDb::new();
    let mut storage = db.open();
    place_baseline(&mut storage, &["a", "b", "c"]);
    place_candidate(&mut storage, "tied");

    let session = start_binary(&mut storage, "tied");
    let duel = storage.next_duel(&session.id, false).unwrap().unwrap();
    assert_eq!(duel.right_entry_id, "b");
    let revision = storage.load_ranking().unwrap().revision;
    let state = storage
        .answer_duel(revision, &session.id, &duel.duel_id, DuelAnswer::Tie)
        .unwrap();
    let prompt = storage.next_duel(&session.id, false).unwrap().unwrap();
    assert_eq!(prompt.kind, "confirm");
    assert_eq!(prompt.proposed_position, Some(2));
    assert_eq!(prompt.previous_entry_id.as_deref(), Some("b"));
    assert_eq!(prompt.next_entry_id.as_deref(), Some("c"));

    let result = storage
        .confirm_binary_placement(state.revision, &session.id, true)
        .unwrap();
    let state = result.state;
    assert_eq!(
        state
            .tiers
            .iter()
            .find(|tier| tier.score == 8)
            .unwrap()
            .placed_ids,
        ["a", "b", "tied", "c"]
    );
}

#[test]
fn skipped_binary_candidate_stays_unplaced_and_ends_instead_of_starting_normal_duels() {
    let db = TestDb::new();
    let mut storage = db.open();
    place_baseline(&mut storage, &["a", "b"]);
    place_candidate(&mut storage, "deferred");

    let session = start_binary(&mut storage, "deferred");
    let binary = storage.next_duel(&session.id, false).unwrap().unwrap();
    let revision = storage.load_ranking().unwrap().revision;
    let state = storage
        .answer_duel(revision, &session.id, &binary.duel_id, DuelAnswer::Skip)
        .unwrap();
    let tier = state.tiers.iter().find(|tier| tier.score == 8).unwrap();
    assert_eq!(tier.unplaced_ids, ["deferred"]);
    assert!(state.active_session.is_none());
    assert!(storage.next_duel(&session.id, false).unwrap().is_none());
}

#[test]
fn stale_binary_prompt_restarts_with_a_new_session_and_ignores_old_answers() {
    let db = TestDb::new();
    let mut storage = db.open();
    place_baseline(&mut storage, &["a", "b"]);
    place_candidate(&mut storage, "candidate");
    let session = start_binary(&mut storage, "candidate");

    let state = storage.load_ranking().unwrap();
    storage
        .move_ranking_entry(
            state.revision,
            "a",
            8,
            true,
            RankingPosition {
                kind: "end".into(),
                anchor_id: None,
            },
        )
        .unwrap();
    let replacement_prompt = storage.next_duel(&session.id, false).unwrap().unwrap();
    assert_ne!(replacement_prompt.session_id, session.id);
    let replacement = storage.load_ranking().unwrap().active_session.unwrap();
    assert_eq!(replacement.id, replacement_prompt.session_id);
    assert_eq!(replacement.answered_count, 0);

    let revision = storage.load_ranking().unwrap().revision;
    let after_stale_answer = storage
        .answer_duel(
            revision,
            &session.id,
            &replacement_prompt.duel_id,
            DuelAnswer::LeftWin,
        )
        .unwrap();
    let active = after_stale_answer.active_session.unwrap();
    assert_eq!(active.id, replacement_prompt.session_id);
    assert_eq!(active.answered_count, 0);
    assert!(matches!(
        storage.end_duel_session(&session.id),
        Err(StorageError::Validation(_))
    ));
}

#[test]
fn reset_clears_ranking_evidence_but_keeps_media_and_its_score() {
    let db = TestDb::new();
    let mut storage = db.open();
    place_baseline(&mut storage, &["one", "two"]);
    let revision = storage.load_ranking().unwrap().revision;
    let session = storage
        .start_duel_session(revision, 8, vec![], None, "normal".into())
        .unwrap();
    let pair = storage.next_duel(&session.id, false).unwrap().unwrap();
    let revision = storage.load_ranking().unwrap().revision;
    storage
        .answer_duel(revision, &session.id, &pair.duel_id, DuelAnswer::LeftWin)
        .unwrap();

    let revision = storage.load_ranking().unwrap().revision;
    let library = storage.reset_media_ranking(revision).unwrap();
    assert_eq!(library.entries.len(), 2);
    assert!(library
        .entries
        .iter()
        .all(|entry| entry.overall_rating == Some(8)));
    let connection = Connection::open(db.0.join("tastellar.sqlite3")).unwrap();
    for table in [
        "ranking_judgment",
        "ranking_session",
        "ranking_boundary",
        "ranking_order_event",
        "ranking_fit",
    ] {
        let count: i64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "{table} should be cleared by ranking reset");
    }
    drop(connection);
    let ranking = storage.load_ranking().unwrap();
    let tier = ranking.tiers.iter().find(|tier| tier.score == 8).unwrap();
    assert!(tier.placed_ids.is_empty());
    assert_eq!(tier.unplaced_ids.len(), 2);
}
