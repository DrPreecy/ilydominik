## Goal Description
You requested a clean-room design for the Cognitive Work System (CWS) from the perspective of a Senior Google Engineer on a review tribunal. This design is built strictly from the founder's intent (`starttoughts.md`) and the product specification (`docs/spec.md`), remaining entirely blind to the current implementation.

## User Review Required
> [!IMPORTANT]
> Please review the security and UX trade-offs, particularly the cryptographic enforcement of human authority and the read-only nature of the cloud dashboard.

## Open Questions
> [!NOTE]
> 1. Should the read-only dashboard eventually support queuing "Proposals" that the user can later cryptographically sign and approve on their local machine?
> 2. What is the acceptable latency threshold for the ephemeral sandboxing (Command Safety) during the interactive "Accept/Reject" loop?

## Proposed Changes

---

### 1. The Core Data Model
**Design:** An append-only, hash-chained Event Log (Event Sourcing) processed by a pure, deterministic reducer function ($S_{t+1} = T(S_t, W_t)$). The system state is merely a transient projection of this log.
**Rationale:** Provides absolute provenance, cryptographic auditability, and reversible time-travel without complex database schemas or destructive mutations.
**Trade-off:** State reconstruction cost scales linearly with log length, eventually requiring snapshotting logic and adding complexity to rapid state queries.

### 2. Human-vs-AI Authority Enforcement
**Design:** Actor roles (`human` vs `ai:<agent>`) are strictly enforced by the reducer. To prevent an AI with local file access from forging `human` events or reordering history, human events must be cryptographically signed (e.g., HMAC-SHA256 or Ed25519) using a private key stored in the OS keystore (Keychain/Credential Manager), inaccessible to the workspace. High-risk actions also require an interactive challenge code.
**Rationale:** Cryptographic signing physically decouples authority from string labels, ensuring that even a compromised local workspace cannot forge human intent.
**Trade-off:** Introduces friction via interactive challenges and increases onboarding complexity due to OS-level key management requirements.

### 3. Agent Context and Output Reception
**Design:** Agents are treated as pure functions. CWS deterministically generates localized "Context Packs" from the current state (`cws prompt N`). Agents receive this context and output structured data. A strict ingestion pipeline (`cws ai` or `--agent` wrappers) validates the output against JSON schemas and appends it strictly as *unconfirmed* AI claims or proposals.
**Rationale:** Isolates the core system from agent hallucination or prompt injection by forcing all AI output through a typed validation funnel and explicitly marking its provenance.
**Trade-off:** Limits agent autonomy and requires maintaining brittle, parser-heavy integration wrappers for every new model or tool.

### 4. Command Safety (Beyond a Guard)
**Design:** Ephemeral, network-isolated sandboxes (e.g., OpenShell/gVisor/containers) for all execution. No raw host shell access. Network policies are strictly whitelisted via human-approved, signed decisions. A failed sandbox run fails closed (kills the process tree, exits non-zero).
**Rationale:** Execution must happen in a disposable, bounded environment where network egress requires explicit, verifiable human consent, preventing rogue agents from exfiltrating data or running destructive host commands.
**Trade-off:** Significant per-step execution latency, high resource overhead, and massive complexity in supporting cross-platform sandboxing (Windows/WSL, Linux, macOS).

### 5. Secrets Handling
**Design:** Secrets are never stored in the project workspace or event log. They reside exclusively in the OS keystore or an external vault. A mandatory redaction middleware runs on all ingested tool outputs (e.g., SARIF) and outbound context packs to strip keys, tokens, and headers before they touch the log or an LLM context window.
**Rationale:** Ensures the event log remains safe to share, sync, or commit publicly without risking credential leakage.
**Trade-off:** Makes environment setup harder for non-developers and increases the risk of false-positive redactions breaking legitimate log content.

### 6. Cloud Sync and Dashboard
**Design:** CQRS (Command Query Responsibility Segregation) pattern. The local hash-chained event log is the single source of truth and is pushed to a serverless NoSQL document store (Firestore) acting as a mirror. The dashboard is a purely read-only projection of this synced log. Push operations verify ancestry; pull operations validate schemas and the hash chain.
**Rationale:** A hash-chained log enables conflict-free, decentralized mirroring and read-only consumption without requiring a heavy, mutable backend API.
**Trade-off:** The cloud dashboard cannot mutate state; enabling remote actions would require complex asynchronous proposal queues back to the local client for human signing.

### 7. UX for a Non-Developer (Visual Blocks)
**Design:** A GUI shell over the CLI that abstracts the log into a 3-step visual loop:
1. **Dump Thoughts:** A raw text/voice input box (Phase: Exploration).
2. **Review Map:** A visual, block-based graph showing the inferred state (Unknowns in red, Decisions in green, Assumptions in yellow).
3. **Accept/Reject/Modify:** Swiping or clicking blocks to confirm or reject AI proposals, triggering the backend signing challenge.
**Rationale:** Hides the CLI and event log entirely behind a visual state representation, keeping the user's cognitive load on the *project*, not the underlying tooling.
**Trade-off:** Requires building and maintaining a heavy frontend client to translate flat logs into intuitive visual graphs, diverging from the CLI-first MVP approach.

### 8. Deliberately NOT Built (Out of Scope)
**Design:** No autonomous agent orchestration loops, no multi-project workspace views, no complex dependency resolution graphs (beyond basic `derivedFrom` links), and no integrated IDE features.
**Rationale:** Keeps the engineering focus strictly on building a reliable, human-led cognitive scaffolding rather than chasing generalized AI capabilities.
**Trade-off:** Will frustrate power users and developers who expect the tool to autonomously run their projects or manage multi-repository architectures.
