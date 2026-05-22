import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportProfile, importBundle, syncProfiles } from "./cli.js";
import { cloneProviderThreads } from "./provider-clone.js";
import { listProfiles, listProjects } from "./profile-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

let mainWindow;

ipcMain.handle("profiles:list", async () => {
  return { ok: true, profiles: await listProfiles() };
});

ipcMain.handle("projects:list", async (_event, body) => {
  try {
    const projects = await listProjects(String(body.profile || "").trim(), {
      includeArchives: body.includeArchives !== false,
      includeEmpty: body.includeEmpty !== false,
    });
    return { ok: true, projects };
  } catch (error) {
    return { ok: false, error: error.message, projects: [] };
  }
});

ipcMain.handle("sync:run", async (_event, body) => {
  const lines = [];
  try {
    await syncProfiles({
      source: String(body.source || "").trim(),
      target: String(body.target || "").trim(),
      "dry-run": body.dryRun !== false,
      overwrite: Boolean(body.overwrite),
      "include-archives": body.includeArchives !== false,
      "include-empty": body.includeEmpty !== false,
      project: body.project || [],
    }, (line) => lines.push(line));

    return { ok: true, code: 0, output: lines.join("\n"), error: "" };
  } catch (error) {
    return { ok: false, code: 1, output: lines.join("\n"), error: error.message };
  }
});

ipcMain.handle("provider-clone:run", async (_event, body) => {
  const lines = [];
  try {
    await cloneProviderThreads({
      profile: String(body.profile || "").trim(),
      dryRun: body.dryRun !== false,
      sourceProviders: body.sourceProviders || [],
      targetProvider: String(body.targetProvider || "").trim(),
      project: body.project || [],
    }, (line) => lines.push(line));

    return { ok: true, code: 0, output: lines.join("\n"), error: "" };
  } catch (error) {
    return { ok: false, code: 1, output: lines.join("\n"), error: error.message };
  }
});

ipcMain.handle("export:run", async (_event, body) => {
  const lines = [];
  try {
    await exportProfile({
      source: String(body.source || "").trim(),
      out: String(body.out || "").trim(),
      "include-archives": body.includeArchives !== false,
      "include-empty": body.includeEmpty !== false,
      project: body.project || [],
    }, (line) => lines.push(line));

    return { ok: true, code: 0, output: lines.join("\n"), error: "" };
  } catch (error) {
    return { ok: false, code: 1, output: lines.join("\n"), error: error.message };
  }
});

ipcMain.handle("import:run", async (_event, body) => {
  const lines = [];
  try {
    await importBundle({
      bundle: String(body.bundle || "").trim(),
      target: String(body.target || "").trim(),
      "dry-run": body.dryRun !== false,
      overwrite: Boolean(body.overwrite),
    }, (line) => lines.push(line));

    return { ok: true, code: 0, output: lines.join("\n"), error: "" };
  } catch (error) {
    return { ok: false, code: 1, output: lines.join("\n"), error: error.message };
  }
});

ipcMain.handle("folder:pick", async () => {
  if (!mainWindow) {
    return null;
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择 Codex profile 文件夹",
    properties: ["openDirectory"],
  });

  if (result.canceled || !result.filePaths[0]) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle("folder:save-export", async () => {
  if (!mainWindow) {
    return null;
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择导出目录",
    properties: ["openDirectory", "createDirectory"],
  });

  if (result.canceled || !result.filePaths[0]) {
    return null;
  }

  return path.join(result.filePaths[0], `codex-chat-export-${Date.now()}`);
});

app.whenReady().then(async () => {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 920,
    minHeight: 680,
    title: "CodexBridge",
    backgroundColor: "#f4f1ea",
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "electron-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    dialog.showErrorBox("界面加载失败", `${errorCode}: ${errorDescription}`);
  });

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      console.error(`[renderer] ${message} (${sourceId}:${line})`);
    }
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    dialog.showErrorBox("界面进程异常", `${details.reason}: ${details.exitCode}`);
  });

  await mainWindow.loadFile(path.join(projectRoot, "web", "index.html"));
  mainWindow.show();
  mainWindow.focus();
}).catch((error) => {
  dialog.showErrorBox("启动失败", error.stack || error.message);
  app.quit();
});

app.on("window-all-closed", () => {
  app.quit();
});
