
import { formatLocalTime } from '../system/SystemInfo';
import type { PortSpec } from '../../../core/ports/PortNumber';
import type { ListenerIdentity } from '../../../tcp/ListenerSocketSink';
import type { ServiceSocketServer } from '../ports/ServiceSocketServer';
import {
  analyserRsyslog, regleRetient, numeroSeverite,
  type ConfigRsyslog, type RegleRsyslog,
} from './RsyslogConfig';
import { RSYSLOG_CONF_PATH } from './RsyslogFiles';
import { SYSLOG_FACILITY } from '../../../syslog/types';

export interface RsyslogHost {
  lireFichier(chemin: string): string | null;
  ecrireLigne(chemin: string, ligne: string): void;
  listerRepertoire(chemin: string): string[];
  ecouterUdp(port: number, onDatagram: (source: string, charge: string) => void): (() => void) | null;
  ecouterTcp(port: number, onMessage: (source: string, charge: string) => void): (() => void) | null;
  hostname(): string;
  maintenant(): number;
  fuseau?(): string | undefined;
}

const NOM_FACILITE: Record<number, string> = Object.fromEntries(
  Object.entries(SYSLOG_FACILITY).map(([nom, num]) => [num, nom]),
) as Record<number, string>;

const ENTETE_3164 = /^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})(?:\.\d+)?\s+(\S+)\s+(.*)$/s;

export function analyserMessageRecu(brut: string): {
  facilite: string; severite: number; reste: string;
} {
  const m = /^<(\d+)>\s*(.*)$/s.exec(brut.trim());
  if (!m) return { facilite: 'user', severite: 5, reste: brut.trim() };
  const pri = Number.parseInt(m[1], 10);
  return {
    facilite: NOM_FACILITE[Math.floor(pri / 8)] ?? 'local7',
    severite: pri % 8,
    reste: m[2],
  };
}

export class LinuxRsyslogService implements ServiceSocketServer {
  private config: ConfigRsyslog = { ecoutes: [], regles: [], inclusions: [] };
  private readonly fermetures = new Map<string, () => void>();

  constructor(private readonly host: RsyslogHost) {}

  recharger(): void {
    const principal = this.host.lireFichier(RSYSLOG_CONF_PATH);
    if (principal === null) {
      this.config = { ecoutes: [], regles: [], inclusions: [] };
      return;
    }
    const base = analyserRsyslog(principal);
    const ecoutes = [...base.ecoutes];
    const regles = [...base.regles];
    for (const motif of base.inclusions) {
      const rep = motif.replace(/\/\*\.conf$/, '');
      for (const nom of this.host.listerRepertoire(rep).sort()) {
        if (!nom.endsWith('.conf')) continue;
        const texte = this.host.lireFichier(`${rep}/${nom}`);
        if (texte === null) continue;
        const sup = analyserRsyslog(texte);
        ecoutes.push(...sup.ecoutes);
        regles.push(...sup.regles);
      }
    }
    this.config = { ecoutes, regles, inclusions: base.inclusions };
  }

  listeningSockets(): Array<{ port: number; protocol: 'udp' | 'tcp' }> {
    const seen = new Map<string, { port: number; protocol: 'udp' | 'tcp' }>();
    for (const e of this.config.ecoutes) seen.set(`${e.protocole}:${e.port}`, { port: e.port, protocol: e.protocole === 'tcp' ? 'tcp' : 'udp' });
    return [...seen.values()].sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
  }

  listeningPorts(): number[] {
    return [...new Set(this.config.ecoutes.map((e) => e.port))].sort((a, b) => a - b);
  }

  configuration(): ConfigRsyslog { return this.config; }

  open(spec: PortSpec, _identity?: ListenerIdentity): boolean {
    this.recharger();
    const voulu = this.config.ecoutes.find(
      (e) => e.port === spec.port && e.protocole === (spec.protocol === 'tcp' ? 'tcp' : 'udp'),
    );
    if (!voulu) return false;
    const key = `${voulu.protocole}:${spec.port}`;
    if (this.fermetures.has(key)) return true;
    const receive = (src: string, charge: string): void => this.recevoir(src, charge);
    const off = voulu.protocole === 'tcp' ? this.host.ecouterTcp(spec.port, receive) : this.host.ecouterUdp(spec.port, receive);
    if (!off) return false;
    this.fermetures.set(key, off);
    return true;
  }

  close(spec: PortSpec): void {
    const key = `${spec.protocol === 'tcp' ? 'tcp' : 'udp'}:${spec.port}`;
    this.fermetures.get(key)?.();
    this.fermetures.delete(key);
  }

  stopAll(): void {
    for (const off of this.fermetures.values()) off();
    this.fermetures.clear();
  }

  recevoir(sourceIp: string, charge: string): void {
    const { facilite, severite, reste } = analyserMessageRecu(charge);
    const entete = ENTETE_3164.exec(reste);
    const hote = entete ? entete[2] : sourceIp;
    for (const r of this.config.regles) {
      if (!regleRetient(r, facilite, severite)) continue;
      if (r.fichier === null) continue;
      this.host.ecrireLigne(
        this.resoudreChemin(r.fichier, sourceIp, hote), this.ligneRecue(sourceIp, reste));
    }
  }

  verifierConfiguration(): { verdict: 'ok' | 'faute'; erreur: string } {
    const principal = this.host.lireFichier(RSYSLOG_CONF_PATH);
    if (principal === null) {
      return {
        verdict: 'faute',
        erreur: "rsyslogd: error: could not open config file '/etc/rsyslog.conf': "
          + 'No such file or directory',
      };
    }
    const textes = [principal];
    for (const motif of analyserRsyslog(principal).inclusions) {
      const rep = motif.replace(/\/\*\.conf$/, '');
      for (const nom of this.host.listerRepertoire(rep).sort()) {
        if (!nom.endsWith('.conf')) continue;
        const t = this.host.lireFichier(`${rep}/${nom}`);
        if (t !== null) textes.push(t);
      }
    }
    for (const texte of textes) {
      const faute = premiereFaute(texte);
      if (faute) return { verdict: 'faute', erreur: faute };
    }
    return { verdict: 'ok', erreur: '' };
  }

  reglesPour(facilite: string, severite: number): RegleRsyslog[] {
    return this.config.regles.filter((r) => regleRetient(r, facilite, severite));
  }

  private resoudreChemin(gabarit: string, sourceIp: string, hote: string): string {
    const at = (format: string) => formatLocalTime(format, this.host.maintenant(), this.host.fuseau?.());
    return gabarit
      .replace(/%FROMHOST-IP%/g, sourceIp)
      .replace(/%HOSTNAME%/g, hote)
      .replace(/%FROMHOST%/g, sourceIp)
      .replace(/%\$YEAR%/g, at('%Y'))
      .replace(/%\$MONTH%/g, at('%m'))
      .replace(/%\$DAY%/g, at('%d'));
  }

  private ligneRecue(sourceIp: string, corps: string): string {
    const m = ENTETE_3164.exec(corps);
    if (m) return `${m[1]} ${m[2]} ${m[3]}`;
    const horodatage = formatLocalTime('%b %e %H:%M:%S', this.host.maintenant(), this.host.fuseau?.());
    return `${horodatage} ${sourceIp} ${corps}`;
  }
}

function premiereFaute(texte: string): string | null {
  let n = 0;
  for (const brute of texte.split('\n')) {
    n += 1;
    const ligne = brute.trim();
    if (ligne === '' || ligne.startsWith('#') || ligne.startsWith('$')) continue;
    if (/^(module|input|template|action)\s*\(/.test(ligne)) continue;
    const parts = ligne.split(/\s+/);
    if (parts.length < 2) continue;
    if (!/^[a-z0-9*,.;=!]+$/i.test(parts[0])) continue;
    for (const sel of parts[0].split(';')) {
      const [, sev] = sel.split('.');
      if (sev === undefined) continue;
      const nom = sev.toLowerCase().replace(/^[=!]/, '');
      if (nom === '*' || nom === 'none' || nom === '') continue;
      if (numeroSeverite(nom) === null) {
        return `rsyslogd: unknown priority name "${sev}" [line ${n}]`;
      }
    }
  }
  return null;
}
