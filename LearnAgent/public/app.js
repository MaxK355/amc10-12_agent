import { marked } from "/vendor/marked/marked.esm.js";

const app = document.getElementById("app");
const SUBJECT_ORDER = ["Prealgebra", "Algebra", "Counting & Probability", "Number Theory", "Geometry"];

// ---------- helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Renders Markdown + LaTeX ($..$, $$..$$, \(..\), \[..\]) to HTML. */
function rich(text) {
  const DOLLAR = "\u0000D\u0000";
  const maths = [];
  let s = String(text ?? "").replace(/\\\$/g, DOLLAR);
  const put = (tex, display) => {
    maths.push({ tex: tex.replaceAll(DOLLAR, "\\$"), display });
    return `\u0000M${maths.length - 1}\u0000`;
  };
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => put(t, true));
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => put(t, true));
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => put(t, false));
  s = s.replace(/\$([^$\n]+?)\$/g, (_, t) => put(t, false));
  s = s.replace(/\\begin\{(align\*?|equation\*?|eqnarray\*?)\}([\s\S]+?)\\end\{\1\}/g, (_, env, t) => put(`\\begin{aligned}${t}\\end{aligned}`, true));
  s = s.replaceAll(DOLLAR, "\\$");
  let html = marked.parse(s, { breaks: true });
  html = html.replace(/\u0000M(\d+)\u0000/g, (_, i) => {
    const m = maths[+i];
    try {
      return katex.renderToString(m.tex, { displayMode: m.display, throwOnError: false });
    } catch {
      return esc(m.tex);
    }
  });
  return html;
}

const fmtScore = (n) => (n == null ? "–" : Number(n).toFixed(1).replace(/\.0$/, ""));
const statusPill = (c) => (c === 1 ? `<span class="pill ok">correct</span>` : c === 0 ? `<span class="pill bad">wrong</span>` : `<span class="pill blank">blank</span>`);

async function startChat(mode, refId) {
  const chat = await api("/api/chats", { method: "POST", body: { mode, refId } });
  location.hash = `#/chat/${chat.id}`;
}

// ---------- dashboard ----------
async function renderDashboard() {
  const d = await api("/api/dashboard");
  const pools = Object.fromEntries(d.pools.map((p) => [p.pool, p.n]));
  const skills = [...d.skills].sort((a, b) => SUBJECT_ORDER.indexOf(a.subject) - SUBJECT_ORDER.indexOf(b.subject));
  app.innerHTML = `
    <h1>Dashboard</h1>
    <div class="grid">
      <div class="card">
        <h2>Take a simulated test</h2>
        <p class="muted">Problems come from the unseen test pool (${pools.assessment ?? 0} left). AMC scoring: +6 correct, +1.5 blank, 0 wrong.</p>
        <button data-test="full">Full test · 25 problems · 75 min</button>
        <button class="secondary" data-test="quick">Quick test · 10 problems · 30 min</button>
      </div>
      <div class="card">
        <h2>Skill estimates</h2>
        <table>${skills.map((s) => `<tr><td>${esc(s.subject)}</td><td><span class="bar"><span style="width:${Math.round(s.mastery * 100)}%"></span></span> ${Math.round(s.mastery * 100)}%</td><td class="muted">${s.attempts} attempts</td></tr>`).join("")}</table>
        <p class="muted">Error log: ${d.errorLogDue} problem(s) due for review.</p>
      </div>
    </div>
    <div class="card">
      <h2>Study plan</h2>
      ${d.plan ? renderPlan(d.plan) : `<p class="muted">No plan yet. Take a test, then click “Review with tutor & build my plan”.</p>`}
    </div>
    <div class="grid">
      <div class="card">
        <h2>Tests</h2>
        ${d.assessments.length ? `<table>${d.assessments.map((a) => `<tr><td><a href="#/test/${a.id}">Test #${a.id}</a> <span class="pill">${a.kind}</span></td><td>${a.submitted_at ? `${fmtScore(a.score)} pts` : `<span class="pill blank">in progress</span>`}</td><td class="muted">${a.created_at.slice(0, 10)}</td></tr>`).join("")}</table>` : `<p class="muted">No tests yet.</p>`}
      </div>
      <div class="card">
        <h2>Homework</h2>
        ${d.homework.length ? `<table>${d.homework.map((h) => `<tr><td><a href="#/homework/${h.id}">#${h.id} ${esc(h.topic)}</a></td><td>${h.submitted_at ? `${Math.round(h.score * 100)}%` : `<span class="pill blank">to do</span>`}</td></tr>`).join("")}</table>` : `<p class="muted">No homework yet.</p>`}
      </div>
    </div>
    <div class="card">
      <h2>Tutor conversations</h2>
      ${d.chats.length ? `<table>${d.chats.map((c) => `<tr><td><a href="#/chat/${c.id}">${esc(c.title)}</a></td><td class="muted">${c.created_at.slice(0, 16)}</td></tr>`).join("")}</table>` : `<p class="muted">None yet.</p>`}
    </div>`;

  app.querySelectorAll("[data-test]").forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    const { id } = await api("/api/tests", { method: "POST", body: { kind: b.dataset.test } });
    location.hash = `#/test/${id}`;
  }));
  app.querySelectorAll("[data-action]").forEach((b) => (b.onclick = () => planAction(b)));
}

function renderPlan(plan) {
  const weeks = {};
  for (const it of plan.items) (weeks[it.week] ??= []).push(it);
  const action = (it) => {
    if (it.type === "lesson" || it.type === "review") {
      const noun = it.type === "lesson" ? "lesson" : "review";
      if (it.status === "done") return it.chat_id ? `<a class="btn secondary" href="#/chat/${it.chat_id}">Revisit ${noun}</a>` : "";
      if (it.chat_id) return `<a class="btn" href="#/chat/${it.chat_id}">Continue ${noun}</a> <button class="secondary" data-action="done" data-id="${it.id}">Mark done</button>`;
      return `<button data-action="${noun}" data-id="${it.id}">Start ${noun}</button>`;
    }
    if (it.type === "homework" || it.type === "checkin") return it.homework_id ? `<a class="btn secondary" href="#/homework/${it.homework_id}">Open homework</a>` : `<button data-action="homework" data-id="${it.id}">Get problems</button>`;
    if (it.type === "test") return `<button data-action="test" data-id="${it.id}">Start test</button>`;
    return it.status === "done" ? "" : `<button class="secondary" data-action="done" data-id="${it.id}">Mark done</button>`;
  };
  return `<div class="solution">${rich(plan.summary)}</div>
    ${Object.entries(weeks).map(([w, items]) => `<div class="week"><h3>Week ${w}</h3>
      ${items.map((it) => `<div class="item ${it.status}"><span class="pill">${it.date.slice(5)}</span><span class="pill">${it.type}</span>
        <span class="what"><b>${esc(it.topic)}</b>${it.subject ? ` <span class="muted">· ${esc(it.subject)}</span>` : ""}${it.description ? `<br><span class="muted">${esc(it.description)}</span>` : ""}</span>
        ${action(it)}</div>`).join("")}</div>`).join("")}`;
}

async function planAction(b) {
  b.disabled = true;
  const id = Number(b.dataset.id);
  try {
    if (b.dataset.action === "lesson") return startChat("lesson", id);
    if (b.dataset.action === "review") return startChat("topic_review", id);
    if (b.dataset.action === "homework") {
      const hw = await api(`/api/plan/items/${id}/homework`, { method: "POST" });
      location.hash = `#/homework/${hw.id}`;
    } else if (b.dataset.action === "test") {
      await api(`/api/plan/items/${id}/done`, { method: "POST" });
      const t = await api("/api/tests", { method: "POST", body: { kind: "full" } });
      location.hash = `#/test/${t.id}`;
    } else {
      await api(`/api/plan/items/${id}/done`, { method: "POST" });
      route();
    }
  } catch (e) {
    alert(e.message);
    b.disabled = false;
  }
}

// ---------- test ----------
let timerHandle = null;

async function renderTest(id) {
  const t = await api(`/api/tests/${id}`);
  if (t.submitted_at) return renderTestResults(t);
  const key = `test-${id}`;
  const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
  const deadline = new Date(t.created_at.replace(" ", "T") + "Z").getTime() + t.duration_min * 60_000;
  app.innerHTML = `
    <div class="timer"><span><b>Test #${t.id}</b> · ${t.items.length} problems · type your answer (number, fraction like 3/4 or \\frac{3}{4}, sqrt(2), etc.)</span>
      <span class="clock" id="clock"></span><button id="submit">Submit test</button></div>
    <div class="card">${t.items.map((it) => `
      <div class="problem"><div class="head"><span class="num">${it.position}.</span></div>
        <div>${rich(it.problem)}</div>
        <p><input data-pid="${it.problem_id}" placeholder="Your answer (leave blank to skip)" value="${esc(saved[it.problem_id]?.answer ?? "")}"></p>
      </div>`).join("")}</div>`;
  const state = saved;
  let focusStart = null, focusPid = null;
  const persist = () => localStorage.setItem(key, JSON.stringify(state));
  const flushFocus = () => {
    if (focusPid) {
      const s = (state[focusPid] ??= { answer: "", timeSec: 0 });
      s.timeSec = (s.timeSec ?? 0) + (Date.now() - focusStart) / 1000;
      focusPid = null;
    }
  };
  app.querySelectorAll("input[data-pid]").forEach((inp) => {
    inp.onfocus = () => { flushFocus(); focusPid = inp.dataset.pid; focusStart = Date.now(); };
    inp.onblur = () => { flushFocus(); persist(); };
    inp.oninput = () => { (state[inp.dataset.pid] ??= { answer: "", timeSec: 0 }).answer = inp.value; persist(); };
  });
  const submit = async () => {
    clearInterval(timerHandle);
    flushFocus();
    document.getElementById("submit").disabled = true;
    const result = await api(`/api/tests/${id}/submit`, { method: "POST", body: { answers: state } });
    localStorage.removeItem(key);
    renderTestResults(result);
  };
  document.getElementById("submit").onclick = () => confirm("Submit the test? You cannot change answers afterwards.") && submit();
  const tick = () => {
    const left = Math.max(0, deadline - Date.now());
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    const el = document.getElementById("clock");
    if (!el) return clearInterval(timerHandle);
    el.textContent = `${m}:${String(s).padStart(2, "0")}`;
    if (left === 0) { clearInterval(timerHandle); alert("Time is up! Submitting."); submit(); }
  };
  clearInterval(timerHandle);
  timerHandle = setInterval(tick, 1000);
  tick();
}

function renderTestResults(t) {
  const correct = t.items.filter((i) => i.correct === 1).length;
  app.innerHTML = `
    <h1>Test #${t.id} results</h1>
    <div class="card">
      <h2>${fmtScore(t.score)} / ${t.items.length * 6} points</h2>
      <p class="muted">${correct} correct · ${t.items.filter((i) => i.correct === 0).length} wrong · ${t.items.filter((i) => i.correct == null).length} blank</p>
      <table><tr><th>Subject</th><th>Correct</th><th>Wrong</th><th>Blank</th></tr>
      ${(t.by_subject ?? []).map((s) => `<tr><td>${esc(s.subject)}</td><td>${s.correct}/${s.total}</td><td>${s.wrong}</td><td>${s.blank}</td></tr>`).join("")}</table>
      <p><button id="review">Review with tutor & build my plan</button> <a class="btn secondary" href="#/">Dashboard</a></p>
    </div>
    <div class="card">${t.items.map((it) => `
      <div class="problem"><div class="head"><span class="num">${it.position}.</span>${statusPill(it.correct)}<span class="pill">${esc(it.subject)}</span><span class="pill">Level ${it.level}</span><span class="muted">${it.time_sec ?? 0}s</span></div>
        <div>${rich(it.problem)}</div>
        <p class="muted">Your answer: <b>${esc(it.given ?? "—")}</b> · Correct answer: ${rich(`$${it.answer}$`).replace(/^<p>|<\/p>\n?$/g, "")}</p>
        <details><summary>Solution</summary><div class="solution">${rich(it.solution)}</div></details>
      </div>`).join("")}</div>`;
  document.getElementById("review").onclick = (e) => { e.target.disabled = true; startChat("review", t.id); };
}

// ---------- homework ----------
async function renderHomework(id) {
  const h = await api(`/api/homework/${id}`);
  const done = !!h.submitted_at;
  app.innerHTML = `
    <h1>Homework #${h.id}: ${esc(h.topic)}</h1>
    <p class="muted">${esc(h.subject)} · ${h.items.length} problems${done ? ` · Score: ${Math.round(h.score * 100)}%` : ""}</p>
    <div class="card">${h.items.map((it) => `
      <div class="problem"><div class="head"><span class="num">${it.position}.</span><span class="pill">Level ${it.level}</span>${done ? statusPill(it.correct) : ""}</div>
        <div>${rich(it.problem)}</div>
        ${done
          ? `<p class="muted">Your answer: <b>${esc(it.given ?? "—")}</b> · Correct answer: ${rich(`$${it.answer}$`).replace(/^<p>|<\/p>\n?$/g, "")}</p>
             <details><summary>Solution</summary><div class="solution">${rich(it.solution)}</div></details>`
          : `<p><input data-pid="${it.problem_id}" placeholder="Your answer"></p>`}
      </div>`).join("")}</div>
    <p>${done ? `<button id="review">Review with tutor</button>` : `<button id="submit">Submit homework</button>`} <a class="btn secondary" href="#/">Dashboard</a></p>`;
  if (done) {
    document.getElementById("review").onclick = (e) => { e.target.disabled = true; startChat("homework_review", h.id); };
  } else {
    document.getElementById("submit").onclick = async (e) => {
      e.target.disabled = true;
      const answers = {};
      app.querySelectorAll("input[data-pid]").forEach((i) => (answers[i.dataset.pid] = { answer: i.value }));
      await api(`/api/homework/${id}/submit`, { method: "POST", body: { answers } });
      renderHomework(id);
    };
  }
}

// ---------- chat ----------
async function renderChat(id) {
  const chat = await api(`/api/chats/${id}`);
  app.innerHTML = `
    <h1>${esc(chat.title)}</h1>
    <div class="chat" id="log"></div>
    <div class="composer"><textarea id="input" placeholder="Ask a question, answer the tutor, or say 'next'… (Enter to send, Shift+Enter for newline)"></textarea>
      <button id="send">Send</button></div>
    <p><a href="#/">← Dashboard</a></p>`;
  const log = document.getElementById("log");
  const add = (role, text) => {
    const div = document.createElement("div");
    div.className = `msg ${role}`;
    div.innerHTML = role === "tool" ? `🔧 ${esc(text)}` : role === "user" ? esc(text).replace(/\n/g, "<br>") : rich(text);
    log.appendChild(div);
    return div;
  };
  chat.messages.forEach((m) => add(m.role, m.content));
  const input = document.getElementById("input");
  const btn = document.getElementById("send");

  async function send(text) {
    add("user", text);
    btn.disabled = true;
    input.value = "";
    let bubble = null, buf = "", raf = 0;
    const draw = () => { raf = 0; if (bubble) bubble.innerHTML = rich(buf); };
    try {
      const res = await fetch(`/api/chats/${id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let pending = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += dec.decode(value, { stream: true });
        let idx;
        while ((idx = pending.indexOf("\n\n")) !== -1) {
          const line = pending.slice(0, idx).replace(/^data: /, "");
          pending = pending.slice(idx + 2);
          const ev = JSON.parse(line);
          if (ev.type === "delta") {
            if (!bubble) { bubble = add("assistant", ""); buf = ""; }
            buf += ev.text;
            if (!raf) raf = requestAnimationFrame(draw);
          } else if (ev.type === "message") {
            if (!bubble) bubble = add("assistant", "");
            buf = ev.text;
            draw();
            bubble = null;
          } else if (ev.type === "tool") {
            add("tool", ev.name);
          } else if (ev.type === "error") {
            add("assistant", `**Error:** ${ev.message}`).classList.add("error");
          }
          window.scrollTo(0, document.body.scrollHeight);
        }
      }
    } finally {
      btn.disabled = false;
      input.focus();
    }
  }

  btn.onclick = () => input.value.trim() && send(input.value.trim());
  input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); btn.click(); } };
  if (!chat.messages.length) send(chat.kickoff);
}

// ---------- router ----------
async function route() {
  clearInterval(timerHandle);
  const [, page, id] = location.hash.replace(/^#/, "").split("/");
  try {
    if (page === "test") await renderTest(id);
    else if (page === "homework") await renderHomework(id);
    else if (page === "chat") await renderChat(id);
    else await renderDashboard();
  } catch (e) {
    app.innerHTML = `<p class="error">${esc(e.message)}</p><p><a href="#/">← Dashboard</a></p>`;
  }
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);
route();
