# Release Actions

- `promote-npm`: validates or submits exact Insider artifacts, either one package or a batch.
- `resolve-npm-source-run`: resolves a trusted producer's newest successful run attempt to an exact batch without registry access.
- `check-npm-public`: separately checks public metadata against an exact version and digest.

See [AGENTS.md](AGENTS.md) for inputs, a combined SDK example, caller permissions,
failure handling and the no-publish test contract.
