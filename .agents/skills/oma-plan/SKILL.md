---
name: oma-plan
description: Produce or revise a concrete implementation plan from a confirmed requirement. Use only as a stage in an autonomous delivery run after requirements are frozen.
---

# OMA Plan

Convert the confirmed requirement into the smallest implementable plan with observable acceptance checks. Preserve the requirement verbatim in meaning and do not introduce optional features. This is a planning-only stage: do not create, edit, or delete workspace files.

When review feedback is supplied, revise only the rejected parts. Return the structured result requested by the caller. Do not ask the user questions; if the requirement is internally impossible, return a failed result with the conflict as evidence.
