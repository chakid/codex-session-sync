<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import "element-plus/es/components/message/style/css";
import "element-plus/es/components/message-box/style/css";
import {
  batchRetargetSessions,
  exportSelectedSessions,
  getConfig,
  getProviders,
  getSession,
  getSessions,
  importSessionArchive,
  retargetSession,
  updateConfig,
  type BatchImportResult,
  type CodexConfig,
  type ProviderStat,
  type SessionDetail,
  type SessionSummary
} from "./api";

const CODEX_HOME_STORAGE_KEY = "codex-sessions.codex-home";

const loading = ref(false);
const migrating = ref(false);
const batchMigrating = ref(false);
const exporting = ref(false);
const importing = ref(false);
const detailLoading = ref(false);
const configLoading = ref(false);
const providers = ref<ProviderStat[]>([]);
const sessions = ref<SessionSummary[]>([]);
const codexConfig = ref<CodexConfig | null>(null);
const selectedIds = ref<string[]>([]);
const sessionTableRef = ref<any>(null);
const importFileInputRef = ref<HTMLInputElement | null>(null);

const filters = reactive({
  provider: "",
  search: ""
});

const dialogVisible = ref(false);
const batchDialogVisible = ref(false);
const detailVisible = ref(false);
const importDialogVisible = ref(false);
const configDialogVisible = ref(false);
const activeSession = ref<SessionSummary | null>(null);
const detailSession = ref<SessionDetail | null>(null);
const importFile = ref<File | null>(null);
const importForm = reactive({
  force: false
});
const migrationForm = reactive({
  targetProvider: ""
});
const batchMigrationForm = reactive({
  targetProvider: ""
});
const codexHomeForm = reactive({
  codexHome: ""
});

const totalSessions = computed(() => sessions.value.length);
const providerOptions = computed(() => providers.value.map((item) => item.model_provider));
const selectedSessions = computed(() =>
  sessions.value.filter((session) => selectedIds.value.includes(session.id))
);
const currentCodexHome = computed(() => codexConfig.value?.codexHome ?? "");
const codexReadModeText = computed(() => {
  if (!codexConfig.value) {
    return "-";
  }

  if (codexConfig.value.usableReadMode === "database") {
    return "数据库";
  }

  if (codexConfig.value.usableReadMode === "rollout_fallback") {
    return "sessions 文件兜底";
  }

  return "不可用";
});
const detailConversationMessages = computed(() => detailSession.value?.conversation_messages ?? []);

function normalizeTimestamp(value: number | null | undefined) {
  if (!value) {
    return null;
  }

  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function formatDateTime(value: number | null | undefined) {
  const normalized = normalizeTimestamp(value);
  if (!normalized) {
    return "-";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(normalized));
}

function formatMessageTime(value: string | null | undefined) {
  if (!value) {
    return "";
  }

  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    return "";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(time));
}

function conversationRoleLabel(role: string) {
  if (role === "user") {
    return "用户";
  }

  if (role === "assistant") {
    return "AI";
  }

  return "工具";
}

function formatSessionTitle(row: SessionSummary | SessionDetail) {
  return row.title?.trim() || row.id;
}

function fallbackText(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  return String(value);
}

function formatBoolean(value: boolean | null | undefined) {
  if (value === true) {
    return "是";
  }
  if (value === false) {
    return "否";
  }
  return "-";
}

function trimSearch() {
  filters.search = filters.search.trim();
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isDatabaseInUseError(message: string) {
  return (
    message.includes("Codex 状态库当前正被占用") ||
    message.includes("checkpoint 之后仍被占用") ||
    message.includes("未能清理 SQLite 辅助文件")
  );
}

function buildDatabaseInUseErrorHtml(message: string) {
  const lines = message.split(/\r?\n/).filter(Boolean);
  const summary = lines[0] ?? "Codex 状态库当前正被占用，暂时无法继续。";
  const details = lines.slice(1);

  return `
    <div class="app-error-dialog">
      <div class="app-error-summary">${escapeHtml(summary)}</div>
      <div class="app-error-tip">
        请先释放本地 Codex 对状态库的占用，再重新导入。
      </div>
      <div class="app-error-section">
        <div class="app-error-section-title">推荐操作</div>
        <ol class="app-error-list">
          <li>先完全关闭本地正在运行的 Codex。</li>
          <li>如果刚重启电脑，先不要打开 Codex，先导入 session。</li>
          <li>如果还是失败，再关闭其他可能读取 SQLite 的工具后重试。</li>
        </ol>
      </div>
      <div class="app-error-section">
        <div class="app-error-section-title">关闭 Codex 命令示例</div>
        <div class="app-error-command-grid">
          <div class="app-error-command-card">
            <div class="app-error-command-label">Windows PowerShell</div>
            <pre class="app-error-command">Get-Process | Where-Object { $_.ProcessName -like '*codex*' } | Stop-Process -Force</pre>
          </div>
          <div class="app-error-command-card">
            <div class="app-error-command-label">macOS / Linux</div>
            <pre class="app-error-command">pkill -f codex</pre>
          </div>
        </div>
      </div>
      ${
        details.length
          ? `<div class="app-error-section">
              <div class="app-error-section-title">检测详情</div>
              <pre class="app-error-detail">${escapeHtml(details.join("\n"))}</pre>
            </div>`
          : ""
      }
    </div>
  `;
}

function buildGenericErrorHtml(message: string) {
  return `
    <div class="app-error-dialog">
      <div class="app-error-summary">${escapeHtml(message)}</div>
    </div>
  `;
}

async function syncTableSelection() {
  if (!sessionTableRef.value) {
    return;
  }

  sessionTableRef.value.clearSelection();
  const selectedIdSet = new Set(selectedIds.value);
  for (const session of sessions.value) {
    if (selectedIdSet.has(session.id)) {
      sessionTableRef.value.toggleRowSelection(session, true);
    }
  }
}

async function loadProviders() {
  const response = await getProviders();
  providers.value = response.providers;
}

async function loadConfig() {
  const response = await getConfig();
  codexConfig.value = response.config;
  codexHomeForm.codexHome = response.config.codexHome;
  return response.config;
}

async function loadSessions() {
  loading.value = true;
  try {
    const response = await getSessions({
      provider: filters.provider,
      search: filters.search,
      limit: 200
    });
    sessions.value = response.sessions;
    const currentIds = new Set(response.sessions.map((session) => session.id));
    selectedIds.value = selectedIds.value.filter((id) => currentIds.has(id));
    await nextTick();
    await syncTableSelection();
  } finally {
    loading.value = false;
  }
}

function showErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const html = isDatabaseInUseError(message)
    ? buildDatabaseInUseErrorHtml(message)
    : buildGenericErrorHtml(message);

  void ElMessageBox.alert(html, "操作失败", {
    confirmButtonText: "我知道了",
    customClass: "app-error-message-box",
    dangerouslyUseHTMLString: true
  });
}

async function refreshSessions() {
  try {
    await loadSessions();
  } catch (error) {
    showErrorMessage(error);
  }
}

async function refreshData() {
  try {
    await Promise.all([loadProviders(), loadSessions()]);
  } catch (error) {
    showErrorMessage(error);
  }
}

async function initializeApp() {
  configLoading.value = true;
  try {
    const storedCodexHome = window.localStorage.getItem(CODEX_HOME_STORAGE_KEY)?.trim() ?? "";
    let config = await loadConfig();

    if (storedCodexHome && storedCodexHome !== config.codexHome) {
      const response = await updateConfig({ codexHome: storedCodexHome });
      config = response.config;
      codexConfig.value = config;
      codexHomeForm.codexHome = config.codexHome;
    }

    if (!config.usable) {
      configDialogVisible.value = true;
      return;
    }

    await refreshData();
  } catch (error) {
    showErrorMessage(error);
  } finally {
    configLoading.value = false;
  }
}

function openMigrateDialog(session: SessionSummary) {
  activeSession.value = session;
  migrationForm.targetProvider = providerOptions.value.find((provider) => provider !== session.model_provider) ?? "";
  dialogVisible.value = true;
}

function openBatchMigrateDialog() {
  if (selectedSessions.value.length === 0) {
    ElMessage.warning("请先选择要迁移的会话。");
    return;
  }

  const firstProvider = selectedSessions.value[0]?.model_provider ?? "";
  const hasDifferentProviderOption = providerOptions.value.find((provider) => provider !== firstProvider);
  batchMigrationForm.targetProvider =
    selectedSessions.value.every((session) => session.model_provider === firstProvider)
      ? hasDifferentProviderOption ?? ""
      : "";
  batchDialogVisible.value = true;
}

async function openDetailDrawer(session: SessionSummary) {
  detailVisible.value = true;
  detailLoading.value = true;
  detailSession.value = null;

  try {
    const response = await getSession(session.id);
    detailSession.value = response.session;
  } catch (error) {
    detailVisible.value = false;
    showErrorMessage(error);
  } finally {
    detailLoading.value = false;
  }
}

function resetDialogState() {
  dialogVisible.value = false;
  activeSession.value = null;
  migrationForm.targetProvider = "";
}

function resetBatchDialogState() {
  batchDialogVisible.value = false;
  batchMigrationForm.targetProvider = "";
}

function resetDetailState() {
  detailVisible.value = false;
  detailLoading.value = false;
  detailSession.value = null;
}

function resetImportDialogState() {
  importDialogVisible.value = false;
  importFile.value = null;
  importForm.force = false;
  if (importFileInputRef.value) {
    importFileInputRef.value.value = "";
  }
}

function openConfigDialog() {
  codexHomeForm.codexHome = codexConfig.value?.codexHome ?? codexHomeForm.codexHome;
  configDialogVisible.value = true;
}

async function submitCodexHome() {
  const codexHome = codexHomeForm.codexHome.trim();
  if (!codexHome) {
    ElMessage.warning("请先填写 Codex 目录。");
    return;
  }

  configLoading.value = true;
  try {
    const response = await updateConfig({ codexHome });
    codexConfig.value = response.config;
    codexHomeForm.codexHome = response.config.codexHome;
    window.localStorage.setItem(CODEX_HOME_STORAGE_KEY, response.config.codexHome);

    if (!response.config.usable) {
      ElMessage.warning(response.config.reason || "当前目录仍不可用，请确认路径是否正确。");
      configDialogVisible.value = true;
      return;
    }

    configDialogVisible.value = false;
    await refreshData();
    ElMessage.success("Codex 目录已更新。");
  } catch (error) {
    showErrorMessage(error);
  } finally {
    configLoading.value = false;
  }
}

async function submitMigration() {
  if (!activeSession.value) {
    return;
  }

  if (!migrationForm.targetProvider) {
    ElMessage.warning("请选择目标 provider。");
    return;
  }

  if (migrationForm.targetProvider === activeSession.value.model_provider) {
    ElMessage.warning("目标 provider 需要和当前 provider 不同。");
    return;
  }

  try {
    await ElMessageBox.confirm(
      `将当前会话的 provider 改为 ${migrationForm.targetProvider} 后会直接写入本地 Codex 状态库，是否继续？`,
      "确认迁移",
      {
        type: "warning",
        confirmButtonText: "执行迁移",
        cancelButtonText: "取消"
      }
    );
  } catch {
    return;
  }

  migrating.value = true;
  try {
    const response = await retargetSession(activeSession.value.id, migrationForm.targetProvider);
    ElMessage.success(`迁移成功：${response.result.threadId}`);

    await refreshData();
    resetDialogState();
  } catch (error) {
    showErrorMessage(error);
  } finally {
    migrating.value = false;
  }
}

async function submitBatchMigration() {
  if (selectedSessions.value.length === 0) {
    ElMessage.warning("请先选择要迁移的会话。");
    return;
  }

  if (!batchMigrationForm.targetProvider) {
    ElMessage.warning("请选择目标 provider。");
    return;
  }

  const targetProvider = batchMigrationForm.targetProvider.trim();
  const skipped = selectedSessions.value.filter((session) => session.model_provider === targetProvider);
  const candidates = selectedSessions.value.filter((session) => session.model_provider !== targetProvider);

  if (candidates.length === 0) {
    ElMessage.warning("选中的会话当前已经属于目标 provider。");
    return;
  }

  try {
    await ElMessageBox.confirm(
      `将 ${candidates.length} 个会话迁移到 ${targetProvider}，是否继续？`,
      "确认批量迁移",
      {
        type: "warning",
        confirmButtonText: "开始迁移",
        cancelButtonText: "取消"
      }
    );
  } catch {
    return;
  }

  batchMigrating.value = true;

  try {
    const response = await batchRetargetSessions(
      candidates.map((session) => session.id),
      targetProvider
    );

    await refreshData();
    selectedIds.value = [];
    await nextTick();
    await syncTableSelection();
    resetBatchDialogState();
    const totalSkipped = skipped.length + response.result.skippedIds.length;
    const skippedSuffix = totalSkipped ? `，跳过 ${totalSkipped} 个已属于目标 provider 的会话` : "";
    ElMessage.success(`批量迁移完成：成功 ${response.result.threadIds.length} 个${skippedSuffix}`);
  } catch (error) {
    showErrorMessage(error);
  } finally {
    batchMigrating.value = false;
  }
}

function handleSelectionChange(rows: SessionSummary[]) {
  selectedIds.value = rows.map((item) => item.id);
}

function handleSearch() {
  trimSearch();
  void refreshSessions();
}

function selectAllCurrentResults() {
  selectedIds.value = sessions.value.map((session) => session.id);
  void nextTick().then(syncTableSelection);
}

function clearSelectedSessions() {
  selectedIds.value = [];
  void nextTick().then(syncTableSelection);
}

function downloadBlob(blob: Blob, filename: string) {
  const objectUrl = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(objectUrl);
}

async function handleBatchExport() {
  if (selectedSessions.value.length === 0) {
    ElMessage.warning("请先选择要导出的会话。");
    return;
  }

  exporting.value = true;
  try {
    const response = await exportSelectedSessions(selectedIds.value);
    downloadBlob(
      response.blob,
      response.filename || `codex-sessions-${new Date().toISOString().replace(/[:.]/g, "-")}.tgz`
    );
    ElMessage.success(`已导出 ${selectedIds.value.length} 个会话。`);
  } catch (error) {
    showErrorMessage(error);
  } finally {
    exporting.value = false;
  }
}

function triggerImportPicker() {
  importFileInputRef.value?.click();
}

function handleImportFileChange(event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  const file = target.files?.[0];
  if (!file) {
    return;
  }

  importFile.value = file;
  importDialogVisible.value = true;
}

function buildImportSummary(result: BatchImportResult) {
  const lines = [
    `总会话数：${result.total}`,
    `成功导入：${result.importedIds.length}`,
    `跳过：${result.skippedIds.length}`,
    `失败：${result.failed.length}`,
    `导入前备份：${result.backupPath}`,
    "如结果不符合预期，可从以上快照目录手动恢复。"
  ];

  if (result.failed.length) {
    lines.push("");
    lines.push("失败明细：");
    for (const item of result.failed.slice(0, 5)) {
      lines.push(`${item.threadId}: ${item.error}`);
    }
    if (result.failed.length > 5) {
      lines.push(`其余 ${result.failed.length - 5} 条失败明细请查看服务端返回。`);
    }
  }

  return lines.join("\n");
}

async function submitImport() {
  if (!importFile.value) {
    ElMessage.warning("请先选择会话包。");
    return;
  }

  importing.value = true;
  try {
    const response = await importSessionArchive(importFile.value, {
      force: importForm.force
    });

    await refreshData();
    resetImportDialogState();
    await ElMessageBox.alert(buildImportSummary(response.result), "导入完成", {
      confirmButtonText: "我知道了",
      customClass: "app-result-message-box"
    });
  } catch (error) {
    showErrorMessage(error);
  } finally {
    importing.value = false;
  }
}

function selectElementText(element: HTMLElement) {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

function handleSelectableDblClick(event: MouseEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const selectable = target.closest(".selectable-value");
  if (!(selectable instanceof HTMLElement)) {
    return;
  }

  selectElementText(selectable);
}

onMounted(() => {
  void initializeApp();
});
</script>

<template>
  <div class="page-shell">
    <div class="page-container">
      <input
        ref="importFileInputRef"
        type="file"
        accept=".tgz,.tar.gz,application/gzip,application/x-gzip"
        class="hidden-file-input"
        @change="handleImportFileChange"
      />

      <div class="page-stack">
        <el-card shadow="never">
          <div class="header-row">
            <div>
              <el-text type="primary">Codex Sessions</el-text>
              <h1 class="page-title">Provider 迁移控制台</h1>
              <el-text type="info">
                面向本地 `~/.codex/state_5.sqlite` 的会话迁移管理页，当前页面支持多选导出、导入迁移包和 provider 迁移。
              </el-text>
            </div>
            <el-statistic title="当前会话数" :value="totalSessions" />
          </div>
        </el-card>

        <el-alert
          :title="`当前 Codex 目录：${currentCodexHome || '-'}`"
          :type="codexConfig?.usable ? 'success' : 'warning'"
          :closable="false"
        >
          <template #default>
            <div class="codex-home-alert">
              <span>读取模式：{{ codexReadModeText }}</span>
              <span v-if="codexConfig?.reason">{{ codexConfig.reason }}</span>
              <el-button link type="primary" @click="openConfigDialog">切换 Codex 目录</el-button>
            </div>
          </template>
        </el-alert>

        <el-card shadow="never">
          <el-space wrap class="filter-row">
            <el-select
              v-model="filters.provider"
              clearable
              filterable
              placeholder="全部 provider"
              class="provider-select"
              @change="refreshSessions"
            >
              <el-option label="全部 provider" value="" />
              <el-option
                v-for="provider in providers"
                :key="provider.model_provider"
                :label="`${provider.model_provider} (${provider.count})`"
                :value="provider.model_provider"
              />
            </el-select>

            <el-input
              v-model="filters.search"
              clearable
              placeholder="搜索标题、工作目录或首条消息"
              class="search-input"
              @clear="refreshSessions"
              @keyup.enter="handleSearch"
            />

            <el-button type="primary" :loading="loading" @click="handleSearch">搜索</el-button>
            <el-button :loading="loading" @click="refreshData">刷新</el-button>
            <el-button :loading="configLoading" @click="openConfigDialog">切换 Codex 目录</el-button>
            <el-button @click="selectAllCurrentResults">全选当前筛选结果</el-button>
            <el-button @click="clearSelectedSessions">清空选择</el-button>
            <el-button type="success" :loading="exporting" :disabled="selectedSessions.length === 0" @click="handleBatchExport">
              导出选中会话
            </el-button>
            <el-button type="primary" plain :loading="importing" @click="triggerImportPicker">导入会话包</el-button>
            <el-button
              type="primary"
              plain
              :disabled="selectedSessions.length === 0"
              @click="openBatchMigrateDialog"
            >
              批量迁移
            </el-button>
            <el-button type="danger" plain disabled>批量克隆</el-button>
          </el-space>

          <div class="selection-summary">
            已选 {{ selectedSessions.length }} / 当前结果 {{ sessions.length }}
          </div>
        </el-card>

        <el-card shadow="never">
          <div class="table-wrapper">
            <el-table
              ref="sessionTableRef"
              v-loading="loading"
              :data="sessions"
              row-key="id"
              stripe
              @selection-change="handleSelectionChange"
            >
              <el-table-column type="selection" width="48" />
              <el-table-column
                label="会话 ID"
                prop="id"
                width="300"
                align="center"
                show-overflow-tooltip
              />
              <el-table-column label="Provider" prop="model_provider" width="180">
                <template #default="{ row }">
                  <el-tag effect="plain" type="warning">{{ row.model_provider }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="会话标题">
                <template #default="{ row }">
                  <el-tooltip
                    :content="formatSessionTitle(row)"
                    placement="top"
                    popper-class="session-title-tooltip"
                  >
                    <span class="session-title-text">{{ formatSessionTitle(row) }}</span>
                  </el-tooltip>
                </template>
              </el-table-column>
              <el-table-column label="更新时间" width="140" align="center">
                <template #default="{ row }">
                  <span>{{ formatDateTime(row.updated_at) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="220" fixed="right" align="center">
                <template #default="{ row }">
                  <el-space>
                    <el-button size="small" type="info" link @click="openDetailDrawer(row)">详情</el-button>
                    <el-button size="small" type="primary" link @click="openMigrateDialog(row)">迁移</el-button>
                    <el-button size="small" type="danger" link disabled>克隆</el-button>
                  </el-space>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </el-card>
      </div>

      <el-dialog
        v-model="dialogVisible"
        width="560px"
        destroy-on-close
        align-center
        @closed="resetDialogState"
      >
        <template #header>
          <div class="dialog-header">
            <el-text type="primary">会话迁移</el-text>
          </div>
        </template>

        <el-form label-position="top">
          <el-form-item label="会话 ID">
            <el-card shadow="never" class="dialog-info-card">
              <div class="dialog-info-value">{{ activeSession?.id ?? "-" }}</div>
            </el-card>
          </el-form-item>

          <el-form-item label="当前 provider">
            <el-card shadow="never" class="dialog-info-card">
              <div class="dialog-info-value">{{ activeSession?.model_provider ?? "-" }}</div>
            </el-card>
          </el-form-item>

          <el-form-item label="目标 provider">
            <el-select
              v-model="migrationForm.targetProvider"
              filterable
              allow-create
              default-first-option
              placeholder="请选择或输入 provider"
              class="dialog-provider"
            >
              <el-option
                v-for="provider in providerOptions.filter((item) => item !== activeSession?.model_provider)"
                :key="provider"
                :label="provider"
                :value="provider"
              />
            </el-select>
          </el-form-item>
        </el-form>

        <template #footer>
          <div class="dialog-footer">
            <el-button @click="resetDialogState">取消</el-button>
            <el-button type="primary" :loading="migrating" @click="submitMigration">
              执行迁移
            </el-button>
          </div>
        </template>
      </el-dialog>

      <el-dialog
        v-model="batchDialogVisible"
        width="640px"
        destroy-on-close
        align-center
        @closed="resetBatchDialogState"
      >
        <template #header>
          <div class="dialog-header">
            <el-text type="primary">批量迁移</el-text>
          </div>
        </template>

        <el-form label-position="top">
          <el-form-item :label="`会话 ID（${selectedSessions.length}）`">
            <el-card shadow="never" class="dialog-info-card">
              <el-scrollbar max-height="220px" class="batch-session-scroll">
                <div class="batch-session-list">
                  <div
                    v-for="session in selectedSessions"
                    :key="session.id"
                    class="batch-session-item"
                  >
                    {{ session.id }}
                  </div>
                </div>
              </el-scrollbar>
            </el-card>
          </el-form-item>

          <el-form-item label="目标 provider">
            <el-select
              v-model="batchMigrationForm.targetProvider"
              filterable
              allow-create
              default-first-option
              placeholder="请选择或输入 provider"
              class="dialog-provider"
            >
              <el-option
                v-for="provider in providerOptions"
                :key="provider"
                :label="provider"
                :value="provider"
              />
            </el-select>
          </el-form-item>
        </el-form>

        <template #footer>
          <div class="dialog-footer">
            <el-button @click="resetBatchDialogState">取消</el-button>
            <el-button type="primary" :loading="batchMigrating" @click="submitBatchMigration">
              开始迁移
            </el-button>
          </div>
        </template>
      </el-dialog>

      <el-dialog
        v-model="importDialogVisible"
        width="560px"
        destroy-on-close
        align-center
        @closed="resetImportDialogState"
      >
        <template #header>
          <div class="dialog-header">
            <el-text type="primary">导入会话包</el-text>
          </div>
        </template>

        <el-form label-position="top">
          <el-form-item label="已选择文件">
            <el-card shadow="never" class="dialog-info-card">
              <div class="dialog-info-value">{{ importFile?.name ?? "-" }}</div>
            </el-card>
          </el-form-item>

          <el-form-item label="导入策略">
            <div class="import-switch-row">
              <el-switch v-model="importForm.force" />
              <el-text type="info">
                强制覆盖已有会话
              </el-text>
            </div>
          </el-form-item>

          <el-alert
            type="warning"
            :closable="false"
            title="导入前会自动创建现有快照备份；如果结果不符合预期，可按返回的快照目录手动恢复。"
          />
        </el-form>

        <template #footer>
          <div class="dialog-footer">
            <el-button @click="resetImportDialogState">取消</el-button>
            <el-button type="primary" :loading="importing" @click="submitImport">
              开始导入
            </el-button>
          </div>
        </template>
      </el-dialog>

      <el-drawer
        v-model="detailVisible"
        title="会话详情"
        size="820px"
        destroy-on-close
        @dblclick="handleSelectableDblClick"
        @closed="resetDetailState"
      >
        <div v-loading="detailLoading">
          <template v-if="detailSession">
            <el-space direction="vertical" fill :size="16">
              <div>
                <span class="detail-section-title">对话记录</span>
                <div class="chat-panel">
                  <template v-if="detailConversationMessages.length">
                    <div
                      v-for="message in detailConversationMessages"
                      :key="message.id"
                      :class="['chat-row', `chat-row-${message.role}`]"
                    >
                      <div class="chat-meta">
                        <span>{{ conversationRoleLabel(message.role) }}</span>
                        <span v-if="formatMessageTime(message.timestamp)">
                          {{ formatMessageTime(message.timestamp) }}
                        </span>
                      </div>
                      <div class="chat-bubble selectable-value">
                        {{ message.content }}
                      </div>
                    </div>
                  </template>
                  <el-empty v-else description="暂无可解析的对话记录" />
                </div>
              </div>

              <el-descriptions :column="1" border class="session-detail-descriptions">
                <el-descriptions-item label="会话 ID">
                  <span class="selectable-value">{{ detailSession.id }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="会话标题">
                  <span class="selectable-value">{{ formatSessionTitle(detailSession) }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="Provider">
                  <span class="selectable-value">{{ detailSession.model_provider }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="模型">
                  <span class="selectable-value">{{ fallbackText(detailSession.model) }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="工作目录">
                  <span class="selectable-value">{{ fallbackText(detailSession.cwd) }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="JSONL 路径">
                  <span class="selectable-value">{{ fallbackText(detailSession.rollout_path) }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="JSONL 是否存在">
                  <span class="selectable-value">{{ formatBoolean(detailSession.rollout_exists) }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="创建时间">
                  <span class="selectable-value">{{ formatDateTime(detailSession.created_at) }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="更新时间">
                  <span class="selectable-value">{{ formatDateTime(detailSession.updated_at) }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="已归档">
                  <span class="selectable-value">{{ formatBoolean(detailSession.archived) }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="数据来源">
                  <span class="selectable-value">{{ fallbackText(detailSession.source) }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="审批模式">
                  <span class="selectable-value">{{ fallbackText(detailSession.approval_mode) }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="沙箱策略">
                  <span class="selectable-value">{{ fallbackText(detailSession.sandbox_policy) }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="CLI 版本">
                  <span class="selectable-value">{{ fallbackText(detailSession.cli_version) }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="推理强度">
                  <span class="selectable-value">{{ fallbackText(detailSession.reasoning_effort) }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="记忆模式">
                  <span class="selectable-value">{{ fallbackText(detailSession.memory_mode) }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="Agent 昵称">
                  <span class="selectable-value">{{ fallbackText(detailSession.agent_nickname) }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="Agent 角色">
                  <span class="selectable-value">{{ fallbackText(detailSession.agent_role) }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="Agent 路径">
                  <span class="selectable-value">{{ fallbackText(detailSession.agent_path) }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="Git 分支">
                  <span class="selectable-value">{{ fallbackText(detailSession.git_branch) }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="Git SHA">
                  <span class="selectable-value">{{ fallbackText(detailSession.git_sha) }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="Git 远端">
                  <span class="selectable-value">{{ fallbackText(detailSession.git_origin_url) }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="包含用户消息">
                  <span class="selectable-value">{{ formatBoolean(detailSession.has_user_event) }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="已用 Token">
                  <span class="selectable-value">{{ fallbackText(detailSession.tokens_used) }}</span>
                </el-descriptions-item>
              </el-descriptions>

              <div>
                <span class="detail-section-title">首条用户消息</span>
                <el-card shadow="never" class="detail-message-card">
                  <div class="detail-message-text selectable-value">
                    {{ detailSession.first_user_message || "-" }}
                  </div>
                </el-card>
              </div>

              <div>
                <span class="detail-section-title">动态工具</span>
                <div class="tool-tags">
                  <el-tag
                    v-for="tool in detailSession.dynamic_tools || []"
                    :key="`${tool.position}-${tool.name}`"
                    effect="plain"
                  >
                    {{ tool.name }}
                  </el-tag>
                  <el-text v-if="!(detailSession.dynamic_tools || []).length" type="info">
                    无
                  </el-text>
                </div>
              </div>
            </el-space>
          </template>
        </div>
      </el-drawer>
    </div>
  </div>

  <el-dialog
    v-model="configDialogVisible"
    width="640px"
    destroy-on-close
    align-center
    :close-on-click-modal="false"
  >
    <template #header>
      <div class="dialog-header">
        <el-text type="primary">Codex 目录配置</el-text>
      </div>
    </template>

    <el-form label-position="top">
      <el-form-item label="Codex 目录">
        <el-input
          v-model="codexHomeForm.codexHome"
          placeholder="例如：C:\\Users\\你的用户名\\.codex"
        />
      </el-form-item>

      <el-alert
        type="info"
        :closable="false"
        title="这里填写的是 Codex 数据目录，不是程序 exe 的安装目录。目录下通常会包含 state_5.sqlite、sessions、session_index.jsonl。"
      />

      <div v-if="codexConfig" class="config-status-card">
        <div class="config-status-line"><strong>当前目录：</strong>{{ codexConfig.codexHome }}</div>
        <div class="config-status-line"><strong>状态：</strong>{{ codexConfig.reason || "-" }}</div>
        <div class="config-status-line"><strong>数据库：</strong>{{ codexConfig.dbPath }}</div>
        <div class="config-status-line"><strong>sessions 目录：</strong>{{ codexConfig.paths.sessionsDir }}</div>
      </div>
    </el-form>

    <template #footer>
      <div class="dialog-footer">
        <el-button @click="configDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="configLoading" @click="submitCodexHome">应用目录</el-button>
      </div>
    </template>
  </el-dialog>
</template>
