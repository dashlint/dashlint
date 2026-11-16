# Hand-written requirements

dashlint reads PostHog dashboards directly with `dashlint pull`. For any other dashboard tool, or
for a few tiles you want checked without a PostHog key, write the requirements by hand in YAML.
The file uses the same schema as the JSON snapshot `pull` writes (`dashlint.requirements/1`), with
a few shorthands so it stays short.

Point the config at it:

```yaml
# dashlint.config.yml
version: 1
requirements: dashlint.requirements.yml
sources:
  - name: web
    path: web
    platform: web
```

or pass it once: `dashlint check --requirements dashlint.requirements.yml`.

## Example

```yaml
schema: dashlint.requirements/1
source: { platform: mixpanel, note: 'Growth board, copied by hand on 2026-12-10' }
dashboards:
  - id: growth
    name: Bookshop growth
tiles:
  - id: growth/orders-by-format
    title: Orders by format
    dashboards: [growth]
    kind: trends
    series:
      - event: order_completed
        filters: [{ key: payment_method, values: card }]
    breakdown: [format]
  - id: growth/browse-to-order
    title: Browse to order
    dashboards: [growth]
    kind: funnels
    series:
      - event: book_viewed
      - event: checkout_started
      - event: order_completed
        filters:
          - { key: gift_wrap, op: is_not, values: true }
  - id: growth/orders-per-viewer
    title: Orders per viewer
    dashboards: [growth]
    kind: trends
    series:
      - event: order_completed
      - event: book_viewed
        math: dau
    formulas:
      - { index: 0, expression: A / B, refs: [A, B] }
  - id: growth/returning-readers
    title: Readers who come back
    kind: retention
    retention:
      target: { event: book_viewed }
      returning: { node: all-events }
alerts:
  - id: orders-drop
    tile: growth/orders-by-format
    target: { kind: series, index: 0 }
    condition: relative_decrease
    bounds: { lower: false, upper: true }
```

## Shorthands

| You write                                   | dashlint reads                       |
| ------------------------------------------- | ------------------------------------ |
| a series entry with `event:` and no `node:` | `node: event`                        |
| a filter or breakdown with no `scope:`      | `scope: event`                       |
| a filter with no `op:`                      | `op: exact`                          |
| `values: card`                              | `values: [card]`                     |
| a breakdown written as a string, `format`   | `{ key: format, scope: event }`      |
| series with no `ref:`                       | `ref` letters `A`, `B`, `C` in order |

## Tiles

Each tile has an `id` (any string, unique in the file), a `title`, an optional list of
`dashboards` ids, and a `kind`:

- `trends`, `lifecycle`, `stickiness`: `series`, optional `formulas`, `filters` (apply to every
  series) and `breakdown`.
- `funnels`: `series` are the steps in order; optional `exclusions` with `event`, `fromStep` and
  `toStep`.
- `retention`: `retention.target` and `retention.returning`.
- `paths`, `sql`, `other`: kept so they show up in the report, always "not checked".

A series entry is one of:

- `{ event: <name>, filters: [...] }`, optionally with `math` and `mathProperty`.
- `{ node: all-events }`: every event, for example a daily active users denominator.
- `{ node: group, operator: OR, events: [...] }`: a union of events.
- `{ node: action, action: { id, name, steps: [...] } }`: each step is an event with filters.

## Filters

```yaml
filters:
  - { key: genre_id, values: [fiction, poetry] } # exact, event property
  - { key: plan, scope: person, op: is_set, values: [] } # a person property
  - any: # OR between filters
      - { key: gift_wrap, values: true }
      - { key: gift_note, op: is_set, values: [] }
```

Operators: `exact`, `is_not`, `icontains`, `not_icontains`, `regex`, `not_regex`, `gt`, `gte`,
`lt`, `lte`, `is_set`, `is_not_set`, `not_in`, and the date and semver operators. Scopes: `event`,
`person`, `session`, `cohort`, `element`, `feature`, `hogql`, `group`, `other`. Only `event` and
`person` are checked; the rest are counted as not checked.

## Rules for other tools

A file whose `source.platform` is `posthog` is checked with PostHog's filter rules. Any other value
uses a generic profile that assumes less:

| Case                                                                      | PostHog                                            | Any other tool                            |
| ------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------- |
| Positive filter on a property no call sends                               | dead                                               | dead                                      |
| Negative filter (`is_not`, `is_not_set`, ...) on a property no call sends | degraded: the filter has no effect                 | not checked                               |
| `exact` value the code can't produce                                      | dead (degraded when only some values can't happen) | not checked unless both sides are strings |
| `regex` values                                                            | not checked                                        | not checked                               |

Values are compared case-sensitively, the way PostHog compares `exact` and `is_not`.

## Alerts

```yaml
alerts:
  - id: orders-drop
    tile: growth/orders-by-format
    target: { kind: series, index: 0 } # or { kind: formula, index: 0 }, { kind: funnel-step, index: 2 }
    condition: relative_decrease # relative_increase | relative_decrease | absolute_value
    bounds: { lower: false, upper: true }
```

`bounds` says which thresholds the alert has. See [checks.md](checks.md#alerts) for what dashlint
reports.

A clean result means nothing dashlint can see is broken, not that every number is right.
