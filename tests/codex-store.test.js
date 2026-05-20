import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import * as tar from "tar";
import { getSqlJs } from "../backend/sqlite.js";
import { CodexSessionStore } from "../backend/store.js";

async function createFixture(options = {}) {
  const SQL = await getSqlJs();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-sessions-"));
  const codexHome = path.join(tempDir, ".codex");
  const sessionsDir = path.join(codexHome, "sessions", "2026", "04", "10");
  await fs.mkdir(sessionsDir, { recursive: true });

  const rolloutPath = path.join(
    sessionsDir,
    "rollout-2026-04-10T10-00-00Z-00000000-0000-4000-8000-000000000000.jsonl"
  );

  const archivedSessionsDir = path.join(codexHome, "archived_sessions");
  await fs.mkdir(archivedSessionsDir, { recursive: true });
  const archivedRolloutPath = path.join(
    archivedSessionsDir,
    "rollout-2026-04-09T10-00-00Z-11111111-1111-4111-8111-111111111111.jsonl"
  );

  const sessionIndexPath = path.join(codexHome, "session_index.jsonl");
  const globalStatePath = path.join(codexHome, ".codex-global-state.json");
  if (options.seedThread !== false) {
    await fs.writeFile(rolloutPath, options.rolloutContent ?? '{"type":"message"}\n');
    await fs.writeFile(archivedRolloutPath, '{"type":"archived"}\n');
    await fs.writeFile(
      sessionIndexPath,
      '{"id":"source-thread","thread_name":"Fixture thread","updated_at":"1970-01-01T00:00:02.000Z"}\n'
    );
  }
  await fs.writeFile(globalStatePath, JSON.stringify({ lastProvider: "openai" }, null, 2));

  const db = new SQL.Database();
  db.run(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      has_user_event INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      git_sha TEXT,
      git_branch TEXT,
      git_origin_url TEXT,
      cli_version TEXT NOT NULL DEFAULT '',
      first_user_message TEXT NOT NULL DEFAULT '',
      agent_nickname TEXT,
      agent_role TEXT,
      memory_mode TEXT NOT NULL DEFAULT 'enabled',
      model TEXT,
      reasoning_effort TEXT,
      agent_path TEXT,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      thread_source TEXT
    );
  `);
  db.run(`
    CREATE TRIGGER threads_created_at_ms_after_insert
    AFTER INSERT ON threads
    WHEN NEW.created_at_ms IS NULL
    BEGIN
      UPDATE threads
      SET created_at_ms = NEW.created_at * 1000
      WHERE id = NEW.id;
    END;
  `);
  db.run(`
    CREATE TRIGGER threads_updated_at_ms_after_insert
    AFTER INSERT ON threads
    WHEN NEW.updated_at_ms IS NULL
    BEGIN
      UPDATE threads
      SET updated_at_ms = NEW.updated_at * 1000
      WHERE id = NEW.id;
    END;
  `);
  db.run(`
    CREATE TRIGGER threads_created_at_ms_after_update
    AFTER UPDATE OF created_at ON threads
    WHEN NEW.created_at != OLD.created_at
     AND NEW.created_at_ms IS OLD.created_at_ms
    BEGIN
      UPDATE threads
      SET created_at_ms = NEW.created_at * 1000
      WHERE id = NEW.id;
    END;
  `);
  db.run(`
    CREATE TRIGGER threads_updated_at_ms_after_update
    AFTER UPDATE OF updated_at ON threads
    WHEN NEW.updated_at != OLD.updated_at
     AND NEW.updated_at_ms IS OLD.updated_at_ms
    BEGIN
      UPDATE threads
      SET updated_at_ms = NEW.updated_at * 1000
      WHERE id = NEW.id;
    END;
  `);
  if (options.includeDynamicToolsTable !== false) {
    db.run(`
      CREATE TABLE thread_dynamic_tools (
        thread_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        input_schema TEXT NOT NULL,
        defer_loading INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(thread_id, position)
      );
    `);
  }

  if (options.seedThread !== false) {
    db.run(
      `
        INSERT INTO threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
          sandbox_policy, approval_mode, tokens_used, has_user_event, archived, archived_at,
          git_sha, git_branch, git_origin_url, cli_version, first_user_message, agent_nickname,
          agent_role, memory_mode, model, reasoning_effort, agent_path, created_at_ms, updated_at_ms, thread_source
        ) VALUES (
          :id, :rollout_path, :created_at, :updated_at, :source, :model_provider, :cwd, :title,
          :sandbox_policy, :approval_mode, :tokens_used, :has_user_event, :archived, :archived_at,
          :git_sha, :git_branch, :git_origin_url, :cli_version, :first_user_message, :agent_nickname,
          :agent_role, :memory_mode, :model, :reasoning_effort, :agent_path, :created_at_ms, :updated_at_ms, :thread_source
        )
      `,
      {
        ":id": "source-thread",
        ":rollout_path": rolloutPath,
        ":created_at": 1,
        ":updated_at": 2,
        ":source": "cli",
        ":model_provider": "openai",
        ":cwd": "/tmp/demo",
        ":title": "Fixture thread",
        ":sandbox_policy": "workspace-write",
        ":approval_mode": "on-request",
        ":tokens_used": 10,
        ":has_user_event": 1,
        ":archived": 0,
        ":archived_at": null,
        ":git_sha": null,
        ":git_branch": "main",
        ":git_origin_url": null,
        ":cli_version": "1.0.0",
        ":first_user_message": "hello",
        ":agent_nickname": null,
        ":agent_role": null,
        ":memory_mode": "enabled",
        ":model": "gpt-5.4",
        ":reasoning_effort": "high",
        ":agent_path": null,
        ":created_at_ms": 1000,
        ":updated_at_ms": 2000,
        ":thread_source": null
      }
    );

    if (options.includeDynamicToolsTable !== false) {
      db.run(
        `
          INSERT INTO thread_dynamic_tools (
            thread_id, position, name, description, input_schema, defer_loading
          ) VALUES (
            'source-thread', 0, 'tool-a', 'desc', '{}', 0
          )
        `
      );
    }
  }

  const dbPath = path.join(codexHome, "state_5.sqlite");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(dbPath, Buffer.from(db.export()));
  db.close();

  return {
    tempDir,
    codexHome,
    dbPath,
    rolloutPath,
    archivedRolloutPath,
    sessionIndexPath,
    globalStatePath
  };
}

async function addThreadToFixture(fixture, options) {
  const rolloutPath = path.join(
    fixture.codexHome,
    "sessions",
    "2026",
    "04",
    "10",
    `rollout-${options.threadId}.jsonl`
  );
  await fs.writeFile(rolloutPath, options.rolloutContent ?? '{"type":"message"}\n');

  const SQL = await getSqlJs();
  const db = new SQL.Database(await fs.readFile(fixture.dbPath));
  db.run(
    `
      INSERT INTO threads (
        id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
        sandbox_policy, approval_mode, tokens_used, has_user_event, archived, archived_at,
        git_sha, git_branch, git_origin_url, cli_version, first_user_message, agent_nickname,
        agent_role, memory_mode, model, reasoning_effort, agent_path, created_at_ms, updated_at_ms, thread_source
      ) VALUES (
        :id, :rollout_path, :created_at, :updated_at, :source, :model_provider, :cwd, :title,
        :sandbox_policy, :approval_mode, :tokens_used, :has_user_event, :archived, :archived_at,
        :git_sha, :git_branch, :git_origin_url, :cli_version, :first_user_message, :agent_nickname,
        :agent_role, :memory_mode, :model, :reasoning_effort, :agent_path, :created_at_ms, :updated_at_ms, :thread_source
      )
    `,
    {
      ":id": options.threadId,
      ":rollout_path": rolloutPath,
      ":created_at": options.createdAt ?? options.updatedAt - 1,
      ":updated_at": options.updatedAt,
      ":source": "cli",
      ":model_provider": options.modelProvider,
      ":cwd": options.cwd ?? `/tmp/${options.threadId}`,
      ":title": options.title,
      ":sandbox_policy": "workspace-write",
      ":approval_mode": "on-request",
      ":tokens_used": options.tokensUsed ?? 0,
      ":has_user_event": 1,
      ":archived": 0,
      ":archived_at": null,
      ":git_sha": null,
      ":git_branch": "main",
      ":git_origin_url": null,
      ":cli_version": "1.0.0",
      ":first_user_message": options.firstUserMessage ?? "hello",
      ":agent_nickname": null,
      ":agent_role": null,
      ":memory_mode": "enabled",
      ":model": "gpt-5.4",
      ":reasoning_effort": "high",
      ":agent_path": null,
      ":created_at_ms": (options.createdAt ?? options.updatedAt - 1) * 1000,
      ":updated_at_ms": options.updatedAt * 1000,
      ":thread_source": null
    }
  );
  await fs.writeFile(fixture.dbPath, Buffer.from(db.export()));
  db.close();
  return rolloutPath;
}

async function readSessionIndexEntries(sessionIndexPath) {
  const raw = await fs.readFile(sessionIndexPath, "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function readJsonlRecords(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("backupSnapshot copies database, sessions, archived_sessions, session_index, and global state", async () => {
  const fixture = await createFixture();
  const store = new CodexSessionStore({
    codexHome: fixture.codexHome,
    dbPath: fixture.dbPath,
    skipSqlitePrepare: true
  });

  const backup = await store.backupSnapshot();

  const manifest = JSON.parse(
    await fs.readFile(path.join(backup.snapshotDir, "manifest.json"), "utf8")
  );

  assert.equal(path.basename(backup.dbPath), "state_5.sqlite");
  assert.equal(manifest.snapshotDir, backup.snapshotDir);
  assert.deepEqual(await fs.readFile(backup.dbPath), await fs.readFile(fixture.dbPath));
  assert.equal(
    await fs.readFile(path.join(backup.sessionsPath, "2026", "04", "10", path.basename(fixture.rolloutPath)), "utf8"),
    await fs.readFile(fixture.rolloutPath, "utf8")
  );
  assert.equal(
    await fs.readFile(path.join(backup.archivedSessionsPath, path.basename(fixture.archivedRolloutPath)), "utf8"),
    await fs.readFile(fixture.archivedRolloutPath, "utf8")
  );
  assert.equal(await fs.readFile(backup.sessionIndexPath, "utf8"), await fs.readFile(fixture.sessionIndexPath, "utf8"));
  assert.equal(await fs.readFile(backup.globalStatePath, "utf8"), await fs.readFile(fixture.globalStatePath, "utf8"));
});

test("backupSnapshot uses lsof fallback on macOS when sqlite3 is unavailable", async () => {
  const fixture = await createFixture();
  const walPath = `${fixture.dbPath}-wal`;
  const shmPath = `${fixture.dbPath}-shm`;
  await fs.writeFile(walPath, "wal-data");
  await fs.writeFile(shmPath, "shm-data");

  const store = new CodexSessionStore({
    codexHome: fixture.codexHome,
    dbPath: fixture.dbPath,
    sqlite3Bin: "sqlite3-definitely-missing",
    platform: "darwin"
  });
  store.hasLsofCli = async () => true;
  store.findOpenHandles = async () => [];

  const backup = await store.backupSnapshot();

  assert.equal(backup.preparation.sqlite3Available, false);
  assert.equal(backup.preparation.mode, "lsof-fallback");
  assert.equal(backup.preparation.occupied, false);
  assert.equal(await fs.readFile(backup.walPath, "utf8"), "wal-data");
  assert.equal(await fs.readFile(backup.shmPath, "utf8"), "shm-data");
});

test("prepareBackup uses /proc fallback on Linux when sqlite3 and lsof are unavailable", async () => {
  const fixture = await createFixture();
  const store = new CodexSessionStore({
    codexHome: fixture.codexHome,
    dbPath: fixture.dbPath,
    sqlite3Bin: "sqlite3-definitely-missing",
    platform: "linux"
  });

  store.hasLsofCli = async () => false;
  store.findOpenHandlesLinuxProc = async () => [];

  const result = await store.prepareBackup();

  assert.equal(result.sqlite3Available, false);
  assert.equal(result.lsofAvailable, false);
  assert.equal(result.mode, "linux-proc-fallback");
  assert.equal(result.occupied, false);
});

test("prepareBackup rejects writes when database handles remain open even if sqlite3 is available", async () => {
  const fixture = await createFixture();
  const store = new CodexSessionStore({
    codexHome: fixture.codexHome,
    dbPath: fixture.dbPath,
    platform: "linux"
  });

  store.hasSqliteCli = async () => true;
  store.runSqlitePragma = async (sql) =>
    sql.includes("integrity_check") ? ["ok"] : ["0|0|0"];
  store.hasLsofCli = async () => true;
  store.findOpenHandles = async () => ["12345 codex /tmp/state_5.sqlite"];

  await assert.rejects(
    () => store.prepareBackup(),
    /checkpoint 之后仍被占用|先关闭本地正在运行的 Codex/
  );
});

test("prepareBackup uses Windows fallback when sqlite3 is unavailable", async () => {
  const fixture = await createFixture();
  const store = new CodexSessionStore({
    codexHome: fixture.codexHome,
    dbPath: fixture.dbPath,
    sqlite3Bin: "sqlite3-definitely-missing",
    platform: "win32"
  });

  store.findLockedFilesWindows = async () => [];

  const result = await store.prepareBackup();

  assert.equal(result.sqlite3Available, false);
  assert.equal(result.mode, "windows-exclusive-open");
  assert.equal(result.occupied, false);
});

test("prepareBackup returns a user-friendly suggestion when Windows files are occupied and sqlite3 is unavailable", async () => {
  const fixture = await createFixture();
  const store = new CodexSessionStore({
    codexHome: fixture.codexHome,
    dbPath: fixture.dbPath,
    sqlite3Bin: "sqlite3-definitely-missing",
    platform: "win32"
  });

  store.findLockedFilesWindows = async () => [`${fixture.dbPath}: file is locked`];

  await assert.rejects(
    () => store.prepareBackup(),
    /先关闭本地正在运行的 Codex|先不要打开 Codex，先导入 session/
  );
});

test("exportSession writes a portable .tgz archive with thread SQL and rollout JSONL", async () => {
  const fixture = await createFixture();
  const archivePath = path.join(fixture.tempDir, "bundle.tgz");
  const extractDir = await fs.mkdtemp(path.join(fixture.tempDir, "extract-"));
  const store = new CodexSessionStore({
    codexHome: fixture.codexHome,
    dbPath: fixture.dbPath,
    skipSqlitePrepare: true
  });

  const result = await store.exportSession("source-thread", archivePath);
  await tar.extract({ file: archivePath, cwd: extractDir, strict: true });
  const manifest = JSON.parse(await fs.readFile(path.join(extractDir, "manifest.json"), "utf8"));
  const threadSql = await fs.readFile(path.join(extractDir, "thread.sql"), "utf8");
  const rollout = await fs.readFile(path.join(extractDir, "rollout.jsonl"), "utf8");

  assert.equal(result.archivePath, archivePath);
  assert.equal(manifest.threadId, "source-thread");
  assert.match(threadSql, /INSERT INTO threads/i);
  assert.match(threadSql, /__CODEX_SESSIONS_ROLLOUT_PATH__/);
  assert.equal(rollout, '{"type":"message"}\n');
});

test("exportSessions writes a portable batch .tgz archive with manifest, threads, and rollouts", async () => {
  const fixture = await createFixture();
  const archivePath = path.join(fixture.tempDir, "bundle-batch.tgz");
  const extractDir = await fs.mkdtemp(path.join(fixture.tempDir, "extract-batch-"));
  await addThreadToFixture(fixture, {
    threadId: "second-thread",
    modelProvider: "anthropic",
    updatedAt: 5,
    title: "Second thread",
    rolloutContent: '{"type":"second"}\n'
  });

  const store = new CodexSessionStore({
    codexHome: fixture.codexHome,
    dbPath: fixture.dbPath,
    skipSqlitePrepare: true
  });

  const result = await store.exportSessions(["source-thread", "second-thread"], archivePath);
  await tar.extract({ file: archivePath, cwd: extractDir, strict: true });
  const manifest = JSON.parse(await fs.readFile(path.join(extractDir, "manifest.json"), "utf8"));

  assert.equal(result.archivePath, archivePath);
  assert.equal(result.threadCount, 2);
  assert.deepEqual(result.threadIds, ["source-thread", "second-thread"]);
  assert.equal(manifest.bundleType, "session-batch");
  assert.equal(manifest.threadCount, 2);
  assert.equal(manifest.threads.length, 2);

  for (const entry of manifest.threads) {
    const threadSql = await fs.readFile(path.join(extractDir, entry.sqlFile), "utf8");
    const rollout = await fs.readFile(path.join(extractDir, entry.rolloutFile), "utf8");
    assert.match(threadSql, /INSERT INTO threads/i);
    assert.match(threadSql, /__CODEX_SESSIONS_ROLLOUT_PATH__/);
    assert.ok(rollout.length > 0);
  }
});

test("importSession reads a .tgz archive and restores rollout JSONL into the current codex home", async () => {
  const sourceFixture = await createFixture();
  const targetFixture = await createFixture({ seedThread: false });
  const archivePath = path.join(sourceFixture.tempDir, "bundle.tgz");

  const sourceStore = new CodexSessionStore({
    codexHome: sourceFixture.codexHome,
    dbPath: sourceFixture.dbPath,
    skipSqlitePrepare: true
  });
  await sourceStore.exportSession("source-thread", archivePath);

  const targetStore = new CodexSessionStore({
    codexHome: targetFixture.codexHome,
    dbPath: targetFixture.dbPath,
    skipSqlitePrepare: true
  });

  const result = await targetStore.importSession(archivePath);
  const imported = await targetStore.getSession("source-thread");

  assert.equal(result.threadId, "source-thread");
  assert.equal(result.archivePath, archivePath);
  assert.match(result.backupPath, /snapshot-/);
  assert.equal(result.imported, true);
  assert.equal(result.skipped, false);
  assert.equal(imported.model_provider, "openai");
  assert.equal(imported.rollout_exists, true);
  assert.ok(imported.rollout_path.startsWith(targetFixture.codexHome));
  assert.ok(!imported.rollout_path.startsWith(sourceFixture.codexHome));
  assert.equal(await fs.readFile(imported.rollout_path, "utf8"), '{"type":"message"}\n');

  const sessionIndex = await readSessionIndexEntries(targetFixture.sessionIndexPath);
  assert.deepEqual(sessionIndex, [
    {
      id: "source-thread",
      thread_name: "Fixture thread",
      updated_at: "1970-01-01T00:00:02.000Z"
    }
  ]);
});

test("importSession creates a snapshot backup exactly once before importing", async () => {
  const sourceFixture = await createFixture();
  const targetFixture = await createFixture({ seedThread: false });
  const archivePath = path.join(sourceFixture.tempDir, "bundle-backup-once.tgz");

  const sourceStore = new CodexSessionStore({
    codexHome: sourceFixture.codexHome,
    dbPath: sourceFixture.dbPath,
    skipSqlitePrepare: true
  });
  await sourceStore.exportSession("source-thread", archivePath);

  const targetStore = new CodexSessionStore({
    codexHome: targetFixture.codexHome,
    dbPath: targetFixture.dbPath,
    skipSqlitePrepare: true
  });
  const originalBackupSnapshot = targetStore.backupSnapshot.bind(targetStore);
  let backupCalls = 0;
  targetStore.backupSnapshot = async (...args) => {
    backupCalls += 1;
    return originalBackupSnapshot(...args);
  };

  const result = await targetStore.importSession(archivePath);

  assert.equal(backupCalls, 1);
  assert.ok(result.backupPath);
  await fs.access(path.join(result.backupPath, "manifest.json"));
});

test("importSession replaces an existing session when the archive updated_at is newer", async () => {
  const sourceFixture = await createFixture();
  const targetFixture = await createFixture();
  const archivePath = path.join(sourceFixture.tempDir, "bundle-newer.tgz");

  const SQL = await getSqlJs();
  const dbBuffer = await fs.readFile(sourceFixture.dbPath);
  const db = new SQL.Database(dbBuffer);
  db.run(
    `UPDATE threads
     SET updated_at = 10,
         title = 'Imported newer thread',
         model_provider = 'anthropic'
     WHERE id = 'source-thread'`
  );
  await fs.writeFile(sourceFixture.dbPath, Buffer.from(db.export()));
  db.close();
  await fs.writeFile(sourceFixture.rolloutPath, '{"type":"newer"}\n');

  const sourceStore = new CodexSessionStore({
    codexHome: sourceFixture.codexHome,
    dbPath: sourceFixture.dbPath,
    skipSqlitePrepare: true
  });
  await sourceStore.exportSession("source-thread", archivePath);

  const targetStore = new CodexSessionStore({
    codexHome: targetFixture.codexHome,
    dbPath: targetFixture.dbPath,
    skipSqlitePrepare: true
  });

  const result = await targetStore.importSession(archivePath);
  const imported = await targetStore.getSession("source-thread");

  assert.equal(result.imported, true);
  assert.equal(result.skipped, false);
  assert.equal(result.reason, "updated");
  assert.equal(imported.updated_at, 10);
  assert.equal(imported.title, "Imported newer thread");
  assert.equal(imported.model_provider, "anthropic");
  assert.equal(imported.dynamic_tools.length, 0);
  assert.equal(await fs.readFile(imported.rollout_path, "utf8"), '{"type":"newer"}\n');

  const sessionIndex = await readSessionIndexEntries(targetFixture.sessionIndexPath);
  assert.deepEqual(sessionIndex, [
    {
      id: "source-thread",
      thread_name: "Imported newer thread",
      updated_at: "1970-01-01T00:00:10.000Z"
    }
  ]);
});

test("importSession skips an existing session when the archive updated_at is older or equal", async () => {
  const sourceFixture = await createFixture();
  const targetFixture = await createFixture();
  const archivePath = path.join(sourceFixture.tempDir, "bundle-older.tgz");

  const SQL = await getSqlJs();
  const dbBuffer = await fs.readFile(sourceFixture.dbPath);
  const db = new SQL.Database(dbBuffer);
  db.run(
    `UPDATE threads
     SET updated_at = 1,
         title = 'Imported older thread',
         model_provider = 'anthropic'
     WHERE id = 'source-thread'`
  );
  await fs.writeFile(sourceFixture.dbPath, Buffer.from(db.export()));
  db.close();
  await fs.writeFile(sourceFixture.rolloutPath, '{"type":"older"}\n');

  const sourceStore = new CodexSessionStore({
    codexHome: sourceFixture.codexHome,
    dbPath: sourceFixture.dbPath,
    skipSqlitePrepare: true
  });
  await sourceStore.exportSession("source-thread", archivePath);

  const targetStore = new CodexSessionStore({
    codexHome: targetFixture.codexHome,
    dbPath: targetFixture.dbPath,
    skipSqlitePrepare: true
  });

  const existingBefore = await targetStore.getSession("source-thread");
  const rolloutBefore = await fs.readFile(existingBefore.rollout_path, "utf8");
  const result = await targetStore.importSession(archivePath);
  const existingAfter = await targetStore.getSession("source-thread");

  assert.equal(result.imported, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "not-newer");
  assert.equal(existingAfter.updated_at, existingBefore.updated_at);
  assert.equal(existingAfter.title, existingBefore.title);
  assert.equal(existingAfter.model_provider, existingBefore.model_provider);
  assert.equal(await fs.readFile(existingAfter.rollout_path, "utf8"), rolloutBefore);
});

test("importSession force-overwrites an existing session even when the archive updated_at is older", async () => {
  const sourceFixture = await createFixture();
  const targetFixture = await createFixture();
  const archivePath = path.join(sourceFixture.tempDir, "bundle-force.tgz");

  const SQL = await getSqlJs();
  const dbBuffer = await fs.readFile(sourceFixture.dbPath);
  const db = new SQL.Database(dbBuffer);
  db.run(
    `UPDATE threads
     SET updated_at = 1,
         title = 'Imported forced thread',
         model_provider = 'deepseek'
     WHERE id = 'source-thread'`
  );
  await fs.writeFile(sourceFixture.dbPath, Buffer.from(db.export()));
  db.close();
  await fs.writeFile(sourceFixture.rolloutPath, '{"type":"forced"}\n');

  const sourceStore = new CodexSessionStore({
    codexHome: sourceFixture.codexHome,
    dbPath: sourceFixture.dbPath,
    skipSqlitePrepare: true
  });
  await sourceStore.exportSession("source-thread", archivePath);

  const targetStore = new CodexSessionStore({
    codexHome: targetFixture.codexHome,
    dbPath: targetFixture.dbPath,
    skipSqlitePrepare: true
  });

  const result = await targetStore.importSession(archivePath, { force: true });
  const imported = await targetStore.getSession("source-thread");

  assert.equal(result.imported, true);
  assert.equal(result.skipped, false);
  assert.equal(result.reason, "forced");
  assert.equal(imported.updated_at, 1);
  assert.equal(imported.title, "Imported forced thread");
  assert.equal(imported.model_provider, "deepseek");
  assert.equal(imported.dynamic_tools.length, 0);
  assert.equal(await fs.readFile(imported.rollout_path, "utf8"), '{"type":"forced"}\n');
});

test("importSessions imports a batch archive and creates one snapshot backup", async () => {
  const sourceFixture = await createFixture();
  const targetFixture = await createFixture({ seedThread: false });
  const archivePath = path.join(sourceFixture.tempDir, "bundle-batch-import.tgz");
  await addThreadToFixture(sourceFixture, {
    threadId: "second-thread",
    modelProvider: "anthropic",
    updatedAt: 5,
    title: "Second thread",
    rolloutContent: '{"type":"second"}\n'
  });

  const sourceStore = new CodexSessionStore({
    codexHome: sourceFixture.codexHome,
    dbPath: sourceFixture.dbPath,
    skipSqlitePrepare: true
  });
  await sourceStore.exportSessions(["source-thread", "second-thread"], archivePath);

  const targetStore = new CodexSessionStore({
    codexHome: targetFixture.codexHome,
    dbPath: targetFixture.dbPath,
    skipSqlitePrepare: true
  });
  const originalBackupSnapshot = targetStore.backupSnapshot.bind(targetStore);
  let backupCalls = 0;
  targetStore.backupSnapshot = async (...args) => {
    backupCalls += 1;
    return originalBackupSnapshot(...args);
  };

  const result = await targetStore.importSessions(archivePath);
  const firstImported = await targetStore.getSession("source-thread");
  const secondImported = await targetStore.getSession("second-thread");

  assert.equal(backupCalls, 1);
  assert.equal(result.total, 2);
  assert.deepEqual(result.importedIds, ["source-thread", "second-thread"]);
  assert.deepEqual(result.skippedIds, []);
  assert.deepEqual(result.failed, []);
  assert.match(result.backupPath, /snapshot-/);
  assert.equal(firstImported.model_provider, "openai");
  assert.equal(secondImported.model_provider, "anthropic");
  assert.equal(await fs.readFile(secondImported.rollout_path, "utf8"), '{"type":"second"}\n');
});

test("importSessions reports failed entries without blocking the rest of the batch", async () => {
  const sourceFixture = await createFixture();
  const targetFixture = await createFixture({ seedThread: false });
  const archivePath = path.join(sourceFixture.tempDir, "bundle-batch-partial.tgz");
  const tamperedArchivePath = path.join(sourceFixture.tempDir, "bundle-batch-partial-tampered.tgz");
  const extractDir = await fs.mkdtemp(path.join(sourceFixture.tempDir, "extract-partial-"));
  await addThreadToFixture(sourceFixture, {
    threadId: "second-thread",
    modelProvider: "anthropic",
    updatedAt: 5,
    title: "Second thread",
    rolloutContent: '{"type":"second"}\n'
  });

  const sourceStore = new CodexSessionStore({
    codexHome: sourceFixture.codexHome,
    dbPath: sourceFixture.dbPath,
    skipSqlitePrepare: true
  });
  await sourceStore.exportSessions(["source-thread", "second-thread"], archivePath);
  await tar.extract({ file: archivePath, cwd: extractDir, strict: true });
  const manifest = JSON.parse(await fs.readFile(path.join(extractDir, "manifest.json"), "utf8"));
  await fs.rm(path.join(extractDir, manifest.threads[1].rolloutFile), { force: true });
  await tar.create(
    {
      gzip: true,
      cwd: extractDir,
      file: tamperedArchivePath,
      portable: true,
      strict: true
    },
    ["manifest.json", "threads", "rollouts"]
  );

  const targetStore = new CodexSessionStore({
    codexHome: targetFixture.codexHome,
    dbPath: targetFixture.dbPath,
    skipSqlitePrepare: true
  });

  const result = await targetStore.importSessions(tamperedArchivePath);
  const imported = await targetStore.getSession("source-thread");

  assert.equal(result.total, 2);
  assert.deepEqual(result.importedIds, ["source-thread"]);
  assert.deepEqual(result.skippedIds, []);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].threadId, "second-thread");
  assert.match(result.failed[0].error, /Missing file/);
  assert.equal(imported.model_provider, "openai");
  await assert.rejects(() => targetStore.getSession("second-thread"), /Session not found/);
});

test("getSession tolerates databases without thread_dynamic_tools", async () => {
  const fixture = await createFixture({ includeDynamicToolsTable: false });
  const store = new CodexSessionStore({
    codexHome: fixture.codexHome,
    dbPath: fixture.dbPath,
    skipSqlitePrepare: true
  });

  const session = await store.getSession("source-thread");

  assert.deepEqual(session.dynamic_tools, []);
});

test("getSession prefers event message timestamps over replayed response items", async () => {
  const rolloutContent = [
    JSON.stringify({
      timestamp: "2026-04-10T10:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }]
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-10T10:00:00.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "hello" }
    }),
    JSON.stringify({
      timestamp: "2026-04-10T10:00:05.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "hi there" }
    }),
    JSON.stringify({
      timestamp: "2026-04-10T10:10:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }]
      }
    })
  ].join("\n");
  const fixture = await createFixture({ rolloutContent });
  const store = new CodexSessionStore({
    codexHome: fixture.codexHome,
    dbPath: fixture.dbPath,
    skipSqlitePrepare: true
  });

  const session = await store.getSession("source-thread");

  assert.deepEqual(
    session.conversation_messages.map((message) => ({
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      source: message.source
    })),
    [
      {
        role: "user",
        content: "hello",
        timestamp: "2026-04-10T10:00:00.000Z",
        source: "event_msg"
      },
      {
        role: "assistant",
        content: "hi there",
        timestamp: "2026-04-10T10:00:05.000Z",
        source: "event_msg"
      }
    ]
  );
});

test("cloneSession duplicates thread row and rollout jsonl without copying dynamic tools", async () => {
  const fixture = await createFixture();
  const store = new CodexSessionStore({
    codexHome: fixture.codexHome,
    dbPath: fixture.dbPath,
    skipSqlitePrepare: true
  });

  const result = await store.cloneSession("source-thread", "crs");
  const cloned = await store.getSession(result.clonedId);
  const original = await store.getSession("source-thread");
  const sessions = await store.listSessions({ limit: 10 });

  assert.equal(cloned.model_provider, "crs");
  assert.equal(cloned.title, "Fixture thread");
  assert.equal(cloned.rollout_exists, true);
  assert.notEqual(cloned.rollout_path, fixture.rolloutPath);
  assert.equal(original.rollout_path, fixture.rolloutPath);
  assert.equal(original.model_provider, "openai");
  assert.equal(cloned.dynamic_tools.length, 0);
  assert.equal(sessions.length, 2);

  const sessionIndex = await readSessionIndexEntries(fixture.sessionIndexPath);
  assert.equal(sessionIndex.length, 2);
  assert.deepEqual(sessionIndex[0], {
    id: "source-thread",
    thread_name: "Fixture thread",
    updated_at: "1970-01-01T00:00:02.000Z"
  });
  assert.deepEqual(sessionIndex[1], {
    id: result.clonedId,
    thread_name: "Fixture thread",
    updated_at: new Date(cloned.updated_at * 1000).toISOString()
  });
});

test("cloneSession rewrites embedded rollout thread metadata to the cloned id and provider", async () => {
  const fixture = await createFixture();
  await fs.writeFile(
    fixture.rolloutPath,
    [
      JSON.stringify({
        timestamp: "2026-04-10T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "source-thread",
          model_provider: "openai",
          source: "cli"
        }
      }),
      JSON.stringify({
        timestamp: "2026-04-10T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "thread_name_updated",
          thread_id: "source-thread",
          thread_name: "Fixture thread"
        }
      }),
      ""
    ].join("\n")
  );

  const store = new CodexSessionStore({
    codexHome: fixture.codexHome,
    dbPath: fixture.dbPath,
    skipSqlitePrepare: true
  });

  const result = await store.cloneSession("source-thread", "crs");
  const sourceRecords = await readJsonlRecords(fixture.rolloutPath);
  const cloned = await store.getSession(result.clonedId);
  const clonedRecords = await readJsonlRecords(cloned.rollout_path);

  assert.equal(sourceRecords[0].payload.id, "source-thread");
  assert.equal(sourceRecords[0].payload.model_provider, "openai");
  assert.equal(sourceRecords[1].payload.thread_id, "source-thread");

  assert.equal(clonedRecords[0].payload.id, result.clonedId);
  assert.equal(clonedRecords[0].payload.model_provider, "crs");
  assert.equal(clonedRecords[1].payload.thread_id, result.clonedId);
});

test("cloneSession rejects the current provider", async () => {
  const fixture = await createFixture();
  const store = new CodexSessionStore({
    codexHome: fixture.codexHome,
    dbPath: fixture.dbPath,
    skipSqlitePrepare: true
  });

  await assert.rejects(
    () => store.cloneSession("source-thread", "openai"),
    /Target provider must differ from the current session model_provider for cloning/
  );
});

test("retargetSession rewrites rollout provider and updates the thread provider without changing updated_at", async () => {
  const fixture = await createFixture();
  await fs.writeFile(
    fixture.rolloutPath,
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "source-thread",
          model_provider: "openai"
        }
      }),
      JSON.stringify({
        type: "message",
        payload: {
          model_provider: "openai",
          nested: {
            provider: "openai"
          }
        }
      }),
      ""
    ].join("\n")
  );
  const store = new CodexSessionStore({
    codexHome: fixture.codexHome,
    dbPath: fixture.dbPath,
    skipSqlitePrepare: true
  });

  const before = await store.getSession("source-thread");
  await store.retargetSession("source-thread", "sub2api");
  const updated = await store.getSession("source-thread");
  const records = await readJsonlRecords(fixture.rolloutPath);

  assert.equal(updated.model_provider, "sub2api");
  assert.equal(updated.updated_at, before.updated_at);
  assert.equal(records[0].payload.model_provider, "sub2api");
  assert.equal(records[1].payload.model_provider, "sub2api");
  assert.equal(records[1].payload.nested.provider, "openai");
});

test("batchRetargetSessions rewrites rollout providers and updates thread providers with one target", async () => {
  const fixture = await createFixture();
  const secondRolloutPath = path.join(
    fixture.codexHome,
    "sessions",
    "2026",
    "04",
    "10",
    "rollout-2026-04-10T11-00-00Z-22222222-2222-4222-8222-222222222222.jsonl"
  );
  await fs.writeFile(
    fixture.rolloutPath,
    `${JSON.stringify({ type: "session_meta", payload: { id: "source-thread", model_provider: "openai" } })}\n`
  );
  await fs.writeFile(
    secondRolloutPath,
    `${JSON.stringify({ type: "session_meta", payload: { id: "second-thread", model_provider: "anthropic" } })}\n`
  );

  const SQL = await getSqlJs();
  const db = new SQL.Database(await fs.readFile(fixture.dbPath));
  db.run(
    `
      INSERT INTO threads (
        id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
        sandbox_policy, approval_mode, tokens_used, has_user_event, archived, archived_at,
        git_sha, git_branch, git_origin_url, cli_version, first_user_message, agent_nickname,
        agent_role, memory_mode, model, reasoning_effort, agent_path, created_at_ms, updated_at_ms, thread_source
      ) VALUES (
        :id, :rollout_path, :created_at, :updated_at, :source, :model_provider, :cwd, :title,
        :sandbox_policy, :approval_mode, :tokens_used, :has_user_event, :archived, :archived_at,
        :git_sha, :git_branch, :git_origin_url, :cli_version, :first_user_message, :agent_nickname,
        :agent_role, :memory_mode, :model, :reasoning_effort, :agent_path, :created_at_ms, :updated_at_ms, :thread_source
      )
    `,
    {
      ":id": "second-thread",
      ":rollout_path": secondRolloutPath,
      ":created_at": 3,
      ":updated_at": 4,
      ":source": "cli",
      ":model_provider": "anthropic",
      ":cwd": "/tmp/demo-2",
      ":title": "Second thread",
      ":sandbox_policy": "workspace-write",
      ":approval_mode": "on-request",
      ":tokens_used": 20,
      ":has_user_event": 1,
      ":archived": 0,
      ":archived_at": null,
      ":git_sha": null,
      ":git_branch": "main",
      ":git_origin_url": null,
      ":cli_version": "1.0.0",
      ":first_user_message": "hello 2",
      ":agent_nickname": null,
      ":agent_role": null,
      ":memory_mode": "enabled",
      ":model": "gpt-5.4",
      ":reasoning_effort": "high",
      ":agent_path": null,
      ":created_at_ms": 3000,
      ":updated_at_ms": 4000,
      ":thread_source": null
    }
  );
  await fs.writeFile(fixture.dbPath, Buffer.from(db.export()));
  db.close();

  const store = new CodexSessionStore({
    codexHome: fixture.codexHome,
    dbPath: fixture.dbPath,
    skipSqlitePrepare: true
  });

  const result = await store.batchRetargetSessions(
    ["source-thread", "second-thread", "source-thread"],
    "sub2api"
  );
  const firstUpdated = await store.getSession("source-thread");
  const secondUpdated = await store.getSession("second-thread");
  const firstRecords = await readJsonlRecords(fixture.rolloutPath);
  const secondRecords = await readJsonlRecords(secondRolloutPath);

  assert.deepEqual(result.threadIds, ["source-thread", "second-thread"]);
  assert.deepEqual(result.skippedIds, []);
  assert.equal(firstUpdated.model_provider, "sub2api");
  assert.equal(secondUpdated.model_provider, "sub2api");
  assert.equal(firstRecords[0].payload.model_provider, "sub2api");
  assert.equal(secondRecords[0].payload.model_provider, "sub2api");
});

test("retargetSession rejects the current provider", async () => {
  const fixture = await createFixture();
  const store = new CodexSessionStore({
    codexHome: fixture.codexHome,
    dbPath: fixture.dbPath,
    skipSqlitePrepare: true
  });

  await assert.rejects(
    () => store.retargetSession("source-thread", "openai"),
    /Target provider must differ from the current session model_provider for retargeting/
  );
});

test("deleteSession removes the thread row, rollout jsonl, and session index entry", async () => {
  const fixture = await createFixture();
  const store = new CodexSessionStore({
    codexHome: fixture.codexHome,
    dbPath: fixture.dbPath,
    skipSqlitePrepare: true
  });

  const result = await store.deleteSession("source-thread");
  const sessions = await store.listSessions({ limit: 10 });
  const sessionIndex = await fs.readFile(fixture.sessionIndexPath, "utf8");

  assert.equal(result.threadId, "source-thread");
  assert.equal(sessions.length, 0);
  await assert.rejects(() => store.getSession("source-thread"), /Session not found/);
  await assert.rejects(() => fs.access(fixture.rolloutPath));
  assert.equal(sessionIndex, "");
});
