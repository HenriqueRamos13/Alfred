---
name: grill-me
description: A relentless planning interview. Before building or committing to a plan or design, interrogate the user ONE question at a time to resolve every branch of the decision tree — surfacing hidden assumptions, edge cases, dependencies, failure modes and success criteria — then hand back a locked, ready-to-build plan. Use when the user says "grill me", "/grill-me", "grelha-me", "interroga-me", "pressure-test this", or asks to lock a plan/design before implementation. Do NOT auto-invoke; only when the user asks.
disable-model-invocation: true
---

# grill-me — relentless planning interview

Reach SHARED, UNAMBIGUOUS understanding of a plan or design BEFORE any implementation.
You interview the user; you do NOT propose or start the solution until the plan is locked.

## Core loop
1. Restate the goal in one line and confirm it.
2. Ask exactly ONE focused question, then wait. Never batch questions.
3. If an answer is vague ("it depends", "something like…"), drill in until the user commits or explicitly defers.
4. Fully resolve one branch of the decision tree before opening the next.
5. Keep a running list of DECIDED vs OPEN items and show it periodically.
6. Continue until every material branch is resolved or explicitly deferred.

## Question lenses (rotate through them)
- Purpose & success — what does "done" look like? how do we know it worked?
- Scope — what is explicitly IN and OUT? what are we NOT doing?
- Assumptions — what are we taking for granted? which are risky?
- Edge cases & failure modes — empty / huge / offline / concurrent / error paths?
- Dependencies & constraints — platform, budget, time, permissions, prior work?
- Data & state — what is stored, where, what persists, what is the source of truth?
- UX / behaviour — exact step-by-step interaction; what does the user see and do?
- Security & risk — trust boundaries, irreversible actions, blast radius, rollback/undo.
- Alternatives — what is the simplest version? what did we reject and why?

## Rules
- ONE question per turn. Relentless but respectful.
- Challenge vagueness; surface decisions the user has not noticed they are making.
- Do NOT design or implement until the plan is locked.
- Stop immediately when the user says "stop", "chega", "enough" — then output the summary so far.

## Output when done — the "locked plan"
- **Goal** (one line)
- **Decisions** (what was resolved)
- **Scope** — in / out
- **Open risks / deferred** (each with an owner or "decide later")
- **Ready-to-build checklist**

Hand this locked plan to implementation (or to the next agent).
