import { describe, it, expect } from 'vitest';
import { parseNmapArgs } from '@/network/scan/nmap/NmapOptions';

describe('parseNmapArgs', () => {
  it('extrait une cible unique', () => {
    const o = parseNmapArgs(['192.168.1.1'], true);
    expect(o.targets).toEqual(['192.168.1.1']);
  });

  it('extrait plusieurs cibles', () => {
    const o = parseNmapArgs(['10.0.0.1', 'host.lan', '10.0.0.2'], true);
    expect(o.targets).toEqual(['10.0.0.1', 'host.lan', '10.0.0.2']);
  });

  it('type de scan par défaut : SYN pour root, connect() sinon', () => {
    expect(parseNmapArgs(['x'], true).scanType).toBe('syn');
    expect(parseNmapArgs(['x'], false).scanType).toBe('tcp');
  });

  // Ce cas encodait l'alias comme contrat : `-sS` et `-sT` etaient le
  // meme balayage. Ils rendent le meme VERDICT et n'emettent pas le meme
  // trafic — le demi-ouvert ne repond jamais ACK — donc ce sont deux
  // types distincts.
  it('-sS selectionne le balayage demi-ouvert', () => {
    expect(parseNmapArgs(['-sS', 'x'], true).scanType).toBe('syn');
  });

  it('-sT selectionne le balayage connecte', () => {
    expect(parseNmapArgs(['-sT', 'x'], true).scanType).toBe('tcp');
  });

  it('-sU sélectionne UDP', () => {
    expect(parseNmapArgs(['-sU', 'x'], true).scanType).toBe('udp');
  });

  it('-sn active la découverte seule', () => {
    const o = parseNmapArgs(['-sn', '10.0.0.0/24'], true);
    expect(o.pingOnly).toBe(true);
  });

  it('-Pn saute la découverte', () => {
    expect(parseNmapArgs(['-Pn', 'x'], true).skipDiscovery).toBe(true);
  });

  it('-sV active la détection de version', () => {
    expect(parseNmapArgs(['-sV', 'x'], true).versionScan).toBe(true);
  });

  it('-A implique version et OS', () => {
    const o = parseNmapArgs(['-A', 'x'], true);
    expect(o.versionScan).toBe(true);
    expect(o.osScan).toBe(true);
  });

  it('-O active la détection d\'OS seule', () => {
    const o = parseNmapArgs(['-O', 'x'], true);
    expect(o.osScan).toBe(true);
    expect(o.versionScan).toBe(false);
  });

  it('-p avec liste et plage', () => {
    expect(parseNmapArgs(['-p', '22,80-82', 'x'], true).ports).toEqual([22, 80, 81, 82]);
  });

  it('-p collé (-p22,80)', () => {
    expect(parseNmapArgs(['-p22,80', 'x'], true).ports).toEqual([22, 80]);
  });

  it('-p- développe toute la plage', () => {
    expect(parseNmapArgs(['-p-', 'x'], true).ports?.length).toBe(65535);
  });

  it('-F retient 100 ports', () => {
    expect(parseNmapArgs(['-F', 'x'], true).ports?.length).toBe(100);
  });

  it('--top-ports N retient N ports', () => {
    expect(parseNmapArgs(['--top-ports', '50', 'x'], true).ports?.length).toBe(50);
  });

  it('sans -p les ports sont indéfinis (défaut résolu par le moteur)', () => {
    expect(parseNmapArgs(['x'], true).ports).toBeUndefined();
  });

  it('--open ne montre que les ports ouverts', () => {
    expect(parseNmapArgs(['--open', 'x'], true).openOnly).toBe(true);
  });

  it('--reason active la justification', () => {
    expect(parseNmapArgs(['--reason', 'x'], true).showReason).toBe(true);
  });

  it('-n désactive la résolution DNS', () => {
    expect(parseNmapArgs(['-n', 'x'], true).noDns).toBe(true);
  });

  it('-oN capture le fichier de sortie normal', () => {
    expect(parseNmapArgs(['-oN', 'scan.txt', 'x'], true).outputNormal).toBe('scan.txt');
  });

  it('-oG capture le fichier de sortie greppable', () => {
    expect(parseNmapArgs(['-oG', 'grep.txt', 'x'], true).outputGreppable).toBe('grep.txt');
  });

  it('-T4 est accepté sans effet fonctionnel', () => {
    const o = parseNmapArgs(['-T4', 'x'], true);
    expect(o.targets).toEqual(['x']);
  });

  it('-v est accepté', () => {
    const o = parseNmapArgs(['-v', 'x'], true);
    expect(o.verbose).toBe(true);
    expect(o.targets).toEqual(['x']);
  });

  it('signale l\'absence de cible', () => {
    expect(parseNmapArgs([], true).targets).toEqual([]);
  });
});
