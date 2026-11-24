# dashlint

## 0.1.1

### Patch Changes

- fbc1c7a: Published from CI with npm provenance, through a staged release a maintainer approves. No change in behaviour on Linux and macOS.
- Windows: `diff` no longer misses the sources of a project whose path has a short name (such as `RUNNER~1`), and a tsconfig with syntax errors no longer stops the run. CI now runs on Linux, macOS and Windows.

## 0.1.0

### Minor Changes

- First release. `init`, `pull`, `audit` and `check` compare the PostHog, Mixpanel, Amplitude and Segment tracking calls in your web and React Native code with the PostHog dashboard tiles and alerts (or a hand-written requirements file) they feed, and report each tile as dead, partly dead, degraded, one platform, not checked or live.
