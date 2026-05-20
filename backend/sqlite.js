import fs from "node:fs/promises";
import path from "node:path";
import initSqlJs from "sql.js";
import { __dirname } from "./utils.js";

let sqlPromise;

export async function getSqlJs() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: (file) => path.join(__dirname, "..", "node_modules", "sql.js", "dist", file)
    });
  }

  return sqlPromise;
}

export async function loadDatabase(dbPath) {
  const SQL = await getSqlJs();
  const buffer = await fs.readFile(dbPath);
  return new SQL.Database(new Uint8Array(buffer));
}

export function selectAll(db, sql, params = {}) {
  const statement = db.prepare(sql);
  statement.bind(params);

  const rows = [];
  while (statement.step()) {
    rows.push(statement.getAsObject());
  }

  statement.free();
  return rows;
}

export function selectOne(db, sql, params = {}) {
  return selectAll(db, sql, params)[0] ?? null;
}

