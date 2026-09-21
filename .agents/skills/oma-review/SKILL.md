---
name: oma-review
description: Independently review a delivery plan or implementation against a confirmed requirement and return a pass, revision, or terminal failure verdict.
---

# OMA Review

Review only the supplied artifact against the confirmed requirement and acceptance checks. Do not continue the producer's assumptions and do not modify the artifact.

Return `completed` only when the evidence satisfies every acceptance check. Return `revise` with precise, actionable feedback for correctable defects. Return `failed` only for an objective contradiction or an unrecoverable condition. Return the structured result requested by the caller and never ask the user to decide the verdict.
