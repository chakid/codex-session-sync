import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startDashboardServer } from "./server.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viteBin = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
const uiPort = 4173;
const apiPort = 4588;

const { server } = await startDashboardServer({
  apiOnly: true,
  open: false,
  port: apiPort
});

const vite = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(uiPort)], {
  cwd: projectRoot,
  stdio: "inherit",
  env: process.env
});

function shutdown(exitCode = 0) {
  server.close();
  if (!vite.killed) {
    vite.kill("SIGINT");
  }
  process.exit(exitCode);
}

vite.on("exit", (code) => {
  shutdown(code ?? 0);
});

vite.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  shutdown(1);
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(`Dev UI:  http://127.0.0.1:${uiPort}`);
console.log(`Dev API: http://127.0.0.1:${apiPort}`);
