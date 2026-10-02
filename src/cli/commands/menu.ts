import { CommanderError, type Command } from 'commander';
import { PHASES, type Phase, type ProjectState } from '../../domain/types.ts';
import { nextSteps } from '../../guidance/next-steps.ts';
import { pendingProposals, warningLine } from '../format.ts';
import { CliExit, openLog, projectRoot, say, warn, type Env } from '../human.ts';
import { riskyPhaseWarnings } from '../override.ts';

/** Runs one cws command through the normal command path, so every human check stays in place. */
export type RunCommand = (args: string[]) => Promise<unknown>;

/** The workflow names for the nine phases (docs/workflow.md). */
const STAGE_NAMES: Readonly<Record<Phase, string>> = {
  EXPLORATION: 'Explore',
  UNDERSTANDING: 'Understand',
  SYNTHESIS: 'Synthesize',
  PROOF: 'Prove',
  CONCEPT: 'Concept',
  PLANNING: 'Plan',
  IMPLEMENTATION: 'Build',
  LAUNCH: 'Launch',
  POST_LAUNCH: 'Learn',
};

const MENU_SIZE = 5;

class Cancelled extends Error {}

async function askLine(env: Env, question: string): Promise<string> {
  return (await env.io.ask(question)).trim();
}

/** Asks for a required answer; an empty answer cancels the current choice. */
async function askRequired(env: Env, question: string): Promise<string> {
  const answer = await askLine(env, question);
  if (!answer) throw new Cancelled();
  return answer;
}

function activeSession(state: ProjectState) {
  return state.sessions.find((s) => s.id === state.activeSessionId);
}

function header(state: ProjectState): string[] {
  const stage = PHASES.indexOf(state.phase) + 1;
  const session = activeSession(state);
  const pending = pendingProposals(state).length;
  const top = nextSteps(state, 1)[0];
  return [
    '',
    `${state.title}`,
    `Stage ${stage} of ${PHASES.length}: ${STAGE_NAMES[state.phase]}`,
    session ? `Session: ${session.goal}` : 'Session: none running',
    ...(session?.doneWhen ? [`  done when: ${session.doneWhen}`] : []),
    ...(session?.notTouching ? [`  not touching: ${session.notTouching}`] : []),
    ...(pending > 0 ? [`Waiting for your review: ${pending}`] : []),
    ...(top ? [`Suggested next: ${top.title}`] : []),
  ];
}

function options(state: ProjectState): string[] {
  return [
    '',
    activeSession(state) ? '1  End this session' : '1  Start a session',
    '2  Write down a thought',
    "3  What's next? (copy a ready prompt)",
    '4  Review AI suggestions',
    '5  Move to another stage',
    'Enter  Quit',
  ];
}

async function startOrEndSession(env: Env, state: ProjectState, run: RunCommand): Promise<void> {
  if (activeSession(state)) {
    const summary = await askLine(env, 'What did you get out of it? (Enter for none) ');
    // An empty answer is also what end of input (Ctrl+D) gives, so ending without a summary is asked again.
    if (!summary && (await askLine(env, 'End the session without a summary? (y/N) ')).toLowerCase() !== 'y') throw new Cancelled();
    await run(['session', 'end', ...(summary ? ['--summary', summary] : [])]);
    return;
  }
  const goal = await askRequired(env, 'What do you want to get out of this session? ');
  const done = await askLine(env, 'How will you know it is done? (Enter to skip) ');
  const not = await askLine(env, 'What should stay untouched? (Enter to skip) ');
  // Options first, then `--`, so typed text is never read as a flag.
  await run(['session', 'start', ...(done ? ['--done', done] : []), ...(not ? ['--not', not] : []), '--', goal]);
}

async function writeThought(env: Env, run: RunCommand): Promise<void> {
  const thought = await askRequired(env, "What's on your mind? ");
  await run(['dump', '--', thought]);
}

async function showNext(env: Env, run: RunCommand): Promise<void> {
  await run(['next']);
  const choice = await askLine(env, 'Copy the prompt for option number (Enter to skip): ');
  if (!choice) return;
  if (!/^\d+$/.test(choice)) {
    warn(env, 'Type an option number from the list, or press Enter to skip.');
    return;
  }
  await run(['prompt', choice, '--copy']);
}

async function reviewSuggestions(env: Env, state: ProjectState, run: RunCommand): Promise<void> {
  if (pendingProposals(state).length === 0) {
    say(env, 'Nothing is waiting for your review.');
    return;
  }
  await run(['review']);
}

async function moveStage(env: Env, state: ProjectState, run: RunCommand): Promise<void> {
  say(env, ...PHASES.map((p, i) => `${i + 1}  ${STAGE_NAMES[p]}${p === state.phase ? '  (you are here)' : ''}`));
  const pick = Number(await askRequired(env, 'Move to stage number: '));
  const to = Number.isInteger(pick) ? PHASES[pick - 1] : undefined;
  if (!to) {
    warn(env, `That is not a stage number. Choose 1-${PHASES.length}.`);
    return;
  }
  const reason = await askRequired(env, 'Why move now? ');
  // Ask about risks up front, from the same check `cws phase` uses, instead of guessing from an exit code:
  // a mistyped confirmation code must never turn into a risk override.
  const risks = riskyPhaseWarnings(state, to);
  if (risks.length === 0) {
    await run(['phase', to, '--reason', reason]);
    return;
  }
  say(env, 'There are open risks:', ...risks.map((w) => `  ${warningLine(w)}`));
  const why = await askRequired(env, 'To go ahead anyway, say why (Enter to cancel): ');
  await run(['phase', to, '--reason', reason, '--accept-risk', why]);
}

async function noProject(env: Env, run: RunCommand): Promise<void> {
  say(env, 'No project here yet.', '', '1  Start a project in this folder', 'Enter  Quit');
  if ((await askLine(env, '> ')) !== '1') return;
  const title = await askLine(env, 'What is your idea called? ');
  if (title) await run(['init', '--', title]);
}

async function choose(env: Env, choice: string, state: ProjectState, run: RunCommand): Promise<void> {
  switch (choice) {
    case '1': return startOrEndSession(env, state, run);
    case '2': return writeThought(env, run);
    case '3': return showNext(env, run);
    case '4': return reviewSuggestions(env, state, run);
    case '5': return moveStage(env, state, run);
    default: warn(env, `Choose 1-${MENU_SIZE}, or press Enter to quit.`);
  }
}

/**
 * A failed choice prints its reason and returns to the menu instead of ending it.
 * CliExit and CommanderError have already printed their message before being thrown.
 */
function report(env: Env, error: unknown): void {
  if (error instanceof Cancelled || error instanceof CliExit || error instanceof CommanderError) return;
  warn(env, `error: ${error instanceof Error ? error.message : String(error)}`);
}

async function menu(env: Env, run: RunCommand): Promise<void> {
  if (!projectRoot(env)) await noProject(env, run);
  if (!projectRoot(env)) return;
  for (;;) {
    const state = (await openLog(env)).state;
    say(env, ...header(state), ...options(state));
    const choice = await askLine(env, '> ');
    if (!choice) return;
    try {
      await choose(env, choice, state, run);
    } catch (error: unknown) {
      report(env, error);
    }
  }
}

/** `cws` with no arguments: a guided menu at a terminal, the usual help everywhere else. */
export function registerMenu(program: Command, env: Env, run: RunCommand): void {
  // The root action would otherwise swallow `cws bogus` as an excess argument.
  program.allowExcessArguments(true);
  program.action(async () => {
    const [unknown] = program.args;
    if (unknown !== undefined) {
      program.error(`error: unknown command '${unknown}' (see \`cws --help\`)`, { code: 'commander.unknownCommand' });
    }
    if (!env.io.isInteractive) {
      program.outputHelp();
      return;
    }
    await menu(env, run);
  });
}
