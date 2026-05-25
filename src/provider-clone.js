import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import initSqlJs from "sql.js";
import { createRequire } from "node:module";
import { normalizeComparablePath, scanSessionFiles } from "./profile-utils.js";
import { assertSafeSqliteWrite, writeSqliteDatabaseSafely } from "./sqlite-safety.js";

const require = createRequire(import.meta.url);
let sqlPromise;

export async function cloneProviderThreads(options, logger = console.log) {
  const profile = path.resolve(String(options.profile || ""));
  const dryRun = Boolean(options.dryRun);
  const targetProvider = String(options.targetProvider || "");
  const sourceProviders = new Set((options.sourceProviders || []).map(String));
  const projectFilter = normalizeProjectFilters(options.project || []);

  if (!targetProvider) {
    throw new Error("targetProvider is required");
  }

  const statePath = path.join(profile, "state_5.sqlite");
  if (!existsSync(statePath)) {
    throw new Error(`state database not found: ${statePath}`);
  }

  const files = await scanSessionFiles(profile, { includeArchives: true, includeEmpty: false });
  const byId = new Map(files.map((file) => [file.sessionId, file]));
  const SQL = await getSql();
  const db = new SQL.Database(await fs.readFile(statePath));

  try {
    const columns = getColumns(db, "threads");
    const rows = selectObjects(db, `select ${columns.map(quoteIdent).join(", ")} from threads`);
    const existingTargetKeys = new Set(rows
      .filter((row) => row.model_provider === targetProvider)
      .map((row) => cloneKey(row.cwd, row.title)));

    const candidates = rows.filter((row) => {
      if (sourceProviders.size && !sourceProviders.has(row.model_provider)) {
        return false;
      }
      if (row.model_provider === targetProvider) {
        return false;
      }
      const file = byId.get(row.id);
      if (!file) {
        return false;
      }
      if (!projectFilter.length) {
        return !existingTargetKeys.has(cloneKey(row.cwd, markTitle(row.title, targetProvider)));
      }
      const cwd = normalizeComparablePath(row.cwd || file.cwd);
      return projectFilter.some((needle) => cwd.includes(needle))
        && !existingTargetKeys.has(cloneKey(row.cwd, markTitle(row.title, targetProvider)));
    });

    logger(dryRun ? "dry-run provider clone plan" : "provider clone plan");
    logger(`source providers: ${Array.from(sourceProviders).join(", ") || "any"}`);
    logger(`target provider: ${targetProvider}`);
    logger(`threads to clone: ${candidates.length}`);

    if (dryRun) {
      return { cloned: 0, planned: candidates.length };
    }

    await assertSafeSqliteWrite(statePath);

    const indexPath = path.join(profile, "session_index.jsonl");
    if (existsSync(indexPath)) {
      await fs.copyFile(indexPath, `${indexPath}.bak-${formatBackupStamp(new Date())}`);
    }

    const insertSql = `insert into threads (${columns.map(quoteIdent).join(", ")}) values (${columns.map(() => "?").join(", ")})`;
    const insert = db.prepare(insertSql);
    const appendedIndex = [];
    let cloned = 0;

    db.run("begin transaction");
    try {
      for (const row of candidates) {
        const file = byId.get(row.id);
        const newId = randomUUID();
        const newRelative = remapRolloutRelative(file.relativePath, row.id, newId);
        const newAbs = path.join(profile, newRelative);
        await cloneJsonl(file.absPath, newAbs, row.id, newId, targetProvider);

        const next = { ...row };
        next.id = newId;
        next.model_provider = targetProvider;
        next.rollout_path = newAbs;
        next.title = markTitle(row.title, targetProvider);
        next.preview = row.preview || next.title;
        insert.run(columns.map((column) => next[column]));

        appendedIndex.push({
          id: newId,
          thread_name: next.title,
          updated_at: new Date(Number(next.updated_at_ms || Date.now())).toISOString(),
        });
        cloned += 1;
      }
      db.run("commit");
    } catch (error) {
      db.run("rollback");
      throw error;
    } finally {
      insert.free();
    }

    if (cloned > 0) {
      await writeSqliteDatabaseSafely(
        statePath,
        Buffer.from(db.export()),
        formatBackupStamp(new Date()),
      );
      await appendJsonl(indexPath, appendedIndex);
    }

    logger(`cloned threads: ${cloned}`);
    logger("note: restart Codex and switch provider mode to see cloned conversations.");
    return { cloned, planned: candidates.length };
  } finally {
    db.close();
  }
}

async function cloneJsonl(source, target, oldId, newId, targetProvider) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const lines = (await fs.readFile(source, "utf8")).split(/\r?\n/);
  if (lines[0]?.trim()) {
    try {
      const first = JSON.parse(lines[0]);
      if (first?.type === "session_meta") {
        first.payload.id = newId;
        first.payload.model_provider = targetProvider;
        lines[0] = JSON.stringify(first);
      }
    } catch {
      // Fall through to global id replacement below.
    }
  }
  const text = lines.join("\n").replaceAll(oldId, newId);
  await fs.writeFile(target, text, "utf8");
}

function remapRolloutRelative(relative, oldId, newId) {
  const parsed = path.parse(relative);
  const name = parsed.base.includes(oldId)
    ? parsed.base.replace(oldId, newId)
    : `${parsed.name}-${newId}${parsed.ext}`;
  return path.join(parsed.dir, name);
}

function markTitle(title, targetProvider) {
  return title || "未命名会话";
}

function cloneKey(cwd, title) {
  return `${normalizeComparablePath(cwd)}\n${String(title || "")}`;
}

async function appendJsonl(filePath, entries) {
  if (!entries.length) {
    return;
  }
  const text = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await fs.appendFile(filePath, text, "utf8");
}

async function getSql() {
  if (!sqlPromise) {
    const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    sqlPromise = initSqlJs({ locateFile: () => wasmPath });
  }
  return sqlPromise;
}

function getColumns(db, table) {
  const result = db.exec(`pragma table_info(${quoteIdent(table)})`);
  if (!result[0]) {
    throw new Error(`table not found: ${table}`);
  }
  return result[0].values.map((row) => row[1]);
}

function selectObjects(db, sql) {
  const result = db.exec(sql);
  if (!result[0]) {
    return [];
  }
  const columns = result[0].columns;
  return result[0].values.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizeProjectFilters(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => normalizeComparablePath(entry.trim()))
    .filter(Boolean);
}

function formatBackupStamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}
