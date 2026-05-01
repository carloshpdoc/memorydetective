## What this changes

<!-- One or two sentences. Link the issue if there is one (closes #N). -->

## Why

<!-- The motivation. If it's a new cycle pattern, describe the real production case it covers. -->

## How

<!-- Tests added / updated, scope of the change, anything reviewers should pay attention to. -->

## Checklist

- [ ] `npm test` is green (61+ tests passing).
- [ ] If a new tool: zod schema + unit test against a fixture in `tests/fixtures/`.
- [ ] If a new cycle pattern: entry in `src/tools/classifyCycle.ts` `PATTERNS` + a test in `src/tools/readTools.test.ts`.
- [ ] README updated if user-facing behavior changed.
- [ ] CHANGELOG entry under `## [Unreleased]` if relevant.
