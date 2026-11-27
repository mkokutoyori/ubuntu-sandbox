import type { Equipment } from '@/network';

export type StepKind = 'shell' | 'sql' | 'rman';

export interface TutorialStep {
  readonly id: string;
  readonly device: string;
  readonly user?: 'root' | 'oracle';
  readonly kind: StepKind;
  readonly input: string;
  readonly expects: readonly RegExp[];
  readonly forbids?: readonly RegExp[];
  readonly capture?: Readonly<Record<string, RegExp>>;
  readonly head?: number;
  readonly tail?: number;
}

export interface TutorialPart {
  readonly command: string;
  readonly output: string;
}

export interface TutorialRecord {
  readonly step: TutorialStep;
  readonly command: string;
  readonly output: string;
  readonly parts: readonly TutorialPart[];
  readonly missing: readonly string[];
  readonly forbidden: readonly string[];
}

export interface TutorialRun {
  readonly records: readonly TutorialRecord[];
  readonly variables: Readonly<Record<string, string>>;
}

interface SessionCapableDevice {
  openShellSession?(options: { user: string }): unknown;
  executeCommandInSession?(command: string, session: unknown): Promise<string>;
  executeCommand(command: string): Promise<string>;
}

const HEREDOC = 'LAB_EOF';

const HEREDOC_START = /<<-?\s*(['"]?)(\w+)\1/;

function shellCommands(input: string): string[] {
  const commands: string[] = [];
  let pending: string[] = [];
  let terminator: string | null = null;
  for (const line of input.split('\n')) {
    pending.push(line);
    if (terminator !== null) {
      if (line.trim() === terminator) { commands.push(pending.join('\n')); pending = []; terminator = null; }
      continue;
    }
    const opening = HEREDOC_START.exec(line);
    if (opening !== null) terminator = opening[2];
    else { commands.push(pending.join('\n')); pending = []; }
  }
  if (pending.length > 0) commands.push(pending.join('\n'));
  return commands;
}

function commandsOf(step: TutorialStep, variables: Readonly<Record<string, string>>): string[] {
  const input = step.input.replace(/\$([A-Z]+)/g, (whole, name: string) => variables[name] ?? whole);
  if (step.kind === 'sql') return [`sqlplus -s / as sysdba <<'${HEREDOC}'\n${input}\n${HEREDOC}`];
  if (step.kind === 'rman') return [`rman target / <<'${HEREDOC}'\n${input}\n${HEREDOC}`];
  return shellCommands(input);
}

export async function runTutorial(devices: ReadonlyMap<string, Equipment>, steps: readonly TutorialStep[]): Promise<TutorialRun> {
  const sessions = new Map<string, unknown>();
  const variables: Record<string, string> = {};
  const records: TutorialRecord[] = [];
  for (const step of steps) {
    const device = devices.get(step.device) as unknown as SessionCapableDevice | undefined;
    if (device === undefined) throw new Error(`tutorial step ${step.id}: no device named ${step.device}`);
    const user = step.user ?? 'root';
    const key = `${step.device}/${user}`;
    if (device.openShellSession !== undefined && !sessions.has(key)) sessions.set(key, device.openShellSession({ user }));
    const commands = commandsOf(step, variables);
    const parts: TutorialPart[] = [];
    for (const single of commands) {
      parts.push({
        command: single,
        output: device.executeCommandInSession !== undefined
          ? await device.executeCommandInSession(single, sessions.get(key))
          : await device.executeCommand(single),
      });
    }
    const command = commands.join('\n');
    const output = parts.map((part) => part.output).filter((text) => text !== '').join('\n');
    for (const [name, pattern] of Object.entries(step.capture ?? {})) {
      const found = pattern.exec(output);
      if (found !== null) variables[name] = found[1];
    }
    records.push({
      step, command, output, parts,
      missing: step.expects.filter((pattern) => !pattern.test(output)).map(String),
      forbidden: (step.forbids ?? []).filter((pattern) => pattern.test(output)).map(String),
    });
  }
  return { records, variables };
}
