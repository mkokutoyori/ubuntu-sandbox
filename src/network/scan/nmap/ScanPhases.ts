import type { ScanType } from './NmapOptions';

/**
 * Le nom que `nmap` donne a chaque phase, tel que `scan_lists.cc:529`
 * (`scantype2str`) l'ecrit. Ce sont des libelles attestes et non
 * derivables du nom de l'option : `-sT` s'annonce `Connect Scan`, `-sS`
 * `SYN Stealth Scan`, `-sX` en CAPITALES, `-sM` du nom de son auteur.
 */
export const SCAN_PHASE_NAME: Readonly<Record<ScanType, string>> = {
  tcp: 'Connect Scan',
  syn: 'SYN Stealth Scan',
  ack: 'ACK Scan',
  fin: 'FIN Scan',
  null: 'NULL Scan',
  xmas: 'XMAS Scan',
  maimon: 'Maimon Scan',
  window: 'Window Scan',
  udp: 'UDP Scan',
};

/**
 * La decouverte est une phase a part entiere, et il y en a TROIS : celle
 * qui interroge le lien en IPv4, sa jumelle IPv6, et celle qui envoie des
 * sondes IP. Les distinguer rend visible dans la sortie ce que le lot
 * precedent a rendu vrai — l'ARP REMPLACE les sondes IP au lieu de s'y
 * ajouter.
 */
export const ARP_PING_PHASE = 'ARP Ping Scan';
export const ND_PING_PHASE = 'ND Ping Scan';
export const IP_PING_PHASE = 'Ping Scan';

export interface ScanPhase {
  name: string;
  /** Ce que la phase a compte, et l'unite dans laquelle elle le compte. */
  total: number;
  unit: 'host' | 'port';
  /** La cible et son nombre de sondes, quand la phase en balaye une. */
  scanning?: { target: string; probes: number };
}

function clockHHMM(at: Date): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/**
 * timing.cc:765 et 2777. La duree est celle que le rapport annonce deja
 * par ailleurs : ce simulateur livre ses trames de facon synchrone, donc
 * elle est estimee et non mesuree, et l'inventer differemment ici ferait
 * dire deux choses a une meme sortie.
 */
export function renderPhase(phase: ScanPhase, at: Date, elapsedSeconds: number): string[] {
  const hhmm = clockHHMM(at);
  const lines = [`Initiating ${phase.name} at ${hhmm}`];
  if (phase.scanning) {
    const n = phase.scanning.probes;
    lines.push(`Scanning ${phase.scanning.target} [${n} port${n === 1 ? '' : 's'}]`);
  }
  const unit = `${phase.total} total ${phase.unit}${phase.total === 1 ? '' : 's'}`;
  lines.push(
    `Completed ${phase.name} at ${hhmm}, ${elapsedSeconds.toFixed(2)}s elapsed (${unit})`);
  return lines;
}
