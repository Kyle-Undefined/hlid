# Provider extension contracts

These fixtures pin the provider-owned extension formats consumed by
`extensionInventory.ts`. They are redacted, minimal reproductions of shapes
observed from live provider installations on 2026-07-24:

- Claude Code `2.1.218`
- Codex CLI `0.145.0`

The values are synthetic. The fixtures contain no credentials, user paths, or
installed package names. `{{...}}` markers are replaced with temporary test
paths before discovery runs.

When a provider changes one of these formats:

1. inspect the new live shape without copying secrets or local paths;
2. add or update the versioned fixture;
3. run `extensionContracts.test.ts`;
4. change production parsing only when the new contract is understood; and
5. retain an older fixture when backward compatibility is still required.

Native mutation command arguments and reconciliation behavior remain pinned in
`extensionMutations.test.ts`. These fixtures cover the registries, manifests,
marketplace snapshots, and successful CLI JSON parsed by inventory discovery.
