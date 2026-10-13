import { parseNanoCommandLine } from '@/network/devices/linux/editors/nano/NanoCommandLine';
import { defaultNanoSettings, type NanoSettings } from '@/network/devices/linux/editors/nano/NanoSettings';
import { replayNanoScreenCase, type NanoScreenCase } from './nanoScreenReplay';

export interface NanoCliCase extends NanoScreenCase {
  args: string[];
  opens: boolean;
  status: number;
  stdout?: string;
  stderr?: string;
}

const SCREEN_PORTED_FLAGS: ReadonlySet<string> = new Set(['view', 'constantshow', 'linenumbers', 'softwrap', 'nohelp', 'emptyline', 'stateflags', 'minibar', 'zero']);

export function screenIsPorted(args: readonly string[]): boolean {
  const invocation = parseNanoCommandLine(args);
  if (invocation.kind !== 'open' || invocation.files.length > 1) return false;
  const defaults = defaultNanoSettings();
  const differing = (Object.keys(defaults) as (keyof NanoSettings)[]).filter((key) => invocation.settings[key] !== defaults[key]);
  return differing.every((key) => SCREEN_PORTED_FLAGS.has(key));
}

export function replayNanoCliCase(c: NanoCliCase): string | null {
  const invocation = parseNanoCommandLine(c.args);
  if (!c.opens) {
    const got = invocation.kind === 'open'
      ? { status: 'opens', stdout: '', stderr: '' }
      : invocation.kind === 'print'
        ? { status: 0, stdout: invocation.stdout, stderr: '' }
        : { status: 1, stdout: invocation.stdout, stderr: invocation.stderr };
    const want = { status: c.status, stdout: c.stdout ?? '', stderr: c.stderr ?? '' };
    return JSON.stringify(got) === JSON.stringify(want) ? null : `${c.id} ${JSON.stringify(c.args)}\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`;
  }
  if (invocation.kind !== 'open') return `${c.id} ${JSON.stringify(c.args)} should open the editor, got ${invocation.kind}`;
  return screenIsPorted(c.args) ? replayNanoScreenCase(c) : null;
}

