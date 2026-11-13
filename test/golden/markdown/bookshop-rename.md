<!-- dashlint:v1 -->
**dashlint: this PR would break 2 tiles and 1 alert**

| Change | Breaks |
|---|---|
| `checkout_started` renamed to `checkout_begun` (web/src/checkout/start.ts:12 · mobile/src/checkout/start.ts:9) | Trend "Checkouts by method" (dead, was degraded) |
| | Alert "Checkouts dropped" (can never fire) |
| `payment_method` removed from `payment_submitted` (web/src/checkout/pay.ts:63 · mobile/src/checkout/pay.ts:40) | Trend "Payments by method" (degraded: one "(none)" bucket) |

Checked against `dashlint.requirements.json` (pulled 2026-12-18). 2 tiles were already dead before this PR. 0 call sites have non-literal event names. 1 part could not be decided.
<sub>dashlint 0.1.0 · a clean result means nothing dashlint can see is broken, not that every number is right</sub>
