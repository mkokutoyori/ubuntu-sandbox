
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
  hostname(): string;
  maintenant(): number;
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
  private readonly fermetures = new Map<number, () => void>();

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
    if (this.fermetures.has(spec.port)) return true;
    const off = this.host.ecouterUdp(spec.port, (src, charge) => this.recevoir(src, charge));
    if (!off) return false;
    this.fermetures.set(spec.port, off);
    return true;
  }

  close(spec: PortSpec): void {
    this.fermetures.get(spec.port)?.();
    this.fermetures.delete(spec.port);
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
    const d = new Date(this.host.maintenant());
    const deuxChiffres = (n: number) => String(n).padStart(2, '0');
    return gabarit
      .replace(/%FROMHOST-IP%/g, sourceIp)
      .replace(/%HOSTNAME%/g, hote)
      .replace(/%FROMHOST%/g, sourceIp)
      .replace(/%\$YEAR%/g, String(d.getFullYear()))
      .replace(/%\$MONTH%/g, deuxChiffres(d.getMonth() + 1))
      .replace(/%\$DAY%/g, deuxChiffres(d.getDate()));
  }

  private ligneRecue(sourceIp: string, corps: string): string {
    const m = ENTETE_3164.exec(corps);
    if (m) return `${m[1]} ${m[2]} ${m[3]}`;
    const d = new Date(this.host.maintenant());
    const MOIS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const hh = (n: number) => String(n).padStart(2, '0');
    const horodatage = `${MOIS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} `
      + `${hh(d.getHours())}:${hh(d.getMinutes())}:${hh(d.getSeconds())}`;
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
