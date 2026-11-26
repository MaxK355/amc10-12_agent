// Deterministic learning services: test assembly, scoring, skills, plans, homework.
import { SUBJECTS, tx } from "./db.mjs";
import { isEquivalent } from "./grade.mjs";

// Positions -> MATH level range, mirroring AMC 10 difficulty progression.
const FULL_BLUEPRINT = [
  ...Array(5).fill([1, 2]),
  ...Array(7).fill([2, 3]),
  ...Array(7).fill([3, 4]),
  ...Array(6).fill([4, 5]),
];
const QUICK_BLUEPRINT = [[1, 2], [1, 2], [2, 3], [2, 3], [3, 3], [3, 4], [3, 4], [4, 4], [4, 5], [5, 5]];

// Approximate AMC 10 topic mix (Algebra includes Prealgebra).
const TOPIC_MIX = { Algebra: 6, Prealgebra: 3, Geometry: 6, "Counting & Probability": 5, "Number Theory": 5 };

export const TEST_KINDS = {
  full: { blueprint: FULL_BLUEPRINT, minutes: 75 },
  quick: { blueprint: QUICK_BLUEPRINT, minutes: 30 },
};

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function subjectSequence(n) {
  const seq = [];
  for (const [s, k] of Object.entries(TOPIC_MIX)) for (let i = 0; i < k; i++) seq.push(s);
  shuffle(seq);
  while (seq.length < n) seq.push(...shuffle(Object.keys(TOPIC_MIX)));
  return seq.slice(0, n);
}

function markExposed(db, problemIds, context) {
  const st = db.prepare("INSERT OR IGNORE INTO exposures (problem_id, context) VALUES (?, ?)");
  for (const id of problemIds) st.run(id, context);
}

export function stripAsy(latex) {
  return latex.replace(/\[asy\][\s\S]*?\[\/asy\]/g, "\n*(diagram omitted)*\n");
}

/** Creates a new simulated test from unseen assessment-pool problems. */
export function createAssessment(db, kind = "full") {
  const cfg = TEST_KINDS[kind];
  if (!cfg) throw new Error(`Unknown test kind: ${kind}`);
  const subjects = subjectSequence(cfg.blueprint.length);
  const pick = db.prepare(`SELECT id FROM problems
    WHERE pool = 'assessment' AND subject = ? AND level BETWEEN ? AND ?
      AND id NOT IN (SELECT problem_id FROM exposures)
    ORDER BY random() LIMIT 1`);
  const anySubject = db.prepare(`SELECT id FROM problems
    WHERE pool = 'assessment' AND level BETWEEN ? AND ?
      AND id NOT IN (SELECT problem_id FROM exposures)
    ORDER BY random() LIMIT 1`);
  return tx(db, () => {
    const { lastInsertRowid } = db.prepare("INSERT INTO assessments (kind, duration_min) VALUES (?, ?)").run(kind, cfg.minutes);
    const id = Number(lastInsertRowid);
    const chosen = [];
    cfg.blueprint.forEach(([lo, hi], i) => {
      const row = pick.get(subjects[i], lo, hi) ?? anySubject.get(lo, hi);
      if (!row) throw new Error("Assessment pool exhausted for this difficulty");
      chosen.push(row.id);
      markExposed(db, [row.id], "test");
      db.prepare("INSERT INTO assessment_items (assessment_id, position, problem_id) VALUES (?, ?, ?)").run(id, i + 1, row.id);
    });
    return id;
  });
}

export function getAssessment(db, id, { includeSolutions = false } = {}) {
  const a = db.prepare("SELECT * FROM assessments WHERE id = ?").get(id);
  if (!a) return null;
  const submitted = !!a.submitted_at;
  const items = db.prepare(`SELECT ai.position, p.id, p.subject, p.level, p.problem_latex, p.solution_latex, p.answer,
      at.answer AS given, at.correct, at.time_sec, at.id AS attempt_id
    FROM assessment_items ai JOIN problems p ON p.id = ai.problem_id
    LEFT JOIN attempts at ON at.context = 'test' AND at.context_id = ai.assessment_id AND at.problem_id = p.id
    WHERE ai.assessment_id = ? ORDER BY ai.position`).all(id);
  const reveal = submitted && includeSolutions;
  return {
    ...a,
    items: items.map((r) => ({
      position: r.position,
      problem_id: r.id,
      subject: r.subject,
      level: r.level,
      problem: stripAsy(r.problem_latex),
      ...(submitted ? { given: r.given, correct: r.correct, time_sec: r.time_sec, attempt_id: r.attempt_id } : {}),
      ...(reveal ? { answer: r.answer, solution: stripAsy(r.solution_latex) } : {}),
    })),
  };
}

/** AMC scoring: +6 correct, +1.5 blank, 0 wrong. */
export function submitAssessment(db, id, answers) {
  const a = db.prepare("SELECT * FROM assessments WHERE id = ?").get(id);
  if (!a) throw new Error("Not found");
  if (a.submitted_at) return getAssessment(db, id, { includeSolutions: true });
  const items = db.prepare(`SELECT p.id, p.answer, p.subject FROM assessment_items ai
    JOIN problems p ON p.id = ai.problem_id WHERE ai.assessment_id = ?`).all(id);
  tx(db, () => {
    let score = 0;
    const ins = db.prepare("INSERT INTO attempts (problem_id, context, context_id, answer, correct, time_sec) VALUES (?, 'test', ?, ?, ?, ?)");
    for (const it of items) {
      const given = (answers?.[it.id]?.answer ?? "").trim();
      const time = Math.round(answers?.[it.id]?.timeSec ?? 0);
      const correct = given === "" ? null : isEquivalent(given, it.answer) ? 1 : 0;
      score += correct === 1 ? 6 : correct === null ? 1.5 : 0;
      ins.run(it.id, id, given || null, correct, time);
      if (correct !== 1) logError(db, it.id);
    }
    db.prepare("UPDATE assessments SET submitted_at = datetime('now'), score = ? WHERE id = ?").run(score, id);
  });
  return getAssessment(db, id, { includeSolutions: true });
}

function logError(db, problemId, cause = null) {
  db.prepare(`INSERT INTO error_log (problem_id, cause, next_review_at) VALUES (?, ?, date('now', '+3 days'))
    ON CONFLICT(problem_id) DO UPDATE SET cause = COALESCE(excluded.cause, cause), resolved = 0`).run(problemId, cause);
}

/** Unresolved past mistakes (optionally for one subject), soonest-due first, with the learner's answer and diagnosis. */
export function getErrorLog(db, { subject = null, limit = 10 } = {}) {
  return db.prepare(`SELECT e.problem_id, e.cause, e.next_review_at, e.review_count,
      p.subject, p.level, p.problem_latex AS problem, p.answer, p.solution_latex AS solution,
      (SELECT answer FROM attempts a WHERE a.problem_id = e.problem_id ORDER BY a.id DESC LIMIT 1) AS learner_answer,
      (SELECT note FROM diagnoses d WHERE d.problem_id = e.problem_id ORDER BY d.id DESC LIMIT 1) AS diagnosis_note
    FROM error_log e JOIN problems p ON p.id = e.problem_id
    WHERE e.resolved = 0 AND (? IS NULL OR p.subject = ?)
    ORDER BY e.next_review_at, p.level LIMIT ?`).all(subject, subject, limit);
}

/** Spaced review: solved without help resolves the entry; otherwise it is due again in 7 days. */
export function recordErrorReview(db, problemId, solved) {
  const r = db.prepare(`UPDATE error_log SET review_count = review_count + 1, resolved = ?,
      next_review_at = CASE WHEN ? THEN next_review_at ELSE date('now', '+7 days') END
    WHERE problem_id = ?`).run(solved ? 1 : 0, solved ? 1 : 0, problemId);
  if (!r.changes) throw new Error(`Problem ${problemId} is not in the error log`);
  return { problem_id: problemId, resolved: !!solved };
}

export function subjectBreakdown(assessment) {
  const out = {};
  for (const it of assessment.items) {
    const s = (out[it.subject] ??= { subject: it.subject, total: 0, correct: 0, wrong: 0, blank: 0 });
    s.total++;
    if (it.correct === 1) s.correct++;
    else if (it.correct === 0) s.wrong++;
    else s.blank++;
  }
  return Object.values(out);
}

/** Level-weighted mastery per subject with a weak prior (0.5). */
export function skillEstimates(db) {
  const rows = db.prepare(`SELECT p.subject, p.level, at.correct FROM attempts at
    JOIN problems p ON p.id = at.problem_id`).all();
  const est = Object.fromEntries(SUBJECTS.map((s) => [s, { subject: s, w: 1, c: 0.5, attempts: 0 }]));
  for (const r of rows) {
    const e = est[r.subject];
    if (!e) continue;
    e.w += r.level;
    e.c += r.correct === 1 ? r.level : 0;
    e.attempts++;
  }
  return Object.values(est).map((e) => ({ subject: e.subject, mastery: +(e.c / e.w).toFixed(2), attempts: e.attempts }));
}

export function recordDiagnosis(db, { problem_id, cause, note }) {
  const causes = ["concept", "strategy", "execution", "timing", "uncertain"];
  if (!causes.includes(cause)) throw new Error(`cause must be one of ${causes.join(", ")}`);
  const attempt = db.prepare("SELECT id FROM attempts WHERE problem_id = ? ORDER BY id DESC LIMIT 1").get(problem_id);
  db.prepare("INSERT INTO diagnoses (attempt_id, problem_id, cause, note) VALUES (?, ?, ?, ?)").run(attempt?.id ?? null, problem_id, cause, note ?? null);
  logError(db, problem_id, cause);
  return { ok: true };
}

const ITEM_TYPES = ["lesson", "homework", "review", "checkin", "test"];

/** Validates and saves a 4-week plan; supersedes any active plan. */
export function savePlan(db, { summary, weeks, assessment_id }) {
  if (!summary || !Array.isArray(weeks) || weeks.length < 1 || weeks.length > 5) throw new Error("Plan needs a summary and 1-5 weeks");
  const items = [];
  for (const w of weeks) {
    if (!Array.isArray(w.items) || !w.items.length) throw new Error(`Week ${w.week} has no items`);
    for (const it of w.items) {
      if (!ITEM_TYPES.includes(it.type)) throw new Error(`Invalid item type '${it.type}'. Use ${ITEM_TYPES.join(", ")}`);
      if (it.subject && !SUBJECTS.includes(it.subject) && it.subject !== "Mixed") throw new Error(`Invalid subject '${it.subject}'. Use ${SUBJECTS.join(", ")} or Mixed`);
      const day = Math.min(7, Math.max(1, Number(it.day) || 1));
      items.push({ week: Number(w.week), day, type: it.type, subject: it.subject ?? null, topic: String(it.topic ?? it.type), description: it.description ?? "" });
    }
  }
  return tx(db, () => {
    db.prepare("UPDATE plans SET status = 'superseded' WHERE status = 'active'").run();
    const { lastInsertRowid } = db.prepare("INSERT INTO plans (assessment_id, start_date, summary) VALUES (?, date('now'), ?)").run(assessment_id ?? null, summary);
    const planId = Number(lastInsertRowid);
    const ins = db.prepare(`INSERT INTO plan_items (plan_id, week, day, date, type, subject, topic, description)
      VALUES (?, ?, ?, date('now', ?), ?, ?, ?, ?)`);
    for (const it of items) ins.run(planId, it.week, it.day, `+${(it.week - 1) * 7 + it.day - 1} days`, it.type, it.subject, it.topic, it.description);
    return { plan_id: planId, items: items.length };
  });
}

export function getActivePlan(db) {
  const plan = db.prepare("SELECT * FROM plans WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
  if (!plan) return null;
  plan.items = db.prepare(`SELECT pi.*, (SELECT id FROM homework h WHERE h.plan_item_id = pi.id   ORDER BY id DESC LIMIT 1) AS homework_id,
      (SELECT id FROM chats c WHERE c.mode IN ('lesson', 'topic_review') AND c.ref_id = pi.id ORDER BY id DESC LIMIT 1) AS chat_id
    FROM plan_items pi WHERE plan_id = ? ORDER BY week, day, id`).all(plan.id);
  return plan;
}

/** Unseen practice problems for examples or homework. */
export function findPracticeProblems(db, { subject, level_min = 1, level_max = 5, count = 3, exclude = [] }) {
  const rows = db.prepare(`SELECT id, subject, level, problem_latex, solution_latex, answer FROM problems
    WHERE pool = 'practice' AND subject = ? AND level BETWEEN ? AND ? AND has_diagram = 0
      AND id NOT IN (SELECT problem_id FROM exposures)
    ORDER BY random() LIMIT ?`).all(subject, level_min, level_max, count + exclude.length);
  return rows.filter((r) => !exclude.includes(r.id)).slice(0, count);
}

export function useAsExample(db, problemId) {
  markExposed(db, [problemId], "lesson");
}

export function createHomework(db, { subject, topic, level_min = 2, level_max = 4, count = 5, plan_item_id = null }) {
  if (!SUBJECTS.includes(subject)) throw new Error(`subject must be one of ${SUBJECTS.join(", ")}`);
  count = Math.min(10, Math.max(1, count));
  const problems = findPracticeProblems(db, { subject, level_min, level_max, count });
  if (!problems.length) throw new Error("No unseen practice problems match");
  problems.sort((a, b) => a.level - b.level);
  return tx(db, () => {
    const { lastInsertRowid } = db.prepare("INSERT INTO homework (plan_item_id, subject, topic) VALUES (?, ?, ?)").run(plan_item_id, subject, topic);
    const id = Number(lastInsertRowid);
    problems.forEach((p, i) => db.prepare("INSERT INTO homework_items (homework_id, position, problem_id) VALUES (?, ?, ?)").run(id, i + 1, p.id));
    markExposed(db, problems.map((p) => p.id), "homework");
    return id;
  });
}

export function getHomework(db, id, { includeSolutions = false } = {}) {
  const h = db.prepare("SELECT * FROM homework WHERE id = ?").get(id);
  if (!h) return null;
  const submitted = !!h.submitted_at;
  const reveal = submitted && includeSolutions;
  const items = db.prepare(`SELECT hi.position, p.id, p.level, p.problem_latex, p.solution_latex, p.answer, at.answer AS given, at.correct
    FROM homework_items hi JOIN problems p ON p.id = hi.problem_id
    LEFT JOIN attempts at ON at.context = 'homework' AND at.context_id = hi.homework_id AND at.problem_id = p.id
    WHERE hi.homework_id = ? ORDER BY hi.position`).all(id);
  return {
    ...h,
    items: items.map((r) => ({
      position: r.position,
      problem_id: r.id,
      level: r.level,
      problem: stripAsy(r.problem_latex),
      ...(submitted ? { given: r.given, correct: r.correct } : {}),
      ...(reveal ? { answer: r.answer, solution: stripAsy(r.solution_latex) } : {}),
    })),
  };
}

export function submitHomework(db, id, answers) {
  const h = db.prepare("SELECT * FROM homework WHERE id = ?").get(id);
  if (!h) throw new Error("Not found");
  if (h.submitted_at) return getHomework(db, id, { includeSolutions: true });
  const items = db.prepare(`SELECT p.id, p.answer FROM homework_items hi JOIN problems p ON p.id = hi.problem_id WHERE hi.homework_id = ?`).all(id);
  tx(db, () => {
    let correctCount = 0;
    for (const it of items) {
      const given = (answers?.[it.id]?.answer ?? "").trim();
      const correct = given === "" ? null : isEquivalent(given, it.answer) ? 1 : 0;
      if (correct === 1) correctCount++;
      else logError(db, it.id);
      db.prepare("INSERT INTO attempts (problem_id, context, context_id, answer, correct, time_sec) VALUES (?, 'homework', ?, ?, ?, ?)")
        .run(it.id, id, given || null, correct, Math.round(answers?.[it.id]?.timeSec ?? 0));
    }
    db.prepare("UPDATE homework SET submitted_at = datetime('now'), score = ? WHERE id = ?").run(correctCount / items.length, id);
    if (h.plan_item_id) db.prepare("UPDATE plan_items SET status = 'done' WHERE id = ?").run(h.plan_item_id);
  });
  return getHomework(db, id, { includeSolutions: true });
}

export function dashboard(db) {
  return {
    skills: skillEstimates(db),
    assessments: db.prepare("SELECT id, kind, created_at, submitted_at, score FROM assessments ORDER BY id DESC LIMIT 10").all(),
    plan: getActivePlan(db),
    homework: db.prepare("SELECT id, subject, topic, created_at, submitted_at, score FROM homework ORDER BY id DESC LIMIT 10").all(),
    errorLogDue: db.prepare("SELECT COUNT(*) n FROM error_log WHERE resolved = 0 AND next_review_at <= date('now')").get().n,
    chats: db.prepare("SELECT id, mode, title, created_at FROM chats ORDER BY id DESC LIMIT 10").all(),
    pools: db.prepare("SELECT pool, COUNT(*) n FROM problems WHERE id NOT IN (SELECT problem_id FROM exposures) GROUP BY pool").all(),
  };
}
