
export type SelecteurFacilite = string; // 'local7', '*', 'auth', ...
export type SelecteurSeverite = string; // 'info', '*', 'none', ...

export interface RegleRsyslog {
  readonly selecteurs: ReadonlyArray<{ facilite: SelecteurFacilite; severite: SelecteurSeverite }>;
  readonly fichier: string | null;
  readonly renvoi: { hote: string; port: number; tcp: boolean } | null;
  readonly source: string;
}

export interface EcouteRsyslog {
  readonly protocole: 'udp' | 'tcp';
  readonly port: number;
}

export interface ConfigRsyslog {
  readonly ecoutes: readonly EcouteRsyslog[];
  readonly regles: readonly RegleRsyslog[];
  readonly inclusions: readonly string[];
}

const SEVERITES: Record<string, number> = {
  emerg: 0, panic: 0, alert: 1, crit: 2, err: 3, error: 3,
  warning: 4, warn: 4, notice: 5, info: 6, debug: 7,
};

export function numeroSeverite(nom: string): number | null {
  return SEVERITES[nom.toLowerCase()] ?? null;
}

function cibleFichier(mot: string): string | null {
  const m = mot.startsWith('-') ? mot.slice(1) : mot;
  return m.startsWith('/') ? m : null;
}

function cibleRenvoi(mot: string): RegleRsyslog['renvoi'] {
  const m = /^(@@?)([^:]+)(?::(\d+))?$/.exec(mot);
  if (!m) return null;
  return { hote: m[2], port: m[3] ? Number.parseInt(m[3], 10) : 514, tcp: m[1] === '@@' };
}

export function analyserRsyslog(texte: string): ConfigRsyslog {
  const ecoutes: EcouteRsyslog[] = [];
  const regles: RegleRsyslog[] = [];
  const inclusions: string[] = [];
  const modules = new Set<string>();

  for (const brute of texte.split('\n')) {
    const ligne = brute.trim();
    if (ligne === '' || ligne.startsWith('#')) continue;

    const mod = /^module\s*\(\s*load\s*=\s*"([^"]+)"/.exec(ligne);
    if (mod) { modules.add(mod[1]); continue; }

    const inc = /^\$IncludeConfig\s+(\S+)/.exec(ligne);
    if (inc) { inclusions.push(inc[1]); continue; }

    const input = /^input\s*\(\s*type\s*=\s*"(imudp|imtcp)"([^)]*)\)/.exec(ligne);
    if (input) {
      if (!modules.has(input[1])) continue;
      const p = /port\s*=\s*"?(\d+)"?/.exec(input[2]);
      ecoutes.push({
        protocole: input[1] === 'imudp' ? 'udp' : 'tcp',
        port: p ? Number.parseInt(p[1], 10) : 514,
      });
      continue;
    }

    const modLoad = /^\$ModLoad\s+(\S+)/.exec(ligne);
    if (modLoad) { modules.add(modLoad[1]); continue; }
    const udpRun = /^\$UDPServerRun\s+(\d+)/.exec(ligne);
    if (udpRun && modules.has('imudp')) {
      ecoutes.push({ protocole: 'udp', port: Number.parseInt(udpRun[1], 10) });
      continue;
    }
    const tcpRun = /^\$InputTCPServerRun\s+(\d+)/.exec(ligne);
    if (tcpRun && modules.has('imtcp')) {
      ecoutes.push({ protocole: 'tcp', port: Number.parseInt(tcpRun[1], 10) });
      continue;
    }

    if (ligne.startsWith('$') || ligne.startsWith('template') || ligne.startsWith('action')) continue;

    const parts = ligne.split(/\s+/);
    if (parts.length < 2) continue;
    const selecteurs = parts[0].split(';').map((s) => {
      const [f, sev] = s.split('.');
      return { facilite: (f ?? '*').toLowerCase(), severite: (sev ?? '*').toLowerCase() };
    });
    if (!selecteurs.every((s) => s.facilite.length > 0)) continue;
    const cible = parts.slice(1).join(' ').trim();
    regles.push({
      selecteurs,
      fichier: cibleFichier(cible),
      renvoi: cibleRenvoi(cible),
      source: ligne,
    });
  }
  return { ecoutes, regles, inclusions };
}

export function regleRetient(r: RegleRsyslog, facilite: string, severite: number): boolean {
  let retenu = false;
  for (const s of r.selecteurs) {
    const facilites = s.facilite.split(',').map((f) => f.trim());
    const concerne = facilites.includes('*') || facilites.includes(facilite);
    if (!concerne) continue;
    if (s.severite === 'none') return false;
    if (s.severite === '*') { retenu = true; continue; }
    const seuil = numeroSeverite(s.severite.replace(/^[=!]/, ''));
    if (seuil === null) continue;
    if (s.severite.startsWith('=')) { if (severite === seuil) retenu = true; continue; }
    if (severite <= seuil) retenu = true;
  }
  return retenu;
}
