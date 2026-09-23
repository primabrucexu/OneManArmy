---
name: oma-plan
description: Produce or revise a concrete implementation plan from a confirmed requirement. Use only as a stage in an autonomous delivery run after requirements are frozen.
---

# OMA Plan

Convert the confirmed requirement into the smallest implementable plan with observable acceptance checks. Follow the frozen feasibility constraints: use the verified path, respect excluded paths and mandatory project/platform/permission constraints, and preserve the requirement's scope and confirmed automated behavior. Do not replace the verified path with an unverified one or introduce optional technical scope. This is a planning-only stage: do not create, edit, or delete workspace files.

Treat the supplied workspace as the run's isolated execution workspace. Do not inspect another checkout or another run's worktree.

For every acceptance criterion, specify an implementation step and a verification method in the complete plan returned as `artifact`; the `summary` does not replace that plan. Before returning `completed`, check the whole plan for complete acceptance coverage, consistency with the frozen path and project constraints, unchanged requirement scope, coherent execution order, and absence of unverified critical capability assumptions.

When review feedback is supplied, correct the identified defects and run the same whole-plan check again; do not validate only the local edits. If the verified path proves infeasible, a different unverified path becomes necessary, or the frozen requirement must change, return `failed` with evidence so Discuss can verify and confirm a new input. Do not silently switch paths or ask the user questions. Return the structured result requested by the caller.
