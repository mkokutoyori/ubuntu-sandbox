/**
 * Les etapes du tutoriel qui ne se faisaient PAS en CLI, verifiees une fois
 * reecrites.
 *
 * Le tutoriel demandait par endroits un navigateur ou l'hyperviseur : se
 * connecter au portail captif (TP 16 etape 5), verifier l'acces
 * d'administration (TP 1), provoquer la panne d'un cluster (TP 21 etape 8).
 * Chacune a desormais sa forme en ligne de commande, et ce fichier verifie
 * que la forme ecrite dans le tutoriel FONCTIONNE.
 *
 * Deux choses ont ete apprises en l'ecrivant, et le tutoriel dit maintenant
 * les deux :
 *
 *   1. **`set status down` sur une interface surveillee ne fait PAS
 *      basculer un cluster.** Le statut administratif fait partie de la
 *      configuration, et la configuration est synchronisee : les DEUX
 *      membres perdent la meme interface, le critere ne departage plus
 *      rien. Une panne d'interface surveillee est un evenement PHYSIQUE —
 *      un cable arrache, lui, fait bien basculer, et le cas voisin le
 *      mesure. Le premier jet du tutoriel recommandait cette commande ;
 *      c'est la mesure qui l'a corrige, pas l'inverse.
 *   2. **`diagnose sys ha reset-uptime` n'a d'effet que si la grappe tourne
 *      depuis un moment**, la duree de fonctionnement se comparant par
 *      tranches de cinq minutes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

function propre(sorties: string[]): void {
  for (const s of sorties) {
    expect(s).not.toMatch(/Unknown action|command parse error|Invalid|entry not found/i);
  }
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

describe('TP 1 etape 7 — verifier l\'acces d\'administration en CLI', () => {
  it('`show system interface port1` nomme ce que le port accepte', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    await taper(fgt, [
      'config system interface', 'edit "port1"', 'set mode static',
      'set ip 192.168.100.99 255.255.255.0',
      'set allowaccess ping https ssh http', 'next', 'end',
    ]);

    const vue = await fgt.executeCommand('show system interface port1');
    expect(vue).toContain('set allowaccess');
    for (const service of ['ping', 'https', 'ssh', 'http']) {
      expect(vue).toContain(service);
    }
  });

  it('un `allowaccess` VIDE ne repond a personne', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const poste = new LinuxPC('linux-pc', 'PC-TRANSIT', -200, 0);
    new Cable('t').connect(poste.getPort('eth0')!, fgt.getPort('port1')!);
    await taper(fgt, [
      'config system interface', 'edit "port1"', 'set mode static',
      'set ip 192.168.100.99 255.255.255.0', 'unset allowaccess', 'next', 'end',
    ]);
    await taper(poste, [
      'ip link set eth0 up', 'ip addr add 192.168.100.10/24 dev eth0',
    ]);

    expect(await poste.executeCommand('ping -c 1 192.168.100.99'))
      .toMatch(/100% packet loss/);

    await taper(fgt, [
      'config system interface', 'edit "port1"',
      'set allowaccess ping', 'next', 'end',
    ]);
    expect(await poste.executeCommand('ping -c 1 192.168.100.99'))
      .toMatch(/, 0% packet loss/);
  });
});

describe('TP 21 etape 8 — provoquer la panne en CLI', () => {
  async function membre(nom: string, priorite: number) {
    const fw = new FortiGate('firewall-fortinet', nom, 0, 0);
    await taper(fw, [
      'config system interface',
      'edit "port1"', 'set mode static',
      'set ip 192.168.10.1 255.255.255.0', 'next',
      'edit "port2"', 'set mode static',
      'set ip 192.168.20.1 255.255.255.0', 'next',
      'edit "port5"', 'set status up', 'next',
      'edit "port6"', 'set status up', 'next', 'end',
    ]);
    await taper(fw, [
      'config system ha',
      'set group-name "CLUSTER-LAB"', 'set mode a-p',
      'set password "HALab2026!"',
      'set hbdev "port5" 50 "port6" 100',
      'set session-pickup enable',
      `set priority ${priorite}`,
      'set override disable',
      'set monitor "port1" "port2"',
      'end',
    ]);
    return fw;
  }

  async function grappe() {
    const maitre = await membre('FGT-01', 200);
    const esclave = await membre('FGT-02', 100);
    new Cable('hb1').connect(maitre.getPort('port5')!, esclave.getPort('port5')!);
    new Cable('hb2').connect(maitre.getPort('port6')!, esclave.getPort('port6')!);
    const lanMaitre = new Cable('lan-m');
    lanMaitre.connect(
      maitre.getPort('port1')!, new LinuxPC('linux-pc', 'T1', 0, 0).getPort('eth0')!);
    new Cable('dmz-m').connect(
      maitre.getPort('port2')!, new LinuxPC('linux-pc', 'T2', 0, 0).getPort('eth0')!);
    new Cable('lan-e').connect(
      esclave.getPort('port1')!, new LinuxPC('linux-pc', 'T3', 0, 0).getPort('eth0')!);
    new Cable('dmz-e').connect(
      esclave.getPort('port2')!, new LinuxPC('linux-pc', 'T4', 0, 0).getPort('eth0')!);
    for (let tour = 0; tour < 4; tour++) {
      maitre.getHa().tick(); esclave.getHa().tick();
    }
    return { maitre, esclave, lanMaitre };
  }

  it('etape 1 : `unset ip` libere une interface de battement de coeur', async () => {
    const { maitre } = await grappe();
    propre(await taper(maitre, [
      'config system interface', 'edit "port5"', 'unset ip',
      'set status up', 'next', 'end',
    ]));
    expect(await maitre.executeCommand('show system interface port5'))
      .not.toMatch(/set ip \d/);
  });

  it('`set status down` NE fait PAS basculer : le shutdown se SYNCHRONISE',
    async () => {
      const { maitre, esclave } = await grappe();
      expect(maitre.getHa().role()).toBe('master');
      expect(maitre.getHa().monitoredUp()).toBe(2);
      expect(esclave.getHa().monitoredUp()).toBe(2);

      propre(await taper(maitre, [
        'config system interface', 'edit "port1"', 'set status down',
        'next', 'end',
      ]));
      for (let tour = 0; tour < 6; tour++) {
        maitre.getHa().tick(); esclave.getHa().tick();
      }

      expect(maitre.getHa().monitoredUp()).toBe(1);
      expect(esclave.getHa().monitoredUp()).toBe(1);
      expect(maitre.getHa().role()).toBe('master');
      expect(esclave.getHa().role()).toBe('slave');
    });

  it('un cable ARRACHE, lui, fait basculer', async () => {
    const { maitre, esclave, lanMaitre } = await grappe();
    expect(maitre.getHa().role()).toBe('master');

    lanMaitre.disconnect();
    for (let tour = 0; tour < 6; tour++) {
      maitre.getHa().tick(); esclave.getHa().tick();
    }

    expect(maitre.getHa().monitoredUp()).toBe(1);
    expect(esclave.getHa().monitoredUp()).toBe(2);
    expect(esclave.getHa().role()).toBe('master');
    expect(maitre.getHa().role()).toBe('slave');
  });

  it('`diagnose sys ha reset-uptime` fait basculer sans rien debrancher',
    async () => {
      const { maitre, esclave } = await grappe();
      maitre.getHa().advanceUptime(30 * 60 * 1000);
      esclave.getHa().advanceUptime(30 * 60 * 1000);
      for (let tour = 0; tour < 3; tour++) {
        maitre.getHa().tick(); esclave.getHa().tick();
      }
      expect(maitre.getHa().role()).toBe('master');

      expect(await maitre.executeCommand('diagnose sys ha reset-uptime'))
        .not.toMatch(/Unknown action|unknown path/i);
      for (let tour = 0; tour < 6; tour++) {
        maitre.getHa().tick(); esclave.getHa().tick();
      }

      expect(esclave.getHa().role()).toBe('master');
    });

  it('`execute ha failover set` cede la main volontairement', async () => {
    const { maitre, esclave } = await grappe();
    expect(maitre.getHa().role()).toBe('master');

    expect(await maitre.executeCommand('execute ha failover set'))
      .not.toMatch(/Unknown action|unknown path/i);
    for (let tour = 0; tour < 6; tour++) {
      maitre.getHa().tick(); esclave.getHa().tick();
    }

    expect(esclave.getHa().role()).toBe('master');
  });
});

describe('TP 16 etape 5 — le portail captif se traverse en CLI', () => {
  async function laboratoire() {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const pcLan = new LinuxPC('linux-pc', 'PC-LAN', -200, 0);
    const srvDmz = new LinuxServer('linux-server', 'SRV-DMZ', 200, 0);

    new Cable('lan').connect(pcLan.getPort('eth0')!, fgt.getPort('port2')!);
    new Cable('dmz').connect(fgt.getPort('port3')!, srvDmz.getPort('eth0')!);

    await taper(fgt, [
      'config system interface',
      'edit "port2"', 'set mode static',
      'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
      'edit "port3"', 'set mode static',
      'set ip 192.168.20.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
      'config user local',
      'edit "marie.durand"', 'set type password',
      'set passwd "Direction2026!"', 'set status enable', 'next', 'end',
      'config user group',
      'edit "GRP-Direction"', 'set group-type firewall',
      'set member "marie.durand"', 'next', 'end',
      'config firewall policy',
      'edit 2', 'set name "LAN-vers-DMZ"',
      'set srcintf "port2"', 'set dstintf "port3"',
      'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
      'set action accept', 'set groups "GRP-Direction"', 'next', 'end',
    ]);
    await taper(pcLan, [
      'ip link set eth0 up', 'ip addr add 192.168.10.10/24 dev eth0',
      'ip route add default via 192.168.10.1',
    ]);
    await taper(srvDmz, [
      'ip link set eth0 up', 'ip addr add 192.168.20.10/24 dev eth0',
      'ip route add default via 192.168.20.1',
    ]);
    await srvDmz.executeCommand('systemctl start nginx');
    return { fgt, pcLan };
  }

  it('la premiere requete est REDIRIGEE, le portail authentifie, la seconde passe',
    async () => {
      const { fgt, pcLan } = await laboratoire();

      const avant = await pcLan.executeCommand('curl -sSi http://192.168.20.10/');
      expect(avant).toMatch(/30[23]|Location:/);
      expect(avant).not.toContain('Welcome to nginx!');

      const portail = await pcLan.executeCommand(
        'curl -sS -d "username=marie.durand&password=Direction2026!" '
        + 'http://192.168.10.1:1000/');
      expect(portail).toMatch(/Authentication successful/i);

      expect(await fgt.executeCommand('diagnose firewall auth list'))
        .toContain('marie.durand');

      expect(await pcLan.executeCommand('curl -sS http://192.168.20.10/'))
        .toContain('Welcome to nginx!');
    });

  it('`auth-secure-http enable` fait pointer la redirection vers le port 1003',
    async () => {
      const { fgt, pcLan } = await laboratoire();
      await taper(fgt, [
        'config user setting', 'set auth-secure-http enable', 'end',
      ]);

      expect(await pcLan.executeCommand('curl -sSi http://192.168.20.10/'))
        .toMatch(/Location: https:\/\/192\.168\.10\.1:1003\//);
    });
});
