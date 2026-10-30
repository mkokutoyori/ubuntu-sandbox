import type { EditorFsContext } from './EditorFsContext';
import type { EditorSession } from './EditorView';

export interface FullScreenHost {
  readonly fs: EditorFsContext;
  readonly owner: string;
  readonly windowSize: { readonly rows: number; readonly cols: number };
  runCommand(commandLine: string): Promise<string>;
}

export interface FullScreenProgram<L = unknown> {
  readonly name: string;
  parse(commandLine: string): L | null;
  open(host: FullScreenHost, launch: L): EditorSession | null | Promise<EditorSession | null>;
}

const programs: FullScreenProgram[] = [];

export function registerFullScreenProgram<L>(program: FullScreenProgram<L>): void {
  if (programs.some((known) => known.name === program.name)) return;
  programs.push(program as FullScreenProgram);
}

export function matchFullScreenProgram(commandLine: string): string | null {
  for (const program of programs) {
    if (program.parse(commandLine) !== null) return program.name;
  }
  return null;
}

export async function openFullScreenProgram(commandLine: string, host: FullScreenHost): Promise<EditorSession | null> {
  for (const program of programs) {
    const launch = program.parse(commandLine);
    if (launch !== null) return program.open(host, launch);
  }
  return null;
}
