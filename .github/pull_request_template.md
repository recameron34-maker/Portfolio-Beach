## What and why
Issue: #
Module(s): M__

## Security
SEC IDs satisfied or affected: SEC-
- [ ] No real data, secrets or company-specific values (synthetic only)
- [ ] New access path enforced in API **and** row-level security, with a negative test
- [ ] New data classified, minimized, retention set
- [ ] AI changes: approved endpoint config, schema-validated output, eval updated, no content in logs
- [ ] New dependency or permission justified below

## Tests and evidence
- [ ] Unit / integration tests added or updated
- [ ] Calc golden files pass (if financial logic changed)
- [ ] Evals pass (if prompts changed)
Paste key test output:

## Docs
- [ ] docs/SESSION_LOG.md updated
- [ ] docs/03 updated if schema changed; decision record added if needed
- [ ] No em dashes (`pnpm check:style`)

## Built by
- [ ] Claude Code (Fable) session   - [ ] Human
Reviewer note: Claude-authored PRs need human approval; security paths need a pb-security reviewer.
