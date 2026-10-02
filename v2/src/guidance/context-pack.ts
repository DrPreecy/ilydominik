import type { Claim, Decision, Note, ProjectState, Purpose } from '../domain/types.ts';
import { assess } from './warnings.ts';

const DEFAULT_MAX_NOTES = 20;

export interface ContextOptions {
  focusRefs?: string[];
  maxNotes?: number;
}

const indent = (text: string) => text.replace(/\r?\n/g, '\n  ');

function claimLine(c: Claim, extra = ''): string {
  const meta = [c.type, c.risk ? `risk ${c.risk}` : null, c.status].filter(Boolean).join(', ');
  return `- [${c.id}] (${meta}) ${indent(c.text)}${extra}`;
}

function noteLine(n: Note): string {
  return `- [${n.id}] ${indent(n.text)}`;
}

function decisionLine(d: Decision): string {
  const tag = d.kind === 'PROCEED_UNDER_UNCERTAINTY' ? ' [PROCEEDED UNDER UNCERTAINTY]' : '';
  const rejected = d.rejected.length > 0 ? ` (rejected: ${d.rejected.join(', ')})` : '';
  return `- [${d.id}] ${d.title}: chose ${d.selected} — ${indent(d.rationale)}${rejected}${tag}`;
}

function section(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : [`## ${title}`, ...lines, ''];
}

const isUnconfirmedAi = (c: Claim) => c.createdBy.kind === 'ai' && !c.confirmed;
const isOpen = (c: Claim) => c.status === 'OPEN' || c.status === 'TESTING';

function focusLines(state: ProjectState, refs: string[]): string[] {
  const lines: string[] = [];
  for (const ref of refs) {
    const note = state.notes.find((n) => n.id === ref);
    const claim = state.claims.find((c) => c.id === ref);
    const decision = state.decisions.find((d) => d.id === ref);
    if (note) lines.push(noteLine(note));
    else if (claim) lines.push(claimLine(claim, isUnconfirmedAi(claim) ? ' [unconfirmed AI guess]' : ''));
    else if (decision) lines.push(decisionLine(decision));
  }
  return lines;
}

function unprocessedNotes(state: ProjectState, max: number): string[] {
  const used = new Set(state.claims.flatMap((c) => c.derivedFrom));
  return state.notes.filter((n) => !used.has(n.id)).slice(-max).map(noteLine);
}

function openQuestionLines(claims: Claim[]): string[] {
  return claims
    .filter((c) => c.type === 'UNKNOWN' && (isOpen(c) || c.status === 'ANSWERED'))
    .map((c) => (c.status === 'ANSWERED' ? `${claimLine(c)} — answered: ${indent(c.answer ?? '(no answer text)')}` : claimLine(c)));
}

function aiLines(claims: Claim[]): string[] {
  return claims.filter(isUnconfirmedAi).map((c) => {
    const agent = c.createdBy.kind === 'ai' ? c.createdBy.agent : 'unknown';
    return claimLine(c, ` — suggested by ${agent}`);
  });
}

function claimSections(claims: Claim[]): string[] {
  const own = claims.filter((c) => !isUnconfirmedAi(c));
  const ofType = (...types: Claim['type'][]) => own.filter((c) => types.includes(c.type));
  return [
    ...section('What the user said', ofType('USER_STATEMENT').map((c) => claimLine(c))),
    ...section('Facts', ofType('FACT').map((c) => claimLine(c, ` — ${c.evidence.length} evidence/source item(s)`))),
    ...section('Interpretations (confirmed)', ofType('INTERPRETATION').map((c) => claimLine(c))),
    ...section('Assumptions & hypotheses', ofType('ASSUMPTION', 'HYPOTHESIS').map((c) => claimLine(c))),
    ...section('Open questions', openQuestionLines(own)),
    ...section('AI interpretations (unconfirmed)', aiLines(claims)),
  ];
}

const HOW_TO_RECORD = [
  '## How to record your results',
  'Use these commands (replace <your-name> with your agent name):',
  '- `cws dump --agent <your-name> "<the user\'s exact words>"` — save the user\'s raw words verbatim.',
  '- `cws claim add --agent <your-name> --type INTERPRETATION|ASSUMPTION|HYPOTHESIS|UNKNOWN --text "..." [--risk LOW|MEDIUM|HIGH|FATAL] [--from <ids>]` — record your own interpretation, assumption, hypothesis or open question.',
  '- `cws evidence add --agent <your-name> --claim <id> --text "..." [--source <url or reference>]` — attach evidence to an existing claim.',
  '- `cws propose --agent <your-name> --json -` — suggest anything else, reading a JSON array from stdin, e.g. `[{"item":{"kind":"claim","type":"USER_STATEMENT","text":"..."},"rationale":"..."}]`.',
  '  Item kinds: `claim` (any type, including FACT and USER_STATEMENT), `status` {claimId,status,evidence?,answer?}, `decision` {title,options,selected,rationale,links?}, `phase` {to,reason}.',
  '',
  'You never record facts, user statements, decisions, status or phase changes directly — propose them; the human accepts or rejects them with `cws review`.',
];

export function buildContext(state: ProjectState, purpose: Purpose, opts: ContextOptions = {}): string {
  const session = state.sessions.find((s) => s.id === state.activeSessionId);
  const claims = state.claims.filter((c) => c.status !== 'RETIRED');
  const decisions = state.decisions.map(decisionLine);
  const warnings = assess(state).map((w) => `- (${w.severity}) ${w.message}`);
  const lines = [
    `# Project context: ${state.title}`,
    `Phase: ${state.phase} · Purpose: ${purpose} · Session goal: ${session ? session.goal : 'no active session'}`,
    '',
    ...section('Focus', focusLines(state, opts.focusRefs ?? [])),
    ...section('Unprocessed notes', unprocessedNotes(state, opts.maxNotes ?? DEFAULT_MAX_NOTES)),
    ...claimSections(claims),
    ...section('Decisions', decisions),
    ...section('Warnings', warnings),
    ...HOW_TO_RECORD,
  ];
  return `${lines.join('\n')}\n`;
}
