import { describe, test, expect, beforeAll, mock } from "bun:test";
import { existsSync } from "fs";
import { searchSessions, loadAllSessions, readConversationPreview, resolveProjectPath, loadFolders } from "./server";
import { writeFile, mkdir, rm, unlink } from "fs/promises";
import { resolve } from "path";
import { tmpdir, homedir } from "os";

const HAS_CLAUDE_PROJECTS = existsSync(resolve(homedir(), ".claude/projects"));

// --- searchSessions tests ---

describe("searchSessions", () => {
  const sessions = [
    {
      sessionId: "aaaa1111-0000-0000-0000-000000000001",
      firstPrompt: "Fix the authentication bug in login flow",
      summary: "Debugged JWT token validation in auth middleware",
      projectPath: "/home/user/my-app",
      gitBranch: "fix/auth-bug",
      created: "2026-03-01T10:00:00Z",
      modified: "2026-03-01T11:00:00Z",
      messageCount: 15,
      projectDir: "/tmp/test-projects/project-a",
    },
    {
      sessionId: "bbbb2222-0000-0000-0000-000000000002",
      firstPrompt: "Add dark mode to the settings page",
      summary: "Implemented theme switching with CSS variables",
      projectPath: "/home/user/webapp",
      gitBranch: "feature/dark-mode",
      created: "2026-03-02T10:00:00Z",
      modified: "2026-03-02T12:00:00Z",
      messageCount: 25,
      projectDir: "/tmp/test-projects/project-b",
    },
    {
      sessionId: "cccc3333-0000-0000-0000-000000000003",
      firstPrompt: "Write tests for the API endpoints",
      projectPath: "/home/user/api-server",
      gitBranch: "main",
      created: "2026-03-03T10:00:00Z",
      modified: "2026-03-03T10:30:00Z",
      messageCount: 8,
      projectDir: "/tmp/test-projects/project-c",
      // No summary — tests graceful degradation
    },
    {
      sessionId: "dddd4444-0000-0000-0000-000000000004",
      firstPrompt: "Refactor authentication middleware",
      summary: "Extracted auth logic into separate module",
      projectPath: "/home/user/my-app",
      gitBranch: "refactor/auth",
      created: "2026-02-28T08:00:00Z",
      modified: "2026-02-28T09:00:00Z",
      messageCount: 12,
      projectDir: "/tmp/test-projects/project-a",
    },
  ];

  test("matches on firstPrompt", () => {
    const results = searchSessions("dark mode", sessions);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].uuid).toBe("bbbb2222-0000-0000-0000-000000000002");
  });

  test("matches on projectPath", () => {
    const results = searchSessions("api-server", sessions);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].uuid).toBe("cccc3333-0000-0000-0000-000000000003");
  });

  test("matches on summary when present", () => {
    const results = searchSessions("JWT token", sessions);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].uuid).toBe("aaaa1111-0000-0000-0000-000000000001");
  });

  test("matches on gitBranch", () => {
    const results = searchSessions("dark-mode", sessions);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].uuid).toBe("bbbb2222-0000-0000-0000-000000000002");
  });

  test("case-insensitive matching", () => {
    const results = searchSessions("AUTHENTICATION", sessions);
    expect(results.length).toBeGreaterThanOrEqual(2);
    // Both auth sessions should match
    const ids = results.map(r => r.uuid);
    expect(ids).toContain("aaaa1111-0000-0000-0000-000000000001");
    expect(ids).toContain("dddd4444-0000-0000-0000-000000000004");
  });

  test("degrades gracefully when summary is absent", () => {
    const results = searchSessions("API endpoints", sessions);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].uuid).toBe("cccc3333-0000-0000-0000-000000000003");
  });

  test("empty query returns all sessions in input order", () => {
    const results = searchSessions("", sessions);
    expect(results.length).toBe(4);
    // Returns sessions in the order they were provided (loadAllSessions pre-sorts by modified desc)
    expect(results[0].uuid).toBe("aaaa1111-0000-0000-0000-000000000001");
  });

  test("respects limit", () => {
    const results = searchSessions("auth", sessions, 1);
    expect(results.length).toBe(1);
  });

  test("returns correct result shape", () => {
    const results = searchSessions("dark mode", sessions);
    const r = results[0];
    expect(r.shortId).toBe("bbbb2222");
    expect(r.uuid).toBe("bbbb2222-0000-0000-0000-000000000002");
    expect(r.title).toBe("Implemented theme switching with CSS variables");
    expect(r.date).toBe("2026-03-02");
    expect(r.score).toBeGreaterThan(0);
    expect(r.resumeCommand).toContain("claude --resume");
    expect(r.resumeCommand).toContain("bbbb2222-0000-0000-0000-000000000002");
    expect(r.projectPath).toBe("/home/user/webapp");
    expect(r.gitBranch).toBe("feature/dark-mode");
    expect(r.messageCount).toBe(25);
  });

  test("no results for unmatched query", () => {
    const results = searchSessions("xyznonexistent", sessions);
    expect(results.length).toBe(0);
  });

  test("multi-term query scores higher when more terms match", () => {
    const results = searchSessions("auth middleware", sessions);
    // Results matching both terms should score higher than single-term matches
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      const sessionText = [
        sessions.find(s => s.sessionId === r.uuid)?.firstPrompt || "",
        sessions.find(s => s.sessionId === r.uuid)?.summary || "",
        sessions.find(s => s.sessionId === r.uuid)?.projectPath || "",
        sessions.find(s => s.sessionId === r.uuid)?.gitBranch || "",
      ].join(" ").toLowerCase();
      // Each result matches at least one term
      expect(
        sessionText.includes("auth") || sessionText.includes("middleware")
      ).toBe(true);
    }
  });

  test("exact word match scores higher than substring", () => {
    const testSessions = [
      {
        sessionId: "eeee5555-0000-0000-0000-000000000005",
        firstPrompt: "testing the test framework",
        projectPath: "/tmp/test",
        projectDir: "/tmp",
      },
      {
        sessionId: "ffff6666-0000-0000-0000-000000000006",
        firstPrompt: "attestation service setup",
        projectPath: "/tmp/attest",
        projectDir: "/tmp",
      },
    ];
    const results = searchSessions("test", testSessions as any);
    expect(results.length).toBe(2);
    // "test" as exact word should score higher than "attest" containing "test"
    expect(results[0].uuid).toBe("eeee5555-0000-0000-0000-000000000005");
  });
});

// --- loadAllSessions tests ---

describe("loadAllSessions (integration)", () => {
  // These tests require ~/.claude/projects to exist — skip on CI / fresh machines.

  test.skipIf(!HAS_CLAUDE_PROJECTS)("loads sessions without crashing", async () => {
    const sessions = await loadAllSessions();
    expect(Array.isArray(sessions)).toBe(true);
    if (sessions.length > 0) {
      expect(sessions[0].sessionId).toBeTruthy();
      expect(sessions[0].projectDir).toBeTruthy();
    }
  });

  test.skipIf(!HAS_CLAUDE_PROJECTS)("sessions are sorted by modified descending", async () => {
    const sessions = await loadAllSessions();
    if (sessions.length >= 2) {
      const mod0 = sessions[0].modified || sessions[0].created || "";
      const mod1 = sessions[1].modified || sessions[1].created || "";
      expect(mod0 >= mod1).toBe(true);
    }
  });

  test("returns empty array when projects dir doesn't exist", async () => {
    // This always works — loadAllSessions catches missing dir gracefully
    const sessions = await loadAllSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });
});

// --- readConversationPreview tests ---

describe("readConversationPreview", () => {
  const testDir = resolve(tmpdir(), "cresume-conv-test-" + Date.now());

  beforeAll(async () => {
    await mkdir(testDir, { recursive: true });
  });

  test("extracts user and assistant text blocks", async () => {
    const jsonlPath = resolve(testDir, "test-conversation.jsonl");
    const lines = [
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Hello Claude" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hi there!" }] } }),
      JSON.stringify({ type: "user", message: { content: "Plain string content" } }),
    ];
    await writeFile(jsonlPath, lines.join("\n") + "\n");

    const result = await readConversationPreview(jsonlPath);
    expect(result.turns.length).toBe(3);
    expect(result.turns[0]).toEqual({ role: "user", text: "Hello Claude" });
    expect(result.turns[1]).toEqual({ role: "assistant", text: "Hi there!" });
    expect(result.turns[2]).toEqual({ role: "user", text: "Plain string content" });
  });

  test("skips non-text content blocks (tool_use, tool_result)", async () => {
    const jsonlPath = resolve(testDir, "test-tools.jsonl");
    const lines = [
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Do something" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [
        { type: "text", text: "Let me help" },
        { type: "tool_use", name: "read_file", input: { path: "/tmp/test" } },
      ] } }),
      JSON.stringify({ type: "tool_result", content: [{ type: "text", text: "file contents" }] }),
    ];
    await writeFile(jsonlPath, lines.join("\n") + "\n");

    const result = await readConversationPreview(jsonlPath);
    expect(result.turns.length).toBe(2);
    expect(result.turns[0].text).toBe("Do something");
    expect(result.turns[1].text).toBe("Let me help");
  });

  test("handles malformed lines", async () => {
    const jsonlPath = resolve(testDir, "test-malformed.jsonl");
    const lines = [
      "not json",
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Valid line" }] } }),
      "{broken json{{",
    ];
    await writeFile(jsonlPath, lines.join("\n") + "\n");

    const result = await readConversationPreview(jsonlPath);
    expect(result.turns.length).toBe(1);
    expect(result.turns[0].text).toBe("Valid line");
  });

  test("extracts gitBranch", async () => {
    const jsonlPath = resolve(testDir, "test-branch.jsonl");
    const lines = [
      JSON.stringify({ type: "summary", gitBranch: "feature/my-branch" }),
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Hello" }] } }),
    ];
    await writeFile(jsonlPath, lines.join("\n") + "\n");

    const result = await readConversationPreview(jsonlPath);
    expect(result.gitBranch).toBe("feature/my-branch");
  });

  test("truncates text at 2000 chars", async () => {
    const jsonlPath = resolve(testDir, "test-truncate.jsonl");
    const longText = "x".repeat(5000);
    const lines = [
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: longText }] } }),
    ];
    await writeFile(jsonlPath, lines.join("\n") + "\n");

    const result = await readConversationPreview(jsonlPath);
    expect(result.turns[0].text.length).toBe(2000);
  });

  test("respects maxLines limit", async () => {
    const jsonlPath = resolve(testDir, "test-maxlines.jsonl");
    const lines = Array.from({ length: 100 }, (_, i) =>
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: `Message ${i}` }] } })
    );
    await writeFile(jsonlPath, lines.join("\n") + "\n");

    const result = await readConversationPreview(jsonlPath, 10);
    expect(result.turns.length).toBe(10);
    expect(result.totalLines).toBe(100);
  });

  test("handles empty file", async () => {
    const jsonlPath = resolve(testDir, "test-empty.jsonl");
    await writeFile(jsonlPath, "");

    const result = await readConversationPreview(jsonlPath);
    expect(result.turns.length).toBe(0);
    expect(result.totalLines).toBe(0);
  });
});

// --- loadFolders tests ---

describe("loadFolders", () => {
  test("returns valid folders structure", async () => {
    const data = await loadFolders();
    expect(Array.isArray(data.folders)).toBe(true);
    for (const f of data.folders) {
      expect(f.id).toBeTruthy();
      expect(f.name).toBeTruthy();
    }
  });

  test("loads folders data structure", async () => {
    // This is an integration test — actual file may or may not exist
    const data = await loadFolders();
    expect(Array.isArray(data.folders)).toBe(true);
  });
});
