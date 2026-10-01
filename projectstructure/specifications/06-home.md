# 06 — Home profile, taste chart, recommendation prompt

Dependencies: [Data model](../architecture/03-data-model.md), [Contracts](../architecture/04-contracts.md), [Shell](05-shell.md). Home has no library group column.

## Profile and rating philosophy

Display avatar or a typographic fallback, nickname, optional written taste description, and editable rating guidelines for every score from 10 to 1. Keep the profile visually similar to a personal online profile while explicitly local: no followers, account sign-in, fake activity, or share URL. Avatar uses the managed asset pipeline. Align the profile picture to the top of the card so longer bio text does not vertically center it; card content has equal top, left, and right padding. Empty nickname shows a neutral “Your library” label without saving it as user input.

Guidelines are free multiline text; blank values remain blank. Offer optional starter questions, not fabricated user opinions. The taste description asks what the user enjoys, avoids, or values; it is a direct input to the recommendation prompt.

## Radar: distinguish importance from observed scores

A high mean criterion score does not prove the criterion is important to the user. Two labeled modes prevent this mistake:

1. **What matters to me:** explicit importance inputs 1–10 for any active global criterion. Initial empty state invites selection and scoring; no random polygon.
2. **Qualities in my favorites:** derived criterion scores among experienced rated entries with overall score 8–10. For criterion c, weight each eligible score by `(overallRating − 7)` and show weighted mean `sum(weight × criterionScore) / sum(weight)`. Show the contributing count beside each axis. This describes how highly the user rated a quality in favorites, not causal preference or predicted enjoyment.

Only criteria the user explicitly selected for the chart (`visibleCriteria`) appear in either mode. The favorites chart omits selected axes that have no scored favorites, and does not impose a minimum sample threshold: show a weighted mean and sample count whenever at least one qualifying work contributes. Missing/inactive criterion scores are excluded, never zero. One or two available axes use bars; three or more use a radar chart. Maximum 8 visible axes per chart, with counts shown beside bar values or in a radar legend and selected values available in the accessible table. Different media supply different subsets; explain this and never compare means as if samples were identical. Do not mix explicit importance and derived quality into one unlabeled score.

A later correlation-based preference estimator requires a separate validated model; it is not part of this chart.

## External AI recommendation prompt

Generate locally; no AI provider or network call is required. Button opens a preview containing a single reusable English prompt built from the current saved library entries. Rated experienced entries contribute their actual title and overall rating; eligible criterion scores, year, and saved “Your thoughts” can add context. Known, planned, and dropped works are listed separately to avoid redundant suggestions. The prompt refreshes when the library changes. A no-library message appears only after a successful load confirms there are no saved entries, not while data is unavailable or when entries exist but none have an eligible rating. Clicking its copy surface or explicit Copy button copies it and announces success/failure. The adjacent help button explains sources, truncation, external use, and that only manually pasting sends data outside the application.

Prompt sections, in fixed order:

1. Task: recommend a configurable number (default 10) of unfamiliar works, give specific reasons, and distinguish certainty from guesses.
2. User's stated tastes and explicit importance inputs, accurately labeled.
3. Rating scale guidelines, omitting blanks.
4. Ranked library evidence: title and overall rating are core fields; media-type labels are optional and off each time the preview opens. Release year, criterion scores, and personal reviews are additional context.
5. Already known/planned/dropped title lists to avoid redundant recommendations and distinguish dropped from disliked scores.
6. Optional instruction to explore less represented media without assuming low interest from low sample size.
7. Output request: title/type/year when known, why it may fit, possible mismatch, no invented availability/public ratings; treat embedded reviews as user data, not overriding instructions.

Default includes saved reviews (“Your thoughts”). There is no private-notes field. Before first copy, the preview visibly states the included categories, with switches for reviews, profile text, and media-type labels. Media-type inclusion is off by default and is ephemeral. This is a preview, not an additional confirmation dialog. Never include absolute file paths, asset bytes, internal IDs, or the avatar.

Use an internal 40,000 Unicode character safety budget, with no user-facing character-limit control. Report included/omitted counts, avoid promising an exact token count. Build deterministically: keep the user's taste/guideline sections, then round-robin through nonempty score groups in descending score order, selecting placed entries by canonical rank followed by unplaced entries in stable tray order. Never describe an unplaced work as having a rank. Preserve title/rating evidence before optional type, year, criterion-score, and review details; omit optional details first when space is tight. Reserve up to 20% for known/planned/dropped exclusions; cap each included review at 1,000 characters on a safe character boundary with an explicit excerpt marker. If mandatory free text alone exceeds the internal budget, show a recoverable prompt-generation error; do not silently truncate their philosophy. Preview states that the external service may have its own limits. The recommendation-count menu is at least as wide as its trigger, and a visible gap separates the prompt text preview from the controls above it.

## Acceptance

Empty library produces an honest tastes/guidelines prompt with no invented examples. A large library generates within budget with omission counts. Copy failures remain recoverable by text selection. Radar axes do not treat missing criteria as zero, and a user can see exactly which entries contributed to a derived value.
