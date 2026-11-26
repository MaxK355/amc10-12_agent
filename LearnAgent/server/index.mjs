import express from "express";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, SUBJECTS } from "./db.mjs";
import {
  createAssessment, getAssessment, submitAssessment, subjectBreakdown,
  getHomework, submitHomework, dashboard, getActivePlan, createHomework,
} from "./learning.mjs";
import { Tutor } from "./tutor.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 3000);

const db = openDb();
if (db.prepare("SELECT COUNT(*) n FROM problems").get().n === 0) {
  console.error("Problem bank is empty. Run: npm run ingest");
  process.exit(1);
}
const tutor = new Tutor(db);
await tutor.start();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(join(ROOT, "public")));
app.use("/vendor/katex", express.static(join(ROOT, "node_modules", "katex", "dist")));
app.use("/vendor/marked", express.static(join(ROOT, "node_modules", "marked", "lib")));

const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out !== undefined) res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};
const id = (req) => Number(req.params.id);

app.get("/api/dashboard", wrap(() => dashboard(db)));

app.post("/api/tests", wrap((req) => ({ id: createAssessment(db, req.body?.kind ?? "full") })));
app.get("/api/tests/:id", wrap((req, res) => {
  const a = getAssessment(db, id(req), { includeSolutions: true });
  if (!a) return res.status(404).json({ error: "Not found" });
  return { ...a, by_subject: a.submitted_at ? subjectBreakdown(a) : undefined };
}));
app.post("/api/tests/:id/submit", wrap((req) => {
  const a = submitAssessment(db, id(req), req.body?.answers ?? {});
  return { ...a, by_subject: subjectBreakdown(a) };
}));

app.get("/api/plan", wrap(() => getActivePlan(db)));
app.post("/api/plan/items/:id/done", wrap((req) => {
  db.prepare("UPDATE plan_items SET status = 'done' WHERE id = ?").run(id(req));
  return { ok: true };
}));
app.post("/api/plan/items/:id/homework", wrap((req) => {
  const item = db.prepare("SELECT * FROM plan_items WHERE id = ?").get(id(req));
  if (!item) throw new Error("Plan item not found");
  const existing = db.prepare("SELECT id FROM homework WHERE plan_item_id = ? ORDER BY id DESC LIMIT 1").get(item.id);
  if (existing) return { id: existing.id };
  const subject = SUBJECTS.includes(item.subject) ? item.subject : SUBJECTS[Math.floor(Math.random() * SUBJECTS.length)];
  return { id: createHomework(db, { subject, topic: item.topic, count: 5, level_min: 2, level_max: 4, plan_item_id: item.id }) };
}));

app.get("/api/homework/:id", wrap((req, res) => getHomework(db, id(req), { includeSolutions: true }) ?? res.status(404).json({ error: "Not found" })));
app.post("/api/homework/:id/submit", wrap((req) => submitHomework(db, id(req), req.body?.answers ?? {})));

app.post("/api/chats", wrap((req) => tutor.startChat(req.body?.mode, Number(req.body?.refId), { fresh: !!req.body?.fresh })));
app.get("/api/chats/:id", wrap((req, res) => tutor.getChat(id(req)) ?? res.status(404).json({ error: "Not found" })));

// Streams the tutor's reply as Server-Sent Events.
app.post("/api/chats/:id/messages", async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "Empty message" });
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const emit = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  try {
    await tutor.send(id(req), text, emit);
    emit({ type: "done" });
  } catch (e) {
    emit({ type: "error", message: e.message });
  }
  res.end();
});

const server = app.listen(PORT, () => console.log(`AMC 10 Learning Agent running at http://localhost:${PORT}`));

async function shutdown() {
  server.close();
  await tutor.stop().catch(() => {});
  db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
