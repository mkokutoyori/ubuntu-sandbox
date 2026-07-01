/**
 * `nmap` — network mapper for service discovery and version detection.
 *
 * Supports the flags Scenario 7 exercises:
 *   -p PORT[,PORT,...]  scan those TCP ports (defaults to 22/80/443).
 *   -sV                 service/version probe: grab the listener's
 *                       application-layer banner and infer the service.
 *   -A                  aggressive scan (implies -sV here).
 *
 * The banner is read from the target host's `SocketTable` via a stable
 * duck-typed surface, so any listener that registered a banner (sshd,
 * SMTP, HTTP, Oracle TNS, …) is identifiable even when it runs on a
 * non-standard port. This is what makes "port ≠ service" observable.
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { findHostByAddress } from '../../network/HostLookup';
import { grabBanner, grabListenerProcess } from './ServiceBannerGrab';

const WELL_KNOWN_TCP_PORT_NAMES: Record<number, string> = {
  22: 'ssh', 25: 'smtp', 53: 'domain', 80: 'http', 110: 'pop3',
  143: 'imap', 443: 'https', 465: 'smtps', 587: 'submission',
  993: 'imaps', 995: 'pop3s', 1521: 'oracle-tns', 3306: 'mysql',
  5432: 'postgresql', 6379: 'redis', 8080: 'http-proxy',
};

function wellKnownServiceName(port: number): string {
  return WELL_KNOWN_TCP_PORT_NAMES[port] ?? 'unknown';
}

export function detectServiceFromBanner(
  banner: string,
): { service: string; version?: string } | null {
  if (banner.startsWith('SSH-')) {
    const versionMatch = /^(SSH-\d\.\d)-(\S+)/.exec(banner);
    return {
      service: 'ssh',
      version: versionMatch
        ? `${versionMatch[2]} (protocol ${versionMatch[1].slice(4)})`
        : undefined,
    };
  }
  if (banner.startsWith('220-') || banner.startsWith('220 ')) {
    if (/smtp|mail|esmtp/i.test(banner)) return { service: 'smtp' };
    return { service: 'ftp' };
  }
  if (banner.startsWith('HTTP/')) return { service: 'http' };
  if (banner.startsWith('* OK')) return { service: 'imap' };
  if (banner.startsWith('+OK')) return { service: 'pop3' };
  if (banner.startsWith('(CONNECT_DATA=')) return { service: 'oracle-tns' };
  return null;
}

export const nmapCommand: LinuxCommand = {
  name: 'nmap',
  needsNetworkContext: true,
  usage: 'nmap [-sV] [-p PORT[,PORT,...]] <target>',
  help: 'Discover hosts and services on a network.',

  run(ctx: LinuxCommandContext, args: string[]): string {
    let versionScan = false;
    let ports: number[] = [80, 443, 22];
    let host: string | null = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-sV' || a === '-A') { versionScan = true; continue; }
      if (a === '-p' && args[i + 1]) {
        ports = args[i + 1]
          .split(',')
          .map((s) => parseInt(s, 10))
          .filter((n) => Number.isFinite(n));
        i++;
        continue;
      }
      if (!a.startsWith('-')) host = a;
    }
    if (!host) {
      return 'Nmap 7.94 ( https://nmap.org )\nUsage: nmap [Scan Type(s)] [Options] {target specification}';
    }

    const vfs = ctx.executor.vfs;
    const found = findHostByAddress(host, { readFile: (p) => vfs.readFile(p) });
    if (!found) return `Failed to resolve "${host}".`;
    if (found.poweredOff || found.interfaceDown) {
      return 'Note: Host seems down. If it is really up, but blocking our ping probes, try -Pn';
    }

    const tcpProbe = (ip: string, p: number): boolean => ctx.net.tcpProbe(ip, p);

    const lines: string[] = [];
    lines.push('Starting Nmap 7.94 ( https://nmap.org )');
    lines.push(`Nmap scan report for ${host} (${found.ip})`);
    lines.push('Host is up.');
    lines.push('');
    lines.push('PORT     STATE SERVICE' + (versionScan ? '         VERSION' : ''));
    for (const port of ports) {
      if (!tcpProbe(found.ip, port)) continue;
      let service = wellKnownServiceName(port);
      let version = '';
      if (versionScan) {
        const banner = grabBanner(found.device, port);
        if (banner) {
          const detected = detectServiceFromBanner(banner);
          if (detected) {
            service = detected.service;
            version = detected.version ?? '';
          }
        } else {
          const proc = grabListenerProcess(found.device, port);
          if (proc === 'sshd') { service = 'ssh'; version = 'OpenSSH (protocol 2.0)'; }
        }
      }
      lines.push(`${(`${port}/tcp`).padEnd(9)}open  ${service.padEnd(15)}${version}`);
    }
    lines.push('');
    lines.push('Nmap done: 1 IP address (1 host up) scanned');
    return lines.join('\n');
  },
};
