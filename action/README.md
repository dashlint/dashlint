# dashlint action

Comments on pull requests that would break saved analytics dashboards and alerts, by diffing your
code's analytics calls against a committed dashlint requirements snapshot.

Not affiliated with or endorsed by PostHog, Mixpanel, Amplitude or Twilio Segment.

## Quickstart

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

Installing dependencies first (`npm ci --ignore-scripts`) lets dashlint resolve your SDK's real call
signatures; without them it falls back to bundled stubs.

## Inputs

| Name      | Default               | Meaning                                                                |
| --------- | --------------------- | ---------------------------------------------------------------------- |
| `config`  | `dashlint.config.yml` | Path to the dashlint config file                                       |
| `base`    | (empty)               | Base commit to diff against; empty uses the pull request's base commit |
| `fail-on` | (empty)               | Severity that fails the job; empty uses the config's `failOn`          |
| `comment` | `true`                | Post or update a PR comment with the result                            |
| `token`   | `${{ github.token }}` | Token used to fetch the base commit and post the PR comment            |

## Behaviour

Runs `dashlint diff` for `pull_request` events, fetching the base commit itself (depth 1). Always
writes the job summary. Posts or updates one marked comment when the token can write (same-repo
pull requests); on fork and Dependabot pull requests, where `GITHUB_TOKEN` is read-only, it writes
the summary only and says so. It never uses `pull_request_target`, never needs an analytics key, and
never reads secrets.

A clean result means nothing dashlint can see is broken, not that every number is right.
