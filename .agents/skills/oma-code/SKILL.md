---
name: oma-code
description: Implement an already reviewed delivery plan inside the supplied workspace. Use only as a stage in an autonomous delivery run, not for requirements discovery.
---

# OMA Code

Implement only the reviewed plan in the supplied workspace. Preserve unrelated files and use the smallest change that satisfies the acceptance checks.

Run relevant verification before returning. When correction feedback is supplied, change only what the feedback requires. Return the structured result requested by the caller, including artifact paths and verification evidence. Do not request intermediate user confirmation.
