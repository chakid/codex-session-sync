import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as tar from "tar";
import { loadDatabase, selectAll, selectOne } from "./sqlite.js";
import {
  buildRolloutPath,
  createThreadId,
  currentUnixTime,
  ensureFile,
  ensureParentDir,
  expandHome,
  formatTimestamp,
  getBackupDir,
  resolveCodexHome,
  resolveDbPath,
  toBoolean
} from "./utils.js";

const execFileAsync = promisify(execFile);
const EXPORT_SQL_PLACEHOLDER = "__CODEX_SESSIONS_ROLLOUT_PATH__";
const EXPORT_BUNDLE_VERSION = 1;
const EXPORT_ARCHIVE_EXT = ".tgz";
const EXPORT_BUNDLE_TYPE_BATCH = "session-batch";

const THREAD_COLUMNS = [
  "id",
  "rollout_path",
  "created_at",
  "updated_at",
  "source",
  "model_provider",
  "cwd",
  "title",
  "sandbox_policy",
  "approval_mode",
  "tokens_used",
  "has_user_event",
  "archived",
  "archived_at",
  "git_sha",
  "git_branch",
  "git_origin_url",
  "cli_version",
  "first_user_message",
  "agent_nickname",
  "agent_role",
  "memory_mode",
  "model",
  "reasoning_effort",
  "agent_path"
];

const ROLLOUT_THREAD_ID_KEYS = new Set([
  "thread_id",
  "parent_thread_id",
  "child_thread_id",
  "assigned_thread_id",
  "threadId",
  "parentThreadId",
  "childThreadId",
  "assignedThreadId"
]);

function isInsideDir(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function encodeSqlLiteral(value) {
  if (value == null) {
    return "NULL";
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot encode non-finite number into export SQL.");
    }

    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }

  return `'${String(value).replace(/'/g, "''")}'`;
}

function escapeSqlStringContent(value) {
  return String(value).replace(/'/g, "''");
}

function formatSessionIndexUpdatedAt(thread) {
  const updatedAtMs = Number(thread.updated_at_ms);
  if (Number.isFinite(updatedAtMs) && updatedAtMs > 0) {
    return new Date(updatedAtMs).toISOString();
  }

  const updatedAt = Number(thread.updated_at);
  if (Number.isFinite(updatedAt) && updatedAt > 0) {
    return new Date(updatedAt < 1_000_000_000_000 ? updatedAt * 1000 : updatedAt).toISOString();
  }

  return new Date().toISOString();
}

function formatSessionIndexThreadName(thread) {
  const candidates = [thread.thread_name, thread.title, thread.first_user_message, thread.id];

  for (const candidate of candidates) {
    if (candidate == null) {
      continue;
    }

    const normalized = String(candidate).replace(/\s+/g, " ").trim();
    if (!normalized) {
      continue;
    }

    return normalized.length > 120 ? `${normalized.slice(0, 117).trimEnd()}...` : normalized;
  }

  return "";
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function normalizeSessionTitle(value, fallback = "") {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || fallback;
}

function normalizeMessageContent(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function toEpochSeconds(value, fallback = 0) {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed / 1000);
    }
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.floor(numeric < 1_000_000_000_000 ? numeric : numeric / 1000);
  }

  return fallback;
}

function extractThreadIdFromRolloutPath(filePath) {
  const match = path.basename(filePath).match(/-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i);
  return match ? match[1] : "";
}

function extractFirstUserMessageFromRecord(record) {
  if (!record || typeof record !== "object") {
    return "";
  }

  if (record.type === "event_msg" && record.payload?.type === "user_message") {
    return normalizeSessionTitle(record.payload.message ?? "");
  }

  if (
    record.type === "response_item" &&
    record.payload?.type === "message" &&
    record.payload?.role === "user" &&
    Array.isArray(record.payload.content)
  ) {
    for (const item of record.payload.content) {
      const text = item?.text;
      if (typeof text === "string" && text.trim()) {
        return normalizeSessionTitle(text);
      }
    }
  }

  return "";
}

function extractTextFromContentItems(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }

      if (typeof item.text === "string") {
        return item.text;
      }

      if (typeof item.input_text === "string") {
        return item.input_text;
      }

      if (typeof item.output_text === "string") {
        return item.output_text;
      }

      return "";
    })
    .filter((text) => text.trim())
    .join("\n\n");
}

function isInternalUserMessage(content) {
  const trimmed = content.trim();
  return (
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<turn_aborted>") ||
    trimmed.startsWith("<permissions instructions>") ||
    trimmed.startsWith("<collaboration_mode>") ||
    trimmed.startsWith("<apps_instructions>") ||
    trimmed.startsWith("<skills_instructions>") ||
    trimmed.startsWith("<plugins_instructions>")
  );
}

function extractConversationMessageFromRecord(record, index) {
  if (!record || typeof record !== "object") {
    return null;
  }

  const timestamp = typeof record.timestamp === "string" ? record.timestamp : "";

  if (
    record.type === "response_item" &&
    record.payload?.type === "message" &&
    (record.payload.role === "user" || record.payload.role === "assistant")
  ) {
    const content = normalizeMessageContent(extractTextFromContentItems(record.payload.content));
    if (!content) {
      return null;
    }
    if (record.payload.role === "user" && isInternalUserMessage(content)) {
      return null;
    }

    return {
      id: `${index}-${record.payload.role}`,
      role: record.payload.role,
      content,
      timestamp,
      source: "response_item"
    };
  }

  if (record.type === "event_msg" && record.payload?.type === "user_message") {
    const content = normalizeMessageContent(record.payload.message ?? "");
    if (!content) {
      return null;
    }
    if (isInternalUserMessage(content)) {
      return null;
    }

    return {
      id: `${index}-user-event`,
      role: "user",
      content,
      timestamp,
      source: "event_msg"
    };
  }

  if (record.type === "event_msg" && record.payload?.type === "agent_message") {
    const content = normalizeMessageContent(record.payload.message ?? "");
    if (!content) {
      return null;
    }

    return {
      id: `${index}-assistant-event`,
      role: "assistant",
      content,
      timestamp,
      source: "event_msg"
    };
  }

  return null;
}

function dedupeAdjacentConversationMessages(messages) {
  const deduped = [];
  let lastKey = "";

  for (const message of messages) {
    const key = `${message.role}\u0000${message.content}`;
    if (key === lastKey) {
      continue;
    }

    lastKey = key;
    deduped.push(message);
  }

  return deduped;
}

async function parseConversationMessagesFromRollout(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }

  const eventMessages = [];
  const fallbackMessages = [];
  const lines = raw.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }

    const parsed = safeJsonParse(line);
    const message = extractConversationMessageFromRecord(parsed, index);
    if (!message) {
      continue;
    }

    if (message.source === "event_msg") {
      eventMessages.push(message);
    } else {
      fallbackMessages.push(message);
    }
  }

  return dedupeAdjacentConversationMessages(eventMessages.length > 0 ? eventMessages : fallbackMessages);
}

function sortSessionsByUpdatedAt(sessions) {
  return sessions.sort((left, right) => {
    const leftMs = Number(left.updated_at_ms) || toEpochSeconds(left.updated_at) * 1000;
    const rightMs = Number(right.updated_at_ms) || toEpochSeconds(right.updated_at) * 1000;
    return rightMs - leftMs;
  });
}

function rewriteClonedRolloutValue(value, context, key = "") {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteClonedRolloutValue(item, context, key));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        rewriteClonedRolloutValue(entryValue, context, entryKey)
      ])
    );
  }

  if (typeof value === "string") {
    if (ROLLOUT_THREAD_ID_KEYS.has(key) && value === context.sourceId) {
      return context.clonedId;
    }

    if (key === "model_provider" && value === context.sourceProvider) {
      return context.targetProvider;
    }
  }

  return value;
}

function rewriteClonedRolloutRecord(record, context) {
  const rewritten = rewriteClonedRolloutValue(record, context);
  if (rewritten?.type === "session_meta" && rewritten.payload && rewritten.payload.id === context.sourceId) {
    rewritten.payload.id = context.clonedId;
    if (rewritten.payload.model_provider === context.sourceProvider) {
      rewritten.payload.model_provider = context.targetProvider;
    }
  }

  return rewritten;
}

function rewriteRetargetedRolloutValue(value, context, key = "") {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteRetargetedRolloutValue(item, context, key));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, nested]) => [
        entryKey,
        rewriteRetargetedRolloutValue(nested, context, entryKey)
      ])
    );
  }

  if (typeof value === "string" && key === "model_provider" && value === context.sourceProvider) {
    return context.targetProvider;
  }

  return value;
}

function rewriteRetargetedRolloutRecord(record, context) {
  return rewriteRetargetedRolloutValue(record, context);
}

async function rewriteClonedRolloutJsonl(filePath, context) {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const rewrittenLines = [];

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const parsed = JSON.parse(line);
    const rewritten = rewriteClonedRolloutRecord(parsed, context);
    rewrittenLines.push(JSON.stringify(rewritten));
  }

  const nextContent = rewrittenLines.length ? `${rewrittenLines.join("\n")}\n` : "";
  await fs.writeFile(filePath, nextContent);
}

async function rewriteRetargetedRolloutJsonl(filePath, context) {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const rewrittenLines = [];

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const parsed = JSON.parse(line);
    const rewritten = rewriteRetargetedRolloutRecord(parsed, context);
    rewrittenLines.push(JSON.stringify(rewritten));
  }

  const nextContent = rewrittenLines.length ? `${rewrittenLines.join("\n")}\n` : "";
  await fs.writeFile(filePath, nextContent);
}

function buildInsertSql(tableName, columns, row) {
  const encodedValues = columns.map((column) => encodeSqlLiteral(row[column]));
  return `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${encodedValues.join(", ")});`;
}

function parseInsertSqlValues(sql) {
  const match = sql.match(
    /^\s*INSERT\s+INTO\s+\w+\s*\(([\s\S]+?)\)\s*VALUES\s*\(([\s\S]+?)\)\s*;?\s*$/i
  );
  if (!match) {
    throw new Error("Session archive thread.sql must contain a single INSERT INTO threads statement.");
  }

  const columns = match[1]
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean);
  const valuesSql = match[2].trim();
  const values = [];
  let current = "";
  let inString = false;

  for (let index = 0; index < valuesSql.length; index += 1) {
    const char = valuesSql[index];

    if (char === "'") {
      current += char;
      if (inString && valuesSql[index + 1] === "'") {
        current += valuesSql[index + 1];
        index += 1;
      } else {
        inString = !inString;
      }
      continue;
    }

    if (char === "," && !inString) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    values.push(current.trim());
  }

  if (columns.length !== values.length) {
    throw new Error("Session archive thread.sql columns and values do not match.");
  }

  return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
}

function buildDatabaseInUseMessage(reason, openHandles = []) {
  const lines = [
    reason,
    "建议处理方式：",
    "1. 先关闭本地正在运行的 Codex。",
    "2. 如果刚重启电脑，先不要打开 Codex，先导入 session。",
    "3. 如果仍然失败，再关闭其他可能占用 SQLite 的工具后重试。"
  ];

  if (openHandles.length) {
    lines.push("检测到的占用信息：");
    lines.push(...openHandles);
  }

  return lines.join("\n");
}

export class CodexSessionStore {
  constructor(options = {}) {
    this.options = { ...options };
    this.codexHome = resolveCodexHome(options.codexHome);
    this.dbPath = resolveDbPath({ codexHome: this.codexHome, dbPath: options.dbPath });
    this.platform = options.platform ?? process.platform;
    this.sqlite3Bin = options.sqlite3Bin ?? "sqlite3";
    this.lsofBin = options.lsofBin ?? "lsof";
    this.powershellBin = options.powershellBin ?? "powershell.exe";
    this.skipSqlitePrepare = options.skipSqlitePrepare === true;
  }

  async pathExists(targetPath) {
    try {
      await fs.access(targetPath);
      return true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return false;
      }

      throw error;
    }
  }

  async hasAnyRolloutFiles(rootDir) {
    let entries;
    try {
      entries = await fs.readdir(rootDir, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return false;
      }

      throw error;
    }

    for (const entry of entries) {
      const fullPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        if (await this.hasAnyRolloutFiles(fullPath)) {
          return true;
        }
        continue;
      }

      if (entry.isFile() && fullPath.endsWith(".jsonl")) {
        return true;
      }
    }

    return false;
  }

  async inspectCodexHome() {
    const sessionsDir = path.join(this.codexHome, "sessions");
    const sessionIndexPath = path.join(this.codexHome, "session_index.jsonl");
    const codexHomeExists = await this.pathExists(this.codexHome);
    const sessionsDirExists = await this.pathExists(sessionsDir);
    const sessionIndexExists = await this.pathExists(sessionIndexPath);
    const database = await this.getSidecarState(this.dbPath);
    const wal = await this.getSidecarState(`${this.dbPath}-wal`);
    const hasRolloutFiles = sessionsDirExists ? await this.hasAnyRolloutFiles(sessionsDir) : false;

    let databaseMode = "missing";
    let databaseReadable = false;
    let databaseError = "";

    if (database.exists) {
      try {
        const db = await loadDatabase(this.dbPath);
        databaseReadable = await this.tableExists(db, "threads");
        databaseMode = databaseReadable ? "threads" : "empty_or_uncheckpointed";
        db.close();
      } catch (error) {
        databaseMode = "unreadable";
        databaseError = error instanceof Error ? error.message : String(error);
      }
    }

    const usableReadMode = databaseReadable ? "database" : hasRolloutFiles ? "rollout_fallback" : "unavailable";
    const usable = usableReadMode !== "unavailable";

    let reason = "";
    if (!codexHomeExists) {
      reason = "未找到默认 Codex 目录。";
    } else if (!database.exists && !hasRolloutFiles) {
      reason = "当前目录下既没有可用的状态库，也没有 sessions 会话文件。";
    } else if (!databaseReadable && wal.exists && !hasRolloutFiles) {
      reason = "检测到 state_5.sqlite-wal，但当前环境无法直接从主库读取 threads 表。";
    } else if (!databaseReadable && hasRolloutFiles) {
      reason = "当前目录下数据库不可直接读取，页面将退回到 sessions 文件读取模式。";
    } else if (databaseReadable) {
      reason = "当前目录可直接读取 Codex 状态库。";
    }

    return {
      codexHome: this.codexHome,
      dbPath: this.dbPath,
      detected: codexHomeExists,
      usable,
      usableReadMode,
      reason,
      paths: {
        sessionsDir,
        sessionIndexPath
      },
      files: {
        database,
        wal,
        sessionIndexExists,
        sessionsDirExists,
        hasRolloutFiles
      },
      databaseMode,
      databaseReadable,
      databaseError
    };
  }

  async backupSnapshot() {
    await ensureFile(this.dbPath);
    const preparation = await this.prepareBackup();
    const backupDir = getBackupDir(this.codexHome);
    const snapshotDir = path.join(backupDir, `snapshot-${formatTimestamp()}`);
    const sessionsDir = path.join(this.codexHome, "sessions");
    const archivedSessionsDir = path.join(this.codexHome, "archived_sessions");
    const sessionIndexPath = path.join(this.codexHome, "session_index.jsonl");
    const dbBackupPath = path.join(snapshotDir, path.basename(this.dbPath));
    const walBackupPath = path.join(snapshotDir, `${path.basename(this.dbPath)}-wal`);
    const shmBackupPath = path.join(snapshotDir, `${path.basename(this.dbPath)}-shm`);
    const sessionsBackupPath = path.join(snapshotDir, "sessions");
    const archivedSessionsBackupPath = path.join(snapshotDir, "archived_sessions");
    const sessionIndexBackupPath = path.join(snapshotDir, "session_index.jsonl");
    const globalStatePath = path.join(this.codexHome, ".codex-global-state.json");
    const globalStateBackupPath = path.join(snapshotDir, ".codex-global-state.json");

    await fs.mkdir(snapshotDir, { recursive: true });
    await fs.copyFile(this.dbPath, dbBackupPath);

    const copied = {
      database: dbBackupPath,
      wal: null,
      shm: null,
      sessions: null,
      archivedSessions: null,
      sessionIndex: null,
      globalState: null
    };

    copied.wal = await this.copyFileIfExists(`${this.dbPath}-wal`, walBackupPath);
    copied.shm = await this.copyFileIfExists(`${this.dbPath}-shm`, shmBackupPath);
    copied.sessions = await this.copyDirectoryIfExists(sessionsDir, sessionsBackupPath);
    copied.archivedSessions = await this.copyDirectoryIfExists(
      archivedSessionsDir,
      archivedSessionsBackupPath
    );
    copied.sessionIndex = await this.copyFileIfExists(sessionIndexPath, sessionIndexBackupPath);
    copied.globalState = await this.copyFileIfExists(globalStatePath, globalStateBackupPath);

    await fs.writeFile(
      path.join(snapshotDir, "manifest.json"),
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          codexHome: this.codexHome,
          dbPath: this.dbPath,
          snapshotDir,
          preparation,
          copied
        },
        null,
        2
      )
    );

    return {
      snapshotDir,
      preparation,
      dbPath: dbBackupPath,
      walPath: copied.wal,
      shmPath: copied.shm,
      sessionsPath: copied.sessions,
      archivedSessionsPath: copied.archivedSessions,
      sessionIndexPath: copied.sessionIndex,
      globalStatePath: copied.globalState
    };
  }

  async backupDatabase() {
    return this.backupSnapshot();
  }

  async copyDirectoryIfExists(sourcePath, targetPath) {
    try {
      await fs.access(sourcePath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }

    await fs.cp(sourcePath, targetPath, { recursive: true });
    return targetPath;
  }

  async copyFileIfExists(sourcePath, targetPath) {
    try {
      await fs.access(sourcePath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }

    await fs.copyFile(sourcePath, targetPath);
    return targetPath;
  }

  resolveUserPath(inputPath) {
    return path.resolve(expandHome(inputPath));
  }

  async ensureExportArchivePath(archivePath) {
    await fs.mkdir(path.dirname(archivePath), { recursive: true });

    try {
      await fs.access(archivePath);
      throw new Error(`Export archive already exists: ${archivePath}`);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return;
      }

      throw error;
    }
  }

  async resolveArchivePath(outputPath, defaultArchiveName) {
    if (!outputPath) {
      return path.join(this.codexHome, "exports", "codex-sessions", defaultArchiveName);
    }

    const resolvedPath = this.resolveUserPath(outputPath);
    try {
      const stats = await fs.stat(resolvedPath);
      if (stats.isDirectory()) {
        return path.join(resolvedPath, defaultArchiveName);
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }

    return resolvedPath.endsWith(EXPORT_ARCHIVE_EXT)
      ? resolvedPath
      : `${resolvedPath}${EXPORT_ARCHIVE_EXT}`;
  }

  async resolveExportArchivePath(outputPath, threadId) {
    const defaultArchiveName = `session-${formatTimestamp()}-${threadId}${EXPORT_ARCHIVE_EXT}`;
    return this.resolveArchivePath(outputPath, defaultArchiveName);
  }

  async resolveBatchExportArchivePath(outputPath, threadCount) {
    const defaultArchiveName = `sessions-${formatTimestamp()}-${threadCount}${EXPORT_ARCHIVE_EXT}`;
    return this.resolveArchivePath(outputPath, defaultArchiveName);
  }

  async createTempBundleDir(prefix) {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
  }

  async extractArchiveToTempDir(archivePath) {
    const extractDir = await this.createTempBundleDir("codex-sessions-import-");
    await tar.extract({
      file: archivePath,
      cwd: extractDir,
      strict: true
    });
    return extractDir;
  }

  async createArchiveFromDir(sourceDir, archivePath, entries = ["manifest.json", "thread.sql", "rollout.jsonl"]) {
    await tar.create(
      {
        gzip: true,
        cwd: sourceDir,
        file: archivePath,
        portable: true,
        strict: true
      },
      entries
    );
  }

  normalizeThreadIds(threadIds) {
    return Array.from(
      new Set((Array.isArray(threadIds) ? threadIds : []).map((value) => String(value).trim()).filter(Boolean))
    );
  }

  sanitizeArchiveEntryName(value, fallback) {
    const normalized = String(value ?? "").replace(/[^a-zA-Z0-9._-]/g, "_");
    return normalized || fallback;
  }

  async loadExportableThread(threadId) {
    const db = await this.openReadDatabase(["threads"]);
    const thread = selectOne(db, `SELECT * FROM threads WHERE id = :threadId`, {
      ":threadId": threadId
    });

    if (!thread) {
      db.close();
      throw new Error(`Session not found: ${threadId}`);
    }

    const threadColumns = Array.from(await this.getTableColumns(db, "threads"));
    db.close();

    const rolloutPath = path.resolve(String(thread.rollout_path ?? ""));
    await ensureFile(rolloutPath);

    if (!isInsideDir(this.codexHome, rolloutPath)) {
      throw new Error("Only sessions whose rollout_path is inside the current Codex home can be exported.");
    }

    const relativeRolloutPath = path.relative(this.codexHome, rolloutPath).split(path.sep).join("/");
    return {
      thread,
      threadColumns,
      rolloutPath,
      relativeRolloutPath
    };
  }

  resolveBundleFilePath(bundleDir, relativePath) {
    const resolvedPath = path.resolve(bundleDir, relativePath);
    if (!isInsideDir(bundleDir, resolvedPath)) {
      throw new Error(`Session bundle contains an invalid file path: ${relativePath}`);
    }

    return resolvedPath;
  }

  getImportEntriesFromManifest(manifest) {
    if (manifest.version !== EXPORT_BUNDLE_VERSION) {
      throw new Error(`Unsupported session bundle version: ${manifest.version}`);
    }

    if (manifest.bundleType === EXPORT_BUNDLE_TYPE_BATCH) {
      if (!Array.isArray(manifest.threads) || manifest.threads.length === 0) {
        throw new Error("Session bundle is missing threads.");
      }

      return manifest.threads.map((entry, index) => {
        const threadId = String(entry?.threadId ?? "").trim();
        const rolloutRelativePath = String(entry?.rolloutRelativePath ?? "").trim();
        const sqlFile = String(entry?.sqlFile ?? "").trim();
        const rolloutFile = String(entry?.rolloutFile ?? "").trim();

        if (!threadId || !rolloutRelativePath || !sqlFile || !rolloutFile) {
          throw new Error(`Session bundle thread entry #${index + 1} is incomplete.`);
        }

        return {
          threadId,
          title: entry?.title ?? "",
          modelProvider: entry?.modelProvider ?? "",
          rolloutRelativePath,
          sqlFile,
          rolloutFile
        };
      });
    }

    const threadId = String(manifest.threadId ?? "").trim();
    const rolloutRelativePath = String(manifest.rolloutRelativePath ?? "").trim();
    const sqlFile = String(manifest.sqlFile ?? "thread.sql").trim();
    const rolloutFile = String(manifest.rolloutFile ?? "rollout.jsonl").trim();

    if (!threadId) {
      throw new Error("Session bundle is missing threadId.");
    }
    if (!rolloutRelativePath) {
      throw new Error("Session bundle is missing rolloutRelativePath.");
    }
    if (!sqlFile || !rolloutFile) {
      throw new Error("Session bundle is missing required entry files.");
    }

    return [
      {
        threadId,
        title: manifest.title ?? "",
        modelProvider: manifest.modelProvider ?? "",
        rolloutRelativePath,
        sqlFile,
        rolloutFile
      }
    ];
  }

  async importBundleEntry(bundleDir, entry, archivePath, force) {
    const sqlPath = this.resolveBundleFilePath(bundleDir, entry.sqlFile);
    const rolloutBundlePath = this.resolveBundleFilePath(bundleDir, entry.rolloutFile);
    await ensureFile(sqlPath);
    await ensureFile(rolloutBundlePath);

    const rolloutRelativeParts = entry.rolloutRelativePath.split(/[\\/]+/).filter(Boolean);
    const targetRolloutPath = path.resolve(this.codexHome, ...rolloutRelativeParts);
    if (!isInsideDir(this.codexHome, targetRolloutPath)) {
      throw new Error("Refusing to import a rollout_path outside the current Codex home.");
    }

    const rawSql = await fs.readFile(sqlPath, "utf8");
    if (!/^\s*INSERT\s+INTO\s+threads\b/i.test(rawSql)) {
      throw new Error("Session archive thread.sql must contain an INSERT INTO threads statement.");
    }

    const importSql = rawSql.replaceAll(
      EXPORT_SQL_PLACEHOLDER,
      escapeSqlStringContent(targetRolloutPath)
    );
    const importValues = parseInsertSqlValues(importSql);
    const incomingThreadId = String(entry.threadId ?? importValues.id ?? "").trim();
    if (!incomingThreadId) {
      throw new Error("Session bundle is missing threadId.");
    }

    const incomingUpdatedAt = Number(importValues.updated_at);
    if (!Number.isFinite(incomingUpdatedAt)) {
      throw new Error("Session bundle is missing a valid updated_at value.");
    }

    const db = await loadDatabase(this.dbPath);
    const existingThread = selectOne(db, `SELECT id, updated_at, rollout_path FROM threads WHERE id = :threadId`, {
      ":threadId": incomingThreadId
    });

    if (existingThread && !force && Number(existingThread.updated_at) >= incomingUpdatedAt) {
      db.close();
      return {
        threadId: incomingThreadId,
        archivePath,
        rolloutPath: String(existingThread.rollout_path),
        imported: false,
        skipped: true,
        reason: "not-newer"
      };
    }

    let updatedBytes;
    try {
      db.run("BEGIN");
      if (existingThread) {
        if (await this.tableExists(db, "thread_dynamic_tools")) {
          db.run(`DELETE FROM thread_dynamic_tools WHERE thread_id = :threadId`, {
            ":threadId": incomingThreadId
          });
        }

        if (await this.tableExists(db, "stage1_outputs")) {
          db.run(`DELETE FROM stage1_outputs WHERE thread_id = :threadId`, {
            ":threadId": incomingThreadId
          });
        }

        if (await this.tableExists(db, "thread_spawn_edges")) {
          db.run(
            `
              DELETE FROM thread_spawn_edges
              WHERE parent_thread_id = :threadId OR child_thread_id = :threadId
            `,
            { ":threadId": incomingThreadId }
          );
        }

        if (await this.tableExists(db, "agent_job_items")) {
          db.run(
            `
              UPDATE agent_job_items
              SET assigned_thread_id = NULL
              WHERE assigned_thread_id = :threadId
            `,
            { ":threadId": incomingThreadId }
          );
        }

        db.run(`DELETE FROM threads WHERE id = :threadId`, {
          ":threadId": incomingThreadId
        });
      }
      db.run(importSql);
      db.run("COMMIT");
      updatedBytes = Buffer.from(db.export());
    } catch (error) {
      try {
        db.run("ROLLBACK");
      } catch {
        // ignore rollback failures from aborted transactions
      }
      db.close();
      throw error;
    }
    db.close();

    await ensureParentDir(targetRolloutPath);
    let copiedRollout = false;
    const rolloutBackups = [];

    const backupRolloutIfExists = async (originalPath) => {
      try {
        await fs.access(originalPath);
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return;
        }

        throw error;
      }

      const backupPath = `${originalPath}.import-backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await fs.rename(originalPath, backupPath);
      rolloutBackups.push({ originalPath, backupPath });
    };

    try {
      if (existingThread) {
        const previousRolloutPath = path.resolve(String(existingThread.rollout_path ?? ""));
        await backupRolloutIfExists(previousRolloutPath);
        if (previousRolloutPath !== targetRolloutPath) {
          await backupRolloutIfExists(targetRolloutPath);
        }
      }

      await fs.copyFile(rolloutBundlePath, targetRolloutPath);
      copiedRollout = true;
      await fs.writeFile(this.dbPath, updatedBytes);
      await this.upsertSessionIndexEntry({
        ...importValues,
        id: incomingThreadId,
        title: entry.title ?? importValues.title ?? "",
        updated_at: importValues.updated_at,
        updated_at_ms: importValues.updated_at_ms
      });

      for (const backup of rolloutBackups) {
        await fs.rm(backup.backupPath, { force: true });
      }
    } catch (error) {
      if (copiedRollout) {
        await fs.rm(targetRolloutPath, { force: true });
      }

      for (const backup of rolloutBackups.slice().reverse()) {
        try {
          await fs.rename(backup.backupPath, backup.originalPath);
        } catch {
          // best effort restore of previous rollout files
        }
      }

      throw error;
    }

    return {
      threadId: incomingThreadId,
      archivePath,
      rolloutPath: targetRolloutPath,
      imported: true,
      skipped: false,
      reason: existingThread ? (force ? "forced" : "updated") : "created"
    };
  }

  async tableExists(db, tableName) {
    const row = selectOne(
      db,
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = :tableName
      `,
      { ":tableName": tableName }
    );
    return Boolean(row);
  }

  async getTableColumns(db, tableName) {
    if (!(await this.tableExists(db, tableName))) {
      return new Set();
    }

    const rows = selectAll(db, `PRAGMA table_info(${tableName})`);
    return new Set(rows.map((row) => String(row.name)));
  }

  async openReadDatabase(requiredTables = ["threads"]) {
    const loadAndValidate = async () => {
      const db = await loadDatabase(this.dbPath);
      for (const tableName of requiredTables) {
        if (!(await this.tableExists(db, tableName))) {
          db.close();
          return null;
        }
      }
      return db;
    };

    let db = await loadAndValidate();
    if (db) {
      return db;
    }

    const walPath = `${this.dbPath}-wal`;
    const walState = await this.getSidecarState(walPath);
    const sqlite3Available = await this.hasSqliteCli();

    if (walState.exists && sqlite3Available) {
      try {
        await this.runSqlitePragma("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {
        // Best-effort for read flows: if checkpoint fails we surface a clearer error below.
      }

      db = await loadAndValidate();
      if (db) {
        return db;
      }
    }

    const details = [
      `Database does not contain required table(s): ${requiredTables.join(", ")}.`,
      `dbPath=${this.dbPath}`
    ];

    if (walState.exists) {
      details.push(`walPath=${walPath}`);
      details.push(
        sqlite3Available
          ? "Detected a WAL sidecar, but checkpointing did not make the expected tables visible."
          : "Detected a WAL sidecar, but sqlite3 is not installed so this app cannot checkpoint it before reading."
      );
    } else {
      details.push("No WAL sidecar was found next to the configured database.");
    }

    details.push(
      "This usually means the configured Codex database path is wrong, or Codex has not checkpointed state_5.sqlite yet."
    );
    details.push(
      "Try fully closing Codex, then run `sqlite3 ~/.codex/state_5.sqlite \"PRAGMA wal_checkpoint(TRUNCATE);\"`, or start the app with `--db-path` pointing at the correct state_5.sqlite."
    );

    throw new Error(details.join(" "));
  }

  shouldUseRolloutFallback(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("Database does not contain required table(s): threads.");
  }

  async listRolloutFiles(rootDir) {
    let entries;
    try {
      entries = await fs.readdir(rootDir, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return [];
      }

      throw error;
    }

    const files = [];
    for (const entry of entries) {
      const fullPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.listRolloutFiles(fullPath)));
        continue;
      }

      if (entry.isFile() && fullPath.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }

    return files;
  }

  async readSessionIndexMap() {
    const sessionIndexPath = path.join(this.codexHome, "session_index.jsonl");
    let raw = "";
    try {
      raw = await fs.readFile(sessionIndexPath, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return new Map();
      }

      throw error;
    }

    const map = new Map();
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      const parsed = safeJsonParse(line);
      if (!parsed?.id) {
        continue;
      }

      map.set(String(parsed.id), {
        thread_name: normalizeSessionTitle(parsed.thread_name ?? ""),
        updated_at: parsed.updated_at
      });
    }

    return map;
  }

  async readRolloutSessionMeta(filePath) {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/);

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const parsed = safeJsonParse(line);
      if (parsed?.type === "session_meta" && parsed.payload && typeof parsed.payload === "object") {
        return parsed.payload;
      }
    }

    return null;
  }

  async buildFallbackSessionSummary(filePath, sessionIndexMap) {
    const [meta, stats] = await Promise.all([
      this.readRolloutSessionMeta(filePath),
      fs.stat(filePath)
    ]);

    if (!meta) {
      return null;
    }

    const threadId = String(meta.id ?? extractThreadIdFromRolloutPath(filePath)).trim();
    if (!threadId) {
      return null;
    }

    const indexEntry = sessionIndexMap.get(threadId);
    const createdAt =
      toEpochSeconds(meta.timestamp) || Math.floor(stats.birthtimeMs > 0 ? stats.birthtimeMs / 1000 : stats.mtimeMs / 1000);
    const updatedAt = toEpochSeconds(indexEntry?.updated_at, Math.floor(stats.mtimeMs / 1000));

    return {
      id: threadId,
      title:
        normalizeSessionTitle(indexEntry?.thread_name) ||
        normalizeSessionTitle(meta.title) ||
        threadId,
      model_provider: String(meta.model_provider ?? ""),
      model: meta.model == null ? null : String(meta.model),
      cwd: String(meta.cwd ?? ""),
      rollout_path: filePath,
      created_at: createdAt,
      updated_at: updatedAt,
      archived: false,
      source: meta.source == null ? null : String(meta.source),
      sandbox_policy: meta.sandbox_policy == null ? null : String(meta.sandbox_policy),
      approval_mode: meta.approval_mode == null ? null : String(meta.approval_mode),
      cli_version: meta.cli_version == null ? null : String(meta.cli_version),
      memory_mode: meta.memory_mode == null ? null : String(meta.memory_mode),
      reasoning_effort: meta.reasoning_effort == null ? null : String(meta.reasoning_effort),
      agent_path: meta.agent_path == null ? null : String(meta.agent_path)
    };
  }

  async loadFallbackSessionSummaries() {
    const sessionsDir = path.join(this.codexHome, "sessions");
    const [rolloutFiles, sessionIndexMap] = await Promise.all([
      this.listRolloutFiles(sessionsDir),
      this.readSessionIndexMap()
    ]);

    const summaries = [];
    for (const filePath of rolloutFiles) {
      const summary = await this.buildFallbackSessionSummary(filePath, sessionIndexMap);
      if (summary) {
        summaries.push(summary);
      }
    }

    summaries.sort((left, right) => Number(right.updated_at) - Number(left.updated_at));
    return summaries;
  }

  async loadDatabaseSessionSummaries() {
    const db = await this.openReadDatabase(["threads"]);
    const threadColumns = await this.getTableColumns(db, "threads");
    const selectColumn = (columnName) =>
      threadColumns.has(columnName) ? columnName : `NULL AS ${columnName}`;

    const rows = selectAll(
      db,
      `
        SELECT
          ${selectColumn("id")},
          ${selectColumn("title")},
          ${selectColumn("model_provider")},
          ${selectColumn("model")},
          ${selectColumn("cwd")},
          ${selectColumn("rollout_path")},
          ${selectColumn("created_at")},
          ${selectColumn("updated_at")},
          ${selectColumn("created_at_ms")},
          ${selectColumn("updated_at_ms")},
          ${selectColumn("archived")}
        FROM threads
      `
    );

    db.close();
    return rows.map((row) => ({
      ...row,
      archived: toBoolean(row.archived)
    }));
  }

  async loadMergedSessionSummaries() {
    let databaseSessions = [];
    let databaseError = null;

    try {
      databaseSessions = await this.loadDatabaseSessionSummaries();
    } catch (error) {
      if (!this.shouldUseRolloutFallback(error)) {
        throw error;
      }
      databaseError = error;
    }

    const fallbackSessions = await this.loadFallbackSessionSummaries();
    if (databaseError && fallbackSessions.length === 0) {
      throw databaseError;
    }

    const byId = new Map();
    for (const session of fallbackSessions) {
      byId.set(String(session.id), session);
    }

    for (const session of databaseSessions) {
      const existing = byId.get(String(session.id));
      byId.set(String(session.id), {
        ...existing,
        ...session,
        archived: toBoolean(session.archived)
      });
    }

    return sortSessionsByUpdatedAt(Array.from(byId.values()));
  }

  async getFallbackSessionDetail(threadId) {
    const sessions = await this.loadFallbackSessionSummaries();
    const summary = sessions.find((item) => item.id === threadId);
    if (!summary) {
      throw new Error(`Session not found: ${threadId}`);
    }

    const raw = await fs.readFile(String(summary.rollout_path), "utf8");
    const conversationMessages = await parseConversationMessagesFromRollout(String(summary.rollout_path));
    let firstUserMessage = "";
    let hasUserEvent = false;

    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      const parsed = safeJsonParse(line);
      const userMessage = extractFirstUserMessageFromRecord(parsed);
      if (userMessage) {
        hasUserEvent = true;
        firstUserMessage = userMessage;
        break;
      }
    }

    return {
      ...summary,
      tokens_used: null,
      has_user_event: hasUserEvent,
      archived_at: null,
      git_sha: null,
      git_branch: null,
      git_origin_url: null,
      first_user_message: firstUserMessage || null,
      agent_nickname: null,
      agent_role: null,
      rollout_exists: true,
      dynamic_tools: [],
      conversation_messages: conversationMessages
    };
  }

  async upsertSessionIndexEntry(thread) {
    const sessionIndexPath = path.join(this.codexHome, "session_index.jsonl");
    const entry = {
      id: String(thread.id),
      thread_name: formatSessionIndexThreadName(thread),
      updated_at: formatSessionIndexUpdatedAt(thread)
    };

    let raw = "";
    try {
      raw = await fs.readFile(sessionIndexPath, "utf8");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }

    const lines = raw.split(/\r?\n/);
    const retained = lines.filter((line) => {
      if (!line.trim()) {
        return false;
      }

      try {
        const parsed = JSON.parse(line);
        return parsed?.id !== entry.id;
      } catch {
        return true;
      }
    });

    retained.push(JSON.stringify(entry));
    await ensureParentDir(sessionIndexPath);
    await fs.writeFile(sessionIndexPath, `${retained.join("\n")}\n`);
    return entry;
  }

  async removeSessionIndexEntry(threadId) {
    const sessionIndexPath = path.join(this.codexHome, "session_index.jsonl");
    let raw;
    try {
      raw = await fs.readFile(sessionIndexPath, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return false;
      }

      throw error;
    }

    const lines = raw.split(/\r?\n/);
    let changed = false;
    const filtered = lines.filter((line) => {
      if (!line.trim()) {
        return false;
      }

      try {
        const parsed = JSON.parse(line);
        if (parsed && parsed.id === threadId) {
          changed = true;
          return false;
        }
      } catch {
        return true;
      }

      return true;
    });

    if (!changed) {
      return false;
    }

    const nextContent = filtered.length ? `${filtered.join("\n")}\n` : "";
    await fs.writeFile(sessionIndexPath, nextContent);
    return true;
  }

  async getSidecarState(filePath) {
    try {
      const stats = await fs.stat(filePath);
      return {
        path: filePath,
        exists: true,
        size: stats.size
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return {
          path: filePath,
          exists: false,
          size: 0
        };
      }

      throw error;
    }
  }

  async hasSqliteCli() {
    try {
      await execFileAsync(this.sqlite3Bin, ["-version"]);
      return true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return false;
      }

      throw error;
    }
  }

  async hasLsofCli() {
    try {
      await execFileAsync(this.lsofBin, ["-v"], { maxBuffer: 1024 * 1024 });
      return true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return false;
      }

      return true;
    }
  }

  async runSqlitePragma(sql) {
    try {
      const { stdout } = await execFileAsync(this.sqlite3Bin, [this.dbPath, sql], {
        maxBuffer: 1024 * 1024
      });
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        throw new Error(
          "`sqlite3` command not found. Backup preparation requires a local sqlite3 CLI."
        );
      }

      const stderr =
        error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : "";
      throw new Error(stderr || `Failed to execute sqlite3: ${sql}`);
    }
  }

  async findOpenHandles(filePaths) {
    const existingPaths = [];
    for (const filePath of filePaths) {
      try {
        await fs.access(filePath);
        existingPaths.push(filePath);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          continue;
        }

        throw error;
      }
    }

    if (existingPaths.length === 0) {
      return [];
    }

    try {
      const { stdout } = await execFileAsync(this.lsofBin, existingPaths, {
        maxBuffer: 1024 * 1024
      });
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        throw new Error(
          "`sqlite3` is not installed and `lsof` is also unavailable, so database file occupancy cannot be verified."
        );
      }

      const stdout =
        error && typeof error === "object" && "stdout" in error ? String(error.stdout).trim() : "";
      const stderr =
        error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : "";

      if ("code" in Object(error) && error.code === 1) {
        return stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
      }

      throw new Error(stderr || stdout || "Failed to inspect open database handles with lsof.");
    }
  }

  async findOpenHandlesLinuxProc(filePaths) {
    const existingPaths = [];
    for (const filePath of filePaths) {
      try {
        await fs.access(filePath);
        existingPaths.push(filePath);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          continue;
        }

        throw error;
      }
    }

    if (existingPaths.length === 0) {
      return [];
    }

    const normalizedTargets = new Set();
    for (const filePath of existingPaths) {
      normalizedTargets.add(path.resolve(filePath));
      try {
        normalizedTargets.add(await fs.realpath(filePath));
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          continue;
        }

        throw error;
      }
    }

    let procEntries;
    try {
      procEntries = await fs.readdir("/proc", { withFileTypes: true });
    } catch {
      throw new Error(
        "`sqlite3` and `lsof` are unavailable, and /proc cannot be read, so database occupancy cannot be verified."
      );
    }

    const openHandles = [];

    for (const entry of procEntries) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
        continue;
      }

      const pid = entry.name;
      const fdDir = path.posix.join("/proc", pid, "fd");
      let fdEntries;
      try {
        fdEntries = await fs.readdir(fdDir, { withFileTypes: true });
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM")
        ) {
          continue;
        }

        throw error;
      }

      let command = "";
      try {
        command = (await fs.readFile(path.posix.join("/proc", pid, "comm"), "utf8")).trim();
      } catch (error) {
        if (
          !(
            error &&
            typeof error === "object" &&
            "code" in error &&
            (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM")
          )
        ) {
          throw error;
        }
      }

      const matchedPaths = new Set();

      for (const fdEntry of fdEntries) {
        const fdPath = path.posix.join(fdDir, fdEntry.name);
        let linkedPath;
        try {
          linkedPath = await fs.readlink(fdPath);
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM")
          ) {
            continue;
          }

          throw error;
        }

        const normalizedLinkedPath = path.resolve(linkedPath.replace(/\s+\(deleted\)$/, ""));
        if (normalizedTargets.has(normalizedLinkedPath)) {
          matchedPaths.add(normalizedLinkedPath);
        }
      }

      for (const matchedPath of matchedPaths) {
        openHandles.push(command ? `${pid} ${command} ${matchedPath}` : `${pid} ${matchedPath}`);
      }
    }

    return openHandles;
  }

  async findLockedFilesWindows(filePaths) {
    const existingPaths = [];
    for (const filePath of filePaths) {
      try {
        await fs.access(filePath);
        existingPaths.push(filePath);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          continue;
        }

        throw error;
      }
    }

    if (existingPaths.length === 0) {
      return [];
    }

    const locked = [];

    for (const filePath of existingPaths) {
      const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$path = ${JSON.stringify(filePath)}
try {
  $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
  $stream.Close()
} catch {
  Write-Output ("{0}: {1}" -f $path, $_.Exception.Message)
  exit 2
}
`;

      try {
        await execFileAsync(
          this.powershellBin,
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
          { maxBuffer: 1024 * 1024 }
        );
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          throw new Error(
            "`sqlite3` is not installed and the Windows PowerShell fallback is unavailable, so database occupancy cannot be verified."
          );
        }

        const stdout =
          error && typeof error === "object" && "stdout" in error
            ? String(error.stdout).trim()
            : "";
        const stderr =
          error && typeof error === "object" && "stderr" in error
            ? String(error.stderr).trim()
            : "";

        locked.push(stdout || stderr || `${filePath}: locked`);
      }
    }

    return locked;
  }

  async inspectDatabaseOccupancy(filePaths) {
    if (this.platform === "win32") {
      const openHandles = await this.findLockedFilesWindows(filePaths);
      return {
        mode: "windows-exclusive-open",
        lsofAvailable: null,
        occupied: openHandles.length > 0,
        openHandles
      };
    }

    const lsofAvailable = await this.hasLsofCli();
    if (!lsofAvailable && this.platform === "linux") {
      const openHandles = await this.findOpenHandlesLinuxProc(filePaths);
      return {
        mode: "linux-proc-fallback",
        lsofAvailable,
        occupied: openHandles.length > 0,
        openHandles
      };
    }

    if (!lsofAvailable) {
      throw new Error(
        "`lsof` is unavailable, so database occupancy cannot be verified safely."
      );
    }

    const openHandles = await this.findOpenHandles(filePaths);
    return {
      mode: "lsof-fallback",
      lsofAvailable,
      occupied: openHandles.length > 0,
      openHandles
    };
  }

  async prepareBackup() {
    await ensureFile(this.dbPath);
    const walPath = `${this.dbPath}-wal`;
    const shmPath = `${this.dbPath}-shm`;
    const dbState = await this.getSidecarState(this.dbPath);
    const before = {
      database: dbState,
      wal: await this.getSidecarState(walPath),
      shm: await this.getSidecarState(shmPath)
    };

    if (this.skipSqlitePrepare) {
      return {
        ok: true,
        skipped: true,
        sqlite3Available: true,
        checkpoint: [],
        integrity: {
          ok: true,
          messages: ["skipped"]
        },
        before,
        after: before,
        filesCleared: !before.wal.exists && !before.shm.exists
      };
    }

    const sqlite3Available = await this.hasSqliteCli();
    if (!sqlite3Available) {
      const occupancy = await this.inspectDatabaseOccupancy([this.dbPath, walPath, shmPath]);
      const occupied = occupancy.occupied;

      if (occupied) {
        throw new Error(
          buildDatabaseInUseMessage(
            "Codex 状态库当前正被占用，无法安全导入。通常是因为本地 Codex 还开着，且当前环境又没有可用的 sqlite3 来完成安全检查。",
            occupancy.openHandles
          )
        );
      }

      return {
        ok: true,
        skipped: false,
        sqlite3Available: false,
        lsofAvailable: occupancy.lsofAvailable,
        mode: occupancy.mode,
        checkpoint: [],
        integrity: {
          ok: null,
          messages: ["skipped: sqlite3 unavailable"]
        },
        before,
        after: before,
        filesCleared: !before.wal.exists && !before.shm.exists,
        occupied,
        openHandles: occupancy.openHandles
      };
    }

    const checkpoint = await this.runSqlitePragma("PRAGMA wal_checkpoint(TRUNCATE);");
    const integrityMessages = await this.runSqlitePragma("PRAGMA integrity_check;");
    const integrityOk = integrityMessages.length === 1 && integrityMessages[0] === "ok";
    const after = {
      wal: await this.getSidecarState(walPath),
      shm: await this.getSidecarState(shmPath)
    };
    const filesCleared = !after.wal.exists && !after.shm.exists;

    if (!integrityOk) {
      throw new Error(`SQLite integrity_check failed: ${integrityMessages.join("; ")}`);
    }

    if (!filesCleared) {
      throw new Error(
        buildDatabaseInUseMessage(
          `备份前检查未能清理 SQLite 辅助文件。wal=${after.wal.exists ? "present" : "missing"}, shm=${after.shm.exists ? "present" : "missing"}。通常表示 Codex 或其他 SQLite 工具仍在占用状态库。`
        )
      );
    }

    const occupancy = await this.inspectDatabaseOccupancy([this.dbPath, walPath, shmPath]);
    if (occupancy.occupied) {
      throw new Error(
        buildDatabaseInUseMessage(
          "备份前检查发现 Codex 状态库在 checkpoint 之后仍被占用，无法继续写入。",
          occupancy.openHandles
        )
      );
    }

    return {
      ok: true,
      skipped: false,
      sqlite3Available,
      lsofAvailable: occupancy.lsofAvailable,
      mode: "sqlite3-checkpoint",
      checkpoint,
      integrity: {
        ok: integrityOk,
        messages: integrityMessages
      },
      before,
      after,
      filesCleared,
      occupied: false,
      openHandles: [],
      occupancyMode: occupancy.mode
    };
  }

  async listSessions(filters = {}) {
    const limit = Math.min(Math.max(Number(filters.limit ?? 100), 1), 500);
    const provider = filters.provider ? String(filters.provider).trim() : "";
    const search = filters.search ? String(filters.search).trim() : "";
    const normalizedSearch = search.toLowerCase();
    const sessions = await this.loadMergedSessionSummaries();

    return sessions
      .filter((session) => !provider || session.model_provider === provider)
      .filter((session) => {
        if (!normalizedSearch) {
          return true;
        }

        return [session.title, session.cwd, session.id, session.model_provider, session.first_user_message]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(normalizedSearch));
      })
      .slice(0, limit)
      .map((session) => ({
        ...session,
        archived: toBoolean(session.archived)
      }));
  }

  async getProviders() {
    const sessions = await this.loadMergedSessionSummaries();
    const counts = new Map();
    for (const session of sessions) {
      const key = String(session.model_provider ?? "").trim();
      if (!key) {
        continue;
      }
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return Array.from(counts.entries())
      .map(([model_provider, count]) => ({ model_provider, count }))
      .sort((left, right) => right.count - left.count || left.model_provider.localeCompare(right.model_provider));
  }

  async getSession(threadId) {
    try {
      const db = await this.openReadDatabase(["threads"]);
      const thread = selectOne(db, `SELECT * FROM threads WHERE id = :threadId`, {
        ":threadId": threadId
      });

      if (!thread) {
        db.close();
        return this.getFallbackSessionDetail(threadId);
      }

      let tools = [];
      if (await this.tableExists(db, "thread_dynamic_tools")) {
        tools = selectAll(
          db,
          `
            SELECT position, name, description, input_schema, defer_loading
            FROM thread_dynamic_tools
            WHERE thread_id = :threadId
            ORDER BY position ASC
          `,
          { ":threadId": threadId }
        );
      }
      db.close();

      let rolloutExists = false;
      try {
        await fs.access(String(thread.rollout_path));
        rolloutExists = true;
      } catch {
        rolloutExists = false;
      }

      const conversationMessages = rolloutExists
        ? await parseConversationMessagesFromRollout(String(thread.rollout_path))
        : [];

      return {
        ...thread,
        archived: toBoolean(thread.archived),
        has_user_event: toBoolean(thread.has_user_event),
        rollout_exists: rolloutExists,
        conversation_messages: conversationMessages,
        dynamic_tools: tools.map((tool) => ({
          ...tool,
          defer_loading: toBoolean(tool.defer_loading)
        }))
      };
    } catch (error) {
      if (!this.shouldUseRolloutFallback(error)) {
        throw error;
      }

      return this.getFallbackSessionDetail(threadId);
    }
  }

  async exportSession(threadId, outputPath) {
    const { thread, threadColumns, rolloutPath, relativeRolloutPath } = await this.loadExportableThread(threadId);
    const archivePath = await this.resolveExportArchivePath(outputPath, threadId);
    await this.ensureExportArchivePath(archivePath);

    const stagingDir = await this.createTempBundleDir("codex-sessions-export-");

    try {
      const manifest = {
        version: EXPORT_BUNDLE_VERSION,
        exportedAt: new Date().toISOString(),
        threadId,
        title: thread.title ?? "",
        modelProvider: thread.model_provider ?? "",
        rolloutRelativePath: relativeRolloutPath,
        originalRolloutPath: rolloutPath,
        sqlFile: "thread.sql",
        rolloutFile: "rollout.jsonl"
      };
      const exportRow = Object.fromEntries(
        threadColumns.map((column) => [
          column,
          column === "rollout_path" ? EXPORT_SQL_PLACEHOLDER : thread[column] ?? null
        ])
      );
      const threadSql = buildInsertSql("threads", threadColumns, exportRow);
      const sqlPath = path.join(stagingDir, "thread.sql");
      const manifestPath = path.join(stagingDir, "manifest.json");
      const rolloutExportPath = path.join(stagingDir, "rollout.jsonl");

      await fs.copyFile(rolloutPath, rolloutExportPath);
      await fs.writeFile(sqlPath, `${threadSql}\n`);
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await this.createArchiveFromDir(stagingDir, archivePath);

      return {
        threadId,
        archivePath,
        rolloutRelativePath: relativeRolloutPath
      };
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
  }

  async exportSessions(threadIds, outputPath) {
    const normalizedThreadIds = this.normalizeThreadIds(threadIds);
    if (normalizedThreadIds.length === 0) {
      throw new Error("At least one thread id is required for export.");
    }

    const exportableThreads = [];
    for (const threadId of normalizedThreadIds) {
      exportableThreads.push(await this.loadExportableThread(threadId));
    }

    const archivePath = await this.resolveBatchExportArchivePath(outputPath, exportableThreads.length);
    await this.ensureExportArchivePath(archivePath);

    const stagingDir = await this.createTempBundleDir("codex-sessions-export-batch-");

    try {
      const threadsDir = path.join(stagingDir, "threads");
      const rolloutsDir = path.join(stagingDir, "rollouts");
      await fs.mkdir(threadsDir, { recursive: true });
      await fs.mkdir(rolloutsDir, { recursive: true });

      const manifestThreads = [];
      for (let index = 0; index < exportableThreads.length; index += 1) {
        const { thread, threadColumns, rolloutPath, relativeRolloutPath } = exportableThreads[index];
        const safeThreadId = this.sanitizeArchiveEntryName(thread.id, `thread-${index + 1}`);
        const sqlRelativePath = `threads/${index + 1}-${safeThreadId}.sql`;
        const rolloutRelativeArchivePath = `rollouts/${index + 1}-${safeThreadId}.jsonl`;
        const exportRow = Object.fromEntries(
          threadColumns.map((column) => [
            column,
            column === "rollout_path" ? EXPORT_SQL_PLACEHOLDER : thread[column] ?? null
          ])
        );

        await fs.writeFile(
          path.join(stagingDir, sqlRelativePath),
          `${buildInsertSql("threads", threadColumns, exportRow)}\n`
        );
        await fs.copyFile(rolloutPath, path.join(stagingDir, rolloutRelativeArchivePath));

        manifestThreads.push({
          threadId: thread.id,
          title: thread.title ?? "",
          modelProvider: thread.model_provider ?? "",
          rolloutRelativePath: relativeRolloutPath,
          sqlFile: sqlRelativePath,
          rolloutFile: rolloutRelativeArchivePath
        });
      }

      await fs.writeFile(
        path.join(stagingDir, "manifest.json"),
        `${JSON.stringify(
          {
            version: EXPORT_BUNDLE_VERSION,
            bundleType: EXPORT_BUNDLE_TYPE_BATCH,
            exportedAt: new Date().toISOString(),
            threadCount: manifestThreads.length,
            threads: manifestThreads
          },
          null,
          2
        )}\n`
      );
      await this.createArchiveFromDir(stagingDir, archivePath, ["manifest.json", "threads", "rollouts"]);

      return {
        archivePath,
        threadIds: manifestThreads.map((entry) => entry.threadId),
        threadCount: manifestThreads.length
      };
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
  }

  async importSession(inputPath, options = {}) {
    if (!inputPath || !String(inputPath).trim()) {
      throw new Error("Import path is required.");
    }

    const force = options.force === true;
    const backup = await this.backupSnapshot();
    const archivePath = this.resolveUserPath(String(inputPath).trim());
    await ensureFile(archivePath);

    const bundleDir = await this.extractArchiveToTempDir(archivePath);

    try {
      const manifestPath = path.join(bundleDir, "manifest.json");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      const entries = this.getImportEntriesFromManifest(manifest);

      if (entries.length !== 1) {
        throw new Error("This import entrypoint only supports archives containing a single session.");
      }

      const result = await this.importBundleEntry(bundleDir, entries[0], archivePath, force);
      return {
        preparation: backup.preparation,
        backupPath: backup.snapshotDir,
        backup,
        ...result
      };
    } finally {
      await fs.rm(bundleDir, { recursive: true, force: true });
    }
  }

  async importSessions(inputPath, options = {}) {
    if (!inputPath || !String(inputPath).trim()) {
      throw new Error("Import path is required.");
    }

    const force = options.force === true;
    const backup = await this.backupSnapshot();
    const archivePath = this.resolveUserPath(String(inputPath).trim());
    await ensureFile(archivePath);

    const bundleDir = await this.extractArchiveToTempDir(archivePath);

    try {
      const manifestPath = path.join(bundleDir, "manifest.json");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      const entries = this.getImportEntriesFromManifest(manifest);
      const importedIds = [];
      const skippedIds = [];
      const failed = [];

      for (const entry of entries) {
        try {
          const result = await this.importBundleEntry(bundleDir, entry, archivePath, force);
          if (result.skipped) {
            skippedIds.push(result.threadId);
          } else if (result.imported) {
            importedIds.push(result.threadId);
          }
        } catch (error) {
          failed.push({
            threadId: entry.threadId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      return {
        preparation: backup.preparation,
        backupPath: backup.snapshotDir,
        backup,
        archivePath,
        total: entries.length,
        importedIds,
        skippedIds,
        failed
      };
    } finally {
      await fs.rm(bundleDir, { recursive: true, force: true });
    }
  }

  async cloneSession(threadId, targetProvider) {
    const source = await this.getSession(threadId);
    if (!targetProvider || !String(targetProvider).trim()) {
      throw new Error("Target provider is required for cloning.");
    }
    if (String(targetProvider).trim() === String(source.model_provider).trim()) {
      throw new Error("Target provider must differ from the current session model_provider for cloning.");
    }

    await ensureFile(source.rollout_path);
    const preparation = await this.prepareBackup();

    const now = new Date();
    const nowTs = currentUnixTime();
    const clonedId = createThreadId();
    const clonedRolloutPath = buildRolloutPath(this.codexHome, clonedId, now);

    await ensureParentDir(clonedRolloutPath);
    await fs.copyFile(source.rollout_path, clonedRolloutPath);
    await rewriteClonedRolloutJsonl(clonedRolloutPath, {
      sourceId: String(source.id),
      clonedId,
      sourceProvider: String(source.model_provider ?? ""),
      targetProvider: String(targetProvider).trim()
    });

    try {
      const db = await loadDatabase(this.dbPath);
      const threadColumns = await this.getTableColumns(db, "threads");
      db.run("BEGIN");

      const clonedThread = {
        ...source,
        id: clonedId,
        rollout_path: clonedRolloutPath,
        created_at: nowTs,
        updated_at: nowTs,
        created_at_ms: nowTs * 1000,
        updated_at_ms: nowTs * 1000,
        model_provider: String(targetProvider).trim(),
        archived: 0,
        archived_at: null
      };

      const availableThreadColumns = THREAD_COLUMNS.filter((column) => threadColumns.has(column));
      const placeholders = availableThreadColumns.map((column) => `:${column}`).join(", ");
      const boundThread = Object.fromEntries(
        availableThreadColumns.map((column) => [`:${column}`, clonedThread[column] ?? null])
      );
      db.run(
        `INSERT INTO threads (${availableThreadColumns.join(", ")}) VALUES (${placeholders})`,
        boundThread
      );

      db.run("COMMIT");
      const updatedBytes = db.export();
      db.close();
      await fs.writeFile(this.dbPath, Buffer.from(updatedBytes));
      await this.upsertSessionIndexEntry(clonedThread);

      return {
        preparation,
        sourceId: threadId,
        clonedId,
        modelProvider: String(targetProvider).trim(),
        rolloutPath: clonedRolloutPath
      };
    } catch (error) {
      await fs.rm(clonedRolloutPath, { force: true });
      throw error;
    }
  }

  async retargetSession(threadId, targetProvider) {
    if (!targetProvider || !String(targetProvider).trim()) {
      throw new Error("Target provider is required for retargeting.");
    }

    const source = await this.getSession(threadId);
    if (String(targetProvider).trim() === String(source.model_provider).trim()) {
      throw new Error("Target provider must differ from the current session model_provider for retargeting.");
    }
    await ensureFile(source.rollout_path);
    const preparation = await this.prepareBackup();
    const normalizedTargetProvider = String(targetProvider).trim();
    await rewriteRetargetedRolloutJsonl(source.rollout_path, {
      sourceProvider: String(source.model_provider ?? ""),
      targetProvider: normalizedTargetProvider
    });

    const db = await loadDatabase(this.dbPath);
    const threadColumns = await this.getTableColumns(db, "threads");
    const updates = [];
    const params = {
      ":threadId": threadId
    };

    if (threadColumns.has("model_provider")) {
      updates.push("model_provider = :targetProvider");
      params[":targetProvider"] = normalizedTargetProvider;
    }

    if (updates.length === 0) {
      db.close();
      throw new Error("Cannot retarget this database because required thread columns are missing.");
    }

    db.run(
      `
        UPDATE threads
        SET ${updates.join(",\n            ")}
        WHERE id = :threadId
      `,
      params
    );

    const updatedBytes = db.export();
    db.close();
    await fs.writeFile(this.dbPath, Buffer.from(updatedBytes));

    return {
      preparation,
      threadId,
      modelProvider: normalizedTargetProvider
    };
  }

  async batchRetargetSessions(threadIds, targetProvider) {
    if (!targetProvider || !String(targetProvider).trim()) {
      throw new Error("Target provider is required for batch retargeting.");
    }

    const normalizedThreadIds = Array.from(
      new Set((Array.isArray(threadIds) ? threadIds : []).map((value) => String(value).trim()).filter(Boolean))
    );

    if (normalizedThreadIds.length === 0) {
      throw new Error("At least one thread id is required for batch retargeting.");
    }

    const normalizedTargetProvider = String(targetProvider).trim();
    const sessions = [];
    for (const threadId of normalizedThreadIds) {
      const session = await this.getSession(threadId);
      sessions.push(session);
    }

    const skippedIds = sessions
      .filter((session) => String(session.model_provider).trim() === normalizedTargetProvider)
      .map((session) => String(session.id));
    const candidates = sessions.filter((session) => String(session.model_provider).trim() !== normalizedTargetProvider);

    if (candidates.length === 0) {
      return {
        preparation: null,
        modelProvider: normalizedTargetProvider,
        threadIds: [],
        skippedIds
      };
    }

    for (const session of candidates) {
      await ensureFile(session.rollout_path);
    }

    const preparation = await this.prepareBackup();
    const rolloutBackups = new Map();

    try {
      for (const session of candidates) {
        if (!rolloutBackups.has(session.rollout_path)) {
          rolloutBackups.set(session.rollout_path, await fs.readFile(session.rollout_path, "utf8"));
        }

        await rewriteRetargetedRolloutJsonl(session.rollout_path, {
          sourceProvider: String(session.model_provider ?? ""),
          targetProvider: normalizedTargetProvider
        });
      }

      const db = await loadDatabase(this.dbPath);
      try {
        const threadColumns = await this.getTableColumns(db, "threads");
        if (!threadColumns.has("model_provider")) {
          throw new Error("Cannot retarget this database because required thread columns are missing.");
        }

        db.run("BEGIN");
        for (const session of candidates) {
          db.run(
            `
              UPDATE threads
              SET model_provider = :targetProvider
              WHERE id = :threadId
            `,
            {
              ":targetProvider": normalizedTargetProvider,
              ":threadId": String(session.id)
            }
          );
        }
        db.run("COMMIT");

        const updatedBytes = db.export();
        await fs.writeFile(this.dbPath, Buffer.from(updatedBytes));
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {}
        throw error;
      } finally {
        db.close();
      }

      return {
        preparation,
        modelProvider: normalizedTargetProvider,
        threadIds: candidates.map((session) => String(session.id)),
        skippedIds
      };
    } catch (error) {
      for (const [rolloutPath, content] of rolloutBackups.entries()) {
        await fs.writeFile(rolloutPath, content);
      }
      throw error;
    }
  }

  async deleteSession(threadId) {
    const source = await this.getSession(threadId);
    const preparation = await this.prepareBackup();
    const db = await loadDatabase(this.dbPath);

    db.run("BEGIN");

    db.run(`DELETE FROM threads WHERE id = :threadId`, {
      ":threadId": threadId
    });

    if (await this.tableExists(db, "thread_dynamic_tools")) {
      db.run(`DELETE FROM thread_dynamic_tools WHERE thread_id = :threadId`, {
        ":threadId": threadId
      });
    }

    if (await this.tableExists(db, "stage1_outputs")) {
      db.run(`DELETE FROM stage1_outputs WHERE thread_id = :threadId`, {
        ":threadId": threadId
      });
    }

    if (await this.tableExists(db, "thread_spawn_edges")) {
      db.run(
        `
          DELETE FROM thread_spawn_edges
          WHERE parent_thread_id = :threadId OR child_thread_id = :threadId
        `,
        { ":threadId": threadId }
      );
    }

    if (await this.tableExists(db, "agent_job_items")) {
      db.run(
        `
          UPDATE agent_job_items
          SET assigned_thread_id = NULL
          WHERE assigned_thread_id = :threadId
        `,
        { ":threadId": threadId }
      );
    }

    db.run("COMMIT");
    const updatedBytes = db.export();
    db.close();
    await fs.writeFile(this.dbPath, Buffer.from(updatedBytes));

    let rolloutDeleted = false;
    try {
      await fs.rm(String(source.rollout_path), { force: true });
      rolloutDeleted = true;
    } catch {
      rolloutDeleted = false;
    }

    const sessionIndexUpdated = await this.removeSessionIndexEntry(threadId);

    return {
      preparation,
      threadId,
      rolloutPath: source.rollout_path,
      rolloutDeleted,
      sessionIndexUpdated
    };
  }
}
