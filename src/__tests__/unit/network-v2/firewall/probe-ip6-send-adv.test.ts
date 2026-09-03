/**
 * `ip6-send-adv`, `ip6-manage-flag` et `ip6-other-flag` gouvernent vraiment
 * l'annonce de routeur d'un FortiGate.
 *
 * Les trois etaient declares par le schema, rendus par `show`, et lus par
 * PERSONNE : le commit de l'interface ne consultait qu'`ip6-address` et
 * `ip6-allowaccess`. La consequence n'etait pas l'inertie mais son
 * contraire, dans la polarite la plus couteuse — le defaut d'`ip6-send-adv`
 * est `disable`, et le pare-feu annoncait quand meme : un poste cable a un
 * FortiGate qu'on n'a PAS regle en routeur annonceur recevait un prefixe,
 * s'autoconfigurait et posait une route par defaut vers lui. La cause est
 * dans le moteur partage : `handleRouterSolicitation` repond des qu'une
 * interface porte un prefixe, ce qui est juste pour un routeur (un IOS
 * annonce des qu'`ipv6 unicast-routing` est actif) et faux pour un
 * pare-feu, ou l'annonce est une fonction que l'on active. Le contexte
 * porte desormais `advertisesWithoutConfig`, que seul le pare-feu met a
 * `false`, de sorte que le routeur ne change pas de comportement.
 *
 * Trouve et corrige en chemin, deux defauts du moteur partage plutot que
 * du pare-feu. (1) `sendRouterAdvertisement` faisait `config.prefixes ||
 * []` puis POUSSAIT dedans les prefixes deduits de l'interface : une
 * configuration d'annonce declaree sans prefixe se retrouvait donc a en
 * porter un pour toujours, et une adresse changee ensuite laissait
 * l'ancien annonce. (2) Le drapeau O marquait l'interface comme « deja
 * interrogee » AVANT d'essayer et ne la demarquait que sur exception : un
 * hote demarre avant son serveur ne redemandait donc jamais, la ou le
 * drapeau M, dont la garde est « ai-je deja un bail », se rattrape tout
 * seul a l'annonce suivante.
 *
 * Discrimine par `git stash push` sur les fichiers du correctif : 7 cas
 * tombent. Les 4 autres sont nommes ici plutot que laisses a decouvrir.
 * Les deux cas `ip6-send-adv enable` passaient AVANT — c'est justement le
 * defaut, le pare-feu annoncant quoi qu'on ait ecrit ; ils gardent
 * desormais que la commande ne s'est pas mise a se taire. « la
 * configuration reproduit ce qui a ete tape » etait juste depuis
 * toujours, et c'est ce qui rendait le decor credible. Et « sans drapeau,
 * l'autoconfiguration seule n'appelle aucun serveur » passait parce
 * qu'aucun drapeau n'etait jamais pose ; il ne garde que l'apres.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(c: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

async function serveurDhcp6(fgt: FortiGate, avecPlage: boolean): Promise<void> {
  await taper(fgt, [
    'config system dhcp6 server', 'edit 1',
    'set interface "port2"',
    'set subnet 2001:db8:1:1::/64',
    'set dns-service specify',
    'set dns-server1 2001:db8:1:1::53',
    'set domain "lab.local"',
    ...(avecPlage ? [
      'config ip-range', 'edit 1',
      'set start-ip 2001:db8:1:1::1000',
      'set end-ip 2001:db8:1:1::1fff', 'next', 'end',
    ] : []),
    'set status enable', 'next', 'end',
  ]);
}

async function laboratoire(reglages: readonly string[], serveur?: 'plage' | 'sans') {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC-LAN', -200, 0);
  new Cable('lan').connect(pc.getPort('eth0')!, fgt.getPort('port2')!);

  if (serveur) await serveurDhcp6(fgt, serveur === 'plage');

  await taper(fgt, [
    'config system interface', 'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping',
    'config ipv6', 'set ip6-address 2001:db8:1:1::1/64',
    'set ip6-allowaccess ping', ...reglages, 'end', 'next', 'end',
  ]);
  await taper(pc, ['ip link set eth0 up']);
  return { fgt, pc };
}

describe('ip6-send-adv gouverne l\'annonce', () => {
  it('sans la commande, le pare-feu n\'annonce RIEN', async () => {
    const { pc } = await laboratoire([]);

    expect(await pc.executeCommand('ip -6 addr show eth0'))
      .not.toContain('2001:db8:1:1:0:ff:fe00:b/64');
  });

  it('sans la commande, aucune route par defaut n\'est apprise', async () => {
    const { pc } = await laboratoire([]);

    expect(await pc.executeCommand('ip -6 route show')).not.toContain('default via');
  });

  it('`ip6-send-adv enable` autoconfigure le poste', async () => {
    const { pc } = await laboratoire(['set ip6-send-adv enable']);

    expect(await pc.executeCommand('ip -6 addr show eth0'))
      .toContain('2001:db8:1:1:0:ff:fe00:b/64');
  });

  it('`ip6-send-adv enable` pose la route par defaut vers le pare-feu', async () => {
    const { pc } = await laboratoire(['set ip6-send-adv enable']);

    expect(await pc.executeCommand('ip -6 route show')).toContain('default via fe80::');
  });

  it('`ip6-send-adv disable` explicite se tait aussi', async () => {
    const { pc } = await laboratoire(['set ip6-send-adv disable']);

    expect(await pc.executeCommand('ip -6 addr show eth0'))
      .not.toContain('2001:db8:1:1:0:ff:fe00:b/64');
  });

  it('TEMOIN : la configuration reproduit ce qui a ete tape', async () => {
    const { fgt } = await laboratoire(['set ip6-send-adv enable',
      'set ip6-manage-flag enable', 'set ip6-other-flag enable']);

    const conf = await fgt.executeCommand('show system interface port2');
    expect(conf).toContain('set ip6-send-adv enable');
    expect(conf).toContain('set ip6-manage-flag enable');
    expect(conf).toContain('set ip6-other-flag enable');
  });
});

describe('les drapeaux M et O sont poses sur le fil', () => {
  it('`ip6-manage-flag enable` fait prendre un bail DHCPv6 au poste', async () => {
    const { fgt, pc } = await laboratoire(
      ['set ip6-send-adv enable', 'set ip6-manage-flag enable'], 'plage');

    expect(await pc.executeCommand('ip -6 addr show eth0'))
      .toContain('2001:db8:1:1::1000/64');
    expect(await fgt.executeCommand('execute dhcp6 lease-list'))
      .toContain('2001:db8:1:1::1000');
  });

  it('`ip6-other-flag enable` seul enseigne le resolveur SANS bail', async () => {
    const { fgt, pc } = await laboratoire(
      ['set ip6-send-adv enable', 'set ip6-other-flag enable'], 'sans');

    const resolv = await pc.executeCommand('cat /etc/resolv.conf');
    expect(resolv).toContain('nameserver 2001:db8:1:1::53');
    expect(resolv).toContain('search lab.local');
    expect(await fgt.executeCommand('execute dhcp6 lease-list')).toBe('');
  });

  it('TEMOIN : sans drapeau, l\'autoconfiguration seule n\'appelle aucun serveur',
    async () => {
      const { fgt, pc } = await laboratoire(['set ip6-send-adv enable'], 'plage');

      expect(await pc.executeCommand('ip -6 addr show eth0'))
        .toContain('2001:db8:1:1:0:ff:fe00:b/64');
      expect(await fgt.executeCommand('execute dhcp6 lease-list')).toBe('');
    });

  it('le drapeau O redemande quand le serveur arrive APRES le poste', async () => {
    const { fgt, pc } = await laboratoire(
      ['set ip6-send-adv enable', 'set ip6-other-flag enable']);

    expect(await pc.executeCommand('cat /etc/resolv.conf')).toBe('');
    await serveurDhcp6(fgt, false);
    await taper(pc, ['ip link set eth0 down', 'ip link set eth0 up']);

    expect(await pc.executeCommand('cat /etc/resolv.conf'))
      .toContain('nameserver 2001:db8:1:1::53');
  });
});

describe('l\'annonce ne s\'accumule pas', () => {
  it('les prefixes declares restent vides apres plusieurs annonces', async () => {
    const { fgt, pc } = await laboratoire(['set ip6-send-adv enable']);
    await taper(pc, ['ip link set eth0 down', 'ip link set eth0 up']);

    expect(fgt.getIpv6().dataPlane().getRaParams('port2')?.prefixes).toHaveLength(0);
  });
});
