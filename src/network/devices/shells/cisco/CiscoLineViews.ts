
import { renderTableText, type TableColumn, FIXED_TABLE } from '../cli/TextTable';

export interface LigneTty {
  readonly tty: number;
  readonly type: 'CTY' | 'AUX' | 'VTY';
  readonly rang: number;
  readonly courante: boolean;
  readonly uses: number;
}

export interface ReglagesLigne {
  readonly execTimeoutMinutes: number | null;
  readonly execTimeoutSeconds: number | null;
  readonly sessionTimeoutMinutes: number | null;
  readonly absoluteTimeoutMinutes: number | null;
  readonly escapeCharacter: string | null;
  readonly historyEnabled: boolean;
  readonly historySize: number | null;
  readonly transportInput: string | null;
  readonly accessClassIn: string | null;
  readonly screenLengthLines: number | null;
}

export const REGLAGES_PAR_DEFAUT: ReglagesLigne = {
  execTimeoutMinutes: null, execTimeoutSeconds: null,
  sessionTimeoutMinutes: null, absoluteTimeoutMinutes: null,
  escapeCharacter: null, historyEnabled: true, historySize: null,
  transportInput: null, accessClassIn: null, screenLengthLines: null,
};

export interface SessionSurLigne {
  readonly user: string | null;
  readonly depuisMs: number;
}

const HHMMSS = (secondes: number): string => {
  const s = Math.max(0, Math.floor(secondes));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, '0')).join(':');
};

export function delaiExec(r: ReglagesLigne): string {
  if (r.execTimeoutMinutes === null && r.execTimeoutSeconds === null) return '00:10:00';
  const total = (r.execTimeoutMinutes ?? 0) * 60 + (r.execTimeoutSeconds ?? 0);
  return total === 0 ? 'never' : HHMMSS(total);
}

const COLONNES: ReadonlyArray<TableColumn<LigneTty>> = [
  { header: '   Tty', width: 6, align: 'right', value: (l) => (l.courante ? '*' : ' ') + String(l.tty).padStart(5) },
  { header: ' Typ', width: 4, value: (l) => ' ' + l.type },
  { header: '     Tx/Rx', width: 10, value: () => '          ' },
  { header: ' A', width: 2, value: () => '  ' },
  { header: ' Modem', width: 6, value: () => '     -' },
  { header: ' Roty', width: 5, value: () => '    -' },
  { header: ' AccO', width: 5, value: () => '    -' },
  { header: ' AccI', width: 5, value: () => '    -' },
  { header: '  Uses', width: 6, align: 'right', value: (l) => String(l.uses) },
  { header: '  Noise', width: 7, align: 'right', value: () => '0' },
  { header: '  Overruns', width: 10, align: 'right', value: () => '0/0' },
  { header: '  Int', width: 5, align: 'right', value: () => '-' },
];

export function tableauLignes(lignes: readonly LigneTty[]): string {
  return renderTableText(lignes, COLONNES, FIXED_TABLE);
}

export function blocDetailLigne(
  l: LigneTty, r: ReglagesLigne, session: SessionSurLigne | null, maintenantMs: number,
): string[] {
  const nomType = l.type === 'CTY' ? '' : l.type;
  const lignes: string[] = [
    '',
    `Line ${l.tty}, Location: "", Type: "${nomType}"`,
    `Length: ${r.screenLengthLines ?? 24} lines, Width: 80 columns`,
    'Baud rate (TX/RX) is 9600/9600',
    `Status: ${session ? 'Ready, Active, No Exit Banner' : 'No Exit Banner'}`,
    `Capabilities: ${l.type === 'VTY' ? 'none' : 'none'}`,
    'Modem state: Ready',
    'Special Chars: Escape  Hold  Stop  Start  Disconnect  Activation',
    `               ${caractereEchappement(r).padEnd(7)}none  -     -      none        none`,
    'Timeouts:      Idle EXEC    Idle Session   Modem Answer  Session   Dispatch',
    `               ${delaiExec(r).padEnd(13)}${delaiSession(r).padEnd(15)}none          not set   not set`,
    '                              Idle Session Disconnect Warning',
    '                                never',
    '                              Login-sequence User Response',
    '                                00:00:30',
    '                              Autoselect Initial Wait',
    '                                not set',
    'Modem type is unknown.',
    limiteSession(r),
    `Time since activation: ${session ? HHMMSS((maintenantMs - session.depuisMs) / 1000) : 'never'}`,
    'Editing is enabled.',
    ligneHistorique(r),
    'DNS resolution in show commands is enabled',
    'Full user help is disabled',
    `Allowed input transports are ${transportsEntrants(l, r)}.`,
    'Allowed output transports are telnet ssh.',
    'Preferred transport is ssh.',
    'No output characters are padded',
    'No special data dispatching characters',
  ];
  if (r.accessClassIn !== null) {
    lignes.splice(lignes.length - 4, 0, `Access class ${r.accessClassIn} applied to incoming connections.`);
  }
  if (session?.user) lignes.splice(2, 0, `User: ${session.user}`);
  return lignes;
}

function limiteSession(r: ReglagesLigne): string {
  return r.absoluteTimeoutMinutes !== null && r.absoluteTimeoutMinutes > 0
    ? `Session limit is ${r.absoluteTimeoutMinutes} minutes.`
    : 'Session limit is not set.';
}

function delaiSession(r: ReglagesLigne): string {
  return r.sessionTimeoutMinutes !== null && r.sessionTimeoutMinutes > 0
    ? HHMMSS(r.sessionTimeoutMinutes * 60)
    : 'never';
}

function ligneHistorique(r: ReglagesLigne): string {
  if (!r.historyEnabled) return 'History is disabled.';
  return `History is enabled, history size is ${r.historySize ?? 10}.`;
}

function caractereEchappement(r: ReglagesLigne): string {
  const c = r.escapeCharacter;
  if (c === null || c === 'default' || c === 'break') return '^^x';
  if (c === 'none') return 'none';
  if (c === 'soft') return 'soft';
  const code = Number.parseInt(c, 10);
  if (!Number.isFinite(code)) return '^^x';
  if (code === 27) return '^[';
  if (code < 32) return `^${String.fromCharCode(code + 64)}`;
  return String.fromCharCode(code);
}

function transportsEntrants(l: LigneTty, r: ReglagesLigne): string {
  if (l.type !== 'VTY') return 'none';
  switch (r.transportInput) {
    case 'none': return 'none';
    case 'ssh': return 'ssh';
    case 'telnet': return 'telnet';
    case 'all': return 'telnet ssh';
    default: return 'telnet ssh';
  }
}
