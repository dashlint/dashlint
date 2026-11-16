# Checks and verdicts

dashlint builds two things and compares them:

- a **catalog** per source folder (`dashlint extract`): every analytics call it finds, with the
  event name, the properties sent, the values a property can take when the code fixes them, the
  platforms, and the file and line. It holds names, keys, values and locations, never source text.
- the **requirements** (`dashlint pull`, or a [hand-written file](requirements-yaml.md)): every
  tile's events, filters, breakdowns, formulas, and the alerts on it.

Every fact is yes, no or unknown. Only a definite "no" can make something dead. When a fact can't
be resolved, the part is counted as not checked, with the reason.

## The checks

| Check                  | Question                                                                                                                                 | What it can mark                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `event-has-call-site`  | Does any call site, or a builtin event of the SDK, send this event?                                                                      | the part dead                                                                              |
| `property-is-sent`     | For each filter, math property and breakdown: is the property sent with that event (event scope), or set on the person (person scope)?   | dead for a positive filter or math property; degraded for a negative filter or a breakdown |
| `value-is-reachable`   | For `exact`, `is_not` and `icontains` on a property the code sends from a fixed set of values: can the code produce the filter's values? | dead when none can; degraded when some can't                                               |
| `alert-target-valid`   | Does the series, formula or funnel step the alert watches still exist?                                                                   | the alert: invalid target                                                                  |
| `alert-can-never-fire` | Is the alert's target dead, and can its condition trigger on a value that is always zero?                                                | the alert: can never fire, or fires on every check                                         |

Builtin events and properties (for example `$pageview`, or properties the SDK adds to every event)
come from each SDK's descriptor, so a filter on one of them is not reported as missing.

### Code and PostHog's own data together

After `pull`, the snapshot also says which events and properties PostHog has seen in the last
`observedDays` days. dashlint combines that with the code:

| Code sends it | PostHog has seen it         | Result                                                                            |
| ------------- | --------------------------- | --------------------------------------------------------------------------------- |
| no            | no                          | dead                                                                              |
| no            | yes                         | live, with a note: produced elsewhere (a server, autocapture, another repository) |
| no            | no data (hand-written file) | dead, and the header says "code only"                                             |
| yes           | no                          | live, and listed under "Not arriving": sent in code, not seen in the window       |
| yes           | yes, or no data             | live                                                                              |
| unknown       | yes                         | live                                                                              |
| unknown       | no or no data               | not checked (dead only if PostHog has no definition of the event at all)          |

"Unknown" in code means dashlint can't rule it out: for example a call whose event name is a plain
`string`, or a property object built at run time.

## Verdicts

Each part of a tile (a series, a funnel step, a formula, a breakdown, an exclusion) is live, dead,
degraded or unknown. The tile's verdict follows, in this order:

1. **dead**: every part dashlint could decide is dead, and none is live.
2. **partly dead**: at least one part is dead.
   - Funnels: the first dead step k. If k is 1 the funnel is dead; otherwise steps k to the end
     are always zero.
   - Retention: a dead target event makes it dead; a dead returning event shows cohorts with 0%
     retention.
   - Formulas: dashlint evaluates the formula with dead series set to zero. Always zero, or never
     a finite number (a dead denominator), is dead; a different result from the full formula is
     partly dead.
3. **degraded**: a breakdown on a property never sent with the tile's events (every row lands in
   one "(none)" bucket), a negative filter that has no effect, an exclusion that has no effect, or a
   filter where only some values can happen.
4. **one platform**: otherwise live, your sources cover two or more platforms, and every event the
   tile counts is sent from only one of them.
5. **live**.

A tile is **not checked** when no part could be decided, or when its kind is SQL, paths or another
kind dashlint does not read. The number of parts not checked is always shown next to the verdict,
for example "live, 1 part not checked".

Groups (OR) are live if any member is live and dead only if every member is dead. A dead member
inside a live group is reported as information, not as a problem.

### PostHog's filter rules

| Filter                                                                              | On a property no call sends                           |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Positive (`exact`, `icontains`, `regex`, `gt`, `is_set`, date and semver operators) | matches nothing: the part is dead                     |
| Negative (`is_not`, `not_icontains`, `not_regex`, `is_not_set`, `not_in`)           | matches every event: "filter has no effect", degraded |
| `semver_neq`                                                                        | drops the event: the part is dead                     |

`exact` and `is_not` compare values case-sensitively, as PostHog does: a filter on `"Card"` never
matches a property the code sends as `"card"`. `regex` values are not checked. Cohort, session,
element, feature flag, HogQL and group filters are not checked. Person properties are "not sent"
only when no code sets them and PostHog has not seen them on any person.

For a [hand-written file](requirements-yaml.md) from another tool, the negative-filter and value
rules are not applied, because they depend on how that tool evaluates filters.

## Alerts

An alert on an event your code never sends can't warn you, and it doesn't look broken. In a test
PostHog project, alerts on an event nothing sends showed "Not firing" with no error on every
hourly check when they watched for a decrease or an upper limit, and fired on every check when they
had a lower limit. dashlint checks each alert's insight and condition against your code and flags
both cases:

- **can never fire**: the alert watches a dead part and has no lower bound (an absolute value or a
  relative change with only an upper threshold).
- **fires on every check**: the alert watches a dead part and has a lower bound, so the constant
  zero breaches it every time.
- **invalid target**: the alert watches a series, formula or funnel step the insight no longer has.

Each alert's state as PostHog shows it (for example "Not firing", "Errored", disabled) is printed
next to the result. HogQL and anomaly detector alerts are not checked.

## Not arriving

An event sent in your code that PostHog has not seen in the window is listed under "Not arriving",
with its call sites. It does not change any verdict: the code might not have shipped yet, or the
event is rare.

## Ignoring a tile

```yaml
# dashlint.config.yml
ignore:
  - tile: insight:Ab12Cd34
    reason: retired on purpose
    until: 2027-06-30
```

Entries take `tile`, `alert` or `dashboard`, a `reason`, and an optional `until` date. Ignored
tiles are counted separately. After `until`, dashlint prints a warning and checks the tile again.

A clean result means nothing dashlint can see is broken, not that every number is right.
