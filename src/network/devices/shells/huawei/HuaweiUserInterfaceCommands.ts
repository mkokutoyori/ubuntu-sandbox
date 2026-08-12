import type { CommandTrie } from '../CommandTrie';
import { renderTable, type TableColumn, FIXED_TABLE } from '../cli/TextTable';
import { vrpUserInterfaceIndex, type LineKind, type SshSessionRecord } from '../../router/aaa/SshSessionRegistry';
import type { VtyLineConfigStore } from '../../router/vty/VtyLineConfigStore';

export interface UserInterfacePool {
  list(): readonly SshSessionRecord[];
  currentSession(): string | null;
  close(id: string, reason?: string): SshSessionRecord | null;
}

export interface UserInterfaceRow {
  current: boolean;
  index: number;
  kind: LineKind;
  relative: number;
  txRx: string;
  privilege: number;
  actualPrivilege: number;
  auth: 'A' | 'N' | 'P';
}

const CONSOLE_DEFAULT_PRIVILEGE = 15;
const VTY_DEFAULT_PRIVILEGE = 0;

const COLUMNS: ReadonlyArray<TableColumn<UserInterfaceRow>> = [
  { header: '  Idx', width: 9, value: (r) => `${r.current ? '+' : ' '} ${r.index}` },
  { header: 'Type', width: 16, value: (r) => `${r.kind === 'con' ? 'CON' : r.kind === 'aux' ? 'AUX' : 'VTY'} ${r.relative}` },
  { header: 'Tx/Rx', width: 9, value: (r) => r.txRx },
  { header: 'Modem', width: 7, value: () => '-' },
  { header: 'Privi', width: 7, value: (r) => String(r.privilege) },
  { header: 'ActualPrivi', width: 13, value: (r) => String(r.actualPrivilege) },
  { header: 'Auth', width: 7, value: (r) => r.auth },
  { header: 'Int', value: () => '-' },
];

function authLetter(mode: 'password' | 'aaa' | 'none' | undefined): 'A' | 'N' | 'P' {
  if (mode === 'aaa') return 'A';
  if (mode === 'password') return 'P';
  return 'N';
}

export function userInterfaceRows(
  pool: UserInterfacePool | undefined,
  lines: VtyLineConfigStore | undefined,
): UserInterfaceRow[] {
  const sessions = pool?.list() ?? [];
  const current = pool?.currentSession() ?? null;
  const occupant = (kind: LineKind, relative: number): SshSessionRecord | undefined =>
    sessions.find((s) => s.lineKind === kind && s.lineIndex === relative);
  const effectivePrivilege = (held: SshSessionRecord | undefined, configured: number): number =>
    held && held.user !== '' ? held.privilege : configured;

  const console0 = occupant('con', 0);
  const rows: UserInterfaceRow[] = [{
    current: console0 !== undefined && console0.id === current,
    index: vrpUserInterfaceIndex('con', 0),
    kind: 'con',
    relative: 0,
    txRx: '9600',
    privilege: CONSOLE_DEFAULT_PRIVILEGE,
    actualPrivilege: effectivePrivilege(console0, CONSOLE_DEFAULT_PRIVILEGE),
    auth: 'N',
  }];

  const capacity = lines?.lineCapacity() ?? 5;
  for (let i = 0; i < capacity; i++) {
    const block = lines?.all().find((b) => i >= b.first && i <= b.last);
    const held = occupant('vty', i);
    const privilege = block?.privilege ?? VTY_DEFAULT_PRIVILEGE;
    rows.push({
      current: held !== undefined && held.id === current,
      index: vrpUserInterfaceIndex('vty', i),
      kind: 'vty',
      relative: i,
      txRx: '-',
      privilege,
      actualPrivilege: effectivePrivilege(held, privilege),
      auth: authLetter(block?.authenticationMode),
    });
  }
  return rows;
}

export function renderDisplayUserInterface(
  pool: UserInterfacePool | undefined,
  lines: VtyLineConfigStore | undefined,
): string {
  return renderTable(userInterfaceRows(pool, lines), COLUMNS, FIXED_TABLE)
    .map((l) => l.trimEnd())
    .join('\n');
}

export interface FreeTarget { kind: LineKind; relative: number; label: string }

export function parseUserInterfaceTarget(
  args: readonly string[],
  lines: VtyLineConfigStore | undefined,
): FreeTarget | null {
  const words = args.map((a) => a.trim().toLowerCase()).filter((a) => a.length > 0);
  if (words.length === 2) {
    const kind: LineKind | null = words[0] === 'vty' ? 'vty'
      : (words[0] === 'con' || words[0] === 'console') ? 'con'
        : words[0] === 'aux' ? 'aux' : null;
    if (!kind || !/^\d+$/.test(words[1])) return null;
    const relative = Number.parseInt(words[1], 10);
    return { kind, relative, label: `${kind === 'con' ? 'CON' : kind === 'aux' ? 'AUX' : 'VTY'}${relative}` };
  }
  if (words.length !== 1 || !/^\d+$/.test(words[0])) return null;
  const index = Number.parseInt(words[0], 10);
  const capacity = lines?.lineCapacity() ?? 5;
  for (const kind of ['con', 'aux', 'vty'] as const) {
    const count = kind === 'vty' ? capacity : 1;
    for (let i = 0; i < count; i++) {
      if (vrpUserInterfaceIndex(kind, i) === index) {
        return { kind, relative: i, label: `${kind === 'con' ? 'CON' : kind === 'aux' ? 'AUX' : 'VTY'}${i}` };
      }
    }
  }
  return null;
}

export function freeUserInterface(
  pool: UserInterfacePool | undefined,
  lines: VtyLineConfigStore | undefined,
  args: readonly string[],
): string {
  const target = parseUserInterfaceTarget(args, lines);
  if (!target) return 'Error: Wrong parameter found at position 1.';
  const held = pool?.list().find(
    (s) => s.lineKind === target.kind && s.lineIndex === target.relative,
  );
  if (!held) return `Info: User interface ${target.label} is free.`;
  if (held.id === pool?.currentSession()) {
    return `Error: The user interface ${target.label} is the current user interface.`;
  }
  pool?.close(held.id, 'admin');
  return `Warning: User interface ${target.label} will be freed. Do you want to continue? [Y/N]:y\n`
    + `Info: User interface ${target.label} is free.`;
}

export function registerUserInterfaceCommands(
  trie: CommandTrie,
  pool: () => UserInterfacePool | undefined,
  lines: () => VtyLineConfigStore | undefined,
): void {
  trie.registerGreedy('free user-interface', 'Free a user interface', (args) =>
    freeUserInterface(pool(), lines(), args));
  trie.registerGreedy('kill user-interface', 'Free a user interface', (args) =>
    freeUserInterface(pool(), lines(), args));
}
