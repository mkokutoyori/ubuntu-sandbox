import { describe, it, expect } from 'vitest';
import {
  scan,
  enumerateTargets,
  type HostProbes,
} from '@/network/scan/nmap/ScanEngine';
import { parseNmapArgs } from '@/network/scan/nmap/NmapOptions';

interface FakeSpec {
  hosts?: Record<string, {
    up?: boolean; hostname?: string; poweredOff?: boolean;
    interfaceDown?: boolean; osHint?: string;
    tcp?: Record<number, 'open' | 'refused' | 'timeout'>;
    udp?: Record<number, 'open' | 'closed' | 'open|filtered'>;
    banners?: Record<number, { service: string; version?: string }>;
  }>;
}

function fakeProbes(spec: FakeSpec): HostProbes {
  return {
    resolveTarget(target) {
      const h = spec.hosts?.[target];
      if (!h) return null;
      return { ip: target, hostname: h.hostname };
    },
    async hostState(target) {
      const h = spec.hosts?.[target.ip];
      return {
        ip: target.ip,
        hostname: target.hostname,
        up: h?.up !== false,
        osHint: h?.osHint,
      };
    },
    tcpOutcome(ip, port) {
      return spec.hosts?.[ip]?.tcp?.[port] ?? 'refused';
    },
    udpState(ip, port) {
      return spec.hosts?.[ip]?.udp?.[port] ?? 'closed';
    },
    banner(ip, port) {
      return spec.hosts?.[ip]?.banners?.[port] ?? null;
    },
  };
}

describe('enumerateTargets', () => {
  it('laisse une IP simple inchangée', async () => {
    expect(enumerateTargets('10.0.0.5')).toEqual(['10.0.0.5']);
  });

  it('laisse un hostname inchangé', async () => {
    expect(enumerateTargets('srv.lan')).toEqual(['srv.lan']);
  });

  it('développe un /30 en ses adressses', async () => {
    expect(enumerateTargets('192.168.1.0/30')).toEqual([
      '192.168.1.0', '192.168.1.1', '192.168.1.2', '192.168.1.3',
    ]);
  });

  it('développe un /29', async () => {
    expect(enumerateTargets('10.0.0.8/29').length).toBe(8);
  });

  it('refuse un préfixe trop large', async () => {
    expect(enumerateTargets('10.0.0.0/8')).toEqual(['10.0.0.0/8']);
  });
});

describe('scan — états TCP', () => {
  const probes = fakeProbes({
    hosts: {
      '10.0.0.1': {
        tcp: { 22: 'open', 23: 'refused', 8080: 'timeout' },
      },
    },
  });

  it('mappe open/refused/timeout vers open/closed/filtered', async () => {
    const opts = parseNmapArgs(['-p', '22,23,8080', '10.0.0.1']);
    const report = await scan(opts, probes);
    const host = report.hosts[0];
    const state = (p: number) => host.ports.find((x) => x.port === p)?.state;
    expect(state(22)).toBe('open');
    expect(state(23)).toBe('closed');
    expect(state(8080)).toBe('filtered');
  });

  it('renseigne le motif (reason)', async () => {
    const opts = parseNmapArgs(['-p', '22,23,8080', '10.0.0.1']);
    const host = (await scan(opts, probes)).hosts[0];
    const reason = (p: number) => host.ports.find((x) => x.port === p)?.reason;
    expect(reason(22)).toBe('syn-ack');
    expect(reason(23)).toBe('reset');
    expect(reason(8080)).toBe('no-response');
  });

  it('nomme le service', async () => {
    const host = (await scan(parseNmapArgs(['-p', '22', '10.0.0.1']), probes)).hosts[0];
    expect(host.ports[0].service).toBe('ssh');
  });
});

describe('scan — Not shown et --open', () => {
  const many: Record<number, 'open' | 'refused'> = { 22: 'open' };
  for (let p = 1000; p < 1040; p++) many[p] = 'refused';
  const probes = fakeProbes({ hosts: { '10.0.0.2': { tcp: many } } });

  it('replie les ports fermés nombreux dans Not shown', async () => {
    const ports = ['22', ...Object.keys(many).filter((k) => k !== '22')].join(',');
    const host = (await scan(parseNmapArgs(['-p', ports, '10.0.0.2']), probes)).hosts[0];
    expect(host.ports.map((p) => p.port)).toEqual([22]);
    expect(host.notShown?.count).toBe(40);
    expect(host.notShown?.groups).toEqual([
      { state: 'closed', protocol: 'tcp', reason: 'reset', ports: expect.any(Array) },
    ]);
    expect(host.notShown?.groups[0].ports).toHaveLength(40);
  });

  it('liste les états peu nombreux au lieu de les replier', async () => {
    const p = fakeProbes({ hosts: { x: { tcp: { 22: 'open', 80: 'refused' } } } });
    const host = (await scan(parseNmapArgs(['-p', '22,80', 'x']), p)).hosts[0];
    expect(host.ports.map((r) => r.port)).toEqual([22, 80]);
    expect(host.notShown).toBeUndefined();
  });

  it('--open masque tout ce qui n\'est pas ouvert', async () => {
    const p = fakeProbes({ hosts: { x: { tcp: { 22: 'open', 80: 'refused' } } } });
    const host = (await scan(parseNmapArgs(['--open', '-p', '22,80', 'x']), p)).hosts[0];
    expect(host.ports.map((r) => r.port)).toEqual([22]);
  });
});

describe('scan — détection de version et OS', () => {
  const probes = fakeProbes({
    hosts: {
      '10.0.0.3': {
        osHint: 'Linux',
        tcp: { 22: 'open', 443: 'open' },
        banners: {
          22: { service: 'ssh', version: 'OpenSSH 8.9 (protocol 2.0)' },
          443: { service: 'ssh', version: 'OpenSSH 8.9 (protocol 2.0)' },
        },
      },
    },
  });

  it('-sV renseigne la version depuis la bannière', async () => {
    const host = (await scan(parseNmapArgs(['-sV', '-p', '22', '10.0.0.3']), probes)).hosts[0];
    expect(host.ports[0].version).toBe('OpenSSH 8.9 (protocol 2.0)');
  });

  it('-sV révèle un service sur un port non standard', async () => {
    const host = (await scan(parseNmapArgs(['-sV', '-p', '443', '10.0.0.3']), probes)).hosts[0];
    expect(host.ports[0].service).toBe('ssh');
  });

  it('sans -sV la bannière n\'est pas sondée', async () => {
    const host = (await scan(parseNmapArgs(['-p', '443', '10.0.0.3']), probes)).hosts[0];
    expect(host.ports[0].version).toBeUndefined();
    expect(host.ports[0].service).toBe('https');
  });

  it('-O renseigne l\'estimation d\'OS', async () => {
    const host = (await scan(parseNmapArgs(['-O', '-p', '22', '10.0.0.3']), probes)).hosts[0];
    expect(host.osGuess).toBe('Linux');
  });
});

describe('scan — UDP', () => {
  const probes = fakeProbes({
    hosts: {
      '10.0.0.4': {
        udp: { 53: 'open', 161: 'open|filtered', 9: 'closed' },
      },
    },
  });

  it('mappe les états UDP', async () => {
    const host = (await scan(parseNmapArgs(['-sU', '-p', '53,161,9', '10.0.0.4']), probes)).hosts[0];
    const state = (p: number) => host.ports.find((x) => x.port === p)?.state;
    expect(state(53)).toBe('open');
    expect(state(161)).toBe('open|filtered');
    expect(host.ports.find((x) => x.port === 53)?.protocol).toBe('udp');
  });
});

describe('scan — découverte d\'hôtes', () => {
  const probes = fakeProbes({
    hosts: {
      '10.0.0.1': { up: true, tcp: { 22: 'open' } },
      '10.0.0.2': { up: false, poweredOff: true },
    },
  });

  it('-sn ne scanne aucun port', async () => {
    const host = (await scan(parseNmapArgs(['-sn', '10.0.0.1']), probes)).hosts[0];
    expect(host.up).toBe(true);
    expect(host.ports).toEqual([]);
  });

  it('un hôte éteint est rapporté down et non scanné', async () => {
    const report = await scan(parseNmapArgs(['-p', '22', '10.0.0.2']), probes);
    expect(report.hosts[0].up).toBe(false);
    expect(report.hosts[0].ports).toEqual([]);
  });

  it('-Pn scanne même sans découverte', async () => {
    const p = fakeProbes({ hosts: { '10.0.0.9': { up: false, poweredOff: true, tcp: { 22: 'timeout' } } } });
    const host = (await scan(parseNmapArgs(['-Pn', '-p', '22', '10.0.0.9']), p)).hosts[0];
    expect(host.up).toBe(true);
    expect(host.ports[0].state).toBe('filtered');
  });

  it('une cible non résolue est signalée', async () => {
    const report = await scan(parseNmapArgs(['-p', '22', 'nowhere']), probes);
    expect(report.unresolved).toContain('nowhere');
    expect(report.hosts).toEqual([]);
  });

  it('compte les hôtes up et scannés', async () => {
    const report = await scan(parseNmapArgs(['-p', '22', '10.0.0.1', '10.0.0.2']), probes);
    expect(report.hostsUp).toBe(1);
    expect(report.targetsScanned).toBe(2);
  });
});
