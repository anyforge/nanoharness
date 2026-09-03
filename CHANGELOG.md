# Changelog

All notable changes are documented here (format follows [Keep a Changelog](https://keepachangelog.com/)).

> [中文 / Chinese](CHANGELOG_zh.md)

## [1.0.0] - 2026-09-03

First stable release.

### 🧠 Agent intelligence — Hermes-like memory & self-evolution (highlight)

- **Two-channel memory**: remembers who you are (preferences/habits) and environment conventions/pitfalls across sessions.
- **Skill self-evolution**: proactively saves reusable procedures as skills and reuses them.
- **Automatic context compression**: long conversations auto-summarized (threshold / target ratio configurable; defaults follow Hermes: 0.5 / 0.2).
- **Asks only when it matters**: decides low-stakes choices itself, pauses with options only for real trade-offs.

### 🌐 Browser automation

- 20+ CDP-based browser tools: open/switch tabs, read pages, click, fill forms, screenshot, and more.

### ⏺️ Action recording

- Records clicks/typing/scroll/hover into reusable skills, replayed with one sentence.

### 🔌 MCP support

- **MCP client**: connect to remote MCP servers over HTTP/SSE.
- **MCP server exposure**: expose browser/files/skills as a standard MCP server (Streamable HTTP + relay) for Claude Desktop, Cursor, etc.

### 🛠️ More

- **Multi-model**: OpenAI-compatible + Anthropic protocols, with built-in presets (DeepSeek / OpenAI / Claude / Moonshot / GLM / Qwen).
- **Workspace filesystem**: OPFS-backed private workspace (list/read/write/remove/search).
- **Session management**: multiple sessions + history search.
- **Skill system**: add/edit/remove skills in Settings, loaded on demand.
- **Bilingual UI**: English by default, Chinese switchable.
- Streaming output, interruption, ask_user approval.

### Fixed

- First release — no prior fixes.
