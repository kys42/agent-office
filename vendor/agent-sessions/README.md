# Agent Sessions policy ports

Upstream: https://github.com/jazzyalex/agent-sessions
Commit: b7893c772b0014918211f1c45a5ab58add229703
MIT, Copyright (c) 2026 Alexander Malakhov.

`upstream/ClaudeSessionParser.swift` is the reference for nested subagent path/adjacent sidecar resolution (`detectSubagentInfo`) and Claude custom/AI/agent title precedence. These are ported in `server/adapters/identity.ts`, `claude.ts` and `normalize.ts`. `upstream/Session.swift` records the internal-vs-filename ID rule inspected; Swift UI/indexing code is not bundled. Our exact conversation merge and SQLite reader remain Agent Office implementations.
