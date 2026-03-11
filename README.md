# cresume

Search and resume Claude Code sessions. No external dependencies required.

## Install

```bash
# Clone and run
git clone https://github.com/dbeyer/cresume
cd cresume
bun run start

# Or install globally
bun install -g .
cresume
```

Requires [Bun](https://bun.sh/) (`brew install oven-sh/bun/bun`).

## Usage

```bash
cresume                    # Start server, open browser
cresume --port=8080        # Custom port
cresume --no-browser       # Don't auto-open browser
```

### How it works

1. Scans all `~/.claude/projects/*/sessions-index.json` files
2. Loads session metadata into memory (fast substring search)
3. Serves a web UI for searching, previewing, and copying resume commands

### Search

Type in the search bar to find sessions by:
- First prompt text
- Project path
- Session summary (when available)
- Git branch name

### Folders

Right-click any session to organize it into folders. Folders are color-coded and persist across restarts. Stored at `~/.config/cresume/folders.json`.

- Right-click a session → "New folder" to create and assign
- Right-click a session → select existing folder to add/remove
- Click a folder in the sidebar to filter sessions

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus search |
| `Up/Down` | Navigate results |
| `Enter` | Load preview |
| `y` | Copy resume command |
| `Esc` | Return to search |

### Resume command

Select a session to see its resume command in the bottom bar. Click "copy" or press `y` to copy it to clipboard, then paste into your terminal:

```bash
cd '/path/to/project' && claude --resume <session-id>
```

## License

MIT
