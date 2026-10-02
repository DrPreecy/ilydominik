# External Research Queue

Research attempted: 2026-10-02. The requested parallel researcher attempted
22 primary-source URLs. Network domain policy denied every fetch. A separate
documentation agent also lacked external tools. No paper results, current
versions, repository licenses, or external implementation claims were verified.
An explicit cheaper-model selection was not available to the researcher.

This is an investigation queue, not completed evidence-backed research. No
external code, dependency, skill, or MCP server was adopted from these sources.

## Sources To Verify

| Topic | Primary source | Question for CWS |
| --- | --- | --- |
| Durable filesystem operations | [Node filesystem docs](https://nodejs.org/api/fs.html) | What survives termination, and when is an append acknowledged? |
| Local process locking | [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile) | Can stale recovery displace a suspended live writer on Windows? |
| Event sourcing | [Microsoft pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing) | Which replay, schema evolution, and recovery guarantees are needed locally? |
| Portable skill packaging | [Agent Skills specification](https://agentskills.io/specification) | Which metadata and discovery rules are genuinely portable? |
| Repository guidance | [AGENTS.md](https://agents.md/) | How do individual clients resolve instruction precedence? |
| MCP trust boundaries | [MCP documentation](https://modelcontextprotocol.io/) | How should tools, retrieved content, and authorization remain separate? |
| MCP implementations | [Reference servers](https://github.com/modelcontextprotocol/servers) | Does a memory interface preserve evidence provenance and human decisions? |
| Skill examples | [Anthropic skills](https://github.com/anthropics/skills) | Which individual licenses and script permissions apply? |
| Specification workflow | [GitHub Spec Kit](https://github.com/github/spec-kit) | Which artifacts improve traceability without adding unnecessary process? |
| Agent workflow | [Superpowers](https://github.com/obra/superpowers) | Which bounded verification practices fit the existing CLI? |
| Versioned documentation | [Context7](https://github.com/upstash/context7) | What project data leaves the machine, and how is source version recorded? |
| Agent action loops | [ReAct](https://arxiv.org/abs/2210.03629) | Which observable actions and results should be persisted? |
| Feedback memory | [Reflexion](https://arxiv.org/abs/2303.11366) | How should reflections remain distinct from verified facts? |
| Agent interfaces | [SWE-agent](https://arxiv.org/abs/2405.15793) | Which constrained interfaces improve reproducibility? |
| Indirect prompt injection | [Research candidate](https://arxiv.org/abs/2302.12173) | How can imported content avoid being mistaken for permission? |

Links identify attempted or proposed sources only. Titles, dates, versions,
licenses, and findings must be checked against accessible primary material
before being cited as evidence or used to justify copying code.

## Current Recommendations

These follow the local implementation and review, not external findings:

- Retain CLI-first integration, explicit provenance, and human proposal review.
- Keep stored notes and model interpretations separate from authorization.
- Preserve append order and test competing writers, process death, and retries.
- Fail closed when safe lock recovery cannot be established.
- Treat serialized context as untrusted data, not as a complete injection defense.
- Defer MCP integration and broad workflow imports until a concrete need,
  verified permissions, and a security boundary are defined.

The next research pass needs permitted network access or supplied source
snapshots. Pin reviewed repositories to a commit and inspect actual license
files before reuse.
