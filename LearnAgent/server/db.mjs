import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DB_PATH = process.env.LEARN_DB ?? join(ROOT, "data", "learn.db");

export const SUBJECTS = ["Prealgebra", "Algebra", "Counting & Probability", "Number Theory", "Geometry"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS problems (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_ref TEXT,
  subject TEXT NOT NULL,
  level INTEGER NOT NULL,
  problem_latex TEXT NOT NULL,
  solution_latex TEXT NOT NULL,
  answer TEXT NOT NULL,
  answer_kind TEXT NOT NULL,          -- numeric | expression
  has_diagram INTEGER NOT NULL DEFAULT 0,
  pool TEXT NOT NULL                  -- assessment | practice
);
CREATE INDEX IF NOT EXISTS idx_problems_pool ON problems(pool, subject, level);

CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                 -- full | quick
  duration_min INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  score REAL
);
CREATE TABLE IF NOT EXISTS assessment_items (
  assessment_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  problem_id TEXT NOT NULL,
  PRIMARY KEY (assessment_id, position)
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id TEXT NOT NULL,
  context TEXT NOT NULL,              -- test | homework
  context_id INTEGER NOT NULL,
  answer TEXT,
  correct INTEGER,                    -- 1, 0, NULL (blank)
  time_sec INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attempts_ctx ON attempts(context, context_id);

CREATE TABLE IF NOT EXISTS exposures (
  problem_id TEXT PRIMARY KEY,
  context TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS diagnoses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER,
  problem_id TEXT NOT NULL,
  cause TEXT NOT NULL,                -- concept | strategy | execution | timing | uncertain
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS error_log (
  problem_id TEXT PRIMARY KEY,
  cause TEXT,
  next_review_at TEXT NOT NULL,
  review_count INTEGER NOT NULL DEFAULT 0,
  resolved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER,
  start_date TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | superseded
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS plan_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL,
  week INTEGER NOT NULL,
  day INTEGER NOT NULL,
  date TEXT NOT NULL,
  type TEXT NOT NULL,                 -- lesson | homework | review | checkin | test
  subject TEXT,
  topic TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo' -- todo | done
);

CREATE TABLE IF NOT EXISTS homework (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_item_id INTEGER,
  subject TEXT NOT NULL,
  topic TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  score REAL
);
CREATE TABLE IF NOT EXISTS homework_items (
  homework_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  problem_id TEXT NOT NULL,
  PRIMARY KEY (homework_id, position)
);

CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,                 -- review | lesson | homework_review | topic_review
  ref_id INTEGER,
  title TEXT NOT NULL,
  sdk_session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  role TEXT NOT NULL,                 -- user | assistant | tool
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function openDb(path = DB_PATH) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
