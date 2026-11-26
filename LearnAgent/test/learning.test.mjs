import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, SUBJECTS } from "../server/db.mjs";
import {
  createAssessment, getAssessment, submitAssessment, savePlan, getActivePlan,
  createHomework, getHomework, submitHomework, getErrorLog, recordErrorReview,
} from "../server/learning.mjs";

function seed() {
  const db = openDb(":memory:");
  const ins = db.prepare(`INSERT INTO problems (id, source, subject, level, problem_latex, solution_latex, answer, answer_kind, pool)
    VALUES (?, 'T', ?, ?, ?, ?, ?, 'numeric', ?)`);
  let n = 0;
  for (const pool of ["assessment", "practice"])
    for (const s of SUBJECTS)
      for (let level = 1; level <= 5; level++)
        for (let k = 0; k < 6; k++) { n++; ins.run(`P${n}`, s, level, `What is ${n}?`, `\\boxed{${n}}`, String(n), pool); }
  return db;
}

test("assessment hides answers until submitted, then scores AMC-style", () => {
  const db = seed();
  const id = createAssessment(db, "quick");
  const before = getAssessment(db, id, { includeSolutions: true });
  assert.equal(before.items.length, 10);
  assert.ok(before.items.every((i) => i.answer === undefined && i.solution === undefined));

  const answers = {};
  const [first, second] = before.items;
  answers[first.problem_id] = { answer: first.problem.match(/\d+/)[0] }; // correct
  answers[second.problem_id] = { answer: "-1" }; // wrong; the rest blank
  const after = submitAssessment(db, id, answers);
  assert.equal(after.score, 6 + 0 + 8 * 1.5);
  assert.ok(after.items.every((i) => i.answer !== undefined));
});

test("tests never reuse problems and only use the assessment pool", () => {
  const db = seed();
  const a = getAssessment(db, createAssessment(db, "full"));
  const b = getAssessment(db, createAssessment(db, "full"));
  const ids = [...a.items, ...b.items].map((i) => i.problem_id);
  assert.equal(new Set(ids).size, ids.length);
  const pools = db.prepare(`SELECT DISTINCT pool FROM problems WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids);
  assert.deepEqual(pools.map((p) => p.pool), ["assessment"]);
});

test("plan validation rejects bad items and supersedes the previous plan", () => {
  const db = seed();
  assert.throws(() => savePlan(db, { summary: "x", weeks: [{ week: 1, items: [{ day: 1, type: "nap", topic: "t" }] }] }), /Invalid item type/);
  savePlan(db, { summary: "first", weeks: [{ week: 1, items: [{ day: 1, type: "lesson", subject: "Algebra", topic: "Linear equations" }] }] });
  savePlan(db, { summary: "second", weeks: [{ week: 2, items: [{ day: 3, type: "homework", subject: "Geometry", topic: "Similar triangles" }] }] });
  const plan = getActivePlan(db);
  assert.equal(plan.summary, "second");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM plans WHERE status = 'active'").get().n, 1);
});

test("homework uses unseen practice problems and marks its plan item done", () => {
  const db = seed();
  savePlan(db, { summary: "p", weeks: [{ week: 1, items: [{ day: 1, type: "homework", subject: "Number Theory", topic: "Remainders" }] }] });
  const item = getActivePlan(db).items[0];
  const hwId = createHomework(db, { subject: "Number Theory", topic: "Remainders", count: 4, plan_item_id: item.id });
  const hw = getHomework(db, hwId);
  assert.equal(hw.items.length, 4);
  const answers = Object.fromEntries(hw.items.map((i) => [i.problem_id, { answer: i.problem.match(/\d+/)[0] }]));
  const done = submitHomework(db, hwId, answers);
  assert.equal(done.score, 1);
  assert.equal(getActivePlan(db).items[0].status, "done");
});

test("error log keeps missed test problems until re-solved", () => {
  const db = seed();
  const t = getAssessment(db, createAssessment(db, "quick"));
  const [miss] = t.items;
  submitAssessment(db, t.id, { [miss.problem_id]: { answer: "-1" } });
  const entry = getErrorLog(db, { subject: miss.subject }).find((e) => e.problem_id === miss.problem_id);
  assert.equal(entry.learner_answer, "-1");

  recordErrorReview(db, miss.problem_id, false);
  assert.equal(getErrorLog(db, { limit: 20 }).find((e) => e.problem_id === miss.problem_id).review_count, 1);
  recordErrorReview(db, miss.problem_id, true);
  assert.ok(!getErrorLog(db, { limit: 20 }).some((e) => e.problem_id === miss.problem_id));
  assert.throws(() => recordErrorReview(db, "nope", true), /not in the error log/);
});
