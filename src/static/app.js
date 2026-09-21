const WELCOME_MESSAGE =
  "你好，我会和你一起把需求讨论清楚，并持续整理为需求文档。先告诉我：这次想解决什么问题？";

const AGENT_ROLES = ["requirements", "planning", "coding", "review"];
const AGENT_META = {
  requirements: ["需求 Agent", "澄清目标并持续整理需求文档"],
  planning: ["计划 Agent", "依据已确认需求生成实施方案"],
  coding: ["编码 Agent", "按照方案实现并验证代码"],
  review: ["审核 Agent", "独立审核方案、实现与最终交付"],
};
const RECOMMENDED_AGENTS = {
  requirements: { model: "gpt-5.6-terra", reasoning_effort: "medium" },
  planning: { model: "gpt-6-astra", reasoning_effort: "high" },
  coding: { model: "gpt-5.6-sol", reasoning_effort: "high" },
  review: { model: "gpt-6-astra", reasoning_effort: "high" },
};

const state = {
  projectPath: "",
  route: "workbench",
  activeTab: "discussion",
  activeConversationId: null,
  conversations: [],
  revision: 0,
  busy: false,
  historyReady: false,
  saveTimer: null,
  models: [],
  agentConfiguration: null,
  settingsBusy: false,
};

const elements = {
  workbenchView: document.querySelector("#workbench-view"),
  requirementView: document.querySelector("#requirement-view"),
  settingsView: document.querySelector("#settings-view"),
  workbenchNav: document.querySelector("#workbench-nav"),
  settingsNav: document.querySelector("#settings-nav"),
  openProject: document.querySelector("#open-project"),
  backWorkbench: document.querySelector("#back-workbench"),
  breadcrumbWorkbench: document.querySelector("#breadcrumb-workbench"),
  workbenchProjectName: document.querySelector("#workbench-project-name"),
  workbenchProjectPath: document.querySelector("#workbench-project-path"),
  settingsProjectName: document.querySelector("#settings-project-name"),
  settingsProjectPath: document.querySelector("#settings-project-path"),
  agentConfigGrid: document.querySelector("#agent-config-grid"),
  agentConfigTemplate: document.querySelector("#agent-config-template"),
  agentConfigVersion: document.querySelector("#agent-config-version"),
  agentConfigMessage: document.querySelector("#agent-config-message"),
  restoreAgentDefaults: document.querySelector("#restore-agent-defaults"),
  saveAgentConfig: document.querySelector("#save-agent-config"),
  conversationAgentConfig: document.querySelector("#conversation-agent-config"),
  breadcrumbProject: document.querySelector("#breadcrumb-project"),
  projectName: document.querySelector("#project-name"),
  projectPath: document.querySelector("#project-path"),
  lastUpdated: document.querySelector("#last-updated"),
  discussionTab: document.querySelector("#discussion-tab"),
  documentTab: document.querySelector("#document-tab"),
  discussionPanel: document.querySelector("#discussion-panel"),
  documentPanel: document.querySelector("#document-panel"),
  messageList: document.querySelector("#message-list"),
  messageForm: document.querySelector("#message-form"),
  messageInput: document.querySelector("#message-input"),
  sendButton: document.querySelector("#send-button"),
  sendButtonLabel: document.querySelector("#send-button span"),
  agentStatus: document.querySelector("#agent-status"),
  messageTemplate: document.querySelector("#message-template"),
  newConversation: document.querySelector("#new-conversation"),
  conversationList: document.querySelector("#conversation-list"),
  conversationTemplate: document.querySelector("#conversation-template"),
  historyEmpty: document.querySelector("#history-empty"),
  historyError: document.querySelector("#history-error"),
  documentTitle: document.querySelector("#document-title"),
  documentState: document.querySelector("#document-state"),
  documentGoal: document.querySelector("#document-goal"),
  documentScope: document.querySelector("#document-scope"),
  documentNonGoals: document.querySelector("#document-non-goals"),
  documentBehaviors: document.querySelector("#document-behaviors"),
  documentAcceptance: document.querySelector("#document-acceptance"),
  decisionCount: document.querySelector("#decision-count"),
  decisionList: document.querySelector("#decision-list"),
  documentVersion: document.querySelector("#document-version"),
  createdTime: document.querySelector("#created-time"),
  updatedTime: document.querySelector("#updated-time"),
};

const routes = new Set(["workbench", "requirement", "settings"]);

function routeFromHash() {
  const route = window.location.hash.replace(/^#\//, "");
  return routes.has(route) ? route : "workbench";
}

function renderRoute(route) {
  if (state.route === "requirement" && route !== "requirement") scheduleUiSave();
  state.route = route;
  elements.workbenchView.hidden = route !== "workbench";
  elements.requirementView.hidden = route !== "requirement";
  elements.settingsView.hidden = route !== "settings";

  const workbenchActive = route !== "settings";
  elements.workbenchNav.classList.toggle("is-active", workbenchActive);
  elements.settingsNav.classList.toggle("is-active", !workbenchActive);
  if (workbenchActive) {
    elements.workbenchNav.setAttribute("aria-current", "page");
    elements.settingsNav.removeAttribute("aria-current");
  } else {
    elements.settingsNav.setAttribute("aria-current", "page");
    elements.workbenchNav.removeAttribute("aria-current");
  }

  const titles = {
    workbench: "工作台 · OneManArmy",
    requirement: "需求讨论 · OneManArmy",
    settings: "设置 · OneManArmy",
  };
  document.title = titles[route];
  if (route === "requirement") requestAnimationFrame(() => elements.messageInput.focus());
}

function navigate(route) {
  const hash = `#/${route}`;
  if (window.location.hash === hash) {
    renderRoute(route);
    return;
  }
  window.location.hash = hash;
}

function initializeRoute() {
  const route = routeFromHash();
  const expectedHash = `#/${route}`;
  if (window.location.hash !== expectedHash) window.history.replaceState(null, "", expectedHash);
  renderRoute(route);
}

function localTime(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

function fullLocalTime(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

function renderAgentSnapshot(configuration) {
  elements.conversationAgentConfig.replaceChildren();
  if (configuration === null) {
    const row = document.createElement("div");
    row.innerHTML = "<dt>状态</dt><dd></dd>";
    row.querySelector("dd").textContent = state.activeConversationId === null
      ? "首次发送消息时固化当前配置"
      : "旧需求未记录配置快照，继续使用原有执行方式";
    elements.conversationAgentConfig.append(row);
    return;
  }

  const versionRow = document.createElement("div");
  const versionTerm = document.createElement("dt");
  const versionValue = document.createElement("dd");
  versionTerm.textContent = "配置版本";
  versionValue.textContent = `v${configuration.version}`;
  versionRow.append(versionTerm, versionValue);
  elements.conversationAgentConfig.append(versionRow);

  for (const role of AGENT_ROLES) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const value = document.createElement("dd");
    term.textContent = AGENT_META[role][0];
    value.textContent = `${configuration.agents[role].model} · ${configuration.agents[role].reasoning_effort}`;
    row.append(term, value);
    elements.conversationAgentConfig.append(row);
  }
}

function modelById(modelId) {
  return state.models.find((model) => model.model === modelId);
}

function fillEffortSelect(select, modelId, selectedEffort) {
  select.replaceChildren();
  const model = modelById(modelId);
  const efforts = model?.supported_reasoning_efforts ?? [];
  for (const effort of efforts) {
    const option = document.createElement("option");
    option.value = effort.reasoning_effort;
    option.textContent = effort.description
      ? `${effort.reasoning_effort} — ${effort.description}`
      : effort.reasoning_effort;
    select.append(option);
  }
  if (!efforts.some((effort) => effort.reasoning_effort === selectedEffort)) {
    const option = document.createElement("option");
    option.value = selectedEffort;
    option.textContent = `${selectedEffort}（当前不可用）`;
    option.disabled = true;
    select.append(option);
  }
  select.value = selectedEffort;
}

function markAgentConfigurationDirty() {
  elements.agentConfigVersion.textContent = "有未保存修改";
  elements.agentConfigMessage.textContent = "保存后仅用于之后创建的需求；当前及历史需求不会改变。";
}

function renderAgentConfiguration() {
  elements.agentConfigGrid.replaceChildren();
  if (state.agentConfiguration === null) return;

  for (const role of AGENT_ROLES) {
    const profile = state.agentConfiguration.agents[role];
    const fragment = elements.agentConfigTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".agent-config-card");
    const title = fragment.querySelector("h3");
    const description = fragment.querySelector("p");
    const modelSelect = fragment.querySelector(".agent-model-select");
    const effortSelect = fragment.querySelector(".agent-effort-select");
    card.dataset.role = role;
    title.textContent = AGENT_META[role][0];
    description.textContent = AGENT_META[role][1];

    for (const model of state.models) {
      const option = document.createElement("option");
      option.value = model.model;
      option.textContent = model.display_name === model.model
        ? model.model
        : `${model.display_name} (${model.model})`;
      modelSelect.append(option);
    }
    if (!modelById(profile.model)) {
      const option = document.createElement("option");
      option.value = profile.model;
      option.textContent = `${profile.model}（当前不可用）`;
      option.disabled = true;
      modelSelect.append(option);
    }
    modelSelect.value = profile.model;
    fillEffortSelect(effortSelect, profile.model, profile.reasoning_effort);

    modelSelect.addEventListener("change", () => {
      const model = modelById(modelSelect.value);
      profile.model = modelSelect.value;
      profile.reasoning_effort = model?.default_reasoning_effort ?? profile.reasoning_effort;
      fillEffortSelect(effortSelect, profile.model, profile.reasoning_effort);
      markAgentConfigurationDirty();
    });
    effortSelect.addEventListener("change", () => {
      profile.reasoning_effort = effortSelect.value;
      markAgentConfigurationDirty();
    });
    elements.agentConfigGrid.append(fragment);
  }

  elements.agentConfigVersion.textContent = `v${state.agentConfiguration.version} · ${fullLocalTime(new Date(state.agentConfiguration.updated_at))}`;
  elements.restoreAgentDefaults.disabled = state.settingsBusy;
  elements.saveAgentConfig.disabled = state.settingsBusy;
}

function appendMessage(role, content, createdAt = new Date().toISOString()) {
  const labels = { user: "你", agent: "需求 Agent", system: "系统" };
  const fragment = elements.messageTemplate.content.cloneNode(true);
  const message = fragment.querySelector(".message");
  const avatar = fragment.querySelector(".avatar");
  const author = fragment.querySelector(".message-meta strong");
  const time = fragment.querySelector("time");
  const body = fragment.querySelector(".message-content");
  const date = new Date(createdAt);

  message.classList.add(`is-${role === "system" ? "error" : role}`);
  avatar.textContent = role === "user" ? "你" : role === "agent" ? "A" : "!";
  author.textContent = labels[role] ?? "系统";
  time.textContent = localTime(date);
  time.dateTime = createdAt;
  body.textContent = content;
  elements.messageList.append(fragment);
}

function setBusy(busy) {
  state.busy = busy;
  const unavailable = state.projectPath.length === 0 || !state.historyReady;
  elements.messageInput.disabled = busy || unavailable;
  elements.sendButton.disabled = busy || unavailable;
  elements.newConversation.disabled = busy || unavailable;
  elements.sendButtonLabel.textContent = busy ? "整理中…" : "发送";
  elements.agentStatus.textContent = busy ? "需求 Agent 正在整理需求文档" : "需求 Agent 已就绪";
  elements.agentStatus.classList.toggle("is-busy", busy);
  elements.documentState.textContent = busy ? "更新中" : state.revision > 0 ? "草稿已更新" : "等待讨论";
  for (const item of elements.conversationList.querySelectorAll("button")) item.disabled = busy;
}

function selectTab(tab) {
  if (tab === state.activeTab) return;
  if (state.activeTab === "discussion") scheduleUiSave();
  state.activeTab = tab;
  const showDiscussion = tab === "discussion";
  elements.discussionTab.classList.toggle("is-active", showDiscussion);
  elements.discussionTab.setAttribute("aria-selected", String(showDiscussion));
  elements.documentTab.classList.toggle("is-active", !showDiscussion);
  elements.documentTab.setAttribute("aria-selected", String(!showDiscussion));
  elements.discussionPanel.hidden = !showDiscussion;
  elements.documentPanel.hidden = showDiscussion;
}

function renderList(container, values) {
  container.replaceChildren();
  for (const value of values.length > 0 ? values : ["尚未确认"]) {
    const item = document.createElement("li");
    item.textContent = value;
    container.append(item);
  }
}

function renderDecisions(pendingDecisions) {
  elements.decisionList.replaceChildren();
  elements.decisionCount.textContent = `(${pendingDecisions.length})`;
  if (pendingDecisions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-decisions";
    empty.textContent = "当前没有待用户决策项。";
    elements.decisionList.append(empty);
    return;
  }
  pendingDecisions.forEach((decision, index) => {
    const item = document.createElement("div");
    item.className = "decision-item";
    const marker = document.createElement("span");
    marker.className = "decision-index";
    marker.textContent = String(index + 1);
    const text = document.createElement("span");
    text.textContent = decision;
    item.append(marker, text);
    elements.decisionList.append(item);
  });
}

function resetDocument() {
  state.revision = 0;
  elements.documentTitle.textContent = "需求文档草稿";
  elements.documentGoal.textContent = "发送第一条消息后，需求 Agent 会在这里整理目标。";
  renderList(elements.documentScope, []);
  renderList(elements.documentNonGoals, []);
  renderList(elements.documentBehaviors, []);
  renderList(elements.documentAcceptance, []);
  renderDecisions([]);
  elements.documentVersion.textContent = "v0.0";
  elements.createdTime.textContent = "—";
  elements.updatedTime.textContent = "—";
  elements.lastUpdated.textContent = "尚未生成需求文档";
  elements.documentState.textContent = "等待讨论";
  elements.documentState.classList.remove("is-ready");
}

function renderDocument(documentDraft, conversation) {
  if (documentDraft === null) {
    resetDocument();
    return;
  }
  state.revision = conversation.document_version;
  elements.documentTitle.textContent = documentDraft.title;
  elements.documentGoal.textContent = documentDraft.goal;
  renderList(elements.documentScope, documentDraft.scope);
  renderList(elements.documentNonGoals, documentDraft.non_goals);
  renderList(elements.documentBehaviors, documentDraft.behaviors);
  renderList(elements.documentAcceptance, documentDraft.acceptance_criteria);
  renderDecisions(conversation.pending_decisions);
  const createdAt = new Date(conversation.created_at);
  const updatedAt = new Date(conversation.updated_at);
  elements.documentVersion.textContent = `v0.${state.revision}`;
  elements.createdTime.textContent = fullLocalTime(createdAt);
  elements.updatedTime.textContent = fullLocalTime(updatedAt);
  elements.lastUpdated.textContent = `最后更新：${fullLocalTime(updatedAt)}`;
  elements.documentState.textContent = "草稿已更新";
  elements.documentState.classList.add("is-ready");
}

function renderConversation(conversation) {
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  state.activeConversationId = conversation.id;
  elements.messageList.replaceChildren();
  for (const message of conversation.messages) appendMessage(message.role, message.content, message.created_at);
  elements.messageInput.value = conversation.input_draft;
  renderDocument(conversation.document, conversation);
  renderAgentSnapshot(conversation.agent_config_snapshot);
  renderConversationHistory();
  elements.agentStatus.textContent = conversation.request_status === "interrupted"
    ? "上一次请求未完成，可继续发送"
    : "需求 Agent 已就绪";
  requestAnimationFrame(() => { elements.messageList.scrollTop = conversation.scroll_top; });
}

function renderNewConversation() {
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  state.activeConversationId = null;
  elements.messageList.replaceChildren();
  appendMessage("agent", WELCOME_MESSAGE);
  elements.messageInput.value = "";
  resetDocument();
  renderAgentSnapshot(null);
  elements.agentStatus.textContent = "需求 Agent 已就绪";
  renderConversationHistory();
  elements.messageList.scrollTop = 0;
}

const statusLabels = {
  discussion: "讨论中", pending_decision: "待决策", draft_updated: "草稿已更新", interrupted: "已中断",
};

function renderConversationHistory() {
  elements.conversationList.replaceChildren();
  elements.historyEmpty.hidden = state.conversations.length > 0;
  for (const conversation of state.conversations) {
    const fragment = elements.conversationTemplate.content.cloneNode(true);
    const button = fragment.querySelector(".conversation-item");
    const title = fragment.querySelector(".conversation-title");
    const time = fragment.querySelector("time");
    const status = fragment.querySelector(".conversation-status");
    button.classList.toggle("is-active", conversation.id === state.activeConversationId);
    button.disabled = state.busy;
    title.textContent = conversation.title;
    time.textContent = localTime(new Date(conversation.updated_at));
    time.dateTime = conversation.updated_at;
    status.textContent = statusLabels[conversation.status] ?? "讨论中";
    status.dataset.status = conversation.status;
    button.addEventListener("click", () => void selectConversation(conversation.id));
    elements.conversationList.append(fragment);
  }
}

function errorDetail(payload, status) {
  if (typeof payload?.detail === "string" && payload.detail.trim().length > 0) return payload.detail;
  return `请求失败（${status}）`;
}

async function apiJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(errorDetail(payload, response.status));
  return payload;
}

function discussionUrl(pathname = "") {
  return `/api/discussions${pathname}?project_path=${encodeURIComponent(state.projectPath)}`;
}

async function loadConversationHistory({ selectActive = true } = {}) {
  try {
    const payload = await apiJson(discussionUrl());
    state.historyReady = true;
    state.conversations = payload.conversations;
    elements.historyError.hidden = true;
    renderConversationHistory();
    if (!selectActive) return;
    if (payload.active_conversation_id !== null) {
      await selectConversation(payload.active_conversation_id, { saveCurrent: false, force: true });
    } else {
      renderNewConversation();
    }
  } catch (error) {
    state.historyReady = false;
    elements.historyError.textContent = error instanceof Error ? error.message : String(error);
    elements.historyError.hidden = false;
    setBusy(false);
  }
}

async function persistUiSnapshot(conversationId, inputDraft, scrollTop) {
  if (conversationId === null || state.projectPath.length === 0) return;
  try {
    await apiJson(discussionUrl(`/${encodeURIComponent(conversationId)}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input_draft: inputDraft, scroll_top: scrollTop }),
      keepalive: true,
    });
  } catch (error) {
    elements.historyError.textContent = `界面状态保存失败：${error instanceof Error ? error.message : String(error)}`;
    elements.historyError.hidden = false;
  }
}

function scheduleUiSave() {
  const conversationId = state.activeConversationId;
  if (conversationId === null) return;
  const inputDraft = elements.messageInput.value;
  const scrollTop = elements.messageList.scrollTop;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    state.saveTimer = null;
    void persistUiSnapshot(conversationId, inputDraft, scrollTop);
  }, 500);
}

async function flushUiState() {
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  await persistUiSnapshot(state.activeConversationId, elements.messageInput.value, elements.messageList.scrollTop);
}

async function selectConversation(conversationId, { saveCurrent = true, force = false } = {}) {
  if (state.busy || (!force && conversationId === state.activeConversationId)) return;
  if (saveCurrent) await flushUiState();
  try {
    const payload = await apiJson(discussionUrl(`/${encodeURIComponent(conversationId)}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: true }),
    });
    renderConversation(payload.conversation);
  } catch (error) {
    elements.historyError.textContent = error instanceof Error ? error.message : String(error);
    elements.historyError.hidden = false;
  }
}

async function startNewConversation() {
  if (state.busy) return;
  await flushUiState();
  renderNewConversation();
  elements.messageInput.focus();
}

async function sendMessage(message) {
  setBusy(true);
  try {
    const body = { project_path: state.projectPath, message };
    if (state.activeConversationId !== null) body.conversation_id = state.activeConversationId;
    const payload = await apiJson("/api/discussions/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    renderConversation(payload.conversation);
    await loadConversationHistory({ selectActive: false });
  } catch (error) {
    elements.historyError.textContent = error instanceof Error ? error.message : String(error);
    elements.historyError.hidden = false;
    setBusy(false);
    await loadConversationHistory();
  } finally {
    setBusy(false);
    elements.messageInput.focus();
  }
}

async function loadAgentConfiguration() {
  elements.agentConfigMessage.textContent = "正在读取 Codex 模型和项目配置…";
  try {
    const [modelPayload, configPayload] = await Promise.all([
      apiJson("/api/codex/models"),
      apiJson(`/api/agent-config?project_path=${encodeURIComponent(state.projectPath)}`),
    ]);
    state.models = modelPayload.models;
    state.agentConfiguration = configPayload.configuration;
    renderAgentConfiguration();
    elements.agentConfigMessage.textContent = "模型列表来自当前 Codex 环境。已有需求继续使用创建时固化的配置。";
  } catch (error) {
    elements.agentConfigMessage.textContent = `Agent 配置读取失败：${error instanceof Error ? error.message : String(error)}`;
    elements.agentConfigVersion.textContent = "不可用";
    elements.restoreAgentDefaults.disabled = true;
    elements.saveAgentConfig.disabled = true;
  }
}

async function saveAgentConfiguration() {
  if (state.agentConfiguration === null || state.settingsBusy) return;
  state.settingsBusy = true;
  elements.restoreAgentDefaults.disabled = true;
  elements.saveAgentConfig.disabled = true;
  elements.saveAgentConfig.textContent = "保存中…";
  try {
    const payload = await apiJson("/api/agent-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_path: state.projectPath,
        agents: state.agentConfiguration.agents,
      }),
    });
    state.agentConfiguration = payload.configuration;
    renderAgentConfiguration();
    elements.agentConfigMessage.textContent = "配置已保存，将从下一条新需求开始生效。";
  } catch (error) {
    elements.agentConfigMessage.textContent = `保存失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    state.settingsBusy = false;
    elements.restoreAgentDefaults.disabled = false;
    elements.saveAgentConfig.disabled = false;
    elements.saveAgentConfig.textContent = "保存配置";
  }
}

function restoreAgentDefaults() {
  if (state.agentConfiguration === null || state.settingsBusy) return;
  state.agentConfiguration.agents = structuredClone(RECOMMENDED_AGENTS);
  renderAgentConfiguration();
  markAgentConfigurationDirty();
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error(`配置读取失败（${response.status}）`);
    const config = await response.json();
    state.projectPath = config.default_project_path ?? "";
    const projectName = config.project_name || "当前项目";
    elements.projectName.textContent = projectName;
    elements.breadcrumbProject.textContent = projectName;
    elements.projectPath.textContent = state.projectPath || "未配置项目路径";
    elements.workbenchProjectName.textContent = projectName;
    elements.workbenchProjectPath.textContent = state.projectPath || "未配置项目路径";
    elements.settingsProjectName.textContent = projectName;
    elements.settingsProjectPath.textContent = state.projectPath || "未配置项目路径";
    await Promise.all([loadConversationHistory(), loadAgentConfiguration()]);
    setBusy(false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elements.projectName.textContent = "项目读取失败";
    elements.projectPath.textContent = message;
    state.projectPath = "";
    state.historyReady = false;
    setBusy(false);
  }
}

elements.workbenchNav.addEventListener("click", () => navigate("workbench"));
elements.settingsNav.addEventListener("click", () => navigate("settings"));
elements.openProject.addEventListener("click", () => navigate("requirement"));
elements.backWorkbench.addEventListener("click", () => navigate("workbench"));
elements.breadcrumbWorkbench.addEventListener("click", () => navigate("workbench"));
window.addEventListener("hashchange", () => renderRoute(routeFromHash()));
elements.discussionTab.addEventListener("click", () => selectTab("discussion"));
elements.documentTab.addEventListener("click", () => selectTab("document"));
elements.newConversation.addEventListener("click", () => void startNewConversation());
elements.restoreAgentDefaults.addEventListener("click", restoreAgentDefaults);
elements.saveAgentConfig.addEventListener("click", () => void saveAgentConfiguration());
elements.messageInput.addEventListener("input", scheduleUiSave);
elements.messageList.addEventListener("scroll", scheduleUiSave, { passive: true });
elements.messageInput.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    elements.messageForm.requestSubmit();
  }
});
elements.messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.busy) return;
  const message = elements.messageInput.value.trim();
  if (message.length === 0 || state.projectPath.length === 0) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  appendMessage("user", message);
  elements.messageList.scrollTop = elements.messageList.scrollHeight;
  elements.messageInput.value = "";
  void sendMessage(message);
});

renderNewConversation();
initializeRoute();
void loadConfig();
