import type { NmapOptions } from './NmapOptions';
import type { HostReport, NmapReport, PortResult, PortState } from './ScanEngine';

const NMAP_BANNER = 'Starting Nmap 7.94 ( https://nmap.org )';

function hostLabel(host: HostReport): string {
  return host.hostname ? `${host.hostname} (${host.ip})` : host.ip;
}

function pluralPorts(n: number): string {
  return n === 1 ? 'port' : 'ports';
}

function notShownLine(host: HostReport): string | null {
  if (!host.notShown) return null;
  const parts = (Object.entries(host.notShown.states) as [PortState, number][])
    .map(([state, count]) => `${count} ${state} ${pluralPorts(count)}`);
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
  const lines: string[] = [`Nmap scan report for ${hostLabel(host)}${host.up ? '' : ' [host down]'}`];
  if (!host.up) {
    lines.push('Note: Host seems down. If it is really up, but blocking our ping probes, try -Pn');
    return lines;
  }
  lines.push(`Host is up (${host.latencyMs.toFixed(4)}s latency).`);
  const notShown = notShownLine(host);
  if (notShown) lines.push(notShown);
  lines.push(...renderTable(host, options));
  if (options.osScan && host.osGuess) {
    lines.push(`OS details: ${host.osGuess}`);
  }
  return lines;
}

function tally(report: NmapReport): string {
  const ips = `${report.targetsScanned} IP ${report.targetsScanned === 1 ? 'address' : 'addresses'}`;
  const up = `${report.hostsUp} ${report.hostsUp === 1 ? 'host up' : 'hosts up'}`;
  const seconds = Math.max(0.02, report.targetsScanned * 0.05).toFixed(2);
  return `Nmap done: ${ips} (${up}) scanned in ${seconds} seconds`;
}

export function renderNormal(report: NmapReport, options: NmapOptions, _commandLine: string): string {
  const lines: string[] = [NMAP_BANNER];
  for (const target of report.unresolved) lines.push(`Failed to resolve "${target}".`);
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
    if (host.notShown) {
      const [state, count] = (Object.entries(host.notShown.states) as [PortState, number][])[0] ?? ['closed', 0];
      line += `\tIgnored State: ${state} (${count})`;
    }
    lines.push(line);
  }
  lines.push(`# Nmap done -- ${report.targetsScanned} IP ${report.targetsScanned === 1 ? 'address' : 'addresses'} (${report.hostsUp} ${report.hostsUp === 1 ? 'host up' : 'hosts up'}) scanned`);
  return lines.join('\n');
}
