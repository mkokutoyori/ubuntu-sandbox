/**
 * SONDE DE PHASE 1 — le pare-feu comme EQUIPEMENT, sur un vrai cable.
 *
 * Tout ce qui precede dans ce module etait teste en isolation. Ici le
 * pare-feu est depose entre deux postes Linux, cable pour de bon, et le
 * trafic est un VRAI `ping` : des trames traversent `Port` et `Cable`,
 * l'ARP est resolu par un vrai echange, et le verdict vient du pipeline.
 *
 * C'est le principe P6 du BRD applique au module entier — rien ne
 * contourne le fil. Un pare-feu dont le trafic passerait par un appel de
 * methode sur l'objet voisin ne demontrerait rien.
 *
 * Les trois cas qui comptent :
 *
 * — UC-1 sur le fil : une seule regle dans le sens aller, et le ping
 *   REPOND — parce que la session existe, pas parce qu'une regle autorise
 *   le retour.
 * — Le temoin : la MEME topologie sans regle ne repond pas. Sans ce
 *   temoin, un laboratoire mal cable et un pare-feu qui laisse tout passer
 *   seraient indiscernables.
 * — L'inverse : une regle qui autorise SEULEMENT le retour ne suffit pas,
 *   puisque c'est l'aller qui ouvre la session.
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

async function buildLab() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const fw = new Firewall('firewall-generic', 'FW1', 0, 0);
  const h1 = new LinuxPC('linux-pc', 'H1', -100, 0);
  const h2 = new LinuxPC('linux-pc', 'H2', 100, 0);

  new Cable('a').connect(h1.getPort('eth0')!, fw.getPort('ethernet1/1')!);
  new Cable('b').connect(fw.getPort('ethernet1/2')!, h2.getPort('eth0')!);

  fw.configureInterface('ethernet1/1', { ip: '10.0.1.1', mask: '255.255.255.0' });
  fw.configureInterface('ethernet1/2', { ip: '10.0.2.1', mask: '255.255.255.0' });

  const zones = fw.getZoneTable();
  zones.createZone('trust');
  zones.createZone('untrust');
  zones.assignInterface('trust', 'ethernet1/1');
  zones.assignInterface('untrust', 'ethernet1/2');

  await run(h1, ['ip link set eth0 up', 'ip addr add 10.0.1.10/24 dev eth0',
    'ip route add default via 10.0.1.1']);
  await run(h2, ['ip link set eth0 up', 'ip addr add 10.0.2.10/24 dev eth0',
    'ip route add default via 10.0.2.1']);

  return { fw, h1, h2 };
}

function allowTrustToUntrust(fw: Firewall) {
  fw.getPolicyStore().append({
    id: 'R1', name: 'Allow-Out', from: ['trust'], to: ['untrust'], action: 'allow',
  });
}

beforeEach(() => { Logger.reset(); });

describe('Firewall — l\'equipement', () => {
  it('porte des ports cablables', async () => {
    const { fw } = await buildLab();

    expect(fw.getPort('ethernet1/1')).toBeDefined();
    expect(fw.getPortNames().length).toBeGreaterThanOrEqual(2);
  });

  it('expose ses magasins', async () => {
    const { fw } = await buildLab();

    expect(fw.getZoneTable().list()).toHaveLength(2);
    expect(fw.getSessionTable().count()).toBe(0);
    expect(fw.getPolicyStore().ordered()).toHaveLength(0);
  });

  it('configurer une interface pose l\'adresse sur le PORT aussi', async () => {
    const { fw } = await buildLab();

    expect(fw.getPort('ethernet1/1')?.getIPAddress()?.toString()).toBe('10.0.1.1');
  });

  it('derive ses routes connectees de ses interfaces', async () => {
    const { fw } = await buildLab();

    expect(fw.getRouteTable().all()).toHaveLength(2);
  });
});

describe('Firewall — UC-1 SUR LE FIL', () => {
  it('LE PING TRAVERSE avec une seule regle dans le sens aller', async () => {
    const { fw, h1 } = await buildLab();
    allowTrustToUntrust(fw);

    const out = await pingOnSimulatedClock(h1, 'ping -c 1 10.0.2.10');

    expect(out).toMatch(/, 0% packet loss/);
  });

  it('LE TEMOIN : la meme topologie SANS regle ne repond pas', async () => {
    const { h1 } = await buildLab();

    const out = await pingOnSimulatedClock(h1, 'ping -c 1 10.0.2.10');

    expect(out).toMatch(/, 100% packet loss/);
  });

  it('une regle qui n\'autorise QUE le retour ne suffit pas', async () => {
    const { fw, h1 } = await buildLab();
    fw.getPolicyStore().append({
      id: 'R1', from: ['untrust'], to: ['trust'], action: 'allow',
    });

    const out = await pingOnSimulatedClock(h1, 'ping -c 1 10.0.2.10');

    expect(out).toMatch(/, 100% packet loss/);
  });

  it('le ping INSTALLE une session, visible dans la table', async () => {
    const { fw, h1 } = await buildLab();
    allowTrustToUntrust(fw);

    await pingOnSimulatedClock(h1, 'ping -c 1 10.0.2.10');

    const sessions = fw.getSessionTable().view().all();
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0].ingressZone).toBe('trust');
    expect(sessions[0].egressZone).toBe('untrust');
  });

  it('la regle qui a autorise le flux porte un compteur non nul', async () => {
    const { fw, h1 } = await buildLab();
    allowTrustToUntrust(fw);

    await pingOnSimulatedClock(h1, 'ping -c 1 10.0.2.10');

    expect(fw.getPolicyStore().byId('R1')!.hitCount).toBeGreaterThan(0);
  });
});

describe('Firewall — de VRAIES trames sur le cable', () => {
  it('des trames traversent le cable dans les deux sens', async () => {
    const { fw, h1 } = await buildLab();
    allowTrustToUntrust(fw);

    await pingOnSimulatedClock(h1, 'ping -c 1 10.0.2.10');

    const p1 = fw.getPort('ethernet1/1')!.getCounters();
    const p2 = fw.getPort('ethernet1/2')!.getCounters();
    expect(p1.framesIn).toBeGreaterThan(0);
    expect(p2.framesOut).toBeGreaterThan(0);
    expect(p2.framesIn).toBeGreaterThan(0);
    expect(p1.framesOut).toBeGreaterThan(0);
  });

  it('LA DIFFERENCE de trames est imputable au ping, pas au bruit de fond', async () => {
    const sansPing = await buildLab();
    allowTrustToUntrust(sansPing.fw);
    const repos = sansPing.fw.getPort('ethernet1/2')!.getCounters().framesOut;

    const avecPing = await buildLab();
    allowTrustToUntrust(avecPing.fw);
    await pingOnSimulatedClock(avecPing.h1, 'ping -c 1 10.0.2.10');
    const apres = avecPing.fw.getPort('ethernet1/2')!.getCounters().framesOut;

    expect(apres - repos).toBeGreaterThan(0);
  });

  it('le pare-feu repond a l\'ARP pour SA propre adresse de passerelle', async () => {
    const { fw, h1 } = await buildLab();
    allowTrustToUntrust(fw);

    await pingOnSimulatedClock(h1, 'ping -c 1 10.0.2.10');

    expect(fw.getArpService().resolved('10.0.1.10')).toBeDefined();
  });

  it('un flux refuse ne fait sortir AUCUNE trame cote untrust', async () => {
    const { fw, h1 } = await buildLab();
    const avant = fw.getPort('ethernet1/2')!.getCounters().framesOut;

    await pingOnSimulatedClock(h1, 'ping -c 1 10.0.2.10');

    expect(fw.getPort('ethernet1/2')!.getCounters().framesOut).toBe(avant);
  });
});

describe('Firewall — le pare-feu lui-meme', () => {
  it('repond au ping sur son adresse d\'interface', async () => {
    const { h1 } = await buildLab();

    const out = await pingOnSimulatedClock(h1, 'ping -c 1 10.0.1.1');

    expect(out).toMatch(/, 0% packet loss/);
  });

  it('une interface abaissee coupe le trafic', async () => {
    const { fw, h1 } = await buildLab();
    allowTrustToUntrust(fw);
    fw.getInterfaceTable().setUp('ethernet1/2', false);

    const out = await pingOnSimulatedClock(h1, 'ping -c 1 10.0.2.10');

    expect(out).toMatch(/, 100% packet loss/);
  });
});
