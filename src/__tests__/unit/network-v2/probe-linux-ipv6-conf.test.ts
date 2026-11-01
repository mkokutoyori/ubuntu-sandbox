/**
 * `net.ipv6.conf.{all,default,<interface>}.*` : la configuration IPv6 PAR INTERFACE d'un hote Linux. Mesure de depart : `/proc/sys/net/ipv6/conf` n'existait pas
 * (`sysctl net.ipv6.conf.all.disable_ipv6=1`, l'une des commandes les plus tapees, repondait « cannot stat »), et rien ne decidait si un hote lit les annonces de
 * routeur : `EndHost.handleRouterAdvertisement` s'autoconfigurait toujours. Sources : include/net/addrconf.h et net/ipv6/addrconf.c (valeurs de ipv6_devconf, v5.15
 * comme v6.8 : accept_ra 1, autoconf 1, accept_ra_defrtr 1, accept_ra_pinfo 1, disable_ipv6 0, forwarding 0), net/ipv6/ndisc.c ndisc_router_discovery (un RA non
 * accepte n'apprend que l'adresse de lien du routeur ; routeur par defaut = accept_ra_defrtr ; prefixes = accept_ra_pinfo ; adresse = autoconf, la route « on-link »
 * restant posee), ipv6_accept_ra (avec forwarding, seul accept_ra = 2 accepte). Portees : ecrire `default` ne touche QUE les interfaces creees ensuite (pas de copie
 * comme en IPv4) ; `all` ne touche les interfaces que pour disable_ipv6 et forwarding (addrconf_disable_change, addrconf_forward_change) : `all.accept_ra` n'est lu
 * par personne. disable_ipv6 = 1 supprime toutes les adresses et routes de l'interface et refuse d'en ajouter (« RTNETLINK answers: Permission denied »).
 * Reserve : `forwarding` est stocke et change l'acceptation des RA, mais un hote n'a pas de plan de transfert IPv6 (TODO.md).
 *
 * Discrimine par `git stash` sur src/network : 13 des 19 cas tombent avant. TEMOINS : l'hote s'autoconfigure par defaut, `all.accept_ra=0` et `default.accept_ra=0` ne changent rien
 * a une interface existante (avant : les fichiers n'existaient pas et l'hote s'autoconfigurait quand meme). Passent avant pour une mauvaise raison, et c'est dit : « forwarding=1 et
 * accept_ra=2 accepte » (le reglage echouait, l'hote acceptait toujours), « remettre disable_ipv6 a 0 recree l'adresse de lien » (elle n'avait jamais ete retiree) et « une valeur
 * refusee » (le fichier n'existait pas) ; leur contrepartie positive est dans les cas voisins.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

async function lab(before: readonly string[] = []) {
  const router = new CiscoRouter('R1');
  const host = new LinuxPC('linux-pc', 'H');
  host.powerOn();
  const machine = host as unknown as { executor: { runAsUser<T>(user: string, run: () => Promise<T>): Promise<T> } };
  const root = async (command: string): Promise<string> =>
    String(await machine.executor.runAsUser('root', () => host.executeCommand(command))).trim();
  for (const line of ['enable', 'configure terminal', 'ipv6 unicast-routing', 'interface GigabitEthernet0/0', 'ipv6 address 2001:db8::1/64', 'no shutdown', 'end']) {
    await router.executeCommand(line);
  }
  for (const command of before) await root(command);
  new Cable('c').connect(router.getPort('GigabitEthernet0/0')!, host.getPort('eth0')!);
  return { root, router, host };
}

const GLOBAL = /inet6 2001:db8::[0-9a-f:]+\/64 scope global/;

describe('the host reads router advertisements by default', () => {
  it('WITNESS — it autoconfigures an address, the prefix route and a default route', async () => {
    const { root } = await lab();
    expect(await root('ip -6 addr show eth0')).toMatch(GLOBAL);
    const routes = await root('ip -6 route show');
    expect(routes).toContain('2001:db8::/64 dev eth0');
    expect(routes).toMatch(/^default via fe80::/m);
  });

  it('the files exist with the kernel defaults, for all, default and each interface', async () => {
    const { root } = await lab();
    for (const scope of ['all', 'default', 'eth0', 'lo']) {
      expect(await root(`cat /proc/sys/net/ipv6/conf/${scope}/accept_ra`)).toBe('1');
      expect(await root(`cat /proc/sys/net/ipv6/conf/${scope}/autoconf`)).toBe('1');
      expect(await root(`cat /proc/sys/net/ipv6/conf/${scope}/disable_ipv6`)).toBe('0');
      expect(await root(`cat /proc/sys/net/ipv6/conf/${scope}/forwarding`)).toBe('0');
    }
  });

  it('sysctl reads and lists them', async () => {
    const { root } = await lab();
    expect(await root('sysctl -n net.ipv6.conf.eth0.accept_ra_defrtr')).toBe('1');
    expect(await root('sysctl -a 2>/dev/null | grep -c "^net.ipv6.conf.eth0."')).toBe('13');
  });
});

describe('accept_ra and its companions', () => {
  it('accept_ra=0 on the interface: no address, no prefix route, no default route, link-local kept', async () => {
    const { root } = await lab(['sysctl -w net.ipv6.conf.eth0.accept_ra=0']);
    expect(await root('ip -6 addr show eth0')).not.toMatch(GLOBAL);
    expect(await root('ip -6 addr show eth0')).toMatch(/inet6 fe80::[0-9a-f:]+\/64 scope link/);
    const routes = await root('ip -6 route show');
    expect(routes).not.toContain('2001:db8::/64');
    expect(routes).not.toMatch(/^default via/m);
  });

  it('with forwarding=1, accept_ra=1 ignores the advertisement', async () => {
    const { root } = await lab(['sysctl -w net.ipv6.conf.eth0.forwarding=1']);
    expect(await root('ip -6 addr show eth0')).not.toMatch(GLOBAL);
  });

  it('with forwarding=1, accept_ra=2 accepts it', async () => {
    const { root } = await lab(['sysctl -w net.ipv6.conf.eth0.forwarding=1', 'sysctl -w net.ipv6.conf.eth0.accept_ra=2']);
    expect(await root('ip -6 addr show eth0')).toMatch(GLOBAL);
  });

  it('autoconf=0: no address, but the on-link prefix route and the default route stay', async () => {
    const { root } = await lab(['sysctl -w net.ipv6.conf.eth0.autoconf=0']);
    expect(await root('ip -6 addr show eth0')).not.toMatch(GLOBAL);
    const routes = await root('ip -6 route show');
    expect(routes).toContain('2001:db8::/64 dev eth0');
    expect(routes).toMatch(/^default via fe80::/m);
  });

  it('accept_ra_pinfo=0: no address and no prefix route, the default route stays', async () => {
    const { root } = await lab(['sysctl -w net.ipv6.conf.eth0.accept_ra_pinfo=0']);
    expect(await root('ip -6 addr show eth0')).not.toMatch(GLOBAL);
    const routes = await root('ip -6 route show');
    expect(routes).not.toContain('2001:db8::/64');
    expect(routes).toMatch(/^default via fe80::/m);
  });

  it('accept_ra_defrtr=0: the address is configured, no default route', async () => {
    const { root } = await lab(['sysctl -w net.ipv6.conf.eth0.accept_ra_defrtr=0']);
    expect(await root('ip -6 addr show eth0')).toMatch(GLOBAL);
    expect(await root('ip -6 route show')).not.toMatch(/^default via/m);
  });
});

describe('scopes follow the kernel, not the IPv4 rules', () => {
  it('WITNESS — all.accept_ra is read by no interface', async () => {
    const { root } = await lab(['sysctl -w net.ipv6.conf.all.accept_ra=0']);
    expect(await root('ip -6 addr show eth0')).toMatch(GLOBAL);
  });

  it('WITNESS — default.accept_ra only concerns interfaces created later', async () => {
    const { root } = await lab(['sysctl -w net.ipv6.conf.default.accept_ra=0']);
    expect(await root('ip -6 addr show eth0')).toMatch(GLOBAL);
  });

  it('default is not copied to existing interfaces', async () => {
    const { root } = await lab(['sysctl -w net.ipv6.conf.default.autoconf=0']);
    expect(await root('cat /proc/sys/net/ipv6/conf/default/autoconf')).toBe('0');
    expect(await root('cat /proc/sys/net/ipv6/conf/eth0/autoconf')).toBe('1');
  });

  it('all.disable_ipv6 and all.forwarding reach every interface and default', async () => {
    const { root } = await lab();
    await root('sysctl -w net.ipv6.conf.all.forwarding=1');
    expect(await root('cat /proc/sys/net/ipv6/conf/eth0/forwarding')).toBe('1');
    expect(await root('cat /proc/sys/net/ipv6/conf/default/forwarding')).toBe('1');
    await root('sysctl -w net.ipv6.conf.all.disable_ipv6=1');
    expect(await root('cat /proc/sys/net/ipv6/conf/eth0/disable_ipv6')).toBe('1');
    expect(await root('cat /proc/sys/net/ipv6/conf/lo/disable_ipv6')).toBe('1');
    expect(await root('cat /proc/sys/net/ipv6/conf/default/disable_ipv6')).toBe('1');
  });

  it('writing a value the file does not accept is refused', async () => {
    const { root } = await lab();
    expect(await root('sysctl -w net.ipv6.conf.eth0.accept_ra=abc; echo rc=$?')).toContain('rc=1');
  });
});

describe('disable_ipv6', () => {
  it('removes the addresses and the routes of the interface', async () => {
    const { root } = await lab();
    await root('sysctl -w net.ipv6.conf.eth0.disable_ipv6=1');
    expect(await root('ip -6 addr show eth0')).not.toMatch(/inet6/);
    const routes = await root('ip -6 route show');
    expect(routes).not.toContain('2001:db8::/64');
    expect(routes).not.toMatch(/^default via/m);
  });

  it('refuses to add an address while it is set', async () => {
    const { root } = await lab(['sysctl -w net.ipv6.conf.eth0.disable_ipv6=1']);
    expect(await root('ip -6 addr add 2001:db8:1::5/64 dev eth0')).toBe('RTNETLINK answers: Permission denied');
    expect(await root('ip -6 addr show eth0')).not.toContain('2001:db8:1::5');
  });

  it('setting it back creates the link-local address again', async () => {
    const { root } = await lab();
    await root('sysctl -w net.ipv6.conf.eth0.disable_ipv6=1');
    await root('sysctl -w net.ipv6.conf.eth0.disable_ipv6=0');
    expect(await root('ip -6 addr show eth0')).toMatch(/inet6 fe80::[0-9a-f:]+\/64 scope link/);
  });

  it('a disabled interface does not autoconfigure from an advertisement', async () => {
    const { root } = await lab(['sysctl -w net.ipv6.conf.eth0.disable_ipv6=1']);
    expect(await root('ip -6 addr show eth0')).not.toMatch(/inet6/);
  });

  it('all.disable_ipv6=1 removes ::1 from lo, and 0 brings it back', async () => {
    const { root } = await lab();
    expect(await root('ip -6 addr show lo')).toContain('::1/128');
    await root('sysctl -w net.ipv6.conf.all.disable_ipv6=1');
    expect(await root('ip -6 addr show lo')).not.toContain('::1/128');
    await root('sysctl -w net.ipv6.conf.all.disable_ipv6=0');
    expect(await root('ip -6 addr show lo')).toContain('::1/128');
  });
});
