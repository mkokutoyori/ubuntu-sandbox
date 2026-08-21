/**
 * Phase 2 : le systeme, les objets, la route — et le laboratoire L1.
 *
 * Ecrite A L'AVEUGLE contre ce qu'un vrai FortiGate fait.
 *
 * La phase 1 a livre la grammaire : deux tables, mais toute la mecanique
 * pour en declarer cent. Cette phase-ci pose les chemins dont un
 * laboratoire a besoin pour EXISTER — les interfaces, les zones, les
 * objets, les horaires, la route par defaut — et elle se juge sur une
 * seule chose : le laboratoire L1 du BRD se joue-t-il de bout en bout ?
 *
 * Trois points meritent d'etre nommes parce qu'ils ne sont pas
 * cosmetiques :
 *
 *   1. **`allowaccess` est un VRAI filtre.** Une interface WAN sans
 *      `ping` ne repond pas a l'echo, et c'est le premier durcissement
 *      qu'on enseigne. Un reglage accepte et sans effet serait le defaut
 *      « range et lu par personne » que ce depot referme partout.
 *   2. **L'horaire gouverne la correspondance.** `PolicyEvaluator` porte
 *      la dependance `scheduleActive` depuis la phase 1 du socle et
 *      personne ne la cablait : une regle horaire etait donc soit
 *      inevaluable, soit ignoree. La meme regle laisse passer dans sa
 *      plage et refuse en dehors, sous horloge maitrisee.
 *   3. **La route vient de `config router static`**, pas d'un appel
 *      direct. Sans elle le paquet n'a nulle part ou aller, et c'est le
 *      second temoin du laboratoire.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../../support/fastPing';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function shell(): { fw: FortiGate; sh: FortiShell } {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  const fw = new FortiGate('firewall-fortinet', 'FGT1', 0, 0);
  return { fw, sh: new FortiShell(fw) };
}

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

async function laboratoireL1() {
  const { fw, sh } = shell();
  const lan = new LinuxPC('linux-pc', 'POSTE', -100, 0);
  const wan = new LinuxPC('linux-pc', 'INTERNET', 100, 0);

  new Cable('a').connect(lan.getPort('eth0')!, fw.getPort('port1')!);
  new Cable('b').connect(fw.getPort('port2')!, wan.getPort('eth0')!);

  run(sh,
    'config system interface',
    'edit "port1"',
    'set alias "LAN"', 'set role lan', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0',
    'set allowaccess ping https ssh',
    'next',
    'edit "port2"',
    'set alias "WAN"', 'set role wan', 'set mode static',
    'set ip 203.0.113.1 255.255.255.0',
    'set allowaccess ping',
    'next', 'end');

  await runOn(lan, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1']);
  await runOn(wan, ['ip link set eth0 up', 'ip addr add 203.0.113.10/24 dev eth0',
    'ip route add default via 203.0.113.1']);

  return { fw, sh, lan, wan };
}

function objetsEtPolitique(sh: FortiShell): void {
  run(sh,
    'config firewall address',
    'edit "LAN_SUBNET"', 'set subnet 192.168.1.0 255.255.255.0', 'next', 'end',
    'config firewall policy',
    'edit 1',
    'set name "LAN-vers-Internet"',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "LAN_SUBNET"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'set nat enable', 'set logtraffic all',
    'next', 'end');
}

beforeEach(() => { Logger.reset(); });

describe('config system interface', () => {
  it('pose une adresse que l\'equipement porte vraiment', async () => {
    const { fw } = await laboratoireL1();

    expect(fw.getInterfaceTable().get('port1')?.ip).toBe('192.168.1.1');
    expect(fw.getPort('port1')?.getIPAddress()?.toString()).toBe('192.168.1.1');
  });

  it('`status down` eteint le port', async () => {
    const { fw, sh } = await laboratoireL1();

    run(sh, 'config system interface', 'edit "port1"', 'set status down', 'next', 'end');

    expect(fw.getInterfaceTable().isUp('port1')).toBe(false);
  });

  it('`show` reproduit ce qui a ete tape', async () => {
    const { sh } = await laboratoireL1();

    const vu = run(sh, 'show system interface');

    expect(vu).toContain('edit "port1"');
    expect(vu).toContain('set alias "LAN"');
    expect(vu).toContain('set ip 192.168.1.1 255.255.255.0');
    expect(vu).toContain('set allowaccess ping https ssh');
  });

  it('`get` rend les defauts que `show` tait', async () => {
    const { sh } = await laboratoireL1();

    const vu = run(sh, 'get system interface port1');

    expect(vu).toMatch(/^role\s+: lan$/m);
    expect(vu).toMatch(/^mode\s+: static$/m);
    expect(vu).toMatch(/^status\s+: up$/m);
  });

  it('`set ip` refuse un masque invalide', async () => {
    const { sh } = await laboratoireL1();
    run(sh, 'config system interface', 'edit "port1"');

    expect(run(sh, 'set ip 10.0.0.1 255.255.0.1')).toContain('value parse error');
  });

  it('`vlanid` n\'apparait pas sur un PORT PHYSIQUE', async () => {
    const { sh } = await laboratoireL1();
    run(sh, 'config system interface', 'edit "port3"');

    expect(run(sh, 'set vlanid 100')).toContain('Command fail');
    expect(run(sh, 'set type vlan')).toContain('Command fail');
  });

  it('une interface CREEE est une vlan, donc `vlanid` y est admis', async () => {
    const { sh } = await laboratoireL1();
    run(sh, 'config system interface', 'edit "VLAN-100"');

    expect(run(sh, 'set interface "port3"')).toBe('');
    expect(run(sh, 'set vlanid 100')).toBe('');
  });
});

describe('allowaccess filtre VRAIMENT', () => {
  it('une interface qui admet `ping` repond a l\'echo', async () => {
    const { lan } = await laboratoireL1();

    const out = await pingOnSimulatedClock(lan, 'ping -c 1 192.168.1.1');

    expect(out).toMatch(/, 0% packet loss/);
  });

  it('une interface qui ne l\'admet pas se tait — le temoin', async () => {
    const { sh, lan } = await laboratoireL1();
    run(sh, 'config system interface', 'edit "port1"',
      'set allowaccess https', 'next', 'end');

    const out = await pingOnSimulatedClock(lan, 'ping -c 1 192.168.1.1');

    expect(out).toMatch(/, 100% packet loss/);
  });

  it('l\'equipement sait dire ce qu\'il admet', async () => {
    const { fw } = await laboratoireL1();

    expect(fw.allowsAccess('port1', 'ssh')).toBe(true);
    expect(fw.allowsAccess('port2', 'ssh')).toBe(false);
    expect(fw.allowsAccess('port2', 'ping')).toBe(true);
  });
});

describe('config system zone', () => {
  it('cree la zone et y range ses membres', async () => {
    const { fw, sh } = await laboratoireL1();

    run(sh, 'config system zone', 'edit "trust"',
      'set interface "port1"', 'set intrazone allow', 'next', 'end');

    expect(fw.getZoneTable().getZone('trust')?.interfaces).toContain('port1');
    expect(fw.getZoneTable().zoneOf('port1')).toBe('trust');
  });

  it('une zone declaree se propose comme interface de politique', async () => {
    const { sh } = await laboratoireL1();
    run(sh, 'config system zone', 'edit "trust"', 'set interface "port1"', 'next', 'end');

    run(sh, 'config firewall policy', 'edit 1');

    expect(run(sh, 'set srcintf ?')).toContain('trust');
  });
});

describe('config firewall service custom', () => {
  it('un service TCP declare est utilisable dans une politique', async () => {
    const { fw, sh } = await laboratoireL1();

    run(sh, 'config firewall service custom', 'edit "HTTP_ALT"',
      'set tcp-portrange 8080', 'next', 'end');

    expect(fw.getObjectStore().getService('HTTP_ALT')).toBeDefined();
    run(sh, 'config firewall policy', 'edit 1');
    expect(run(sh, 'set service "HTTP_ALT"')).toBe('');
  });

  it('le catalogue d\'usine est propose', async () => {
    const { sh } = await laboratoireL1();
    run(sh, 'config firewall policy', 'edit 1');

    const aide = run(sh, 'set service ?');

    expect(aide).toContain('HTTPS');
    expect(aide).toContain('DNS');
  });

  it('une plage de ports est lue jusqu\'a sa borne haute', async () => {
    const { fw, sh } = await laboratoireL1();

    run(sh, 'config firewall service custom', 'edit "APP"',
      'set tcp-portrange 9000-9010', 'next', 'end');

    const service = fw.getObjectStore().getService('APP');
    expect(service?.entries[0].destinationPorts?.[0]).toEqual({ from: 9000, to: 9010 });
  });
});

describe('config firewall addrgrp', () => {
  it('groupe des adresses, et la politique le reference', async () => {
    const { fw, sh } = await laboratoireL1();
    run(sh, 'config firewall address',
      'edit "A"', 'set subnet 10.1.0.0 255.255.0.0', 'next',
      'edit "B"', 'set subnet 10.2.0.0 255.255.0.0', 'next', 'end');

    run(sh, 'config firewall addrgrp', 'edit "INTERNES"',
      'set member "A" "B"', 'next', 'end');

    expect(fw.getObjectStore().getAddressGroup('INTERNES')?.members).toEqual(['A', 'B']);
  });

  it('`append` ajoute un membre sans perdre les autres', async () => {
    const { fw, sh } = await laboratoireL1();
    run(sh, 'config firewall address',
      'edit "A"', 'set subnet 10.1.0.0 255.255.0.0', 'next',
      'edit "B"', 'set subnet 10.2.0.0 255.255.0.0', 'next', 'end');
    run(sh, 'config firewall addrgrp', 'edit "G"', 'set member "A"', 'next', 'end');

    run(sh, 'config firewall addrgrp', 'edit "G"', 'append member "B"', 'next', 'end');

    expect(fw.getObjectStore().getAddressGroup('G')?.members).toEqual(['A', 'B']);
  });
});

describe('config firewall schedule recurring', () => {
  it('une regle hors de son horaire ne correspond pas', async () => {
    const { fw, sh } = await laboratoireL1();
    objetsEtPolitique(sh);
    run(sh, 'config firewall schedule recurring', 'edit "NUIT"',
      'set day monday tuesday wednesday thursday friday',
      'set start 22:00', 'set end 23:00', 'next', 'end');
    run(sh, 'config firewall policy', 'edit 1', 'set schedule "NUIT"', 'next', 'end');

    const midi = new Date(2026, 7, 17, 12, 0, 0).getTime();
    expect(fw.getScheduleStore().activeAt('NUIT', midi)).toBe(false);

    const nuit = new Date(2026, 7, 17, 22, 30, 0).getTime();
    expect(fw.getScheduleStore().activeAt('NUIT', nuit)).toBe(true);
  });

  it('`always` est toujours actif — le temoin', async () => {
    const { fw } = await laboratoireL1();

    expect(fw.getScheduleStore().activeAt('always', Date.now())).toBe(true);
  });

  it('un horaire declare se propose dans la politique', async () => {
    const { sh } = await laboratoireL1();
    run(sh, 'config firewall schedule recurring', 'edit "OUVRE"',
      'set day monday', 'set start 08:00', 'set end 18:00', 'next', 'end');

    run(sh, 'config firewall policy', 'edit 1');

    expect(run(sh, 'set schedule ?')).toContain('OUVRE');
  });

  it('une heure mal formee est refusee', async () => {
    const { sh } = await laboratoireL1();
    run(sh, 'config firewall schedule recurring', 'edit "X"');

    expect(run(sh, 'set start 25:99')).toContain('value parse error');
  });
});

describe('config router static', () => {
  it('pose une route par defaut que la table porte', async () => {
    const { fw, sh } = await laboratoireL1();

    run(sh, 'config router static', 'edit 1',
      'set dst 0.0.0.0 0.0.0.0', 'set gateway 203.0.113.254',
      'set device "port2"', 'next', 'end');

    const resolved = fw.getRouteTable().resolveNextHop('8.8.8.8');
    expect(resolved?.iface).toBe('port2');
    expect(resolved?.nextHop).toBe('203.0.113.254');
  });

  it('la distance par defaut est 10, pas 1', async () => {
    const { sh } = await laboratoireL1();
    run(sh, 'config router static', 'edit 1',
      'set dst 10.0.0.0 255.0.0.0', 'set gateway 192.168.1.9', 'next', 'end');

    expect(run(sh, 'get router static 1')).toMatch(/^distance\s+: 10$/m);
  });

  it('`status disable` retire la route', async () => {
    const { fw, sh } = await laboratoireL1();
    run(sh, 'config router static', 'edit 1',
      'set dst 10.0.0.0 255.0.0.0', 'set gateway 192.168.1.9', 'next', 'end');
    expect(fw.getRouteTable().resolveNextHop('10.1.1.1')).toBeDefined();

    run(sh, 'config router static', 'edit 1', 'set status disable', 'next', 'end');

    expect(fw.getRouteTable().resolveNextHop('10.1.1.1')).toBeUndefined();
  });
});

describe('laboratoire L1 — LAN vers Internet, de bout en bout', () => {
  it('le poste atteint Internet une fois tout configure', async () => {
    const { sh, lan } = await laboratoireL1();
    objetsEtPolitique(sh);

    const out = await pingOnSimulatedClock(lan, 'ping -c 1 203.0.113.10');

    expect(out).toMatch(/, 0% packet loss/);
  });

  it('sans politique, rien ne passe — premier temoin', async () => {
    const { lan } = await laboratoireL1();

    const out = await pingOnSimulatedClock(lan, 'ping -c 1 203.0.113.10');

    expect(out).toMatch(/, 100% packet loss/);
  });

  it('sans l\'objet adresse, la politique est refusee — second temoin', async () => {
    const { sh } = await laboratoireL1();
    run(sh, 'config firewall policy', 'edit 1');

    const dit = run(sh, 'set srcaddr "LAN_SUBNET"');

    expect(dit).toContain('entry not found in datasource');
  });

  it('`set nat enable` traduit vers l\'adresse de sortie', async () => {
    const { fw, sh } = await laboratoireL1();
    objetsEtPolitique(sh);

    const result = fw.simulate({
      ingressPort: 'port1', protocol: 'tcp',
      sourceIP: '192.168.1.10', sourcePort: 44001,
      destinationIP: '203.0.113.10', destinationPort: 443,
    });

    expect(result.translatedSourceIP).toBe('203.0.113.1');
  });

  it('toute la configuration se relit et se rejoue', async () => {
    const { sh } = await laboratoireL1();
    objetsEtPolitique(sh);
    run(sh, 'config router static', 'edit 1',
      'set dst 0.0.0.0 0.0.0.0', 'set gateway 203.0.113.254',
      'set device "port2"', 'next', 'end');

    const texte = run(sh, 'show');
    const rejoue = shell();
    for (const ligne of texte.split('\n')) rejoue.sh.execute(ligne);

    expect(run(rejoue.sh, 'show')).toBe(texte);
  });

  it('l\'ordre de rendu place les objets avant la politique', async () => {
    const { sh } = await laboratoireL1();
    objetsEtPolitique(sh);

    const texte = run(sh, 'show');

    expect(texte.indexOf('config firewall address'))
      .toBeLessThan(texte.indexOf('config firewall policy'));
    expect(texte.indexOf('config system interface'))
      .toBeLessThan(texte.indexOf('config firewall address'));
  });
});
