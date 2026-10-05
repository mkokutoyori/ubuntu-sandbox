export const SHELL_INFO_REQUEST = 'shell-info@ubuntu-sandbox.local';
export const LINE_RESULT_REQUEST = 'line-result@ubuntu-sandbox.local';
export const STREAM_BEGIN_REQUEST = 'stream-begin@ubuntu-sandbox.local';
export const COMPLETE_REQUEST = 'complete@ubuntu-sandbox.local';
export const COMPLETE_RESULT_REQUEST = 'complete-result@ubuntu-sandbox.local';
export const EDITOR_REQUEST = 'editor@ubuntu-sandbox.local';
export const EDITOR_VIEW_REQUEST = 'editor-view@ubuntu-sandbox.local';

export const TTY_OP_ECHO = 53;
export const TTY_OP_ONLCR = 72;

export interface ShellInfoPayload {
  readonly inlineHelp: boolean;
  readonly prompt: string | null;
  readonly posixShell: boolean;
  readonly motd: string | null;
  readonly bannerBytes: number;
}

export interface LineResultPayload {
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly exitCode: number;
  readonly prompt: string | null;
  readonly nested: boolean;
  readonly clearScreen: boolean;
  readonly pendingInput: { kind: 'password' | 'text'; promptText: string } | null;
  readonly sessionEnded: boolean;
}

export type EditorAction =
  | { readonly action: 'open'; readonly commandLine: string }
  | { readonly action: 'key'; readonly key: unknown }
  | { readonly action: 'paste'; readonly text: string }
  | { readonly action: 'cursor'; readonly offset: number }
  | { readonly action: 'close' };

export function parseTerminalModes(modes: Uint8Array): Map<number, number> {
  const parsed = new Map<number, number>();
  let offset = 0;
  while (offset < modes.length && modes[offset] !== 0 && modes[offset] < 160) {
    if (offset + 5 > modes.length) break;
    const value = ((modes[offset + 1] << 24) | (modes[offset + 2] << 16) | (modes[offset + 3] << 8) | modes[offset + 4]) >>> 0;
    parsed.set(modes[offset], value);
    offset += 5;
  }
  return parsed;
}

export function encodeTerminalModes(modes: ReadonlyMap<number, number>): Uint8Array {
  const out: number[] = [];
  for (const [opcode, value] of modes) {
    out.push(opcode, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }
  out.push(0);
  return new Uint8Array(out);
}
