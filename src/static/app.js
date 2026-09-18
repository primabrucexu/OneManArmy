const form = document.querySelector("#run-form");
const projectPath = document.querySelector("#project-path");
const runButton = document.querySelector("#run-button");
const statusBadge = document.querySelector("#status-badge");
const emptyState = document.querySelector("#empty-state");
const resultState = document.querySelector("#result-state");
const errorState = document.querySelector("#error-state");
const errorMessage = document.querySelector("#error-message");
const threadId = document.querySelector("#thread-id");
const resultMode = document.querySelector("#result-mode");
const responseOutput = document.querySelector("#response-output");
const writeWarning = document.querySelector("#write-warning");

function selectedSandbox() {
  return form.elements.sandbox.value;
}

function setStatus(state, text) {
  statusBadge.dataset.state = state;
  statusBadge.textContent = text;
}

function setBusy(busy) {
  runButton.disabled = busy;
  runButton.querySelector("span:first-child").textContent = busy
    ? "Codex 正在运行…"
    : "运行 Codex";
}

function showError(message) {
  emptyState.hidden = true;
  resultState.hidden = true;
  errorState.hidden = false;
  errorMessage.textContent = message;
  setStatus("error", "失败");
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) return;
    const config = await response.json();
    projectPath.value = config.default_project_path ?? "";
  } catch {
    // The form remains usable when the default path cannot be loaded.
  }
}

form.addEventListener("change", () => {
  writeWarning.hidden = selectedSandbox() !== "workspace_write";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(form);

  setBusy(true);
  setStatus("running", "运行中");
  emptyState.hidden = false;
  resultState.hidden = true;
  errorState.hidden = true;
  emptyState.querySelector("p").textContent = "Codex 正在处理任务…";

  try {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_path: data.get("project_path"),
        prompt: data.get("prompt"),
        sandbox: data.get("sandbox"),
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      const detail = Array.isArray(payload.detail)
        ? payload.detail.map((item) => item.msg).join("；")
        : payload.detail;
      throw new Error(detail || `请求失败（${response.status}）`);
    }

    emptyState.hidden = true;
    errorState.hidden = true;
    resultState.hidden = false;
    threadId.textContent = payload.thread_id;
    resultMode.textContent =
      data.get("sandbox") === "workspace_write" ? "可写" : "只读";
    responseOutput.textContent = payload.response || "Codex 未返回文本结果。";
    setStatus("done", "已完成");
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
    if (!resultState.hidden || !errorState.hidden) {
      emptyState.querySelector("p").textContent = "结果会显示在这里。";
    }
  }
});

loadConfig();
