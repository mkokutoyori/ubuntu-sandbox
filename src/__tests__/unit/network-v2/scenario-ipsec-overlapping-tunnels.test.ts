import { describe, it, expect, beforeEach } from 'vitest';
import {
  resetCounters, IPAddress, IP_PROTO_ICMP, IP_PROTO_ESP, nextIPv4Id,
} from '@/network/core/types';
import type { IPv4Packet } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface EngineInternal {
  findMatchingCryptoEntry(pkt: IPv4Packet, egressIface: string): unknown;
  findAllMatchingCryptoEntries(pkt: IPv4Packet, egressIface: string): Array<{
    seq: number; peers: string[]; aclName: string;
  }>;
}

const HUB_WAN = '10.0.0.1';
const PEER_A = '10.0.0.10';
const PEER_B = '10.0.0.20';
const PEER_C = '10.0.0.30';

function pkt(dstIp: string, srcIp = '192.168.100.10', protocol = IP_PROTO_ICMP): IPv4Packet {
  return {
    type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 84,
    identification: nextIPv4Id(), flags: 0, fragmentOffset: 0, ttl: 64,
    protocol, headerChecksum: 0,
    sourceIP: new IPAddress(srcIp),
    destinationIP: new IPAddress(dstIp),
    payload: null,
  } as unknown as IPv4Packet;
}

async function configureHub(
  router: CiscoRouter,
  entries: Array<{ seq: number; peer: string; aclName: string; dstNet: string; dstWildcard: string }>,
): Promise<void> {
  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', `ip address ${HUB_WAN} 255.255.255.0`, 'no shutdown', 'exit',
    'crypto isakmp policy 10',
    'encryption aes 256', 'hash sha256', 'authentication pre-share', 'group 14', 'exit',
    'crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
  ]) await router.executeCommand(cmd);

  for (const e of entries) {
    await router.executeCommand(`crypto isakmp key SharedSecret address ${e.peer}`);
    await router.executeCommand(`ip access-list extended ${e.aclName}`);
    await router.executeCommand(`permit ip 192.168.100.0 0.0.0.255 ${e.dstNet} ${e.dstWildcard}`);
    await router.executeCommand('exit');
    await router.executeCommand(`crypto map CMAP ${e.seq} ipsec-isakmp`);
    await router.executeCommand(`set peer ${e.peer}`);
    await router.executeCommand('set transform-set TSET');
    await router.executeCommand(`match address ${e.aclName}`);
    await router.executeCommand('exit');
  }
  await router.executeCommand('interface GigabitEthernet0/1');
  await router.executeCommand('crypto map CMAP');
  await router.executeCommand('end');
}

function getEngine(r: CiscoRouter): EngineInternal {
  return (r as unknown as { _getIPSecEngineInternal(): EngineInternal })._getIPSecEngineInternal();
}

describe('Scénario 11 — Coexistence de tunnels IPsec sur une même passerelle', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
  });

  describe('Configuration cohérente', () => {
    it('show crypto map liste les trois entrées avec pairs et ACL distincts', async () => {
      const hub = new CiscoRouter('HUB');
      await configureHub(hub, [
        { seq: 5,  peer: PEER_C, aclName: 'ACL_C', dstNet: '10.1.0.128', dstWildcard: '0.0.0.127' },
        { seq: 10, peer: PEER_A, aclName: 'ACL_A', dstNet: '10.1.0.0',   dstWildcard: '0.0.0.255' },
        { seq: 20, peer: PEER_B, aclName: 'ACL_B', dstNet: '10.2.0.0',   dstWildcard: '0.0.0.255' },
      ]);
      const map = await hub.executeCommand('show crypto map');
      expect(map).toMatch(/Peer = 10\.0\.0\.10/);
      expect(map).toMatch(/Peer = 10\.0\.0\.20/);
      expect(map).toMatch(/Peer = 10\.0\.0\.30/);
      expect(map).toMatch(/ACL_A/);
      expect(map).toMatch(/ACL_B/);
      expect(map).toMatch(/ACL_C/);
    });
  });

  describe('Sélection du bon tunnel selon la destination', () => {
    it('un paquet vers le site A (10.1.0.5) sélectionne le tunnel avec le pair A', async () => {
      const hub = new CiscoRouter('HUB');
      await configureHub(hub, [
        { seq: 5,  peer: PEER_C, aclName: 'ACL_C', dstNet: '10.1.0.128', dstWildcard: '0.0.0.127' },
        { seq: 10, peer: PEER_A, aclName: 'ACL_A', dstNet: '10.1.0.0',   dstWildcard: '0.0.0.255' },
        { seq: 20, peer: PEER_B, aclName: 'ACL_B', dstNet: '10.2.0.0',   dstWildcard: '0.0.0.255' },
      ]);
      const eng = getEngine(hub);
      const entry = eng.findMatchingCryptoEntry(pkt('10.1.0.5'), 'GigabitEthernet0/1') as { peers: string[] };
      expect(entry).not.toBeNull();
      expect(entry.peers).toContain(PEER_A);
    });

    it('un paquet vers le site B (10.2.0.5) sélectionne le tunnel avec le pair B', async () => {
      const hub = new CiscoRouter('HUB');
      await configureHub(hub, [
        { seq: 5,  peer: PEER_C, aclName: 'ACL_C', dstNet: '10.1.0.128', dstWildcard: '0.0.0.127' },
        { seq: 10, peer: PEER_A, aclName: 'ACL_A', dstNet: '10.1.0.0',   dstWildcard: '0.0.0.255' },
        { seq: 20, peer: PEER_B, aclName: 'ACL_B', dstNet: '10.2.0.0',   dstWildcard: '0.0.0.255' },
      ]);
      const eng = getEngine(hub);
      const entry = eng.findMatchingCryptoEntry(pkt('10.2.0.5'), 'GigabitEthernet0/1') as { peers: string[] };
      expect(entry.peers).toContain(PEER_B);
    });

    it("en cas de chevauchement (10.1.0.200 dans /24 ET /25), la règle la plus spécifique doit primer", async () => {
      const hub = new CiscoRouter('HUB');
      await configureHub(hub, [
        { seq: 5,  peer: PEER_C, aclName: 'ACL_C', dstNet: '10.1.0.128', dstWildcard: '0.0.0.127' },
        { seq: 10, peer: PEER_A, aclName: 'ACL_A', dstNet: '10.1.0.0',   dstWildcard: '0.0.0.255' },
        { seq: 20, peer: PEER_B, aclName: 'ACL_B', dstNet: '10.2.0.0',   dstWildcard: '0.0.0.255' },
      ]);
      const eng = getEngine(hub);
      const entry = eng.findMatchingCryptoEntry(pkt('10.1.0.200'), 'GigabitEthernet0/1') as { peers: string[] };
      expect(entry.peers).toContain(PEER_C);
      expect(entry.peers).not.toContain(PEER_A);
    });

    it('un paquet hors de tout sélecteur → aucun tunnel sélectionné (envoyé en clair)', async () => {
      const hub = new CiscoRouter('HUB');
      await configureHub(hub, [
        { seq: 5,  peer: PEER_C, aclName: 'ACL_C', dstNet: '10.1.0.128', dstWildcard: '0.0.0.127' },
        { seq: 10, peer: PEER_A, aclName: 'ACL_A', dstNet: '10.1.0.0',   dstWildcard: '0.0.0.255' },
      ]);
      const eng = getEngine(hub);
      const entry = eng.findMatchingCryptoEntry(pkt('8.8.8.8'), 'GigabitEthernet0/1');
      expect(entry).toBeNull();
    });

    it("les paquets ESP déjà encapsulés ne sont pas ré-encryptés (pas de tunnel dans le tunnel)", async () => {
      const hub = new CiscoRouter('HUB');
      await configureHub(hub, [
        { seq: 10, peer: PEER_A, aclName: 'ACL_A', dstNet: '10.1.0.0', dstWildcard: '0.0.0.255' },
      ]);
      const eng = getEngine(hub);
      const entry = eng.findMatchingCryptoEntry(pkt('10.1.0.5', '192.168.100.10', IP_PROTO_ESP), 'GigabitEthernet0/1');
      expect(entry).toBeNull();
    });
  });

  describe('Priorité et détection du chevauchement', () => {
    it("l'ordonnancement des séquences est déterminant : general-first ↦ le général capte le trafic spécifique", async () => {
      const hub = new CiscoRouter('HUB');
      await configureHub(hub, [
        { seq: 5,  peer: PEER_A, aclName: 'ACL_A', dstNet: '10.1.0.0',   dstWildcard: '0.0.0.255' },
        { seq: 10, peer: PEER_C, aclName: 'ACL_C', dstNet: '10.1.0.128', dstWildcard: '0.0.0.127' },
      ]);
      const eng = getEngine(hub);
      const entry = eng.findMatchingCryptoEntry(pkt('10.1.0.200'), 'GigabitEthernet0/1') as { peers: string[] };
      expect(entry.peers).toContain(PEER_A);
    });

    it("findAllMatchingCryptoEntries retourne tous les sélecteurs concordants pour audit", async () => {
      const hub = new CiscoRouter('HUB');
      await configureHub(hub, [
        { seq: 5,  peer: PEER_C, aclName: 'ACL_C', dstNet: '10.1.0.128', dstWildcard: '0.0.0.127' },
        { seq: 10, peer: PEER_A, aclName: 'ACL_A', dstNet: '10.1.0.0',   dstWildcard: '0.0.0.255' },
      ]);
      const eng = getEngine(hub);
      const all = eng.findAllMatchingCryptoEntries(pkt('10.1.0.200'), 'GigabitEthernet0/1');
      expect(all.length).toBe(2);
      expect(all[0].seq).toBe(5);
      expect(all[1].seq).toBe(10);
    });

    it("un warning est journalisé quand un paquet correspond à plusieurs sélecteurs simultanément", async () => {
      const hub = new CiscoRouter('HUB');
      await configureHub(hub, [
        { seq: 5,  peer: PEER_C, aclName: 'ACL_C', dstNet: '10.1.0.128', dstWildcard: '0.0.0.127' },
        { seq: 10, peer: PEER_A, aclName: 'ACL_A', dstNet: '10.1.0.0',   dstWildcard: '0.0.0.255' },
      ]);
      const eng = getEngine(hub);
      Logger.reset();
      eng.findAllMatchingCryptoEntries(pkt('10.1.0.200'), 'GigabitEthernet0/1');
      const warns = Logger.getLogs().filter(e => e.level === 'warn' && /overlap|Multiple crypto/i.test(e.message ?? ''));
      expect(warns.length).toBeGreaterThan(0);
      expect(warns[0].message).toMatch(/seq 5/);
      expect(warns[0].message).toMatch(/wins/i);
    });

    it("un paquet non chevauché ne déclenche aucun warning d'overlap", async () => {
      const hub = new CiscoRouter('HUB');
      await configureHub(hub, [
        { seq: 5,  peer: PEER_C, aclName: 'ACL_C', dstNet: '10.1.0.128', dstWildcard: '0.0.0.127' },
        { seq: 10, peer: PEER_B, aclName: 'ACL_B', dstNet: '10.2.0.0',   dstWildcard: '0.0.0.255' },
      ]);
      const eng = getEngine(hub);
      Logger.reset();
      eng.findAllMatchingCryptoEntries(pkt('10.2.0.10'), 'GigabitEthernet0/1');
      const warns = Logger.getLogs().filter(e => e.level === 'warn' && /overlap/i.test(e.message ?? ''));
      expect(warns.length).toBe(0);
    });
  });

  describe('Isolation stricte entre tunnels', () => {
    it('les trois destinations mappent trois pairs distincts, sans contamination', async () => {
      const hub = new CiscoRouter('HUB');
      await configureHub(hub, [
        { seq: 5,  peer: PEER_C, aclName: 'ACL_C', dstNet: '10.1.0.128', dstWildcard: '0.0.0.127' },
        { seq: 10, peer: PEER_A, aclName: 'ACL_A', dstNet: '10.1.0.0',   dstWildcard: '0.0.0.255' },
        { seq: 20, peer: PEER_B, aclName: 'ACL_B', dstNet: '10.2.0.0',   dstWildcard: '0.0.0.255' },
      ]);
      const eng = getEngine(hub);
      const chosen = new Set<string>();
      for (const dst of ['10.1.0.5', '10.2.0.5', '10.1.0.200']) {
        const e = eng.findMatchingCryptoEntry(pkt(dst), 'GigabitEthernet0/1') as { peers: string[] };
        chosen.add(e.peers[0]);
      }
      expect(chosen.size).toBe(3);
      expect(chosen).toEqual(new Set([PEER_A, PEER_B, PEER_C]));
    });
  });
});
