# Next Session Handoff: Cognitive Work System (CWS)

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

### A. `obra/superpowers` (294k+ ⭐) – *Der Goldstandard für SDLC-Workflows*
- **Kernkonzept:** Zwingt den Agenten in deterministische Best Practices, bevor Code geschrieben wird.
- **Wichtigste Skills:**
  - `brainstorming`: Sokratische Entschlüsselung vager Ideen in kleine, lesbare Design-Häppchen.
  - `writing-plans`: Zerlegung in mundgerechte 2–5-Minuten-Tasks mit exakten Pfaden und Verifikationstests.
  - `subagent-driven-development`: Trennung von Planer, Builder und Reviewer.
  - `test-driven-development`: Harter Red-Green-Refactor-Zwang (Code ohne Test wird gelöscht).
  - `requesting-code-review`: Strikte Review-Checkliste gegen den Plan vor dem Merge.

### B. `WorldFlowAI/everything-claude-code` (ECC) & `agent-sh/agentsys`
- **Kernkonzept:** Modularer Werkzeugkasten aus spezialisierten Rollen-Agenten (Architect, Reviewer, Performance Optimizer, Security Auditor) und Hooks.
- **Relevanz für CWS:** Progressive Context Disclosure – der Agent lädt nur die Regeln und Skills, die für die aktuelle Phase nötig sind.

### C. `thedotmack/claude-mem` & `coleam00/claude-memory-compiler`
- **Kernkonzept:** Persistent Context across Sessions.
- **Relevanz für CWS:** Automatische Extraktion von Entscheidungen und Lessons Learned nach jeder Sitzung, Kompilierung in einen strukturierten Wissensgraphen.

---

## 4. Prompt für den Start des neuen Chats

Kopiere einfach diesen Prompt in das Eingabefeld der neuen Session:

```markdown
Ich starte eine neue Session am Cognitive Work System (CWS).
Bitte lies zuerst die Datei `NEXT_SESSION.md` und `specs/state-machine-spec.md` ein.
Unser heutiger Fokus:
1. Führe mit mir ein strukturiertes sokratisches Interview zu den offenen System-Fragen des Meta-Operating-Models (Session-Lifecycle, Review-Gates, Kontext-Transfer).
2. Evaluiere mit mir, welche Muster aus `obra/superpowers` und `claude-mem` wir nativ in unser System übernehmen.
3. Formuliere die Antworten als verbindliche Spezifikation `specs/meta-operating-model.md`.
```
