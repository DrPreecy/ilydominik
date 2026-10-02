# Next Session Handoff: Cognitive Work System (CWS)

## Current Entrypoint (2026-10-02)

Start with [README.md](README.md) and [REVIEW.md](REVIEW.md). Root verification
commands now target the canonical event-sourced CLI in `v2/`; use `legacy:*`
scripts for the historical snapshot model. The original material below is
preserved as historical context, not a statement of the current default API.
Code/security audit repairs are integrated and independently reviewed. See
[REVIEW.md](REVIEW.md) for verification and remaining limits, and
[RESEARCH.md](RESEARCH.md) for the network-blocked external research queue.

> **Zweck dieser Datei:**
> Diese Datei ist der direkte Einstiegspunkt („Cold-Start“) für den nächsten Chat. Sie enthält den aktuellen Projektstand, die offenen Systemfragen für das Meta-Operating-Model und die Analyse der besten Open-Source-Agent-Skillsets.

---

## 1. Was in dieser Session gebaut & gesichert wurde (Status Quo)

Alle bisherigen Arbeiten sind im lokalen Git-Repository (`main` Branch) versioniert und getestet:

- **SDD-Architektur & Schemas:**
  - `specs/state-machine-spec.md`: Formale Spezifikation des Zustandsmodells $S_t = (K, U, A, D, C, P)$, Phasenübergänge und Anti-Rationalisierungs-Tabellen.
  - `schemas/project-state.schema.json`: Maschinell validierbares JSON Schema.
  - `src/models/types.ts`: Typisierte Modelle für epistemische Typen (`FACT`, `ASSUMPTION`, `UNKNOWN`, `DECISION`) und Arbeitsereignisse $W_t$.
- **MVP-Rechenkern & Guardrails:**
  - `src/engine/state-store.ts`: Deterministischer State Store mit Übergangsfunktion $S_{t+1} = T(S_t, W_t)$ und JSON-Persistierung.
  - `src/engine/anti-rationalization.ts`: Harte Circuit Breaker (Menschliche Entscheidungshoheit, Evidenzpflicht, Blockade von Phase 7 bei ungetesteten fatalen Annahmen).
  - `src/guidance/next-step-engine.ts`: Generiert automatische, kontextreiche Handlungsempfehlungen.
- **Pre-Made Prompt Catalog (`.github/prompts/`):**
  - `/explore.prompt.md`, `/understand.prompt.md`, `/synthesize.prompt.md`, `/proof-spike.prompt.md`, `/next-step.prompt.md`, `/sdd-implement.prompt.md`.
- **Verifikation:**
  - `tests/state-machine.test.ts`: 7/7 Tests grün (Node 24 Test Runner + TSX).
  - TypeScript Compilation (`tsc --noEmit` & `tsc`) fehlerfrei.

---

## 2. Die System-Fragen für die nächste Session (Das Meta-Operating-Model)

In der nächsten Session soll die **Meta-Ebene** (das „Betriebssystem für die Projektarbeit“) entworfen werden. Folgende System-Fragen bilden den Kern:

1. **Session-Lifecycle:**
   - Wann gilt eine Session als abgeschlossen?
   - Wie sieht die automatisierte Checkliste vor dem Chat-Wechsel aus (Tests -> State Snapshot -> Git Commit -> Handoff-Export)?
2. **Review- & Gatekeeper-Mechanismus:**
   - Wann wird ein Maschinelles Review (KI-Subagent / Linter) getriggert?
   - Wie und wann wird der Mensch als einziger Richtungs-Entscheider konsultiert, ohne ihn mit Code-Details zu überlasten?
3. **Kontext-Transfer ohne Informationsverlust:**
   - Wie liest ein neuer Chat den Projektzustand vollautomatisch in < 3 Sekunden ein, ohne dass der Benutzer Zusammenfassungen schreiben muss?
4. **Git- & Release-Strategie:**
   - Wann wird lokal committet (atomar nach jedem grünen Test)?
   - Wann wird auf Remote gepusht?

---

## 3. GitHub Benchmark: Die besten generischen Agent-Skillsets

Eine Recherche im GitHub-Ökosystem zeigt drei maßgebliche Vorbilder, deren Konzepte wir für das Cognitive Work System adaptieren können:

what are the best generic github skillset, tools etc. for agentic a deep research and browse first over what is exisitng and then secondly a discussion which and how will be used.

---

## 4. Prompt für den Start des neuen Chats

i dont want to have to copy my prompts manually any more and i also dont want to manually keep track ofthe steps and if they were probally made and the next one espscally as if there is nothing as defined steps etc yet so.
