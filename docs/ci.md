# dashlint in CI

The idea: commit a snapshot of your dashboards (`dashlint.requirements.json`) next to your code.
On every pull request, dashlint builds the catalog of analytics calls for the base and the head
commit, checks both against the snapshot, and reports the tiles and alerts the change would newly
break. CI never calls PostHog and needs no analytics key.

## The GitHub Action

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

Installing dependencies first (`npm ci --ignore-scripts`) lets dashlint resolve your SDK's real
call signatures; without them it falls back to stubs it ships for each supported SDK.

| Input     | Default               | Meaning                                                                |
| --------- | --------------------- | ---------------------------------------------------------------------- |
| `config`  | `dashlint.config.yml` | Path to the config file                                                |
| `base`    | (empty)               | Base commit to diff against; empty uses the pull request's base commit |
| `fail-on` | (empty)               | Level that fails the job; empty uses the config's `failOn`             |
| `comment` | `true`                | Post or update a comment on the pull request                           |
| `token`   | `${{ github.token }}` | Token used to fetch the base commit and post the comment               |

Outputs: `newly-broken` (how many tiles the change newly breaks at or above the failing level) and
`report-json` (the path to the JSON report).

The Action always writes the job summary. It posts one comment and updates it on later pushes, so
a pull request never collects a stack of them. A comment looks like this:

```markdown
**dashlint: this PR would break 3 tiles and 1 alert**

| Change                                                                        | Breaks                                             |
| ----------------------------------------------------------------------------- | -------------------------------------------------- |
| `checkout_started` renamed to `checkout_begun` (web/src/cart/checkout.tsx:52) | Funnel "Checkout funnel" (step 1: dead)            |
|                                                                               | Trend "Daily checkouts" (dead)                     |
|                                                                               | Alert "Checkouts dropped" (can never fire)         |
| `format` removed from `order_completed` (mobile/src/orders/complete.ts:30)    | "Orders by format" (degraded: one "(none)" bucket) |
```

## What fails the job

Only tiles **newly** broken at or above `failOn` fail the run. A tile that was already dead on the
base commit is mentioned and never blocks a merge. Alerts the change breaks are listed in the
comment and do not fail the run on their own. Levels: `dead` (the default), `partly-dead`,
`degraded`, `never` (report only).

When the same pull request also changes the requirements file, verdict changes caused by that are
listed as information and never fail.

## Forks and Dependabot

On pull requests from forks and from Dependabot, GitHub gives the workflow a read-only
`GITHUB_TOKEN`. The Action then writes the job summary only and says so in it. It never uses
`pull_request_target`, never checks out pull request code with write permissions, and never reads
secrets.

## Several apps in one repository

List each app as a source in `dashlint.config.yml`; `dashlint init` does this for npm, yarn and
pnpm workspaces. Each source has a platform (`web`, `ios`, `android`, or a list), which is how
dashlint tells a web-only event on a cross-platform dashboard.

```yaml
sources:
  - name: web
    path: apps/web
    platform: web
  - name: mobile
    path: apps/mobile
    platform: [ios, android]
    tsconfig: apps/mobile/tsconfig.json # optional
```

Events sent from another repository (a backend, say) can be added as catalogs that repository
writes with `dashlint extract`:

```yaml
catalogs:
  - path: catalogs/server.json
```

## Run the same check locally

```sh
npx @dashlint/cli diff --base origin/main
```

`--format markdown` prints the comment the Action would post; `--format json` prints the report.
`--base` also takes a catalog file written by `dashlint extract`.

## Keeping the snapshot fresh

The snapshot is a file in your repository, so a change to a dashboard shows up as a diff you can
review. To refresh it on a schedule, run `dashlint pull` in a workflow of your own with a
repository secret holding a read-only PostHog key, and open a pull request with the result. One
way, using the GitHub CLI that GitHub's runners include:

```yaml
# .github/workflows/dashlint-refresh.yml
name: dashlint refresh
on:
  schedule:
    - cron: '0 6 * * 1'
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
jobs:
  pull:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npx @dashlint/cli pull
        env:
          DASHLINT_POSTHOG_KEY: ${{ secrets.DASHLINT_POSTHOG_KEY }}
      - name: Open a pull request when the snapshot changed
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          git diff --quiet -- dashlint.requirements.json && exit 0
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git switch -c dashlint/refresh-${{ github.run_id }}
          git commit -am "chore: refresh dashlint snapshot"
          git push origin HEAD
          gh pr create --fill
```

`gh pr create` with `GITHUB_TOKEN` needs the repository setting "Allow GitHub Actions to create and
approve pull requests". The Action itself never runs `pull` and never needs this secret.

On a public repository, the snapshot makes your insight and dashboard names and filter values
public. Set `redact: true` under `platforms.posthog` to replace titles with ids and drop dashboard
names.

A clean result means nothing dashlint can see is broken, not that every number is right.
