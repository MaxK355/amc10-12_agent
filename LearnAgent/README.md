# AMC 10 Learning Agent (POC)

A personal AMC 10 tutor built on the GitHub Copilot SDK. It uses the SDK's agent loop with custom tools; scoring and learner data are handled deterministically in SQLite. See `design.html` for the design.

## Run
```powershell
npm install          # once
npm run ingest       # once: downloads the MATH dataset and builds data/learn.db
npm start            # http://localhost:3000
```
You must be logged in to GitHub Copilot (the SDK uses your Copilot CLI login). Optional: `$env:TUTOR_MODEL="..."` to pick a model.

## Flow
Dashboard → **Take test** (quick 10 / full 25) → **Review with tutor**, which diagnoses your mistakes and saves a 4-week plan → open a plan item to start a **lesson chat**, where you can ask questions and get homework; **review** items open a tutor chat that has you re-solve past mistakes from your error log, then gives fresh problems. Reopening a lesson or review continues the same chat. → **Homework** → review → retest.

## Dev
- `npm test` runs the unit tests (grading, test assembly, plan, homework)
- `npm run reset` wipes your progress (tests, plans, homework, chats) but keeps the problem bank, after saving a backup in `data/`
- `node scripts/e2e.mjs http://localhost:3000` runs a full flow against a running server (uses the real LLM, takes about 3 min, and writes to the DB; set `LEARN_DB` to a copy if you want)

## POC limitations
MATH-dataset problems only (no A–E choices, `[asy]` diagrams not rendered); JS answer checker instead of SymPy; native tools only (no MCP servers yet); vanilla JS UI.
