# dashlint

Find the dashboard tiles and alerts your code can no longer feed, before you merge.

dashlint reads the analytics calls in your TypeScript or JavaScript code, reads the saved
insights, dashboards and alerts from PostHog (or from a requirements file you write by hand), and
gives every tile a verdict with the reason and the line of code behind it. In CI it compares a
pull request against a committed snapshot of your dashboards and comments on the tiles the change
would break, with no analytics key in CI.

By Aman Gupta.

Not affiliated with or endorsed by PostHog, Mixpanel, Amplitude or Twilio Segment.

## Why

A dashboard tile can be broken in a way neither side shows. The chart draws a plausible zero or a
single "(none)" bucket, and the code looks fine. In a production app I run, a sharing dashboard of
23 tiles had 4 that could show a real number. One instrumentation commit, adding properties at call
sites that already had the data, took it to 10. Nothing had alerted on it for 7 weeks.

dashlint joins the two sides. It checks the property filters, filter values and breakdowns of each
tile against the calls your code makes: a filter on a property no call sends, a value the code
can't produce, a breakdown that collapses into one "(none)" bucket, a negative filter with no
effect. PostHog's dead-insight scout covers event firings and, in its instructions as of November
2026, says property filters, cohorts and breakdowns are "outside this check", so the two are
complementary.

## Try it on the demo (no account, no key)

The demo is a small fictional bookshop with a web app and a mobile app, a few tiles broken on
purpose, and a committed snapshot of its PostHog dashboards:

```sh
git clone https://github.com/dashlint/demo.git
cd demo
npx dashlint audit --offline
```

This prints the text report and writes `dashlint-report.html`. It exits 1, because the demo has
dead tiles on purpose. Part of the output:

```text
Bookshop growth (18 tiles): 5 live · 2 dead · 11 one platform · 0 not checked

DEAD          Book views by genre
              filters on `genre` = "mystery", but no call site sends `genre` with `book_viewed`
              (they send `genre_id`), and PostHog has never seen `genre` on that event
              web/src/App.tsx:25

DEAD          Gift card redemptions
              (alert "Gift card redemptions dropped" can never fire; alert "Gift card redemptions
              below one" fires on every check)
              queries `gift_card_redeemed`: no code sends it and PostHog has never seen it; closest
              event in code: `giftcard_redeemed`
              web/src/App.tsx:74
```

## Use it on your app

Node 22.13 or later. Install your dependencies first (`npm ci --ignore-scripts` is enough): that
lets dashlint read your SDK's real types and any tsconfig your config extends from a package. In
the root of your repository:

```sh
npx dashlint init
```

`init` finds the folders that use an analytics SDK and writes `dashlint.config.yml`. Open it,
uncomment the `platforms` block and set `project` to your PostHog project id (the number after
`/project/` in your PostHog URL); change `host` if you are not on US cloud. Then pull a snapshot of
your PostHog dashboards with a personal API key that has read-only scopes:

```sh
export DASHLINT_POSTHOG_KEY=phx_your_read_only_key
npx dashlint pull
```

`pull` writes `dashlint.requirements.json`. Commit it: CI and every other command read this file
and never call PostHog. Then:

```sh
npx dashlint audit --offline
```

`audit` without `--offline` pulls a fresh snapshot first. `dashlint check` prints the same verdicts
as `text`, `json` or `html`.

The PostHog key needs read access to insights, dashboards, alerts, actions, event definitions and
property definitions. dashlint never reads event rows, persons or recordings, and never writes to
PostHog.

## What it checks

For each tile, dashlint asks:

- **Is the event sent?** Does any call site (or an SDK's builtin event) send the event the tile
  counts? An event renamed in code shows up here, with the closest name the code does send.
- **Is the property sent?** For each property filter, math property and breakdown, does any call
  site send that property with that event, or set it on the person?
- **Can the value happen?** When the code sends a property from a fixed set of values, can it
  produce the value the filter asks for? A filter on `"Card"` when the code only sends `"card"` or
  `"wallet"` matches nothing.
- **Can the alert fire?** An alert on an event your code never sends can't warn you, and it
  doesn't look broken. In a test PostHog project in November 2026, alerts on an event nothing
  sends showed "Not firing" with no error on every hourly check when they watched for a decrease
  or an upper limit, and fired on every check when they had a lower limit. dashlint checks each alert's insight and
  condition against your code and flags both cases, plus alerts that point at a series or step the
  insight no longer has.

Each tile also shows which platforms (web, iOS, Android) can send its data, read from the code
before release.

dashlint reads tracking calls for the PostHog, Mixpanel, Amplitude and Segment SDKs (web and React
Native). Dashboards come from PostHog, or from a [hand-written requirements file](docs/requirements-yaml.md)
for any other tool. The full rules are in [docs/checks.md](docs/checks.md).

## Verdicts

| Verdict      | Meaning                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| dead         | The tile can only show zero or nothing: every part it is built from is dead                                 |
| partly dead  | Some of it is dead: a funnel whose later steps are always zero, a formula with a dead term                  |
| degraded     | It shows a number, but not the one you think: a breakdown with one "(none)" bucket, a filter with no effect |
| one platform | Live, but every event it counts is sent from one platform while your app ships on several                   |
| not checked  | dashlint can't decide (SQL insights, paths, or facts it can't resolve), and says why                        |
| live         | Nothing dashlint can see is wrong                                                                           |

Facts are yes, no or unknown. Only a definite "no" makes a tile dead; when dashlint can't tell, it
says "not checked" with the reason and counts it. Unknown counts are always printed. Same input,
same verdicts. It's free per run, and works offline after `pull`.

## In CI

The [dashlint GitHub Action](https://github.com/dashlint/action) runs `dashlint diff` on every pull
request: it builds the catalog of analytics calls for the base and head commits, checks both against
the committed snapshot, and comments on the tiles and alerts the change would newly break. It needs
no analytics key and never reads secrets.

```yaml
# .github/workflows/dashlint.yml
name: dashlint
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  dashlint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: npm ci --ignore-scripts
      - uses: dashlint/action@v0
```

Only tiles newly broken at or above `failOn` fail the check; tiles that were already dead are
mentioned and never block a merge. [docs/ci.md](docs/ci.md) covers forks, monorepos and refreshing
the snapshot on a schedule.

## Configuration

```yaml
# dashlint.config.yml
version: 1
requirements: dashlint.requirements.json # or a hand-written .yml
platforms:
  posthog:
    host: https://us.posthog.com # or https://eu.posthog.com, or your own host
    project: 12345
    key: env:DASHLINT_POSTHOG_KEY # the name of an environment variable, never the key itself
    observedDays: 30
sources:
  - name: web
    path: web
    platform: web
  - name: mobile
    path: mobile
    platform: [ios, android]
ignore:
  - tile: insight:Ab12Cd34
    reason: retired on purpose
    until: 2027-06-30
failOn: dead # dead | partly-dead | degraded | never
```

Unknown keys are an error that names the key. Exit codes: `0` nothing at or above `failOn`, `1`
findings at or above `failOn`, `2` usage or config error, `3` a bug in dashlint, `4` `pull` failed.
`dashlint --help` lists every command and flag.

## Privacy

- No telemetry. dashlint never sends your source code anywhere.
- `extract`, `check`, `diff` and `audit --offline` make no network calls. `pull` makes GET requests
  to the PostHog host in your config and nothing else, unless you set `hogql: true` under
  `platforms.posthog`: then it also sends aggregate HogQL queries to that host's `query/` endpoint,
  asking when each property a tile uses last arrived. They return timestamps, never event rows.
- The key is read only from the environment variable your config names, and never printed or
  logged. A key written into the config file is refused.
- The catalog holds event names, property keys, fixed values and file:line locations, never source
  text.
- **The committed snapshot contains your insight and dashboard names and filter values.** On a
  public repository they become public. Set `redact: true` under `platforms.posthog` to replace
  titles with ids and drop dashboard names.

## Measured

Every number here comes from a recorded run:

- On 64 public repositories across the four SDK families, dashlint read a literal event name at
  95.9% of the call sites it found, with 0 crashes.
- In blind samples of 100 facts it reported, 1 was wrong.
- On a laptop, `check` on a 1,040-file app takes 0.33 seconds end to end.

## Limits

- TypeScript and JavaScript only; no Swift, Kotlin or server SDKs.
- PostHog is the only dashboard source read directly. For other tools, write the
  [requirements file](docs/requirements-yaml.md) by hand.
- SQL insights, paths and cohort, session or group filters are reported as not checked.
- Event names built at run time (for example `capture(name)` with a plain `string`) can't be
  checked; dashlint counts them and shows the share.
- A client dashlint can't see (a global set by a script tag such as `window.posthog`, an SDK used
  only from a file outside the source, a framework plugin) is not read. When a source's
  package.json names the SDK and dashlint finds no event call of it, the events that source doesn't
  send are "not checked", never "dead".

More in the [FAQ](docs/faq.md).

## License

MIT. Contributions welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports:
[SECURITY.md](SECURITY.md).

A clean result means nothing dashlint can see is broken, not that every number is right.
