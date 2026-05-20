import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CodexSessionStore } from "./store.js";

const FRONTEND_DIST_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "web"
);

function isInsideDir(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

async function readRequestBodyBuffer(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function getContentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

async function ensureStaticAssets() {
  try {
    await fs.access(path.join(FRONTEND_DIST_DIR, "index.html"));
  } catch {
    throw new Error("Dashboard assets are missing. Run `npm run build` first.");
  }
}

async function serveStatic(request, response) {
  let pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/") {
    pathname = "/index.html";
  }

  const candidate = path.join(FRONTEND_DIST_DIR, pathname);
  const safePath = path.normalize(candidate);
  if (!isInsideDir(FRONTEND_DIST_DIR, safePath)) {
    json(response, 400, { error: "Invalid asset path." });
    return;
  }

  try {
    const data = await fs.readFile(safePath);
    response.writeHead(200, { "content-type": getContentType(safePath) });
    response.end(data);
  } catch {
    const indexPath = path.join(FRONTEND_DIST_DIR, "index.html");
    const data = await fs.readFile(indexPath);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(data);
  }
}

function openUrl(url) {
  const spawnAndIgnoreErrors = (command, args) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  };

  if (process.platform === "darwin") {
    spawnAndIgnoreErrors("open", [url]);
    return;
  }

  if (process.platform === "win32") {
    spawnAndIgnoreErrors("cmd", ["/c", "start", "", url]);
    return;
  }

  spawnAndIgnoreErrors("xdg-open", [url]);
}

export async function startDashboardServer(options = {}) {
  const storeOptions = { ...options };
  let store = new CodexSessionStore(storeOptions);
  const apiOnly = options.apiOnly === true;

  if (!apiOnly) {
    await ensureStaticAssets();
  }

  const port = Number(options.port ?? 4588);

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/api/health") {
        json(response, 200, { ok: true, apiOnly });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/config") {
        const config = await store.inspectCodexHome();
        json(response, 200, { config });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/config") {
        const body = await readJsonBody(request);
        const nextStore = new CodexSessionStore({
          ...storeOptions,
          codexHome: body.codexHome,
          dbPath: body.dbPath
        });
        const config = await nextStore.inspectCodexHome();
        store = nextStore;
        json(response, 200, { config });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/providers") {
        const providers = await store.getProviders();
        json(response, 200, { providers });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/prepare-backup") {
        const preparation = await store.prepareBackup();
        json(response, 200, preparation);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/sessions") {
        const sessions = await store.listSessions({
          provider: url.searchParams.get("provider") ?? "",
          search: url.searchParams.get("search") ?? "",
          limit: url.searchParams.get("limit") ?? "100"
        });
        json(response, 200, { sessions });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/sessions/batch/retarget") {
        const body = await readJsonBody(request);
        const result = await store.batchRetargetSessions(body.threadIds, body.modelProvider);
        json(response, 200, { result });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/sessions/export/archive") {
        const body = await readJsonBody(request);
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-sessions-export-download-"));
        const archivePath = path.join(tempDir, "sessions-export.tgz");

        try {
          const result = await store.exportSessions(body.threadIds, archivePath);
          const archiveBuffer = await fs.readFile(result.archivePath);
          const filename = path.basename(result.archivePath);

          response.writeHead(200, {
            "content-type": "application/gzip",
            "x-codex-download-name": filename
          });
          response.end(archiveBuffer);
        } finally {
          await fs.rm(tempDir, { recursive: true, force: true });
        }
        return;
      }

      const detailMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (request.method === "GET" && detailMatch) {
        const session = await store.getSession(detailMatch[1]);
        json(response, 200, { session });
        return;
      }

      const cloneMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/clone$/);
      if (request.method === "POST" && cloneMatch) {
        const body = await readJsonBody(request);
        const result = await store.cloneSession(cloneMatch[1], body.modelProvider);
        json(response, 200, { result });
        return;
      }

      const exportMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/export$/);
      if (request.method === "POST" && exportMatch) {
        const body = await readJsonBody(request);
        const result = await store.exportSession(exportMatch[1], body.outputPath);
        json(response, 200, { result });
        return;
      }

      const exportDownloadMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/export\/download$/);
      if (request.method === "POST" && exportDownloadMatch) {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-sessions-export-download-"));
        const safeThreadId = exportDownloadMatch[1].replace(/[^a-zA-Z0-9._-]/g, "_");
        const archivePath = path.join(tempDir, `session-${safeThreadId}.tgz`);

        try {
          const result = await store.exportSession(exportDownloadMatch[1], archivePath);
          const archiveBuffer = await fs.readFile(result.archivePath);
          const filename = path.basename(result.archivePath);

          response.writeHead(200, {
            "content-type": "application/gzip",
            "x-codex-download-name": filename
          });
          response.end(archiveBuffer);
        } finally {
          await fs.rm(tempDir, { recursive: true, force: true });
        }
        return;
      }

      const retargetMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/retarget$/);
      if (request.method === "POST" && retargetMatch) {
        const body = await readJsonBody(request);
        const result = await store.retargetSession(retargetMatch[1], body.modelProvider);
        json(response, 200, { result });
        return;
      }

      const deleteMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (request.method === "DELETE" && deleteMatch) {
        const result = await store.deleteSession(deleteMatch[1]);
        json(response, 200, { result });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/backup") {
        const backup = await store.backupSnapshot();
        json(response, 200, { backupPath: backup.snapshotDir, backup });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/import") {
        const body = await readJsonBody(request);
        const result = await store.importSession(body.inputPath, {
          force: body.force === true
        });
        json(response, 200, { result });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/import/archive") {
        const archiveBuffer = await readRequestBodyBuffer(request);
        if (archiveBuffer.length === 0) {
          throw new Error("Import archive payload is empty.");
        }

        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-sessions-upload-"));
        const uploadName = request.headers["x-codex-upload-name"];
        const forceHeader = request.headers["x-codex-import-force"];
        const normalizedForceHeader = Array.isArray(forceHeader) ? forceHeader[0] : forceHeader;
        const decodedName =
          typeof uploadName === "string" && uploadName
            ? decodeURIComponent(uploadName)
            : "session-import.tgz";
        const archivePath = path.join(tempDir, path.basename(decodedName || "session-import.tgz"));
        const force =
          typeof normalizedForceHeader === "string" &&
          /^(1|true|yes|on)$/i.test(normalizedForceHeader.trim());

        try {
          await fs.writeFile(archivePath, archiveBuffer);
          const result = await store.importSession(archivePath, { force });
          json(response, 200, { result });
        } finally {
          await fs.rm(tempDir, { recursive: true, force: true });
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/import/archive/batch") {
        const archiveBuffer = await readRequestBodyBuffer(request);
        if (archiveBuffer.length === 0) {
          throw new Error("Import archive payload is empty.");
        }

        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-sessions-upload-"));
        const uploadName = request.headers["x-codex-upload-name"];
        const forceHeader = request.headers["x-codex-import-force"];
        const normalizedForceHeader = Array.isArray(forceHeader) ? forceHeader[0] : forceHeader;
        const decodedName =
          typeof uploadName === "string" && uploadName
            ? decodeURIComponent(uploadName)
            : "sessions-import.tgz";
        const archivePath = path.join(tempDir, path.basename(decodedName || "sessions-import.tgz"));
        const force =
          typeof normalizedForceHeader === "string" &&
          /^(1|true|yes|on)$/i.test(normalizedForceHeader.trim());

        try {
          await fs.writeFile(archivePath, archiveBuffer);
          const result = await store.importSessions(archivePath, { force });
          json(response, 200, { result });
        } finally {
          await fs.rm(tempDir, { recursive: true, force: true });
        }
        return;
      }

      if (apiOnly) {
        json(response, 404, { error: "Static dashboard is disabled in API-only mode." });
        return;
      }

      await serveStatic(request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(response, 500, { error: message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const url = `http://127.0.0.1:${port}`;
  if (!apiOnly && options.open !== false) {
    openUrl(url);
  }

  return { server, url, apiOnly };
}
