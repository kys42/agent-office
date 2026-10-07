# Third-party notices

Agent Office itself is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md) — noncommercial use only. The third-party components below keep their own licenses, which this does not change. User-provided design assets are reused with the user's explicit instruction from kys42/claude-skills, commit 9a644d65.

## Pixel Agents

`src/lib/pathfinding.ts` adapts four-connected BFS from `webview-ui/src/office/layout/tileMap.ts` at pixel-agents-hq/pixel-agents commit 3537e14. Copyright (c) 2026 Pablo De Lucca. MIT License. The original source and complete license are in `vendor/pixel-agents/`. No Pixel Agents character/furniture artwork is incorporated.

## Packaged dependencies

React, React DOM, Lucide, Zod, MCP TypeScript SDK, Pretendard (OFL-1.1, UI typeface), Galmuri (OFL-1.1, pixel lettering inside the office scene), and JetBrains Mono (OFL-1.1, numerals and code) are used under their package licenses. Copies are in `public/licenses/` and shipped to `dist/licenses/`. Electron includes its own LICENSE and Chromium notices in the application distribution. The package lock records exact resolved versions.

Research checkouts under `.research/` are not shipped or added to Git. Claude-Mem was inspected for architecture and format comparison; its implementation code was not copied. CASS and MCP Agent Mail include additional license riders and no implementation from those repositories is incorporated.

## Orca session ingestion

Copyright (c) 2026 Lovecast Inc. MIT License. From stablyai/orca commit ea6a6d60774ac2b74bb6692d1798e3ab13b99ae0: JSONL byte reader, record budget, Codex non-user-origin classifier, and value helpers. Source paths, SHA-256 checksums and limited modifications are in `vendor/orca/manifest.json`; original and runtime copies and complete license are preserved in `vendor/orca/`. `tests/orca-origin.test.ts` ports the original origin test suite; reader boundary cases also inform `tests/ingestion-conformance.test.ts`. The complete license ships in `public/licenses/orca-LICENSE.txt`.

## Agent Sessions parser policies

Copyright (c) 2026 Alexander Malakhov. MIT License. Claude nested subagent path/sidecar detection and title precedence are adapted from `AgentSessions/Services/ClaudeSessionParser.swift`, commit b7893c772b0014918211f1c45a5ab58add229703. The port is in `server/adapters/identity.ts`, `claude.ts`, and `normalize.ts`. Upstream copies and the full license are preserved in `vendor/agent-sessions/`; the license ships in `public/licenses/agent-sessions-LICENSE.txt`. Swift application code is not bundled.

## Acorn and usage-reference research

Acorn parses literal JavaScript call syntax without executing transcript content. MIT License, Copyright (C) 2012-2022 by various contributors. The complete license ships in `public/licenses/acorn-LICENSE.txt`; `package-lock.json` pins the version.

The quota service is an independent TypeScript implementation informed by Orca's `claude-oauth-usage-request.ts` / `codex-rpc-rate-limit-probe.ts` (same pinned commit above), and Agent Sessions' OAuth credential resolver / Codex CLI probe (same pinned commit above). No additional upstream runtime module is copied. Provenance and limits: `docs/development/USAGE-AND-WORKSPACE.md`.
