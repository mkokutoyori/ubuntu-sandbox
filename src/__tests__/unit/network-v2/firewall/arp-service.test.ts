/**
 * `ArpService` — le cache de voisins du pare-feu.
 *
 * Audit prealable. `src/network/arp/` existe mais porte l'INSPECTION ARP
 * (DAI — une fonction de securite de commutateur), pas un resolveur :
 * `ArpInspectionEngine`, `ArpRateLimiter`, `ArpStats`. Aucun cache de
 * voisins reutilisable.
 *
 * En revanche `core/interfaces.ts` DECLARE deja le contrat
 * `INeighborResolver<TAddress>` — `resolve`, `learn`, `lookup`, `getCache`,
 * `clear` — pensé pour unifier ARP et NDP. Ce service l'IMPLEMENTE plutot
 * que d'inventer une interface voisine, ce qui est exactement la regle que
 * ce carnet s'est donnee : enrichir l'existant, ne pas le doubler.
 *
 * Trois faits que ces cas fixent :
 *
 * — Un pare-feu ne repond a une demande ARP que pour les adresses QU'IL
 *   PORTE. Repondre pour autrui est du proxy ARP, une fonction distincte
 *   qui se configure, et l'activer par defaut ferait du pare-feu un trou
 *   noir pour tout le sous-reseau.
 * — Une entree APPRISE expire ; une entree STATIQUE non. C'est ce qui
 *   distingue une table qui suit le reseau d'une table qui le decrete.
 * — Une demande ARP apprend son EMETTEUR. C'est ce qui evite l'aller-retour
 *   symetrique : quand A demande l'adresse de B, B connait deja A.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ArpService } from '@/network/devices/firewall/l3/ArpService';
import { InterfaceTable } from '@/network/devices/firewall/l3/InterfaceTable';
import { IPAddress, MACAddress, type ARPPacket } from '@/network/core/types';

const FW_MAC_1 = '00:11:22:33:44:01';
const FW_MAC_2 = '00:11:22:33:44:02';
const PEER_MAC = 'aa:bb:cc:dd:ee:ff';

let clock = 1_000_000;

function lab() {
  const interfaces = new InterfaceTable();
  interfaces.configure('port1', { ip: '192.168.1.1', mask: '255.255.255.0' });
  interfaces.configure('port2', { ip: '203.0.113.1', mask: '255.255.255.0' });

  const arp = new ArpService({
    interfaces,
    macOf: (iface) => new MACAddress(iface === 'port1' ? FW_MAC_1 : FW_MAC_2),
    now: () => clock,
  });
  return { arp, interfaces };
}

function request(senderIP: string, senderMAC: string, targetIP: string): ARPPacket {
  return {
    type: 'arp',
    operation: 'request',
    senderMAC: new MACAddress(senderMAC),
    senderIP: new IPAddress(senderIP),
    targetMAC: new MACAddress('00:00:00:00:00:00'),
    targetIP: new IPAddress(targetIP),
  };
}

function reply(senderIP: string, senderMAC: string, targetIP: string, targetMAC: string): ARPPacket {
  return {
    type: 'arp',
    operation: 'reply',
    senderMAC: new MACAddress(senderMAC),
    senderIP: new IPAddress(senderIP),
    targetMAC: new MACAddress(targetMAC),
    targetIP: new IPAddress(targetIP),
  };
}

beforeEach(() => { clock = 1_000_000; });

describe('ArpService — cache', () => {
  it('apprend et retrouve une correspondance', () => {
    const { arp } = lab();

    arp.learn('192.168.1.10', new MACAddress(PEER_MAC), 'port1');

    expect(arp.lookup('192.168.1.10')?.mac.toString()).toBe(PEER_MAC);
    expect(arp.lookup('192.168.1.10')?.iface).toBe('port1');
  });

  it('ne connait pas une adresse jamais apprise', () => {
    expect(lab().arp.lookup('192.168.1.99')).toBeUndefined();
  });

  it('un reapprentissage remplace l\'ancienne adresse MAC', () => {
    const { arp } = lab();
    arp.learn('192.168.1.10', new MACAddress(PEER_MAC), 'port1');

    arp.learn('192.168.1.10', new MACAddress('11:22:33:44:55:66'), 'port1');

    expect(arp.lookup('192.168.1.10')?.mac.toString()).toBe('11:22:33:44:55:66');
  });

  it('expose le cache complet', () => {
    const { arp } = lab();
    arp.learn('192.168.1.10', new MACAddress(PEER_MAC), 'port1');

    expect(arp.getCache().size).toBe(1);
  });

  it('vide le cache', () => {
    const { arp } = lab();
    arp.learn('192.168.1.10', new MACAddress(PEER_MAC), 'port1');

    arp.clear();

    expect(arp.getCache().size).toBe(0);
  });

  it('vide seulement les entrees d\'une interface', () => {
    const { arp } = lab();
    arp.learn('192.168.1.10', new MACAddress(PEER_MAC), 'port1');
    arp.learn('203.0.113.9', new MACAddress(PEER_MAC), 'port2');

    arp.clearInterface('port1');

    expect(arp.lookup('192.168.1.10')).toBeUndefined();
    expect(arp.lookup('203.0.113.9')).toBeDefined();
  });
});

describe('ArpService — expiration', () => {
  it('une entree APPRISE expire', () => {
    const { arp } = lab();
    arp.learn('192.168.1.10', new MACAddress(PEER_MAC), 'port1');

    clock += 4 * 3600 * 1000;
    arp.sweep();

    expect(arp.lookup('192.168.1.10')).toBeUndefined();
  });

  it('une entree STATIQUE n\'expire pas', () => {
    const { arp } = lab();
    arp.setStatic('192.168.1.10', new MACAddress(PEER_MAC), 'port1');

    clock += 4 * 3600 * 1000;
    arp.sweep();

    expect(arp.lookup('192.168.1.10')).toBeDefined();
  });

  it('reapprendre repousse l\'echeance', () => {
    const { arp } = lab();
    arp.learn('192.168.1.10', new MACAddress(PEER_MAC), 'port1');

    clock += 3000 * 1000;
    arp.learn('192.168.1.10', new MACAddress(PEER_MAC), 'port1');
    clock += 3000 * 1000;

    expect(arp.sweep()).toBe(0);
  });

  it('honore le delai de vieillissement fourni', () => {
    const { interfaces } = lab();
    const arp = new ArpService({
      interfaces, macOf: () => new MACAddress(FW_MAC_1), now: () => clock, agingSec: 60,
    });
    arp.learn('192.168.1.10', new MACAddress(PEER_MAC), 'port1');

    clock += 61_000;

    expect(arp.sweep()).toBe(1);
  });
});

describe('ArpService — repondre a une demande', () => {
  it('repond quand la cible est une adresse QU\'IL PORTE', () => {
    const { arp } = lab();

    const answer = arp.handleRequest(request('192.168.1.10', PEER_MAC, '192.168.1.1'), 'port1');

    expect(answer).toBeDefined();
    expect(answer?.operation).toBe('reply');
    expect(answer?.senderIP.toString()).toBe('192.168.1.1');
    expect(answer?.senderMAC.toString()).toBe(FW_MAC_1);
  });

  it('la reponse est adressee au demandeur', () => {
    const { arp } = lab();

    const answer = arp.handleRequest(request('192.168.1.10', PEER_MAC, '192.168.1.1'), 'port1');

    expect(answer?.targetIP.toString()).toBe('192.168.1.10');
    expect(answer?.targetMAC.toString()).toBe(PEER_MAC);
  });

  it('NE REPOND PAS pour une adresse qu\'il ne porte pas — ce serait du proxy ARP', () => {
    const { arp } = lab();

    const answer = arp.handleRequest(request('192.168.1.10', PEER_MAC, '192.168.1.50'), 'port1');

    expect(answer).toBeUndefined();
  });

  it('ne repond pas pour l\'adresse d\'une AUTRE de ses interfaces', () => {
    const { arp } = lab();

    const answer = arp.handleRequest(request('192.168.1.10', PEER_MAC, '203.0.113.1'), 'port1');

    expect(answer).toBeUndefined();
  });

  it('APPREND l\'emetteur d\'une demande, meme sans y repondre', () => {
    const { arp } = lab();

    arp.handleRequest(request('192.168.1.10', PEER_MAC, '192.168.1.50'), 'port1');

    expect(arp.lookup('192.168.1.10')?.mac.toString()).toBe(PEER_MAC);
  });
});

describe('ArpService — reponses recues et ARP gratuit', () => {
  it('apprend d\'une reponse recue', () => {
    const { arp } = lab();

    arp.handleReply(reply('192.168.1.10', PEER_MAC, '192.168.1.1', FW_MAC_1), 'port1');

    expect(arp.lookup('192.168.1.10')?.mac.toString()).toBe(PEER_MAC);
  });

  it('apprend d\'un ARP gratuit — sender et target identiques', () => {
    const { arp } = lab();

    arp.handleRequest(request('192.168.1.10', PEER_MAC, '192.168.1.10'), 'port1');

    expect(arp.lookup('192.168.1.10')?.mac.toString()).toBe(PEER_MAC);
  });

  it('construit sa propre demande pour une adresse a resoudre', () => {
    const { arp } = lab();

    const query = arp.buildRequest('192.168.1.10', 'port1');

    expect(query?.operation).toBe('request');
    expect(query?.senderIP.toString()).toBe('192.168.1.1');
    expect(query?.senderMAC.toString()).toBe(FW_MAC_1);
    expect(query?.targetIP.toString()).toBe('192.168.1.10');
  });

  it('ne construit pas de demande sur une interface sans adresse', () => {
    const { arp, interfaces } = lab();
    interfaces.configure('port3', {});

    expect(arp.buildRequest('10.0.0.1', 'port3')).toBeUndefined();
  });

  it('construit un ARP gratuit pour ses propres adresses', () => {
    const { arp } = lab();

    const gratuit = arp.buildGratuitous('port1');

    expect(gratuit?.senderIP.toString()).toBe('192.168.1.1');
    expect(gratuit?.targetIP.toString()).toBe('192.168.1.1');
  });
});

describe('ArpService — resolution asynchrone du contrat INeighborResolver', () => {
  it('resout immediatement depuis le cache', async () => {
    const { arp } = lab();
    arp.learn('192.168.1.10', new MACAddress(PEER_MAC), 'port1');

    await expect(arp.resolve('192.168.1.10', 'port1')).resolves.toBeDefined();
  });

  it('echoue quand l\'adresse est inconnue et que rien ne repond', async () => {
    const { arp } = lab();

    await expect(arp.resolve('192.168.1.99', 'port1')).rejects.toThrow();
  });

  it('reussit quand une reponse arrive pendant l\'attente', async () => {
    const { arp } = lab();

    const pending = arp.resolve('192.168.1.10', 'port1');
    arp.handleReply(reply('192.168.1.10', PEER_MAC, '192.168.1.1', FW_MAC_1), 'port1');

    await expect(pending).resolves.toBeDefined();
  });
});
