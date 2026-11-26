// Wipe learner progress (tests, plans, homework, chats) but keep the problem bank.
// A backup snapshot of the DB is written next to it first.
import { DB_PATH, openDb } from "../server/db.mjs";

const backup = DB_PATH.replace(/\.db$/, "") + `-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.db`;
const db = openDb(DB_PATH);
// VACUUM INTO includes changes still in the WAL file, unlike a plain file copy.
db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
const tables = ["chat_messages", "chats", "homework_items", "homework", "plan_items", "plans",
  "error_log", "diagnoses", "exposures", "attempts", "assessment_items", "assessments"];
db.exec("PRAGMA foreign_keys = OFF; BEGIN;");
for (const t of tables) db.exec(`DELETE FROM ${t};`);
db.exec(`DELETE FROM sqlite_sequence WHERE name IN (${tables.map((t) => `'${t}'`).join(",")}); COMMIT; PRAGMA foreign_keys = ON;`);
const left = db.prepare("SELECT COUNT(*) n FROM problems").get().n;
console.log(`Progress cleared. Problems kept: ${left}. Backup: ${backup}`);
