/**
 * SONDE DE PHASE 2 — la publication de serveur, sur un vrai cable.
 *
 * La sonde de phase 1 avait prouve l'inspection a etats avec de vraies
 * trames. Celle-ci prouve la TRADUCTION, et surtout sa moitie la plus
 * facile a rater : le RETOUR.
 *
 * L'aller est visible et se teste tout seul — le paquet arrive sur
 * l'adresse publique et repart vers l'adresse reelle. Le retour ne se voit
 * que du cote du CLIENT : le serveur repond avec SA propre adresse, et si
 * le pare-feu ne la reecrit pas en adresse publique, le client recoit une
 * reponse d'une machine a qui il n'a jamais rien demande — et la jette.
 *
 * C'est exactement le defaut que `PRD-Port-Forwarding.md` a du corriger
 * deux fois cote routeur (phase 1 sur `NATEngine` pour les entrees
 * statiques, phase 5 sur `EndHost` faute de toute table de retour). Ce
 * fichier verifie que le modele « la traduction vit sur la session » le
 * rend impossible ici.
 *
 * La topologie evite deliberement le proxy ARP : l'adresse publique
 * n'appartient a AUCUN sous-reseau connecte, donc le client l'atteint par
 * sa route par defaut et le pare-feu la recoit sans avoir a repondre pour
 * elle. Un laboratoire qui aurait mis la VIP dans le sous-reseau du client
 * aurait teste le proxy ARP sans le savoir.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Firewall } from '@/network/devices/firewall/Firewall';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../../support/fastPing';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

const VIP = '203.0.113.10';

async function buildLab() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const fw = new Firewall('firewall-generic', 'FW1', 0, 0);
  const client = new LinuxPC('linux-pc', 'CLIENT', -100, 0);
  const server = new LinuxPC('linux-pc', 'SRV', 100, 0);

  new Cable('a').connect(client.getPort('eth0')!, fw.getPort('ethernet1/1')!);
  new Cable('b').connect(fw.getPort('ethernet1/2')!, server.getPort('eth0')!);

  fw.configureInterface('ethernet1/1', { ip: '198.51.100.1', mask: '255.255.255.0' });
  fw.configureInterface('ethernet1/2', { ip: '192.168.50.1', mask: '255.255.255.0' });

  const zones = fw.getZoneTable();
  zones.createZone('untrust');
  zones.createZone('dmz');
  zones.assignInterface('untrust', 'ethernet1/1');
  zones.assignInterface('dmz', 'ethernet1/2');

  fw.getObjectStore().addAddress({
    name: 'PUB_WEB', kind: 'host', family: 'ipv4', value: VIP,
    predefined: false, tags: [],
  });

  await run(client, ['ip link set eth0 up', 'ip addr add 198.51.100.7/24 dev eth0',
    'ip route add default via 198.51.100.1']);
  await run(server, ['ip link set eth0 up', 'ip addr add 192.168.50.10/24 dev eth0',
    'ip route add default via 192.168.50.1']);

  return { fw, client, server };
}

function publish(fw: Firewall) {
  fw.getNatPolicy().append({
    id: 'D1', name: 'Publish-Web', type: 'static',
    fromZone: ['untrust'], toZone: ['any'], originalDestination: ['PUB_WEB'],
    destinationTranslation: { kind: 'static-ip', translatedAddress: '192.168.50.10' },
  });
}

function allowInbound(fw: Firewall) {
  fw.getPolicyStore().append({
    id: 'R1', name: 'Allow-Pub', from: ['untrust'], to: ['dmz'], action: 'allow',
  });
}

beforeEach(() => { Logger.reset(); });

describe('Sonde phase 2 — la publication repond sur le fil', () => {
  it('LE PING VERS L\'ADRESSE PUBLIQUE ABOUTIT', async () => {
    const { fw, client } = await buildLab();
    publish(fw);
    allowInbound(fw);

    const out = await pingOnSimulatedClock(client, `ping -c 1 ${VIP}`);

    expect(out).toMatch(/, 0% packet loss/);
  });

  it('LE TEMOIN : sans regle NAT, la meme adresse ne repond pas', async () => {
    const { fw, client } = await buildLab();
    allowInbound(fw);

    const out = await pingOnSimulatedClock(client, `ping -c 1 ${VIP}`);

    expect(out).toMatch(/, 100% packet loss/);
  });

  it('LE SECOND TEMOIN : NAT sans regle de politique ne repond pas non plus', async () => {
    const { fw, client } = await buildLab();
    publish(fw);

    const out = await pingOnSimulatedClock(client, `ping -c 1 ${VIP}`);

    expect(out).toMatch(/, 100% packet loss/);
  });

  it('la reponse est attribuee a l\'ADRESSE PUBLIQUE, pas a l\'adresse reelle', async () => {
    const { fw, client } = await buildLab();
    publish(fw);
    allowInbound(fw);

    const out = await pingOnSimulatedClock(client, `ping -c 1 ${VIP}`);

    expect(out).toContain(VIP);
    expect(out).not.toContain('192.168.50.10');
  });

  it('la session porte la traduction, avec sa regle NAT', async () => {
    const { fw, client } = await buildLab();
    publish(fw);
    allowInbound(fw);

    await pingOnSimulatedClock(client, `ping -c 1 ${VIP}`);

    const session = fw.getSessionTable().view().all()[0];
    expect(session.natRuleId).toBe('D1');
    expect(session.translation?.originalDest).toBe(VIP);
    expect(session.translation?.translatedDest).toBe('192.168.50.10');
  });

  it('la regle NAT porte un compteur non nul', async () => {
    const { fw, client } = await buildLab();
    publish(fw);
    allowInbound(fw);

    await pingOnSimulatedClock(client, `ping -c 1 ${VIP}`);

    expect(fw.getNatPolicy().byId('D1')!.hitCount).toBeGreaterThan(0);
  });

  it('le serveur voit le trafic arriver sur SON adresse reelle', async () => {
    const { fw, client, server } = await buildLab();
    publish(fw);
    allowInbound(fw);

    await pingOnSimulatedClock(client, `ping -c 1 ${VIP}`);

    expect(server.getPort('eth0')!.getCounters().framesIn).toBeGreaterThan(0);
  });

  it('de vraies trames traversent les deux cables', async () => {
    const { fw, client } = await buildLab();
    publish(fw);
    allowInbound(fw);

    await pingOnSimulatedClock(client, `ping -c 1 ${VIP}`);

    expect(fw.getPort('ethernet1/1')!.getCounters().framesIn).toBeGreaterThan(0);
    expect(fw.getPort('ethernet1/2')!.getCounters().framesOut).toBeGreaterThan(0);
    expect(fw.getPort('ethernet1/2')!.getCounters().framesIn).toBeGreaterThan(0);
    expect(fw.getPort('ethernet1/1')!.getCounters().framesOut).toBeGreaterThan(0);
  });
});

describe('Sonde phase 2 — PAT sortant sur le fil', () => {
  function patOut(fw: Firewall) {
    fw.getObjectStore().addAddress({
      name: 'DMZ_NET', kind: 'subnet', family: 'ipv4',
      value: '192.168.50.0', careMask: '255.255.255.0', predefined: false, tags: [],
    });
    fw.getNatPolicy().append({
      id: 'S1', type: 'dynamic-pat', fromZone: ['dmz'], toZone: ['untrust'],
      originalSource: ['DMZ_NET'], sourceTranslation: { kind: 'interface-address' },
    });
    fw.getPolicyStore().append({
      id: 'R2', from: ['dmz'], to: ['untrust'], action: 'allow',
    });
  }

  it('le serveur atteint le client, traduit derriere l\'adresse du pare-feu', async () => {
    const { fw, server } = await buildLab();
    patOut(fw);

    const out = await pingOnSimulatedClock(server, 'ping -c 1 198.51.100.7');

    expect(out).toMatch(/, 0% packet loss/);
  });

  it('la session porte la traduction de SOURCE', async () => {
    const { fw, server } = await buildLab();
    patOut(fw);

    await pingOnSimulatedClock(server, 'ping -c 1 198.51.100.7');

    const session = fw.getSessionTable().view().all()[0];
    expect(session.translation?.originalSource).toBe('192.168.50.10');
    expect(session.translation?.translatedSource).toBe('198.51.100.1');
  });
});
