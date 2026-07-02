import { describe, it, expect } from 'vitest';
import { renderNormal, renderGreppable } from '@/network/devices/linux/commands/net/nmap/NmapFormatter';
import { scan } from '@/network/devices/linux/commands/net/nmap/ScanEngine';
import type { HostProbes } from '@/network/devices/linux/commands/net/nmap/ScanEngine';
import { parseNmapArgs } from '@/network/devices/linux/commands/net/nmap/NmapOptions';

function probes(): HostProbes {
  return {
    hostState(target) {
      if (target === '10.0.0.1') return { ip: '10.0.0.1', hostname: 'srv.lan', up: true, osHint: 'Linux' };
      if (target === '10.0.0.9') return { ip: '10.0.0.9', up: false, poweredOff: true };
      return null;
    },
    tcpOutcome(_ip, port) {
      if (port === 22 || port === 443) return 'open';
      if (port === 25) return 'timeout';
      return 'refused';
    },
    udpState(_ip, port) {
      return port === 53 ? 'open' : 'closed';
    },
    banner(_ip, port) {
      if (port === 443) return { service: 'ssh', version: 'OpenSSH 8.9 (protocol 2.0)' };
      return null;
    },
  };
}

describe('renderNormal', () => {
  it('affiche l\'en-tête et le rapport de scan', () => {
    const opts = parseNmapArgs(['-p', '22,80', '10.0.0.1']);
    const out = renderNormal(scan(opts, probes()), opts, 'nmap -p 22,80 10.0.0.1');
    expect(out).toContain('Starting Nmap 7.94 ( https://nmap.org )');
    expect(out).toContain('Nmap scan report for srv.lan (10.0.0.1)');
    expect(out).toMatch(/Host is up/);
  });

  it('aligne les colonnes avec un port ouvert', () => {
    const opts = parseNmapArgs(['-p', '22,80', '10.0.0.1']);
    const out = renderNormal(scan(opts, probes()), opts, 'x');
    expect(out).toMatch(/^PORT\s+STATE\s+SERVICE/m);
    expect(out).toMatch(/^22\/tcp\s+open\s+ssh/m);
    expect(out).toMatch(/^80\/tcp\s+closed\s+http/m);
  });

  it('affiche la colonne VERSION avec -sV', () => {
    const opts = parseNmapArgs(['-sV', '-p', '443', '10.0.0.1']);
    const out = renderNormal(scan(opts, probes()), opts, 'x');
    expect(out).toMatch(/^PORT\s+STATE\s+SERVICE\s+VERSION/m);
    expect(out).toContain('OpenSSH 8.9 (protocol 2.0)');
  });

  it('affiche la colonne REASON avec --reason', () => {
    const opts = parseNmapArgs(['--reason', '-p', '22,25', '10.0.0.1']);
    const out = renderNormal(scan(opts, probes()), opts, 'x');
    expect(out).toMatch(/^PORT\s+STATE\s+SERVICE\s+REASON/m);
    expect(out).toMatch(/22\/tcp\s+open\s+ssh\s+syn-ack/);
    expect(out).toMatch(/25\/tcp\s+filtered\s+\S+\s+no-response/);
  });

  it('replie les ports fermés nombreux', () => {
    const ports = ['22', ...Array.from({ length: 40 }, (_, i) => String(3000 + i))].join(',');
    const opts = parseNmapArgs(['-p', ports, '10.0.0.1']);
    const out = renderNormal(scan(opts, probes()), opts, 'x');
    expect(out).toMatch(/Not shown: 40 closed ports/);
    expect(out).toMatch(/^22\/tcp\s+open/m);
  });

  it('inclut l\'estimation d\'OS avec -O', () => {
    const opts = parseNmapArgs(['-O', '-p', '22', '10.0.0.1']);
    const out = renderNormal(scan(opts, probes()), opts, 'x');
    expect(out).toMatch(/OS details|Running|OS guess/i);
    expect(out).toContain('Linux');
  });

  it('signale un hôte injoignable', () => {
    const opts = parseNmapArgs(['-p', '22', '10.0.0.9']);
    const out = renderNormal(scan(opts, probes()), opts, 'x');
    expect(out).toMatch(/Host seems down|host down/i);
  });

  it('signale une cible non résolue', () => {
    const opts = parseNmapArgs(['-p', '22', 'ghost']);
    const out = renderNormal(scan(opts, probes()), opts, 'x');
    expect(out).toContain('Failed to resolve "ghost"');
  });

  it('affiche le bilan final', () => {
    const opts = parseNmapArgs(['-p', '22', '10.0.0.1']);
    const out = renderNormal(scan(opts, probes()), opts, 'x');
    expect(out).toMatch(/Nmap done: 1 IP address \(1 host up\) scanned/);
  });

  it('mode -sn : découverte sans table de ports', () => {
    const opts = parseNmapArgs(['-sn', '10.0.0.1']);
    const out = renderNormal(scan(opts, probes()), opts, 'x');
    expect(out).toContain('Host is up');
    expect(out).not.toMatch(/^PORT\s+STATE/m);
  });
});

describe('renderGreppable', () => {
  it('produit une ligne Host et une ligne Ports', () => {
    const opts = parseNmapArgs(['-p', '22,80', '10.0.0.1']);
    const out = renderGreppable(scan(opts, probes()), 'nmap -p 22,80 10.0.0.1');
    expect(out).toMatch(/Host: 10\.0\.0\.1 \(srv\.lan\)\s+Status: Up/);
    expect(out).toMatch(/22\/open\/tcp\/\/ssh/);
  });

  it('marque un hôte down', () => {
    const opts = parseNmapArgs(['-Pn', '10.0.0.9']);
    const report = scan(opts, probes());
    report.hosts[0].up = false;
    const out = renderGreppable(report, 'x');
    expect(out).toMatch(/Status: Down/);
  });
});
