# 10 — Analytics rules and wording

Analytics is a feed, without the Library group column. Each tab has independent filters, scroll, and a stable selection seed until a fresh open/explicit refresh. All cards share one snapshot revision; on updates refresh coherently and preserve scroll. Every metric exposes population/denominator and a way to inspect contributing entries.

## Basic distributions and rarity

Population: active experienced entries with a current overall rating. Planned, dropped, Unrated, and trash are excluded; report their counts separately. Histogram uses ten integer bins including zero-count bins. Show count and percentage per bin, sample size, mean (one decimal), median, population standard deviation, and all tied modes where useful. Percentages derive from exact counts and may sum to 99.9/100.1 after rounding; explain only if necessary.

Rarity of score k = `100 × count(k) / N`; this differs from overall-rank Top percentage. No causal claim follows from either measure.

For N < 5: show counts and an add/rate invitation. For 5 ≤ N < 20: show charts with “Early snapshot” and no interpretive personality text. N ≥ 20 permits the rules below, in priority order; show at most two compatible observations.

1. **Concentrated score:** one bin contains ≥60%: “Many recorded works share [score]. This may reflect a deliberately narrow scale or the works entered so far.”
2. **Separated peaks:** two nonadjacent local peaks each contain ≥20%, distance ≥3 scores, and every intermediate bin is lower than both: “Ratings cluster in more than one range. Different kinds of work or selection habits may contribute.” Equal peaks are named equally.
3. **Near-flat:** at least eight occupied bins and coefficient of variation of all ten bin counts ≤0.35: “No narrow score range dominates this library.”
4. **Broad spread:** standard deviation ≥2.2 and at least six occupied bins: “Your ratings span much of the scale. You may be recording a wide range of experiences.”
5. **Dominant band:** total share of 1–4, 5–6, 7–8, or 9–10 is ≥45%, exceeds each other band's share by ≥10 percentage points, and contains a modal bin. 1–4: may reflect strict use of the scale or disappointing works recorded. 5–6: may reflect broad sampling or demanding standards. 7–8: may reflect choosing appealing works. 9–10: may reflect entering favorites first.
6. Otherwise state that several score ranges are represented and no single interpretation is supported.

Shape rules are deterministic heuristics, not psychological or statistical diagnoses. Do not call a histogram “normal/bell-shaped” from appearance alone. Do not infer severity from a mean without explaining selection effects.

## Across media types

Show raw distributions for types with ≥5 rated works, marking small samples. Interpret pairwise differences only when each type has ≥20 rated works. Include at most three comparisons per feed, prioritizing sufficiently represented types. Type-less entries form a visible “No type” group but do not support medium-specific explanations.

For each eligible pair report n, median, mean, modal scores, and high-rating share (8–10). Use “similar recorded distributions” when mean difference <0.5 and high-rating share difference <10 percentage points. Use “higher average in this library” only at mean difference ≥1.0 with median difference in the same direction of at least 1; otherwise describe a mixed/modest difference numerically without a confident interpretation. Tied or different modes do not alone trigger a claim. If sample counts differ by >4×, flag the imbalance and omit speculative explanations.

Optional neutral explanation: “This could reflect what you choose to record, different expectations, or how selectively you choose this medium.” The book/time-investment example is a possibility the user may recognize, never asserted as a fact about them. No significance, causality, preference probability, or personality labels without a separate validated method.

## Meaningful top lists

Candidate filters: one media type; one established tag; a release decade; type + decade. Do not generate arbitrary predicate combinations. Candidate must have ≥8 placed eligible works for Top 5, ≥3 distinct overall scores OR ≥8 explicitly ordered same-score works, and enough known fields for its predicate. Rank-based lists include placed works only; unplaced works still count in rating distributions but do not have rank, percentile, or Top percentage. Explicit order means `rankingPlaced=true`, through a recorded manual placement or confirmed binary insertion; default append alone does not prove intentional ordering. Analytics reads the same canonical placed order as Ranking and Library at one snapshot revision. Maximum three cards, with different entry sets where possible; near-duplicate sets with Jaccard overlap >0.8 are deduplicated.

Choose a seeded shuffle of eligible candidates on a fresh tab open or Refresh selections, avoid the previous seed's first choice when alternatives exist, and persist it within the tab. Sort results using canonical order only. If no candidate qualifies, omit niche cards and show general library stats; do not invent “Top 5 Animation” from two entries.

Year-based lists use only known release years and clearly say “Among works with release years,” plus missing-year count. Missing dates never become year zero/current year. If no eligible dated subset exists, show a request to add dates rather than a year-based result.

## Rating-boundary review

Find adjacent numeric groups k and k−1 that both contain placed entries. Compare lowest-ranked in k with highest-ranked in k−1. If a group has rated but unplaced entries and no placed entry, do not invent a rank-boundary comparison for it; direct the user to place works first. Prioritize 10/9, 9/8, 8/7, then remaining descending boundaries. Do not bridge empty groups (10/8 is not a 10/9 boundary). This review uses full-library boundaries; temporarily filtered Analytics shows that scope explicitly and does not mislabel filtered extremes as actual boundaries.

Actions: Keep both ratings; move upper work down (insert at top of lower group); move lower work up (insert at bottom of upper group); edit either directly. Preview resulting ratings/order. Changing groups writes normal rating history, invalidates boundary cards and recomputes ranks. Keep records the current pair/fingerprint; suppress it until a boundary participant, rating, or relative boundary position changes, or explicit review reset. It must not repeat each launch unchanged. Continue to next meaningful boundary; end with a concise completion state.

## Acceptance

Fixtures cover empty/singleton, one dominant bin, equal peaks, separated peaks, flat/broad shapes, 19/20 thresholds, tiny categories, imbalanced type samples, missing dates, and all scores identical. Every statement has a deterministic evidence rule and localized whole-sentence template. No card suggests causal preference from absent data.
