// Offline import: MATH dataset (Hendrycks et al.) parquet -> SQLite problem bank.
// Usage: node ingest/import-math.mjs
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parquetReadObjects } from "hyparquet";
import { openDb, tx, SUBJECTS } from "../server/db.mjs";
import { extractBoxed, answerKind } from "../server/grade.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw", "competition_math.parquet");
const URL = "https://huggingface.co/datasets/qwedsacf/competition_math/resolve/main/data/train-00000-of-00001-7320a6f3aba8ebd2.parquet";
const ASSESSMENT_SHARE = 30; // percent of eligible problems reserved for tests

async function ensureRaw() {
  if (existsSync(RAW)) return;
  mkdirSync(dirname(RAW), { recursive: true });
  console.log("Downloading MATH dataset...");
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  writeFileSync(RAW, Buffer.from(await res.arrayBuffer()));
}

function bucket(id) {
  return parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16) % 100;
}

await ensureRaw();
const buf = readFileSync(RAW);
const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const rows = await parquetReadObjects({ file });
console.log(`Read ${rows.length} rows`);

const stats = { kept: 0, noAnswer: 0, excluded: 0, duplicate: 0, assessment: 0, practice: 0 };
const seen = new Set();
const records = [];
rows.forEach((r, idx) => {
  const level = parseInt(String(r.level).replace(/\D/g, ""), 10);
  const isCore = SUBJECTS.includes(r.type);
  const isStretch = r.type === "Intermediate Algebra" && level <= 3;
  if (!(isCore || isStretch) || !level) return stats.excluded++;
  const answer = extractBoxed(r.solution);
  if (!answer) return stats.noAnswer++;
  const key = r.problem.replace(/\s+/g, " ").trim();
  if (seen.has(key)) return stats.duplicate++;
  seen.add(key);

  const id = "MATH-" + createHash("sha1").update(key).digest("hex").slice(0, 10);
  const hasDiagram = /\[asy\]/.test(r.problem) ? 1 : 0;
  const kind = answerKind(answer);
  const eligibleForTest = isCore && !hasDiagram && kind === "numeric";
  const pool = eligibleForTest && bucket(id) < ASSESSMENT_SHARE ? "assessment" : "practice";
  stats[pool]++;
  stats.kept++;
  records.push({ id, ref: `row ${idx}`, subject: r.type, level, problem: r.problem, solution: r.solution, answer, kind, hasDiagram, pool });
});

const db = openDb();
const insert = db.prepare(`INSERT OR REPLACE INTO problems
  (id, source, source_ref, subject, level, problem_latex, solution_latex, answer, answer_kind, has_diagram, pool)
  VALUES (?, 'MATH', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
tx(db, () => {
  for (const p of records) insert.run(p.id, p.ref, p.subject, p.level, p.problem, p.solution, p.answer, p.kind, p.hasDiagram, p.pool);
});

console.log(stats);
const summary = db.prepare(`SELECT pool, subject, COUNT(*) n FROM problems GROUP BY pool, subject ORDER BY pool, subject`).all();
console.table(summary);
db.close();
