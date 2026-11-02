#!/usr/bin/env node
// Runs one SQL file against the staging project only. Refuses unless STAGING_DB_URL belongs to
// STAGING_PROJECT_REF and that ref is not production. Never prints the connection string.
//
//   STAGING_PROJECT_REF=<ref> STAGING_DB_URL=… node scripts/staging-sql.mjs <file.sql>
import { readFileSync } from "node:fs";
import pg from "pg";

const PRODUCTION_REFS = new Set(["rbghfpwbwmrjbpjswbbn"]);
const ref = (process.env.STAGING_PROJECT_REF ?? "").trim();
const url = (process.env.STAGING_DB_URL ?? "").trim();
const file = process.argv[2];
if (!file) throw new Error("usage: node scripts/staging-sql.mjs <file.sql>");
if (!ref || PRODUCTION_REFS.has(ref)) throw new Error("refused: STAGING_PROJECT_REF is missing or is production");
if (!url.includes(ref) || [...PRODUCTION_REFS].some((p) => url.includes(p))) throw new Error("refused: STAGING_DB_URL is not the staging project");

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query(readFileSync(file, "utf8"));
  console.log(`applied ${file} to ${ref}`);
} catch (err) {
  console.log(`failed ${file} on ${ref}: ${err.code ?? ""} ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
