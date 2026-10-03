# CWS Workflow: Idea → Launch, as Blocks

The meta-workflow of CWS, drawn like Scratch: colored blocks that snap into each other. You learn one block shape once, and it fits inside itself at every size.

Source of intent: [`starttoughts.md`](../starttoughts.md). Technical contract: [`spec.md`](spec.md). Where this doc and the constitution disagree, the constitution wins.

**Badges:** ✓ built (exists in the code today) · ◐ in the prompts (the AI is told to do it; the code does not track it) · ◌ vision (designed, not built yet).
**AI tiers:** 🧠 brain (higher-capacity model: frames, checks, reviews) · 🔧 worker (lower-cost model: bounded work). See [Multi-model layer](#6-multi-model-layer).

---

## 1. The block palette

| Block | Shape | Meaning |
| --- | --- | --- |
| 🟧 **Start** | hat (rounded top) | "When I have an idea" / "When I sit down to work" |
| 🟦 **Stage** | C-shaped container | one of the 9 stages; holds steps |
| 🟩 **Step** | stack block | adaptive work inside a stage; `(…)` = sub-steps, designed later |
| 🟪 **AI role** | tag on a stage | the hat the AI wears, with its 🧠/🔧 tier |
| 🟨 **Piece** | round reporter | the stuff that flows: Note, Your statement, Fact, Interpretation, Assumption, Hypothesis, Unknown, Evidence |
| 🔶 **Check** | if-block | a warning, never a wall |
| ⭐ **You decide** | gold block | only the human can place it: accept, decide, move stage |
| ↺ **Loop / go back** | repeat block | the next round, or a jump back when new info breaks something |
| 🧩 **Domain** | snap-in block | an area of work (Blueprint, Identity, …) inside Translate & Plan |
| 🌡️ **Thermostat** | end block | keep-running mode after the project is done |

---

## 2. Level 0: the outer program

```text
🟧 WHEN I HAVE AN IDEA
│
↺ ROUND  (not endless; every round has a finish line)
│   🟦 1 Explore      collect: inside your head, then outside
│   🟦 2 Understand   make sense: what do I mean, how does it fit?
│   🟦 3 Synthesize   pull it into one picture
│   🟦 4 Prove        check the specific risky ideas
│   🟦 5 Concept      what, for whom, why + the done-list G
│   🟦 6 Plan         translate into domains, plan the work
│   🟦 7 Build        make it, one framed session at a time
│   🟦 8 Launch       put it in front of people
│   🟦 9 Learn        what really happened?
│
│   ⭐ YOU DECIDE: is it done enough?
│      ├─ ✅ DONE    → 🌡️ KEEP-RUNNING MODE (thermostat)
│      └─ ↺ NOT YET → another round, on purpose, with a clear reason
│
└ ANYWHERE: ↺ GO BACK TO <stage> when something breaks an earlier idea.
            The system lists what might be affected; ⭐ you choose how far.
```

| Rule | Status |
| --- | --- |
| 9 stages, same names as the code (`PHASES` in `src/domain/types.ts`) | ✓ |
| Going back to any stage, with "possibly affected" items listed | ✓ |
| Every round passes through all 9 stages. A stage may be a ⚡ **quick pass** (one minute: "anything new here?"), but it is never skipped. Today the code still allows forward jumps with a warning (`PHASE_SKIP`). | ◌ |
| Concept defines the done-list **G** (`prompts/concept.md`) | ◐ |
| The thermostat: the Learn prompt suggests it (`prompts/learn.md`); no automatic watching yet | ◐ |

### When is it done? (math)

- **S** = the project state: everything known, open, assumed and decided.
- **G** = the done-list written in Concept.

> done ⇔ G(S) = true **and** no untested HIGH/FATAL risk remains

### 🌡️ Keep-running mode

After launch, the world keeps sending events *e* (feedback, bugs, news). The thermostat only reacts when a line is crossed:

```text
for every new event e:
   if e breaks an assumption or decision the concept rests on   → BIG
        🔶 wake you up → ⭐ you choose: new round, or not
   else                                                         → SMALL
        🟩 handle it quietly (fix, note it, move on)
```

A new round starts only when a BIG event happens **and** you say yes. This protects against endless scope. One BIG signal already exists in the code: the `FALSIFIED_PREMISE` warning ✓.

---

## 3. Level 1: the stage cards

Every stage is the same card, so you only learn it once:

```text
┌ 🟦 STAGE NAME ─────────────────── 🟪 AI role (🧠/🔧) ┐
│  🎯 Goal          what this stage is for              │
│  📥 Takes in      pieces from earlier stages          │
│  🟩 Steps         (…) sub-steps, later                │
│  🔶 Checks        what it warns you about             │
│  📤 Gives out     pieces for later stages             │
│  ⚡ Quick pass    the 1-minute version                │
└  ⭐ Ready when…    the "feels done" signal (not a gate)┘
```

| # | Stage | 🎯 Goal | 🟪 AI role | 📤 Gives out | ⚡ Quick pass | ⭐ Ready when… |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Explore | collect everything, without judging | Sparring Partner 🧠 ✓ · Researcher 🔧 ◐ | raw notes | "anything new on my mind or out there?" | notes start repeating |
| 2 | Understand | make sense of inner + outer | Interviewer 🧠 ✓ | your statements, open questions, assumptions | "does it still mean the same?" | you can say it in 2 sentences |
| 3 | Synthesize | one picture | Analyst 🧠 ✓ | vision, problem, goals, options, contradictions | "is the picture still right?" | a 1-page picture you agree with |
| 4 | Prove | check one specific risky idea on purpose | Reality Tester 🧠 ✓ · Critic 🧠 ◌ | evidence; ideas confirmed ✓ or broken ✗ | "any new big risk?" | the riskiest ideas are checked |
| 5 | Concept | what, for whom, why + **done-list G** | Concept Editor 🧠 ✓ | the Idea Concept | "is G still right?" | ⭐ you approve it |
| 6 | Plan | translate into domains, plan the work | Planner 🧠 ✓ · Architect 🧠 ◌ | 🧩 domains with starter kits → tasks (…) | "does the plan still fit?" | ⭐ you pick order and scope |
| 7 | Build | make it | Build Interviewer 🧠 ◐ · Builder 🔧 ✓ · Tester 🔧 ◌ · Reviewer 🧠 ✓ | real things + noted surprises | "anything to build?" | tests pass, ⭐ you accept |
| 8 | Launch | in front of people | Launch Coordinator 🧠 ✓ | release + readiness list | "ready to show?" | ⭐ go / no-go |
| 9 | Learn | what really happened? | Learning Partner 🧠 ✓ | feedback, changed ideas, G check | "what did we learn?" | ⭐ done → 🌡️, or a new round |

✓ roles have their own prompt in `prompts/*.md`. ◐ roles are described inside another stage's prompt (Researcher in Explore's outer lane, Build Interviewer in Build). ◌ roles are designed but have no prompt yet.

### Explore = collect · Understand = make sense · Prove = check

| Stage | Question | Direction |
| --- | --- | --- |
| Explore | "What's there?" | **collect**, wide, no judging |
| Understand | "What does it mean, and how do the pieces fit?" | **make sense** of what was collected |
| Prove | "Is this specific risky idea true?" | **check** one thing on purpose |

### Explore has two lanes

```text
┌ 🟦 1 EXPLORE ──────────────────────────────────────┐
│  🧠 INNER lane  (first)    🟪 Sparring Partner      │
│     what's in my head: ideas, feelings, knowledge   │
│                                                     │
│  🌍 OUTER lane  (second)   🟪 Researcher            │
│     what exists out there: similar things, people,  │
│     competitors, research, tools                    │
└─────────────────────────────────────────────────────┘
```

Inner comes first. If you look outside first, other people's ideas can drown out your own before you've even said it. Understand then puts both lanes side by side: "this is what I want, this is what exists, and this is where my idea is different."

### Prove: the sandbox loop ◌

`question → small experiment → result → meaning → ⭐ decide` (constitution §31). It covers four kinds of proof: logic, understanding, evidence and reality.

### 6 Translate & Plan: snap-in domains ◐

```text
┌ 🟦 6 TRANSLATE & PLAN ─────────────────────────────────┐
│  ⭐ YOU pick which domains this project needs           │
│  🧩 Core  🧩 Blueprint  🧩 Engine Room  🧩 Money Model  │
│  🧩 Identity  🧩 Megaphone  🧩 Words & Media  🧩 People │
│  🧩 Daily Running  🧩 Rules & Risks  🧩 Lookout         │
└─────────────────────────────────────────────────────────┘
```

| 🧩 Domain | What it holds |
| --- | --- |
| **Core** | what the thing *is* and does |
| **Blueprint** | how it's put together (design, architecture) |
| **Engine Room** | actually building it (engineering) |
| **Money Model** | how it earns, costs and survives (business, finance) |
| **Identity** | how it looks, sounds and feels (brand) |
| **Megaphone** | how people hear about it (marketing, campaigns) |
| **Words & Media** | texts, images, videos (content) |
| **People** | users, fans, helpers (community) |
| **Daily Running** | keeping it going (operations; feeds the 🌡️ thermostat) |
| **Rules & Risks** | what's allowed and what could go wrong (legal) |
| **Lookout** | ongoing outside info (research; continues 🌍 outer explore) |

Every 🧩 domain block comes with a **starter kit**, so you can begin right away:
🎯 what this area must achieve · 🟩 first 3 concrete tasks · 🧰 templates and tools · 🟪 the right AI role · 🔗 what it depends on (for example Identity before Megaphone).

### 7 Build: one framed session at a time

```text
┌ 🟦 7 BUILD  (runs once per session) ───────────────────┐
│  🟪 Build Interviewer 🧠  "what do we build today, and  │
│                          how will we know it's done?"   │
│  📄 Session Build Plan   what · done-when · not-touching│
│  ⭐ YOU OK the plan                                     │
│  🟪 Builder 🔧           does only what's in the plan   │
│  🟪 Tester 🔧            checks it works                │
│  🟪 Reviewer 🧠          checks it matches the plan     │
│  ⭐ YOU accept  →  surprises get noted for next time    │
└─────────────────────────────────────────────────────────┘
```

This is the constitution's bounded execution (§30) and its anti-vibe-coding rule (§39). Test and Review live inside Build.

---

## 4. Level 2: the universal step Ψ (the engine under everything)

### Ingredients

| Symbol | Meaning |
| --- | --- |
| **S** | the project state |
| **b** = (g, D, B) | the **brief**: g = today's goal, D = "done when…", B = boundary (what we don't touch) |
| **R** | the AI role for this stage |
| **π(S, b)** | a **slice** of the state: only what matters right now |
| **Δ** | what the AI suggests (pencil) |
| **Δ\*** | the part of Δ that you approved (pen) |

### The step

```text
Ψ:  1 FRAME    b  = interview(you, R)          "what do we do, and when is it done?"  ⭐ you OK the brief
    2 LOAD     C  = π(S, b)                    only the relevant slice, auto-loaded
    3 WORK     Δ  = R(C, b)                    the AI works, in pencil only
    4 CHECK    w  = assess(S ⊕ Δ),  Δ vs D     warnings + "did we hit done?"
    5 DECIDE   Δ* = you(Δ)                     ⭐ accept / reject
    6 SAVE     S' = S ⊕ Δ*                     appended to the log, never erased
    7 HANDOFF  N  = f(S'),  h = what changed   next options + "where I left off" note
    repeat until D(S') = true
```

### It's fractal: the same block at every size

```text
a ROUND   = Ψ repeated over the 9 stages
a STAGE   = Ψ repeated over sessions
a SESSION = Ψ repeated over steps
a STEP    = Ψ  (sub-steps later: Ψ again, one level smaller)
```

### The rules every step obeys, regardless of topic

| # | Rule | As math |
| --- | --- | --- |
| I1 | AI suggests, you decide | Δ\* = you(Δ): nothing turns into pen without you |
| I2 | Nothing gets lost | log(t+1) = log(t) + entry (it only ever grows) |
| I3 | Stay in bounds | Δ ⊆ B; anything outside it → ask first |
| I4 | Warnings, not walls | assess() can warn you but never blocks you |
| I5 | Labels never change by themselves | a guess ≠ a fact unless you promote it |
| I6 | Load only what matters | the AI gets π(S), not all of S |
| I7 | Progress = a clearer state | an open question answered, a risk checked, a piece built: not "hours spent" |

### Ψ ↔ the code today

| Step | Where it lives | Status |
| --- | --- | --- |
| 1 FRAME | every prompt opens with **Step 0 · Frame**; `cws session start "<goal>" --done "…" --not "…"` stores the brief; the context pack shows it | ✓ |
| 2 LOAD | `cws prompt N` / `cws context` build the slice (`src/guidance/context-pack.ts`) | ✓ |
| 3 WORK | role prompts in `prompts/*.md`; the AI records with `--agent` (pencil) | ✓ |
| 4 CHECK | warnings in `src/guidance/warnings.ts` ✓; the handoff asks "Done-when reached?" but nothing checks it automatically ◌ | half |
| 5 DECIDE | `cws review` (accept / reject), challenge codes for human actions | ✓ |
| 6 SAVE | hash-chained append-only log (`src/store/event-log.ts`) | ✓ |
| 7 HANDOFF | `cws session end` writes "what changed"; `cws next` gives the options | ✓ |

---

## 5. Level 3: sub-steps

Each stage holds collapsed `(…)` blocks. These are designed later, and each one is a smaller Ψ.

---

## 6. Multi-model layer

Every 🟪 role carries a tier, following `.github/agents/Multi-Modal.agent.md`:

- 🧠 **Brain** (higher-capacity model): FRAME, CHECK and review-type roles. Interviewers, Analyst, Planner, Reviewer, Critic.
- 🔧 **Worker** (lower-cost model): bounded WORK. Builder, Researcher legwork, Tester runs.

The brain hands the worker a self-contained assignment and reviews the result before the human sees it. It allows at most 2 corrective retries, then reports the blocker. Lower cost means focused work, not lower quality. ◐ The protocol (`AGENTS.md`) and every prompt carry the tier; picking the actual models depends on your AI tool.

---

## 7. No commands to remember ✓

- The human only ever needs one word: `cws`. At a terminal it opens a guided menu (`src/cli/commands/menu.ts`) that shows the project, the stage ("Stage 1 of 9: Explore"), the session brief, what is waiting for review and the suggested next step. Then it offers:
  `1` start or end a session (it asks for goal, done when and not touching) · `2` write down a thought · `3` what's next (copies a ready prompt) · `4` review AI suggestions · `5` move to another stage · `Enter` quit.
  Every choice runs the normal command, so the human checks and challenge codes still apply.
- Everything else is done by the AI through the `/cws-*` slash commands that `cws install-agents` sets up ✓.
- When a ⭐ human-only step is due, the AI shows the single line to type.
- Challenge codes stay, so I1 holds.

---

## 8. Always-on rules (the physics of the board)

AI = pencil, you = pen · warnings, not walls · nothing is erased · you can always go back · same rules every time, while the methods adapt to the project.
