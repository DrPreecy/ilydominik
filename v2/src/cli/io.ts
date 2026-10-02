/**
 * CLI I/O contract. Everything the CLI touches outside the event log goes through here,
 * so tests can simulate a human at a terminal or an agent in a non-interactive shell.
 */
export interface CliIO {
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
  /** true when a person can answer questions (stdin and stdout are a TTY) */
  isInteractive: boolean;
  /** ask the person a question, resolve with their answer line */
  ask(question: string): Promise<string>;
  /** read all of stdin (for `cws dump -` / `cws propose --json -`) */
  readStdin(): Promise<string>;
  /** produce a short random code the human must type back to confirm a decision-level action */
  challenge(): string;
  /** copy text to the clipboard; resolve false when unavailable */
  copy(text: string): Promise<boolean>;
}

export const EXIT = {
  OK: 0,
  ERROR: 1,
  /** a human action was attempted non-interactively, or an override (--accept-risk) is needed */
  NEEDS_HUMAN: 2,
  /** the event log failed its integrity check */
  INTEGRITY: 3,
} as const;
