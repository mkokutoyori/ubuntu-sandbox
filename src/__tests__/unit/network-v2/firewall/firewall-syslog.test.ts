/**
 * Le pare-feu JOURNALISE ce qu'il decide — BRD-Firewall phase 4.
 *
 * Audit de non-duplication fait AVANT d'ecrire une ligne, comme le veut la
 * regle de ce carnet : `LoggingConfig` existe, il est mur (severites,
 * tampon, collecteurs, horodatage, discriminateurs) et son rendu produit
 * DEJA le format d'un ASA — `%${tag}-${niveau}-${mnemonique}` donne
 * `%ASA-6-302013` sans qu'une ligne du moteur change. Ecrire un second
 * journal aurait ete le doublon que ce depot passe son temps a refermer.
 *
 * Ce qui manquait n'etait donc pas un moteur mais deux choses :
 *
 *   1. le pare-feu n'emettait RIEN — un pare-feu qui ne journalise ni les
 *      connexions ni les refus est inutilisable en exploitation, c'est le
 *      journal qu'on lit pour savoir pourquoi une application ne passe
 *      pas ;
 *   2. les numeros de message sont propres au constructeur, donc ils sont
 *      une DONNEE du profil et non du socle (BRD §26 : la couche vendeur
 *      livre des artefacts, jamais un moteur).
 *
 * Les identifiants sont ceux d'un vrai ASA, et ce sont eux qu'un operateur
 * cherche : 302013 pour une connexion TCP ouverte, 302014 pour sa
 * fermeture, 106023 pour un refus par ACL, 305011 pour une traduction
 * creee. Les inventer aurait rendu le journal illisible par quiconque
 * connait la machine.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AsaFirewall } from '@/network/devices/firewall/vendors/asa/AsaFirewall';
import { AsaShell } from '@/network/devices/firewall/vendors/asa/AsaShell';
import { Firewall } from '@/network/devices/firewall/Firewall';
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
    'ip address 203.0.113.1 255.255.255.0', 'exit',
    'logging enable', 'logging buffered debugging', 'end');

  await runOn(inside, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1']);
  await runOn(outside, ['ip link set eth0 up', 'ip addr add 203.0.113.10/24 dev eth0',
    'ip route add default via 203.0.113.1']);

  return { fw, shell, inside, outside };
}

beforeEach(() => { Logger.reset(); });

describe('le journal reutilise le moteur du depot', () => {
  it('un pare-feu porte un `LoggingConfig`, pas un journal a lui', async () => {
    const { fw } = await buildLab();

    expect(fw.getLoggingConfig()).toBeDefined();
    expect(fw).toBeInstanceOf(Firewall);
  });

  it('`logging enable` puis `show logging` rendent le texte du moteur', async () => {
    const { shell } = await buildLab();

    expect(run(shell, 'show logging')).toContain('Syslog logging: enabled');
  });

  it('`no logging enable` le coupe', async () => {
    const { shell } = await buildLab();

    run(shell, 'configure terminal', 'no logging enable', 'end');

    expect(run(shell, 'show logging')).toContain('Syslog logging: disabled');
  });

  it('la configuration rendue reproduit les lignes de journalisation', async () => {
    const { shell } = await buildLab();

    expect(run(shell, 'show running-config')).toContain('logging enable');
  });
});

describe('une connexion qui s\'ouvre est JOURNALISEE', () => {
  it('un flux traversant ecrit un message', async () => {
    const { shell, inside } = await buildLab();

    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    expect(run(shell, 'show logging')).toContain('Built');
  });

  it('le message porte l\'identifiant d\'un VRAI ASA', async () => {
    const { shell, inside } = await buildLab();

    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    expect(run(shell, 'show logging')).toMatch(/%ASA-6-30201\d/);
  });

  it('il nomme les deux interfaces et les deux adresses', async () => {
    const { shell, inside } = await buildLab();

    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');
    const out = run(shell, 'show logging');

    expect(out).toContain('inside');
    expect(out).toContain('outside');
    expect(out).toContain('192.168.1.10');
    expect(out).toContain('203.0.113.10');
  });

  it('sans trafic, aucun message de connexion — le temoin', async () => {
    const { shell } = await buildLab();

    expect(run(shell, 'show logging')).not.toContain('Built');
  });

  it('`clear logging buffer` vide le tampon', async () => {
    const { shell, inside } = await buildLab();
    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    run(shell, 'clear logging buffer');

    expect(run(shell, 'show logging')).not.toContain('Built');
  });
});

describe('un refus est JOURNALISE, et c\'est le message qu\'on cherche', () => {
  it('un paquet refuse ecrit un message de refus', async () => {
    const { shell, outside } = await buildLab();

    await pingOnSimulatedClock(outside, 'ping -c 1 192.168.1.10');

    expect(run(shell, 'show logging')).toContain('Deny');
  });

  it('il porte l\'identifiant du refus par liste d\'acces', async () => {
    const { shell, outside } = await buildLab();

    await pingOnSimulatedClock(outside, 'ping -c 1 192.168.1.10');

    expect(run(shell, 'show logging')).toMatch(/%ASA-\d-106023/);
  });

  it('il nomme la source et la destination refusees', async () => {
    const { shell, outside } = await buildLab();

    await pingOnSimulatedClock(outside, 'ping -c 1 192.168.1.10');
    const out = run(shell, 'show logging');

    expect(out).toContain('203.0.113.10');
    expect(out).toContain('192.168.1.10');
  });

  it('un refus est plus GRAVE qu\'une connexion ouverte', async () => {
    const { fw, shell, inside, outside } = await buildLab();
    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');
    await pingOnSimulatedClock(outside, 'ping -c 1 192.168.1.10');

    const out = run(shell, 'show logging');
    const refus = /%ASA-(\d)-106023/.exec(out);
    const ouverture = /%ASA-(\d)-30201\d/.exec(out);

    expect(refus).not.toBeNull();
    expect(ouverture).not.toBeNull();
    expect(Number(refus![1])).toBeLessThan(Number(ouverture![1]));
    expect(fw.getLoggingConfig().enabled).toBe(true);
  });

  it('journal coupe, rien n\'est retenu — le temoin', async () => {
    const { shell, outside } = await buildLab();
    run(shell, 'configure terminal', 'no logging enable', 'end');

    await pingOnSimulatedClock(outside, 'ping -c 1 192.168.1.10');

    expect(run(shell, 'show logging')).not.toContain('Deny');
  });
});

describe('la severite filtre pour de bon', () => {
  it('un tampon regle sur `warnings` ne retient pas une ouverture', async () => {
    const { shell, inside } = await buildLab();
    run(shell, 'configure terminal', 'logging buffered warnings', 'end');

    await pingOnSimulatedClock(inside, 'ping -c 1 203.0.113.10');

    expect(run(shell, 'show logging')).not.toContain('Built');
  });

  it('mais il retient un refus, qui est plus grave — le temoin', async () => {
    const { shell, outside } = await buildLab();
    run(shell, 'configure terminal', 'logging buffered warnings', 'end');

    await pingOnSimulatedClock(outside, 'ping -c 1 192.168.1.10');

    expect(run(shell, 'show logging')).toContain('Deny');
  });
});
