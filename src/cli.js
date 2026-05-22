#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeComparablePath, scanSessionFiles } from "./profile-utils.js";
import { syncThreadState } from "./state-sync.js";

const TOOL_VERSION = "0.1.0";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = parseArgs(args);

  if (!command || command === "help" || options.help) {
    printHelp();
    return;
  }

  if (command === "export") {
    await exportProfile(options);
    return;
  }

  if (command === "sync") {
    await syncProfiles(options);
    return;
  }

  if (command === "inspect") {
    await inspectBundle(options);
    return;
  }

  if (command === "import") {
    await importBundle(options);
    return;
  }

  throw new Error(`unknown command "${command}"`);
}

export async function exportProfile(options, logger = console.log) {
  const source = requirePath(options.source, "--source");
  const out = requirePath(options.out, "--out");
  const includeArchives = parseBool(options["include-archives"], true);
  const includeEmpty = parseBool(options["include-empty"], true);
  const projectFilter = normalizeProjectFilters(options.project || options.projects);

  await assertDirectory(source, "source profile");
  await prepareEmptyOutput(out);

  const sessionIndexPath = path.join(source, "session_index.jsonl");
  const sourceIndexEntries = existsSync(sessionIndexPath)
    ? await readJsonl(sessionIndexPath)
    : [];
  const sourceFiles = await scanSessionFiles(source, { includeArchives, includeEmpty });
  const selectedFiles = filterProjectFiles(sourceFiles, projectFilter);
  const selectedIds = new Set(selectedFiles.map((file) => file.sessionId).filter(Boolean));
  const indexEntries = selectedIds.size
    ? sourceIndexEntries.filter((entry) => selectedIds.has(entry?.id))
    : sourceIndexEntries;

  const manifest = {
    schema: "codex-chat-migrator.bundle.v1",
    toolVersion: TOOL_VERSION,
    exportedAt: new Date().toISOString(),
    sourceProfile: source,
    counts: {
      indexEntries: indexEntries.length,
      sessions: selectedFiles.filter((file) => file.kind === "session").length,
      archivedSessions: selectedFiles.filter((file) => file.kind === "archived_session").length,
    },
    projectFilter,
    files: [],
  };

  await fs.mkdir(path.join(out, "sessions"), { recursive: true });
  await fs.mkdir(path.join(out, "archived_sessions"), { recursive: true });

  if (existsSync(sessionIndexPath)) {
    await writeMergedIndex(path.join(out, "session_index.jsonl"), indexEntries);
    manifest.files.push(await describeCopiedFile(source, sessionIndexPath, "session_index"));
  }

  for (const file of selectedFiles) {
    const target = path.join(out, file.relativePath);
    await copyFileWithDirs(file.absPath, target);
    manifest.files.push(await describeCopiedFile(source, file.absPath, file.kind));
  }

  await writeJson(path.join(out, "manifest.json"), manifest);

  logger(`exported ${manifest.counts.sessions} sessions`);
  logger(`exported ${manifest.counts.archivedSessions} archived sessions`);
  logger(`exported ${indexEntries.length} index entries`);
  logger(`bundle: ${out}`);
}

async function inspectBundle(options) {
  const bundle = requirePath(options.bundle, "--bundle");
  const manifest = await readManifest(bundle);
  const indexPath = path.join(bundle, "session_index.jsonl");
  const indexEntries = existsSync(indexPath) ? await readJsonl(indexPath) : [];

  console.log(`bundle schema: ${manifest.schema}`);
  console.log(`tool version: ${manifest.toolVersion}`);
  console.log(`exported at: ${manifest.exportedAt}`);
  console.log(`index entries: ${indexEntries.length}`);
  console.log(`sessions: ${manifest.counts?.sessions ?? 0}`);
  console.log(`archived sessions: ${manifest.counts?.archivedSessions ?? 0}`);
  console.log(`files: ${manifest.files?.length ?? 0}`);
}

export async function importBundle(options, logger = console.log) {
  const bundle = requirePath(options.bundle, "--bundle");
  const target = requirePath(options.target, "--target");
  const dryRun = Boolean(options["dry-run"]);
  const overwrite = Boolean(options.overwrite);

  await assertDirectory(bundle, "bundle");
  await fs.mkdir(target, { recursive: true });

  const manifest = await readManifest(bundle);
  const actions = [];

  const sessionFiles = manifest.files.filter((file) => file.kind === "session");
  const archivedFiles = manifest.files.filter((file) => file.kind === "archived_session");

  for (const file of sessionFiles) {
    const sourceFile = path.join(bundle, file.relativePath);
    const targetFile = path.join(target, file.relativePath);
    actions.push(await planCopy(sourceFile, targetFile, overwrite));
  }

  for (const file of archivedFiles) {
    const sourceFile = path.join(bundle, file.relativePath);
    const targetFile = path.join(target, file.relativePath);
    actions.push(await planCopy(sourceFile, targetFile, overwrite));
  }

  const indexPlan = await planIndexMerge(
    path.join(bundle, "session_index.jsonl"),
    path.join(target, "session_index.jsonl"),
  );

  printImportPlan(actions, indexPlan, dryRun, logger);

  if (dryRun) {
    return;
  }

  const nowStamp = formatBackupStamp(new Date());
  const targetIndex = path.join(target, "session_index.jsonl");
  if (existsSync(targetIndex)) {
    await fs.copyFile(targetIndex, `${targetIndex}.bak-${nowStamp}`);
  }

  for (const action of actions) {
    if (action.type === "copy") {
      await copyFileWithDirs(action.source, action.target);
    }
  }

  await writeMergedIndex(targetIndex, indexPlan.mergedEntries);

  logger("import complete");
  logger("note: SQLite state was not modified; restart Codex if the UI does not refresh immediately.");
}

export async function syncProfiles(options, logger = console.log) {
  const source = requirePath(options.source, "--source");
  const target = requirePath(options.target, "--target");
  const dryRun = Boolean(options["dry-run"]);
  const overwrite = Boolean(options.overwrite);
  const includeArchives = parseBool(options["include-archives"], true);
  const includeEmpty = parseBool(options["include-empty"], true);
  const projectFilter = normalizeProjectFilters(options.project || options.projects);

  await assertDirectory(source, "source profile");
  await fs.mkdir(target, { recursive: true });

  const sourceFiles = await scanSessionFiles(source, { includeArchives, includeEmpty });
  const sessions = filterProjectFiles(sourceFiles, projectFilter);

  const actions = [];

  for (const file of sessions) {
    actions.push(await planCopy(file.absPath, path.join(target, file.relativePath), overwrite));
  }

  const indexPlan = await planIndexMerge(
    path.join(source, "session_index.jsonl"),
    path.join(target, "session_index.jsonl"),
    sessions,
  );

  printSyncPlan(actions, indexPlan, dryRun, logger, projectFilter);

  const statePlan = await syncThreadState({
    sourceProfile: source,
    targetProfile: target,
    selectedFiles: sessions,
    dryRun: true,
  });

  if (dryRun) {
    printStatePlan(statePlan, logger);
    return;
  }

  const nowStamp = formatBackupStamp(new Date());
  const targetIndex = path.join(target, "session_index.jsonl");
  if (existsSync(targetIndex)) {
    await fs.copyFile(targetIndex, `${targetIndex}.bak-${nowStamp}`);
  }

  for (const action of actions) {
    if (action.type === "copy") {
      await copyFileWithDirs(action.source, action.target);
    }
  }

  await writeMergedIndex(targetIndex, indexPlan.mergedEntries);

  const stateResult = await syncThreadState({
    sourceProfile: source,
    targetProfile: target,
    selectedFiles: sessions,
    dryRun: false,
  });
  printStatePlan(stateResult, logger);

  logger("sync complete");
  logger("note: restart Codex if the UI does not refresh immediately.");
}

async function planCopy(source, target, overwrite) {
  if (!existsSync(source)) {
    return { type: "missing_source", source, target };
  }

  if (existsSync(target) && !overwrite) {
    return { type: "skip_exists", source, target };
  }

  return { type: "copy", source, target };
}

async function planIndexMerge(bundleIndex, targetIndex, selectedFiles = []) {
  const importedEntries = existsSync(bundleIndex) ? await readJsonl(bundleIndex) : [];
  const currentEntries = existsSync(targetIndex) ? await readJsonl(targetIndex) : [];
  const seen = new Set();
  const mergedEntries = [];
  let added = 0;
  let skipped = 0;
  const allowedIds = new Set(selectedFiles.map((file) => file.sessionId).filter(Boolean));

  for (const entry of currentEntries) {
    const id = entry?.id;
    if (id) {
      seen.add(id);
    }
    mergedEntries.push(entry);
  }

  for (const entry of importedEntries) {
    const id = entry?.id;
    if (allowedIds.size && id && !allowedIds.has(id)) {
      continue;
    }
    if (id && seen.has(id)) {
      skipped += 1;
      continue;
    }
    if (id) {
      seen.add(id);
    }
    mergedEntries.push(entry);
    added += 1;
  }

  return {
    imported: importedEntries.length,
    current: currentEntries.length,
    added,
    skipped,
    mergedEntries,
  };
}

function printImportPlan(actions, indexPlan, dryRun, logger = console.log) {
  const copies = actions.filter((action) => action.type === "copy").length;
  const skipped = actions.filter((action) => action.type === "skip_exists").length;
  const missing = actions.filter((action) => action.type === "missing_source").length;

  logger(dryRun ? "dry-run import plan" : "import plan");
  logger(`copy files: ${copies}`);
  logger(`skip existing files: ${skipped}`);
  logger(`missing source files: ${missing}`);
  logger(`index current entries: ${indexPlan.current}`);
  logger(`index imported entries: ${indexPlan.imported}`);
  logger(`index entries to add: ${indexPlan.added}`);
  logger(`index duplicate ids skipped: ${indexPlan.skipped}`);
}

function printSyncPlan(actions, indexPlan, dryRun, logger = console.log, projectFilter = []) {
  const copies = actions.filter((action) => action.type === "copy").length;
  const skipped = actions.filter((action) => action.type === "skip_exists").length;
  const missing = actions.filter((action) => action.type === "missing_source").length;

  logger(dryRun ? "dry-run sync plan" : "sync plan");
  if (projectFilter.length) {
    logger(`project filter: ${projectFilter.join(", ")}`);
  }
  logger(`copy files: ${copies}`);
  logger(`skip existing files: ${skipped}`);
  logger(`missing source files: ${missing}`);
  logger(`index target entries: ${indexPlan.current}`);
  logger(`index source entries: ${indexPlan.imported}`);
  logger(`index entries to append: ${indexPlan.added}`);
  logger(`index duplicate ids skipped: ${indexPlan.skipped}`);
}

function printStatePlan(statePlan, logger = console.log) {
  if (statePlan.skipped) {
    logger(`sqlite thread state: skipped (${statePlan.reason})`);
    return;
  }

  logger(`sqlite thread rows to add: ${statePlan.inserted}`);
  logger(`sqlite thread duplicate ids skipped: ${statePlan.skippedExisting}`);
}

function filterProjectFiles(files, projectFilter) {
  if (!projectFilter.length) {
    return files;
  }

  return files.filter((file) => {
    const normalized = normalizeComparablePath(file.cwd);
    return projectFilter.some((needle) => normalized.includes(needle));
  });
}

function normalizeProjectFilters(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => normalizeComparablePath(entry.trim()))
    .filter(Boolean);
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

async function describeCopiedFile(sourceRoot, filePath, kind) {
  const stats = await fs.stat(filePath);
  return {
    kind,
    relativePath: normalizePath(path.relative(sourceRoot, filePath)),
    bytes: stats.size,
    sha256: await sha256File(filePath),
  };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const data = await fs.readFile(filePath);
  hash.update(data);
  return hash.digest("hex");
}

async function readManifest(bundle) {
  const manifestPath = path.join(bundle, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.schema !== "codex-chat-migrator.bundle.v1") {
    throw new Error(`unsupported bundle schema: ${manifest.schema}`);
  }
  return manifest;
}

async function readJsonl(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid JSONL at ${filePath}:${index + 1}: ${error.message}`);
      }
    });
}

async function writeMergedIndex(filePath, entries) {
  const lines = entries.map((entry) => JSON.stringify(entry));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function prepareEmptyOutput(out) {
  if (existsSync(out)) {
    const entries = await fs.readdir(out);
    if (entries.length > 0) {
      throw new Error(`output directory must be empty or absent: ${out}`);
    }
  }
  await fs.mkdir(out, { recursive: true });
}

async function copyFileWithDirs(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function assertDirectory(dir, label) {
  const stats = await fs.stat(dir).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new Error(`${label} is not a directory: ${dir}`);
  }
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

function requirePath(value, flag) {
  if (!value || value === true) {
    throw new Error(`missing required ${flag}`);
  }
  return path.resolve(String(value));
}

function parseBool(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }
  if (value === true) {
    return true;
  }
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function formatBackupStamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function printHelp() {
  console.log(`Codex Chat Migrator ${TOOL_VERSION}

Usage:
  node src/cli.js sync --source <codex-profile> --target <codex-profile> [--dry-run] [--overwrite]
  node src/cli.js export --source <codex-profile> --out <bundle-dir>
  node src/cli.js inspect --bundle <bundle-dir>
  node src/cli.js import --bundle <bundle-dir> --target <codex-profile> [--dry-run] [--overwrite]

Examples:
  node src/cli.js sync --source "%USERPROFILE%\\.codex-api" --target "%USERPROFILE%\\.codex" --dry-run
  node src/cli.js export --source "%USERPROFILE%\\.codex" --out ".\\exports\\api-profile"
  node src/cli.js inspect --bundle ".\\exports\\api-profile"
  node src/cli.js import --bundle ".\\exports\\api-profile" --target "%USERPROFILE%\\.codex" --dry-run
`);
}
