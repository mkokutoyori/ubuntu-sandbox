/**
 * La simulation d'un paquet — le socle derriere `packet-tracer`.
 *
 * BRD-Firewall, invariant I-F3 : un outil de diagnostic doit lire le VRAI
 * pipeline. Une commande qui rejouerait la decision dans son coin
 * decrirait un pare-feu qui n'est pas celui qui filtre — et le jour ou les
 * deux divergent, c'est le diagnostic qu'on croit, pas la machine.
 *
 * D'ou la contrainte centrale de ce fichier : la simulation traverse les
 * MEMES etapes, dans le MEME ordre, et rend la MEME trace qu'un paquet
 * arrive par le cable. Ce qu'elle ne fait pas, c'est laisser quelque chose
 * derriere elle — verifie contre la documentation Cisco plutot que suppose :
 * `packet-tracer` simule, il ne cree ni connexion ni traduction.
 *
 * Les deux moities sont testees separement parce qu'elles peuvent echouer
 * separement : « la trace est la meme » et « rien n'a bouge ».
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Firewall } from '@/network/devices/firewall/Firewall';
import { buildSimulatedPacket } from '@/network/devices/firewall/pipeline/SimulatedPacket';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function lab() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const fw = new Firewall('firewall-generic', 'FW1', 0, 0);
  const ports = fw.getPortNames();

  fw.configureInterface(ports[0], { ip: '192.168.1.1', mask: '255.255.255.0' });
  fw.configureInterface(ports[1], { ip: '203.0.113.1', mask: '255.255.255.0' });
  fw.getZoneTable().createZone('trust');
  fw.getZoneTable().createZone('untrust');
  fw.getZoneTable().assignInterface('trust', ports[0]);
  fw.getZoneTable().assignInterface('untrust', ports[1]);

  return { fw, inside: ports[0], outside: ports[1] };
}

function permitAll(fw: Firewall) {
  fw.getPolicyStore().append({
    id: 'P1', from: ['trust'], to: ['untrust'], action: 'allow',
  });
}

const FLOW = {
  protocol: 'tcp' as const,
  sourceIP: '192.168.1.10', sourcePort: 44001,
  destinationIP: '203.0.113.10', destinationPort: 443,
};

beforeEach(() => { Logger.reset(); });

describe('Firewall.simulate — la trace vient du VRAI pipeline', () => {
  it('rend une trace non vide', () => {
    const { fw, inside } = lab();
    permitAll(fw);

    const result = fw.simulate({ ingressPort: inside, ...FLOW });

    expect(result.trace.length).toBeGreaterThan(0);
  });

  it('traverse les etapes du profil, dans l\'ordre du profil', () => {
    const { fw, inside } = lab();
    permitAll(fw);

    const result = fw.simulate({ ingressPort: inside, ...FLOW });
    const traversed = result.trace.map(entry => entry.stage);

    const expected = fw.getProfile().pipeline.filter(name => traversed.includes(name));
    expect(traversed.filter(name => expected.includes(name))).toEqual(expected);
  });

  it('conclut ACCEPTE quand une regle autorise', () => {
    const { fw, inside } = lab();
    permitAll(fw);

    expect(fw.simulate({ ingressPort: inside, ...FLOW }).allowed).toBe(true);
  });

  it('conclut REFUSE sans aucune regle, et nomme le motif', () => {
    const { fw, inside } = lab();

    const result = fw.simulate({ ingressPort: inside, ...FLOW });

    expect(result.allowed).toBe(false);
    expect(result.verdict?.reason).toBe('implicit-deny');
  });

  it('nomme l\'ETAPE qui a tranche — c\'est ce qu\'on vient chercher', () => {
    const { fw, inside } = lab();

    expect(fw.simulate({ ingressPort: inside, ...FLOW }).verdict?.stage)
      .toBe('policy-lookup');
  });

  it('nomme la REGLE qui a filtre', () => {
    const { fw, inside } = lab();
    fw.getPolicyStore().append({
      id: 'BLOQUE', from: ['trust'], to: ['untrust'], action: 'deny',
    });

    expect(fw.simulate({ ingressPort: inside, ...FLOW }).verdict?.ruleId).toBe('BLOQUE');
  });

  it('resout la zone d\'entree et celle de sortie', () => {
    const { fw, inside } = lab();
    permitAll(fw);

    const result = fw.simulate({ ingressPort: inside, ...FLOW });

    expect(result.ingressZone).toBe('trust');
    expect(result.egressZone).toBe('untrust');
  });

  it('une destination sans route s\'arrete a la recherche de route', () => {
    const { fw, inside } = lab();
    permitAll(fw);

    const result = fw.simulate({
      ingressPort: inside, ...FLOW, destinationIP: '198.51.100.7',
    });

    expect(result.allowed).toBe(false);
    expect(result.verdict?.reason).toBe('no-route');
  });

  it('un port d\'entree inconnu est refuse avant tout', () => {
    const { fw } = lab();

    expect(() => fw.simulate({ ingressPort: 'fantome', ...FLOW })).toThrow();
  });
});

describe('Firewall.simulate — elle ne laisse RIEN derriere elle', () => {
  it('n\'installe aucune session', () => {
    const { fw, inside } = lab();
    permitAll(fw);

    fw.simulate({ ingressPort: inside, ...FLOW });

    expect(fw.getSessionTable().count()).toBe(0);
  });

  it('n\'installe pas davantage de session de rejet quand elle refuse', () => {
    const { fw, inside } = lab();

    fw.simulate({ ingressPort: inside, ...FLOW });

    expect(fw.getSessionTable().count()).toBe(0);
  });

  it('cent simulations ne remplissent pas la table', () => {
    const { fw, inside } = lab();
    permitAll(fw);

    for (let index = 0; index < 100; index++) {
      fw.simulate({ ingressPort: inside, ...FLOW, sourcePort: 40000 + index });
    }

    expect(fw.getSessionTable().count()).toBe(0);
  });

  it('ne consomme aucun port de traduction', () => {
    const { fw, inside, outside } = lab();
    permitAll(fw);
    fw.getNatPolicy().append({
      id: 'N1', fromZone: ['trust'], toZone: ['untrust'],
      type: 'dynamic-pat',
      sourceTranslation: { kind: 'dynamic-ip-and-port', translatedAddress: ['203.0.113.1'] },
    });

    for (let index = 0; index < 20; index++) {
      fw.simulate({ ingressPort: inside, ...FLOW, sourcePort: 40000 + index });
    }

    expect(fw.getNatEngine().statistics().portsInUse).toBe(0);
    expect(outside).toBeDefined();
  });

  it('elle N\'EFFACE PAS non plus une traduction vivante — le temoin', () => {
    const { fw, inside, outside } = lab();
    permitAll(fw);
    fw.getNatPolicy().append({
      id: 'N1', fromZone: ['trust'], toZone: ['untrust'],
      type: 'dynamic-pat',
      sourceTranslation: { kind: 'dynamic-ip-and-port', translatedAddress: ['203.0.113.1'] },
    });

    const vivante = fw.getNatEngine().translateOutbound(
      buildSimulatedPacket(FLOW),
      {
        ingressZone: 'trust', egressZone: 'untrust',
        ingressInterface: inside, egressInterface: outside,
      },
    );
    const avant = fw.getNatEngine().statistics().portsInUse;

    fw.simulate({ ingressPort: inside, ...FLOW });

    expect(vivante.translation).toBeDefined();
    expect(fw.getNatEngine().statistics().portsInUse).toBe(avant);
  });
});

describe('Firewall.simulate — ce qu\'elle rend a voir', () => {
  it('rend le paquet tel qu\'il est ARRIVE et tel qu\'il PART', () => {
    const { fw, inside } = lab();
    permitAll(fw);
    fw.getNatPolicy().append({
      id: 'N1', fromZone: ['trust'], toZone: ['untrust'],
      type: 'dynamic-pat',
      sourceTranslation: { kind: 'dynamic-ip-and-port', translatedAddress: ['203.0.113.1'] },
    });

    const result = fw.simulate({ ingressPort: inside, ...FLOW });

    expect(result.originalSourceIP).toBe('192.168.1.10');
    expect(result.translatedSourceIP).toBe('203.0.113.1');
  });

  it('sans NAT, les deux adresses sont la meme', () => {
    const { fw, inside } = lab();
    permitAll(fw);

    const result = fw.simulate({ ingressPort: inside, ...FLOW });

    expect(result.translatedSourceIP).toBe(result.originalSourceIP);
  });

  it('nomme l\'interface de sortie choisie par la route', () => {
    const { fw, inside, outside } = lab();
    permitAll(fw);

    expect(fw.simulate({ ingressPort: inside, ...FLOW }).egressPort).toBe(outside);
  });

  it('l\'ICMP se simule aussi', () => {
    const { fw, inside } = lab();
    permitAll(fw);

    const result = fw.simulate({
      ingressPort: inside, protocol: 'icmp',
      sourceIP: '192.168.1.10', sourcePort: 1,
      destinationIP: '203.0.113.10', destinationPort: 8,
    });

    expect(result.allowed).toBe(true);
  });

  it('l\'UDP se simule aussi', () => {
    const { fw, inside } = lab();
    permitAll(fw);

    const result = fw.simulate({ ingressPort: inside, ...FLOW, protocol: 'udp' });

    expect(result.allowed).toBe(true);
  });
});
