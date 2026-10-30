import { PsArgumentParser } from './PsArguments';
import { PsDisplay, checkArgumentConflicts } from './PsDisplay';
import type { PsHost } from './PsHost';
import { resetFormatErrorText } from './PsSortFormat';
import { PsState } from './PsState';
import { PsExit } from './PsTypes';

export interface PsOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly interleaved: string;
  readonly exitCode: number;
}

export function runPs(host: PsHost, args: readonly string[]): PsOutcome {
  resetFormatErrorText();
  const state = new PsState(host);
  let exitCode = 0;
  try {
    new PsArgumentParser(state).parse(args);
    checkArgumentConflicts(state);
    new PsDisplay(state).run();
  } catch (error) {
    if (!(error instanceof PsExit)) throw error;
    exitCode = error.code;
  }
  const { stdout, stderr, interleaved } = state.output;
  return { stdout, stderr, interleaved, exitCode };
}
