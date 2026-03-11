#!/usr/bin/env bun
import { loadAllSessions, loadFolders, startServer, allSessions, foldersData } from "./server";

const DEFAULT_PORT = 3117;

function parseArgs(): { port: number; noBrowser: boolean } {
  let port = DEFAULT_PORT;
  let noBrowser = false;

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--port=")) {
      port = parseInt(arg.split("=")[1], 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(`Invalid port: ${arg.split("=")[1]}`);
        process.exit(1);
      }
    } else if (arg === "--no-browser") {
      noBrowser = true;
    } else if (arg === "--version" || arg === "-v") {
      console.log("cresume 0.1.0");
      process.exit(0);
    } else if (arg === "--help" || arg === "-h") {
      console.log(`cresume - Search and resume Claude Code sessions

Usage: cresume [options]

Options:
  --port=PORT     Server port (default: ${DEFAULT_PORT})
  --no-browser    Don't open browser automatically
  -v, --version   Show version
  -h, --help      Show this help`);
      process.exit(0);
    }
  }

  return { port, noBrowser };
}

async function main() {
  const { port, noBrowser } = parseArgs();

  console.log("Loading sessions...");
  const sessions = await loadAllSessions();
  allSessions.length = 0;
  allSessions.push(...sessions);

  if (sessions.length === 0) {
    console.log("No Claude Code sessions found. Start a session with `claude` first.");
  } else {
    console.log(`Loaded ${sessions.length} sessions`);
  }

  const loaded = await loadFolders();
  foldersData.folders = loaded.folders;
  if (loaded.folders.length > 0) {
    console.log(`Loaded ${loaded.folders.length} folders`);
  }

  let server;
  try {
    server = startServer(port);
  } catch (e: any) {
    if (e?.code === "EADDRINUSE" || e?.message?.includes("address already in use")) {
      console.error(`Port ${port} is already in use. Try: cresume --port=${port + 1}`);
      process.exit(1);
    }
    throw e;
  }
  const url = `http://localhost:${server.port}`;
  console.log(`cresume running on ${url}`);

  // Open browser
  if (!noBrowser && !process.env.CI) {
    const { exec } = await import("child_process");
    let cmd: string;
    if (process.platform === "darwin") cmd = "open";
    else if (process.platform === "win32") cmd = "cmd /c start";
    else cmd = "xdg-open";
    exec(`${cmd} ${url}`);
  }
}

main();
