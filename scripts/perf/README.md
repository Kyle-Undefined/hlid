# Hlid performance gate

The gate builds an isolated Hlid executable, seeds a disposable Raven session,
and drives the real production UI with Chromium. It never reads or writes the
repository's live `hlid.db`, `auth.json`, token, config, or provider sessions.

Install the Chromium revision that matches the pinned Playwright version after
`bun install`, and again whenever Playwright changes:

```sh
bun run perf:install-browser
```

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

The fixture covers production startup, desktop and mobile Raven readiness, a
20-message initial transcript window containing 58,000 characters of Markdown,
a tool-heavy nonpageable response on the 21st lookahead row, and a large context
receipt. The lookahead row must stay free of tool enrichment, the receipt must
remain compact, and neither payload may reach the mounted transcript. The newest
260-tool response remains eligible for server-backed activity paging. The gate
records first-transcript visibility, full Raven readiness, initial-history
response bytes, DOM and heap size, a real 180-chunk ACP stream, visible-idle CPU
and heap growth, long tasks, and client transfer size. It also records WebSocket
messages by type so subscription or heartbeat feedback loops fail the idle
budget directly. Budgets deliberately catch regressions rather than encoding
one machine's best observed number; compare JSON reports for optimization work.
