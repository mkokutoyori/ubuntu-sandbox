import { describe, it, expect } from 'vitest';
import { parsePortSpec } from '@/network/devices/linux/commands/net/nmap/PortSpec';
import {
  serviceName,
  topPorts,
  fastPorts,
  DEFAULT_TOP_COUNT,
} from '@/network/devices/linux/commands/net/nmap/ServiceRegistry';

describe('parsePortSpec', () => {
  it('parse une liste simple', () => {
    expect(parsePortSpec('22,80,443')).toEqual([22, 80, 443]);
  });

  it('parse une plage', () => {
    expect(parsePortSpec('20-25')).toEqual([20, 21, 22, 23, 24, 25]);
  });

  it('combine listes et plages', () => {
    expect(parsePortSpec('22,80-82,443')).toEqual([22, 80, 81, 82, 443]);
  });

  it('trie et déduplique', () => {
    expect(parsePortSpec('443,22,443,22,80')).toEqual([22, 80, 443]);
  });

  it('développe -p- en toute la plage', () => {
    const all = parsePortSpec('-');
    expect(all[0]).toBe(1);
    expect(all[all.length - 1]).toBe(65535);
    expect(all.length).toBe(65535);
  });

  it('développe une plage ouverte à gauche', () => {
    expect(parsePortSpec('-3')).toEqual([1, 2, 3]);
  });

  it('développe une plage ouverte à droite', () => {
    const hi = parsePortSpec('65533-');
    expect(hi).toEqual([65533, 65534, 65535]);
  });

  it('borne les ports hors plage', () => {
    expect(parsePortSpec('0,80,70000')).toEqual([80]);
  });

  it('ignore les entrées non numériques', () => {
    expect(parsePortSpec('80,abc,443')).toEqual([80, 443]);
  });

  it('ignore les préfixes de protocole T: et U:', () => {
    expect(parsePortSpec('T:80,U:53')).toEqual([53, 80]);
  });

  it('retourne une liste vide pour une entrée vide', () => {
    expect(parsePortSpec('')).toEqual([]);
  });
});

describe('ServiceRegistry', () => {
  it('nomme les ports TCP bien connus', () => {
    expect(serviceName(22, 'tcp')).toBe('ssh');
    expect(serviceName(80, 'tcp')).toBe('http');
    expect(serviceName(443, 'tcp')).toBe('https');
    expect(serviceName(1521, 'tcp')).toBe('oracle-tns');
  });

  it('nomme les ports UDP bien connus', () => {
    expect(serviceName(53, 'udp')).toBe('domain');
    expect(serviceName(161, 'udp')).toBe('snmp');
  });

  it('retourne unknown pour un port inconnu', () => {
    expect(serviceName(45789, 'tcp')).toBe('unknown');
  });

  it('topPorts(n) retourne exactement n ports', () => {
    expect(topPorts(10).length).toBe(10);
    expect(topPorts(10)).toContain(80);
    expect(topPorts(10)).toContain(22);
  });

  it('topPorts est trié croissant', () => {
    const ports = topPorts(20);
    const sorted = [...ports].sort((a, b) => a - b);
    expect(ports).toEqual(sorted);
  });

  it('fastPorts retourne 100 ports', () => {
    expect(fastPorts().length).toBe(100);
  });

  it('le défaut top-ports vaut 1000', () => {
    expect(DEFAULT_TOP_COUNT).toBe(1000);
    expect(topPorts(DEFAULT_TOP_COUNT).length).toBe(1000);
  });
});
