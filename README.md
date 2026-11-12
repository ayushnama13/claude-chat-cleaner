# Claude Chat Cleaner

A small local web dashboard to manage and clean up Claude Code chat transcripts and related leftover files.

## Features
- **Zero npm dependencies**: Uses Node 20 built-ins only (`http`, `fs`, `path`, `os`, `child_process`).
- **Two-pane UI**: Browse projects and chat history with live status detection, search filtering, and raw transcript inspection.
- **Safe Deletion & Trash**: Moves chats, session-envs, file-histories, jobs, and roster entries to `.trash/` with full Restore and permanent Purge support.
- **Live Session Protection**: Automatically detects active/live sessions (running processes) and blocks deletion.
- **Configurable `CLAUDE_HOME`**: Supports overriding `~/.claude` via environment variable `CLAUDE_HOME`.

## Run Instructions

1. Ensure Node.js 20+ is installed.
2. Run the server:
   ```bash
   node server.js
   ```
3. Open your browser at:
   ```
   http://127.0.0.1:7788
   ```

## Testing with Fake CLAUDE_HOME

To test against a custom or fake Claude home directory without modifying your actual ~/.claude data:
```bash
CLAUDE_HOME=/path/to/fake-claude node server.js
```
