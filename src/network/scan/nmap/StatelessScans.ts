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
