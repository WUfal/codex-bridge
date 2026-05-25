import { existsSync } from "node:fs";
import fs from "node:fs/promises";

export async function assertSafeSqliteWrite(dbPath) {
  const sidecars = [`${dbPath}-wal`, `${dbPath}-shm`];
  const active = [];

  for (const filePath of sidecars) {
    if (!existsSync(filePath)) {
      continue;
    }
    const stats = await fs.stat(filePath);
    if (stats.size > 0) {
      active.push(`${filePath} (${stats.size} bytes)`);
    }
  }

  if (active.length > 0) {
    throw new Error(
      [
        `refusing to write SQLite database while WAL/SHM sidecar files exist: ${dbPath}`,
        "Close Codex completely and retry after the sidecar files are gone.",
        "Writing the main .sqlite file while WAL data exists can corrupt or desynchronize the database.",
        `active sidecars: ${active.join(", ")}`,
      ].join(" "),
    );
  }
}

export async function writeSqliteDatabaseSafely(dbPath, data, stamp) {
  await assertSafeSqliteWrite(dbPath);

  const backupPath = `${dbPath}.bak-${stamp}`;
  const tempPath = `${dbPath}.tmp-${stamp}`;

  await fs.writeFile(tempPath, data);
  await fs.copyFile(dbPath, backupPath);

  try {
    await fs.rm(dbPath);
    await fs.rename(tempPath, dbPath);
  } catch (error) {
    if (!existsSync(dbPath) && existsSync(backupPath)) {
      await fs.copyFile(backupPath, dbPath);
    }
    throw error;
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }

  return backupPath;
}
