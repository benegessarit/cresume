#!/usr/bin/env bun
import { resolve, basename, dirname } from "path";
import { readdir, readFile, stat, watch, writeFile, mkdir, rename } from "fs/promises";
import { randomUUID } from "crypto";

const HOME = Bun.env.HOME || Bun.env.USERPROFILE || "";
if (!HOME) {
  console.error("ERROR: HOME environment variable is not set.");
  process.exit(1);
}
const CLAUDE_PROJECTS = resolve(HOME, ".claude/projects");
const DEFAULT_PORT = 3117;
const FOLDERS_PATH = resolve(HOME, ".config/cresume/folders.json");

// --- Types ---

interface SessionEntry {
  sessionId: string;
  firstPrompt?: string;
  summary?: string;
  projectPath?: string;
  gitBranch?: string;
  created?: string;
  modified?: string;
  messageCount?: number;
  isSidechain?: boolean;
  projectDir: string; // which project dir this came from
}

interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

interface SearchResult {
  title: string;
  shortId: string;
  uuid: string;
  projectPath: string | null;
  resumeCommand: string;
  date: string | null;
  score: number;
  gitBranch?: string;
  messageCount?: number;
  summary?: string;
}

// --- In-memory Session Index ---

let allSessions: SessionEntry[] = [];

export async function loadAllSessions(): Promise<SessionEntry[]> {
  const sessions: SessionEntry[] = [];
  try {
    const projectDirs = await readdir(CLAUDE_PROJECTS);
    for (const dir of projectDirs) {
      if (dir.includes("private-tmp")) continue;
      const projectDir = resolve(CLAUDE_PROJECTS, dir);
      const indexPath = resolve(projectDir, "sessions-index.json");
      try {
        const data = await readFile(indexPath, "utf-8");
        const index = JSON.parse(data);
        const entries = index?.entries || [];
        for (const entry of entries) {
          if (!entry.sessionId) continue;
          sessions.push({
            sessionId: entry.sessionId,
            firstPrompt: entry.firstPrompt,
            summary: entry.summary,
            projectPath: entry.projectPath,
            gitBranch: entry.gitBranch,
            created: entry.created,
            modified: entry.modified,
            messageCount: entry.messageCount,
            isSidechain: entry.isSidechain,
            projectDir,
          });
        }
      } catch { /* skip unreadable/missing index */ }
    }
  } catch { /* projects dir doesn't exist — new install */ }

  // Sort by modified descending (most recent first)
  sessions.sort((a, b) => {
    const ma = a.modified || a.created || "";
    const mb = b.modified || b.created || "";
    return mb.localeCompare(ma);
  });

  return sessions;
}

// --- Helpers ---

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function buildResumeCommand(projectPath: string | null, uuid: string): string {
  if (projectPath) {
    return `cd ${shellQuote(projectPath)} && claude --resume ${uuid}`;
  }
  return `claude --resume ${uuid}`;
}

export async function resolveProjectPath(projectDir: string): Promise<string | null> {
  const indexPath = resolve(projectDir, "sessions-index.json");
  try {
    const indexData = await readFile(indexPath, "utf-8");
    const index = JSON.parse(indexData);
    const projectPath = index?.entries?.[0]?.projectPath;
    if (projectPath) {
      try {
        await stat(projectPath);
        return projectPath;
      } catch { /* dir doesn't exist */ }
    }
  } catch { /* no index file */ }

  // Decode dir name: -Users-<user>-X (macOS) or -home-<user>-X (Linux) -> ~/X
  const dirName = basename(projectDir);
  const user = Bun.env.USER || Bun.env.LOGNAME || basename(HOME);
  const prefixes = [`-Users-${user}-`, `-home-${user}-`];
  for (const prefix of prefixes) {
    if (dirName.startsWith(prefix)) {
      const suffix = dirName.slice(prefix.length);
      const decoded = resolve(HOME, suffix);
      try {
        await stat(decoded);
        return decoded;
      } catch { /* doesn't exist */ }
    }
  }
  return null;
}

// --- Native Search ---

export function searchSessions(query: string, sessions: SessionEntry[], limit = 20): SearchResult[] {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    // Empty query: return most recent
    return sessions.slice(0, limit).map(s => sessionToResult(s, 0));
  }

  const scored: { session: SessionEntry; score: number }[] = [];

  for (const session of sessions) {
    const fields = [
      session.firstPrompt || "",
      session.projectPath || "",
      session.summary || "",
      session.gitBranch || "",
    ].map(f => f.toLowerCase());

    const searchable = fields.join(" ");
    let score = 0;

    for (const term of terms) {
      let termScore = 0;
      // Exact word match scores higher
      const wordBoundary = new RegExp(`\\b${escapeRegex(term)}\\b`);
      if (wordBoundary.test(searchable)) {
        termScore = 2;
      } else if (searchable.includes(term)) {
        termScore = 1;
      }
      // Boost matches in summary (more descriptive)
      if (session.summary?.toLowerCase().includes(term)) termScore += 0.5;
      // Boost matches in firstPrompt (user intent)
      if (session.firstPrompt?.toLowerCase().includes(term)) termScore += 0.3;
      score += termScore;
    }

    if (score > 0) {
      scored.push({ session, score });
    }
  }

  // Sort by score desc, then by modified desc
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ma = a.session.modified || a.session.created || "";
    const mb = b.session.modified || b.session.created || "";
    return mb.localeCompare(ma);
  });

  return scored.slice(0, limit).map(s => sessionToResult(s.session, s.score));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sessionToResult(session: SessionEntry, score: number): SearchResult {
  const shortId = session.sessionId.slice(0, 8);
  const title = session.summary?.split("\n")[0]?.slice(0, 120)
    || session.firstPrompt?.slice(0, 120)
    || "Session " + shortId;
  const dateMatch = (session.created || session.modified || "").match(/(\d{4}-\d{2}-\d{2})/);

  return {
    title,
    shortId,
    uuid: session.sessionId,
    projectPath: session.projectPath || null,
    resumeCommand: buildResumeCommand(session.projectPath || null, session.sessionId),
    date: dateMatch ? dateMatch[1] : null,
    score,
    gitBranch: session.gitBranch,
    messageCount: session.messageCount,
    summary: session.summary,
  };
}

// --- JSONL Conversation Preview ---

export async function readConversationPreview(jsonlPath: string, maxLines = 300): Promise<{ turns: ConversationTurn[]; gitBranch?: string; totalLines: number }> {
  const file = Bun.file(jsonlPath);
  const stream = file.stream();
  const decoder = new TextDecoder();

  const turns: ConversationTurn[] = [];
  let gitBranch: string | undefined;
  let lineCount = 0;
  let partial = "";

  for await (const chunk of stream) {
    partial += decoder.decode(chunk, { stream: true });
    const segments = partial.split("\n");
    partial = segments.pop() || "";

    for (const line of segments) {
      if (!line) continue;
      lineCount++;
      if (lineCount > maxLines) continue;

      try {
        const d = JSON.parse(line);
        if (!gitBranch && d.gitBranch) gitBranch = d.gitBranch;

        if (d.type === "user" || d.type === "assistant") {
          const content = d.message?.content;
          let text = "";
          if (typeof content === "string") {
            text = content;
          } else if (Array.isArray(content)) {
            text = content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text || "")
              .join("\n");
          }
          if (text.trim()) {
            turns.push({ role: d.type, text: text.slice(0, 2000) });
          }
        }
      } catch { /* skip malformed lines */ }
    }
  }
  if (partial) lineCount++;

  return { turns, gitBranch, totalLines: lineCount };
}

// --- Preview ---

interface PreviewResponse {
  shortId: string;
  previewTier: "index" | "conversation";
  firstPrompt?: string;
  summary?: string;
  projectPath?: string;
  gitBranch?: string;
  created?: string;
  modified?: string;
  messageCount?: number;
  uuid?: string;
  resumeCommand?: string;
  conversation?: ConversationTurn[];
  totalLines?: number;
}

async function handlePreview(shortId: string): Promise<Response> {
  if (!/^[0-9a-f]{8}$/.test(shortId)) {
    return Response.json({ error: "invalid shortId format" }, { status: 400 });
  }

  // Find session in loaded index
  const session = allSessions.find(s => s.sessionId.startsWith(shortId));
  if (!session) {
    return Response.json({ error: "session not found" }, { status: 404 });
  }

  const result: PreviewResponse = {
    shortId,
    previewTier: "index",
    uuid: session.sessionId,
    firstPrompt: session.firstPrompt,
    summary: session.summary,
    projectPath: session.projectPath,
    gitBranch: session.gitBranch,
    created: session.created,
    modified: session.modified,
    messageCount: session.messageCount,
    resumeCommand: buildResumeCommand(session.projectPath || null, session.sessionId),
  };

  // Try to read conversation from .jsonl
  const jsonlPath = resolve(session.projectDir, session.sessionId + ".jsonl");
  try {
    await stat(jsonlPath);
    const conv = await readConversationPreview(jsonlPath);
    result.conversation = conv.turns;
    result.totalLines = conv.totalLines;
    result.previewTier = "conversation";
    if (!result.gitBranch && conv.gitBranch) result.gitBranch = conv.gitBranch;
  } catch { /* .jsonl doesn't exist or unreadable */ }

  return Response.json(result);
}

// --- Search API ---

function handleSearch(url: URL): Response {
  const query = url.searchParams.get("q") || "";
  const count = parseInt(url.searchParams.get("n") || "20", 10);

  const results = searchSessions(query, allSessions, count);
  return Response.json({ results, total: allSessions.length });
}

// --- Folders ---

interface Folder {
  id: string;
  name: string;
  color: string;
  sessionIds: string[];
}

interface FoldersData {
  folders: Folder[];
}

let foldersData: FoldersData = { folders: [] };

export async function loadFolders(): Promise<FoldersData> {
  try {
    const data = await readFile(FOLDERS_PATH, "utf-8");
    const parsed = JSON.parse(data);
    if (parsed && Array.isArray(parsed.folders)) return parsed;
  } catch { /* file doesn't exist or is malformed */ }
  return { folders: [] };
}

async function saveFolders(data: FoldersData): Promise<void> {
  const dir = dirname(FOLDERS_PATH);
  await mkdir(dir, { recursive: true });
  // Atomic write: write to temp file, then rename
  const tmpPath = FOLDERS_PATH + ".tmp." + Date.now();
  await writeFile(tmpPath, JSON.stringify(data, null, 2));
  await rename(tmpPath, FOLDERS_PATH);
}

async function handleFoldersGet(): Promise<Response> {
  return Response.json(foldersData);
}

async function handleFoldersCreate(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body?.name || typeof body.name !== "string") {
    return Response.json({ error: "name is required" }, { status: 400 });
  }
  const color = typeof body.color === "string" && /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : "#F59E0B";
  const folder: Folder = {
    id: randomUUID().slice(0, 8),
    name: body.name.slice(0, 100),
    color,
    sessionIds: [],
  };
  foldersData.folders.push(folder);
  await saveFolders(foldersData);
  return Response.json(folder, { status: 201 });
}

async function handleFoldersDelete(folderId: string): Promise<Response> {
  const idx = foldersData.folders.findIndex(f => f.id === folderId);
  if (idx === -1) return Response.json({ error: "folder not found" }, { status: 404 });
  foldersData.folders.splice(idx, 1);
  await saveFolders(foldersData);
  return Response.json({ ok: true });
}

async function handleFoldersSessions(folderId: string, req: Request): Promise<Response> {
  const folder = foldersData.folders.find(f => f.id === folderId);
  if (!folder) return Response.json({ error: "folder not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: "invalid JSON" }, { status: 400 });

  if (body.action === "add" && typeof body.sessionId === "string") {
    if (!folder.sessionIds.includes(body.sessionId)) {
      folder.sessionIds.push(body.sessionId);
      await saveFolders(foldersData);
    }
    return Response.json(folder);
  }

  if (body.action === "remove" && typeof body.sessionId === "string") {
    folder.sessionIds = folder.sessionIds.filter(id => id !== body.sessionId);
    await saveFolders(foldersData);
    return Response.json(folder);
  }

  return Response.json({ error: "action must be 'add' or 'remove', with sessionId" }, { status: 400 });
}

async function handleFolderRename(folderId: string, req: Request): Promise<Response> {
  const folder = foldersData.folders.find(f => f.id === folderId);
  if (!folder) return Response.json({ error: "folder not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: "invalid JSON" }, { status: 400 });

  if (body.name && typeof body.name === "string") folder.name = body.name.slice(0, 100);
  if (body.color && typeof body.color === "string" && /^#[0-9a-fA-F]{6}$/.test(body.color)) folder.color = body.color;

  await saveFolders(foldersData);
  return Response.json(folder);
}

// --- Static ---

const INDEX_HTML_PATH = resolve(import.meta.dir, "index.html");

// --- Server ---

export function startServer(port: number = DEFAULT_PORT) {
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/search" && req.method === "GET") {
        return handleSearch(url);
      }

      if (url.pathname.startsWith("/api/preview/") && req.method === "GET") {
        const shortId = url.pathname.slice("/api/preview/".length);
        if (!/^[0-9a-f]{8}$/.test(shortId)) {
          return Response.json({ error: "invalid shortId" }, { status: 400 });
        }
        return handlePreview(shortId);
      }

      if (url.pathname === "/api/stats" && req.method === "GET") {
        return Response.json({ sessions: allSessions.length });
      }

      // Folder endpoints
      if (url.pathname === "/api/folders" && req.method === "GET") {
        return handleFoldersGet();
      }
      if (url.pathname === "/api/folders" && req.method === "POST") {
        return handleFoldersCreate(req);
      }
      if (url.pathname.match(/^\/api\/folders\/[^/]+$/) && req.method === "DELETE") {
        const folderId = url.pathname.split("/").pop()!;
        return handleFoldersDelete(folderId);
      }
      if (url.pathname.match(/^\/api\/folders\/[^/]+$/) && req.method === "PATCH") {
        const folderId = url.pathname.split("/").pop()!;
        return handleFolderRename(folderId, req);
      }
      if (url.pathname.match(/^\/api\/folders\/[^/]+\/sessions$/) && req.method === "PUT") {
        const parts = url.pathname.split("/");
        const folderId = parts[parts.length - 2];
        return handleFoldersSessions(folderId, req);
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        const file = Bun.file(INDEX_HTML_PATH);
        return new Response(file, { headers: { "Content-Type": "text/html" } });
      }

      return Response.json({ error: "not found" }, { status: 404 });
    },
    error() {
      return Response.json({ error: "internal server error" }, { status: 500 });
    },
  });

  return server;
}

// --- File Watcher ---

let reloadTimer: ReturnType<typeof setTimeout> | null = null;

async function watchSessionIndexes() {
  try {
    const watcher = watch(CLAUDE_PROJECTS, { recursive: true });
    for await (const event of watcher) {
      if (event.filename?.endsWith("sessions-index.json")) {
        // Debounce reloads — multiple files may change at once
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(async () => {
          const newSessions = await loadAllSessions();
          allSessions.length = 0;
          allSessions.push(...newSessions);
          console.log(`Reloaded ${allSessions.length} sessions`);
        }, 1000);
      }
    }
  } catch {
    // Watcher failed (e.g., dir doesn't exist) — non-fatal
  }
}

// --- Main ---

async function main() {
  const portArg = process.argv.find(a => a.startsWith("--port="));
  const port = portArg ? parseInt(portArg.split("=")[1], 10) : DEFAULT_PORT;

  console.log("Loading sessions...");
  allSessions = await loadAllSessions();
  if (allSessions.length === 0) {
    console.log("No Claude Code sessions found. Start a session with `claude` first.");
  } else {
    console.log(`Loaded ${allSessions.length} sessions`);
  }

  foldersData = await loadFolders();
  if (foldersData.folders.length > 0) {
    console.log(`Loaded ${foldersData.folders.length} folders`);
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
  console.log(`cresume running on http://localhost:${server.port}`);

  // Watch for new sessions in background
  watchSessionIndexes();
}

// Only run main when executed directly (not imported for tests)
if (import.meta.main) {
  main();
}

export { allSessions, foldersData };
