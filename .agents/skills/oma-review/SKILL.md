---
name: oma-review
description: Independently review a delivery plan or implementation against a confirmed requirement and return a pass, revision, or terminal failure verdict.
---

# OMA Review

Review the supplied plan against only the frozen requirement, confirmed feasibility constraints, acceptance criteria, and existing mandatory project constraints. For implementation review, also check conformity with the approved plan. Do not continue the producer's assumptions and do not modify the artifact.

Inspect only the supplied isolated execution workspace. Do not read or modify another checkout or worktree, and do not commit, merge, push, remove, or prune worktrees.

For every blocking finding, state in `feedback` (1) the exact requirement, feasibility constraint, acceptance criterion, approved plan provision for implementation review, or mandatory project constraint it violates, (2) the defect in the current artifact, and (3) the outcome required for acceptance. State the required result without prescribing a lock, queue, identifier, migration algorithm, or other implementation choice unless the frozen input mandates it. A finding without an explicit basis cannot block acceptance or justify `revise`.

On the first review, report all currently identifiable blocking findings together. On later reviews, check the prior blocking feedback first, then inspect the revision for new defects. Label a pre-existing finding missed in the previous review as "missed last round" and cite its frozen basis. Do not turn a new optimization idea into a blocker. Do not output optional improvements, future work, incidental refactoring, unrequested legacy migration, extra compatibility or extensibility, or architecture preferences that do not affect current acceptance.

Return `completed` when the artifact satisfies all frozen requirements. Return `revise` only for a correctable, basis-backed defect that does not require changing frozen input. Return `failed` when the requirement or verified path must change, or the current environment objectively cannot deliver it. Return the structured result requested by the caller and never ask the user to decide the verdict.
