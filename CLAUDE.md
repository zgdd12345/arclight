
## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health

## Task-completion review protocol (MANDATORY)

At the END of every task (a feature/slice/fix is implemented and self-verified),
you MUST invoke the `codex` skill to review the work, then fix according to its
findings before declaring the task done. Do not skip this even when your own
tests pass.

- Trigger: any task that produced code/diff changes, right before reporting it
  complete (and before any merge/PR/finishing step).
- Action: invoke the `codex` skill (review mode) on the task's diff/changes.
- Then: triage the review output — fix Critical/Important findings, record
  Minor ones; re-review if a fix is non-trivial. Report what was found and fixed.
- This runs IN ADDITION TO any subagent/plan review already performed; codex is
  an independent second reviewer.

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.
Hard rules: hazard red #FF4D2E appears ONLY on approval surfaces; all machine
output (paths/diffs/terminal/costs) uses Commit Mono; no chat bubbles; no
blue-black backgrounds; border-radius 0 by default.
