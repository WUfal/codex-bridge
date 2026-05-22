const bridge = window.codexSync;
const sourcePath = document.querySelector("#sourcePath");
const targetPath = document.querySelector("#targetPath");
const statusEl = document.querySelector("#status");
const outputEl = document.querySelector("#output");
const includeArchives = document.querySelector("#includeArchives");
const includeEmpty = document.querySelector("#includeEmpty");
const overwrite = document.querySelector("#overwrite");
const projectsEl = document.querySelector("#projects");
const projectCount = document.querySelector("#projectCount");
const modeHint = document.querySelector("#modeHint");
const sourceLabel = document.querySelector("#sourceLabel");
const targetLabel = document.querySelector("#targetLabel");
const previewButton = document.querySelector("#preview");
const runButton = document.querySelector("#run");

let detectedProfiles = [];
let projects = [];
let selectedProjects = new Set();
let mode = "api-to-login";

window.addEventListener("error", (event) => {
  showError(event.error || event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  showError(event.reason || "未知异步错误");
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button) {
    outputEl.textContent = `已收到点击：${button.textContent.trim()}`;
  }
}, true);

document.querySelectorAll(".mode").forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});
document.querySelector("#useSourceDefault").addEventListener("click", () => useDefault("source"));
document.querySelector("#useTargetDefault").addEventListener("click", () => useDefault("target"));
document.querySelector("#browseSource").addEventListener("click", () => pickFolderInto(sourcePath));
document.querySelector("#browseTarget").addEventListener("click", () => pickFolderInto(targetPath));
document.querySelector("#refreshProjects").addEventListener("click", loadProjects);
document.querySelector("#preview").addEventListener("click", () => runAction(true));
document.querySelector("#run").addEventListener("click", () => runAction(false));

sourcePath.addEventListener("change", () => loadProjects().catch(showError));
includeArchives.addEventListener("change", () => loadProjects().catch(showError));
includeEmpty.addEventListener("change", () => loadProjects().catch(showError));

if (!bridge) {
  document.querySelector("#browseSource").disabled = true;
  document.querySelector("#browseTarget").disabled = true;
}

outputEl.textContent = bridge
  ? "桌面桥接已连接。先选模式，再选项目，最后点预览。"
  : "桌面桥接未连接，当前界面不能执行同步。";

loadProfiles().catch(showError);

async function loadProfiles() {
  setStatus("扫描配置");
  const data = bridge ? await bridge.listProfiles() : await fetchProfilesViaHttp();
  if (!data.ok) {
    throw new Error(data.error || "读取配置失败");
  }
  detectedProfiles = data.profiles || [];
  useDefault("target");
  useDefault("source");
  await loadProjects();
  setStatus("空闲");
}

async function loadProjects() {
  projectsEl.textContent = "";
  projectCount.textContent = "0";
  selectedProjects.clear();

  if (!sourcePath.value.trim()) {
    projectsEl.append(emptyProject("先选择源配置。"));
    return;
  }

  setStatus("扫描项目");
  const data = bridge
    ? await bridge.listProjects({
      profile: sourcePath.value,
      includeArchives: includeArchives.checked,
      includeEmpty: includeEmpty.checked,
    })
    : { ok: false, error: "网页调试模式暂不支持项目扫描" };

  if (!data.ok) {
    throw new Error(data.error || "项目扫描失败");
  }

  projects = data.projects || [];
  projectCount.textContent = String(projects.length);

  if (!projects.length) {
    projectsEl.append(emptyProject("没有从源配置识别到项目。"));
    setStatus("空闲");
    return;
  }

  const all = document.createElement("button");
  all.type = "button";
  all.className = "project active";
  all.dataset.cwd = "";
  all.innerHTML = "<strong>全部项目</strong><span>复制源配置里的全部会话</span>";
  all.addEventListener("click", () => {
    selectedProjects.clear();
    renderProjects();
  });
  projectsEl.append(all);

  renderProjects();
  setStatus("空闲");
}

function renderProjects() {
  projectsEl.querySelectorAll(".project:not([data-cwd=''])").forEach((node) => node.remove());
  const allButton = projectsEl.querySelector(".project[data-cwd='']");
  if (allButton) {
    allButton.classList.toggle("active", selectedProjects.size === 0);
  }

  for (const project of projects) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "project";
    item.classList.toggle("active", selectedProjects.has(project.cwd));
    item.dataset.cwd = project.cwd;

    const name = lastPathPart(project.cwd);
    item.innerHTML = `<strong>${escapeHtml(name)}</strong><span>${escapeHtml(project.cwd)}</span><em>${project.fileCount} 个会话文件</em>`;
    item.addEventListener("click", () => {
      if (selectedProjects.has(project.cwd)) {
        selectedProjects.delete(project.cwd);
      } else {
        selectedProjects.add(project.cwd);
      }
      renderProjects();
    });
    projectsEl.append(item);
  }
}

async function runAction(dryRun) {
  try {
    if (!bridge) {
      throw new Error("桌面桥接未连接。请使用桌面 exe 打开，不要直接用浏览器打开 HTML。");
    }

  if (mode === "export") {
      if (dryRun) {
        setStatus("说明");
        outputEl.textContent = "导出会创建一个迁移包目录。请选择源配置和项目，然后点“执行”。";
        return;
      }
      await runExport();
      return;
    }

    if (mode === "import") {
      await runImport(dryRun);
      return;
    }

    if (mode === "api-to-login" || mode === "login-to-api") {
      await runProviderClone(dryRun);
      return;
    }

    setStatus(dryRun ? "预览中" : "同步中");
    outputEl.textContent = "处理中...";

    const data = await bridge.runSync({
      source: sourcePath.value,
      target: targetPath.value,
      dryRun,
      overwrite: overwrite.checked,
      includeArchives: includeArchives.checked,
      includeEmpty: includeEmpty.checked,
      project: Array.from(selectedProjects),
    });

    outputEl.textContent = [data.output, data.error].filter(Boolean).join("\n\n") || "无输出。";
    setStatus(data.ok ? (dryRun ? "预览完成" : "已同步") : "失败");
    if (!dryRun && data.ok) {
      await loadProjects();
    }
  } catch (error) {
    showError(error);
  }
}

async function runProviderClone(dryRun) {
  setStatus(dryRun ? "预览中" : "克隆中");
  outputEl.textContent = "处理中...";

  const apiToLogin = mode === "api-to-login";
  const data = await bridge.runProviderClone({
    profile: sourcePath.value,
    dryRun,
    sourceProviders: apiToLogin ? ["openai", "custom"] : ["codex"],
    targetProvider: apiToLogin ? "codex" : "custom",
    project: Array.from(selectedProjects),
  });

  outputEl.textContent = [data.output, data.error].filter(Boolean).join("\n\n") || "无输出。";
  setStatus(data.ok ? (dryRun ? "预览完成" : "已克隆") : "失败");
  if (!dryRun && data.ok) {
    await loadProjects();
  }
}

async function runExport() {
  setStatus("选择导出位置");
  const out = await bridge.pickExportFolder();
  if (!out) {
    setStatus("已取消");
    return;
  }

  setStatus("导出中");
  outputEl.textContent = "处理中...";
  const data = await bridge.runExport({
    source: sourcePath.value,
    out,
    includeArchives: includeArchives.checked,
    includeEmpty: includeEmpty.checked,
    project: Array.from(selectedProjects),
  });
  outputEl.textContent = [data.output, data.error].filter(Boolean).join("\n\n") || "无输出。";
  setStatus(data.ok ? "已导出" : "失败");
}

async function runImport(dryRun) {
  setStatus(dryRun ? "预览导入" : "导入中");
  outputEl.textContent = "处理中...";
  const data = await bridge.runImport({
    bundle: sourcePath.value,
    target: targetPath.value,
    dryRun,
    overwrite: overwrite.checked,
  });
  outputEl.textContent = [data.output, data.error].filter(Boolean).join("\n\n") || "无输出。";
  setStatus(data.ok ? (dryRun ? "预览完成" : "已导入") : "失败");
}

function setMode(nextMode) {
  mode = nextMode;
  document.querySelectorAll(".mode").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });

  const hints = {
    "api-to-login": "在同一个 Codex 配置里，把 API 会话克隆成登录账号可见的会话",
    "login-to-api": "在同一个 Codex 配置里，把登录账号会话克隆成 API 模式可见的会话",
    sync: "源配置复制到目标配置，可选全部或某个项目",
    export: "把聊天记录导出成迁移包，适合换设备",
    import: "把迁移包导入到当前设备的目标配置",
  };
  modeHint.textContent = hints[mode];
  sourceLabel.textContent = mode === "import" ? "迁移包目录" : mode.includes("to") ? "Codex 配置" : "源配置";
  targetLabel.textContent = mode === "export" ? "导出位置" : mode.includes("to") ? "无需填写" : "目标配置";
  previewButton.textContent = mode === "export" ? "说明" : "预览";
  runButton.textContent = mode === "sync" ? "开始同步" : mode === "export" ? "开始导出" : mode === "import" ? "开始导入" : "开始复制";
  outputEl.textContent = mode === "api-to-login"
    ? "选择 Codex 配置和项目，把 API 会话克隆到登录账号视图。"
    : mode === "login-to-api"
      ? "选择 Codex 配置和项目，把登录账号会话克隆到 API 视图。"
      : mode === "sync"
    ? "选源配置、目标配置和项目，然后点预览。"
    : mode === "export"
      ? "选源配置和项目，点执行后选择导出位置。"
      : "源配置处选择迁移包目录，目标配置处选择要导入的 Codex 配置。";
}

function useDefault(kind) {
  const current = detectedProfiles.find((profile) => profile.label === ".codex") || detectedProfiles[0];
  if (!current) {
    return;
  }
  if (kind === "source") {
    sourcePath.value = current.path;
    loadProjects().catch(showError);
  } else {
    targetPath.value = current.path;
  }
}

async function pickFolderInto(input) {
  if (!bridge) {
    return;
  }

  const folder = await bridge.pickFolder();
  if (folder) {
    input.value = folder;
    if (input === sourcePath) {
      await loadProjects();
    }
  }
}

function emptyProject(text) {
  const item = document.createElement("div");
  item.className = "empty";
  item.textContent = text;
  return item;
}

function setStatus(value) {
  statusEl.textContent = value;
}

function showError(error) {
  setStatus("出错");
  outputEl.textContent = error?.stack || error?.message || String(error);
}

function lastPathPart(value) {
  const parts = String(value).split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function fetchProfilesViaHttp() {
  const response = await fetch("/api/profiles");
  return response.json();
}
