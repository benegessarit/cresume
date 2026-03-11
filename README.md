# cresume

Search and resume your Claude Code sessions from a local web UI. Find that conversation where you fixed the auth bug, preview it, and jump back in with one command.

![cresume screenshot](screenshot.png)

## Install

Requires [Bun](https://bun.sh/) (no other dependencies):

```bash
# Install Bun (if you don't have it)
curl -fsSL https://bun.sh/install | bash      # macOS / Linux
# powershell -c "irm bun.sh/install.ps1|iex"  # Windows

# Clone and run
git clone https://github.com/benegessarit/cresume
cd cresume
bun run start

# Or install globally
bun install -g .
cresume
```

## Usage

```bash
cresume                    # Start server, open browser
cresume --port=8080        # Custom port
cresume --no-browser       # Don't auto-open browser
cresume --version          # Show version
```

### How it works

1. Scans all `~/.claude/projects/*/sessions-index.json` files
2. Loads session metadata into memory (fast substring search)
3. Serves a web UI for searching, previewing, and copying resume commands
4. Watches for new sessions and reloads automatically

### Search

Type in the search bar to find sessions by:
- First prompt text
- Session summary
- Project path
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

Select a session to see its resume command in the bottom bar. Press `y` to copy, then paste into your terminal:

```bash
cd '/path/to/project' && claude --resume <session-id>
```

## License

MIT
