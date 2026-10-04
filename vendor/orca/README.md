# Orca ingestion modules

MIT, Copyright (c) 2026 Lovecast Inc. Pinned commit and source checksums: `manifest.json`.

`upstream/` is the unchanged review copy; it is not bundled. `runtime/` contains the modules imported by Agent Office. Only JSONL stream injection, relative imports and extraction of the two pure value helpers differ; the byte fold and origin classifier are retained. No Orca hooks, execution, account management, network service or WSL runtime is installed.

The complete origin test suite is ported to `tests/orca-origin.test.ts` using Node assertions. Reader boundary tests and integration policy cases are in `tests/ingestion-conformance.test.ts`. See `docs/INGESTION-REFERENCE-AUDIT.md` for why the entire Vault parser is not used.
