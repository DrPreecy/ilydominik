# ADR 0003 - Google Cloud integration (Gemini, Firebase sync, and dashboard prep)

- Status: accepted (2026-10-03)
- Context: CWS needs AI capabilities (Gemini), multi-device synchronization of project memory, and a web dashboard to visualize project state. The integration must follow a strict €0-first budget philosophy, starting on the Firebase Spark free tier and Gemini API free tier via Google AI Studio keys, with an optional future Stage 2 utilizing Google AI Pro developer credits and tight budget alerts.
- Decision:
  - **Local event log remains canonical**: The local `.cws/events.jsonl` log is the single source of truth. Cloud storage (Firestore) serves strictly as a synchronized copy/replica for multi-device sync and web visualization.
  - **Authority and AI boundaries**: Gemini acts strictly as an AI actor (`ai:gemini`). Per spec §2, it can generate notes, unconfirmed claims (HYPOTHESIS, INTERPRETATION, ASSUMPTION, UNKNOWN), and proposals. It cannot decide, accept proposals, confirm claims, or change phases. All AI responses must validate against schemas, and secrets are masked.
  - **Privacy and consent**: Because Google's free-tier Gemini API may retain prompts for service improvement, CWS requires explicit one-time interactive user consent before dispatching prompts, recording the decision in the event log.
  - **Read-only Dashboard v1**: The web dashboard is strictly read-only to preserve the integrity of interactive human challenge codes. Any modifications must go through the CLI.
  - **Frontend location and workspace split reservation**: The frontend will live in this repository under `web/`. In accordance with `AGENTS.md`, this ADR formally authorizes and reserves `web/` for a workspace split (`pnpm-workspace.yaml` and `web/package.json`), which will be configured when the frontend agent begins implementation. `web/pretotype/` is permitted as a temporary, throwaway HTML/JS test page with no build step and no separate `package.json`.
  - **Browser-safe core logic**: Core domain logic (`fold`, `reduce`, `assess`, `nextSteps`, `verifyChain`, schemas, and types) will be decoupled from Node-specific APIs and exposed via `cws/core` using standard WebCrypto, allowing browser frontends to execute identical state reducers directly.
  - **Credential hygiene**: No API keys, credentials, or tokens may be stored in repository files or in `.cws/`. `GEMINI_API_KEY` is loaded strictly from user environment variables, and authentication tokens are persisted in the user's OS configuration directory.
- Consequences:
  - Offline functionality is preserved; all Google Cloud integrations are opt-in.
  - The CLI gains `cws ai` and `cws sync` command surfaces.
  - `web/` is reserved in repo structure rules; full workspace split will be enacted upon frontend agent onboarding.
