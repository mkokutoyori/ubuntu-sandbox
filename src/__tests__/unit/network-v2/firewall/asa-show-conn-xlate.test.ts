/**
 * `show conn` et `show xlate` — les deux tables qu'un ASA fait consulter.
 *
 * Elles sont testees ensemble parce qu'elles decrivent le MEME flux vu de
 * deux endroits : `show conn` la connexion, `show xlate` la traduction qui
 * lui est attachee. Une machine ou les deux se contrediraient serait
 * indiagnosticable, et c'est precisement ce qui arrive quand deux rendus
 * lisent deux magasins.
 *
 * **Le trafic est REEL.** Un test qui poserait les sessions a la main
 * verifierait le formateur et rien d'autre — or ce qu'on veut savoir est
 * si la table se remplit quand des paquets traversent, et si ce qu'elle
 * annonce correspond a ce qui a circule. Les compteurs d'octets et les
 * drapeaux sont donc des MESURES : `U` dit que la connexion est etablie,
 * `I` qu'il est entre des donnees, `O` qu'il en est sorti (documentation
 * Cisco, verifiee et non ecrite de memoire).
 *
 * L'ordre des champs vient de la meme source, et il n'est pas devinable :
 * `TCP outside <distant>:<port> inside <local>:<port>` — le cote EXTERIEUR
 * d'abord, quel que soit le sens dans lequel la connexion a ete ouverte.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AsaFirewall } from '@/network/devices/firewall/vendors/asa/AsaFirewall';
import { AsaShell } from '@/network/devices/firewall/vendors/asa/AsaShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../../support/fastPing';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(shell: AsaShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = shell.execute(line);
  return last;
}

async function buildLab() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const fw = new AsaFirewall('firewall-cisco', 'ASA1', 0, 0);
  const shell = new AsaShell(fw);
  const inside = new LinuxPC('linux-pc', 'INSIDE', -100, 0);
  const outside = new LinuxPC('linux-pc', 'OUTSIDE', 100, 0);

  new Cable('a').connect(inside.getPort('eth0')!, fw.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(fw.getPort('GigabitEthernet0/1')!, outside.getPort('eth0')!);

  run(shell, 'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'nameif inside',
    'ip address 192.168.1.1 255.255.255.0', 'exit',
    'interface GigabitEthernet0/1', 'nameif outside',
    'ip address 203.0.113.1 255.255.255.0', 'exit', 'end');

  await runOn(inside, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1']);
  await runOn(outside, ['ip link set eth0 up', 'ip addr add 203.0.113.10/24 dev eth0',
    'ip route add default via 203.0.113.1']);

  return { fw, shell, inside, outside };
}

function totalBytes(output: string): number {
  return [...output.matchAll(/bytes (\d+)/g)]
    .reduce((sum, match) => sum + Number(match[1]), 0);
}

beforeEach(() => { Logger.reset(); });

describe('show conn — la table se remplit de VRAI trafic', () => {
  it('une table vide annonce zero', async () => {
    const { shell } = await buildLab();

    expect(run(shell, 'show conn')).toContain('0 in use');
  });

  it('un ping traversant CREE une connexion', async () => {
    const { shell, inside } = await buildLab();

    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    expect(run(shell, 'show conn')).toContain('1 in use');
  });

  it('la ligne nomme le protocole et les deux interfaces', async () => {
    const { shell, inside } = await buildLab();
    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    const out = run(shell, 'show conn');

    expect(out).toContain('ICMP');
    expect(out).toContain('outside');
    expect(out).toContain('inside');
  });

  it('le cote EXTERIEUR est nomme en PREMIER, comme sur un vrai', async () => {
    const { shell, inside } = await buildLab();
    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    const ligne = run(shell, 'show conn').split('\n')[1];

    expect(ligne.indexOf('outside')).toBeLessThan(ligne.indexOf('inside'));
  });

  it('les deux adresses sont celles qui ont vraiment circule', async () => {
    const { shell, inside } = await buildLab();
    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    const out = run(shell, 'show conn');

    expect(out).toContain('203.0.113.10');
    expect(out).toContain('192.168.1.10');
  });

  it('le compteur d\'octets est une MESURE, pas un zero de facade', async () => {
    const { shell, inside } = await buildLab();
    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    const octets = /bytes (\d+)/.exec(run(shell, 'show conn'));

    expect(octets).not.toBeNull();
    expect(Number(octets![1])).toBeGreaterThan(0);
  });

  it('trois pings comptent PLUS d\'octets qu\'un seul — le temoin', async () => {
    const un = await buildLab();
    await pingOnSimulatedClock(un.inside, 'ping -c 1 203.0.113.10');

    const trois = await buildLab();
    await pingOnSimulatedClock(trois.inside, 'ping -c 3 203.0.113.10');

    expect(totalBytes(run(trois.shell, 'show conn')))
      .toBeGreaterThan(totalBytes(run(un.shell, 'show conn')));
  });

  it('`O` dit qu\'il est SORTI des donnees', async () => {
    const { shell, inside } = await buildLab();
    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    expect(/flags \S*O/.test(run(shell, 'show conn'))).toBe(true);
  });

  it('`I` dit qu\'il en est ENTRE — la reponse est revenue', async () => {
    const { shell, inside } = await buildLab();
    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    expect(/flags \S*I/.test(run(shell, 'show conn'))).toBe(true);
  });

  it('un flux dont personne ne repond ne porte pas `I` — le temoin', async () => {
    const { shell, inside } = await buildLab();

    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.99');
    const out = run(shell, 'show conn');

    expect(out).toContain('1 in use');
    expect(/flags \S*I/.test(out)).toBe(false);
    expect(/flags \S*O/.test(out)).toBe(true);
  });

  it('`show conn count` rend le compte sans les lignes', async () => {
    const { shell, inside } = await buildLab();
    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    const out = run(shell, 'show conn count');

    expect(out).toContain('1 in use');
    expect(out).not.toContain('flags');
  });

  it('`clear conn` vide vraiment la table', async () => {
    const { shell, inside } = await buildLab();
    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    run(shell, 'clear conn');

    expect(run(shell, 'show conn')).toContain('0 in use');
  });
});

describe('show xlate — la traduction attachee au meme flux', () => {
  async function withPat() {
    const lab = await buildLab();
    run(lab.shell, 'configure terminal',
      'object network LAN', 'subnet 192.168.1.0 255.255.255.0',
      'nat (inside,outside) dynamic interface', 'end');
    return lab;
  }

  it('sans NAT, aucune traduction', async () => {
    const { shell, inside } = await buildLab();
    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    expect(run(shell, 'show xlate')).toContain('0 in use');
  });

  it('un flux traduit apparait', async () => {
    const { shell, inside } = await withPat();

    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    expect(run(shell, 'show xlate')).toContain('1 in use');
  });

  it('elle nomme les deux interfaces et les deux adresses', async () => {
    const { shell, inside } = await withPat();
    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    const out = run(shell, 'show xlate');

    expect(out).toContain('inside:192.168.1.10');
    expect(out).toContain('outside:203.0.113.1');
  });

  it('la traduction annoncee est celle que le flux a REELLEMENT subie', async () => {
    const { fw, shell, inside } = await withPat();
    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    const session = fw.getSessionTable().view().all()[0];
    const out = run(shell, 'show xlate');

    expect(out).toContain(session.translation!.translatedSource);
  });

  it('les deux vues comptent le MEME flux', async () => {
    const { shell, inside } = await withPat();
    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    expect(run(shell, 'show conn')).toContain('1 in use');
    expect(run(shell, 'show xlate')).toContain('1 in use');
  });

  it('`clear xlate` retire les traductions', async () => {
    const { shell, inside } = await withPat();
    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    run(shell, 'clear xlate');

    expect(run(shell, 'show xlate')).toContain('0 in use');
  });
});
