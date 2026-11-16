# FAQ

## Does dashlint send my code or data anywhere?

No. There is no telemetry. `extract`, `check`, `diff` and `audit --offline` make no network calls.
`pull` makes GET requests to the PostHog host in your config, reads definitions (insights,
dashboards, alerts, actions, event and property definitions), and nothing else. It never reads
event rows, persons or recordings, and never writes to PostHog.

## Which key does `pull` need?

A PostHog personal API key with read-only scopes for insights, dashboards, alerts, actions, event
definitions and property definitions, for the one project in your config. Put it in an
environment variable and name the variable in the config (`key: env:DASHLINT_POSTHOG_KEY`). A key
written into the config file is refused, and dashlint never prints it.

## Is the snapshot safe to commit?

It holds your insight and dashboard names, the events and properties they use, and their filter
values, never any event data. On a public repository these become public. `redact: true` under
`platforms.posthog` replaces titles with ids and drops dashboard names.

## How is this different from PostHog's own checks?

PostHog's dead-insight scout covers event firings and says property filters, cohorts and
breakdowns are "outside this check", so the two are complementary. dashlint reads your code, so it
also checks the property filters, filter values and breakdowns of each tile, and it can run on a
pull request before the change ships. PostHog's scouts look after the fact: a dead insight after 30
days of silence, the PR follow-up scout after deploy.

## Which SDKs does it read?

`posthog-js`, `posthog-react-native`, `mixpanel-browser`, `mixpanel-react-native`,
`@amplitude/analytics-browser`, `@amplitude/analytics-react-native`, `@segment/analytics-next` and
`@segment/analytics-react-native`, in TypeScript and JavaScript. Calls through your own wrapper
functions (`track('order_completed', ...)` that calls `posthog.capture`) are followed.

## I use Mixpanel, Amplitude or Segment dashboards. Can I use it?

The code side reads all four SDK families. Dashboards are read directly only from PostHog; for any
other tool, copy the tiles you care about into a [hand-written requirements file](requirements-yaml.md).
Those files are checked with a more cautious rule set, because filter semantics differ between
tools.

## Why is a tile "not checked"?

dashlint only says "dead" when it is sure. A tile is not checked when it is a SQL or paths insight,
when it filters on something dashlint doesn't read (cohorts, sessions, feature flags, HogQL), or
when the code side is open: an event name that is a plain `string`, a property object built at run
time, or an SDK package your source depends on with no call of it that dashlint can find. The
report gives the reason for each one and counts them.

## A tile is dead, but I see numbers in PostHog.

Check the "produced elsewhere" note first. If PostHog has seen the event or property (for example
from a server, a CDP or autocapture), dashlint reports the tile live with a note, as long as the
snapshot includes observed data. A hand-written requirements file has no observed data, so its
results rest on code alone, and the report header says so. If the numbers come from another
repository, add its catalog under `catalogs:` in the config.

## Does `dashlint` run my code or my build?

No. It reads your TypeScript or JavaScript with the TypeScript compiler's type checker. It loads no
plugins, runs no scripts, and does not need a build. Installing your dependencies first (with
`--ignore-scripts`) lets it see your SDK's real types; without them it uses stubs it ships.

## Does a clean report mean my dashboards are right?

No. A clean result means nothing dashlint can see is broken, not that every number is right. It
can't tell whether an event fires at the right moment, whether a value is correct, or what happens
in code it can't read.

## Who makes it?

Aman Gupta, as an MIT open-source project. Not affiliated with or endorsed by PostHog, Mixpanel,
Amplitude or Twilio Segment.
