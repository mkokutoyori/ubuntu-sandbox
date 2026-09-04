import { absoluteLineNumber, type LineKind, type SshSessionRecord } from '../../router/aaa/SshSessionRegistry';

export interface LinePool {
  list(): readonly SshSessionRecord[];
  currentSession(): string | null;
  close(id: string, reason?: string): SshSessionRecord | null;
  sessionOnAbsoluteLine(absolute: number): SshSessionRecord | null;
}

export type LinePoolAccessor = () => LinePool | undefined;

export const NOT_CURRENT_LINE = '% Not allowed to clear current line';

export interface LineTarget {
  kind: LineKind | null;
  index: number;
}

const KIND_WORDS: Record<string, LineKind> = {
  con: 'con', console: 'con', aux: 'aux', vty: 'vty',
};

export function parseLineTarget(args: readonly string[]): LineTarget | null {
  const words = args.map((a) => a.trim().toLowerCase()).filter((a) => a.length > 0);
  if (words.length === 0 || words.length > 2) return null;
  if (words.length === 2) {
    const kind = KIND_WORDS[words[0]];
    if (!kind) return null;
    const index = Number.parseInt(words[1], 10);
    if (!Number.isInteger(index) || index < 0 || !/^\d+$/.test(words[1])) return null;
    return { kind, index };
  }
  if (!/^\d+$/.test(words[0])) return null;
  const absolute = Number.parseInt(words[0], 10);
  return { kind: null, index: absolute };
}

export function matchesTarget(session: SshSessionRecord, target: LineTarget): boolean {
  if (target.kind === null) {
    return absoluteLineNumber(session.lineKind, session.lineIndex) === target.index;
  }
  return session.lineKind === target.kind && session.lineIndex === target.index;
}

export function clearLine(pool: LinePool | undefined, args: readonly string[]): string {
  const target = parseLineTarget(args);
  if (!target) return '% Incomplete command.';
  if (!pool) return '[confirm]';
  const current = pool.currentSession();
  const victim = pool.list().find((s) => matchesTarget(s, target)) ?? null;
  if (!victim) return '[confirm]';
  if (victim.id === current) return NOT_CURRENT_LINE;
  pool.close(victim.id, 'admin');
  return '[confirm]\n [OK]';
}

