// Copilot SDK integration: one session per learning activity, with mode-specific tools.
import { CopilotClient, defineTool } from "@github/copilot-sdk";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUBJECTS } from "./db.mjs";
import {
  getAssessment, subjectBreakdown, skillEstimates, recordDiagnosis, savePlan, getActivePlan,
  findPracticeProblems, useAsExample, createHomework, getHomework, getErrorLog, recordErrorReview,
} from "./learning.mjs";
import { isEquivalent, numericValue } from "./grade.mjs";

const COMMON_RULES = `
You are an encouraging, rigorous AMC 10 coach for a single learner.
Formatting: write math in LaTeX using $...$ inline and $$...$$ for display. Keep replies focused and readable; use short paragraphs and lists.
Integrity rules:
- Scores, correctness and answer keys come only from tools. Never invent problem data, scores or answers.
- When you state a numeric result, double-check it (use check_answer when comparing values).
- Prefer the stored, verified solutions returned by tools over deriving new ones.
- Problems solved with heavy hints are "assisted", not mastered; say so honestly.`;

const json = (o) => JSON.stringify(o);

// --- Model provider -------------------------------------------------------
// By default the SDK authenticates as the logged-in GitHub Copilot user.
// Alternatively, route model calls through any OpenAI-compatible provider
// (BYOK). DashScope (Alibaba Qwen) is supported out of the box via
// DASHSCOPE_API_KEY; any other endpoint works via TUTOR_BASE_URL + TUTOR_API_KEY.
// Values may live in a .env file in the project root (KEY=VALUE lines).
function loadDotEnv() {
  try {
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".env"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env file */ }
}
loadDotEnv();

export function providerConfig() {
  if (process.env.TUTOR_BASE_URL) {
    const p = { type: process.env.TUTOR_PROVIDER_TYPE ?? "openai", baseUrl: process.env.TUTOR_BASE_URL };
    if (process.env.TUTOR_BEARER_TOKEN) p.bearerToken = process.env.TUTOR_BEARER_TOKEN;
    else if (process.env.TUTOR_API_KEY) p.apiKey = process.env.TUTOR_API_KEY;
    return p;
  }
  if (process.env.DASHSCOPE_API_KEY) {
    return { type: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: process.env.DASHSCOPE_API_KEY };
  }
  return null; // use the logged-in Copilot user
}

export const DEFAULT_MODEL = process.env.DASHSCOPE_API_KEY && !process.env.TUTOR_BASE_URL ? "qwen-max" : null;
const obj = (properties, required = []) => ({ type: "object", properties, required });
const subjectEnum = { type: "string", enum: SUBJECTS };

function sharedTools(db) {
  return {
    get_learner_summary: defineTool("get_learner_summary", {
      description: "Get the learner's estimated mastery per subject (0-1), recent test scores and the active study plan.",
      parameters: obj({}),
      skipPermission: true,
      handler: () => {
        const plan = getActivePlan(db);
        return json({
          skills: skillEstimates(db),
          recent_tests: db.prepare("SELECT id, kind, score, submitted_at FROM assessments WHERE submitted_at IS NOT NULL ORDER BY id DESC LIMIT 5").all(),
          active_plan: plan && { summary: plan.summary, start_date: plan.start_date, items: plan.items.map((i) => ({ week: i.week, day: i.day, type: i.type, subject: i.subject, topic: i.topic, status: i.status })) },
        });
      },
    }),
    check_answer: defineTool("check_answer", {
      description: "Check whether two math answers are equivalent (e.g. '\\\\frac{1}{2}' vs '0.5') and evaluate numeric expressions. Use this to verify computations.",
      parameters: obj({ a: { type: "string" }, b: { type: "string" } }, ["a", "b"]),
      skipPermission: true,
      handler: ({ a, b }) => json({ equivalent: isEquivalent(a, b), value_a: numericValue(a), value_b: numericValue(b) }),
    }),
    record_diagnosis: defineTool("record_diagnosis", {
      description: "Save the diagnosed cause of a missed problem: concept (missing idea), strategy (could not find approach), execution (careless/arithmetic error), timing (too slow), uncertain (guessed / unclear reasoning).",
      parameters: obj({
        problem_id: { type: "string" },
        cause: { type: "string", enum: ["concept", "strategy", "execution", "timing", "uncertain"] },
        note: { type: "string", description: "One sentence: the specific skill or misconception" },
      }, ["problem_id", "cause"]),
      skipPermission: true,
      handler: (args) => json(recordDiagnosis(db, args)),
    }),
    find_example_problems: defineTool("find_example_problems", {
      description: "Get unseen practice problems (with verified answer and solution) for worked examples or guided practice. Returned problems are marked as seen.",
      parameters: obj({
        subject: subjectEnum,
        level_min: { type: "integer", minimum: 1, maximum: 5 },
        level_max: { type: "integer", minimum: 1, maximum: 5 },
        count: { type: "integer", minimum: 1, maximum: 5 },
      }, ["subject"]),
      skipPermission: true,
      handler: (args) => {
        const probs = findPracticeProblems(db, { subject: args.subject, level_min: args.level_min ?? 1, level_max: args.level_max ?? 5, count: args.count ?? 3 });
        probs.forEach((p) => useAsExample(db, p.id));
        return json(probs.map((p) => ({ id: p.id, level: p.level, problem: p.problem_latex, answer: p.answer, solution: p.solution_latex })));
      },
    }),
  };
}

function reviewMode(db, assessmentId) {
  const t = sharedTools(db);
  return {
    title: `Test #${assessmentId} review & study plan`,
    kickoff: "I just submitted my test. Please review my results, help me understand my mistakes, and then build my study plan.",
    system: `${COMMON_RULES}
Current activity: REVIEW of simulated test #${assessmentId} (already submitted) and creating a one-month study plan.
Workflow:
1. Call get_test_results. Give a short overview: score out of 150 (AMC scoring: +6 correct, +1.5 blank, 0 wrong), strengths, weak subjects.
2. Pick the 2-4 most important missed problems. For each, briefly ask what the learner tried OR explain the key idea, then call record_diagnosis with your best judgment.
   Do not walk through every problem unless asked. Keep the conversation moving.
3. When the learner is ready (or after the diagnosis), call propose_study_plan with a 4-week plan:
   Week 1 repair biggest gaps, Week 2 strategies, Week 3 mixed + timed practice, Week 4 consolidate + retest.
   About 4-5 items per week (lessons and homework mostly; one checkin per week; final week ends with a 'test' item). Use subjects exactly: ${SUBJECTS.join(", ")} (or "Mixed").
   Topics should be specific (e.g. "Complementary counting", "Modular arithmetic: remainders").
4. Summarize the plan and tell the learner to start from the Dashboard.`,
    tools: [
      t.get_learner_summary, t.check_answer, t.record_diagnosis,
      defineTool("get_test_results", {
        description: "Get the submitted test: score, per-subject breakdown, and every problem with the learner's answer, correctness, time spent, correct answer and official solution.",
        parameters: obj({}),
        skipPermission: true,
        handler: () => {
          const a = getAssessment(db, assessmentId, { includeSolutions: true });
          return json({ id: a.id, kind: a.kind, score: a.score, max: a.items.length * 6, by_subject: subjectBreakdown(a), problems: a.items });
        },
      }),
      defineTool("propose_study_plan", {
        description: "Save the learner's study plan. The backend validates it and replaces any active plan.",
        parameters: obj({
          summary: { type: "string", description: "2-4 sentences: diagnosis and goals for the month" },
          weeks: {
            type: "array",
            items: obj({
              week: { type: "integer" },
              focus: { type: "string" },
              items: {
                type: "array",
                items: obj({
                  day: { type: "integer", description: "1-7 within the week" },
                  type: { type: "string", enum: ["lesson", "homework", "review", "checkin", "test"] },
                  subject: { type: "string", enum: [...SUBJECTS, "Mixed"] },
                  topic: { type: "string" },
                  description: { type: "string" },
                }, ["day", "type", "topic"]),
              },
            }, ["week", "items"]),
          },
        }, ["summary", "weeks"]),
        skipPermission: true,
        handler: (args) => json(savePlan(db, { ...args, assessment_id: assessmentId })),
      }),
    ],
  };
}

function lessonMode(db, planItemId) {
  const t = sharedTools(db);
  const item = db.prepare("SELECT * FROM plan_items WHERE id = ?").get(planItemId);
  if (!item) throw new Error("Plan item not found");
  const subject = SUBJECTS.includes(item.subject) ? item.subject : null;
  return {
    title: `Lesson: ${item.topic}`,
    kickoff: `Let's start today's lesson on "${item.topic}".`,
    system: `${COMMON_RULES}
Current activity: LESSON. Plan item #${item.id}: type=${item.type}, subject=${item.subject ?? "Mixed"}, topic="${item.topic}". ${item.description ?? ""}
Workflow (interactive; one step per message, wait for the learner):
1. Check get_learner_summary, then explain the core concept(s) of the topic concisely with key formulas and when to use them.
2. Worked example: call find_example_problems and choose one; present the problem, then walk through the solution step by step, explaining WHY each step works. Base it on the stored solution.
3. Invite questions and answer them. Offer another example if helpful.
4. Guided practice: give one more problem from find_example_problems WITHOUT the answer. Let the learner try. Give progressive hints only when asked (nudge -> approach -> key step). Check their answer with check_answer.
5. When the learner is ready, call assign_homework (5 problems, levels increasing) and tell them to open the homework from the Dashboard.`,
    tools: [
      t.get_learner_summary, t.check_answer, t.find_example_problems,
      defineTool("assign_homework", {
        description: "Create a homework set of unseen practice problems on this lesson's topic.",
        parameters: obj({
          subject: subjectEnum,
          topic: { type: "string" },
          count: { type: "integer", minimum: 3, maximum: 10 },
          level_min: { type: "integer", minimum: 1, maximum: 5 },
          level_max: { type: "integer", minimum: 1, maximum: 5 },
        }, ["subject", "topic"]),
        skipPermission: true,
        handler: (args) => {
          const id = createHomework(db, { ...args, subject: args.subject ?? subject, plan_item_id: planItemId });
          db.prepare("UPDATE plan_items SET status = 'done' WHERE id = ? AND type = 'lesson'").run(planItemId);
          return json({ homework_id: id, message: "Homework created. The learner can open it from the Dashboard." });
        },
      }),
    ],
  };
}

function homeworkReviewMode(db, homeworkId) {
  const t = sharedTools(db);
  return {
    title: `Homework #${homeworkId} review`,
    kickoff: "I submitted my homework. Can you go over it with me?",
    system: `${COMMON_RULES}
Current activity: HOMEWORK REVIEW of homework #${homeworkId} (already submitted).
Call get_homework_results. Celebrate what went well, explain each mistake clearly using the stored solution, record_diagnosis for each missed problem, and answer questions. Suggest what to focus on next.`,
    tools: [
      t.get_learner_summary, t.check_answer, t.record_diagnosis,
      defineTool("get_homework_results", {
        description: "Get the submitted homework with answers, correctness and solutions.",
        parameters: obj({}),
        skipPermission: true,
        handler: () => json(getHomework(db, homeworkId, { includeSolutions: true })),
      }),
    ],
  };
}

function topicReviewMode(db, planItemId) {
  const t = sharedTools(db);
  const item = db.prepare("SELECT * FROM plan_items WHERE id = ?").get(planItemId);
  if (!item) throw new Error("Plan item not found");
  const subject = SUBJECTS.includes(item.subject) ? item.subject : null;
  return {
    title: `Review: ${item.topic}`,
    kickoff: `Let's do my review session on "${item.topic}".`,
    system: `${COMMON_RULES}
Current activity: TOPIC REVIEW. Plan item #${item.id}: subject=${item.subject ?? "Mixed"}, topic="${item.topic}". ${item.description ?? ""}
Goal: revisit the learner's past mistakes, then confirm the skill with fresh problems. Interactive; one problem at a time, wait for the learner.
1. Call get_error_log (subject ${subject ? `"${subject}"` : "omitted for mixed review"}). Pick up to 3 entries most related to the topic.
   If there are none, say so briefly and skip to step 3.
2. For each picked mistake: show the problem and remind the learner what they answered (do NOT reveal the correct answer). Ask them to re-solve it.
   Check with check_answer. Give progressive hints only if asked. Then walk through the key idea of the stored solution.
   Call record_error_review: solved=true only if they got it right without hints; otherwise false.
3. Give 2 fresh problems from find_example_problems on the topic WITHOUT answers, one at a time; check each with check_answer.
4. Summarize what is now solid and what still needs work, then call complete_review.`,
    tools: [
      t.get_learner_summary, t.check_answer, t.find_example_problems,
      defineTool("get_error_log", {
        description: "Get the learner's unresolved past mistakes (problem, their answer, correct answer, stored solution, diagnosis).",
        parameters: obj({ subject: subjectEnum, limit: { type: "integer", minimum: 1, maximum: 20 } }),
        skipPermission: true,
        handler: (args) => json(getErrorLog(db, { subject: args.subject ?? null, limit: args.limit ?? 10 })),
      }),
      defineTool("record_error_review", {
        description: "Record the result of re-solving a past mistake. solved=true (unaided) removes it from the error log; false schedules it again in 7 days.",
        parameters: obj({ problem_id: { type: "string" }, solved: { type: "boolean" } }, ["problem_id", "solved"]),
        skipPermission: true,
        handler: ({ problem_id, solved }) => json(recordErrorReview(db, problem_id, solved)),
      }),
      defineTool("complete_review", {
        description: "Mark this review item in the study plan as done. Call at the end of the session.",
        parameters: obj({}),
        skipPermission: true,
        handler: () => {
          db.prepare("UPDATE plan_items SET status = 'done' WHERE id = ?").run(planItemId);
          return json({ ok: true });
        },
      }),
    ],
  };
}

export const MODES = { review: reviewMode, lesson: lessonMode, homework_review: homeworkReviewMode, topic_review: topicReviewMode };

export class Tutor {
  constructor(db) {
    this.db = db;
    this.client = new CopilotClient();
    this.sessions = new Map();
    this.busy = new Set();
  }

  async start() {
    await this.client.start();
  }

  async stop() {
    await this.client.stop();
  }

  /** Reopens the existing chat for this activity unless `fresh` is set. */
  startChat(mode, refId, { fresh = false } = {}) {
    const build = MODES[mode];
    if (!build) throw new Error(`Unknown mode ${mode}`);
    const spec = build(this.db, refId);
    if (!fresh) {
      const existing = this.db.prepare("SELECT id FROM chats WHERE mode = ? AND ref_id = ? ORDER BY id DESC LIMIT 1").get(mode, refId);
      if (existing) return { id: existing.id, title: spec.title, kickoff: spec.kickoff, resumed: true };
    }
    const { lastInsertRowid } = this.db.prepare("INSERT INTO chats (mode, ref_id, title) VALUES (?, ?, ?)").run(mode, refId, spec.title);
    return { id: Number(lastInsertRowid), title: spec.title, kickoff: spec.kickoff };
  }

  getChat(id) {
    const chat = this.db.prepare("SELECT * FROM chats WHERE id = ?").get(id);
    if (!chat) return null;
    chat.messages = this.db.prepare("SELECT role, content FROM chat_messages WHERE chat_id = ? ORDER BY id").all(id);
    chat.kickoff = MODES[chat.mode](this.db, chat.ref_id).kickoff;
    return chat;
  }

  async #session(chat) {
    if (this.sessions.has(chat.id)) return this.sessions.get(chat.id);
    const spec = MODES[chat.mode](this.db, chat.ref_id);
    const provider = providerConfig();
    const model = process.env.TUTOR_MODEL ?? DEFAULT_MODEL;
    const config = {
      // A custom provider (BYOK) requires an explicit model.
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      streaming: true,
      tools: spec.tools,
      availableTools: ["custom:*"],
      systemMessage: { mode: "append", content: spec.system },
      onPermissionRequest: () => ({ kind: "reject" }),
    };
    let session;
    if (chat.sdk_session_id) {
      try {
        session = await this.client.resumeSession(chat.sdk_session_id, config);
      } catch {
        session = null;
      }
    }
    if (!session) {
      session = await this.client.createSession(config);
      this.db.prepare("UPDATE chats SET sdk_session_id = ? WHERE id = ?").run(session.sessionId, chat.id);
    }
    this.sessions.set(chat.id, session);
    return session;
  }

  /** Sends a user message and streams events via onEvent({type, ...}). Resolves when the turn ends. */
  async send(chatId, text, onEvent) {
    const chat = this.db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId);
    if (!chat) throw new Error("Chat not found");
    if (this.busy.has(chatId)) throw new Error("The tutor is still answering the previous message");
    this.busy.add(chatId);
    const unsubs = [];
    try {
      const session = await this.#session(chat);
      this.db.prepare("INSERT INTO chat_messages (chat_id, role, content) VALUES (?, 'user', ?)").run(chatId, text);
      const parts = [];
      const done = new Promise((resolve, reject) => {
        unsubs.push(session.on("assistant.message_delta", (e) => onEvent({ type: "delta", text: e.data.deltaContent ?? "" })));
        unsubs.push(session.on("assistant.message", (e) => {
          if (e.data.content) {
            parts.push(e.data.content);
            this.db.prepare("INSERT INTO chat_messages (chat_id, role, content) VALUES (?, 'assistant', ?)").run(chatId, e.data.content);
            onEvent({ type: "message", text: e.data.content });
          }
        }));
        unsubs.push(session.on("tool.execution_start", (e) => {
          onEvent({ type: "tool", name: e.data.toolName });
          this.db.prepare("INSERT INTO chat_messages (chat_id, role, content) VALUES (?, 'tool', ?)").run(chatId, e.data.toolName ?? "tool");
        }));
        unsubs.push(session.on("session.idle", () => resolve()));
        unsubs.push(session.on("session.error", (e) => reject(new Error(e.data?.message ?? "Session error"))));
      });
      await session.send({ prompt: text });
      await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error("Tutor timed out")), 5 * 60_000))]);
      return parts.join("\n\n");
    } finally {
      unsubs.forEach((u) => u());
      this.busy.delete(chatId);
    }
  }
}
