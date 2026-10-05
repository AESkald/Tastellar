use crate::{now_nanos, now_rfc3339, Storage, StorageError};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::json;
use std::collections::{BTreeMap, HashMap, HashSet};
use tastellar_domain::{BinaryPlacementNextStep, BinaryPlacementResult};

pub(crate) const ORDER_KEY_ALGORITHM_VERSION: i64 = 2;
const ORDER_KEY_ALPHABET: &[u8; 62] =
    b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ORDER_KEY_WIDTH: usize = 16;
const MAX_ORDER_KEY_LENGTH: usize = 64;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RankingArchive {
    pub schema_version: i64,
    #[serde(default = "current_order_key_algorithm_version")]
    pub order_key_algorithm_version: i64,
    pub tiers: Vec<RankingTierArchive>,
    pub entries: Vec<RankingEntryArchive>,
    pub sessions: Vec<RankingSessionArchive>,
    pub judgments: Vec<RankingJudgmentArchive>,
    pub boundaries: Vec<RankingBoundaryArchive>,
    pub order_events: Vec<RankingOrderEventArchive>,
}

fn current_order_key_algorithm_version() -> i64 {
    1
}

fn order_key_digit(value: u8) -> char {
    ORDER_KEY_ALPHABET[value as usize] as char
}

fn order_key_digit_value(value: u8) -> Option<u8> {
    ORDER_KEY_ALPHABET
        .iter()
        .position(|candidate| *candidate == value)
        .map(|index| index as u8)
}

/// Returns a BINARY-collated key strictly between its bounds when one is
/// representable. A caller rebalances the group when a prefix edge has no gap.
fn fractional_order_key(previous: Option<&str>, next: Option<&str>) -> Option<String> {
    match (previous, next) {
        (None, None) => Some(order_key_digit(31).to_string()),
        (Some(previous), None) => Some(format!("{previous}{}", order_key_digit(31))),
        (None, Some(next)) => {
            let first = *next.as_bytes().first()?;
            let upper = order_key_digit_value(first)?;
            if upper == 0 {
                return (next.len() > 1).then(|| "0".to_string());
            }
            Some(order_key_digit((upper - 1) / 2).to_string())
        }
        (Some(previous), Some(next)) => {
            if previous >= next {
                return None;
            }
            let common = previous
                .as_bytes()
                .iter()
                .zip(next.as_bytes())
                .take_while(|(a, b)| a == b)
                .count();
            if common == previous.len() {
                let suffix = &next.as_bytes()[common..];
                let first = *suffix.first()?;
                let upper = order_key_digit_value(first)?;
                if upper == 0 {
                    return (suffix.len() > 1).then(|| format!("{previous}0"));
                }
                Some(format!("{previous}{}", order_key_digit((upper - 1) / 2)))
            } else {
                // Since the first differing digit already places `previous`
                // before `next`, any strict extension of previous remains in
                // the open interval.
                Some(format!("{previous}{}", order_key_digit(31)))
            }
        }
    }
}

fn spaced_order_keys(count: usize) -> Result<Vec<String>, StorageError> {
    let capacity = 62u128.pow(ORDER_KEY_WIDTH as u32) - 1;
    let divisor = (count as u128).saturating_add(1);
    let step = capacity / divisor;
    if step == 0 {
        return Err(StorageError::Validation(
            "The tier is too large to assign stable order keys".into(),
        ));
    }
    (0..count)
        .map(|index| {
            let rank = step * (index as u128 + 1);
            let mut remainder = rank;
            let mut encoded = vec![b'0'; ORDER_KEY_WIDTH];
            for slot in (0..ORDER_KEY_WIDTH).rev() {
                encoded[slot] = ORDER_KEY_ALPHABET[(remainder % 62) as usize];
                remainder /= 62;
            }
            String::from_utf8(encoded)
                .map_err(|_| StorageError::Validation("Invalid order key".into()))
        })
        .collect()
}

fn rebalance_group(
    tx: &Transaction<'_>,
    group_id: &str,
    ordered_ids: &[String],
) -> Result<(), StorageError> {
    let keys = spaced_order_keys(ordered_ids.len())?;
    // Move all rows out of the destination's UNIQUE(group_id, order_key)
    // namespace first, so rebalances cannot collide with their old keys.
    for id in ordered_ids {
        tx.execute(
            "UPDATE group_order SET group_id=?1,order_key='V' WHERE entry_id=?2",
            params![format!("__rank-order-tmp__{id}"), id],
        )?;
    }
    for (id, key) in ordered_ids.iter().zip(keys) {
        tx.execute(
            "UPDATE group_order SET group_id=?1,order_key=?2 WHERE entry_id=?3",
            params![group_id, key, id],
        )?;
    }
    Ok(())
}

pub(crate) fn migrate_order_keys(tx: &Transaction<'_>) -> Result<(), StorageError> {
    let mut groups = BTreeMap::<String, Vec<String>>::new();
    {
        let mut statement = tx.prepare("SELECT group_id,entry_id FROM group_order ORDER BY group_id,order_key COLLATE BINARY,entry_id COLLATE BINARY")?;
        for row in statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (group_id, id) = row?;
            groups.entry(group_id).or_default().push(id);
        }
    }
    for (group_id, ids) in groups {
        rebalance_group(tx, &group_id, &ids)?;
    }
    Ok(())
}

pub(crate) fn next_order_key(tx: &Transaction<'_>, group_id: &str) -> Result<String, StorageError> {
    let max: Option<String> = tx.query_row(
        "SELECT MAX(order_key) FROM group_order WHERE group_id=?1",
        [group_id],
        |row| row.get(0),
    )?;
    if let Some(key) =
        fractional_order_key(max.as_deref(), None).filter(|key| key.len() <= MAX_ORDER_KEY_LENGTH)
    {
        return Ok(key);
    }
    let mut ids = Vec::new();
    {
        let mut statement = tx.prepare("SELECT entry_id FROM group_order WHERE group_id=?1 ORDER BY order_key COLLATE BINARY,entry_id COLLATE BINARY")?;
        for row in statement.query_map([group_id], |row| row.get::<_, String>(0))? {
            ids.push(row?);
        }
    }
    rebalance_group(tx, group_id, &ids)?;
    let max: Option<String> = tx.query_row(
        "SELECT MAX(order_key) FROM group_order WHERE group_id=?1",
        [group_id],
        |row| row.get(0),
    )?;
    fractional_order_key(max.as_deref(), None)
        .ok_or_else(|| StorageError::Validation("Unable to allocate an order key".into()))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RankingTierArchive {
    pub score: i32,
    pub input_sequence: i64,
    pub fitted_sequence: i64,
    pub pending_reconcile: bool,
    pub order_revision: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RankingEntryArchive {
    pub entry_id: String,
    pub score: i32,
    pub placed: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RankingSessionArchive {
    pub id: String,
    pub score: i32,
    pub status: String,
    pub mode: String,
    pub intent: String,
    pub filter_json: String,
    pub seed: i64,
    pub snapshot_order_json: String,
    #[serde(default)]
    pub explicit_subset: bool,
    pub snapshot_order_revision: i64,
    pub candidate_id: Option<String>,
    pub low_bound: i64,
    pub high_bound: i64,
    pub current_pivot_id: Option<String>,
    pub answered_count: i64,
    pub presented_duel_id: Option<String>,
    pub presented_left_id: Option<String>,
    pub presented_right_id: Option<String>,
    pub presented_step: Option<i32>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RankingJudgmentArchive {
    pub id: String,
    pub session_id: String,
    pub score: i32,
    pub duel_id: String,
    pub kind: String,
    pub left_id: String,
    pub right_id: String,
    pub answer: String,
    pub retracted: bool,
    pub occurred_at: String,
    #[serde(default)]
    pub input_sequence: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RankingBoundaryArchive {
    pub id: String,
    pub score: i32,
    pub first_id: String,
    pub second_id: String,
    pub preferred_id: String,
    pub weight: f64,
    pub protected: bool,
    #[serde(default)]
    pub created_sequence: i64,
    #[serde(default)]
    pub legacy_unlock: bool,
    #[serde(default)]
    pub unlock_judgment_ids: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RankingOrderEventArchive {
    pub id: String,
    pub score: i32,
    pub kind: String,
    pub payload_json: String,
    pub occurred_at: String,
}
use tastellar_domain::{
    DuelAnswer, DuelPrompt, DuelSession, LibraryState, RankingPosition, RankingState,
    RankingTierState,
};

mod retraction;

impl Storage {
    pub fn latest_retractable_judgment_id(
        &self,
        session_id: &str,
    ) -> Result<Option<String>, StorageError> {
        self.conn.query_row(
            "SELECT id FROM ranking_judgment WHERE session_id=?1 AND retracted=0 ORDER BY occurred_at DESC,id DESC LIMIT 1",
            [session_id], |row| row.get(0),
        ).optional().map_err(Into::into)
    }

    pub(crate) fn recover_ranking_state(&mut self) -> Result<(), StorageError> {
        for score in 1..=10 {
            let (input,fitted,pending,order_revision):(i64,i64,bool,i64)=self.conn.query_row(
                "SELECT input_sequence,fitted_sequence,pending_reconcile,order_revision FROM ranking_tier_state WHERE score=?1",
                [score],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
            let cache: Option<(i64, i64)> = self
                .conn
                .query_row(
                    "SELECT input_sequence,model_version FROM ranking_fit WHERE score=?1",
                    [score],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let cache_current =
                cache.is_some_and(|(cache_input, version)| cache_input == input && version == 1);
            if fitted >= input && !pending && cache_current {
                continue;
            }
            let tx = self.conn.transaction()?;
            let attempt = if pending {
                fit_and_reconcile(&tx, score)
            } else {
                fit_without_reconcile(&tx, score)
            };
            match attempt {
                Ok(()) => {
                    let new_order_revision: i64 = tx.query_row(
                        "SELECT order_revision FROM ranking_tier_state WHERE score=?1",
                        [score],
                        |r| r.get(0),
                    )?;
                    if new_order_revision != order_revision {
                        tx.execute("UPDATE metadata SET version=version+1 WHERE id=1", [])?;
                    }
                    tx.commit()?;
                }
                Err(StorageError::Validation(_)) => {
                    drop(tx);
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    pub fn load_ranking(&mut self) -> Result<RankingState, StorageError> {
        self.recover_ranking_state()?;
        let library = self.load_library()?;
        let mut tiers = Vec::with_capacity(10);
        for score in (1..=10).rev() {
            let (input_sequence, fitted_sequence, pending_reconcile): (i64, i64, bool) =
                self.conn.query_row(
                    "SELECT input_sequence,fitted_sequence,pending_reconcile FROM ranking_tier_state WHERE score=?1",
                    [score],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
            let mut placed_ids = Vec::new();
            let mut unplaced_ids = Vec::new();
            let mut stmt = self.conn.prepare(
                "SELECT re.entry_id,re.placed FROM ranking_entry re JOIN entry e ON e.id=re.entry_id JOIN group_order go ON go.entry_id=re.entry_id WHERE re.score=?1 AND e.trashed_at IS NULL ORDER BY re.placed DESC,go.order_key COLLATE BINARY,re.entry_id COLLATE BINARY",
            )?;
            for row in stmt.query_map([score], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
            })? {
                let (id, placed) = row?;
                if placed {
                    placed_ids.push(id);
                } else {
                    unplaced_ids.push(id);
                }
            }
            tiers.push(RankingTierState {
                score,
                placed_ids,
                unplaced_ids,
                input_sequence,
                fitted_sequence,
                pending_reconcile,
            });
        }
        let unscored_ids = library
            .entries
            .iter()
            .filter(|entry| entry.disposition == "experienced" && entry.overall_rating.is_none())
            .map(|entry| entry.id.clone())
            .collect();
        let active_session = self
            .conn
            .query_row(
                "SELECT id,score,status,mode,answered_count,candidate_id,current_pivot_id FROM ranking_session WHERE status='active' LIMIT 1",
                [],
                |row| {
                    Ok(DuelSession {
                        id: row.get(0)?,
                        score: row.get(1)?,
                        status: row.get(2)?,
                        mode: if row.get::<_, Option<String>>(6)?.is_some() { "seed".into() } else { row.get(3)? },
                        answered_count: row.get(4)?,
                        candidate_entry_id: row.get(5)?,
                    })
                },
            )
            .optional()?;
        Ok(RankingState {
            revision: library.revision,
            library,
            unscored_ids,
            tiers,
            active_session,
        })
    }

    pub fn move_ranking_entry(
        &mut self,
        expected_revision: i64,
        entry_id: &str,
        score: i32,
        ranked: bool,
        position: RankingPosition,
    ) -> Result<RankingState, StorageError> {
        if !(1..=10).contains(&score) {
            return Err(StorageError::Validation(
                "Choose a score from 1 to 10".into(),
            ));
        }
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_revision)?;
        let old: Option<(Option<i32>, String)> = tx
            .query_row(
                "SELECT overall_rating,disposition FROM entry WHERE id=?1 AND trashed_at IS NULL",
                [entry_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (old_score, disposition) =
            old.ok_or_else(|| StorageError::Validation("Entry is unavailable".into()))?;
        if disposition != "experienced" {
            return Err(StorageError::Validation(
                "Only experienced media can be ranked".into(),
            ));
        }
        let old_row: Option<(i32, bool)> = tx
            .query_row(
                "SELECT score,placed FROM ranking_entry WHERE entry_id=?1",
                [entry_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let previous_score = old_row.map(|row| row.0).or(old_score);
        let mut affected_scores = vec![score];
        if let Some(previous) = previous_score.filter(|previous| *previous != score) {
            affected_scores.push(previous);
        }
        affected_scores.sort_unstable();
        let mut before_tiers = Vec::new();
        for affected in &affected_scores {
            before_tiers.push(tier_order_snapshot(&tx, *affected)?);
        }
        let previous_group_order: Option<(String, String)> = tx
            .query_row(
                "SELECT group_id,order_key FROM group_order WHERE entry_id=?1",
                [entry_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (previous_group_id, previous_order_key) = previous_group_order.ok_or_else(|| {
            StorageError::Validation("Media is missing its tier order record".into())
        })?;
        let mut prior_boundaries = Vec::new();
        {
            let mut statement=tx.prepare("SELECT id,score,first_id,second_id,preferred_id,weight,protected,legacy_unlock,created_sequence FROM ranking_boundary WHERE first_id=?1 OR second_id=?1 ORDER BY score,first_id,second_id")?;
            let rows = statement
                .query_map([entry_id], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i32>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, f64>(5)?,
                        r.get::<_, bool>(6)?,
                        r.get::<_, bool>(7)?,
                        r.get::<_, i64>(8)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            for (
                id,
                score,
                first_id,
                second_id,
                preferred_id,
                weight,
                protected,
                legacy_unlock,
                created_sequence,
            ) in rows
            {
                let mut unlock_stmt=tx.prepare("SELECT judgment_id FROM ranking_boundary_unlock WHERE boundary_id=?1 ORDER BY judgment_id COLLATE BINARY")?;
                let unlocks = unlock_stmt
                    .query_map([&id], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                prior_boundaries.push(json!({"id":id,"score":score,"firstId":first_id,"secondId":second_id,"preferredId":preferred_id,"weight":weight,"protected":protected,"legacyUnlock":legacy_unlock,"createdSequence":created_sequence,"unlockJudgmentIds":unlocks}));
            }
        }
        let mut placed_ids = tier_ids(&tx, score, true)?
            .into_iter()
            .filter(|id| id != entry_id)
            .collect::<Vec<_>>();
        let mut unplaced_ids = tier_ids(&tx, score, false)?
            .into_iter()
            .filter(|id| id != entry_id)
            .collect::<Vec<_>>();
        let target_ids = if ranked {
            &mut placed_ids
        } else {
            &mut unplaced_ids
        };
        let insert_at = insertion_index(target_ids, &position)?;
        target_ids.insert(insert_at, entry_id.to_string());

        let now = now_rfc3339();
        tx.execute(
            "UPDATE entry SET overall_rating=?1,updated_at=?2,version=version+1 WHERE id=?3",
            params![score, now, entry_id],
        )?;
        tx.execute(
            "INSERT INTO ranking_entry(entry_id,score,placed) VALUES(?1,?2,?3) ON CONFLICT(entry_id) DO UPDATE SET score=excluded.score,placed=excluded.placed",
            params![entry_id, score, ranked],
        )?;
        let mut target_order = placed_ids.clone();
        target_order.extend(unplaced_ids.iter().cloned());
        insert_ordered_entry(&tx, score, &target_order, entry_id)?;
        retire_entry_boundaries(&tx, entry_id)?;
        if ranked {
            add_manual_boundaries(&tx, score, &placed_ids, insert_at, entry_id)?;
        }
        if let Some(previous) = previous_score.filter(|old| *old != score) {
            tx.execute("DELETE FROM ranking_fit WHERE score=?1", [previous])?;
            tx.execute("UPDATE ranking_tier_state SET input_sequence=input_sequence+1,pending_reconcile=0,order_revision=order_revision+1 WHERE score=?1", [previous])?;
        }
        tx.execute("DELETE FROM ranking_fit WHERE score=?1", [score])?;
        tx.execute("UPDATE ranking_tier_state SET input_sequence=input_sequence+1,fitted_sequence=0,pending_reconcile=0,order_revision=order_revision+1 WHERE score=?1", [score])?;
        let mut after_tiers = Vec::new();
        for affected in &affected_scores {
            after_tiers.push(tier_order_snapshot(&tx, *affected)?);
        }
        let event_id = format!("order-{}", now_nanos());
        tx.execute(
            "INSERT INTO ranking_order_event(id,score,kind,payload_json,occurred_at) VALUES(?1,?2,'manual_move',?3,?4)",
            params![event_id, score, json!({"entryId":entry_id,"score":score,"ranked":ranked,"position":position,"previousRating":old_score,"previousPlaced":old_row.map(|row|row.1),"previousDisposition":disposition,"previousGroupId":previous_group_id,"previousOrderKey":previous_order_key,"beforeTiers":before_tiers,"afterTiers":after_tiers,"previousBoundaries":prior_boundaries}).to_string(), now],
        )?;
        let _ = fit_without_reconcile(&tx, score);
        if let Some(previous) = previous_score.filter(|old| *old != score) {
            let _ = fit_without_reconcile(&tx, previous);
        }
        tx.execute("UPDATE metadata SET version=version+1 WHERE id=1", [])?;
        tx.commit()?;
        self.load_ranking()
    }

    pub fn undo_last_ranking_move(
        &mut self,
        expected_revision: i64,
    ) -> Result<RankingState, StorageError> {
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_revision)?;
        let latest:Option<(String,String,i64)>=tx.query_row(
            "SELECT e.id,e.payload_json,e.rowid FROM ranking_order_event e WHERE e.kind='manual_move' AND NOT EXISTS(SELECT 1 FROM ranking_order_event u WHERE u.kind='manual_move_undone' AND json_extract(u.payload_json,'$.originalEventId')=e.id) ORDER BY e.rowid DESC LIMIT 1",
            [],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).optional()?;
        let (event_id, payload, event_rowid) = latest
            .ok_or_else(|| StorageError::Validation("There is no ranking move to undo".into()))?;
        let payload: serde_json::Value = serde_json::from_str(&payload)?;
        let has_intervening_event:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM ranking_order_event WHERE rowid>?1 AND kind NOT IN ('manual_move','manual_move_undone'))",[event_rowid],|row|row.get(0))?;
        if has_intervening_event {
            return Err(StorageError::Conflict);
        }
        let entry_id = payload
            .get("entryId")
            .and_then(|v| v.as_str())
            .ok_or(StorageError::Conflict)?;
        let previous_rating = payload
            .get("previousRating")
            .and_then(|v| v.as_i64())
            .map(|v| v as i32);
        let previous_placed = payload
            .get("previousPlaced")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let previous_group = payload
            .get("previousGroupId")
            .and_then(|v| v.as_str())
            .ok_or(StorageError::Conflict)?;
        let previous_key = payload
            .get("previousOrderKey")
            .and_then(|v| v.as_str())
            .ok_or(StorageError::Conflict)?;
        let before_tiers = payload
            .get("beforeTiers")
            .and_then(|v| v.as_array())
            .ok_or(StorageError::Conflict)?;
        let after_tiers = payload
            .get("afterTiers")
            .and_then(|v| v.as_array())
            .ok_or(StorageError::Conflict)?;
        for snapshot in after_tiers {
            if !tier_snapshot_content_matches(&tx, snapshot)? {
                return Err(StorageError::Conflict);
            }
        }
        let disposition = payload
            .get("previousDisposition")
            .and_then(|v| v.as_str())
            .unwrap_or("experienced");
        let now = now_rfc3339();
        tx.execute("UPDATE entry SET overall_rating=?1,disposition=?2,updated_at=?3,version=version+1 WHERE id=?4 AND trashed_at IS NULL",params![previous_rating,disposition,now,entry_id])?;
        tx.execute(
            "DELETE FROM ranking_boundary WHERE first_id=?1 OR second_id=?1",
            [entry_id],
        )?;
        if let Some(rating) = previous_rating {
            tx.execute("INSERT INTO ranking_entry(entry_id,score,placed) VALUES(?1,?2,?3) ON CONFLICT(entry_id) DO UPDATE SET score=excluded.score,placed=excluded.placed",params![entry_id,rating,previous_placed])?;
            tx.execute(
                "UPDATE group_order SET group_id=?1 WHERE entry_id=?2",
                params![format!("__rank-undo__{entry_id}"), entry_id],
            )?;
        } else {
            let old_key_taken:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM group_order WHERE group_id=?1 AND order_key=?2 AND entry_id<>?3)",params![previous_group,previous_key,entry_id],|row|row.get(0))?;
            if old_key_taken {
                return Err(StorageError::Conflict);
            }
            tx.execute("DELETE FROM ranking_entry WHERE entry_id=?1", [entry_id])?;
            tx.execute(
                "UPDATE group_order SET group_id=?1,order_key=?2 WHERE entry_id=?3",
                params![previous_group, previous_key, entry_id],
            )?;
        }
        for snapshot in before_tiers {
            let score = snapshot
                .get("score")
                .and_then(|v| v.as_i64())
                .ok_or(StorageError::Conflict)? as i32;
            let placed = snapshot
                .get("placedIds")
                .and_then(|v| v.as_array())
                .ok_or(StorageError::Conflict)?
                .iter()
                .map(|v| v.as_str().map(str::to_owned).ok_or(StorageError::Conflict))
                .collect::<Result<Vec<_>, _>>()?;
            let unplaced = snapshot
                .get("unplacedIds")
                .and_then(|v| v.as_array())
                .ok_or(StorageError::Conflict)?
                .iter()
                .map(|v| v.as_str().map(str::to_owned).ok_or(StorageError::Conflict))
                .collect::<Result<Vec<_>, _>>()?;
            // The candidate is already in its restored tier, or in its former
            // non-ranking group, so it cannot collide with these active IDs.
            renumber_tier_groups(&tx, score, &placed, &unplaced)?;
            tx.execute("UPDATE ranking_tier_state SET input_sequence=input_sequence+1,fitted_sequence=0,pending_reconcile=0,order_revision=order_revision+1 WHERE score=?1",[score])?;
            tx.execute("DELETE FROM ranking_fit WHERE score=?1", [score])?;
        }
        if let Some(boundaries) = payload.get("previousBoundaries").and_then(|v| v.as_array()) {
            for boundary in boundaries {
                let boundary_id = boundary["id"].as_str().ok_or(StorageError::Conflict)?;
                tx.execute("INSERT INTO ranking_boundary(id,score,first_id,second_id,preferred_id,weight,protected,legacy_unlock,created_sequence) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![boundary_id,boundary["score"].as_i64().ok_or(StorageError::Conflict)? as i32,boundary["firstId"].as_str().ok_or(StorageError::Conflict)?,boundary["secondId"].as_str().ok_or(StorageError::Conflict)?,boundary["preferredId"].as_str().ok_or(StorageError::Conflict)?,boundary["weight"].as_f64().ok_or(StorageError::Conflict)?,boundary["protected"].as_bool().ok_or(StorageError::Conflict)?,boundary["legacyUnlock"].as_bool().unwrap_or(false),boundary["createdSequence"].as_i64().unwrap_or(0)])?;
                if let Some(unlocks) = boundary["unlockJudgmentIds"].as_array() {
                    for judgment_id in unlocks {
                        let judgment_id = judgment_id.as_str().ok_or(StorageError::Conflict)?;
                        tx.execute("INSERT INTO ranking_boundary_unlock(boundary_id,judgment_id) VALUES(?1,?2)",params![boundary_id,judgment_id])?;
                    }
                }
            }
        }
        for snapshot in before_tiers {
            let score = snapshot["score"].as_i64().ok_or(StorageError::Conflict)? as i32;
            let _ = fit_without_reconcile(&tx, score);
        }
        tx.execute("INSERT INTO ranking_order_event(id,score,kind,payload_json,occurred_at) VALUES(?1,?2,'manual_move_undone',?3,?4)",params![format!("undo-{}",now_nanos()),payload["score"].as_i64().ok_or(StorageError::Conflict)? as i32,json!({"originalEventId":event_id,"entryId":entry_id,"restoredTiers":before_tiers}).to_string(),now])?;
        tx.execute("UPDATE metadata SET version=version+1 WHERE id=1", [])?;
        tx.commit()?;
        self.load_ranking()
    }

    pub fn reset_media_ranking(
        &mut self,
        expected_revision: i64,
    ) -> Result<LibraryState, StorageError> {
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_revision)?;
        tx.execute("DELETE FROM ranking_judgment", [])?;
        tx.execute("DELETE FROM ranking_session", [])?;
        tx.execute("DELETE FROM ranking_boundary", [])?;
        tx.execute("DELETE FROM ranking_order_event", [])?;
        tx.execute("DELETE FROM ranking_fit", [])?;
        tx.execute("UPDATE ranking_entry SET placed=0", [])?;
        // Keep deterministic tray order and its existing BINARY keys.
        tx.execute("UPDATE ranking_tier_state SET input_sequence=input_sequence+1,fitted_sequence=0,pending_reconcile=0,order_revision=order_revision+1", [])?;
        tx.execute("UPDATE metadata SET version=version+1 WHERE id=1", [])?;
        tx.commit()?;
        self.load_library()
    }

    pub(crate) fn export_ranking_archive(&self) -> Result<RankingArchive, StorageError> {
        let mut archive = RankingArchive {
            schema_version: 3,
            order_key_algorithm_version: ORDER_KEY_ALGORITHM_VERSION,
            ..Default::default()
        };
        {
            let mut stmt=self.conn.prepare("SELECT score,input_sequence,fitted_sequence,pending_reconcile,order_revision FROM ranking_tier_state ORDER BY score")?;
            for row in stmt.query_map([], |r| {
                Ok(RankingTierArchive {
                    score: r.get(0)?,
                    input_sequence: r.get(1)?,
                    fitted_sequence: r.get(2)?,
                    pending_reconcile: r.get(3)?,
                    order_revision: r.get(4)?,
                })
            })? {
                archive.tiers.push(row?);
            }
        }
        {
            let mut stmt=self.conn.prepare("SELECT entry_id,score,placed FROM ranking_entry ORDER BY score,entry_id COLLATE BINARY")?;
            for row in stmt.query_map([], |r| {
                Ok(RankingEntryArchive {
                    entry_id: r.get(0)?,
                    score: r.get(1)?,
                    placed: r.get(2)?,
                })
            })? {
                archive.entries.push(row?);
            }
        }
        {
            let mut stmt=self.conn.prepare("SELECT id,score,status,mode,intent,filter_json,seed,snapshot_order_json,explicit_subset,snapshot_order_revision,candidate_id,low_bound,high_bound,current_pivot_id,answered_count,presented_duel_id,presented_left_id,presented_right_id,presented_step,created_at,updated_at FROM ranking_session ORDER BY created_at,id")?;
            for row in stmt.query_map([], |r| {
                Ok(RankingSessionArchive {
                    id: r.get(0)?,
                    score: r.get(1)?,
                    status: r.get(2)?,
                    mode: r.get(3)?,
                    intent: r.get(4)?,
                    filter_json: r.get(5)?,
                    seed: r.get(6)?,
                    snapshot_order_json: r.get(7)?,
                    explicit_subset: r.get(8)?,
                    snapshot_order_revision: r.get(9)?,
                    candidate_id: r.get(10)?,
                    low_bound: r.get(11)?,
                    high_bound: r.get(12)?,
                    current_pivot_id: r.get(13)?,
                    answered_count: r.get(14)?,
                    presented_duel_id: r.get(15)?,
                    presented_left_id: r.get(16)?,
                    presented_right_id: r.get(17)?,
                    presented_step: r.get(18)?,
                    created_at: r.get(19)?,
                    updated_at: r.get(20)?,
                })
            })? {
                archive.sessions.push(row?);
            }
        }
        {
            let mut stmt=self.conn.prepare("SELECT id,session_id,score,duel_id,kind,left_id,right_id,answer,retracted,occurred_at,input_sequence FROM ranking_judgment ORDER BY occurred_at,id")?;
            for row in stmt.query_map([], |r| {
                Ok(RankingJudgmentArchive {
                    id: r.get(0)?,
                    session_id: r.get(1)?,
                    score: r.get(2)?,
                    duel_id: r.get(3)?,
                    kind: r.get(4)?,
                    left_id: r.get(5)?,
                    right_id: r.get(6)?,
                    answer: r.get(7)?,
                    retracted: r.get(8)?,
                    occurred_at: r.get(9)?,
                    input_sequence: r.get(10)?,
                })
            })? {
                archive.judgments.push(row?);
            }
        }
        {
            let mut unlocks = BTreeMap::<String, Vec<String>>::new();
            let mut unlock_stmt=self.conn.prepare("SELECT boundary_id,judgment_id FROM ranking_boundary_unlock ORDER BY boundary_id,judgment_id COLLATE BINARY")?;
            for row in unlock_stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            {
                let (boundary_id, judgment_id) = row?;
                unlocks.entry(boundary_id).or_default().push(judgment_id);
            }
            let mut stmt=self.conn.prepare("SELECT id,score,first_id,second_id,preferred_id,weight,protected,legacy_unlock,created_sequence FROM ranking_boundary ORDER BY score,first_id,second_id")?;
            for row in stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i32>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, f64>(5)?,
                    r.get::<_, bool>(6)?,
                    r.get::<_, bool>(7)?,
                    r.get::<_, i64>(8)?,
                ))
            })? {
                let (
                    id,
                    score,
                    first_id,
                    second_id,
                    preferred_id,
                    weight,
                    protected,
                    legacy_unlock,
                    created_sequence,
                ) = row?;
                archive.boundaries.push(RankingBoundaryArchive {
                    id: id.clone(),
                    score,
                    first_id,
                    second_id,
                    preferred_id,
                    weight,
                    protected,
                    created_sequence,
                    legacy_unlock,
                    unlock_judgment_ids: unlocks.remove(&id).unwrap_or_default(),
                });
            }
        }
        {
            let mut stmt=self.conn.prepare("SELECT id,score,kind,payload_json,occurred_at FROM ranking_order_event ORDER BY occurred_at,id")?;
            for row in stmt.query_map([], |r| {
                Ok(RankingOrderEventArchive {
                    id: r.get(0)?,
                    score: r.get(1)?,
                    kind: r.get(2)?,
                    payload_json: r.get(3)?,
                    occurred_at: r.get(4)?,
                })
            })? {
                archive.order_events.push(row?);
            }
        }
        Ok(archive)
    }

    pub(crate) fn import_ranking_archive(
        tx: &Transaction<'_>,
        archive: Option<&RankingArchive>,
    ) -> Result<(), StorageError> {
        tx.execute("DELETE FROM ranking_judgment", [])?;
        tx.execute("DELETE FROM ranking_session", [])?;
        tx.execute("DELETE FROM ranking_boundary", [])?;
        tx.execute("DELETE FROM ranking_order_event", [])?;
        tx.execute("DELETE FROM ranking_fit", [])?;
        tx.execute("DELETE FROM ranking_entry", [])?;
        tx.execute("DELETE FROM ranking_tier_state", [])?;
        if let Some(archive) = archive {
            if ![1, 2, 3].contains(&archive.schema_version) {
                return Err(StorageError::UnsupportedVersion);
            }
            if !(1..=ORDER_KEY_ALGORITHM_VERSION).contains(&archive.order_key_algorithm_version) {
                return Err(StorageError::UnsupportedVersion);
            }
            if archive.order_key_algorithm_version < ORDER_KEY_ALGORITHM_VERSION {
                migrate_order_keys(tx)?;
            }
            tx.execute(
                "UPDATE ranking_order_key_meta SET algorithm_version=?1 WHERE id=1",
                [ORDER_KEY_ALGORITHM_VERSION],
            )?;
            if archive.tiers.len() != 10 {
                return Err(StorageError::Validation(
                    "Ranking archive needs all ten tier states".into(),
                ));
            }
            for tier in &archive.tiers {
                if !(1..=10).contains(&tier.score)
                    || tier.input_sequence < 0
                    || tier.fitted_sequence < 0
                    || tier.fitted_sequence > tier.input_sequence
                    || tier.order_revision < 0
                {
                    return Err(StorageError::Validation(
                        "Ranking archive tier state is invalid".into(),
                    ));
                }
                tx.execute("INSERT INTO ranking_tier_state(score,input_sequence,fitted_sequence,pending_reconcile,order_revision) VALUES(?1,?2,?3,?4,?5)",params![tier.score,tier.input_sequence,tier.fitted_sequence,tier.pending_reconcile,tier.order_revision])?;
            }
            let tier_count: i64 =
                tx.query_row("SELECT COUNT(*) FROM ranking_tier_state", [], |r| r.get(0))?;
            if tier_count != 10 {
                return Err(StorageError::Validation(
                    "Ranking archive has duplicate tier states".into(),
                ));
            }
            for entry in &archive.entries {
                let actual: Option<(Option<i32>, String)> = tx
                    .query_row(
                        "SELECT overall_rating,disposition FROM entry WHERE id=?1",
                        [&entry.entry_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                if !(1..=10).contains(&entry.score)
                    || !actual.is_some_and(|(rating, disposition)| {
                        rating == Some(entry.score) && disposition == "experienced"
                    })
                {
                    return Err(StorageError::Validation(
                        "Ranking archive placement does not match its media".into(),
                    ));
                }
                tx.execute(
                    "INSERT INTO ranking_entry(entry_id,score,placed) VALUES(?1,?2,?3)",
                    params![entry.entry_id, entry.score, entry.placed],
                )?;
            }
            let missing_placements:i64=tx.query_row(
                "SELECT COUNT(*) FROM entry e WHERE e.trashed_at IS NULL AND e.disposition='experienced' AND e.overall_rating IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ranking_entry re WHERE re.entry_id=e.id)",
                [],|r|r.get(0))?;
            if missing_placements != 0 {
                return Err(StorageError::Validation(
                    "Ranking archive omitted scored media placements".into(),
                ));
            }
            for session in &archive.sessions {
                if !(1..=10).contains(&session.score)
                    || !["active", "paused", "ended"].contains(&session.status.as_str())
                    || !["binary", "normal", "confirm"].contains(&session.mode.as_str())
                    || !["auto", "binary", "normal"].contains(&session.intent.as_str())
                    || session.snapshot_order_revision < 0
                    || session.low_bound < 0
                    || session.high_bound < 0
                    || session.answered_count < 0
                    || session.answered_count >= i32::MAX as i64
                {
                    return Err(StorageError::Validation(
                        "Ranking archive session is invalid".into(),
                    ));
                }
                let filter: Vec<String> = serde_json::from_str(&session.filter_json)?;
                if filter.iter().collect::<HashSet<_>>().len() != filter.len() {
                    return Err(StorageError::Validation(
                        "Ranking archive session filter repeats a media type".into(),
                    ));
                }
                let mut snapshot: Vec<String> = serde_json::from_str(&session.snapshot_order_json)?;
                if snapshot.iter().collect::<HashSet<_>>().len() != snapshot.len() {
                    return Err(StorageError::Validation(
                        "Ranking archive session snapshot repeats a media ID".into(),
                    ));
                }
                if archive.schema_version < 3
                    && session.status == "active"
                    && session.mode == "normal"
                {
                    let full_order = tier_ids(tx, session.score, true)?;
                    let mut expected = full_order;
                    let mut archived = snapshot.clone();
                    expected.sort();
                    archived.sort();
                    if expected != archived {
                        return Err(StorageError::Validation(
                            "Legacy active normal session snapshot does not match the placed tier"
                                .into(),
                        ));
                    }
                    snapshot = filtered_tier_ids(tx, &snapshot, &filter)?;
                }
                let explicit_subset = archive.schema_version >= 3 && session.explicit_subset;
                tx.execute("INSERT INTO ranking_session(id,score,status,mode,intent,filter_json,seed,snapshot_order_json,explicit_subset,snapshot_order_revision,candidate_id,low_bound,high_bound,current_pivot_id,answered_count,presented_duel_id,presented_left_id,presented_right_id,presented_step,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)",params![session.id,session.score,session.status,session.mode,session.intent,session.filter_json,session.seed,serde_json::to_string(&snapshot)?,explicit_subset,session.snapshot_order_revision,session.candidate_id,session.low_bound,session.high_bound,session.current_pivot_id,session.answered_count,session.presented_duel_id,session.presented_left_id,session.presented_right_id,session.presented_step,session.created_at,session.updated_at])?;
            }
            for judgment in &archive.judgments {
                if !(1..=10).contains(&judgment.score)
                    || !["binary", "normal"].contains(&judgment.kind.as_str())
                    || !["leftWin", "rightWin", "tie", "skip"].contains(&judgment.answer.as_str())
                {
                    return Err(StorageError::Validation(
                        "Ranking archive judgment is invalid".into(),
                    ));
                }
                let input_sequence = if archive.schema_version >= 3 {
                    judgment.input_sequence
                } else {
                    0
                };
                tx.execute("INSERT INTO ranking_judgment(id,session_id,score,duel_id,kind,left_id,right_id,answer,retracted,input_sequence,occurred_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![judgment.id,judgment.session_id,judgment.score,judgment.duel_id,judgment.kind,judgment.left_id,judgment.right_id,judgment.answer,judgment.retracted,input_sequence,judgment.occurred_at])?;
            }
            for boundary in &archive.boundaries {
                if !(1..=10).contains(&boundary.score)
                    || !boundary.weight.is_finite()
                    || boundary.weight <= 0.0
                    || boundary.weight > 1.0
                    || boundary.first_id >= boundary.second_id
                    || ![boundary.first_id.as_str(), boundary.second_id.as_str()]
                        .contains(&boundary.preferred_id.as_str())
                {
                    return Err(StorageError::Validation(
                        "Ranking archive boundary is invalid".into(),
                    ));
                }
                let legacy_unlock = if archive.schema_version <= 2 {
                    !boundary.protected
                } else {
                    boundary.legacy_unlock
                };
                let unlock_ids = if archive.schema_version <= 2 {
                    &[][..]
                } else {
                    boundary.unlock_judgment_ids.as_slice()
                };
                let tier_sequence: i64 = tx.query_row(
                    "SELECT input_sequence FROM ranking_tier_state WHERE score=?1",
                    [boundary.score],
                    |r| r.get(0),
                )?;
                let created_sequence = if archive.schema_version >= 3 {
                    boundary.created_sequence
                } else {
                    tier_sequence
                };
                if created_sequence < 0 || created_sequence > tier_sequence {
                    return Err(StorageError::Validation(
                        "Ranking archive boundary sequence is invalid".into(),
                    ));
                }
                if boundary.protected && (legacy_unlock || !unlock_ids.is_empty())
                    || (!boundary.protected && !legacy_unlock && unlock_ids.is_empty())
                {
                    return Err(StorageError::Validation(
                        "Ranking archive boundary unlock state is inconsistent".into(),
                    ));
                }
                let placed_pair:i64=tx.query_row("SELECT COUNT(*) FROM ranking_entry a JOIN ranking_entry b ON b.entry_id=?2 WHERE a.entry_id=?1 AND a.score=?3 AND b.score=?3 AND a.placed=1 AND b.placed=1",params![boundary.first_id,boundary.second_id,boundary.score],|r|r.get(0))?;
                if placed_pair != 1 {
                    return Err(StorageError::Validation(
                        "Ranking archive boundary does not reference two placed works in its tier"
                            .into(),
                    ));
                }
                tx.execute("INSERT INTO ranking_boundary(id,score,first_id,second_id,preferred_id,weight,protected,legacy_unlock,created_sequence) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![boundary.id,boundary.score,boundary.first_id,boundary.second_id,boundary.preferred_id,boundary.weight,boundary.protected,legacy_unlock,created_sequence])?;
                let mut seen = HashSet::new();
                for judgment_id in unlock_ids {
                    if !seen.insert(judgment_id) {
                        return Err(StorageError::Validation(
                            "Ranking archive repeats a boundary unlock judgment".into(),
                        ));
                    }
                    let judgment:Option<(i32,String,String,String,bool,i64)>=tx.query_row("SELECT score,left_id,right_id,answer,retracted,input_sequence FROM ranking_judgment WHERE id=?1",[judgment_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
                    let valid = judgment.is_some_and(
                        |(score, left, right, answer, retracted, input_sequence)| {
                            let winner = match answer.as_str() {
                                "leftWin" => Some(left.as_str()),
                                "rightWin" => Some(right.as_str()),
                                _ => None,
                            };
                            score == boundary.score
                                && !retracted
                                && input_sequence > created_sequence
                                && ordered_pair(&left, &right)
                                    == (boundary.first_id.clone(), boundary.second_id.clone())
                                && winner.is_some_and(|id| id != boundary.preferred_id)
                        },
                    );
                    if !valid {
                        return Err(StorageError::Validation(
                            "Ranking archive boundary unlock judgment is invalid".into(),
                        ));
                    }
                    tx.execute("INSERT INTO ranking_boundary_unlock(boundary_id,judgment_id) VALUES(?1,?2)",params![boundary.id,judgment_id])?;
                }
            }
            for event in &archive.order_events {
                if !(1..=10).contains(&event.score) {
                    return Err(StorageError::Validation(
                        "Ranking archive order event is invalid".into(),
                    ));
                }
                let _: serde_json::Value = serde_json::from_str(&event.payload_json)?;
                tx.execute("INSERT INTO ranking_order_event(id,score,kind,payload_json,occurred_at) VALUES(?1,?2,?3,?4,?5)",params![event.id,event.score,event.kind,event.payload_json,event.occurred_at])?;
            }
            Self::validate_imported_ranking_state(tx, archive.schema_version)?;
        } else {
            tx.execute("INSERT INTO ranking_tier_state(score) VALUES(1),(2),(3),(4),(5),(6),(7),(8),(9),(10)",[])?;
            tx.execute("INSERT INTO ranking_entry(entry_id,score,placed) SELECT id,overall_rating,1 FROM entry WHERE disposition='experienced' AND overall_rating IS NOT NULL AND trashed_at IS NULL",[])?;
            migrate_order_keys(tx)?;
            tx.execute(
                "UPDATE ranking_order_key_meta SET algorithm_version=?1 WHERE id=1",
                [ORDER_KEY_ALGORITHM_VERSION],
            )?;
        }
        Ok(())
    }

    fn validate_imported_ranking_state(
        tx: &Transaction<'_>,
        schema_version: i64,
    ) -> Result<(), StorageError> {
        let mut seen_judgment_sequences = HashSet::<(i32, i64)>::new();
        {
            let mut statement=tx.prepare("SELECT j.score,j.session_id,j.left_id,j.right_id,j.answer,j.input_sequence,s.score FROM ranking_judgment j LEFT JOIN ranking_session s ON s.id=j.session_id ORDER BY j.score,j.input_sequence,j.id")?;
            for row in statement.query_map([], |r| {
                Ok((
                    r.get::<_, i32>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, Option<i32>>(6)?,
                ))
            })? {
                let (score, _session_id, left, right, answer, input_sequence, session_score) = row?;
                if left == right || session_score != Some(score) {
                    return Err(StorageError::Validation(
                        "Ranking archive judgment has an invalid session or pair".into(),
                    ));
                }
                let tier_sequence: i64 = tx.query_row(
                    "SELECT input_sequence FROM ranking_tier_state WHERE score=?1",
                    [score],
                    |r| r.get(0),
                )?;
                if input_sequence < 0 || input_sequence > tier_sequence {
                    return Err(StorageError::Validation(
                        "Ranking archive judgment sequence is invalid".into(),
                    ));
                }
                if schema_version >= 3
                    && answer != "skip"
                    && (input_sequence == 0
                        || !seen_judgment_sequences.insert((score, input_sequence)))
                {
                    return Err(StorageError::Validation(
                        "Ranking archive judgment sequence is missing or repeated".into(),
                    ));
                }
            }
        }
        {
            let mut statement=tx.prepare("SELECT id,score,status,mode,filter_json,snapshot_order_json,explicit_subset,snapshot_order_revision,candidate_id,low_bound,high_bound,answered_count,presented_duel_id,presented_left_id,presented_right_id,presented_step,current_pivot_id FROM ranking_session WHERE status='active'")?;
            let rows = statement.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i32>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, bool>(6)?,
                    r.get::<_, i64>(7)?,
                    r.get::<_, Option<String>>(8)?,
                    r.get::<_, i64>(9)?,
                    r.get::<_, i64>(10)?,
                    r.get::<_, i64>(11)?,
                    r.get::<_, Option<String>>(12)?,
                    r.get::<_, Option<String>>(13)?,
                    r.get::<_, Option<String>>(14)?,
                    r.get::<_, Option<i32>>(15)?,
                    r.get::<_, Option<String>>(16)?,
                ))
            })?;
            for row in rows {
                let (
                    _id,
                    score,
                    _status,
                    mode,
                    filter_json,
                    snapshot_json,
                    explicit_subset,
                    snapshot_revision,
                    candidate,
                    low,
                    high,
                    answered,
                    presented_id,
                    presented_left,
                    presented_right,
                    presented_step,
                    current_pivot,
                ) = row?;
                let filter: Vec<String> = serde_json::from_str(&filter_json)?;
                let snapshot: Vec<String> = serde_json::from_str(&snapshot_json)?;
                if mode == "binary" || mode == "confirm" {
                    if explicit_subset {
                        return Err(StorageError::Validation(
                            "Placement sessions cannot carry an explicit normal-duel subset".into(),
                        ));
                    }
                    let pending_reconcile: bool = tx.query_row(
                        "SELECT pending_reconcile FROM ranking_tier_state WHERE score=?1",
                        [score],
                        |r| r.get(0),
                    )?;
                    if pending_reconcile {
                        return Err(StorageError::Validation(
                            "Ranking archive active placement session has pending reconciliation"
                                .into(),
                        ));
                    }
                    let placed = tier_ids(tx, score, true)?;
                    let current_order_revision: i64 = tx.query_row(
                        "SELECT order_revision FROM ranking_tier_state WHERE score=?1",
                        [score],
                        |r| r.get(0),
                    )?;
                    if snapshot != placed
                        || snapshot_revision != current_order_revision
                        || low < 0
                        || high < low
                        || high as usize > snapshot.len()
                    {
                        return Err(StorageError::Validation(
                            "Ranking archive active placement snapshot or bounds are stale".into(),
                        ));
                    }
                    if mode == "confirm" && low != high {
                        return Err(StorageError::Validation(
                            "Ranking archive confirmation interval is invalid".into(),
                        ));
                    }
                    let Some(candidate_id) = candidate.as_deref() else {
                        return Err(StorageError::Validation(
                            "Ranking archive placement session has no candidate".into(),
                        ));
                    };
                    let candidate_is_unplaced:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM ranking_entry re JOIN entry e ON e.id=re.entry_id WHERE re.entry_id=?1 AND re.score=?2 AND re.placed=0 AND e.disposition='experienced' AND e.overall_rating=?2 AND e.trashed_at IS NULL)",params![candidate_id,score],|r|r.get(0))?;
                    if !candidate_is_unplaced || snapshot.iter().any(|id| id == candidate_id) {
                        return Err(StorageError::Validation("Ranking archive placement candidate is not an unplaced work in its tier".into()));
                    }
                    let prompt_fields = (
                        presented_id.is_some(),
                        presented_left.is_some(),
                        presented_right.is_some(),
                    );
                    if mode == "binary" && current_pivot.is_some() {
                        let pivot = current_pivot.as_deref().unwrap();
                        let pivot_is_unplaced:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM ranking_entry re JOIN entry e ON e.id=re.entry_id WHERE re.entry_id=?1 AND re.score=?2 AND re.placed=0 AND e.disposition='experienced' AND e.overall_rating=?2 AND e.trashed_at IS NULL)",params![pivot,score],|r|r.get(0))?;
                        if !snapshot.is_empty()
                            || !placed.is_empty()
                            || pivot == candidate_id
                            || !pivot_is_unplaced
                            || low != 0
                            || high != 0
                        {
                            return Err(StorageError::Validation(
                                "Ranking archive seed duel is not a pair of unplaced works".into(),
                            ));
                        }
                        if prompt_fields == (true, true, true) {
                            if presented_left.as_deref() != Some(candidate_id)
                                || presented_right.as_deref() != Some(pivot)
                                || presented_step != Some((answered + 1) as i32)
                            {
                                return Err(StorageError::Validation(
                                    "Ranking archive seed duel pair is invalid".into(),
                                ));
                            }
                        } else if prompt_fields != (false, false, false) || presented_step.is_some()
                        {
                            return Err(StorageError::Validation(
                                "Ranking archive seed duel prompt is incomplete".into(),
                            ));
                        }
                    } else if mode == "confirm" {
                        if prompt_fields != (false, false, false) || presented_step.is_some() {
                            return Err(StorageError::Validation(
                                "Ranking archive confirmation has a presented duel".into(),
                            ));
                        }
                    } else if prompt_fields == (true, true, true) {
                        let pivot = low as usize + (high as usize - low as usize) / 2;
                        if snapshot.get(pivot) != presented_right.as_ref()
                            || presented_left.as_deref() != Some(candidate_id)
                            || presented_step != Some((answered + 1) as i32)
                        {
                            return Err(StorageError::Validation(
                                "Ranking archive presented pivot does not match its frozen bounds"
                                    .into(),
                            ));
                        }
                    } else if prompt_fields != (false, false, false) || presented_step.is_some() {
                        return Err(StorageError::Validation(
                            "Ranking archive presented duel is incomplete".into(),
                        ));
                    }
                } else {
                    if candidate.is_some() || !(2..=200).contains(&snapshot.len()) {
                        return Err(StorageError::Validation(
                            "Ranking archive normal session participants are invalid".into(),
                        ));
                    }
                    let placed = tier_ids(tx, score, true)?;
                    let expected = filtered_tier_ids(tx, &placed, &filter)?;
                    let valid_participants = if explicit_subset {
                        let eligible = expected.into_iter().collect::<HashSet<_>>();
                        snapshot.iter().all(|id| eligible.contains(id))
                    } else {
                        let mut expected_set = expected;
                        let mut snapshot_set = snapshot.clone();
                        expected_set.sort();
                        snapshot_set.sort();
                        expected_set == snapshot_set
                    };
                    if !valid_participants {
                        return Err(StorageError::Validation("Ranking archive active normal session participants do not match its filter or subset".into()));
                    }
                    let prompt_fields = (
                        presented_id.is_some(),
                        presented_left.is_some(),
                        presented_right.is_some(),
                    );
                    if prompt_fields == (true, true, true) {
                        if presented_left == presented_right
                            || !snapshot.contains(presented_left.as_ref().unwrap())
                            || !snapshot.contains(presented_right.as_ref().unwrap())
                            || presented_step.is_some()
                        {
                            return Err(StorageError::Validation(
                                "Ranking archive normal duel is not among its participants".into(),
                            ));
                        }
                    } else if prompt_fields != (false, false, false) || presented_step.is_some() {
                        return Err(StorageError::Validation(
                            "Ranking archive presented duel is incomplete".into(),
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    pub fn start_duel_session(
        &mut self,
        expected_revision: i64,
        score: i32,
        filter_media_type_ids: Vec<String>,
        candidate_entry_id: Option<String>,
        intent: String,
    ) -> Result<DuelSession, StorageError> {
        self.start_duel_session_with_candidates(
            expected_revision,
            score,
            filter_media_type_ids,
            candidate_entry_id,
            None,
            intent,
        )
    }

    pub fn start_duel_session_with_candidates(
        &mut self,
        expected_revision: i64,
        score: i32,
        filter_media_type_ids: Vec<String>,
        candidate_entry_id: Option<String>,
        candidate_entry_ids: Option<Vec<String>>,
        intent: String,
    ) -> Result<DuelSession, StorageError> {
        self.start_duel_session_with_eligible_unplaced(
            expected_revision,
            score,
            filter_media_type_ids,
            candidate_entry_id,
            candidate_entry_ids,
            None,
            intent,
        )
    }

    pub fn start_duel_session_with_eligible_unplaced(
        &mut self,
        expected_revision: i64,
        score: i32,
        filter_media_type_ids: Vec<String>,
        candidate_entry_id: Option<String>,
        candidate_entry_ids: Option<Vec<String>>,
        eligible_unplaced_entry_ids: Option<Vec<String>>,
        intent: String,
    ) -> Result<DuelSession, StorageError> {
        if !(1..=10).contains(&score) || !["auto", "binary", "normal"].contains(&intent.as_str()) {
            return Err(StorageError::Validation(
                "Invalid duel session settings".into(),
            ));
        }
        let tx = self.conn.transaction()?;
        Self::check_version(&tx, expected_revision)?;
        // Starting another session is an explicit replacement, never a dead end.
        tx.execute(
            "UPDATE ranking_session SET status='ended',updated_at=?1 WHERE status='active'",
            [now_rfc3339()],
        )?;
        let placed = tier_ids(&tx, score, true)?;
        let all_unplaced = tier_ids(&tx, score, false)?;
        let media_eligible_unplaced =
            filtered_tier_ids(&tx, &all_unplaced, &filter_media_type_ids)?;
        let eligible_unplaced = if let Some(selected_ids) = eligible_unplaced_entry_ids {
            let selected: HashSet<&str> = selected_ids.iter().map(String::as_str).collect();
            if selected.len() != selected_ids.len()
                || selected_ids.iter().any(|id| {
                    !media_eligible_unplaced
                        .iter()
                        .any(|eligible| eligible == id)
                })
            {
                return Err(StorageError::Validation(
                    "Binary placement candidates must be unplaced works in the selected tier and media filters".into(),
                ));
            }
            media_eligible_unplaced
                .into_iter()
                .filter(|id| selected.contains(id.as_str()))
                .collect::<Vec<_>>()
        } else {
            media_eligible_unplaced
        };
        let candidate = candidate_entry_id.or_else(|| eligible_unplaced.first().cloned());
        if !all_unplaced.is_empty() && eligible_unplaced.is_empty() {
            return Err(StorageError::Validation(
                "No unplaced works match the selected filters".into(),
            ));
        }
        if let Some(candidate) = candidate.as_ref() {
            if !eligible_unplaced.contains(candidate) {
                return Err(StorageError::Validation(
                    "The selected work is already placed or does not match the selected filters"
                        .into(),
                ));
            }
        }
        let skipped_seed_pairs = skipped_seed_pairs(&tx, score)?;
        let seed_pivot = if placed.is_empty() {
            candidate.as_ref().and_then(|candidate| {
                eligible_unplaced
                    .iter()
                    .find(|other| {
                        *other != candidate
                            && !skipped_seed_pairs.contains(&ordered_pair(candidate, other))
                    })
                    .cloned()
            })
        } else {
            None
        };
        let seed_mode = seed_pivot.is_some();
        let should_binary = seed_mode
            || !all_unplaced.is_empty()
            || (placed.is_empty() && candidate.is_some())
            || (placed.len() == 1 && candidate.is_some())
            || match intent.as_str() {
                "binary" => candidate.is_some(),
                "normal" => false,
                _ => {
                    candidate.is_some()
                        && binary_suggestion_threshold(placed.len(), eligible_unplaced.len())
                }
            };
        let mode = if should_binary { "binary" } else { "normal" };
        if should_binary && candidate_entry_ids.is_some() {
            return Err(StorageError::Validation(
                "Choose either binary placement or a normal-duel subset".into(),
            ));
        }
        if should_binary {
            let id = candidate
                .as_deref()
                .ok_or_else(|| StorageError::Validation("Choose an unplaced work".into()))?;
            if !eligible_unplaced.contains(&id.to_string()) {
                return Err(StorageError::Validation(
                    "The selected work is already placed or belongs to another tier".into(),
                ));
            }
        }
        let normal_participants = filtered_tier_ids(&tx, &placed, &filter_media_type_ids)?;
        let explicit_subset = candidate_entry_ids.is_some();
        let normal_participants = if let Some(selected_ids) = candidate_entry_ids {
            if should_binary {
                return Err(StorageError::Validation(
                    "Binary placement does not accept a participant subset".into(),
                ));
            }
            if !(2..=200).contains(&selected_ids.len()) {
                return Err(StorageError::Validation(
                    "Choose between 2 and 200 placed works for duels".into(),
                ));
            }
            let selected: HashSet<&str> = selected_ids.iter().map(String::as_str).collect();
            if selected.len() != selected_ids.len() {
                return Err(StorageError::Validation(
                    "A duel subset cannot contain duplicate works".into(),
                ));
            }
            if selected_ids
                .iter()
                .any(|id| !normal_participants.iter().any(|eligible| eligible == id))
            {
                return Err(StorageError::Validation("A duel subset can include only placed works in the selected tier and media filters".into()));
            }
            normal_participants
                .into_iter()
                .filter(|id| selected.contains(id.as_str()))
                .collect()
        } else {
            normal_participants
        };
        if !should_binary && normal_participants.len() > 200 {
            return Err(StorageError::Validation(
                "Filter to 200 or fewer placed works to start a duel session".into(),
            ));
        }
        if mode == "normal" && normal_participants.len() < 2 {
            return Err(StorageError::Validation(
                "At least two placed works are needed for duels".into(),
            ));
        }
        let order_revision: i64 = tx.query_row(
            "SELECT order_revision FROM ranking_tier_state WHERE score=?1",
            [score],
            |row| row.get(0),
        )?;
        let id = format!("session-{}", now_nanos());
        let now = now_rfc3339();
        tx.execute(
            "INSERT INTO ranking_session(id,score,status,mode,intent,filter_json,seed,snapshot_order_json,snapshot_order_revision,candidate_id,low_bound,high_bound,current_pivot_id,explicit_subset,created_at,updated_at) VALUES(?1,?2,'active',?3,?4,?5,?6,?7,?8,?9,0,?10,?11,?12,?13,?13)",
            params![id,score,mode,intent,serde_json::to_string(&filter_media_type_ids)?,(now_nanos()%i64::MAX as u128) as i64,serde_json::to_string(if should_binary { &placed } else { &normal_participants })?,order_revision,if should_binary {candidate.as_deref()} else {None},placed.len() as i64,if seed_mode { seed_pivot.as_deref() } else {None},explicit_subset,now],
        )?;
        // A singleton tier has no possible seed pair, so retain direct placement.
        if should_binary && placed.is_empty() && !seed_mode {
            tx.execute(
                "UPDATE ranking_session SET mode='confirm',low_bound=0,high_bound=0 WHERE id=?1",
                [&id],
            )?;
        }
        tx.commit()?;
        Ok(DuelSession {
            id,
            score,
            status: "active".into(),
            mode: if seed_mode {
                "seed"
            } else if should_binary && placed.is_empty() {
                "confirm"
            } else {
                mode
            }
            .into(),
            answered_count: 0,
            candidate_entry_id: if should_binary { candidate } else { None },
        })
    }

    pub fn next_duel(
        &mut self,
        session_id: &str,
        revisit: bool,
    ) -> Result<Option<DuelPrompt>, StorageError> {
        let tx = self.conn.transaction()?;
        let session: Option<SessionRow> = tx.query_row(
            "SELECT id,score,mode,filter_json,snapshot_order_json,snapshot_order_revision,candidate_id,low_bound,high_bound,answered_count,presented_duel_id,presented_left_id,presented_right_id,presented_step,explicit_subset,current_pivot_id,intent FROM ranking_session WHERE id=?1 AND status='active'",
            [session_id], SessionRow::from_row,
        ).optional()?;
        let Some(mut session) = session else {
            return Ok(None);
        };
        if session.mode == "binary" || session.mode == "confirm" {
            let snapshot: Vec<String> = serde_json::from_str(&session.snapshot_order_json)?;
            let current_revision: i64 = tx.query_row(
                "SELECT order_revision FROM ranking_tier_state WHERE score=?1",
                [session.score],
                |row| row.get(0),
            )?;
            let seed_stale = if let Some(pivot) = session.current_pivot_id.as_ref() {
                let unplaced = tier_ids(&tx, session.score, false)?;
                session
                    .candidate_id
                    .as_ref()
                    .is_none_or(|candidate| !unplaced.contains(candidate))
                    || !unplaced.contains(pivot)
            } else {
                false
            };
            if current_revision != session.snapshot_order_revision
                || tier_ids(&tx, session.score, true)? != snapshot
                || seed_stale
            {
                tx.execute(
                    "UPDATE ranking_session SET status='ended',updated_at=?1 WHERE id=?2",
                    params![now_rfc3339(), session.id],
                )?;
                tx.commit()?;
                return self.restart_stale_session(&session);
            }
        }
        if session.mode == "normal" {
            let entries: Vec<String> = serde_json::from_str(&session.snapshot_order_json)?;
            let filter: Vec<String> = serde_json::from_str(&session.filter_json)?;
            let current_participants =
                filtered_tier_ids(&tx, &tier_ids(&tx, session.score, true)?, &filter)?;
            let mut expected_set = entries.clone();
            let mut current_set = current_participants;
            expected_set.sort();
            current_set.sort();
            let participants_stale = if session.explicit_subset {
                expected_set.len() > 200
                    || expected_set
                        .iter()
                        .any(|id| current_set.binary_search(id).is_err())
            } else {
                expected_set != current_set
            };
            if participants_stale || !tier_ids(&tx, session.score, false)?.is_empty() {
                tx.execute(
                    "UPDATE ranking_session SET status='ended',updated_at=?1 WHERE id=?2",
                    params![now_rfc3339(), session.id],
                )?;
                tx.commit()?;
                return self.restart_stale_session(&session);
            }
            if entries.len() > 200 {
                tx.execute(
                    "UPDATE ranking_session SET status='paused',updated_at=?1 WHERE id=?2",
                    params![now_rfc3339(), session.id],
                )?;
                tx.commit()?;
                return Err(StorageError::Validation(
                    "Filter to 200 or fewer placed works to start a duel session".into(),
                ));
            }
        }
        if let (Some(duel_id), Some(left), Some(right)) = (
            &session.presented_duel_id,
            &session.presented_left_id,
            &session.presented_right_id,
        ) {
            let prompt = prompt_from_session(&session, duel_id, left, right);
            tx.commit()?;
            return Ok(Some(prompt));
        }
        let prompt = if session.mode == "confirm" {
            let snapshot: Vec<String> = serde_json::from_str(&session.snapshot_order_json)?;
            let candidate = session
                .candidate_id
                .as_deref()
                .ok_or(StorageError::Conflict)?;
            Some(confirm_prompt(
                &session,
                &snapshot,
                candidate,
                session.low_bound,
            ))
        } else if session.mode == "binary" {
            let snapshot: Vec<String> = serde_json::from_str(&session.snapshot_order_json)?;
            if let Some(pivot) = &session.current_pivot_id {
                let left = session.candidate_id.clone().ok_or(StorageError::Conflict)?;
                let duel_id = format!("duel-{}", now_nanos());
                let step = (session.answered_count + 1) as i32;
                tx.execute("UPDATE ranking_session SET presented_duel_id=?1,presented_left_id=?2,presented_right_id=?3,presented_step=?4,updated_at=?5 WHERE id=?6",params![duel_id,left,pivot,step,now_rfc3339(),session.id])?;
                session.presented_duel_id = Some(duel_id.clone());
                session.presented_left_id = Some(left.clone());
                session.presented_right_id = Some(pivot.clone());
                session.presented_step = Some(step);
                Some(prompt_from_session(&session, &duel_id, &left, pivot))
            } else {
                if let Some(midpoint) = binary_midpoint(session.low_bound, session.high_bound) {
                    let left = session.candidate_id.clone().unwrap();
                    let skipped = skipped_seed_pairs(&tx, session.score)?;
                    let mid = (session.low_bound..session.high_bound)
                        .filter(|index| !skipped.contains(&ordered_pair(&left, &snapshot[*index])))
                        .min_by_key(|index| index.abs_diff(midpoint));
                    if let Some(mid) = mid {
                        let right = snapshot[mid].clone();
                        let duel_id = format!("duel-{}", now_nanos());
                        let step = (session.answered_count + 1) as i32;
                        tx.execute("UPDATE ranking_session SET presented_duel_id=?1,presented_left_id=?2,presented_right_id=?3,presented_step=?4,updated_at=?5 WHERE id=?6", params![duel_id,left,right,step,now_rfc3339(),session.id])?;
                        session.presented_duel_id = Some(duel_id.clone());
                        session.presented_left_id = Some(left.clone());
                        session.presented_right_id = Some(right.clone());
                        session.presented_step = Some(step);
                        Some(prompt_from_session(&session, &duel_id, &left, &right))
                    } else {
                        tx.execute("UPDATE ranking_session SET status='ended',candidate_id=NULL,updated_at=?1 WHERE id=?2", params![now_rfc3339(),session.id])?;
                        None
                    }
                } else {
                    tx.execute("UPDATE ranking_session SET mode='confirm',presented_duel_id=NULL,presented_left_id=NULL,presented_right_id=NULL,updated_at=?1 WHERE id=?2", params![now_rfc3339(),session.id])?;
                    session.mode = "confirm".into();
                    Some(confirm_prompt(
                        &session,
                        &snapshot,
                        session.candidate_id.as_deref().unwrap(),
                        session.low_bound,
                    ))
                }
            }
        } else {
            let snapshot: Vec<String> = serde_json::from_str(&session.snapshot_order_json)?;
            let members: HashSet<String> = snapshot.iter().cloned().collect();
            let entries: Vec<String> = tier_ids(&tx, session.score, true)?
                .into_iter()
                .filter(|id| members.contains(id))
                .collect();
            if entries.len() < 2 {
                None
            } else {
                let avoid_pair = if revisit {
                    None
                } else {
                    latest_normal_pair(&tx, session.score)?
                };
                let mut pair = select_normal_pair(
                    &tx,
                    session.score,
                    &entries,
                    revisit,
                    avoid_pair.as_ref(),
                    &session.id,
                    session.answered_count,
                )?;
                if pair.is_none() && !revisit {
                    pair = select_normal_pair(
                        &tx,
                        session.score,
                        &entries,
                        true,
                        avoid_pair.as_ref(),
                        &session.id,
                        session.answered_count,
                    )?;
                }
                if let Some((left, right)) = pair {
                    let duel_id = format!("duel-{}", now_nanos());
                    tx.execute("UPDATE ranking_session SET presented_duel_id=?1,presented_left_id=?2,presented_right_id=?3,updated_at=?4 WHERE id=?5", params![duel_id,left,right,now_rfc3339(),session.id])?;
                    Some(prompt_from_session(&session, &duel_id, &left, &right))
                } else {
                    tx.execute(
                        "UPDATE ranking_session SET status='ended',updated_at=?1 WHERE id=?2",
                        params![now_rfc3339(), session.id],
                    )?;
                    None
                }
            }
        };
        tx.commit()?;
        Ok(prompt)
    }

    fn restart_stale_session(
        &mut self,
        session: &SessionRow,
    ) -> Result<Option<DuelPrompt>, StorageError> {
        let state = self.load_ranking()?;
        let tier = state
            .tiers
            .iter()
            .find(|tier| tier.score == session.score)
            .ok_or(StorageError::Conflict)?;
        let candidate = session
            .candidate_id
            .as_ref()
            .filter(|id| tier.unplaced_ids.contains(id))
            .cloned();
        let intent = if session.mode == "binary" || session.mode == "confirm" {
            "binary".to_string()
        } else {
            session.intent.clone()
        };
        let subset = if session.mode == "normal"
            && session.explicit_subset
            && session.snapshot_order_json.len() > 2
        {
            serde_json::from_str::<Vec<String>>(&session.snapshot_order_json)
                .ok()
                .filter(|ids| (2..=200).contains(&ids.len()))
        } else {
            None
        };
        let eligible_unplaced = candidate.as_ref().map(|id| vec![id.clone()]);
        let started = self.start_duel_session_with_eligible_unplaced(
            state.revision,
            session.score,
            serde_json::from_str(&session.filter_json)?,
            candidate,
            subset,
            eligible_unplaced,
            intent,
        );
        match started {
            Ok(replacement) => self.next_duel(&replacement.id, false),
            Err(StorageError::Validation(_)) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn answer_duel(
        &mut self,
        expected_revision: i64,
        session_id: &str,
        duel_id: &str,
        answer: DuelAnswer,
    ) -> Result<RankingState, StorageError> {
        let tx = self.conn.transaction()?;
        let current_revision: i64 =
            tx.query_row("SELECT version FROM metadata WHERE id=1", [], |r| r.get(0))?;
        let session:Option<SessionRow> = tx.query_row(
            "SELECT id,score,mode,filter_json,snapshot_order_json,snapshot_order_revision,candidate_id,low_bound,high_bound,answered_count,presented_duel_id,presented_left_id,presented_right_id,presented_step,explicit_subset,current_pivot_id,intent FROM ranking_session WHERE id=?1 AND status='active'",
            [session_id], SessionRow::from_row,
        ).optional()?;
        let Some(session) = session else {
            drop(tx);
            return self.load_ranking();
        };
        if expected_revision != current_revision {
            tx.execute(
                "UPDATE ranking_session SET status='ended',updated_at=?1 WHERE id=?2",
                params![now_rfc3339(), session.id],
            )?;
            tx.commit()?;
            let _ = self.restart_stale_session(&session)?;
            return self.load_ranking();
        }
        if session.mode == "binary" || session.mode == "confirm" {
            let snapshot: Vec<String> = serde_json::from_str(&session.snapshot_order_json)?;
            let current_revision: i64 = tx.query_row(
                "SELECT order_revision FROM ranking_tier_state WHERE score=?1",
                [session.score],
                |row| row.get(0),
            )?;
            let seed_stale = session.current_pivot_id.as_ref().is_some_and(|pivot| {
                let candidate = session.candidate_id.as_deref().unwrap_or("");
                tier_ids(&tx, session.score, false)
                    .map(|unplaced| {
                        !unplaced.contains(pivot) || !unplaced.contains(&candidate.to_string())
                    })
                    .unwrap_or(true)
            });
            if current_revision != session.snapshot_order_revision
                || tier_ids(&tx, session.score, true)? != snapshot
                || seed_stale
            {
                tx.execute(
                    "UPDATE ranking_session SET status='ended',updated_at=?1 WHERE id=?2",
                    params![now_rfc3339(), session.id],
                )?;
                tx.commit()?;
                let _ = self.restart_stale_session(&session)?;
                return self.load_ranking();
            }
        } else if session.mode == "normal" {
            let snapshot: Vec<String> = serde_json::from_str(&session.snapshot_order_json)?;
            let filter: Vec<String> = serde_json::from_str(&session.filter_json)?;
            let current = filtered_tier_ids(&tx, &tier_ids(&tx, session.score, true)?, &filter)?;
            let mut expected_set = snapshot.clone();
            let mut current_set = current;
            expected_set.sort();
            current_set.sort();
            let participants_stale = if session.explicit_subset {
                expected_set.len() > 200
                    || expected_set
                        .iter()
                        .any(|id| current_set.binary_search(id).is_err())
            } else {
                expected_set != current_set
            };
            if participants_stale
                || snapshot.len() > 200
                || !tier_ids(&tx, session.score, false)?.is_empty()
            {
                tx.execute(
                    "UPDATE ranking_session SET status='ended',updated_at=?1 WHERE id=?2",
                    params![now_rfc3339(), session.id],
                )?;
                tx.commit()?;
                let _ = self.restart_stale_session(&session)?;
                return self.load_ranking();
            }
        }
        if session.presented_duel_id.as_deref() != Some(duel_id) {
            tx.execute(
                "UPDATE ranking_session SET status='ended',updated_at=?1 WHERE id=?2",
                params![now_rfc3339(), session.id],
            )?;
            tx.commit()?;
            let _ = self.restart_stale_session(&session)?;
            return self.load_ranking();
        }
        let left = session.presented_left_id.as_deref().unwrap();
        let right = session.presented_right_id.as_deref().unwrap();
        if session.mode == "normal" {
            let participants: Vec<String> = serde_json::from_str(&session.snapshot_order_json)?;
            if left == right
                || !participants.iter().any(|id| id == left)
                || !participants.iter().any(|id| id == right)
            {
                return Err(StorageError::Conflict);
            }
        }
        let answer_text = answer_as_str(answer);
        let judgment_id = format!("judgment-{}", now_nanos());
        let current_input_sequence: i64 = tx.query_row(
            "SELECT input_sequence FROM ranking_tier_state WHERE score=?1",
            [session.score],
            |row| row.get(0),
        )?;
        let judgment_input_sequence = if answer == DuelAnswer::Skip {
            current_input_sequence
        } else {
            current_input_sequence + 1
        };
        tx.execute("INSERT INTO ranking_judgment(id,session_id,score,duel_id,kind,left_id,right_id,answer,retracted,input_sequence,occurred_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,0,?9,?10)", params![judgment_id,session_id,session.score,duel_id,session.mode,left,right,answer_text,judgment_input_sequence,now_rfc3339()])?;
        tx.execute("UPDATE ranking_session SET answered_count=answered_count+1,presented_duel_id=NULL,presented_left_id=NULL,presented_right_id=NULL,presented_step=NULL,updated_at=?1 WHERE id=?2", params![now_rfc3339(),session_id])?;
        if session.mode == "binary" {
            if session.current_pivot_id.is_some() {
                if answer == DuelAnswer::Skip {
                    tx.execute("UPDATE ranking_session SET status='ended',current_pivot_id=NULL,candidate_id=NULL,updated_at=?1 WHERE id=?2",params![now_rfc3339(),session_id])?;
                } else {
                    let pair = [left.to_string(), right.to_string()];
                    let selected = if answer == DuelAnswer::LeftWin {
                        pair.to_vec()
                    } else if answer == DuelAnswer::RightWin {
                        vec![right.to_string(), left.to_string()]
                    } else {
                        let stable = tier_ids(&tx, session.score, false)?;
                        let left_pos = stable
                            .iter()
                            .position(|id| id == left)
                            .ok_or(StorageError::Conflict)?;
                        let right_pos = stable
                            .iter()
                            .position(|id| id == right)
                            .ok_or(StorageError::Conflict)?;
                        if left_pos < right_pos {
                            pair.to_vec()
                        } else {
                            vec![right.to_string(), left.to_string()]
                        }
                    };
                    let unplaced = tier_ids(&tx, session.score, false)?;
                    if !unplaced.contains(&selected[0]) || !unplaced.contains(&selected[1]) {
                        return Err(StorageError::Conflict);
                    }
                    let remaining = unplaced
                        .into_iter()
                        .filter(|id| id != &selected[0] && id != &selected[1])
                        .collect::<Vec<_>>();
                    for id in &selected {
                        tx.execute("UPDATE ranking_entry SET placed=1 WHERE entry_id=?1 AND score=?2 AND placed=0",params![id,session.score])?;
                    }
                    renumber_tier_groups(&tx, session.score, &selected, &remaining)?;
                    tx.execute("UPDATE ranking_tier_state SET input_sequence=input_sequence+1,pending_reconcile=0,order_revision=order_revision+1 WHERE score=?1",[session.score])?;
                    tx.execute("INSERT INTO ranking_order_event(id,score,kind,payload_json,occurred_at) VALUES(?1,?2,'seed_duel',?3,?4)",params![format!("order-{}",now_nanos()),session.score,json!({"winnerId":selected[0],"secondId":selected[1],"answer":answer_text}).to_string(),now_rfc3339()])?;
                    // Fitting consumes the duel evidence; reconciliation remains off until later normal judgments.
                    let _ = fit_without_reconcile(&tx, session.score);
                    let placed_now = tier_ids(&tx, session.score, true)?;
                    let remaining = tier_ids(&tx, session.score, false)?;
                    let filter: Vec<String> = serde_json::from_str(&session.filter_json)?;
                    let participants = filtered_tier_ids(&tx, &placed_now, &filter)?;
                    let order_revision: i64 = tx.query_row(
                        "SELECT order_revision FROM ranking_tier_state WHERE score=?1",
                        [session.score],
                        |r| r.get(0),
                    )?;
                    if !remaining.is_empty() {
                        tx.execute("UPDATE ranking_session SET status='ended',mode='binary',candidate_id=NULL,current_pivot_id=NULL,explicit_subset=0,snapshot_order_json=?1,snapshot_order_revision=?2,low_bound=0,high_bound=0,updated_at=?3 WHERE id=?4",params![serde_json::to_string(&participants)?,order_revision,now_rfc3339(),session_id])?;
                    } else if participants.len() >= 2 {
                        tx.execute("UPDATE ranking_session SET mode='normal',candidate_id=NULL,current_pivot_id=NULL,explicit_subset=0,snapshot_order_json=?1,snapshot_order_revision=?2,low_bound=0,high_bound=0,updated_at=?3 WHERE id=?4",params![serde_json::to_string(&participants)?,order_revision,now_rfc3339(),session_id])?;
                    } else {
                        tx.execute("UPDATE ranking_session SET status='ended',mode='normal',candidate_id=NULL,current_pivot_id=NULL,explicit_subset=0,snapshot_order_json=?1,snapshot_order_revision=?2,updated_at=?3 WHERE id=?4",params![serde_json::to_string(&participants)?,order_revision,now_rfc3339(),session_id])?;
                    }
                }
            } else if answer == DuelAnswer::Skip {
                tx.execute("UPDATE ranking_session SET status='ended',candidate_id=NULL,current_pivot_id=NULL,updated_at=?1 WHERE id=?2", params![now_rfc3339(),session_id])?;
            } else {
                let snapshot: Vec<String> = serde_json::from_str(&session.snapshot_order_json)?;
                let pivot = snapshot
                    .iter()
                    .position(|id| id == right)
                    .ok_or(StorageError::Conflict)?;
                tx.execute("UPDATE ranking_tier_state SET input_sequence=input_sequence+1,pending_reconcile=0 WHERE score=?1", [session.score])?;
                match binary_step(session.low_bound, session.high_bound, pivot, answer) {
                    BinaryStep::Bounds(low, high) => {
                        tx.execute(
                            "UPDATE ranking_session SET low_bound=?1,high_bound=?2 WHERE id=?3",
                            params![low as i64, high as i64, session_id],
                        )?;
                    }
                    BinaryStep::Confirm(index) => {
                        tx.execute("UPDATE ranking_session SET low_bound=?1,high_bound=?1,mode='confirm' WHERE id=?2",params![index as i64,session_id])?;
                    }
                    BinaryStep::Skip => {
                        unreachable!("skip was handled before recording preference evidence")
                    }
                }
            }
        } else if answer != DuelAnswer::Skip {
            tx.execute("UPDATE ranking_tier_state SET input_sequence=input_sequence+1,pending_reconcile=1 WHERE score=?1", [session.score])?;
            if answer == DuelAnswer::LeftWin {
                unlock_opposing_boundary(&tx, session.score, left, right, left, &judgment_id)?;
            }
            if answer == DuelAnswer::RightWin {
                unlock_opposing_boundary(&tx, session.score, left, right, right, &judgment_id)?;
            }
            let (winner, loser) = if answer == DuelAnswer::LeftWin {
                (left, right)
            } else {
                (right, left)
            };
            apply_adjacent_duel_correction(&tx, session.score, winner, loser, &judgment_id)?;
            let _ = fit_and_reconcile(&tx, session.score);
        }
        tx.execute("UPDATE metadata SET version=version+1 WHERE id=1", [])?;
        tx.commit()?;
        self.load_ranking()
    }

    pub fn confirm_binary_placement(
        &mut self,
        expected_revision: i64,
        session_id: &str,
        accepted: bool,
    ) -> Result<BinaryPlacementResult, StorageError> {
        let tx = self.conn.transaction()?;
        let current_revision: i64 =
            tx.query_row("SELECT version FROM metadata WHERE id=1", [], |r| r.get(0))?;
        let session:Option<SessionRow> = tx.query_row(
            "SELECT id,score,mode,filter_json,snapshot_order_json,snapshot_order_revision,candidate_id,low_bound,high_bound,answered_count,presented_duel_id,presented_left_id,presented_right_id,presented_step,explicit_subset,current_pivot_id,intent FROM ranking_session WHERE id=?1 AND status='active'",
            [session_id], SessionRow::from_row,
        ).optional()?;
        let Some(session) = session else {
            let stale_score: Option<i32> = tx
                .query_row(
                    "SELECT score FROM ranking_session WHERE id=?1",
                    [session_id],
                    |r| r.get(0),
                )
                .optional()?;
            drop(tx);
            let state = self.load_ranking()?;
            return Ok(BinaryPlacementResult {
                next_step: binary_step_for_state(&state, stale_score.unwrap_or(0)),
                state,
            });
        };
        if expected_revision != current_revision {
            tx.execute(
                "UPDATE ranking_session SET status='ended',updated_at=?1 WHERE id=?2",
                params![now_rfc3339(), session.id],
            )?;
            tx.commit()?;
            let _ = self.restart_stale_session(&session)?;
            let state = self.load_ranking()?;
            return Ok(BinaryPlacementResult {
                next_step: binary_step_for_state(&state, session.score),
                state,
            });
        }
        if session.mode != "confirm" {
            drop(tx);
            let state = self.load_ranking()?;
            return Ok(BinaryPlacementResult {
                next_step: binary_step_for_state(&state, session.score),
                state,
            });
        }
        let filter: Vec<String> = serde_json::from_str(&session.filter_json)?;
        let next_step;
        if accepted {
            let snapshot: Vec<String> = serde_json::from_str(&session.snapshot_order_json)?;
            let current_order = tier_ids(&tx, session.score, true)?;
            let current_revision: i64 = tx.query_row(
                "SELECT order_revision FROM ranking_tier_state WHERE score=?1",
                [session.score],
                |row| row.get(0),
            )?;
            let candidate = session.candidate_id.as_deref().unwrap_or("");
            let candidate_unplaced:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM ranking_entry WHERE entry_id=?1 AND score=?2 AND placed=0)",params![candidate,session.score],|r|r.get(0))?;
            if current_order != snapshot
                || current_revision != session.snapshot_order_revision
                || !candidate_unplaced
            {
                tx.execute(
                    "UPDATE ranking_session SET status='ended',updated_at=?1 WHERE id=?2",
                    params![now_rfc3339(), session.id],
                )?;
                tx.commit()?;
                let _ = self.restart_stale_session(&session)?;
                let state = self.load_ranking()?;
                return Ok(BinaryPlacementResult {
                    next_step: binary_step_for_state(&state, session.score),
                    state,
                });
            }
            let candidate = session
                .candidate_id
                .as_deref()
                .ok_or(StorageError::Conflict)?;
            let index = session.low_bound.min(snapshot.len());
            confirm_binary_insertion(&tx, session.score, candidate, &snapshot, index)?;
            tx.execute("UPDATE ranking_tier_state SET input_sequence=input_sequence+1,pending_reconcile=0,order_revision=order_revision+1 WHERE score=?1", [session.score])?;
            let _ = fit_without_reconcile(&tx, session.score);
        }
        let remaining = tier_ids(&tx, session.score, false)?;
        if !remaining.is_empty() {
            tx.execute("UPDATE ranking_session SET status='ended',mode='binary',candidate_id=NULL,current_pivot_id=NULL,explicit_subset=0,low_bound=0,high_bound=0,updated_at=?1 WHERE id=?2", params![now_rfc3339(),session_id])?;
            next_step = BinaryPlacementNextStep::OfferBinary;
        } else {
            let placed_now = tier_ids(&tx, session.score, true)?;
            let participants = filtered_tier_ids(&tx, &placed_now, &filter)?;
            let order_revision: i64 = tx.query_row(
                "SELECT order_revision FROM ranking_tier_state WHERE score=?1",
                [session.score],
                |row| row.get(0),
            )?;
            if participants.len() > 200 {
                tx.execute("UPDATE ranking_session SET status='paused',mode='normal',candidate_id=NULL,explicit_subset=0,snapshot_order_json=?1,snapshot_order_revision=?2,low_bound=0,high_bound=0,updated_at=?3 WHERE id=?4",params![serde_json::to_string(&participants)?,order_revision,now_rfc3339(),session_id])?;
                next_step = BinaryPlacementNextStep::RequiresSubset;
            } else if participants.len() >= 2 {
                tx.execute("UPDATE ranking_session SET status='active',mode='normal',candidate_id=NULL,explicit_subset=0,snapshot_order_json=?1,snapshot_order_revision=?2,low_bound=0,high_bound=0 WHERE id=?3",params![serde_json::to_string(&participants)?,order_revision,session_id])?;
                next_step = BinaryPlacementNextStep::Normal;
            } else {
                tx.execute("UPDATE ranking_session SET status='ended',mode='normal',candidate_id=NULL,explicit_subset=0,snapshot_order_json=?1,snapshot_order_revision=?2,low_bound=0,high_bound=0,updated_at=?3 WHERE id=?4",params![serde_json::to_string(&participants)?,order_revision,now_rfc3339(),session_id])?;
                next_step = BinaryPlacementNextStep::Done;
            }
        }
        tx.execute("UPDATE metadata SET version=version+1 WHERE id=1", [])?;
        tx.commit()?;
        Ok(BinaryPlacementResult {
            state: self.load_ranking()?,
            next_step,
        })
    }

    pub fn pause_duel_session(&mut self, session_id: &str) -> Result<DuelSession, StorageError> {
        self.set_session_status(session_id, "paused")
    }

    pub fn end_duel_session(&mut self, session_id: &str) -> Result<DuelSession, StorageError> {
        self.set_session_status(session_id, "ended")
    }

    fn set_session_status(
        &mut self,
        session_id: &str,
        status: &str,
    ) -> Result<DuelSession, StorageError> {
        let changed = self.conn.execute("UPDATE ranking_session SET status=?1,updated_at=?2 WHERE id=?3 AND status IN ('active','paused')", params![status,now_rfc3339(),session_id])?;
        if changed == 0 {
            return Err(StorageError::Validation(
                "Duel session is unavailable".into(),
            ));
        }
        self.conn.query_row("SELECT id,score,status,mode,answered_count,candidate_id FROM ranking_session WHERE id=?1", [session_id], |row| Ok(DuelSession { id:row.get(0)?,score:row.get(1)?,status:row.get(2)?,mode:row.get(3)?,answered_count:row.get(4)?,candidate_entry_id:row.get(5)? })).map_err(Into::into)
    }
}

#[derive(Debug)]
struct SessionRow {
    id: String,
    score: i32,
    mode: String,
    filter_json: String,
    snapshot_order_json: String,
    snapshot_order_revision: i64,
    candidate_id: Option<String>,
    low_bound: usize,
    high_bound: usize,
    answered_count: i64,
    presented_duel_id: Option<String>,
    presented_left_id: Option<String>,
    presented_right_id: Option<String>,
    presented_step: Option<i32>,
    explicit_subset: bool,
    current_pivot_id: Option<String>,
    intent: String,
}
impl SessionRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            score: row.get(1)?,
            mode: row.get(2)?,
            filter_json: row.get(3)?,
            snapshot_order_json: row.get(4)?,
            snapshot_order_revision: row.get(5)?,
            candidate_id: row.get(6)?,
            low_bound: row.get::<_, i64>(7)?.max(0) as usize,
            high_bound: row.get::<_, i64>(8)?.max(0) as usize,
            answered_count: row.get(9)?,
            presented_duel_id: row.get(10)?,
            presented_left_id: row.get(11)?,
            presented_right_id: row.get(12)?,
            presented_step: row.get(13)?,
            explicit_subset: row.get(14)?,
            current_pivot_id: row.get(15)?,
            intent: row.get(16)?,
        })
    }
}

fn tier_ids(tx: &Transaction<'_>, score: i32, placed: bool) -> Result<Vec<String>, StorageError> {
    let mut stmt = tx.prepare("SELECT re.entry_id FROM ranking_entry re JOIN entry e ON e.id=re.entry_id JOIN group_order go ON go.entry_id=re.entry_id WHERE re.score=?1 AND re.placed=?2 AND e.trashed_at IS NULL ORDER BY go.order_key COLLATE BINARY,re.entry_id COLLATE BINARY")?;
    let ids = stmt
        .query_map(params![score, placed], |row| row.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(ids)
}
fn media_type_matches_filter(
    tx: &Transaction<'_>,
    entry_id: &str,
    filter: &[String],
) -> Result<bool, StorageError> {
    if filter.is_empty() {
        return Ok(true);
    }
    let type_id: Option<String> = tx
        .query_row(
            "SELECT media_type_id FROM entry WHERE id=?1 AND trashed_at IS NULL",
            [entry_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    Ok(type_id.is_some_and(|type_id| filter.contains(&type_id)))
}
fn filtered_tier_ids(
    tx: &Transaction<'_>,
    ids: &[String],
    filter: &[String],
) -> Result<Vec<String>, StorageError> {
    if filter.is_empty() {
        return Ok(ids.to_vec());
    }
    let mut filtered = Vec::new();
    for id in ids {
        if media_type_matches_filter(tx, id, filter)? {
            filtered.push(id.clone());
        }
    }
    Ok(filtered)
}
fn tier_order_snapshot(
    tx: &Transaction<'_>,
    score: i32,
) -> Result<serde_json::Value, StorageError> {
    let revision: i64 = tx.query_row(
        "SELECT order_revision FROM ranking_tier_state WHERE score=?1",
        [score],
        |row| row.get(0),
    )?;
    let judgment_count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM ranking_judgment WHERE score=?1",
        [score],
        |row| row.get(0),
    )?;
    Ok(
        json!({"score":score,"placedIds":tier_ids(tx,score,true)?,"unplacedIds":tier_ids(tx,score,false)?,"orderRevision":revision,"judgmentCount":judgment_count}),
    )
}
fn tier_snapshot_content_matches(
    tx: &Transaction<'_>,
    snapshot: &serde_json::Value,
) -> Result<bool, StorageError> {
    let score = snapshot
        .get("score")
        .and_then(|value| value.as_i64())
        .ok_or(StorageError::Conflict)? as i32;
    let placed = snapshot
        .get("placedIds")
        .and_then(|value| value.as_array())
        .ok_or(StorageError::Conflict)?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or(StorageError::Conflict)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let unplaced = snapshot
        .get("unplacedIds")
        .and_then(|value| value.as_array())
        .ok_or(StorageError::Conflict)?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or(StorageError::Conflict)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let judgment_count = snapshot
        .get("judgmentCount")
        .and_then(|value| value.as_i64())
        .ok_or(StorageError::Conflict)?;
    let current_judgment_count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM ranking_judgment WHERE score=?1",
        [score],
        |row| row.get(0),
    )?;
    Ok(tier_ids(tx, score, true)? == placed
        && tier_ids(tx, score, false)? == unplaced
        && current_judgment_count == judgment_count)
}
fn insertion_index(ids: &[String], position: &RankingPosition) -> Result<usize, StorageError> {
    match position.kind.as_str() {
        "start" => Ok(0),
        "end" => Ok(ids.len()),
        "before" | "after" => {
            let anchor = position
                .anchor_id
                .as_deref()
                .ok_or_else(|| StorageError::Validation("Choose a target position".into()))?;
            let index = ids
                .iter()
                .position(|id| id == anchor)
                .ok_or_else(|| StorageError::Conflict)?;
            Ok(if position.kind == "before" {
                index
            } else {
                index + 1
            })
        }
        _ => Err(StorageError::Validation("Invalid ranking position".into())),
    }
}
fn renumber_tier(tx: &Transaction<'_>, score: i32, ordered: &[String]) -> Result<(), StorageError> {
    let unplaced = tier_ids(tx, score, false)?;
    renumber_tier_groups(tx, score, ordered, &unplaced)
}
fn renumber_tier_groups(
    tx: &Transaction<'_>,
    score: i32,
    placed: &[String],
    unplaced: &[String],
) -> Result<(), StorageError> {
    let mut ordered = placed.to_vec();
    ordered.extend(unplaced.iter().cloned());
    ordered.extend(trashed_group_ids(tx, score)?);
    rebalance_group(tx, &format!("rating-{score:02}"), &ordered)
}

fn trashed_group_ids(tx: &Transaction<'_>, score: i32) -> Result<Vec<String>, StorageError> {
    let mut statement=tx.prepare("SELECT go.entry_id FROM group_order go JOIN entry e ON e.id=go.entry_id WHERE go.group_id=?1 AND e.trashed_at IS NOT NULL ORDER BY go.order_key COLLATE BINARY,go.entry_id COLLATE BINARY")?;
    let rows = statement.query_map([format!("rating-{score:02}")], |row| {
        row.get::<_, String>(0)
    })?;
    Ok(rows.collect::<Result<Vec<_>, rusqlite::Error>>()?)
}

fn insert_ordered_entry(
    tx: &Transaction<'_>,
    score: i32,
    ordered: &[String],
    entry_id: &str,
) -> Result<(), StorageError> {
    let group_id = format!("rating-{score:02}");
    let index = ordered
        .iter()
        .position(|id| id == entry_id)
        .ok_or(StorageError::Conflict)?;
    let trashed = trashed_group_ids(tx, score)?;
    if !trashed.is_empty() {
        let mut all = ordered.to_vec();
        all.extend(trashed);
        return rebalance_group(tx, &group_id, &all);
    }
    let previous_key = index
        .checked_sub(1)
        .and_then(|i| ordered.get(i))
        .map(|id| {
            tx.query_row(
                "SELECT order_key FROM group_order WHERE entry_id=?1",
                [id],
                |row| row.get::<_, String>(0),
            )
        })
        .transpose()?;
    let next_key = ordered
        .get(index + 1)
        .map(|id| {
            tx.query_row(
                "SELECT order_key FROM group_order WHERE entry_id=?1",
                [id],
                |row| row.get::<_, String>(0),
            )
        })
        .transpose()?;
    // Detach the moved row before looking for its new key. This also handles
    // same-tier moves without colliding with the row's former UNIQUE key.
    let detached_group = format!("__rank-move__{entry_id}");
    let changed = tx.execute(
        "UPDATE group_order SET group_id=?1 WHERE entry_id=?2",
        params![detached_group, entry_id],
    )?;
    if changed == 0 {
        return Err(StorageError::Validation(
            "Media is missing its tier order record".into(),
        ));
    }
    if let Some(key) = fractional_order_key(previous_key.as_deref(), next_key.as_deref())
        .filter(|key| key.len() <= MAX_ORDER_KEY_LENGTH)
    {
        tx.execute(
            "UPDATE group_order SET group_id=?1,order_key=?2 WHERE entry_id=?3",
            params![group_id, key, entry_id],
        )?;
        Ok(())
    } else {
        rebalance_group(tx, &group_id, ordered)
    }
}
fn retire_entry_boundaries(tx: &Transaction<'_>, entry: &str) -> Result<(), StorageError> {
    tx.execute(
        "DELETE FROM ranking_boundary WHERE first_id=?1 OR second_id=?1",
        [entry],
    )?;
    Ok(())
}
fn add_manual_boundaries(
    tx: &Transaction<'_>,
    score: i32,
    ordered: &[String],
    index: usize,
    entry: &str,
) -> Result<(), StorageError> {
    let current_sequence: i64 = tx.query_row(
        "SELECT input_sequence FROM ranking_tier_state WHERE score=?1",
        [score],
        |row| row.get(0),
    )?;
    let created_sequence = current_sequence
        .checked_add(1)
        .ok_or_else(|| StorageError::Validation("Ranking sequence is exhausted".into()))?;
    let before = index.checked_sub(1).and_then(|i| ordered.get(i));
    let after = ordered.get(index + 1);
    let mut pairs = Vec::new();
    if let Some(id) = before {
        pairs.push((id.as_str(), entry));
    }
    if let Some(id) = after {
        pairs.push((entry, id.as_str()));
    }
    let weight = if pairs.len() == 2 { 0.5 } else { 1.0 };
    for (preferred, other) in pairs {
        let (first, second) = if preferred < other {
            (preferred, other)
        } else {
            (other, preferred)
        };
        tx.execute("INSERT INTO ranking_boundary(id,score,first_id,second_id,preferred_id,weight,protected,legacy_unlock,created_sequence) VALUES(?1,?2,?3,?4,?5,?6,1,0,?7) ON CONFLICT(score,first_id,second_id) DO UPDATE SET preferred_id=excluded.preferred_id,weight=excluded.weight,protected=1,legacy_unlock=0,created_sequence=excluded.created_sequence", params![format!("boundary-{}",now_nanos()),score,first,second,preferred,weight,created_sequence])?;
        tx.execute("DELETE FROM ranking_boundary_unlock WHERE boundary_id=(SELECT id FROM ranking_boundary WHERE score=?1 AND first_id=?2 AND second_id=?3)",params![score,first,second])?;
    }
    Ok(())
}
fn confirm_binary_insertion(
    tx: &Transaction<'_>,
    score: i32,
    candidate: &str,
    snapshot: &[String],
    index: usize,
) -> Result<(), StorageError> {
    let mut ordered = snapshot.to_vec();
    ordered.retain(|id| id != candidate);
    let index = index.min(ordered.len());
    ordered.insert(index, candidate.to_string());
    tx.execute(
        "UPDATE ranking_entry SET score=?1,placed=1 WHERE entry_id=?2",
        params![score, candidate],
    )?;
    tx.execute("UPDATE entry SET overall_rating=?1,updated_at=?2,version=version+1 WHERE id=?3 AND trashed_at IS NULL", params![score,now_rfc3339(),candidate])?;
    insert_ordered_entry(tx, score, &ordered, candidate)?;
    retire_entry_boundaries(tx, candidate)?;
    add_manual_boundaries(tx, score, &ordered, index, candidate)?;
    tx.execute("INSERT INTO ranking_order_event(id,score,kind,payload_json,occurred_at) VALUES(?1,?2,'binary_insert',?3,?4)", params![format!("order-{}",now_nanos()),score,json!({"entryId":candidate,"index":index,"snapshot":snapshot}).to_string(),now_rfc3339()])?;
    Ok(())
}
fn apply_adjacent_duel_correction(
    tx: &Transaction<'_>,
    score: i32,
    winner: &str,
    loser: &str,
    judgment_id: &str,
) -> Result<(), StorageError> {
    let mut order = tier_ids(tx, score, true)?;
    let Some(winner_index) = order.iter().position(|id| id == winner) else {
        return Ok(());
    };
    let Some(loser_index) = order.iter().position(|id| id == loser) else {
        return Ok(());
    };
    if winner_index <= loser_index {
        return Ok(());
    }
    // Move only the directly preferred work. Do not cross any still-protected
    // manual adjacent boundary; those remain authoritative until contradicted.
    for index in loser_index..winner_index {
        let a = &order[index];
        let b = &order[index + 1];
        let (first, second) = if a < b { (a, b) } else { (b, a) };
        let protected:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM ranking_boundary WHERE score=?1 AND first_id=?2 AND second_id=?3 AND protected=1)",params![score,first,second],|r|r.get(0))?;
        if protected {
            return Ok(());
        }
    }
    let work = order.remove(winner_index);
    order.insert(loser_index, work);
    renumber_tier(tx, score, &order)?;
    tx.execute(
        "UPDATE ranking_tier_state SET order_revision=order_revision+1 WHERE score=?1",
        [score],
    )?;
    tx.execute("INSERT INTO ranking_order_event(id,score,kind,payload_json,occurred_at) VALUES(?1,?2,'duel_correction',?3,?4)",params![format!("order-{}",now_nanos()),score,json!({"winnerId":winner,"loserId":loser,"judgmentId":judgment_id,"newUpperIndex":loser_index}).to_string(),now_rfc3339()])?;
    Ok(())
}
fn binary_midpoint(low: usize, high: usize) -> Option<usize> {
    (low < high).then_some(low + (high - low) / 2)
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BinaryStep {
    Bounds(usize, usize),
    Confirm(usize),
    Skip,
}
fn binary_step(low: usize, high: usize, pivot: usize, answer: DuelAnswer) -> BinaryStep {
    match answer {
        DuelAnswer::LeftWin => BinaryStep::Bounds(low, pivot),
        DuelAnswer::RightWin => BinaryStep::Bounds(pivot + 1, high),
        DuelAnswer::Tie => BinaryStep::Confirm(pivot + 1),
        DuelAnswer::Skip => BinaryStep::Skip,
    }
}
fn binary_suggestion_threshold(placed: usize, unplaced: usize) -> bool {
    unplaced > 0
        && (placed == 0
            || placed.saturating_mul(10) >= placed.saturating_add(unplaced).saturating_mul(9))
}
fn binary_step_for_state(state: &RankingState, score: i32) -> BinaryPlacementNextStep {
    if let Some(session) = state.active_session.as_ref() {
        if session.score == score {
            return match session.mode.as_str() {
                "binary" | "seed" | "confirm" => BinaryPlacementNextStep::Binary,
                "normal" => BinaryPlacementNextStep::Normal,
                _ => BinaryPlacementNextStep::Done,
            };
        }
    }
    if state
        .tiers
        .iter()
        .find(|tier| tier.score == score)
        .is_some_and(|tier| !tier.unplaced_ids.is_empty())
    {
        BinaryPlacementNextStep::OfferBinary
    } else if state
        .tiers
        .iter()
        .find(|tier| tier.score == score)
        .is_some_and(|tier| tier.placed_ids.len() > 200)
    {
        BinaryPlacementNextStep::RequiresSubset
    } else {
        BinaryPlacementNextStep::Done
    }
}
fn prompt_from_session(session: &SessionRow, duel_id: &str, left: &str, right: &str) -> DuelPrompt {
    let seed = session.mode == "binary" && session.current_pivot_id.is_some();
    let binary = session.mode == "binary" && !seed;
    DuelPrompt {
        session_id: session.id.clone(),
        duel_id: duel_id.into(),
        kind: if seed {
            "seed".into()
        } else {
            session.mode.clone()
        },
        left_entry_id: left.into(),
        right_entry_id: right.into(),
        candidate_entry_id: if binary || seed {
            session.candidate_id.clone()
        } else {
            None
        },
        step: if binary {
            session
                .presented_step
                .or(Some((session.answered_count + 1) as i32))
        } else {
            None
        },
        total_steps: if binary {
            Some(
                (serde_json::from_str::<Vec<String>>(&session.snapshot_order_json)
                    .map(|ids| ids.len() + 1)
                    .unwrap_or(1) as f64)
                    .log2()
                    .ceil() as i32,
            )
        } else {
            None
        },
        proposed_position: None,
        tier_length: None,
        previous_entry_id: None,
        next_entry_id: None,
    }
}
fn confirm_prompt(
    session: &SessionRow,
    snapshot: &[String],
    candidate: &str,
    index: usize,
) -> DuelPrompt {
    DuelPrompt {
        session_id: session.id.clone(),
        duel_id: format!("confirm-{}", session.id),
        kind: "confirm".into(),
        left_entry_id: candidate.into(),
        right_entry_id: candidate.into(),
        candidate_entry_id: Some(candidate.into()),
        step: None,
        total_steps: None,
        proposed_position: Some(index as i32),
        tier_length: Some(snapshot.len() as i32),
        previous_entry_id: index.checked_sub(1).and_then(|i| snapshot.get(i)).cloned(),
        next_entry_id: snapshot.get(index).cloned(),
    }
}
fn select_normal_pair(
    tx: &Transaction<'_>,
    score: i32,
    entries: &[String],
    revisit: bool,
    avoid_pair: Option<&(String, String)>,
    session_id: &str,
    answered_count: i64,
) -> Result<Option<(String, String)>, StorageError> {
    if entries.len() < 2 {
        return Ok(None);
    }
    if entries.len() > 200 {
        return Err(StorageError::Validation(
            "Filter to 200 or fewer placed works to start a duel session".into(),
        ));
    }
    let seed: i64 = tx.query_row(
        "SELECT seed FROM ranking_session WHERE id=?1",
        [session_id],
        |r| r.get(0),
    )?;
    let fit = fit_tier(tx, score)?;
    let fit_indices: HashMap<&str, usize> = fit
        .entry_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    let participant_indices = entries
        .iter()
        .map(|id| {
            fit_indices
                .get(id.as_str())
                .copied()
                .ok_or(StorageError::Conflict)
        })
        .collect::<Result<Vec<_>, _>>()?;
    // Solve one sparse inverse column per participant; every pair variance
    // then comes from the same Laplace covariance approximation.
    let mut covariance = vec![vec![0.0; entries.len()]; entries.len()];
    for (i, &global_i) in participant_indices.iter().enumerate() {
        let mut unit = vec![0.0; fit.entry_ids.len()];
        unit[global_i] = 1.0;
        let column = solve_spd(&fit.hessian, unit)?;
        for (j, &global_j) in participant_indices.iter().enumerate() {
            covariance[i][j] = column[global_j];
        }
    }
    let mut endpoint_counts: HashMap<&str, usize> =
        entries.iter().map(|id| (id.as_str(), 0)).collect();
    let mut pair_history: HashMap<(String, String), Vec<usize>> = HashMap::new();
    let mut components: Vec<usize> = (0..entries.len()).collect();
    let mut skipped = HashSet::<(String, String)>::new();
    {
        let mut stmt=tx.prepare("SELECT id,left_id,right_id,answer,retracted,session_id FROM ranking_judgment WHERE score=?1 ORDER BY occurred_at,id")?;
        let rows = stmt.query_map([score], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, bool>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?;
        let mut sequence = 0usize;
        for row in rows {
            let (_id, left, right, answer, retracted, judgment_session) = row?;
            let pair = ordered_pair(&left, &right);
            if judgment_session == session_id && answer == "skip" {
                skipped.insert(pair.clone());
            }
            // Side balance counts every display, including skips and retracted judgments.
            if answer != "skip" {
                sequence += 1;
                if let Some(count) = endpoint_counts.get_mut(left.as_str()) {
                    *count += 1;
                }
                if let Some(count) = endpoint_counts.get_mut(right.as_str()) {
                    *count += 1;
                }
                pair_history.entry(pair).or_default().push(sequence);
                if !retracted {
                    if let (Some(i), Some(j)) = (
                        entries.iter().position(|id| id == &left),
                        entries.iter().position(|id| id == &right),
                    ) {
                        union_components(&mut components, i, j);
                    }
                }
            }
        }
    }
    let mut side_counts: HashMap<&str, (i64, i64)> =
        entries.iter().map(|id| (id.as_str(), (0, 0))).collect();
    {
        let mut stmt = tx.prepare(
            "SELECT left_id,right_id FROM ranking_judgment WHERE score=?1 ORDER BY occurred_at,id",
        )?;
        for row in stmt.query_map([score], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })? {
            let (left, right) = row?;
            if let Some(count) = side_counts.get_mut(left.as_str()) {
                count.0 += 1;
            }
            if let Some(count) = side_counts.get_mut(right.as_str()) {
                count.1 += 1;
            }
        }
    }
    let mut boundaries = HashMap::<(String, String), (String, bool)>::new();
    {
        let mut stmt = tx.prepare(
            "SELECT first_id,second_id,preferred_id,protected FROM ranking_boundary WHERE score=?1",
        )?;
        for row in stmt.query_map([score], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, bool>(3)?,
            ))
        })? {
            let (first, second, preferred, protected) = row?;
            boundaries.insert((first, second), (preferred, protected));
        }
    }
    let component_roots = (0..entries.len())
        .map(|i| component_root(&mut components, i))
        .collect::<Vec<_>>();
    let disconnected = component_roots
        .iter()
        .copied()
        .collect::<HashSet<_>>()
        .len()
        > 1;
    let total_history = pair_history.values().map(Vec::len).sum::<usize>();
    let has_bridge = disconnected
        && (0..entries.len()).any(|i| {
            ((i + 1)..entries.len()).any(|j| {
                component_roots[i] != component_roots[j]
                    && !cooling_down(
                        &pair_history,
                        total_history,
                        &entries[i],
                        &entries[j],
                        revisit,
                    )
            })
        });
    let min_coverage = (0..entries.len())
        .map(|i| endpoint_counts[entries[i].as_str()])
        .min()
        .unwrap_or(0);
    let explore = answered_count > 0 && answered_count % 5 == 0;
    let n = entries.len() as f64;
    let h = 5.0_f64.max((n / 20.0).ceil());
    let mut best: Option<(bool, f64, f64, u64, usize, usize)> = None;
    for i in 0..entries.len() {
        for j in i + 1..entries.len() {
            let bridged = component_roots[i] != component_roots[j];
            if avoid_pair.is_some_and(|pair| pair == &ordered_pair(&entries[i], &entries[j])) {
                continue;
            }
            if has_bridge && !bridged {
                continue;
            }
            if skipped.contains(&ordered_pair(&entries[i], &entries[j]))
                || cooling_down(
                    &pair_history,
                    total_history,
                    &entries[i],
                    &entries[j],
                    revisit,
                )
            {
                continue;
            }
            if explore
                && endpoint_counts[entries[i].as_str()] != min_coverage
                && endpoint_counts[entries[j].as_str()] != min_coverage
            {
                continue;
            }
            let gi = participant_indices[i];
            let gj = participant_indices[j];
            let variance =
                (covariance[i][i] + covariance[j][j] - covariance[i][j] - covariance[j][i])
                    .max(0.0);
            let d = fit.means[gi] - fit.means[gj];
            let probabilities = davidson_probabilities(fit.means[gi], fit.means[gj]);
            let information = ((probabilities[0] + probabilities[1])
                - (probabilities[0] - probabilities[1]).powi(2))
            .max(0.0)
                / 4.0;
            let ig = 0.5 * (1.0 + variance * information).ln();
            let coverage = 1.0
                + 0.5 / (1.0 + endpoint_counts[entries[i].as_str()] as f64)
                + 0.5 / (1.0 + endpoint_counts[entries[j].as_str()] as f64);
            let pair = ordered_pair(&entries[i], &entries[j]);
            let repeats = pair_history.get(&pair).map_or(0, Vec::len);
            let repeat = 1.0 / (1.0 + repeats as f64).sqrt();
            let gap = j - i;
            let rank_factor = (-(gap as f64) / h).exp();
            let current_probability = normal_cdf(-d / variance.sqrt().max(1e-12));
            let order_conflict = (current_probability > 0.65) as u8;
            let boundary_conflict = boundaries.get(&pair).is_some_and(|(preferred, protected)| {
                *protected
                    && ((preferred == &entries[i] && d < 0.0)
                        || (preferred == &entries[j] && d > 0.0))
            }) as u8;
            let conflict = 1.0 + 2.0 * boundary_conflict as f64 + order_conflict as f64;
            let local_correction_bonus = if gap == 1 && order_conflict == 1 {
                10.0
            } else {
                1.0
            };
            let utility = ig * rank_factor * coverage * conflict * repeat * local_correction_bonus;
            let coverage_priority = if bridged { coverage } else { 0.0 };
            let tie = stable_pair_hash(seed, &entries[i], &entries[j]);
            let key = (bridged, coverage_priority, utility, tie, i, j);
            if best
                .as_ref()
                .is_none_or(|current| compare_pair_priority(&key, current).is_gt())
            {
                best = Some(key);
            }
        }
    }
    let Some((_, _, _, _, i, j)) = best else {
        return Ok(None);
    };
    let (left_balance, right_balance) = orientation_costs(
        *side_counts.get(entries[i].as_str()).unwrap_or(&(0, 0)),
        *side_counts.get(entries[j].as_str()).unwrap_or(&(0, 0)),
    );
    let (left, right) = if left_balance < right_balance
        || (left_balance == right_balance
            && stable_pair_hash(seed, &entries[i], &entries[j]) % 2 == 0)
    {
        (entries[i].clone(), entries[j].clone())
    } else {
        (entries[j].clone(), entries[i].clone())
    };
    Ok(Some((left, right)))
}

fn ordered_pair(left: &str, right: &str) -> (String, String) {
    if left < right {
        (left.into(), right.into())
    } else {
        (right.into(), left.into())
    }
}
fn skipped_seed_pairs(
    tx: &Transaction<'_>,
    score: i32,
) -> Result<HashSet<(String, String)>, StorageError> {
    let mut pairs = HashSet::new();
    let mut stmt = tx.prepare(
        "SELECT left_id,right_id FROM ranking_judgment WHERE score=?1 AND answer='skip'",
    )?;
    for row in stmt.query_map([score], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (left, right) = row?;
        pairs.insert(ordered_pair(&left, &right));
    }
    Ok(pairs)
}
fn latest_normal_pair(
    tx: &Transaction<'_>,
    score: i32,
) -> Result<Option<(String, String)>, StorageError> {
    tx.query_row(
        "SELECT left_id,right_id FROM ranking_judgment WHERE score=?1 AND kind='normal' AND retracted=0 ORDER BY occurred_at DESC,id DESC LIMIT 1",
        [score],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )
    .optional()
    .map(|pair| pair.map(|(left, right)| ordered_pair(&left, &right)))
    .map_err(Into::into)
}
fn cooling_down(
    history: &HashMap<(String, String), Vec<usize>>,
    total_answers: usize,
    left: &str,
    right: &str,
    revisit: bool,
) -> bool {
    if revisit {
        return false;
    }
    let Some(items) = history.get(&ordered_pair(left, right)) else {
        return false;
    };
    items
        .last()
        .is_some_and(|last| total_answers.saturating_sub(*last) < 20)
}
fn union_components(parent: &mut [usize], a: usize, b: usize) {
    let ra = component_root(parent, a);
    let rb = component_root(parent, b);
    if ra != rb {
        parent[rb] = ra;
    }
}
fn component_root(parent: &mut [usize], mut item: usize) -> usize {
    while parent[item] != item {
        let grand = parent[parent[item]];
        parent[item] = grand;
        item = grand;
    }
    item
}
fn davidson_probabilities(left: f64, right: f64) -> [f64; 3] {
    let scores = [left, right, 0.5_f64.ln() + 0.5 * (left + right)];
    let maximum = scores[0].max(scores[1]).max(scores[2]);
    let raw = scores.map(|v| (v - maximum).exp());
    let sum = raw.iter().sum::<f64>();
    [raw[0] / sum, raw[1] / sum, raw[2] / sum]
}
fn stable_pair_hash(seed: i64, left: &str, right: &str) -> u64 {
    let mut value = (seed as u64) ^ 0xcbf29ce484222325;
    for byte in left.bytes().chain([0]).chain(right.bytes()) {
        value ^= u64::from(byte);
        value = value.wrapping_mul(0x100000001b3);
    }
    value
}
fn orientation_costs(a: (i64, i64), b: (i64, i64)) -> (i64, i64) {
    let cost = |x: i64, y: i64| {
        let v = x - y;
        v * v
    };
    (
        cost(a.0 + 1, a.1) + cost(b.0, b.1 + 1),
        cost(a.0, a.1 + 1) + cost(b.0 + 1, b.1),
    )
}
fn compare_pair_priority(
    a: &(bool, f64, f64, u64, usize, usize),
    b: &(bool, f64, f64, u64, usize, usize),
) -> std::cmp::Ordering {
    a.0.cmp(&b.0)
        .then_with(|| a.1.total_cmp(&b.1))
        .then_with(|| a.2.total_cmp(&b.2))
        .then_with(|| a.3.cmp(&b.3))
}
fn fit_and_reconcile(tx: &Transaction<'_>, score: i32) -> Result<(), StorageError> {
    tx.execute_batch("SAVEPOINT ranking_reconcile")?;
    match fit_and_reconcile_inner(tx, score) {
        Ok(()) => {
            tx.execute_batch("RELEASE ranking_reconcile")?;
            Ok(())
        }
        Err(error) => {
            // The accepted judgment and pending flag are written by the caller
            // before this savepoint. Roll back only fit/order side effects.
            tx.execute_batch("ROLLBACK TO ranking_reconcile; RELEASE ranking_reconcile")?;
            Err(error)
        }
    }
}

fn fit_and_reconcile_inner(tx: &Transaction<'_>, score: i32) -> Result<(), StorageError> {
    let fit = fit_tier(tx, score)?;
    store_fit(tx, score, &fit)?;
    let pending: bool = tx.query_row(
        "SELECT pending_reconcile FROM ranking_tier_state WHERE score=?1",
        [score],
        |row| row.get(0),
    )?;
    if !pending {
        return Ok(());
    }

    let mut order = tier_ids(tx, score, true)?;
    let indices: HashMap<String, usize> = fit
        .entry_ids
        .iter()
        .cloned()
        .enumerate()
        .map(|(i, id)| (id, i))
        .collect();
    let mut variance_cache: HashMap<(usize, usize), f64> = HashMap::new();
    let mut changed = Vec::new();
    let mut scans = 0usize;
    let max_swaps = order.len().saturating_mul(order.len()).max(1);
    let delta = 1.5_f64.ln();
    loop {
        let mut swapped = false;
        for i in 0..order.len().saturating_sub(1) {
            let a = order[i].clone();
            let b = order[i + 1].clone();
            let Some(&ai) = indices.get(&a) else { continue };
            let Some(&bi) = indices.get(&b) else { continue };
            let protected: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM ranking_boundary WHERE score=?1 AND first_id=?2 AND second_id=?3 AND protected=1)",
                params![score,if a<b {&a} else {&b},if a<b {&b} else {&a}], |row| row.get(0))?;
            if protected {
                continue;
            }
            let d = fit.means[bi] - fit.means[ai];
            let key = if ai < bi { (ai, bi) } else { (bi, ai) };
            let v = if let Some(value) = variance_cache.get(&key) {
                *value
            } else {
                let value = contrast_variance(&fit.hessian, ai, bi)?;
                variance_cache.insert(key, value);
                value
            };
            if !v.is_finite() || v <= 0.0 || d <= delta {
                continue;
            }
            let confidence = normal_cdf((d - delta) / v.sqrt());
            if confidence < 0.90 {
                continue;
            }
            order.swap(i, i + 1);
            changed.push((a, b, i));
            swapped = true;
            scans += 1;
            if scans > max_swaps {
                return Err(StorageError::Validation(
                    "Ranking reconciliation exceeded its safe work limit".into(),
                ));
            }
            break;
        }
        if !swapped {
            break;
        }
    }
    if !changed.is_empty() {
        renumber_tier(tx, score, &order)?;
        tx.execute(
            "UPDATE ranking_tier_state SET order_revision=order_revision+1 WHERE score=?1",
            [score],
        )?;
        let now = now_rfc3339();
        for (a, b, index) in changed {
            tx.execute("INSERT INTO ranking_order_event(id,score,kind,payload_json,occurred_at) VALUES(?1,?2,'automatic_swap',?3,?4)", params![format!("order-{}",now_nanos()),score,json!({"upperEntryId":b,"lowerEntryId":a,"newUpperIndex":index}).to_string(),now])?;
        }
    }
    tx.execute(
        "UPDATE ranking_tier_state SET pending_reconcile=0 WHERE score=?1",
        [score],
    )?;
    Ok(())
}

fn fit_without_reconcile(tx: &Transaction<'_>, score: i32) -> Result<(), StorageError> {
    let fit = fit_tier(tx, score)?;
    store_fit(tx, score, &fit)
}
fn unlock_opposing_boundary(
    tx: &Transaction<'_>,
    score: i32,
    left: &str,
    right: &str,
    winner: &str,
    judgment_id: &str,
) -> Result<(), StorageError> {
    let (first, second) = if left < right {
        (left, right)
    } else {
        (right, left)
    };
    let boundary_id:Option<String>=tx.query_row("SELECT b.id FROM ranking_boundary b JOIN ranking_judgment j ON j.id=?5 WHERE b.score=?1 AND b.first_id=?2 AND b.second_id=?3 AND b.preferred_id<>?4 AND j.input_sequence>b.created_sequence",params![score,first,second,winner,judgment_id],|row|row.get(0)).optional()?;
    if let Some(boundary_id) = boundary_id {
        tx.execute(
            "INSERT OR IGNORE INTO ranking_boundary_unlock(boundary_id,judgment_id) VALUES(?1,?2)",
            params![boundary_id, judgment_id],
        )?;
        tx.execute(
            "UPDATE ranking_boundary SET protected=0 WHERE id=?1",
            [boundary_id],
        )?;
    }
    Ok(())
}

struct TierFit {
    entry_ids: Vec<String>,
    means: Vec<f64>,
    hessian: Vec<BTreeMap<usize, f64>>,
    model_version: i64,
}
fn fit_tier(tx: &Transaction<'_>, score: i32) -> Result<TierFit, StorageError> {
    let mut entry_ids = {
        let mut stmt=tx.prepare("SELECT re.entry_id FROM ranking_entry re JOIN entry e ON e.id=re.entry_id WHERE re.score=?1 AND e.trashed_at IS NULL ORDER BY re.entry_id COLLATE BINARY")?;
        let ids = stmt
            .query_map([score], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        ids
    };
    entry_ids.sort();
    let n = entry_ids.len();
    let index: HashMap<String, usize> = entry_ids
        .iter()
        .cloned()
        .enumerate()
        .map(|(i, id)| (id, i))
        .collect();
    let mut observations = Vec::new();
    {
        let mut stmt=tx.prepare("SELECT left_id,right_id,answer FROM ranking_judgment WHERE score=?1 AND retracted=0 AND answer<>'skip' ORDER BY id COLLATE BINARY")?;
        for row in stmt.query_map([score], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })? {
            let (left, right, answer) = row?;
            if let (Some(&i), Some(&j)) = (index.get(&left), index.get(&right)) {
                observations.push((
                    i,
                    j,
                    match answer.as_str() {
                        "leftWin" => 0,
                        "rightWin" => 1,
                        "tie" => 2,
                        _ => continue,
                    },
                ));
            }
        }
    }
    let mut boundaries = Vec::new();
    {
        let mut stmt=tx.prepare("SELECT preferred_id,CASE WHEN preferred_id=first_id THEN second_id ELSE first_id END,weight FROM ranking_boundary WHERE score=?1")?;
        for row in stmt.query_map([score], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, f64>(2)?,
            ))
        })? {
            let (preferred, other, weight) = row?;
            if let (Some(&a), Some(&b)) = (index.get(&preferred), index.get(&other)) {
                boundaries.push((a, b, weight));
            }
        }
    }
    let mut theta = vec![0.0; n];
    let mut converged = n == 0;
    for _ in 0..200 {
        let (objective, gradient, hessian) = posterior(&theta, &observations, &boundaries);
        let direction = solve_spd(&hessian, gradient.iter().map(|g| -g).collect())?;
        let max_direction = direction.iter().fold(0.0_f64, |m, v| m.max(v.abs()));
        if max_direction < 1e-6 {
            converged = true;
            break;
        }
        let mut scale = 1.0;
        let mut candidate = vec![0.0; n];
        let mut accepted = false;
        while scale >= 1.0 / 65536.0 {
            for i in 0..n {
                candidate[i] = theta[i] + scale * direction[i];
            }
            if posterior(&candidate, &observations, &boundaries).0 <= objective + 1e-12 {
                accepted = true;
                break;
            }
            scale *= 0.5;
        }
        if !accepted {
            return Err(StorageError::Validation(
                "Ranking model line search failed".into(),
            ));
        }
        let actual = scale * max_direction;
        theta.clone_from_slice(&candidate);
        if actual < 1e-6 {
            converged = true;
            break;
        }
    }
    if !converged {
        return Err(StorageError::Validation(
            "Ranking model did not converge".into(),
        ));
    }
    let mean = if n == 0 {
        0.0
    } else {
        theta.iter().sum::<f64>() / n as f64
    };
    for value in &mut theta {
        *value -= mean;
    }
    let (_, _, hessian) = posterior(&theta, &observations, &boundaries);
    let model_version = 1;
    Ok(TierFit {
        entry_ids,
        means: theta,
        hessian,
        model_version,
    })
}

fn posterior(
    theta: &[f64],
    observations: &[(usize, usize, usize)],
    boundaries: &[(usize, usize, f64)],
) -> (f64, Vec<f64>, Vec<BTreeMap<usize, f64>>) {
    let n = theta.len();
    let mut objective = 0.5 * theta.iter().map(|x| x * x).sum::<f64>();
    let mut gradient = theta.to_vec();
    let mut hessian = vec![BTreeMap::new(); n];
    for i in 0..n {
        hessian[i].insert(i, 1.0);
    }
    const NU: f64 = 0.5;
    for &(i, j, outcome) in observations {
        let scores = [theta[i], theta[j], NU.ln() + 0.5 * (theta[i] + theta[j])];
        let max = scores[0].max(scores[1]).max(scores[2]);
        let terms = [
            (scores[0] - max).exp(),
            (scores[1] - max).exp(),
            (scores[2] - max).exp(),
        ];
        let sum = terms.iter().sum::<f64>();
        let p = [terms[0] / sum, terms[1] / sum, terms[2] / sum];
        objective += max + sum.ln() - scores[outcome];
        let fi = [1.0, 0.0, 0.5];
        let fj = [0.0, 1.0, 0.5];
        let mi = p[0] * fi[0] + p[1] * fi[1] + p[2] * fi[2];
        let mj = p[0] * fj[0] + p[1] * fj[1] + p[2] * fj[2];
        gradient[i] += mi - fi[outcome];
        gradient[j] += mj - fj[outcome];
        let eii = p[0] * fi[0] * fi[0] + p[1] * fi[1] * fi[1] + p[2] * fi[2] * fi[2];
        let ejj = p[0] * fj[0] * fj[0] + p[1] * fj[1] * fj[1] + p[2] * fj[2] * fj[2];
        let eij = p[2] * fi[2] * fj[2];
        add_hessian(&mut hessian, i, i, eii - mi * mi);
        add_hessian(&mut hessian, j, j, ejj - mj * mj);
        let cross = eij - mi * mj;
        add_hessian(&mut hessian, i, j, cross);
        add_hessian(&mut hessian, j, i, cross);
    }
    for &(preferred, other, weight) in boundaries {
        let diff = theta[preferred] - theta[other];
        let sigmoid = if diff >= 0.0 {
            1.0 / (1.0 + (-diff).exp())
        } else {
            let e = diff.exp();
            e / (1.0 + e)
        };
        objective += weight * softplus(-diff);
        let derivative = weight * (sigmoid - 1.0);
        gradient[preferred] += derivative;
        gradient[other] -= derivative;
        let curvature = weight * sigmoid * (1.0 - sigmoid);
        add_hessian(&mut hessian, preferred, preferred, curvature);
        add_hessian(&mut hessian, other, other, curvature);
        add_hessian(&mut hessian, preferred, other, -curvature);
        add_hessian(&mut hessian, other, preferred, -curvature);
    }
    (objective, gradient, hessian)
}
fn softplus(value: f64) -> f64 {
    if value > 30.0 {
        value
    } else if value < -30.0 {
        value.exp()
    } else {
        (1.0 + value.exp()).ln()
    }
}
fn add_hessian(matrix: &mut [BTreeMap<usize, f64>], row: usize, col: usize, value: f64) {
    *matrix[row].entry(col).or_insert(0.0) += value;
}
fn solve_spd(matrix: &[BTreeMap<usize, f64>], rhs: Vec<f64>) -> Result<Vec<f64>, StorageError> {
    let n = rhs.len();
    if n == 0 {
        return Ok(Vec::new());
    }
    let norm_rhs = rhs.iter().map(|v| v * v).sum::<f64>().sqrt();
    let tolerance = 1e-10 * norm_rhs.max(1.0);
    let mut solution = vec![0.0; n];
    let mut residual = rhs;
    let mut direction = residual.clone();
    let mut residual_norm = residual.iter().map(|v| v * v).sum::<f64>();
    if residual_norm.sqrt() <= tolerance {
        return Ok(solution);
    }
    let max_iterations = n.saturating_mul(4).saturating_add(100).min(20000);
    for _ in 0..max_iterations {
        let mut product = vec![0.0; n];
        for (row, values) in matrix.iter().enumerate() {
            for (col, value) in values {
                product[row] += value * direction[*col];
            }
        }
        let denominator = direction
            .iter()
            .zip(&product)
            .map(|(a, b)| a * b)
            .sum::<f64>();
        if !denominator.is_finite() || denominator <= 0.0 {
            return Err(StorageError::Validation(
                "Ranking Hessian is not positive definite".into(),
            ));
        }
        let alpha = residual_norm / denominator;
        for i in 0..n {
            solution[i] += alpha * direction[i];
            residual[i] -= alpha * product[i];
        }
        let next_norm = residual.iter().map(|v| v * v).sum::<f64>();
        if next_norm.sqrt() <= tolerance {
            return if solution.iter().all(|x| x.is_finite()) {
                Ok(solution)
            } else {
                Err(StorageError::Validation(
                    "Ranking fit produced a nonfinite result".into(),
                ))
            };
        }
        let beta = next_norm / residual_norm;
        for i in 0..n {
            direction[i] = residual[i] + beta * direction[i];
        }
        residual_norm = next_norm;
    }
    Err(StorageError::Validation(
        "Ranking sparse solve did not reach its tolerance".into(),
    ))
}
fn contrast_variance(
    hessian: &[BTreeMap<usize, f64>],
    a: usize,
    b: usize,
) -> Result<f64, StorageError> {
    let mut contrast = vec![0.0; hessian.len()];
    contrast[a] = 1.0;
    contrast[b] -= 1.0;
    let solution = solve_spd(hessian, contrast)?;
    Ok(solution[a] - solution[b])
}
fn store_fit(tx: &Transaction<'_>, score: i32, fit: &TierFit) -> Result<(), StorageError> {
    let input_sequence: i64 = tx.query_row(
        "SELECT input_sequence FROM ranking_tier_state WHERE score=?1",
        [score],
        |row| row.get(0),
    )?;
    let indices: HashMap<String, usize> = fit
        .entry_ids
        .iter()
        .cloned()
        .enumerate()
        .map(|(i, id)| (id, i))
        .collect();
    let order = tier_ids(tx, score, true)?;
    let mut contrasts = Vec::new();
    for pair in order.windows(2) {
        if let (Some(&a), Some(&b)) = (indices.get(&pair[0]), indices.get(&pair[1])) {
            contrasts.push((
                pair[0].clone(),
                pair[1].clone(),
                contrast_variance(&fit.hessian, a, b)?,
            ));
        }
    }
    tx.execute("INSERT INTO ranking_fit(score,input_sequence,entry_ids_json,means_json,covariance_json,model_version) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(score) DO UPDATE SET input_sequence=excluded.input_sequence,entry_ids_json=excluded.entry_ids_json,means_json=excluded.means_json,covariance_json=excluded.covariance_json,model_version=excluded.model_version",params![score,input_sequence,serde_json::to_string(&fit.entry_ids)?,serde_json::to_string(&fit.means)?,serde_json::to_string(&contrasts)?,fit.model_version])?;
    tx.execute(
        "UPDATE ranking_tier_state SET fitted_sequence=input_sequence WHERE score=?1",
        [score],
    )?;
    Ok(())
}
fn normal_cdf(value: f64) -> f64 {
    // Abramowitz-Stegun 7.1.26; absolute error below 8e-8.
    let x = value.abs();
    let t = 1.0 / (1.0 + 0.2316419 * x);
    let density = (-0.5 * x * x).exp() / 2.5066282746310002;
    let tail = density
        * t
        * (0.319381530
            + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    if value >= 0.0 {
        1.0 - tail
    } else {
        tail
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use tastellar_domain::{EntryInput, RankingPosition};

    fn test_entry(id: &str, rating: Option<i32>) -> EntryInput {
        EntryInput {
            id: id.into(),
            title: id.into(),
            disposition: "experienced".into(),
            media_type_id: None,
            overall_rating: rating,
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

    #[test]
    fn binary_bounds_cover_empty_single_even_and_odd_tiers() {
        for count in [0usize, 1, 4, 5] {
            let mut low = 0;
            let mut high = count;
            let mut pivots = Vec::new();
            while let Some(mid) = binary_midpoint(low, high) {
                assert!(mid < count);
                pivots.push(mid);
                (low, high) = match binary_step(low, high, mid, DuelAnswer::LeftWin) {
                    BinaryStep::Bounds(l, h) => (l, h),
                    _ => panic!("win must narrow bounds"),
                };
            }
            assert_eq!(low, 0);
            assert!(pivots.len() <= (usize::BITS as usize));

            let mut low = 0;
            let mut high = count;
            while let Some(mid) = binary_midpoint(low, high) {
                (low, high) = match binary_step(low, high, mid, DuelAnswer::RightWin) {
                    BinaryStep::Bounds(l, h) => (l, h),
                    _ => panic!("loss must narrow bounds"),
                };
            }
            assert_eq!(low, count);
        }
        assert_eq!(binary_midpoint(0, 4), Some(2));
        assert_eq!(binary_midpoint(0, 5), Some(2));
        assert_eq!(binary_midpoint(3, 3), None);
    }

    #[test]
    fn binary_tie_goes_after_pivot_and_skip_does_not_choose_a_gap() {
        assert_eq!(
            binary_step(0, 5, 2, DuelAnswer::Tie),
            BinaryStep::Confirm(3)
        );
        assert_eq!(binary_step(0, 5, 2, DuelAnswer::Skip), BinaryStep::Skip);
    }

    #[test]
    fn binary_suggestion_uses_the_placed_share_boundary() {
        assert!(binary_suggestion_threshold(9, 1));
        assert!(!binary_suggestion_threshold(8, 1));
        assert!(binary_suggestion_threshold(0, 3));
        assert!(!binary_suggestion_threshold(10, 0));
    }

    #[test]
    fn fractional_keys_stay_ordered_and_rebalance_when_a_gap_runs_out() {
        let mut keys = vec!["A".to_string(), "B".to_string()];
        let mut rebalanced = false;
        for _ in 0..300 {
            let candidate = fractional_order_key(Some(&keys[0]), Some(&keys[1]));
            let key = match candidate.filter(|value| value.len() <= MAX_ORDER_KEY_LENGTH) {
                Some(value) => value,
                None => {
                    rebalanced = true;
                    keys = spaced_order_keys(keys.len()).unwrap();
                    fractional_order_key(Some(&keys[0]), Some(&keys[1])).unwrap()
                }
            };
            keys.insert(1, key);
            assert!(keys.windows(2).all(|pair| pair[0] < pair[1]));
        }
        assert!(rebalanced);
        let spaced = spaced_order_keys(512).unwrap();
        assert_eq!(spaced.len(), 512);
        assert!(spaced.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(ORDER_KEY_ALGORITHM_VERSION, 2);
    }

    #[test]
    fn sparse_fit_keeps_entries_above_256() {
        let root = std::env::temp_dir().join(format!("ranking-sparse-{}", crate::now_nanos()));
        let mut storage = Storage::open(&root).unwrap();
        let ids = (0..260)
            .map(|i| format!("sparse-{i:03}"))
            .collect::<Vec<_>>();
        let keys = spaced_order_keys(ids.len()).unwrap();
        let tx = storage.conn.transaction().unwrap();
        for (index, (id, key)) in ids.iter().zip(keys).enumerate() {
            tx.execute("INSERT INTO entry(id,title,disposition,overall_rating,created_at,updated_at,import_order) VALUES(?1,?2,'experienced',7,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',?3)",params![id,id,index as i64]).unwrap();
            tx.execute(
                "INSERT INTO ranking_entry(entry_id,score,placed) VALUES(?1,7,1)",
                [id],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO group_order(entry_id,group_id,order_key) VALUES(?1,'rating-07',?2)",
                params![id, key],
            )
            .unwrap();
        }
        let fit = fit_tier(&tx, 7).unwrap();
        assert_eq!(fit.entry_ids.len(), 260);
        let solved = solve_spd(&fit.hessian, vec![1.0; fit.entry_ids.len()]).unwrap();
        assert_eq!(solved.len(), 260);
        tx.rollback().unwrap();
        drop(storage);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn manual_move_undo_restores_exact_order_rating_and_rejects_stale_revision() {
        let root = std::env::temp_dir().join(format!("ranking-undo-{}", crate::now_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let mut storage = Storage::open(&root).unwrap();
        for id in ["work-a", "work-b"] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .save_entry(revision, test_entry(id, Some(7)))
                .unwrap();
        }
        for id in ["work-a", "work-b"] {
            let state = storage.load_ranking().unwrap();
            storage
                .move_ranking_entry(
                    state.revision,
                    id,
                    7,
                    true,
                    RankingPosition {
                        kind: "end".into(),
                        anchor_id: None,
                    },
                )
                .unwrap();
        }
        let before = storage.load_ranking().unwrap();
        assert_eq!(
            before
                .tiers
                .iter()
                .find(|tier| tier.score == 7)
                .unwrap()
                .placed_ids,
            ["work-a", "work-b"]
        );
        let moved = storage
            .move_ranking_entry(
                before.revision,
                "work-a",
                7,
                true,
                RankingPosition {
                    kind: "after".into(),
                    anchor_id: Some("work-b".into()),
                },
            )
            .unwrap();
        assert_eq!(
            moved
                .tiers
                .iter()
                .find(|tier| tier.score == 7)
                .unwrap()
                .placed_ids,
            ["work-b", "work-a"]
        );
        assert!(matches!(
            storage.undo_last_ranking_move(before.revision),
            Err(StorageError::Conflict)
        ));
        let undone = storage.undo_last_ranking_move(moved.revision).unwrap();
        assert_eq!(
            undone
                .tiers
                .iter()
                .find(|tier| tier.score == 7)
                .unwrap()
                .placed_ids,
            ["work-a", "work-b"]
        );

        let current = storage.load_ranking().unwrap();
        let moved_tier = storage
            .move_ranking_entry(
                current.revision,
                "work-a",
                9,
                false,
                RankingPosition {
                    kind: "end".into(),
                    anchor_id: None,
                },
            )
            .unwrap();
        assert_eq!(
            moved_tier
                .library
                .entries
                .iter()
                .find(|entry| entry.id == "work-a")
                .unwrap()
                .overall_rating,
            Some(9)
        );
        let restored = storage.undo_last_ranking_move(moved_tier.revision).unwrap();
        assert_eq!(
            restored
                .library
                .entries
                .iter()
                .find(|entry| entry.id == "work-a")
                .unwrap()
                .overall_rating,
            Some(7)
        );
        assert_eq!(
            restored
                .tiers
                .iter()
                .find(|tier| tier.score == 7)
                .unwrap()
                .placed_ids,
            ["work-a", "work-b"]
        );

        let revision = storage.load_library().unwrap().revision;
        storage
            .save_entry(revision, test_entry("unscored", None))
            .unwrap();
        let before = storage.load_ranking().unwrap();
        let placed = storage
            .move_ranking_entry(
                before.revision,
                "unscored",
                7,
                true,
                RankingPosition {
                    kind: "start".into(),
                    anchor_id: None,
                },
            )
            .unwrap();
        let restored = storage.undo_last_ranking_move(placed.revision).unwrap();
        assert!(restored.unscored_ids.contains(&"unscored".to_string()));
        assert_eq!(
            restored
                .library
                .entries
                .iter()
                .find(|entry| entry.id == "unscored")
                .unwrap()
                .overall_rating,
            None
        );
        drop(storage);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn manual_move_undo_supports_a_stack_and_rejects_later_duel_answers() {
        let root = std::env::temp_dir().join(format!("ranking-undo-stack-{}", crate::now_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let mut storage = Storage::open(&root).unwrap();
        for id in ["stack-a", "stack-b"] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .save_entry(revision, test_entry(id, Some(7)))
                .unwrap();
        }
        let first = storage.load_ranking().unwrap();
        let after_first = storage
            .move_ranking_entry(
                first.revision,
                "stack-a",
                7,
                true,
                RankingPosition {
                    kind: "end".into(),
                    anchor_id: None,
                },
            )
            .unwrap();
        let after_second = storage
            .move_ranking_entry(
                after_first.revision,
                "stack-b",
                7,
                true,
                RankingPosition {
                    kind: "end".into(),
                    anchor_id: None,
                },
            )
            .unwrap();
        let undo_second = storage
            .undo_last_ranking_move(after_second.revision)
            .unwrap();
        assert_eq!(
            undo_second
                .tiers
                .iter()
                .find(|tier| tier.score == 7)
                .unwrap()
                .placed_ids,
            ["stack-a"]
        );
        assert!(undo_second
            .tiers
            .iter()
            .find(|tier| tier.score == 7)
            .unwrap()
            .unplaced_ids
            .contains(&"stack-b".to_string()));
        let undo_first = storage
            .undo_last_ranking_move(undo_second.revision)
            .unwrap();
        let tier = undo_first
            .tiers
            .iter()
            .find(|tier| tier.score == 7)
            .unwrap();
        assert!(tier.placed_ids.is_empty());
        assert_eq!(tier.unplaced_ids, ["stack-a", "stack-b"]);

        let place_a = storage
            .move_ranking_entry(
                undo_first.revision,
                "stack-a",
                7,
                true,
                RankingPosition {
                    kind: "end".into(),
                    anchor_id: None,
                },
            )
            .unwrap();
        let place_b = storage
            .move_ranking_entry(
                place_a.revision,
                "stack-b",
                7,
                true,
                RankingPosition {
                    kind: "end".into(),
                    anchor_id: None,
                },
            )
            .unwrap();
        let session = storage
            .start_duel_session(place_b.revision, 7, Vec::new(), None, "normal".into())
            .unwrap();
        let prompt = storage.next_duel(&session.id, false).unwrap().unwrap();
        let answer_revision = storage.load_ranking().unwrap().revision;
        let answered = storage
            .answer_duel(
                answer_revision,
                &session.id,
                &prompt.duel_id,
                DuelAnswer::Tie,
            )
            .unwrap();
        assert!(
            matches!(
                storage.undo_last_ranking_move(answered.revision),
                Err(StorageError::Conflict)
            ),
            "a later answer makes the earlier order snapshot stale"
        );
        drop(storage);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ranking_evidence_records_the_tier_sequence_it_entered() {
        let root =
            std::env::temp_dir().join(format!("ranking-evidence-sequence-{}", crate::now_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let mut storage = Storage::open(&root).unwrap();
        for id in ["sequence-a", "sequence-b"] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .save_entry(revision, test_entry(id, Some(7)))
                .unwrap();
            let state = storage.load_ranking().unwrap();
            storage
                .move_ranking_entry(
                    state.revision,
                    id,
                    7,
                    true,
                    RankingPosition {
                        kind: "end".into(),
                        anchor_id: None,
                    },
                )
                .unwrap();
        }
        let state = storage.load_ranking().unwrap();
        let boundary_sequence: i64 = storage
            .conn
            .query_row(
                "SELECT created_sequence FROM ranking_boundary WHERE score=7",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let placed_sequence = state
            .tiers
            .iter()
            .find(|tier| tier.score == 7)
            .unwrap()
            .input_sequence;
        assert_eq!(
            boundary_sequence, placed_sequence,
            "the manual factor is stamped at the E created by the placement"
        );
        let session = storage
            .start_duel_session(state.revision, 7, Vec::new(), None, "normal".into())
            .unwrap();
        let prompt = storage.next_duel(&session.id, false).unwrap().unwrap();
        let answer_revision = storage.load_ranking().unwrap().revision;
        let state = storage
            .answer_duel(
                answer_revision,
                &session.id,
                &prompt.duel_id,
                DuelAnswer::Tie,
            )
            .unwrap();
        let judgment_sequence: i64 = storage
            .conn
            .query_row(
                "SELECT input_sequence FROM ranking_judgment WHERE duel_id=?1",
                [&prompt.duel_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(judgment_sequence, boundary_sequence + 1);
        let skipped = storage.next_duel(&session.id, true).unwrap().unwrap();
        let state = storage
            .answer_duel(
                state.revision,
                &session.id,
                &skipped.duel_id,
                DuelAnswer::Skip,
            )
            .unwrap();
        let skip_sequence: i64 = storage
            .conn
            .query_row(
                "SELECT input_sequence FROM ranking_judgment WHERE duel_id=?1",
                [&skipped.duel_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            skip_sequence, judgment_sequence,
            "a skip is audit history, not a new evidence sequence"
        );
        assert_eq!(
            state
                .tiers
                .iter()
                .find(|tier| tier.score == 7)
                .unwrap()
                .input_sequence,
            judgment_sequence
        );
        drop(storage);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn duel_session_rejects_over_two_hundred_before_persisting_and_snapshots_filtered_participants()
    {
        let root = std::env::temp_dir().join(format!("ranking-session-cap-{}", crate::now_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let mut storage = Storage::open(&root).unwrap();
        let ids = (0..201).map(|i| format!("cap-{i:03}")).collect::<Vec<_>>();
        let keys = spaced_order_keys(ids.len()).unwrap();
        {
            let tx = storage.conn.transaction().unwrap();
            for (index, (id, key)) in ids.iter().zip(keys).enumerate() {
                tx.execute("INSERT INTO entry(id,title,disposition,overall_rating,created_at,updated_at,import_order) VALUES(?1,?2,'experienced',7,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',?3)",params![id,id,index as i64]).unwrap();
                tx.execute(
                    "INSERT INTO ranking_entry(entry_id,score,placed) VALUES(?1,7,1)",
                    [id],
                )
                .unwrap();
                tx.execute("INSERT INTO group_order(entry_id,group_id,order_key) VALUES(?1,'rating-07',?2)",params![id,key]).unwrap();
            }
            tx.commit().unwrap();
        }
        let revision = storage.load_ranking().unwrap().revision;
        assert!(matches!(
            storage.start_duel_session(revision, 7, Vec::new(), None, "normal".into()),
            Err(StorageError::Validation(_))
        ));
        let session_count: i64 = storage
            .conn
            .query_row("SELECT count(*) FROM ranking_session", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            session_count, 0,
            "an invalid participant count must not create an active session"
        );
        drop(storage);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn normal_session_restarts_automatically_on_participant_membership_change() {
        let root =
            std::env::temp_dir().join(format!("ranking-session-snapshot-{}", crate::now_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let mut storage = Storage::open(&root).unwrap();
        for id in ["snapshot-a", "snapshot-b"] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .save_entry(revision, test_entry(id, Some(7)))
                .unwrap();
            let state = storage.load_ranking().unwrap();
            storage
                .move_ranking_entry(
                    state.revision,
                    id,
                    7,
                    true,
                    RankingPosition {
                        kind: "end".into(),
                        anchor_id: None,
                    },
                )
                .unwrap();
        }
        let state = storage.load_ranking().unwrap();
        let session = storage
            .start_duel_session(state.revision, 7, Vec::new(), None, "normal".into())
            .unwrap();
        let persisted: String = storage
            .conn
            .query_row(
                "SELECT snapshot_order_json FROM ranking_session WHERE id=?1",
                [&session.id],
                |row| row.get(0),
            )
            .unwrap();
        let participants: Vec<String> = serde_json::from_str(&persisted).unwrap();
        assert_eq!(participants, ["snapshot-a", "snapshot-b"]);
        let prompt = storage.next_duel(&session.id, false).unwrap().unwrap();
        let revision = storage.load_library().unwrap().revision;
        storage
            .save_entry(revision, test_entry("snapshot-new", Some(7)))
            .unwrap();
        let moved = storage.load_ranking().unwrap();
        storage
            .move_ranking_entry(
                moved.revision,
                "snapshot-new",
                7,
                true,
                RankingPosition {
                    kind: "end".into(),
                    anchor_id: None,
                },
            )
            .unwrap();
        let changed = storage.load_ranking().unwrap();
        let recovered = storage
            .answer_duel(
                changed.revision,
                &session.id,
                &prompt.duel_id,
                DuelAnswer::Tie,
            )
            .unwrap();
        assert_ne!(
            recovered.active_session.as_ref().unwrap().id,
            session.id,
            "stale answer must replace the session rather than record the old answer"
        );
        let judgments: i64 = storage
            .conn
            .query_row(
                "SELECT count(*) FROM ranking_judgment WHERE session_id=?1",
                [&session.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            judgments, 0,
            "a stale presented duel must not record an answer"
        );
        let status: String = storage
            .conn
            .query_row(
                "SELECT status FROM ranking_session WHERE id=?1",
                [&session.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            status, "ended",
            "membership conflicts must be durably ended"
        );
        let current = storage.load_ranking().unwrap();
        let second = storage
            .start_duel_session(current.revision, 7, Vec::new(), None, "normal".into())
            .unwrap();
        let cached = storage.next_duel(&second.id, false).unwrap().unwrap();
        assert_eq!(cached.kind, "normal");
        let revision = storage.load_library().unwrap().revision;
        storage
            .save_entry(revision, test_entry("snapshot-newer", Some(7)))
            .unwrap();
        let moved = storage.load_ranking().unwrap();
        storage
            .move_ranking_entry(
                moved.revision,
                "snapshot-newer",
                7,
                true,
                RankingPosition {
                    kind: "end".into(),
                    anchor_id: None,
                },
            )
            .unwrap();
        let replacement_prompt = storage.next_duel(&second.id, false).unwrap().unwrap();
        assert_ne!(
            replacement_prompt.session_id, second.id,
            "stale next should return a replacement prompt"
        );
        let status: String = storage
            .conn
            .query_row(
                "SELECT status FROM ranking_session WHERE id=?1",
                [&second.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "ended");
        drop(storage);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn binary_insertion_on_a_large_tier_finishes_and_returns_a_subset_prompt() {
        let root = std::env::temp_dir().join(format!("ranking-binary-cap-{}", crate::now_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let mut storage = Storage::open(&root).unwrap();
        let ids = (0..202)
            .map(|i| format!("binary-cap-{i:03}"))
            .collect::<Vec<_>>();
        let keys = spaced_order_keys(ids.len()).unwrap();
        {
            let tx = storage.conn.transaction().unwrap();
            for (index, (id, key)) in ids.iter().zip(keys).enumerate() {
                tx.execute("INSERT INTO entry(id,title,disposition,overall_rating,created_at,updated_at,import_order) VALUES(?1,?2,'experienced',7,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',?3)",params![id,id,index as i64]).unwrap();
                tx.execute(
                    "INSERT INTO ranking_entry(entry_id,score,placed) VALUES(?1,7,?2)",
                    params![id, index < 201],
                )
                .unwrap();
                tx.execute("INSERT INTO group_order(entry_id,group_id,order_key) VALUES(?1,'rating-07',?2)",params![id,key]).unwrap();
            }
            tx.commit().unwrap();
        }
        let revision = storage.load_ranking().unwrap().revision;
        let session = storage
            .start_duel_session(revision, 7, Vec::new(), None, "binary".into())
            .unwrap();
        assert_eq!(session.mode, "binary");
        let prompt = storage.next_duel(&session.id, false).unwrap().unwrap();
        let answer_revision = storage.load_ranking().unwrap().revision;
        let state = storage
            .answer_duel(
                answer_revision,
                &session.id,
                &prompt.duel_id,
                DuelAnswer::Tie,
            )
            .unwrap();
        let result = storage
            .confirm_binary_placement(state.revision, &session.id, true)
            .unwrap();
        assert_eq!(result.next_step, BinaryPlacementNextStep::RequiresSubset);
        assert!(result.state.active_session.is_none());
        let status: String = storage
            .conn
            .query_row(
                "SELECT status FROM ranking_session WHERE id=?1",
                [&session.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "paused");
        let tier = result
            .state
            .tiers
            .iter()
            .find(|tier| tier.score == 7)
            .unwrap();
        assert_eq!(tier.placed_ids.len(), 202);
        assert!(tier.unplaced_ids.is_empty());
        drop(storage);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn explicit_normal_subset_is_canonical_and_stays_stable_when_new_works_are_placed() {
        let root =
            std::env::temp_dir().join(format!("ranking-explicit-subset-{}", crate::now_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let mut storage = Storage::open(&root).unwrap();
        let ids = (0..201)
            .map(|i| format!("subset-{i:03}"))
            .collect::<Vec<_>>();
        let keys = spaced_order_keys(ids.len()).unwrap();
        {
            let tx = storage.conn.transaction().unwrap();
            for (type_id, name) in [("type-a", "Type A"), ("type-b", "Type B")] {
                tx.execute("INSERT INTO media_type(id,name,normalized_name,sort_order,created_at,updated_at) VALUES(?1,?2,?1,0,'now','now')",params![type_id,name]).unwrap();
            }
            for (index, (id, key)) in ids.iter().zip(keys).enumerate() {
                let type_id = if index % 2 == 0 { "type-a" } else { "type-b" };
                tx.execute("INSERT INTO entry(id,title,disposition,media_type_id,overall_rating,created_at,updated_at,import_order) VALUES(?1,?2,'experienced',?3,7,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',?4)",params![id,id,type_id,index as i64]).unwrap();
                tx.execute(
                    "INSERT INTO ranking_entry(entry_id,score,placed) VALUES(?1,7,1)",
                    [id],
                )
                .unwrap();
                tx.execute("INSERT INTO group_order(entry_id,group_id,order_key) VALUES(?1,'rating-07',?2)",params![id,key]).unwrap();
            }
            tx.commit().unwrap();
        }
        let revision = storage.load_ranking().unwrap().revision;
        assert!(matches!(
            storage.start_duel_session_with_candidates(
                revision,
                7,
                Vec::new(),
                None,
                Some(vec!["subset-000".into(), "outside-tier".into()]),
                "normal".into()
            ),
            Err(StorageError::Validation(_))
        ));
        assert!(matches!(
            storage.start_duel_session_with_candidates(
                revision,
                7,
                vec!["type-a".into()],
                None,
                Some(vec!["subset-000".into(), "subset-011".into()]),
                "normal".into()
            ),
            Err(StorageError::Validation(_))
        ));
        let session = storage
            .start_duel_session_with_candidates(
                revision,
                7,
                vec!["type-a".into()],
                None,
                Some(vec!["subset-010".into(), "subset-002".into()]),
                "normal".into(),
            )
            .unwrap();
        assert_eq!(session.mode, "normal");
        let snapshot: String = storage
            .conn
            .query_row(
                "SELECT snapshot_order_json FROM ranking_session WHERE id=?1",
                [&session.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Vec<String>>(&snapshot).unwrap(),
            ["subset-002", "subset-010"]
        );
        let prompt = storage.next_duel(&session.id, false).unwrap().unwrap();
        {
            let tx = storage.conn.transaction().unwrap();
            tx.execute("INSERT INTO entry(id,title,disposition,media_type_id,overall_rating,created_at,updated_at,import_order) VALUES('subset-new','new','experienced','type-a',7,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',201)",[]).unwrap();
            tx.execute(
                "INSERT INTO ranking_entry(entry_id,score,placed) VALUES('subset-new',7,1)",
                [],
            )
            .unwrap();
            let key = next_order_key(&tx, "rating-07").unwrap();
            tx.execute("INSERT INTO group_order(entry_id,group_id,order_key) VALUES('subset-new','rating-07',?1)",[key]).unwrap();
            tx.commit().unwrap();
        }
        let cached = storage.next_duel(&session.id, false).unwrap().unwrap();
        assert_eq!(
            cached.duel_id, prompt.duel_id,
            "new eligible entries outside an explicit subset do not stale it"
        );
        let current = storage.load_ranking().unwrap();
        storage
            .answer_duel(
                current.revision,
                &session.id,
                &prompt.duel_id,
                DuelAnswer::Tie,
            )
            .unwrap();
        let explicit: bool = storage
            .conn
            .query_row(
                "SELECT explicit_subset FROM ranking_session WHERE id=?1",
                [&session.id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(explicit);
        drop(storage);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn failed_reconciliation_rolls_back_partial_fit_and_order_writes_but_keeps_answer_pending() {
        let root = std::env::temp_dir().join(format!(
            "ranking-reconcile-savepoint-{}",
            crate::now_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let mut storage = Storage::open(&root).unwrap();
        for id in ["reconcile-b", "reconcile-a"] {
            let revision = storage.load_library().unwrap().revision;
            storage
                .save_entry(revision, test_entry(id, Some(7)))
                .unwrap();
            let state = storage.load_ranking().unwrap();
            storage
                .move_ranking_entry(
                    state.revision,
                    id,
                    7,
                    true,
                    RankingPosition {
                        kind: "end".into(),
                        anchor_id: None,
                    },
                )
                .unwrap();
        }
        let tx = storage.conn.transaction().unwrap();
        tx.execute("INSERT INTO ranking_session(id,score,status,mode,intent,filter_json,seed,snapshot_order_json,snapshot_order_revision,high_bound,created_at,updated_at) VALUES('savepoint-session',7,'ended','normal','normal','[]',0,'[]',0,0,'now','now')",[]).unwrap();
        for index in 0..50 {
            tx.execute("INSERT INTO ranking_judgment(id,session_id,score,duel_id,kind,left_id,right_id,answer,occurred_at) VALUES(?1,'savepoint-session',7,?2,'normal','reconcile-a','reconcile-b','leftWin','now')",params![format!("saved-{index}"),format!("saved-duel-{index}")]).unwrap();
        }
        tx.execute("UPDATE ranking_tier_state SET input_sequence=input_sequence+50,pending_reconcile=1 WHERE score=7",[]).unwrap();
        tx.execute("INSERT INTO ranking_judgment(id,session_id,score,duel_id,kind,left_id,right_id,answer,occurred_at) VALUES('accepted-before-fit','savepoint-session',7,'accepted-before-fit','normal','reconcile-a','reconcile-b','leftWin','now')",[]).unwrap();
        tx.execute("UPDATE ranking_tier_state SET input_sequence=input_sequence+1,pending_reconcile=1 WHERE score=7",[]).unwrap();
        tx.execute_batch("CREATE TRIGGER fail_reconcile_clear BEFORE UPDATE OF pending_reconcile ON ranking_tier_state WHEN NEW.score=7 AND NEW.pending_reconcile=0 BEGIN SELECT RAISE(ABORT,'forced reconcile failure'); END;").unwrap();
        let before = tier_ids(&tx, 7, true).unwrap();
        assert_eq!(before, ["reconcile-b", "reconcile-a"]);
        let fit = fit_tier(&tx, 7).unwrap();
        let indices: HashMap<String, usize> = fit
            .entry_ids
            .iter()
            .cloned()
            .enumerate()
            .map(|(i, id)| (id, i))
            .collect();
        let a = indices["reconcile-a"];
        let b = indices["reconcile-b"];
        assert!(fit.means[a] - fit.means[b] > 1.5_f64.ln());
        let previous_fit: Option<i64> = tx
            .query_row(
                "SELECT input_sequence FROM ranking_fit WHERE score=7",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        assert!(fit_and_reconcile(&tx, 7).is_err());
        assert_eq!(
            tier_ids(&tx, 7, true).unwrap(),
            before,
            "tentative swaps must be rolled back"
        );
        assert_eq!(
            tx.query_row::<bool, _, _>(
                "SELECT pending_reconcile FROM ranking_tier_state WHERE score=7",
                [],
                |row| row.get(0)
            )
            .unwrap(),
            true
        );
        assert_eq!(
            tx.query_row::<i64, _, _>(
                "SELECT count(*) FROM ranking_judgment WHERE id='accepted-before-fit'",
                [],
                |row| row.get(0)
            )
            .unwrap(),
            1,
            "the accepted answer predates the fit savepoint"
        );
        assert_eq!(
            tx.query_row::<i64, _, _>(
                "SELECT count(*) FROM ranking_order_event WHERE kind='automatic_swap'",
                [],
                |row| row.get(0)
            )
            .unwrap(),
            0
        );
        let restored_fit: Option<i64> = tx
            .query_row(
                "SELECT input_sequence FROM ranking_fit WHERE score=7",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(restored_fit, previous_fit);
        tx.rollback().unwrap();
        drop(storage);
        let _ = std::fs::remove_dir_all(root);
    }
}

fn answer_as_str(answer: DuelAnswer) -> &'static str {
    match answer {
        DuelAnswer::LeftWin => "leftWin",
        DuelAnswer::RightWin => "rightWin",
        DuelAnswer::Tie => "tie",
        DuelAnswer::Skip => "skip",
    }
}
