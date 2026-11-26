// End-to-end smoke test against a running server: test -> review chat -> plan -> lesson -> homework.
// Usage: node scripts/e2e.mjs [baseUrl]
const BASE = process.argv[2] ?? "http://localhost:3100";

async function api(path, body) {
  const res = await fetch(BASE + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await res.json();
  if (!res.ok) throw new Error(`${path}: ${data.error}`);
  return data;
}

async function chat(chatId, text) {
  const res = await fetch(`${BASE}/api/chats/${chatId}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  const raw = await res.text();
  const events = raw.split("\n\n").filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, "")));
  const tools = events.filter((e) => e.type === "tool").map((e) => e.name);
  const messages = events.filter((e) => e.type === "message").map((e) => e.text);
  const err = events.find((e) => e.type === "error");
  if (err) throw new Error(err.message);
  console.log(`  tools: ${tools.join(", ") || "(none)"}`);
  console.log(`  reply: ${messages.join(" | ").slice(0, 400).replace(/\n/g, " ")}...`);
  return { tools, messages };
}

console.log("1. Quick test");
const { id: testId } = await api("/api/tests", { kind: "quick" });
const t = await api(`/api/tests/${testId}`);
console.log(`  test #${testId}: ${t.items.length} problems, answers hidden: ${t.items.every((i) => i.answer === undefined)}`);
const answers = {};
t.items.slice(0, 6).forEach((i, k) => (answers[i.problem_id] = { answer: k % 2 ? "7" : "1", timeSec: 60 }));
const result = await api(`/api/tests/${testId}/submit`, { answers });
console.log(`  score: ${result.score}/60`);

console.log("2. Review chat -> study plan");
const review = await api("/api/chats", { mode: "review", refId: testId });
await chat(review.id, review.kickoff);
const r2 = await chat(review.id, "I mostly guessed on the ones I got wrong. Please skip further questions and create my 4-week study plan now.");
const plan = await api("/api/plan");
if (!plan) throw new Error("No plan was created");
console.log(`  plan #${plan.id}: ${plan.items.length} items; tool used: ${r2.tools.includes("propose_study_plan")}`);

console.log("3. Lesson chat");
const lessonItem = plan.items.find((i) => i.type === "lesson");
const lesson = await api("/api/chats", { mode: "lesson", refId: lessonItem.id });
await chat(lesson.id, lesson.kickoff);
await chat(lesson.id, "Thanks, I understand. Please assign my homework now.");
const dash = await api("/api/dashboard");
const hw = dash.homework[0];
if (!hw) throw new Error("No homework was assigned");
console.log(`  homework #${hw.id}: ${hw.topic}`);

console.log("4. Homework submit");
const h = await api(`/api/homework/${hw.id}`);
const hwAnswers = Object.fromEntries(h.items.map((i) => [i.problem_id, { answer: "2" }]));
const done = await api(`/api/homework/${hw.id}/submit`, { answers: hwAnswers });
console.log(`  homework score: ${Math.round(done.score * 100)}%`);
console.log("E2E OK");
