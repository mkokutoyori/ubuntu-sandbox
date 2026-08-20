import { describe, it, expect } from 'vitest';
import { parseNmapArgs } from '@/network/devices/linux/commands/net/nmap/NmapOptions';

describe('parseNmapArgs', () => {
  it('extrait une cible unique', () => {
    const o = parseNmapArgs(['192.168.1.1']);
    expect(o.targets).toEqual(['192.168.1.1']);
  });

  it('extrait plusieurs cibles', () => {
    const o = parseNmapArgs(['10.0.0.1', 'host.lan', '10.0.0.2']);
    expect(o.targets).toEqual(['10.0.0.1', 'host.lan', '10.0.0.2']);
  });

  it('type de scan connect par défaut', () => {
    expect(parseNmapArgs(['x']).scanType).toBe('tcp');
  });

  it('-sS reste un scan TCP', () => {
    expect(parseNmapArgs(['-sS', 'x']).scanType).toBe('tcp');
  });

  it('-sU sélectionne UDP', () => {
    expect(parseNmapArgs(['-sU', 'x']).scanType).toBe('udp');
  });

  it('-sn active la découverte seule', () => {
    const o = parseNmapArgs(['-sn', '10.0.0.0/24']);
    expect(o.pingOnly).toBe(true);
  });

  it('-Pn saute la découverte', () => {
    expect(parseNmapArgs(['-Pn', 'x']).skipDiscovery).toBe(true);
  });

  it('-sV active la détection de version', () => {
    expect(parseNmapArgs(['-sV', 'x']).versionScan).toBe(true);
  });

  it('-A implique version et OS', () => {
    const o = parseNmapArgs(['-A', 'x']);
    expect(o.versionScan).toBe(true);
    expect(o.osScan).toBe(true);
  });

  it('-O active la détection d\'OS seule', () => {
    const o = parseNmapArgs(['-O', 'x']);
    expect(o.osScan).toBe(true);
    expect(o.versionScan).toBe(false);
  });

  it('-p avec liste et plage', () => {
    expect(parseNmapArgs(['-p', '22,80-82', 'x']).ports).toEqual([22, 80, 81, 82]);
  });

  it('-p collé (-p22,80)', () => {
    expect(parseNmapArgs(['-p22,80', 'x']).ports).toEqual([22, 80]);
  });

  it('-p- développe toute la plage', () => {
    expect(parseNmapArgs(['-p-', 'x']).ports?.length).toBe(65535);
  });

  it('-F retient 100 ports', () => {
    expect(parseNmapArgs(['-F', 'x']).ports?.length).toBe(100);
  });

  it('--top-ports N retient N ports', () => {
    expect(parseNmapArgs(['--top-ports', '50', 'x']).ports?.length).toBe(50);
  });

  it('sans -p les ports sont indéfinis (défaut résolu par le moteur)', () => {
    expect(parseNmapArgs(['x']).ports).toBeUndefined();
  });

  it('--open ne montre que les ports ouverts', () => {
    expect(parseNmapArgs(['--open', 'x']).openOnly).toBe(true);
  });

  it('--reason active la justification', () => {
    expect(parseNmapArgs(['--reason', 'x']).showReason).toBe(true);
  });

  it('-n désactive la résolution DNS', () => {
    expect(parseNmapArgs(['-n', 'x']).noDns).toBe(true);
  });

  it('-oN capture le fichier de sortie normal', () => {
    expect(parseNmapArgs(['-oN', 'scan.txt', 'x']).outputNormal).toBe('scan.txt');
  });

  it('-oG capture le fichier de sortie greppable', () => {
    expect(parseNmapArgs(['-oG', 'grep.txt', 'x']).outputGreppable).toBe('grep.txt');
  });

  it('-T4 est accepté sans effet fonctionnel', () => {
    const o = parseNmapArgs(['-T4', 'x']);
    expect(o.targets).toEqual(['x']);
  });

  it('-v est accepté', () => {
    const o = parseNmapArgs(['-v', 'x']);
    expect(o.verbose).toBe(true);
    expect(o.targets).toEqual(['x']);
  });

  it('signale l\'absence de cible', () => {
    expect(parseNmapArgs([]).targets).toEqual([]);
  });
});
