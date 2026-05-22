import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export function normalizeComparablePath(value) {
  return path
    .normalize(String(value || ""))
    .replaceAll("/", "\\")
    .toLowerCase();
}

export async function listProfiles() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const candidates = [
    path.join(home, ".codex"),
    path.join(home, ".codex-api"),
    path.join(home, ".codex-account"),
    path.join(home, ".codex-backup"),
  ];

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    candidates.push(path.join(localAppData, "Codex"));
  }

  const profiles = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    profiles.push(await summarizeProfile(candidate));
  }

  return profiles;
}

export async function listProjects(profilePath, options = {}) {
  const sessionFiles = await scanSessionFiles(profilePath, options);
  const projects = new Map();

  for (const file of sessionFiles) {
    if (!file.cwd) {
      continue;
    }

    const key = normalizeComparablePath(file.cwd);
    const current = projects.get(key) || {
      cwd: file.cwd,
      sessionCount: 0,
      archivedCount: 0,
      fileCount: 0,
      threadNames: new Set(),
    };

    current.fileCount += 1;
    current.sessionCount += file.kind === "session" ? 1 : 0;
    current.archivedCount += file.kind === "archived_session" ? 1 : 0;
    if (file.threadName) {
      current.threadNames.add(file.threadName);
    }
    projects.set(key, current);
  }

  return Array.from(projects.values())
    .map((project) => ({
      cwd: project.cwd,
      fileCount: project.fileCount,
      sessionCount: project.sessionCount,
      archivedCount: project.archivedCount,
      threadNames: Array.from(project.threadNames).slice(0, 3),
    }))
    .sort((a, b) => b.fileCount - a.fileCount || a.cwd.localeCompare(b.cwd));
}

export async function summarizeProfile(profilePath) {
  const indexPath = path.join(profilePath, "session_index.jsonl");
  const sessionsPath = path.join(profilePath, "sessions");
  const archivedPath = path.join(profilePath, "archived_sessions");

  return {
    path: profilePath,
    label: path.basename(profilePath),
    hasIndex: existsSync(indexPath),
    indexEntries: existsSync(indexPath) ? await countJsonl(indexPath) : 0,
    sessions: await countFiles(sessionsPath, ".jsonl"),
    archivedSessions: await countFiles(archivedPath, ".jsonl"),
  };
}

export async function scanSessionFiles(profilePath, options = {}) {
  const includeArchives = options.includeArchives !== false;
  const includeEmpty = options.includeEmpty !== false;
  const found = [];

  for (const kind of ["sessions", includeArchives ? "archived_sessions" : null].filter(Boolean)) {
    const root = path.join(profilePath, kind);
    const files = await collectFiles(root, includeEmpty);
    for (const absPath of files) {
      const meta = await readSessionMeta(absPath);
      found.push({
        absPath,
        kind: kind === "sessions" ? "session" : "archived_session",
        relativePath: path.relative(profilePath, absPath),
        cwd: meta?.cwd || "",
        threadName: meta?.thread_name || "",
        sessionId: meta?.id || "",
      });
    }
  }

  return found;
}

async function countJsonl(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return text.split(/\r?\n/).filter((line) => line.trim()).length;
}

async function countFiles(root, extension) {
  if (!existsSync(root)) {
    return 0;
  }

  let count = 0;
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      count += await countFiles(fullPath, extension);
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      count += 1;
    }
  }
  return count;
}

async function collectFiles(root, includeEmpty) {
  if (!existsSync(root)) {
    return [];
  }

  const found = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...await collectFiles(fullPath, includeEmpty));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const stats = await fs.stat(fullPath);
    if (!includeEmpty && stats.size === 0) {
      continue;
    }
    found.push(fullPath);
  }
  return found;
}

async function readSessionMeta(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const firstLine = await readFirstLine(handle);
    if (!firstLine) {
      return null;
    }
    const record = JSON.parse(firstLine);
    if (record?.type !== "session_meta") {
      return null;
    }
    return record?.payload || null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function readFirstLine(handle) {
  const buffer = Buffer.alloc(1024 * 1024);
  const result = await handle.read(buffer, 0, buffer.length, 0);
  const chunk = buffer.subarray(0, result.bytesRead).toString("utf8");
  const index = chunk.indexOf("\n");
  return index >= 0 ? chunk.slice(0, index).trim() : chunk.trim();
}
