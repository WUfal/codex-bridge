import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import { writeSqliteDatabaseSafely } from "./sqlite-safety.js";

const require = createRequire(import.meta.url);

let sqlPromise;

export async function syncThreadState(options) {
  const sourceProfile = options.sourceProfile;
  const targetProfile = options.targetProfile;
  const selectedFiles = options.selectedFiles || [];
  const dryRun = Boolean(options.dryRun);

  const sourceDbPath = path.join(sourceProfile, "state_5.sqlite");
  const targetDbPath = path.join(targetProfile, "state_5.sqlite");

  if (!existsSync(sourceDbPath)) {
    return { skipped: true, reason: `source state db not found: ${sourceDbPath}` };
  }
  if (!existsSync(targetDbPath)) {
    return { skipped: true, reason: `target state db not found: ${targetDbPath}` };
  }

  const selectedIds = new Set(selectedFiles.map((file) => file.sessionId).filter(Boolean));
  if (!selectedIds.size) {
    return { inserted: 0, skippedExisting: 0, skippedUnselected: 0 };
  }

  const SQL = await getSql();
  const sourceDb = new SQL.Database(await fs.readFile(sourceDbPath));
  const targetDb = new SQL.Database(await fs.readFile(targetDbPath));

  try {
    const columns = getColumns(sourceDb, "threads");
    assertCompatibleColumns(columns, getColumns(targetDb, "threads"));

    const targetIds = new Set(selectValues(targetDb, "select id from threads"));
    const rows = selectObjects(sourceDb, `select ${columns.map(quoteIdent).join(", ")} from threads`);
    const insertSql = `insert into threads (${columns.map(quoteIdent).join(", ")}) values (${columns.map(() => "?").join(", ")})`;
    const insert = targetDb.prepare(insertSql);
    const rolloutPathIndex = columns.indexOf("rollout_path");

    let inserted = 0;
    let skippedExisting = 0;
    let skippedUnselected = 0;

    targetDb.run("begin transaction");
    try {
      for (const row of rows) {
        if (!selectedIds.has(row.id)) {
          skippedUnselected += 1;
          continue;
        }
        if (targetIds.has(row.id)) {
          skippedExisting += 1;
          continue;
        }

        const values = columns.map((column) => row[column]);
        if (rolloutPathIndex >= 0 && row.rollout_path) {
          values[rolloutPathIndex] = remapRolloutPath(row.rollout_path, sourceProfile, targetProfile);
        }
        insert.run(values);
        targetIds.add(row.id);
        inserted += 1;
      }
      targetDb.run("commit");
    } catch (error) {
      targetDb.run("rollback");
      throw error;
    } finally {
      insert.free();
    }

    if (inserted > 0 && !dryRun) {
      await writeSqliteDatabaseSafely(
        targetDbPath,
        Buffer.from(targetDb.export()),
        formatBackupStamp(new Date()),
      );
    }

    return { inserted, skippedExisting, skippedUnselected, dryRun };
  } finally {
    sourceDb.close();
    targetDb.close();
  }
}

async function getSql() {
  if (!sqlPromise) {
    const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    sqlPromise = initSqlJs({
      locateFile: () => wasmPath,
    });
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

function assertCompatibleColumns(sourceColumns, targetColumns) {
  const source = sourceColumns.join("\n");
  const target = targetColumns.join("\n");
  if (source !== target) {
    throw new Error("source and target threads table schemas are not compatible");
  }
}

function selectValues(db, sql) {
  const result = db.exec(sql);
  if (!result[0]) {
    return [];
  }
  return result[0].values.map((row) => row[0]);
}

function selectObjects(db, sql) {
  const result = db.exec(sql);
  if (!result[0]) {
    return [];
  }
  const columns = result[0].columns;
  return result[0].values.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

function remapRolloutPath(rolloutPath, sourceProfile, targetProfile) {
  const relative = path.relative(sourceProfile, rolloutPath);
  if (relative.startsWith("..")) {
    return rolloutPath;
  }
  return path.join(targetProfile, relative);
}

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function formatBackupStamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}
