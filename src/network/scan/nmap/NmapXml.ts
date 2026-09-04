import { fmtHumanDate } from '@/network/devices/linux/LinuxLogManager';
import type { NmapOptions, ScanType } from './NmapOptions';
import { effectivePorts } from './ScanEngine';
import type { HostReport, NmapReport, PortResult } from './ScanEngine';
import { formatPortRanges } from './PortSpec';

/**
 * `-oX` : le document que `xml.cc` et `output.cc` ecrivent.
 *
 * Deux proprietes de ces ecrivains gouvernent tout le reste. Aucun
 * n'INDENTE — un retour a la ligne n'existe que la ou `xml_newline()`
 * est appele — et un attribut est TOUJOURS echappe (`xml.cc:222`), donc
 * l'echappement est ici la seule facon d'ecrire une valeur.
 */

export const NMAP_XML_OUTPUT_VERSION = '1.05';
export const NMAP_XML_VERSION = '7.94';

/**
 * `escape` (`xml.cc:222`) : les cinq entites, puis `--` dans un
 * commentaire, puis tout ce qui sort de l'ASCII imprimable en `&#x..;`.
 */
export function escapeXml(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '&') out += '&amp;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&apos;';
    else if (c === '-' && i > 0 && text[i - 1] === '-') out += '&#45;';
    else if (c < ' ' || c > '\x7e') out += `&#x${c.charCodeAt(0).toString(16)};`;
    else out += c;
  }
  return out;
}

type Attr = readonly [string, string | number | undefined];

function attributes(attrs: readonly Attr[]): string {
  return attrs
    .filter((a): a is readonly [string, string | number] => a[1] !== undefined)
    .map(([name, value]) => ` ${name}="${escapeXml(String(value))}"`)
    .join('');
}

function emptyTag(name: string, attrs: readonly Attr[]): string {
  return `<${name}${attributes(attrs)}/>`;
}

function openTag(name: string, attrs: readonly Attr[]): string {
  return `<${name}${attributes(attrs)}>`;
}

/**
 * `output_xml_scaninfo_records` (`output.cc:1207`) nomme le balayage par
 * son TYPE. Les noms sont ceux des drapeaux de `NmapOps`, pas ceux des
 * options : `-sT` est `connect` et `-sN` est `null`.
 */
const SCANINFO_TYPE: Readonly<Record<ScanType, string>> = {
  tcp: 'connect', syn: 'syn', udp: 'udp', ack: 'ack', fin: 'fin',
  null: 'null', xmas: 'xmas', maimon: 'maimon', window: 'window',
};

function addressType(ip: string): 'ipv4' | 'ipv6' {
  return ip.includes(':') ? 'ipv6' : 'ipv4';
}

/**
 * `adjust_timeouts2` (`timing.cc:120`) sur un PREMIER echantillon :
 * `srtt` est l'aller-retour mesure, `rttvar` le meme borne a
 * [5 ms, 2 s], et le delai `srtt + 4 * rttvar` borne a
 * [`MIN_RTT_TIMEOUT`, `MAX_RTT_TIMEOUT`], soit [100 ms, 10 s]
 * (`nmap.h:187`). Les trois sont en MICROSECONDES.
 */
function timesOf(latencyMs: number): { srtt: number; rttvar: number; to: number } {
  const srtt = Math.round(latencyMs * 1000);
  const rttvar = Math.min(2000000, Math.max(5000, srtt));
  const to = Math.min(10000000, Math.max(100000, srtt + rttvar * 4));
  return { srtt, rttvar, to };
}

/**
 * `print_xml_service` (`output.cc:178`). `method` distingue la table des
 * services de la SONDE qui a lu une banniere, et `conf` est la confiance
 * que `nmap` accorde au nom : 3 pour une deduction de table, 10 pour un
 * service reellement identifie.
 */
function serviceTag(port: PortResult, versionScan: boolean): string {
  const probed = versionScan && port.version !== undefined;
  return emptyTag('service', [
    ['name', port.service],
    ['product', probed ? port.version : undefined],
    ['method', probed ? 'probed' : 'table'],
    ['conf', probed ? 10 : 3],
  ]);
}

function portTag(port: PortResult, versionScan: boolean): string {
  // `state_reason_init` (`portreasons.cc:398`) part d'un TTL nul, et un
  // balayage CONNECTE n'en observe jamais : ce simulateur ne releve le
  // TTL d'aucune reponse de port, donc zero est ce qu'il a mesure.
  return openTag('port', [['protocol', port.protocol], ['portid', port.port]])
    + emptyTag('state', [
      ['state', port.state], ['reason', port.reason], ['reason_ttl', 0],
    ])
    + serviceTag(port, versionScan)
    + '</port>';
}

function portsSection(host: HostReport, options: NmapOptions): string[] {
  if (host.ports.length === 0 && !host.notShown) return [];
  const lines: string[] = [];
  let head = '<ports>';
  for (const group of host.notShown?.groups ?? []) {
    lines.push(head + openTag('extraports', [
      ['state', group.state], ['count', group.ports.length],
    ]));
    head = '';
    lines.push(emptyTag('extrareasons', [
      ['reason', group.reason], ['count', group.ports.length],
      ['proto', group.protocol], ['ports', formatPortRanges(group.ports)],
    ]));
    lines.push('</extraports>');
  }
  for (const port of host.ports) {
    lines.push(head + portTag(port, options.versionScan));
    head = '';
  }
  if (head !== '') lines.push(head);
  lines.push('</ports>');
  return lines;
}

/**
 * `write_xml_osmatch` (`output.cc:1339`). `line` nomme la ligne de
 * `nmap-os-db` d'ou vient l'empreinte de reference ; l'indication de ce
 * simulateur vient du TTL initial et d'aucune base, ce que
 * `FingerMatch()` (`osscan.h:185`) ecrit `-1`.
 */
function osSection(host: HostReport): string[] {
  if (!host.osGuess) return [];
  return [
    '<os>' + emptyTag('osmatch', [
      ['name', host.osGuess], ['accuracy', 100], ['line', -1],
    ]),
    '</os>',
  ];
}

/** `printtraceroute_xml` (`output.cc:2356`) : un `<hop>` par saut REPONDU. */
function traceSection(host: HostReport): string[] {
  const trace = host.trace;
  if (!trace || trace.hops.length === 0) return [];
  const probe = trace.probe;
  const head = openTag('trace', probe.kind === 'port'
    ? [['port', probe.port], ['proto', probe.proto]]
    : probe.kind === 'proto' ? [['proto', probe.name]] : []);
  const lines = [head];
  for (const hop of trace.hops) {
    if (hop.ip === undefined) continue;
    lines.push(emptyTag('hop', [
      ['ttl', hop.ttl], ['ipaddr', hop.ip],
      ['rtt', hop.rttMs === undefined ? '--' : hop.rttMs.toFixed(2)],
      ['host', hop.name],
    ]));
  }
  lines.push('</trace>');
  return lines;
}

/**
 * `output.cc:1272` : l'element parait des que l'hote est vivant, meme
 * sans un seul nom a y mettre, et chaque nom occupe sa propre ligne
 * (`xml_newline()` suit l'ouverture puis chaque entree). Le nom TAPE et
 * le nom RESOLU sont ecrits tous les deux, sans etre compares : c'est la
 * ligne `rDNS record for` de la sortie humaine qui, elle, ne parait que
 * lorsqu'ils different.
 */
function hostnamesSection(host: HostReport): string[] {
  const names: string[] = [];
  if (host.hostname) {
    names.push(emptyTag('hostname', [['name', host.hostname], ['type', 'user']]));
  }
  if (host.rdnsName) {
    names.push(emptyTag('hostname', [['name', host.rdnsName], ['type', 'PTR']]));
  }
  if (names.length === 0 && !host.up) return [];
  return ['<hostnames>', ...names, '</hostnames>'];
}

function hostSection(
  host: HostReport, options: NmapOptions, start: number, end: number,
): string[] {
  const status = emptyTag('status', [
    ['state', host.up ? 'up' : 'down'],
    ['reason', host.up ? (host.discoveryReason ?? 'unknown-response')
      : (host.downReason ?? 'no-response')],
    ['reason_ttl', host.up ? (host.replyTtl ?? 0) : 0],
  ]);
  const lines = [
    openTag('host', [['starttime', start], ['endtime', end]]) + status,
    emptyTag('address', [['addr', host.ip], ['addrtype', addressType(host.ip)]]),
  ];
  if (host.mac) {
    lines.push(emptyTag('address', [
      ['addr', host.mac.toUpperCase()], ['addrtype', 'mac'],
    ]));
  }
  lines.push(...hostnamesSection(host));
  if (host.up) {
    lines.push(...portsSection(host, options));
    lines.push(...osSection(host));
    lines.push(...traceSection(host));
    const { srtt, rttvar, to } = timesOf(host.latencyMs);
    lines.push(emptyTag('times', [['srtt', srtt], ['rttvar', rttvar], ['to', to]]));
  }
  lines.push('</host>');
  return lines;
}

/**
 * `XSLStyleSheet()` (`NmapOps.cc:618`) cherche `nmap.xsl` sur le disque
 * et, faute de le trouver, rend l'URL RELATIVE — « It won't work, but it
 * gives a clue that there is an nmap.xsl somewhere ». Aucune image de ce
 * simulateur ne porte ce fichier, donc c'est cette branche qui vaut.
 */
export const NMAP_DEFAULT_STYLESHEET = 'nmap.xsl';
export const NMAP_WEB_STYLESHEET = 'https://svn.nmap.org/nmap/docs/nmap.xsl';

export function renderXml(
  report: NmapReport, options: NmapOptions, commandLine: string,
  elapsedSeconds: number,
): string {
  const started = new Date(report.startedAt);
  const startedSec = Math.floor(started.getTime() / 1000);
  const startedStr = fmtHumanDate(started);
  const finished = new Date(started.getTime() + Math.round(elapsedSeconds * 1000));
  const finishedSec = Math.floor(finished.getTime() / 1000);
  const finishedStr = fmtHumanDate(finished);

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE nmaprun>',
  ];
  if (options.stylesheet !== null) {
    lines.push(`<?xml-stylesheet href="${escapeXml(options.stylesheet)}" type="text/xsl"?>`);
  }
  lines.push(`<!-- Nmap ${NMAP_XML_VERSION} scan initiated ${escapeXml(startedStr)}`
    + ` as: ${escapeXml(commandLine)} -->`);
  lines.push(openTag('nmaprun', [
    ['scanner', 'nmap'], ['args', commandLine],
    ['start', startedSec], ['startstr', startedStr],
    ['version', NMAP_XML_VERSION],
    ['xmloutputversion', NMAP_XML_OUTPUT_VERSION],
  ]));

  if (!options.pingOnly) {
    const ports = effectivePorts(options);
    const protocol = options.scanType === 'udp' ? 'udp' : 'tcp';
    lines.push(emptyTag('scaninfo', [
      ['type', SCANINFO_TYPE[options.scanType]], ['protocol', protocol],
      ['numservices', ports.length], ['services', formatPortRanges(ports)],
    ]));
  }
  lines.push(emptyTag('verbose', [['level', options.verbose ? 1 : 0]]));
  lines.push(emptyTag('debugging', [['level', options.debugLevel]]));

  for (const host of report.hosts) {
    lines.push(...hostSection(host, options, startedSec, finishedSec));
  }

  const ips = `${report.targetsScanned} IP `
    + `${report.targetsScanned === 1 ? 'address' : 'addresses'}`;
  const up = `${report.hostsUp} ${report.hostsUp === 1 ? 'host' : 'hosts'} up`;
  const elapsed = elapsedSeconds.toFixed(2);
  lines.push('<runstats>'
    + emptyTag('finished', [
      ['time', finishedSec], ['timestr', finishedStr],
      ['summary', `Nmap done at ${finishedStr};`
        + ` ${ips} (${up}) scanned in ${elapsed} seconds`],
      ['elapsed', elapsed], ['exit', 'success'],
    ])
    + emptyTag('hosts', [
      ['up', report.hostsUp],
      ['down', report.targetsScanned - report.hostsUp],
      ['total', report.targetsScanned],
    ]));
  lines.push('</runstats>');
  lines.push('</nmaprun>');
  return lines.join('\n');
}
