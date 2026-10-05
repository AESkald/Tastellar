use super::fit_and_reconcile;
use crate::{now_nanos, now_rfc3339, Storage, StorageError};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::json;
use tastellar_domain::RankingState;

struct JudgmentToRetract {
    score: i32,
    session_id: String,
    left_id: String,
    right_id: String,
    answer: String,
    retracted: bool,
}

struct BoundaryUnlockChange {
    boundary_id: String,
    protected: bool,
    legacy_unlock: bool,
    removed_unlock: bool,
    remaining_unlocks: i64,
}

impl Storage {
    /// Retract a saved duel answer while retaining it in the audit history.
    pub fn retract_duel_judgment(
        &mut self,
        expected_revision: i64,
        judgment_id: &str,
    ) -> Result<RankingState, StorageError> {
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_revision)?;
        let judgment: Option<JudgmentToRetract> = tx
            .query_row(
                "SELECT score,session_id,left_id,right_id,answer,retracted FROM ranking_judgment WHERE id=?1",
                [judgment_id],
                |row| {
                    Ok(JudgmentToRetract {
                        score: row.get(0)?,
                        session_id: row.get(1)?,
                        left_id: row.get(2)?,
                        right_id: row.get(3)?,
                        answer: row.get(4)?,
                        retracted: row.get(5)?,
                    })
                },
            )
            .optional()?;
        let judgment = judgment.ok_or_else(|| {
            StorageError::Validation("Duel answer is unavailable or already retracted".into())
        })?;
        if judgment.retracted {
            return Err(StorageError::Validation(
                "Duel answer is unavailable or already retracted".into(),
            ));
        }
        tx.execute(
            "UPDATE ranking_judgment SET retracted=1 WHERE id=?1 AND retracted=0",
            [judgment_id],
        )?;

        let boundary_unlock_change = if judgment.answer == "skip" {
            None
        } else {
            remove_retracted_boundary_unlock(
                &tx,
                judgment.score,
                &judgment.left_id,
                &judgment.right_id,
                judgment_id,
            )?
        };

        let now = now_rfc3339();
        if judgment.answer != "skip" {
            tx.execute(
                "UPDATE ranking_tier_state SET input_sequence=input_sequence+1,pending_reconcile=1 WHERE score=?1",
                [judgment.score],
            )?;
            let _ = fit_and_reconcile(&tx, judgment.score);
        }

        let resulting_order = load_placed_order(&tx, judgment.score)?;
        if let Some(change) = &boundary_unlock_change {
            if change.removed_unlock {
                tx.execute(
                    "INSERT INTO ranking_order_event(id,score,kind,payload_json,occurred_at) VALUES(?1,?2,'boundary_unlock_retracted',?3,?4)",
                    params![
                        format!("order-retraction-{}", now_nanos()),
                        judgment.score,
                        json!({
                            "boundaryId": change.boundary_id,
                            "judgmentId": judgment_id,
                            "protected": change.protected,
                            "legacyUnlock": change.legacy_unlock,
                            "remainingUnlocks": change.remaining_unlocks,
                        }).to_string(),
                        now_rfc3339(),
                    ],
                )?;
            }
        }
        tx.execute(
            "INSERT INTO ranking_order_event(id,score,kind,payload_json,occurred_at) VALUES(?1,?2,'judgment_retracted',?3,?4)",
            params![
                format!("retraction-{}", now_nanos()),
                judgment.score,
                json!({
                    "judgmentId": judgment_id,
                    "sessionId": judgment.session_id,
                    "answer": judgment.answer,
                    "boundary": boundary_unlock_change.map(|boundary| json!({
                        "boundaryId": boundary.boundary_id,
                        "protected": boundary.protected,
                        "legacyUnlock": boundary.legacy_unlock,
                        "removedUnlock": boundary.removed_unlock,
                        "remainingUnlocks": boundary.remaining_unlocks,
                    })),
                    "placedOrder": resulting_order,
                })
                .to_string(),
                now,
            ],
        )?;
        tx.execute("UPDATE metadata SET version=version+1 WHERE id=1", [])?;
        tx.commit()?;
        self.load_ranking()
    }
}

fn remove_retracted_boundary_unlock(
    tx: &Transaction<'_>,
    score: i32,
    left_id: &str,
    right_id: &str,
    judgment_id: &str,
) -> Result<Option<BoundaryUnlockChange>, StorageError> {
    let (first_id, second_id) = if left_id < right_id {
        (left_id, right_id)
    } else {
        (right_id, left_id)
    };
    let boundary: Option<(String, bool)> = tx
        .query_row(
            "SELECT id,legacy_unlock FROM ranking_boundary WHERE score=?1 AND first_id=?2 AND second_id=?3",
            params![score, first_id, second_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((boundary_id, legacy_unlock)) = boundary else {
        return Ok(None);
    };
    let removed_unlock = tx.execute(
        "DELETE FROM ranking_boundary_unlock WHERE boundary_id=?1 AND judgment_id=?2",
        params![boundary_id, judgment_id],
    )? > 0;
    let remaining_unlocks: i64 = tx.query_row(
        "SELECT COUNT(*) FROM ranking_boundary_unlock WHERE boundary_id=?1",
        [&boundary_id],
        |row| row.get(0),
    )?;
    let protected = !legacy_unlock && remaining_unlocks == 0;
    tx.execute(
        "UPDATE ranking_boundary SET protected=?1 WHERE id=?2",
        params![protected, boundary_id],
    )?;
    Ok(Some(BoundaryUnlockChange {
        boundary_id,
        protected,
        legacy_unlock,
        removed_unlock,
        remaining_unlocks,
    }))
}

fn load_placed_order(tx: &Transaction<'_>, score: i32) -> Result<Vec<String>, StorageError> {
    let mut statement = tx.prepare(
        "SELECT re.entry_id FROM ranking_entry re JOIN entry e ON e.id=re.entry_id JOIN group_order go ON go.entry_id=re.entry_id WHERE re.score=?1 AND re.placed=1 AND e.trashed_at IS NULL ORDER BY go.order_key COLLATE BINARY,re.entry_id COLLATE BINARY",
    )?;
    let ids = statement
        .query_map([score], |row| row.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::super::RankingArchive;
    use super::*;
    use std::{
        collections::BTreeMap,
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };
    use tastellar_domain::{DuelAnswer, EntryInput, RankingPosition};

    fn test_root() -> PathBuf {
        static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "tastellar-ranking-retraction-{}-{}-{}",
            std::process::id(),
            now_nanos(),
            NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn scored_entry(id: &str, title: &str) -> EntryInput {
        EntryInput {
            id: id.into(),
            title: title.into(),
            disposition: "experienced".into(),
            media_type_id: None,
            overall_rating: Some(8),
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

    fn fit_parameters(storage: &Storage) -> (String, Vec<(String, String, f64)>) {
        let (means, covariance): (String, String) = storage
            .conn
            .query_row(
                "SELECT means_json,covariance_json FROM ranking_fit WHERE score=8",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let mut covariance: Vec<(String, String, f64)> = serde_json::from_str(&covariance).unwrap();
        for (first, second, _) in &mut covariance {
            if first > second {
                std::mem::swap(first, second);
            }
        }
        covariance.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
        (means, covariance)
    }

    fn assert_archive_rejected(storage: &mut Storage, archive: &RankingArchive) {
        let tx = storage.conn.transaction().unwrap();
        let result = Storage::import_ranking_archive(&tx, Some(archive));
        assert!(matches!(result, Err(StorageError::Validation(_))));
        drop(tx);
    }

    #[test]
    fn retracting_judgment_removes_likelihood_and_recovers_after_reopen() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let mut storage = Storage::open(&root).unwrap();
        for (id, title) in [("work-a", "Work A"), ("work-b", "Work B")] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .save_entry(revision, scored_entry(id, title))
                .unwrap();
        }
        for id in ["work-a", "work-b"] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .move_ranking_entry(
                    revision,
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
        let baseline_fit = fit_parameters(&storage);
        let revision = storage.load_library().unwrap().revision;
        let session = storage
            .start_duel_session(revision, 8, Vec::new(), None, "normal".into())
            .unwrap();
        let prompt = storage.next_duel(&session.id, false).unwrap().unwrap();
        let answer = if prompt.left_entry_id == "work-b" {
            DuelAnswer::LeftWin
        } else {
            DuelAnswer::RightWin
        };
        let revision = storage.load_library().unwrap().revision;
        let answered = storage
            .answer_duel(revision, &session.id, &prompt.duel_id, answer)
            .unwrap();
        let order_before_retraction = answered
            .tiers
            .iter()
            .find(|tier| tier.score == 8)
            .unwrap()
            .placed_ids
            .clone();
        let judgment_id: String = storage
            .conn
            .query_row(
                "SELECT id FROM ranking_judgment WHERE session_id=?1",
                [&session.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_ne!(fit_parameters(&storage), baseline_fit);
        let unlocked: bool = storage
            .conn
            .query_row(
                "SELECT protected FROM ranking_boundary WHERE score=8 AND first_id='work-a' AND second_id='work-b'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            !unlocked,
            "an opposing direct win releases the manual boundary"
        );
        let unlock_rows: i64 = storage
            .conn
            .query_row("SELECT COUNT(*) FROM ranking_boundary_unlock", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(unlock_rows, 1);

        let revision = storage.load_library().unwrap().revision;
        let ranking = storage
            .retract_duel_judgment(revision, &judgment_id)
            .unwrap();
        assert_eq!(fit_parameters(&storage), baseline_fit);
        let (answer_text, retracted): (String, bool) = storage
            .conn
            .query_row(
                "SELECT answer,retracted FROM ranking_judgment WHERE id=?1",
                [&judgment_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(answer_text, "rightWin");
        assert!(retracted);
        let (first_id, second_id, preferred_id, protected): (String, String, String, bool) = storage
            .conn
            .query_row(
                "SELECT first_id,second_id,preferred_id,protected FROM ranking_boundary WHERE score=8 AND ((first_id='work-a' AND second_id='work-b') OR (first_id='work-b' AND second_id='work-a'))",
                [],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
            )
            .unwrap();
        let mut canonical_ids = [first_id.as_str(), second_id.as_str()];
        canonical_ids.sort_unstable();
        assert_eq!(canonical_ids, ["work-a", "work-b"]);
        assert_eq!(preferred_id, "work-a");
        assert!(
            protected,
            "retracting the only opposing win restores the lock"
        );
        let unlock_rows: i64 = storage
            .conn
            .query_row("SELECT COUNT(*) FROM ranking_boundary_unlock", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(unlock_rows, 0);
        assert_eq!(
            ranking
                .tiers
                .iter()
                .find(|tier| tier.score == 8)
                .unwrap()
                .placed_ids,
            order_before_retraction
        );
        let retraction_events: i64 = storage
            .conn
            .query_row(
                "SELECT COUNT(*) FROM ranking_order_event WHERE score=8 AND kind='judgment_retracted'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retraction_events, 1);

        storage
            .conn
            .execute("DELETE FROM ranking_fit WHERE score=8", [])
            .unwrap();
        drop(storage);
        let mut reopened = Storage::open(&root).unwrap();
        assert_eq!(fit_parameters(&reopened), baseline_fit);
        let recovered = reopened.load_ranking().unwrap();
        assert_eq!(
            recovered
                .tiers
                .iter()
                .find(|tier| tier.score == 8)
                .unwrap()
                .placed_ids,
            order_before_retraction
        );
        assert!(matches!(
            reopened.retract_duel_judgment(recovered.revision, &judgment_id),
            Err(StorageError::Validation(_))
        ));
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preexisting_opposing_win_does_not_unlock_a_later_manual_boundary_on_tie_retraction() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let mut storage = Storage::open(&root).unwrap();
        for (id, title) in [("old-a", "Old A"), ("old-b", "Old B")] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .save_entry(revision, scored_entry(id, title))
                .unwrap();
        }
        for id in ["old-a", "old-b"] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .move_ranking_entry(
                    revision,
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
        // Simulate an already-placed legacy pair with no manual constraint.
        storage
            .conn
            .execute(
                "DELETE FROM ranking_boundary WHERE first_id='old-a' AND second_id='old-b'",
                [],
            )
            .unwrap();
        let revision = storage.load_library().unwrap().revision;
        let first_session = storage
            .start_duel_session(revision, 8, Vec::new(), None, "normal".into())
            .unwrap();
        let first_prompt = storage
            .next_duel(&first_session.id, false)
            .unwrap()
            .unwrap();
        let old_opposing_answer = if first_prompt.left_entry_id == "old-b" {
            DuelAnswer::LeftWin
        } else {
            DuelAnswer::RightWin
        };
        let state = storage
            .answer_duel(
                storage.load_library().unwrap().revision,
                &first_session.id,
                &first_prompt.duel_id,
                old_opposing_answer,
            )
            .unwrap();
        let old_judgment: String = storage
            .conn
            .query_row(
                "SELECT id FROM ranking_judgment WHERE session_id=?1",
                [&first_session.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            storage
                .conn
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM ranking_boundary_unlock", [], |row| {
                    row.get(0)
                })
                .unwrap(),
            0
        );

        storage.end_duel_session(&first_session.id).unwrap();
        let revision = state.revision;
        storage
            .move_ranking_entry(
                revision,
                "old-a",
                8,
                true,
                RankingPosition {
                    kind: "before".into(),
                    anchor_id: Some("old-b".into()),
                },
            )
            .unwrap();
        let boundary:(bool,bool)=storage.conn.query_row("SELECT protected,legacy_unlock FROM ranking_boundary WHERE score=8 AND first_id='old-a' AND second_id='old-b'",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(boundary, (true, false));
        assert_eq!(
            storage
                .conn
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM ranking_boundary_unlock", [], |row| {
                    row.get(0)
                })
                .unwrap(),
            0
        );

        let revision = storage.load_library().unwrap().revision;
        let tie_session = storage
            .start_duel_session(revision, 8, Vec::new(), None, "normal".into())
            .unwrap();
        let tie_prompt = storage.next_duel(&tie_session.id, true).unwrap().unwrap();
        let tied_state = storage
            .answer_duel(
                storage.load_library().unwrap().revision,
                &tie_session.id,
                &tie_prompt.duel_id,
                DuelAnswer::Tie,
            )
            .unwrap();
        let tie_judgment: String = storage
            .conn
            .query_row(
                "SELECT id FROM ranking_judgment WHERE session_id=?1",
                [&tie_session.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_ne!(old_judgment, tie_judgment);
        storage
            .retract_duel_judgment(tied_state.revision, &tie_judgment)
            .unwrap();

        let (protected,legacy_unlock):(bool,bool)=storage.conn.query_row("SELECT protected,legacy_unlock FROM ranking_boundary WHERE score=8 AND first_id='old-a' AND second_id='old-b'",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert!(
            protected,
            "an opposing win from before the manual boundary must not release it"
        );
        assert!(!legacy_unlock);
        assert_eq!(
            storage
                .conn
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM ranking_boundary_unlock", [], |row| {
                    row.get(0)
                })
                .unwrap(),
            0
        );
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn boundary_relocks_only_after_every_post_boundary_opposing_win_is_retracted() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let mut storage = Storage::open(&root).unwrap();
        for (id, title) in [("multi-a", "Multi A"), ("multi-b", "Multi B")] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .save_entry(revision, scored_entry(id, title))
                .unwrap();
        }
        for id in ["multi-a", "multi-b"] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .move_ranking_entry(
                    revision,
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
        let revision = storage.load_library().unwrap().revision;
        storage
            .move_ranking_entry(
                revision,
                "multi-a",
                8,
                true,
                RankingPosition {
                    kind: "before".into(),
                    anchor_id: Some("multi-b".into()),
                },
            )
            .unwrap();

        let mut opposing_judgments = Vec::new();
        for _ in 0..2 {
            let revision = storage.load_library().unwrap().revision;
            let session = storage
                .start_duel_session(revision, 8, Vec::new(), None, "normal".into())
                .unwrap();
            let prompt = storage.next_duel(&session.id, true).unwrap().unwrap();
            let answer = if prompt.left_entry_id == "multi-b" {
                DuelAnswer::LeftWin
            } else {
                DuelAnswer::RightWin
            };
            let state = storage
                .answer_duel(
                    storage.load_library().unwrap().revision,
                    &session.id,
                    &prompt.duel_id,
                    answer,
                )
                .unwrap();
            let judgment_id = storage
                .conn
                .query_row(
                    "SELECT id FROM ranking_judgment WHERE session_id=?1",
                    [&session.id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap();
            opposing_judgments.push(judgment_id);
            storage.end_duel_session(&session.id).unwrap();
            assert!(state.revision > 0);
        }

        let unlock_count: i64 = storage
            .conn
            .query_row("SELECT COUNT(*) FROM ranking_boundary_unlock", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(unlock_count, 2);
        let revision = storage.load_library().unwrap().revision;
        storage
            .retract_duel_judgment(revision, &opposing_judgments[0])
            .unwrap();
        let (protected, remaining): (bool, i64) = storage
            .conn
            .query_row(
                "SELECT b.protected,(SELECT COUNT(*) FROM ranking_boundary_unlock u WHERE u.boundary_id=b.id) FROM ranking_boundary b WHERE b.score=8 AND b.first_id='multi-a' AND b.second_id='multi-b'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(!protected, "one remaining opposing win keeps it unlocked");
        assert_eq!(remaining, 1);

        let revision = storage.load_library().unwrap().revision;
        storage
            .retract_duel_judgment(revision, &opposing_judgments[1])
            .unwrap();
        let (protected, remaining): (bool, i64) = storage
            .conn
            .query_row(
                "SELECT b.protected,(SELECT COUNT(*) FROM ranking_boundary_unlock u WHERE u.boundary_id=b.id) FROM ranking_boundary b WHERE b.score=8 AND b.first_id='multi-a' AND b.second_id='multi-b'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(
            protected,
            "retracting the final unlock re-locks the boundary"
        );
        assert_eq!(remaining, 0);

        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retracting_skip_preserves_history_without_dirtying_the_tier() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let mut storage = Storage::open(&root).unwrap();
        for (id, title) in [("skip-a", "Skip A"), ("skip-b", "Skip B")] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .save_entry(revision, scored_entry(id, title))
                .unwrap();
        }
        for id in ["skip-a", "skip-b"] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .move_ranking_entry(
                    revision,
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
        let revision = storage.load_library().unwrap().revision;
        let session = storage
            .start_duel_session(revision, 8, Vec::new(), None, "normal".into())
            .unwrap();
        let prompt = storage.next_duel(&session.id, false).unwrap().unwrap();
        let revision = storage.load_library().unwrap().revision;
        storage
            .answer_duel(revision, &session.id, &prompt.duel_id, DuelAnswer::Skip)
            .unwrap();
        let judgment_id: String = storage
            .conn
            .query_row(
                "SELECT id FROM ranking_judgment WHERE session_id=?1",
                [&session.id],
                |row| row.get(0),
            )
            .unwrap();
        let before: (i64, bool) = storage
            .conn
            .query_row(
                "SELECT input_sequence,pending_reconcile FROM ranking_tier_state WHERE score=8",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let revision = storage.load_library().unwrap().revision;
        storage
            .retract_duel_judgment(revision, &judgment_id)
            .unwrap();
        let after: (i64, bool) = storage
            .conn
            .query_row(
                "SELECT input_sequence,pending_reconcile FROM ranking_tier_state WHERE score=8",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(after, before);
        let (answer, retracted): (String, bool) = storage
            .conn
            .query_row(
                "SELECT answer,retracted FROM ranking_judgment WHERE id=?1",
                [&judgment_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(answer, "skip");
        assert!(retracted);
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn v6_migration_marks_unlocked_boundaries_as_legacy_without_fabricating_unlocks() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let mut storage = Storage::open(&root).unwrap();
        for (id, title) in [("legacy-a", "Legacy A"), ("legacy-b", "Legacy B")] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .save_entry(revision, scored_entry(id, title))
                .unwrap();
        }
        for id in ["legacy-a", "legacy-b"] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .move_ranking_entry(
                    revision,
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
        storage.conn.execute("UPDATE ranking_boundary SET protected=0 WHERE score=8 AND first_id='legacy-a' AND second_id='legacy-b'",[]).unwrap();
        storage.conn.execute_batch("DROP TABLE ranking_boundary_unlock; ALTER TABLE ranking_boundary DROP COLUMN created_sequence; ALTER TABLE ranking_boundary DROP COLUMN legacy_unlock; ALTER TABLE ranking_judgment DROP COLUMN input_sequence; ALTER TABLE ranking_session DROP COLUMN explicit_subset; PRAGMA user_version=6;").unwrap();
        drop(storage);

        let migrated = Storage::open(&root).unwrap();
        let (protected,legacy_unlock):(bool,bool)=migrated.conn.query_row("SELECT protected,legacy_unlock FROM ranking_boundary WHERE score=8 AND first_id='legacy-a' AND second_id='legacy-b'",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert!(
            !protected,
            "the migration preserves the old unlocked display state"
        );
        assert!(
            legacy_unlock,
            "unknown v6 unlock provenance is marked rather than inferred"
        );
        assert_eq!(
            migrated
                .conn
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM ranking_boundary_unlock", [], |row| {
                    row.get(0)
                })
                .unwrap(),
            0
        );
        drop(migrated);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn v7_migration_preserves_unlocked_state_but_discards_unsequenced_provenance() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let mut storage = Storage::open(&root).unwrap();
        for (id, title) in [("v7-a", "V7 A"), ("v7-b", "V7 B")] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .save_entry(revision, scored_entry(id, title))
                .unwrap();
        }
        for id in ["v7-a", "v7-b"] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .move_ranking_entry(
                    revision,
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
        let revision = storage.load_library().unwrap().revision;
        let session = storage
            .start_duel_session(revision, 8, Vec::new(), None, "normal".into())
            .unwrap();
        let prompt = storage.next_duel(&session.id, false).unwrap().unwrap();
        let answer = if prompt.left_entry_id == "v7-b" {
            DuelAnswer::LeftWin
        } else {
            DuelAnswer::RightWin
        };
        let revision = storage.load_library().unwrap().revision;
        storage
            .answer_duel(revision, &session.id, &prompt.duel_id, answer)
            .unwrap();
        storage.end_duel_session(&session.id).unwrap();
        let sequence: i64 = storage
            .conn
            .query_row(
                "SELECT input_sequence FROM ranking_tier_state WHERE score=8",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            storage
                .conn
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM ranking_boundary_unlock", [], |row| {
                    row.get(0)
                })
                .unwrap(),
            1
        );

        storage
            .conn
            .execute_batch(
                "ALTER TABLE ranking_boundary DROP COLUMN created_sequence; ALTER TABLE ranking_judgment DROP COLUMN input_sequence; ALTER TABLE ranking_session DROP COLUMN explicit_subset; PRAGMA user_version=7;",
            )
            .unwrap();
        drop(storage);

        let migrated = Storage::open(&root).unwrap();
        let (protected, legacy, created_sequence): (bool, bool, i64) = migrated
            .conn
            .query_row(
                "SELECT protected,legacy_unlock,created_sequence FROM ranking_boundary WHERE score=8 AND first_id='v7-a' AND second_id='v7-b'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert!(!protected);
        assert!(legacy);
        assert_eq!(created_sequence, sequence);
        assert_eq!(
            migrated
                .conn
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM ranking_boundary_unlock", [], |row| {
                    row.get(0)
                })
                .unwrap(),
            0
        );
        assert_eq!(
            migrated
                .conn
                .query_row::<i64, _, _>(
                    "SELECT input_sequence FROM ranking_judgment WHERE session_id=?1",
                    [&session.id],
                    |row| row.get(0)
                )
                .unwrap(),
            0
        );
        drop(migrated);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn archive_v3_rejects_unproven_unlocks_and_stale_binary_sessions() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let mut storage = Storage::open(&root).unwrap();
        for (id, title) in [
            ("archive-a", "Archive A"),
            ("archive-b", "Archive B"),
            ("archive-c", "Archive C"),
            ("archive-d", "Archive D"),
        ] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .save_entry(revision, scored_entry(id, title))
                .unwrap();
        }
        let (literature_type, anime_type): (String, String) = storage
            .conn
            .query_row(
                "SELECT id,(SELECT id FROM media_type WHERE id='anime') FROM media_type WHERE id='literature'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        for (id, media_type_id) in [
            ("archive-a", &literature_type),
            ("archive-b", &literature_type),
            ("archive-c", &anime_type),
            ("archive-d", &literature_type),
        ] {
            storage
                .conn
                .execute(
                    "UPDATE entry SET media_type_id=?1 WHERE id=?2",
                    rusqlite::params![media_type_id, id],
                )
                .unwrap();
        }
        for id in ["archive-a", "archive-b"] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .move_ranking_entry(
                    revision,
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
        let revision = storage.load_library().unwrap().revision;
        storage
            .move_ranking_entry(
                revision,
                "archive-c",
                8,
                true,
                RankingPosition {
                    kind: "end".into(),
                    anchor_id: None,
                },
            )
            .unwrap();

        // Remove the original factor to create an opposing judgment before a
        // later manual boundary, then verify an archive cannot claim it unlocked
        // that newer boundary.
        storage
            .conn
            .execute(
                "DELETE FROM ranking_boundary WHERE first_id='archive-a' AND second_id='archive-b'",
                [],
            )
            .unwrap();
        let revision = storage.load_library().unwrap().revision;
        let old_session = storage
            .start_duel_session(revision, 8, Vec::new(), None, "normal".into())
            .unwrap();
        let old_prompt = storage.next_duel(&old_session.id, false).unwrap().unwrap();
        let old_answer = if old_prompt.left_entry_id == "archive-b" {
            DuelAnswer::LeftWin
        } else {
            DuelAnswer::RightWin
        };
        let revision = storage.load_library().unwrap().revision;
        storage
            .answer_duel(revision, &old_session.id, &old_prompt.duel_id, old_answer)
            .unwrap();
        let old_judgment_id: String = storage
            .conn
            .query_row(
                "SELECT id FROM ranking_judgment WHERE session_id=?1",
                [&old_session.id],
                |row| row.get(0),
            )
            .unwrap();
        storage.end_duel_session(&old_session.id).unwrap();
        let revision = storage.load_library().unwrap().revision;
        storage
            .move_ranking_entry(
                revision,
                "archive-a",
                8,
                true,
                RankingPosition {
                    kind: "before".into(),
                    anchor_id: Some("archive-b".into()),
                },
            )
            .unwrap();

        let valid_archive = storage.export_ranking_archive().unwrap();
        let boundary_index = valid_archive
            .boundaries
            .iter()
            .position(|boundary| {
                boundary.first_id == "archive-a" && boundary.second_id == "archive-b"
            })
            .unwrap();
        let mut no_provenance = valid_archive.clone();
        no_provenance.boundaries[boundary_index].protected = false;
        no_provenance.boundaries[boundary_index].legacy_unlock = false;
        no_provenance.boundaries[boundary_index]
            .unlock_judgment_ids
            .clear();
        assert_archive_rejected(&mut storage, &no_provenance);

        let mut pre_boundary_win = valid_archive.clone();
        pre_boundary_win.boundaries[boundary_index].protected = false;
        pre_boundary_win.boundaries[boundary_index].legacy_unlock = false;
        pre_boundary_win.boundaries[boundary_index].unlock_judgment_ids =
            vec![old_judgment_id.clone()];
        assert!(pre_boundary_win.judgments.iter().any(|judgment| {
            judgment.id == old_judgment_id
                && judgment.input_sequence
                    <= pre_boundary_win.boundaries[boundary_index].created_sequence
        }));
        assert_archive_rejected(&mut storage, &pre_boundary_win);

        let revision = storage.load_library().unwrap().revision;
        storage
            .start_duel_session(
                revision,
                8,
                Vec::new(),
                Some("archive-d".into()),
                "binary".into(),
            )
            .unwrap();
        let binary_archive = storage.export_ranking_archive().unwrap();
        let session_index = binary_archive
            .sessions
            .iter()
            .position(|session| session.status == "active")
            .unwrap();

        let mut wrong_candidate = binary_archive.clone();
        wrong_candidate.sessions[session_index].candidate_id = Some("archive-a".into());
        assert_archive_rejected(&mut storage, &wrong_candidate);

        let mut pending_placement = binary_archive.clone();
        pending_placement
            .tiers
            .iter_mut()
            .find(|tier| tier.score == 8)
            .unwrap()
            .pending_reconcile = true;
        assert_archive_rejected(&mut storage, &pending_placement);

        let mut wrong_snapshot = binary_archive.clone();
        wrong_snapshot.sessions[session_index].snapshot_order_json = "[]".into();
        assert_archive_rejected(&mut storage, &wrong_snapshot);

        let mut invalid_bounds = binary_archive;
        let snapshot: Vec<String> =
            serde_json::from_str(&invalid_bounds.sessions[session_index].snapshot_order_json)
                .unwrap();
        invalid_bounds.sessions[session_index].high_bound = snapshot.len() as i64 + 1;
        assert_archive_rejected(&mut storage, &invalid_bounds);

        let active_id: String = storage
            .conn
            .query_row(
                "SELECT id FROM ranking_session WHERE status='active'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        storage.end_duel_session(&active_id).unwrap();
        let revision = storage.load_library().unwrap().revision;
        let mut moved_candidate = scored_entry("archive-d", "Archive D");
        moved_candidate.overall_rating = Some(9);
        storage.save_entry(revision, moved_candidate).unwrap();
        let revision = storage.load_library().unwrap().revision;
        storage
            .start_duel_session(revision, 8, vec![literature_type], None, "normal".into())
            .unwrap();
        let mut legacy_archive = storage.export_ranking_archive().unwrap();
        legacy_archive.schema_version = 2;
        let mut old_full_order: Vec<String> = storage
            .load_ranking()
            .unwrap()
            .tiers
            .into_iter()
            .find(|tier| tier.score == 8)
            .unwrap()
            .placed_ids;
        old_full_order.reverse();
        let active_legacy = legacy_archive
            .sessions
            .iter_mut()
            .find(|session| session.status == "active")
            .unwrap();
        active_legacy.snapshot_order_json = serde_json::to_string(&old_full_order).unwrap();
        let legacy_boundary = legacy_archive
            .boundaries
            .iter_mut()
            .find(|boundary| boundary.first_id == "archive-a" && boundary.second_id == "archive-b")
            .unwrap();
        legacy_boundary.protected = false;
        legacy_boundary.legacy_unlock = false;
        legacy_boundary.unlock_judgment_ids = vec![old_judgment_id];
        let tx = storage.conn.transaction().unwrap();
        Storage::import_ranking_archive(&tx, Some(&legacy_archive)).unwrap();
        tx.commit().unwrap();
        let normalized_snapshot: String = storage
            .conn
            .query_row(
                "SELECT snapshot_order_json FROM ranking_session WHERE status='active'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            normalized_snapshot,
            serde_json::to_string(&vec!["archive-b", "archive-a"]).unwrap()
        );
        let (protected, legacy_unlock): (bool, bool) = storage
            .conn
            .query_row(
                "SELECT protected,legacy_unlock FROM ranking_boundary WHERE score=8 AND first_id='archive-a' AND second_id='archive-b'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(!protected);
        assert!(legacy_unlock);
        assert_eq!(
            storage
                .conn
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM ranking_boundary_unlock", [], |row| {
                    row.get(0)
                })
                .unwrap(),
            0
        );

        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn archive_v3_preserves_frozen_normal_participants_after_reorder_and_rejects_too_small_sets() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let mut storage = Storage::open(&root).unwrap();
        for (id, title) in [
            ("frozen-a", "Frozen A"),
            ("frozen-b", "Frozen B"),
            ("frozen-c", "Frozen C"),
        ] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .save_entry(revision, scored_entry(id, title))
                .unwrap();
        }
        for id in ["frozen-a", "frozen-b", "frozen-c"] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .move_ranking_entry(
                    revision,
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
        let revision = storage.load_library().unwrap().revision;
        let session = storage
            .start_duel_session(revision, 8, Vec::new(), None, "normal".into())
            .unwrap();
        let frozen: Vec<String> = serde_json::from_str(
            &storage
                .conn
                .query_row(
                    "SELECT snapshot_order_json FROM ranking_session WHERE id=?1",
                    [&session.id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        let revision = storage.load_library().unwrap().revision;
        storage
            .move_ranking_entry(
                revision,
                &frozen[0],
                8,
                true,
                RankingPosition {
                    kind: "end".into(),
                    anchor_id: None,
                },
            )
            .unwrap();
        let current = storage
            .load_ranking()
            .unwrap()
            .tiers
            .into_iter()
            .find(|tier| tier.score == 8)
            .unwrap()
            .placed_ids;
        assert_ne!(frozen, current);

        let archive = storage.export_ranking_archive().unwrap();
        let active = archive
            .sessions
            .iter()
            .find(|archived| archived.id == session.id)
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Vec<String>>(&active.snapshot_order_json).unwrap(),
            frozen
        );
        let tx = storage.conn.transaction().unwrap();
        Storage::import_ranking_archive(&tx, Some(&archive)).unwrap();
        tx.commit().unwrap();

        let mut too_small = archive.clone();
        let active = too_small
            .sessions
            .iter_mut()
            .find(|session| session.status == "active")
            .unwrap();
        active.snapshot_order_json = serde_json::to_string(&vec![frozen[0].clone()]).unwrap();
        assert_archive_rejected(&mut storage, &too_small);

        storage.end_duel_session(&session.id).unwrap();
        let placed = storage
            .load_ranking()
            .unwrap()
            .tiers
            .into_iter()
            .find(|tier| tier.score == 8)
            .unwrap()
            .placed_ids;
        let revision = storage.load_library().unwrap().revision;
        let subset_session = storage
            .start_duel_session_with_candidates(
                revision,
                8,
                Vec::new(),
                None,
                Some(placed[..2].to_vec()),
                "normal".into(),
            )
            .unwrap();
        let mut subset_archive = storage.export_ranking_archive().unwrap();
        let subset = subset_archive
            .sessions
            .iter_mut()
            .find(|session| session.id == subset_session.id)
            .unwrap();
        assert!(subset.explicit_subset);
        subset.snapshot_order_json = serde_json::to_string(&vec![placed[0].clone()]).unwrap();
        assert_archive_rejected(&mut storage, &subset_archive);

        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_zero_sequence_boundary_round_trips_in_archive_v3() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let mut storage = Storage::open(&root).unwrap();
        for (id, title) in [("zero-a", "Zero A"), ("zero-b", "Zero B")] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .save_entry(revision, scored_entry(id, title))
                .unwrap();
        }
        for id in ["zero-a", "zero-b"] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .move_ranking_entry(
                    revision,
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

        let mut legacy = storage.export_ranking_archive().unwrap();
        assert!(!legacy.boundaries.is_empty());
        legacy.schema_version = 2;
        let tier = legacy
            .tiers
            .iter_mut()
            .find(|tier| tier.score == 8)
            .unwrap();
        tier.input_sequence = 0;
        tier.fitted_sequence = 0;
        tier.pending_reconcile = false;

        let tx = storage.conn.transaction().unwrap();
        Storage::import_ranking_archive(&tx, Some(&legacy)).unwrap();
        tx.commit().unwrap();
        let current = storage.export_ranking_archive().unwrap();
        assert_eq!(current.schema_version, 3);
        assert!(current
            .boundaries
            .iter()
            .filter(|boundary| boundary.score == 8)
            .all(|boundary| boundary.created_sequence == 0));

        let tx = storage.conn.transaction().unwrap();
        Storage::import_ranking_archive(&tx, Some(&current)).unwrap();
        tx.commit().unwrap();

        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }
}
