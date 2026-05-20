import { CodexSessionStore } from "./store.js";
import { startDashboardServer } from "./server.js";
import { formatThreadSummary } from "./utils.js";

function parseArgs(argv) {
  const [command = "dashboard", ...rest] = argv;
  const flags = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = "true";
    } else {
      flags[key] = next;
      index += 1;
    }
  }

  return { command, flags };
}

function printHelp() {
  console.log(`codex-sessions

Commands:
  codex-sessions dashboard [--port 4588] [--no-open] [--codex-home ~/.codex]
  codex-sessions prepare-backup
  codex-sessions list [--provider crs] [--search keyword] [--limit 50]
  codex-sessions export --thread <id> [--out <archive.tgz>]
  codex-sessions import --from <archive.tgz>
  codex-sessions clone --thread <id> --to <provider>
  codex-sessions retarget --thread <id> --to <provider>
  codex-sessions delete --thread <id>
  codex-sessions backup
`);
}

export async function runCli(argv) {
  const { command, flags } = parseArgs(argv);
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const store = new CodexSessionStore({
    codexHome: flags["codex-home"],
    dbPath: flags["db-path"]
  });

  if (command === "dashboard") {
    const { url } = await startDashboardServer({
      codexHome: flags["codex-home"],
      dbPath: flags["db-path"],
      port: Number(flags.port ?? 4588),
      open: flags["no-open"] !== "true"
    });
    console.log(`Dashboard running at ${url}`);
    return;
  }

  if (command === "list") {
    const sessions = await store.listSessions({
      provider: flags.provider,
      search: flags.search,
      limit: flags.limit
    });
    for (const session of sessions) {
      console.log(formatThreadSummary(session));
    }
    return;
  }

  if (command === "prepare-backup") {
    const result = await store.prepareBackup();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "clone") {
    const threadId = flags.thread;
    const targetProvider = flags.to;
    if (!threadId || !targetProvider) {
      throw new Error("`clone` requires --thread and --to.");
    }

    const result = await store.cloneSession(threadId, targetProvider);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "export") {
    const threadId = flags.thread;
    if (!threadId) {
      throw new Error("`export` requires --thread.");
    }

    const result = await store.exportSession(threadId, flags.out);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "import") {
    const inputPath = flags.from;
    if (!inputPath) {
      throw new Error("`import` requires --from.");
    }

    const result = await store.importSession(inputPath);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "retarget") {
    const threadId = flags.thread;
    const targetProvider = flags.to;
    if (!threadId || !targetProvider) {
      throw new Error("`retarget` requires --thread and --to.");
    }

    const result = await store.retargetSession(threadId, targetProvider);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "delete") {
    const threadId = flags.thread;
    if (!threadId) {
      throw new Error("`delete` requires --thread.");
    }

    const result = await store.deleteSession(threadId);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "backup") {
    const backup = await store.backupSnapshot();
    console.log(JSON.stringify(backup, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}
