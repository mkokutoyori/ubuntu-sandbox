import type { StatelessProbeReply } from '@/network/tcp/TcpStack';
import type { PortState } from './ScanEngine';

/**
 * Les balayages TCP de `nmap` qui n'ouvrent RIEN. Chacun se distingue par
 * deux choses seulement : les drapeaux qu'il pose sur son segment, et la
 * facon dont il lit la reponse.
 *
 * Drapeaux (`scan_engine.cc`, `setupProbe`) : Xmas `FIN|URG|PSH`, NULL
 * aucun, FIN `FIN`, Maimon `FIN|ACK`, fenetre `ACK`, SYN `SYN`, ACK
 * `ACK`.
 *
 * Verdict sans reponse (`scan_engine.cc`, `setDefaultPortState`) :
 * `open|filtered` pour FIN, NULL, Xmas et Maimon — leur silence est
 * justement ce qu'ils mesurent — et `filtered` pour SYN, ACK et fenetre.
 *
 * Verdict sur RST (`scan_engine_raw.cc`) : `closed`, sauf le balayage ACK
 * qui rend `unfiltered` et le balayage par fenetre ou c'est la FENETRE du
 * RST qui tranche.
 */
export type StatelessScanKind =
  'syn' | 'ack' | 'fin' | 'null' | 'xmas' | 'maimon' | 'window';

export interface ScanProbeFlags {
  fin: boolean; syn: boolean; rst: boolean; psh: boolean;
  ack: boolean; urg: boolean; ece: boolean; cwr: boolean;
}

function flags(set: Partial<ScanProbeFlags>): ScanProbeFlags {
  return {
    fin: false, syn: false, rst: false, psh: false,
    ack: false, urg: false, ece: false, cwr: false,
    ...set,
  };
}

export const SCAN_PROBE_FLAGS: Readonly<Record<StatelessScanKind, ScanProbeFlags>> = {
  syn: flags({ syn: true }),
  ack: flags({ ack: true }),
  fin: flags({ fin: true }),
  null: flags({}),
  xmas: flags({ fin: true, urg: true, psh: true }),
  maimon: flags({ fin: true, ack: true }),
  window: flags({ ack: true }),
};

/**
 * Les bits du champ de controle TCP, dans l'ordre de la RFC 9293 §3.1.
 * `parse_scanflags` (`nmap.cc:162`) lit un NOMBRE de 0 a 255 ou un
 * amalgame de ces noms, dans un ordre indifferent ; `ALL` vaut 255 et
 * `NONE` remet a zero, deux mots que le code connait et que la page de
 * manuel ne cite pas.
 */
const TCP_FLAG_BITS: ReadonlyArray<[keyof ScanProbeFlags, number, string[]]> = [
  ['fin', 0x01, ['FIN']],
  ['syn', 0x02, ['SYN']],
  ['rst', 0x04, ['RST', 'RESET']],
  ['psh', 0x08, ['PSH', 'PUSH']],
  ['ack', 0x10, ['ACK']],
  ['urg', 0x20, ['URG']],
  ['ece', 0x40, ['ECE']],
  ['cwr', 0x80, ['CWR']],
];

export function flagsFromBits(value: number): ScanProbeFlags {
  const out = flags({});
  for (const [name, bit] of TCP_FLAG_BITS) out[name] = (value & bit) !== 0;
  return out;
}

/** `null` quand la valeur n'est ni un nombre de 0 a 255 ni des noms connus. */
export function parseScanFlags(arg: string): ScanProbeFlags | null {
  if (/^\d/.test(arg)) {
    const value = Number(arg);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    return flagsFromBits(value);
  }
  const upper = arg.toUpperCase();
  let value = 0;
  let matched = false;
  for (const [, bit, names] of TCP_FLAG_BITS) {
    if (names.some((n) => upper.includes(n))) { value |= bit; matched = true; }
  }
  if (upper.includes('ALL')) { value = 255; matched = true; }
  if (upper.includes('NONE')) { value = 0; matched = true; }
  return matched ? flagsFromBits(value) : null;
}

export interface ScanVerdict {
  state: PortState;
  reason: string;
}

export function readStatelessReply(
  kind: StatelessScanKind, reply: StatelessProbeReply,
): ScanVerdict {
  if (reply === 'none') {
    const silenceOpens = kind === 'fin' || kind === 'null'
      || kind === 'xmas' || kind === 'maimon';
    return {
      state: silenceOpens ? 'open|filtered' : 'filtered',
      reason: 'no-response',
    };
  }
  if (reply === 'syn-ack') return { state: 'open', reason: 'syn-ack' };
  if (kind === 'ack') return { state: 'unfiltered', reason: 'reset' };
  if (kind === 'window') {
    return reply === 'rst-window'
      ? { state: 'open', reason: 'reset' }
      : { state: 'closed', reason: 'reset' };
  }
  return { state: 'closed', reason: 'reset' };
}
