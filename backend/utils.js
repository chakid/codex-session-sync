import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function expandHome(inputPath) {
  if (!inputPath) {
    return inputPath;
  }

  if (inputPath === "~") {
    return os.homedir();
  }

  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return inputPath;
}

export function resolveCodexHome(codexHome) {
  return path.resolve(expandHome(codexHome ?? "~/.codex"));
}

export function resolveDbPath({ codexHome, dbPath }) {
  return path.resolve(expandHome(dbPath ?? path.join(resolveCodexHome(codexHome), "state_5.sqlite")));
}

export function getBackupDir(codexHome) {
  return path.join(resolveCodexHome(codexHome), "backups", "codex-sessions");
}

export function formatTimestamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");
}

export function currentUnixTime() {
  return Math.floor(Date.now() / 1000);
}

export function createThreadId() {
  return crypto.randomUUID();
}

export function formatDateParts(date = new Date()) {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return { year, month, day };
}

export function buildRolloutPath(codexHome, threadId, date = new Date()) {
  const { year, month, day } = formatDateParts(date);
  const timestamp = formatTimestamp(date);
  return path.join(
    resolveCodexHome(codexHome),
    "sessions",
    year,
    month,
    day,
    `rollout-${timestamp}-${threadId}.jsonl`
  );
}

export async function ensureFile(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Missing file: ${filePath}`);
  }
}

export async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export function toBoolean(value) {
  return value === 1 || value === true;
}

export function toNullableString(value) {
  return value == null ? null : String(value);
}

export function formatThreadSummary(thread) {
  return [
    thread.id,
    thread.model_provider,
    thread.model ?? "-",
    toIsoDate(thread.updated_at),
    thread.title
  ].join(" | ");
}

export function toEpochMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}

export function toIsoDate(value) {
  return new Date(toEpochMs(value)).toISOString();
}
