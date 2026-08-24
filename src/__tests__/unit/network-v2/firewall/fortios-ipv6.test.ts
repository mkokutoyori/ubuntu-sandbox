/**
 * Le pare-feu parle IPv6 pour lui-meme.
 *
 * L'entree `[execute] ping6 absente, faute d'emetteur ICMPv6 sur le
 * pare-feu` de `TODO.md`. Le report est juste sur la cause et trop
 * etroit sur l'etendue : la mesure trouve qu'IPv6 manque en ENTIER —
 * pas d'adresse, pas de NDP, pas de table de routage v6, pas d'ICMPv6.
 *
 * Ecrite A L'AVEUGLE contre ce que fait un vrai FortiGate :
 *
 *   1. `config system interface / config ipv6 / set ip6-address` est
 *      acceptee et la configuration la rend.
 *   2. `set ip6-allowaccess ping` est acceptee et rendue.
 *   3. `diagnose ipv6 address list` nomme l'adresse posee.
 *   4. `execute ping6` vers un voisin REPOND — un vrai paquet traverse
 *      le cable, la resolution NDP comprise.
 *   5. Le texte est celui de FortiOS, le meme que `execute ping` :
 *      `PING …: 56 data bytes` puis `64 bytes from …: icmp_seq=N …`.
 *      MESURE, ecrite ici plutot que masquee : le PREMIER echo reste
 *      sans reponse, le voisin devant d'abord resoudre notre adresse de
 *      couche 2 en sens inverse. C'est ce que fait une vraie machine —
 *      le premier paquet d'un ping se perd pendant la resolution ARP ou
 *      ND — donc la sonde mesure le FORMAT et l'arrivee des reponses,
 *      pas une perte nulle.
 *   6. `execute ping6` vers une adresse sans route rend le refus de
 *      FortiOS et non une exception.
 *   7. Le voisin appris parait dans `diagnose ipv6 neighbor-cache list`.
 *   8. `config router static6` pose une route, `get router info6
 *      routing-table` la rend.
 *   9. Un paquet IPv6 EN TRANSIT est refuse — le moteur de politiques
 *      est v4 seulement, donc le refus implicite s'applique.
 *  10. TEMOIN : le meme laboratoire en IPv4 relaie, lui, sous une
 *      politique permissive — sans quoi « le v6 ne passe pas » ne
 *      distinguerait pas un verrou d'un laboratoire mal monte.
 *  11. `set ip6-allowaccess` sans `ping` fait taire la reponse a l'echo.
 *  12. TEMOIN : une machine neuve n'a aucune adresse v6.
 *
 * Discrimine par `git stash push -- src/network/` : 9 cas tombent avant
 * correctif. Les 3 qui passent des DEUX cotes sont nommes ici plutot que
 * laisses a decouvrir :
 *
 *   — les deux TEMOINS, dont c'est l'objet : « une machine neuve n'a
 *     aucune adresse v6 » et « le meme laboratoire relaie en IPv4 ».
 *   — « sans `ping` dans `ip6-allowaccess`, l'echo reste sans reponse » :
 *     avant correctif le pare-feu ne repondait a AUCUN echo v6, faute
 *     d'ICMPv6 ; le silence y est indiscernable d'un verrou. Ce cas ne
 *     vaut qu'accompagne du cas 4, qui prouve que la reponse existe.
 */

import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function runOn(device: Cmd, ...commands: string[]): Promise<string> {
  let last = '';
  for (const command of commands) last = await device.executeCommand(command);
  return last;
}

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell();
  const poste = new LinuxPC('linux-pc', 'PC', 200, 0);
  poste.powerOn();
  new Cable('c1').connect(fw.getPort('port1')!, poste.getPorts()[0]);

  await runOn(poste,
    'ip link set eth0 up',
    'ip addr add 2001:db8::10/64 dev eth0',
    'ip addr add 192.168.1.10/24 dev eth0');

  return { fw, sh, poste };
}

function poserAdresse(sh: FortiShell, acces = 'ping'): string {
  return run(sh,
    'config system interface', 'edit "port1"',
    'config ipv6',
    'set ip6-address 2001:db8::1/64',
    `set ip6-allowaccess ${acces}`,
    'end', 'next', 'end');
}

describe('le pare-feu porte une adresse IPv6', () => {
  it('`config ipv6` / `set ip6-address` est acceptee et rendue', async () => {
    const { sh } = await laboratoire();

    expect(poserAdresse(sh)).not.toMatch(/Command fail|parse error/);
    expect(run(sh, 'show system interface port1'))
      .toContain('set ip6-address 2001:db8::1/64');
  });

  it('`set ip6-allowaccess` est acceptee et rendue', async () => {
    const { sh } = await laboratoire();
    poserAdresse(sh, 'ping https');

    expect(run(sh, 'show system interface port1'))
      .toContain('set ip6-allowaccess ping https');
  });

  it('`diagnose ipv6 address list` nomme l adresse posee', async () => {
    const { sh } = await laboratoire();
    poserAdresse(sh);

    const vu = run(sh, 'diagnose ipv6 address list');

    expect(vu).toContain('2001:db8::1');
    expect(vu).toContain('port1');
  });

  it('TEMOIN : une machine neuve n a aucune adresse v6', async () => {
    const { sh } = await laboratoire();

    expect(run(sh, 'diagnose ipv6 address list')).not.toContain('2001:db8');
  });
});

describe('`execute ping6` emet un vrai paquet', () => {
  it('un voisin repond', async () => {
    const { sh } = await laboratoire();
    poserAdresse(sh);

    const vu = run(sh, 'execute ping6 2001:db8::10');

    expect(vu).toMatch(/64 bytes from 2001:db8::10:/);
    expect(vu).not.toMatch(/100% packet loss/);
  });

  it('le texte est celui de FortiOS', async () => {
    const { sh } = await laboratoire();
    poserAdresse(sh);

    const vu = run(sh, 'execute ping6 2001:db8::10');

    expect(vu).toContain('PING 2001:db8::10 (2001:db8::10): 56 data bytes');
    expect(vu).toMatch(/64 bytes from 2001:db8::10: icmp_seq=\d+ ttl=\d+ time=/);
    expect(vu).toContain('--- 2001:db8::10 ping statistics ---');
    expect(vu).toMatch(/5 packets transmitted, \d packets received/);
  });

  it('une adresse sans route rend le refus de FortiOS', async () => {
    const { sh } = await laboratoire();
    poserAdresse(sh);

    const vu = run(sh, 'execute ping6 2001:db9::99');

    expect(vu).toContain('Unable to send the ICMP packet');
  });

  it('le voisin appris parait dans le cache de voisins', async () => {
    const { sh } = await laboratoire();
    poserAdresse(sh);
    run(sh, 'execute ping6 2001:db8::10');

    expect(run(sh, 'diagnose ipv6 neighbor-cache list')).toContain('2001:db8::10');
  });

  it('sans `ping` dans `ip6-allowaccess`, l echo reste sans reponse', async () => {
    const { sh, poste } = await laboratoire();
    poserAdresse(sh, 'https');

    const vu = await runOn(poste, 'ping6 -c 2 2001:db8::1');

    expect(vu).toMatch(/100% packet loss/);
  });
});

describe('routes IPv6 et transit', () => {
  it('`config router static6` pose une route rendue par `get router info6`',
    async () => {
      const { sh } = await laboratoire();
      poserAdresse(sh);

      run(sh, 'config router static6', 'edit 1', 'set dst ::/0',
        'set gateway 2001:db8::10', 'set device "port1"', 'next', 'end');

      expect(run(sh, 'get router info6 routing-table')).toContain('2001:db8::10');
    });

  it('un paquet IPv6 EN TRANSIT est refuse', async () => {
    const { fw, sh, poste } = await laboratoire();
    poserAdresse(sh);
    run(sh, 'config system interface', 'edit "port2"',
      'config ipv6', 'set ip6-address 2001:db8:2::1/64', 'end', 'next', 'end');
    run(sh, 'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
      'set action accept', 'set schedule "always"', 'next', 'end');
    await runOn(poste, 'ip route add default via 2001:db8::1');

    const avant = fw.getIpv6Counters().outForwarded;
    await runOn(poste, 'ping6 -c 2 2001:db8:2::99');

    expect(fw.getIpv6Counters().outForwarded).toBe(avant);
  });

  it('TEMOIN : le meme laboratoire relaie en IPv4', async () => {
    const { sh, poste } = await laboratoire();
    run(sh, 'config system interface', 'edit "port1"', 'set mode static',
      'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next',
      'edit "port2"', 'set mode static', 'set ip 192.168.2.1 255.255.255.0',
      'set allowaccess ping', 'next', 'end');
    run(sh, 'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
      'set action accept', 'set schedule "always"', 'next', 'end');
    await runOn(poste, 'ip route add default via 192.168.1.1');

    const vu = await runOn(poste, 'ping -c 2 192.168.1.1');

    expect(vu).toMatch(/, 0% packet loss/);
  });
});
