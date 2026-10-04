import { EventLog } from '../../../src/store/event-log.ts';

const [dir, worker, countArg, kind] = process.argv.slice(2) as [string, string, string, string?];
const count = Number(countArg);
const log = await EventLog.open(dir);
let failures = 0;
const messages = new Set<string>();
for (let i = 0; i < count; i++) {
  try {
    await log.append({ type: 'NOTE_ADDED', actor: kind === 'ai' ? { kind: 'ai', agent: 'w' + worker } : { kind: 'human' }, payload: { noteId: `n_${worker}_${i}`, text: `w${worker} #${i}` } });
  } catch (error) {
    failures++;
    messages.add(error instanceof Error ? error.message.slice(0, 120) : String(error));
  }
}
process.stdout.write(JSON.stringify({ worker, failures, messages: [...messages] }));
