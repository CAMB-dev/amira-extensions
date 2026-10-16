---
name: code-review
description: Usage guide for the experimental bounded /code-review command
---

Use `/code-review` to choose worktree or an explicit local ancestor. This skill is documentation only;
it does not start a second review pipeline. The command handles permission-checked collection,
model-exposure consent, independent reviewers, static assessment and durable reports.

Examples:
- `/code-review worktree --path src`
- `/code-review worktree --include-untracked --path src`
- `/code-review since HEAD~1`
- `/code-review status`, `/code-review stop`, `/code-review last`
- `/code-review show F001`, `/code-review ignore F001`, `/code-review fix F001`

`fix` confirms one explicit send to main and starts a potentially mutating model turn. It does not
apply a patch itself. Review completion does not imply tested correctness. `/review` belongs to share.
