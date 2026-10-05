use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tastellar_domain::{BinaryPlacementNextStep, DuelAnswer, EntryInput, RankingPosition};
use tastellar_storage::Storage;

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
            "tastellar-ranking-reported-{}-{suffix}-{sequence}",
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

fn add_unplaced(storage: &mut Storage, id: &str) {
    add_unplaced_at(storage, id, 8);
}

fn add_unplaced_at(storage: &mut Storage, id: &str, score: i32) {
    let state = storage.load_library().unwrap();
    storage
        .save_entry(
            state.revision,
            EntryInput {
                id: id.into(),
                title: id.into(),
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
        add_unplaced(storage, id);
        place_at_end(storage, id);
    }
}

fn start_normal(storage: &mut Storage) -> tastellar_domain::DuelSession {
    let state = storage.load_ranking().unwrap();
    storage
        .start_duel_session(state.revision, 8, Vec::new(), None, "normal".into())
        .unwrap()
}

#[test]
fn first_seed_duel_compares_two_unplaced_and_places_both() {
    let db = TestDb::new();
    let mut storage = db.open();
    add_unplaced(&mut storage, "first-unplaced");
    add_unplaced(&mut storage, "second-unplaced");

    let revision = storage.load_ranking().unwrap().revision;
    let session = storage
        .start_duel_session(
            revision,
            8,
            Vec::new(),
            Some("first-unplaced".into()),
            "binary".into(),
        )
        .unwrap();
    let prompt = storage.next_duel(&session.id, false).unwrap().unwrap();
    assert_eq!(prompt.kind, "seed");
    assert_eq!(
        [
            prompt.left_entry_id.as_str(),
            prompt.right_entry_id.as_str()
        ],
        ["first-unplaced", "second-unplaced"]
    );

    let archive_path = db.0.join("active-seed-session.tastellar.json");
    storage.export_library_archive(&archive_path).unwrap();
    let restored_db = TestDb::new();
    let mut restored = restored_db.open();
    let empty_home = restored.load_home().unwrap();
    restored
        .import_library_archive(&archive_path, empty_home.version)
        .unwrap();
    let restored_session = restored.load_ranking().unwrap().active_session.unwrap();
    let restored_prompt = restored
        .next_duel(&restored_session.id, false)
        .unwrap()
        .unwrap();
    assert_eq!(restored_prompt, prompt);

    let revision = storage.load_ranking().unwrap().revision;
    let state = storage
        .answer_duel(revision, &session.id, &prompt.duel_id, DuelAnswer::LeftWin)
        .unwrap();
    let tier = state.tiers.iter().find(|tier| tier.score == 8).unwrap();
    assert_eq!(tier.placed_ids, ["first-unplaced", "second-unplaced"]);
    assert!(tier.unplaced_ids.is_empty());
}

#[test]
fn seed_tie_uses_stable_unplaced_order() {
    let db = TestDb::new();
    let mut storage = db.open();
    add_unplaced(&mut storage, "seed-a");
    add_unplaced(&mut storage, "seed-b");
    let before = storage
        .load_ranking()
        .unwrap()
        .tiers
        .into_iter()
        .find(|tier| tier.score == 8)
        .unwrap()
        .unplaced_ids;

    let revision = storage.load_ranking().unwrap().revision;
    let session = storage
        .start_duel_session(
            revision,
            8,
            Vec::new(),
            Some("seed-a".into()),
            "binary".into(),
        )
        .unwrap();
    let prompt = storage.next_duel(&session.id, false).unwrap().unwrap();
    assert_eq!(prompt.kind, "seed");
    let revision = storage.load_ranking().unwrap().revision;
    let state = storage
        .answer_duel(revision, &session.id, &prompt.duel_id, DuelAnswer::Tie)
        .unwrap();
    let tier = state.tiers.iter().find(|tier| tier.score == 8).unwrap();
    assert_eq!(tier.placed_ids, before);
    assert!(tier.unplaced_ids.is_empty());
}

#[test]
fn skipping_a_seed_pair_does_not_place_works_and_a_new_seed_avoids_that_pair() {
    let db = TestDb::new();
    let mut storage = db.open();
    for id in ["seed-a", "seed-b", "seed-c"] {
        add_unplaced(&mut storage, id);
    }
    let before_tier = storage
        .load_ranking()
        .unwrap()
        .tiers
        .into_iter()
        .find(|tier| tier.score == 8)
        .unwrap();
    let before_unplaced = before_tier.unplaced_ids.clone();
    let before_sequence = before_tier.input_sequence;
    let revision = storage.load_ranking().unwrap().revision;
    let session = storage
        .start_duel_session(
            revision,
            8,
            Vec::new(),
            Some("seed-a".into()),
            "binary".into(),
        )
        .unwrap();
    let first = storage.next_duel(&session.id, false).unwrap().unwrap();
    let revision = storage.load_ranking().unwrap().revision;
    let state = storage
        .answer_duel(revision, &session.id, &first.duel_id, DuelAnswer::Skip)
        .unwrap();
    let tier = state.tiers.iter().find(|tier| tier.score == 8).unwrap();
    assert_eq!(tier.input_sequence, before_sequence);
    assert!(tier.placed_ids.is_empty());
    assert_eq!(tier.unplaced_ids, before_unplaced);

    assert!(state.active_session.is_none());
    assert!(storage.next_duel(&session.id, false).unwrap().is_none());
    let next_session = storage
        .start_duel_session(
            state.revision,
            8,
            Vec::new(),
            Some("seed-a".into()),
            "binary".into(),
        )
        .unwrap();
    let second = storage.next_duel(&next_session.id, false).unwrap().unwrap();
    assert_eq!(second.kind, "seed");
    assert_ne!(
        [first.left_entry_id.as_str(), first.right_entry_id.as_str()],
        [
            second.left_entry_id.as_str(),
            second.right_entry_id.as_str()
        ]
    );
}

#[test]
fn normal_intent_is_forced_into_binary_placement_until_the_tier_is_fully_placed() {
    let db = TestDb::new();
    let mut storage = db.open();
    place_baseline(&mut storage, &["placed-a", "placed-b"]);
    add_unplaced(&mut storage, "candidate-a");
    add_unplaced(&mut storage, "candidate-b");

    let state = storage.load_ranking().unwrap();
    let session = storage
        .start_duel_session(state.revision, 8, Vec::new(), None, "normal".into())
        .unwrap();
    assert_eq!(session.mode, "binary");
    let placed = state
        .tiers
        .iter()
        .find(|tier| tier.score == 8)
        .unwrap()
        .placed_ids
        .clone();
    let mut prompt = storage.next_duel(&session.id, false).unwrap().unwrap();
    assert_eq!(prompt.kind, "binary");
    assert!(placed.contains(&prompt.right_entry_id));

    while prompt.kind != "confirm" {
        let revision = storage.load_ranking().unwrap().revision;
        let state = storage
            .answer_duel(revision, &session.id, &prompt.duel_id, DuelAnswer::LeftWin)
            .unwrap();
        prompt = storage.next_duel(&session.id, false).unwrap().unwrap();
        assert!(state.active_session.is_some());
    }
    let revision = storage.load_ranking().unwrap().revision;
    let result = storage
        .confirm_binary_placement(revision, &session.id, true)
        .unwrap();
    assert_eq!(result.next_step, BinaryPlacementNextStep::OfferBinary);
    assert!(result.state.active_session.is_none());
    let tier = result
        .state
        .tiers
        .iter()
        .find(|tier| tier.score == 8)
        .unwrap();
    assert_eq!(tier.unplaced_ids, ["candidate-b"]);
}

#[test]
fn placing_the_first_seed_pair_offers_another_binary_candidate_when_items_remain() {
    let db = TestDb::new();
    let mut storage = db.open();
    for id in ["seed-first", "seed-second", "seed-next"] {
        add_unplaced(&mut storage, id);
    }
    let state = storage.load_ranking().unwrap();
    let session = storage
        .start_duel_session(state.revision, 8, Vec::new(), None, "normal".into())
        .unwrap();
    assert_eq!(session.mode, "seed");
    let prompt = storage.next_duel(&session.id, false).unwrap().unwrap();
    let revision = storage.load_ranking().unwrap().revision;
    let state = storage
        .answer_duel(revision, &session.id, &prompt.duel_id, DuelAnswer::LeftWin)
        .unwrap();
    assert!(state.active_session.is_none());
    let tier = state.tiers.iter().find(|tier| tier.score == 8).unwrap();
    assert_eq!(tier.placed_ids.len(), 2);
    assert_eq!(tier.unplaced_ids.len(), 1);
}

#[test]
fn eligible_unplaced_filter_scopes_seed_pair_and_candidate_but_not_binary_pivots() {
    let db = TestDb::new();
    let mut storage = db.open();
    for id in ["allowed-a", "allowed-b", "excluded"] {
        add_unplaced(&mut storage, id);
    }
    let state = storage.load_ranking().unwrap();
    let seed = storage
        .start_duel_session_with_eligible_unplaced(
            state.revision,
            8,
            Vec::new(),
            Some("allowed-a".into()),
            None,
            Some(vec!["allowed-a".into(), "allowed-b".into()]),
            "binary".into(),
        )
        .unwrap();
    let seed_prompt = storage.next_duel(&seed.id, false).unwrap().unwrap();
    assert_eq!(seed_prompt.kind, "seed");
    assert!(seed_prompt.left_entry_id.starts_with("allowed-"));
    assert!(seed_prompt.right_entry_id.starts_with("allowed-"));

    storage.end_duel_session(&seed.id).unwrap();
    place_baseline(&mut storage, &["placed-a", "placed-b"]);
    let state = storage.load_ranking().unwrap();
    let candidate = state
        .tiers
        .iter()
        .find(|tier| tier.score == 8)
        .unwrap()
        .unplaced_ids[0]
        .clone();
    let binary = storage
        .start_duel_session_with_eligible_unplaced(
            state.revision,
            8,
            Vec::new(),
            Some(candidate.clone()),
            None,
            Some(vec![candidate.clone()]),
            "binary".into(),
        )
        .unwrap();
    let prompt = storage.next_duel(&binary.id, false).unwrap().unwrap();
    assert_eq!(prompt.kind, "binary");
    assert_eq!(prompt.left_entry_id, candidate);
    let tier = state.tiers.iter().find(|tier| tier.score == 8).unwrap();
    assert!(tier.placed_ids.contains(&prompt.right_entry_id));
}

#[test]
fn normal_duels_do_not_repeat_the_last_pair_in_reverse_order() {
    let db = TestDb::new();
    let mut storage = db.open();
    place_baseline(&mut storage, &["pair-a", "pair-b"]);
    let session = start_normal(&mut storage);
    let first = storage.next_duel(&session.id, false).unwrap().unwrap();
    let revision = storage.load_ranking().unwrap().revision;
    storage
        .answer_duel(revision, &session.id, &first.duel_id, DuelAnswer::LeftWin)
        .unwrap();

    assert!(storage.next_duel(&session.id, false).unwrap().is_none());
    assert!(storage.load_ranking().unwrap().active_session.is_none());
}

#[test]
fn a_skipped_binary_candidate_pivot_is_not_repeated_after_restarting_that_candidate() {
    let db = TestDb::new();
    let mut storage = db.open();
    place_baseline(&mut storage, &["pivot-a", "pivot-b", "pivot-c"]);
    add_unplaced(&mut storage, "candidate");
    let state = storage.load_ranking().unwrap();
    let first_session = storage
        .start_duel_session(
            state.revision,
            8,
            Vec::new(),
            Some("candidate".into()),
            "binary".into(),
        )
        .unwrap();
    let first = storage
        .next_duel(&first_session.id, false)
        .unwrap()
        .unwrap();
    let revision = storage.load_ranking().unwrap().revision;
    let state = storage
        .answer_duel(
            revision,
            &first_session.id,
            &first.duel_id,
            DuelAnswer::Skip,
        )
        .unwrap();
    assert!(state.active_session.is_none());

    let second_session = storage
        .start_duel_session(
            state.revision,
            8,
            Vec::new(),
            Some("candidate".into()),
            "binary".into(),
        )
        .unwrap();
    let second = storage
        .next_duel(&second_session.id, false)
        .unwrap()
        .unwrap();
    assert_eq!(second.kind, "binary");
    assert_eq!(second.left_entry_id, "candidate");
    assert_ne!(second.right_entry_id, first.right_entry_id);
}

#[test]
fn sanitized_archive_shaped_population_starts_with_an_unplaced_pair() {
    let db = TestDb::new();
    let mut storage = db.open();
    let tier_counts = [(7, 124), (8, 71), (6, 31), (9, 18), (10, 4)];
    for (score, count) in tier_counts {
        for index in 0..count {
            add_unplaced_at(&mut storage, &format!("fixture-{score}-{index:03}"), score);
        }
    }
    let state = storage.load_ranking().unwrap();
    assert_eq!(state.library.entries.len(), 248);
    assert!(state.tiers.iter().all(|tier| tier.placed_ids.is_empty()));
    assert_eq!(
        state
            .tiers
            .iter()
            .map(|tier| tier.unplaced_ids.len())
            .sum::<usize>(),
        248
    );

    let session = storage
        .start_duel_session(
            state.revision,
            7,
            Vec::new(),
            Some("fixture-7-000".into()),
            "binary".into(),
        )
        .unwrap();
    let prompt = storage.next_duel(&session.id, false).unwrap().unwrap();
    assert_eq!(prompt.kind, "seed");
    assert_ne!(prompt.left_entry_id, prompt.right_entry_id);
    assert_eq!(prompt.left_entry_id, "fixture-7-000");
    assert!(prompt.right_entry_id.starts_with("fixture-7-"));
}

#[test]
fn per_item_binary_placement_starts_at_the_middle_pivot() {
    let db = TestDb::new();
    let mut storage = db.open();
    place_baseline(&mut storage, &["a", "b", "c", "d"]);
    add_unplaced(&mut storage, "chosen-unplaced");

    let revision = storage.load_ranking().unwrap().revision;
    let session = storage
        .start_duel_session(
            revision,
            8,
            Vec::new(),
            Some("chosen-unplaced".into()),
            "binary".into(),
        )
        .unwrap();
    let first = storage.next_duel(&session.id, false).unwrap().unwrap();
    assert_eq!(first.kind, "binary");
    assert_eq!(first.left_entry_id, "chosen-unplaced");
    assert_eq!(first.right_entry_id, "c");

    let revision = storage.load_ranking().unwrap().revision;
    storage
        .answer_duel(revision, &session.id, &first.duel_id, DuelAnswer::LeftWin)
        .unwrap();
    let second = storage.next_duel(&session.id, false).unwrap().unwrap();
    assert_eq!(second.kind, "binary");
    assert_eq!(second.right_entry_id, "b");
}

#[test]
fn normal_duel_evidence_can_change_the_shared_canonical_order() {
    let db = TestDb::new();
    let mut storage = db.open();
    place_baseline(&mut storage, &["higher-b", "lower-a"]);
    // The second placement places `higher-b` above `lower-a`, which the later
    // repeated direct judgments will contradict.
    let session = start_normal(&mut storage);

    let mut state = storage.load_ranking().unwrap();
    let mut moved = false;
    for _ in 0..40 {
        let prompt = storage.next_duel(&session.id, true).unwrap().unwrap();
        let answer = if prompt.left_entry_id == "lower-a" {
            DuelAnswer::LeftWin
        } else {
            assert_eq!(prompt.right_entry_id, "lower-a");
            DuelAnswer::RightWin
        };
        state = storage
            .answer_duel(state.revision, &session.id, &prompt.duel_id, answer)
            .unwrap();
        let tier = state.tiers.iter().find(|tier| tier.score == 8).unwrap();
        if tier.placed_ids == ["lower-a", "higher-b"] {
            moved = true;
            break;
        }
    }
    assert!(
        moved,
        "sufficient direct duel evidence should reconcile the shared order"
    );
    drop(storage);

    let reopened = db.open().load_ranking().unwrap();
    assert_eq!(
        reopened
            .tiers
            .iter()
            .find(|tier| tier.score == 8)
            .unwrap()
            .placed_ids,
        ["lower-a", "higher-b"]
    );
}

#[test]
fn starting_a_new_session_ends_the_previous_active_session() {
    let db = TestDb::new();
    let mut storage = db.open();
    place_baseline(&mut storage, &["a", "b", "c"]);
    let first = start_normal(&mut storage);
    assert!(storage.next_duel(&first.id, false).unwrap().is_some());

    let second = start_normal(&mut storage);
    assert_ne!(first.id, second.id);
    let state = storage.load_ranking().unwrap();
    assert_eq!(state.active_session.unwrap().id, second.id);
    assert!(storage.next_duel(&first.id, false).unwrap().is_none());
    assert!(storage.next_duel(&second.id, false).unwrap().is_some());
}

#[test]
fn two_item_normal_tier_does_not_repeat_the_same_pair_immediately() {
    let db = TestDb::new();
    let mut storage = db.open();
    place_baseline(&mut storage, &["a", "b"]);
    let first = start_normal(&mut storage);
    let prompt = storage.next_duel(&first.id, false).unwrap().unwrap();
    let revision = storage.load_ranking().unwrap().revision;
    storage
        .answer_duel(revision, &first.id, &prompt.duel_id, DuelAnswer::Tie)
        .unwrap();

    assert!(storage.next_duel(&first.id, false).unwrap().is_none());

    let replacement = start_normal(&mut storage);
    assert_ne!(first.id, replacement.id);
    assert!(storage.next_duel(&first.id, false).unwrap().is_none());
    assert!(storage.next_duel(&replacement.id, false).unwrap().is_none());
}
