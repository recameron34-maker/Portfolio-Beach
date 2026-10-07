# Review pass (run every few PRs, or before a phase exit)

Review the current `main` branch against the docs. Do not change code in this session; produce a findings report as a GitHub issue draft.

Check:
1. Every acceptance criterion for completed modules (`docs/04`) has a test that would fail if the behavior broke.
2. RLS matrix: any table without positive and negative tests per role; any API path that checks roles but has no RLS backing.
3. State machines: any transition reachable in code that is not in `docs/18`.
4. Money handled as JS `number` anywhere; dates created without the injected clock.
5. Logs that could contain content, values or bank details.
6. Adapters missing timeout, retry, circuit breaker or kill switch.
7. Mock adapters reachable from production builds.
8. Docs drift: code behavior not reflected in docs, or docs promising behavior that does not exist.
9. Dependencies added without justification or with disallowed licenses.
Rank findings High / Medium / Low with file references and a proposed fix for each.
