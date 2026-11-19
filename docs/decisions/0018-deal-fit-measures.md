# 0018: Deal fit measures and the radar chart

- **Status:** Accepted for the prototype, as a draft set of measures
- **Date:** 2026-11-12
- **Deciders:** repo owner (asked for the chart and said to choose a draft set of measures); built in Claude Code

## Context

The owner asked: "on the new deal pipeline, if we have detail recorded on specific sponsors, it would be cool to illustrate the deals fit for the portfolio by different metrics in a radar chart", and then: "go ahead and use your best judgement for the draft radar chart measures".

A radar chart needs measures on one scale. Three rules of the build guide shape them. A number is never invented (rule 10), so a measure whose input is not recorded cannot be drawn as a zero or filled from somewhere else. Thresholds are configuration, not code (rule 9). And financial math is specified and tested before anything uses it (rule 12, `docs/08`).

## Options considered

1. **Scores a person enters.** A deal lead rates each deal from 1 to 5 on a few headings. Simple, and it records opinion, not the portfolio: two leads would score the same deal differently, and nothing ties the score to a figure.
2. **Scores worked out from what is recorded (chosen).** Each measure is a plain rule over figures the platform already holds (the sponsor's tier, our returns with the sponsor, our fund commitments, the shares of held NAV, the sizes of held positions). A reader can check any score by hand from the figures shown beside it.
3. **One overall fit score.** A single number is easy to rank by and hides everything a radar chart exists to show. It would also need weights nobody has chosen. Not built; the seven measures stand side by side.

## Decision

**Seven measures, each from 0 to 100, higher a better fit** (the rules in full are `docs/08` section 8):

| Measure | What it reads | Scores 100 | Scores 0 |
|---|---|---|---|
| Sponsor relationship | the sponsor's tier | the tier configured highest (core) | none; a tier with no configured score has no score |
| Track record | pooled gross MOIC of our positions with the sponsor | 2.50x or more | 1.00x or less |
| Fund relationship | whether the firm has a commitment to the deal's sponsor fund | to the deal's own fund | to no fund of the sponsor (another fund scores 60) |
| Sector room | share of held NAV already in the deal's sector | nothing held | 25% or more |
| Sponsor room | share of held NAV already with the sponsor | nothing held | 20% or more |
| Geography room | share of held NAV already in the deal's geography | nothing held | 70% or more |
| Deal size | target commitment as a multiple of the median held position of the deal's type | 0.5x to 1.5x | nothing, and 3.0x or more |

- **Every threshold is configuration** (`config/definitions.json`, `dealFit`). The API refuses to answer with a threshold missing or unusable and names the key; there is no default in code.
- **A measure with no input has no score and says why:** the tier is not scored, no position with the sponsor has a calculable MOIC, nothing is recorded on the deal or no NAV is held, there is no target commitment (or it is in another currency than the positions, which is never converted), or no held position of the type exists to compare with.
- **The calculation** is `dealFit` in `@pb/calc`, with golden fixture 24 and the Python cross-check, written before anything used it.
- **The API** is `GET /api/v1/opportunities/{id}/fit` (the roles that read the pipeline; `asOf` optional). It answers the scores, the figures each was worked out from and the thresholds. Every figure is one another page already reports the same way: shares of held NAV as the Exposure tab has them, the pooled MOIC and the commitments as the sponsor page has them. It reads only the book the caller may see, and a deal behind a wall is 404, as its detail is. The read is audited.
- **The page** is a "Portfolio fit" card on the opportunity, marked "Draft measures": the radar chart, and beside it each measure with its score, the recorded figure behind it and its rule in words.

**How the chart is drawn.** The app's own SVG, as every chart is (`docs/13`). One spoke per measure, rings at 25, 50, 75 and 100, the scores joined into a shape. A measure with no score is a dashed spoke with the missing-value placeholder and **leaves a gap in the shape**: it is not drawn at the centre, which would read as zero, and no line crosses it from one neighbour to the other, which would suggest a value in between. The score is printed at every label, so nothing is said by position or colour alone, and the same rows are a table one button away.

**Motion.** The web fades in, the shape opens out from the centre and the points land in turn, once. Pointing at a measure in the list brings its spoke forward on the chart and the other way round. Nothing moves under the reduced motion setting (`docs/06` section 5).

**The static preview** replays the fit the API recorded for each deal and each user. It works nothing out: a deal created in the preview has no fit, and the card says so.

## Consequences

- The measures are a first draft for the owner to change. Changing a threshold is a configuration edit; changing a rule, or adding or dropping a measure, is a change to `docs/08`, the fixture and this record.
- No dependency, no table and no migration: the fit is worked out on read from figures already held, and nothing is stored.
- The scores describe the portfolio the caller may see. Two readers with different entitlements can see different shares, and so different scores, for the same deal. That follows the rule every pooled figure on the platform follows.
- The synthetic book is concentrated (one sponsor holds about two fifths of held NAV, one geography about three fifths), so several synthetic deals score low on sponsor room and geography room. That is the data, and it shows the measures doing their job; the caps are the owner's to set.
- None of the measures is a recommendation, and the card says so.

## Verification

```
packages/calc fit.test.ts, fixture 24     the rules, the ends of every line, every missing input, bad thresholds refused
apps/worker-py calc_check                 the same cases in Python; cross-check 440 cases, 0 mismatches
apps/api pipeline-fit.test.ts             each score is the rule over the figures returned; the figures equal the Exposure
                                          and sponsor pages; as-of date; the wall (404); bad thresholds name their key
apps/web radar.test.ts, RadarChart.test   geometry, the gap at a measure with no score, labels, tooltip, table twin
apps/web deal-fit.test.ts, DealFit.test   the wording of every measure and every reason; the fixture equals dealFit;
                                          list and chart tied together; the unavailable states
apps/web preview pipeline.test.ts         the recorded fit replayed, the wall, 501 for a deal made in the preview
apps/web e2e/deal-fit.spec.ts             the real API: spokes, points, scores in the API's order; accessibility scan
```

## SEC IDs affected

SEC-5.3 (the fit reads only positions the caller may see; a walled deal is 404, tested), SEC-9 audit trail (the read is recorded as `opportunity.fit.read`). No new column, role or permission.
