/**
 * `FirewallProfile` et sa premiere instance, `ASA_PROFILE`.
 *
 * BRD-Firewall §26.2 : le profil EST le contrat. Ajouter un constructeur
 * doit consister a ecrire une DONNEE, pas a ouvrir un fichier du socle.
 *
 * Ce fichier verifie deux choses distinctes :
 *
 * 1. Que le profil ASA declare ce qu'un ASA fait vraiment — niveaux de
 *    securite, politique liee a l'INTERFACE et non a la zone, ordre
 *    NAT 8.3+ (de-NAT avant l'ACL), configuration immediate.
 * 2. Que l'equipement CONSTRUIT depuis ce profil se comporte en
 *    consequence. Un profil qui declarerait sans que rien ne le lise serait
 *    exactement le defaut « accepte et inerte » que ce depot referme
 *    partout — et le seul moyen de s'en assurer est de faire passer du
 *    trafic.
 *
 * Le cas central est celui des niveaux de securite : inside vers outside
 * passe SANS aucune regle, outside vers inside non. C'est ce qui distingue
 * un ASA de tous les autres pare-feux du BRD, et c'est la premiere chose
 * qu'on enseigne.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AsaFirewall } from '@/network/devices/firewall/vendors/asa/AsaFirewall';
import { ASA_PROFILE } from '@/network/devices/firewall/vendors/asa/AsaProfile';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../../support/fastPing';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

async function buildLab() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const fw = new AsaFirewall('firewall-cisco', 'ASA1', 0, 0);
  const inside = new LinuxPC('linux-pc', 'INSIDE', -100, 0);
  const outside = new LinuxPC('linux-pc', 'OUTSIDE', 100, 0);

  new Cable('a').connect(inside.getPort('eth0')!, fw.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(fw.getPort('GigabitEthernet0/1')!, outside.getPort('eth0')!);

  fw.nameif('GigabitEthernet0/0', 'inside', 100);
  fw.nameif('GigabitEthernet0/1', 'outside', 0);
  fw.configureInterface('GigabitEthernet0/0', { ip: '192.168.1.1', mask: '255.255.255.0' });
  fw.configureInterface('GigabitEthernet0/1', { ip: '203.0.113.1', mask: '255.255.255.0' });

  await run(inside, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1']);
  await run(outside, ['ip link set eth0 up', 'ip addr add 203.0.113.10/24 dev eth0',
    'ip route add default via 203.0.113.1']);

  return { fw, inside, outside };
}

beforeEach(() => { Logger.reset(); });

describe('ASA_PROFILE — ce que le profil DECLARE', () => {
  it('la politique est liee a l\'INTERFACE, pas a la zone', () => {
    expect(ASA_PROFILE.policyKeyedBy).toBe('interface');
  });

  it('la politique implicite suit les NIVEAUX DE SECURITE', () => {
    expect(ASA_PROFILE.implicitPolicy).toBe('security-level');
  });

  it('l\'ordre 8.3+ : la politique voit la destination DE-NATEE', () => {
    expect(ASA_PROFILE.natOrder.destinationNatBeforePolicy).toBe(true);
    expect(ASA_PROFILE.natOrder.policySeesPreNatDestination).toBe(false);
  });

  it('la configuration est IMMEDIATE — pas de candidat', () => {
    expect(ASA_PROFILE.configurationModel).toBe('immediate');
  });

  it('l\'ASA ne fait PAS d\'application shift', () => {
    expect(ASA_PROFILE.applicationShift).toBe(false);
  });

  it('ne declare que les actions qu\'un ASA connait', () => {
    expect([...ASA_PROFILE.supportedActions].sort()).toEqual(['allow', 'deny']);
  });

  it('nomme son contexte virtuel « context »', () => {
    expect(ASA_PROFILE.virtualizationName).toBe('context');
  });

  it('le pipeline place le de-NAT AVANT la recherche de politique', () => {
    const stages = ASA_PROFILE.pipeline.nat;

    expect(stages.indexOf('nat-destination')).toBeLessThan(stages.indexOf('policy-lookup'));
  });

  it('le pipeline place le NAT source APRES la politique', () => {
    const stages = ASA_PROFILE.pipeline.nat;

    expect(stages.indexOf('policy-lookup')).toBeLessThan(stages.indexOf('nat-source'));
  });
});

describe('AsaFirewall — les niveaux de securite, sur le fil', () => {
  it('INSIDE vers OUTSIDE passe SANS aucune regle', async () => {
    const { inside } = await buildLab();

    const out = await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    expect(out).toMatch(/, 0% packet loss/);
  });

  it('OUTSIDE vers INSIDE ne passe PAS sans regle', async () => {
    const { outside } = await buildLab();

    const out = await pingOnSimulatedClock(outside, 'ping -c 1 192.168.1.10');

    expect(out).toMatch(/, 100% packet loss/);
  });

  it('une ACL entrante sur inside ANNULE le permit implicite', async () => {
    const { fw, inside } = await buildLab();
    fw.accessGroup('OUTSIDE_IN', 'GigabitEthernet0/0');

    const out = await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    expect(out).toMatch(/, 100% packet loss/);
  });

  it('le temoin : la MEME ACL contenant un permit laisse passer', async () => {
    const { fw, inside } = await buildLab();
    fw.getPolicyStore().append({
      id: 'A1', from: ['GigabitEthernet0/0'], to: ['GigabitEthernet0/1'], action: 'allow',
    });
    fw.accessGroup('OUTSIDE_IN', 'GigabitEthernet0/0');

    const out = await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    expect(out).toMatch(/, 0% packet loss/);
  });

  it('une regle explicite ouvre OUTSIDE vers INSIDE', async () => {
    const { fw, outside } = await buildLab();
    fw.getPolicyStore().append({
      id: 'A1', from: ['GigabitEthernet0/1'], to: ['GigabitEthernet0/0'], action: 'allow',
    });

    const out = await pingOnSimulatedClock(outside, 'ping -c 1 192.168.1.10');

    expect(out).toMatch(/, 0% packet loss/);
  });
});

describe('AsaFirewall — nameif et niveaux', () => {
  it('`nameif` cree la zone et lui donne son niveau', async () => {
    const { fw } = await buildLab();

    expect(fw.getZoneTable().getZone('inside')?.securityLevel).toBe(100);
    expect(fw.getZoneTable().getZone('outside')?.securityLevel).toBe(0);
  });

  it('`nameif` affecte l\'interface a sa zone', async () => {
    const { fw } = await buildLab();

    expect(fw.getZoneTable().zoneOf('GigabitEthernet0/0')).toBe('inside');
  });

  it('renommer une interface la deplace', async () => {
    const { fw } = await buildLab();

    fw.nameif('GigabitEthernet0/0', 'dmz', 50);

    expect(fw.getZoneTable().zoneOf('GigabitEthernet0/0')).toBe('dmz');
    expect(fw.getZoneTable().getZone('dmz')?.securityLevel).toBe(50);
  });

  it('les ports portent les noms d\'un chassis Cisco', async () => {
    const { fw } = await buildLab();

    expect(fw.getPortNames()[0]).toBe('GigabitEthernet0/0');
  });

  it('expose son profil', async () => {
    const { fw } = await buildLab();

    expect(fw.getProfile().vendor).toBe('asa');
  });
});

describe('AsaFirewall — meme niveau vers meme niveau', () => {
  async function twoDmz() {
    const lab = await buildLab();
    lab.fw.nameif('GigabitEthernet0/1', 'dmz', 100);
    return lab;
  }

  it('meme niveau est REFUSE par defaut', async () => {
    const { inside } = await twoDmz();

    const out = await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    expect(out).toMatch(/, 100% packet loss/);
  });

  it('`same-security-traffic permit inter-interface` l\'autorise', async () => {
    const { fw, inside } = await twoDmz();
    fw.setSameSecurityTraffic('inter-interface', true);

    const out = await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    expect(out).toMatch(/, 0% packet loss/);
  });
});
