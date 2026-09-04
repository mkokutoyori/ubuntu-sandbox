import type { NmapOptions } from './NmapOptions';
import type { HostReport, NmapReport, PortResult } from './ScanEngine';
import { renderPhase } from './ScanPhases';
import { renderTrace } from './Traceroute';

const NMAP_BANNER = 'Starting Nmap 7.94 ( https://nmap.org )';

/**
 * `num_to_string_sigdigits` (`output.cc:1362`) : arrondir a la puissance
 * de dix qui laisse `digits` chiffres significatifs, remettre l'echelle,
 * puis imprimer avec exactement `MAX(0, -shift)` decimales.
 *
 * Le second temps est ce qui ne se devine pas — c'est lui qui fait sortir
 * `1200` pour 1234 et `0.15` pour 0,15, la ou `toPrecision(2)` rendrait
 * `1.2e+3`.
 */
export function numToStringSigdigits(value: number, digits: number): string {
  let d = value;
  let shift: number;
  if (d === 0) {
    shift = -digits;
  } else {
    shift = Math.floor(Math.log10(Math.abs(d))) - digits + 1;
    d = Math.floor(d / 10 ** shift + 0.5) * 10 ** shift;
  }
  return d.toFixed(Math.max(0, -shift));
}

/** Le compteur d'aller-retour est en millisecondes, la sortie en secondes. */
function latencyText(latencyMs: number): string {
  return numToStringSigdigits(latencyMs / 1000, 2);
}

/**
 * `Target::NameIP` (Target.cc:364) : le nom TAPE par l'operateur
 * l'emporte, sinon le nom resolu, sinon l'adresse nue.
 */
function hostLabel(host: HostReport): string {
  const name = host.hostname ?? host.rdnsName;
  return name ? `${name} (${host.ip})` : host.ip;
}

/**
 * output.cc:1408 : la ligne n'existe QUE lorsque l'operateur a tape un nom
 * et que la resolution inverse en rend un AUTRE — elle dit precisement
 * cette divergence, et la rendre sinon serait repeter l'en-tete.
 */
function rdnsLine(host: HostReport): string | null {
  if (!host.hostname || !host.rdnsName) return null;
  if (host.hostname === host.rdnsName) return null;
  return `rDNS record for ${host.ip}: ${host.rdnsName}`;
}

function pluralPorts(n: number): string {
  return n === 1 ? 'port' : 'ports';
}

/**
 * `output.cc:594` : `%d %s %s %s%s (%s)` — compte, etat, PROTOCOLE,
 * « port »/« ports », puis la RAISON entre parentheses. Sans elle la
 * ligne ne dit pas si le port s'est tu ou a repondu, c'est-a-dire ne dit
 * rien de ce qui se diagnostique.
 */
function notShownLine(host: HostReport): string | null {
  if (!host.notShown) return null;
  const parts = host.notShown.groups.map((g) =>
    `${g.ports.length} ${g.state} ${g.protocol} ${pluralPorts(g.ports.length)} (${g.reason})`);
  return `Not shown: ${parts.join(', ')}`;
}

function columns(options: NmapOptions): { headers: string[]; cell: (p: PortResult) => string[] } {
  const headers = ['PORT', 'STATE', 'SERVICE'];
  if (options.showReason) headers.push('REASON');
  if (options.versionScan) headers.push('VERSION');
  const cell = (p: PortResult): string[] => {
    const row = [`${p.port}/${p.protocol}`, p.state, p.service];
    if (options.showReason) row.push(p.reason);
    if (options.versionScan) row.push(p.version ?? '');
    return row;
  };
  return { headers, cell };
}

function renderTable(host: HostReport, options: NmapOptions): string[] {
  if (host.ports.length === 0) return [];
  const { headers, cell } = columns(options);
  const rows = host.ports.map(cell);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => (i < cells.length - 1 ? c.padEnd(widths[i] + 1) : c)).join('').trimEnd();
  return [line(headers), ...rows.map(line)];
}

function renderHost(host: HostReport, options: NmapOptions): string[] {
  // output.cc:1390 : un hote MORT porte sa raison DANS le crochet, ce qui
  // est le seul endroit ou elle puisse tenir — il n'y a pas de ligne
  // d'etat pour l'accueillir.
  const down = options.showReason
    ? ` [host down, received ${host.downReason ?? 'no-response'}]`
    : ' [host down]';
  const lines: string[] = [`Nmap scan report for ${hostLabel(host)}${host.up ? '' : down}`];
  const rdns = rdnsLine(host);
  if (rdns) lines.push(rdns);
  if (!host.up) {
    lines.push('Note: Host seems down. If it is really up, but blocking our ping probes, try -Pn');
    return lines;
  }
  // output.cc, `write_host_header` : la raison se glisse entre l'etat et
  // la latence, et le TTL de la reponse la suit quand elle en portait un
  // — `Host is up, received echo-reply ttl 64 (0.00058s latency).`
  const received = options.showReason && host.discoveryReason
    ? `, received ${host.discoveryReason}` : '';
  const ttl = options.showReason && host.replyTtl ? ` ttl ${host.replyTtl}` : '';
  lines.push(`Host is up${received}${ttl} (${latencyText(host.latencyMs)}s latency).`);
  const notShown = notShownLine(host);
  if (notShown) lines.push(notShown);
  lines.push(...renderTable(host, options));
  // nmap.cc:2339 : `printmacinfo` vient APRES la table des ports et AVANT
  // `printosscanoutput`. Le constructeur est `Unknown` par demonstration
  // et non par defaut — `MACPrefix2Corp` ne cherche que dans les prefixes
  // enregistres a l'IEEE, et toute adresse de ce simulateur porte le bit
  // local (RFC 7042 §2.1), donc aucune n'y figure.
  if (host.mac) lines.push(`MAC Address: ${host.mac.toUpperCase()} (Unknown)`);
  if (options.osScan && host.osGuess) {
    lines.push(`OS details: ${host.osGuess}`);
  }
  // nmap.cc:2345 : la trace vient apres l'identification du service et
  // avant les temps, et un hote sans aucun saut n'a pas de section.
  if (host.trace) lines.push(...renderTrace(host.trace, host.ip));
  return lines;
}

export function totalSeconds(report: NmapReport): number {
  return Math.max(0.02, report.targetsScanned * 0.05);
}

function phaseSeconds(report: NmapReport): number {
  return report.phases.length === 0 ? 0 : totalSeconds(report) / report.phases.length;
}

function tally(report: NmapReport): string {
  const ips = `${report.targetsScanned} IP ${report.targetsScanned === 1 ? 'address' : 'addresses'}`;
  const up = `${report.hostsUp} ${report.hostsUp === 1 ? 'host up' : 'hosts up'}`;
  return `Nmap done: ${ips} (${up}) scanned in ${totalSeconds(report).toFixed(2)} seconds`;
}

export function renderNormal(report: NmapReport, options: NmapOptions, _commandLine: string): string {
  const lines: string[] = [NMAP_BANNER];
  for (const target of report.unresolved) lines.push(`Failed to resolve "${target}".`);
  if (options.verbose) {
    const at = new Date(report.startedAt);
    // Une phase ne mesure rien ici — les trames sont livrees de facon
    // synchrone — donc sa duree est celle que le rapport annonce deja,
    // repartie sur les phases : deux estimations differentes pour une
    // meme sortie se contrediraient.
    const each = phaseSeconds(report);
    for (const phase of report.phases) lines.push(...renderPhase(phase, at, each));
  }
  // Les paquets sont emis PENDANT le balayage, donc leurs lignes
  // precedent le rapport de chaque hote.
  lines.push(...report.packetTrace);
  for (const host of report.hosts) {
    lines.push('');
    lines.push(...renderHost(host, options));
  }
  lines.push('');
  lines.push(tally(report));
  return lines.join('\n');
}

function greppablePort(p: PortResult): string {
  return `${p.port}/${p.state}/${p.protocol}//${p.service}//${p.version ?? ''}/`;
}

export function renderGreppable(report: NmapReport, commandLine: string): string {
  const lines: string[] = [`# Nmap 7.94 scan initiated as: ${commandLine}`];
  for (const host of report.hosts) {
    const label = `Host: ${host.ip} (${host.hostname ?? ''})`;
    lines.push(`${label}\tStatus: ${host.up ? 'Up' : 'Down'}`);
    if (!host.up) continue;
    const ports = host.ports.map(greppablePort).join(', ');
    let line = `${label}\tPorts: ${ports}`;
    // Le format greppable ne sait porter qu'UN etat ignore, et il en
    // compte tous les ports quel que soit le nombre de raisons.
    if (host.notShown) {
      const state = host.notShown.groups[0]?.state ?? 'closed';
      const count = host.notShown.groups
        .filter((g) => g.state === state)
        .reduce((n, g) => n + g.ports.length, 0);
      line += `\tIgnored State: ${state} (${count})`;
    }
    lines.push(line);
  }
  lines.push(`# Nmap done -- ${report.targetsScanned} IP ${report.targetsScanned === 1 ? 'address' : 'addresses'} (${report.hostsUp} ${report.hostsUp === 1 ? 'host up' : 'hosts up'}) scanned`);
  return lines.join('\n');
}
