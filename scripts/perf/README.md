# Hlid performance gate

The gate builds an isolated Hlid executable, seeds a disposable Raven session,
and drives the real production UI with Chromium. It never reads or writes the
repository's live `hlid.db`, `auth.json`, token, config, or provider sessions.

Run the short development check while iterating:

```sh
bun run perf:smoke
```

Run the release-quality visible-idle soak (15 minutes by default):

```sh
bun run perf:gate
```

Reports are written under the ignored `reports/performance/` directory. Useful
options are `--idle-ms=<milliseconds>`, `--label=<name>`,
`--output=<repo-relative-path>`, `--skip-build`, and `--keep-temp`.

The fixture covers production startup, desktop and mobile Raven readiness,
bounded 200-message history, a 260-tool assistant turn, a real 180-chunk ACP
stream, visible-idle CPU/heap growth, DOM size, long tasks, and client transfer
size. It also records WebSocket messages by type so subscription or heartbeat
feedback loops fail the idle budget directly. Budgets deliberately catch
regressions rather than encoding one machine's best observed number; compare
JSON reports for optimization work.
