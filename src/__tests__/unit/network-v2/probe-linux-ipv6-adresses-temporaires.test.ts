/**
 * Durees de vie des adresses SLAAC et extensions de confidentialite (RFC 4941, `use_tempaddr`). Mesure de depart : une adresse SLAAC n'avait AUCUNE duree de vie (ni
 * valid_lft ni preferred_lft lus de l'annonce, `ip -6 addr` ecrivait « forever » partout et omettait « dynamic mngtmpaddr »), `net.ipv6.conf.*.use_tempaddr` n'existait pas, et la
 * source d'un paquet etait la premiere adresse globale venue. Sources : net/ipv6/addrconf.c v5.15 (addrconf_prefix_rcv_add_addr : adresse creee avec IFA_F_MANAGETEMPADDR,
 * lifetimes REMPLACEES a chaque annonce ; manage_tempaddrs ; ipv6_create_tempaddr : valid = min(public, temp_valid_lft + age), preferred = min(public, temp_prefered_lft + age - desync),
 * pas de creation si preferred <= regen_advance + age ; addrconf_verify : expiration, « deprecated » a preferred, regeneration a preferred - regen_advance), include/net/addrconf.h
 * (TEMP_VALID_LIFETIME 7 jours, TEMP_PREFERRED_LIFETIME 1 jour, REGEN_MAX_RETRY 3, MAX_DESYNC_FACTOR 600 ; la doc ip-sysctl.rst dit 2 jours et se trompe), iproute2 v6.1 print_ifa_flags
 * (ordre « temporary deprecated dynamic mngtmpaddr », `dynamic` = valid_lft fini) et le defaut Ubuntu `use_tempaddr = 2` de /etc/sysctl.d/10-ipv6-privacy.conf (releve sur la machine de reference ;
 * `lo` reste a -1 comme dans le noyau). L'annonce du routeur porte 30 jours (valide) et 7 jours (prefere).
 *
 * `ip -6 route get` n'existait pas pour IPv6 (« Command get is unknown ») : sa sortie suit iproute2 (`from ::`, `proto`, `src`, `metric`, `pref medium`), la route par defaut apprise
 * d'une annonce est `proto ra` et sans zone `%eth0` dans `show` comme dans `get`, le noyau l'installant ainsi.
 *
 * Discrimine par `git stash` sur src/network : 13 des 16 premiers cas tombent avant, et 8 des 9 cas de route (la commande etait inconnue ; reste vide avant : « une destination sans route »). TEMOIN : `use_tempaddr=0` ne cree rien. Passent avant pour une mauvaise raison : « une duree trop courte ne cree
 * pas d'adresse temporaire » (il n'y en avait jamais) et « supprimer l'adresse publique supprime ses temporaires » (il n'y avait pas de temporaires a supprimer). Le hasard (partie variable de l'adresse, desync_factor) vient d'un tirage deterministe par machine.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { IPv6Packet, ICMPv6Packet } from '@/network/core/types';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const DAY = 86_400;

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
  const elapse = (seconds: number): void => host.getSystemClock().step(seconds * 1000);
  return { root, host, elapse };
}

interface Row { address: string; flags: string[]; valid: string; preferred: string }

async function globals(root: (c: string) => Promise<string>): Promise<Row[]> {
  const lines = (await root('ip -6 addr show eth0')).split('\n');
  const rows: Row[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = /inet6 (\S+)\/\d+ scope global ?(.*)$/.exec(lines[i].trim());
    if (head === null) continue;
    const life = /valid_lft (\S+) preferred_lft (\S+)/.exec(lines[i + 1] ?? '');
    rows.push({ address: head[1], flags: head[2].trim().split(/\s+/).filter(Boolean), valid: life?.[1] ?? '', preferred: life?.[2] ?? '' });
  }
  return rows;
}

async function echoSource(host: LinuxPC, root: (c: string) => Promise<string>): Promise<string | null> {
  let source: string | null = null;
  host.attachCapture(({ direction, frame }) => {
    if (direction !== 'out') return;
    const ip = frame.payload as IPv6Packet | undefined;
    const icmp = ip?.payload as ICMPv6Packet | undefined;
    if (ip?.type === 'ipv6' && String(icmp?.icmpType) === 'echo-request') source = ip.sourceIP.toString();
  });
  await root('ping6 -c 1 2001:db8::1');
  return source;
}

const seconds = (text: string): number => Number(text.replace('sec', ''));
const publics = (rows: Row[]): Row[] => rows.filter((row) => !row.flags.includes('temporary'));
const temporaries = (rows: Row[]): Row[] => rows.filter((row) => row.flags.includes('temporary'));

describe('the public SLAAC address carries the advertised lifetimes', () => {
  it('is dynamic and managed, with the router\'s lifetimes', async () => {
    const { root } = await lab(['sysctl -w net.ipv6.conf.eth0.use_tempaddr=0']);
    const [pub] = publics(await globals(root));
    expect(pub.flags).toEqual(['dynamic', 'mngtmpaddr']);
    expect(seconds(pub.valid)).toBe(30 * DAY);
    expect(seconds(pub.preferred)).toBe(7 * DAY);
  });

  it('its remaining lifetimes decrease with the clock of the machine', async () => {
    const { root, elapse } = await lab(['sysctl -w net.ipv6.conf.eth0.use_tempaddr=0']);
    elapse(3600);
    const [pub] = publics(await globals(root));
    expect(seconds(pub.valid)).toBe(30 * DAY - 3600);
    expect(seconds(pub.preferred)).toBe(7 * DAY - 3600);
  });

  it('is deprecated once its preferred lifetime is over, and gone once its valid lifetime is', async () => {
    const { root, elapse } = await lab(['sysctl -w net.ipv6.conf.eth0.use_tempaddr=0']);
    elapse(7 * DAY + 10);
    const [pub] = publics(await globals(root));
    expect(pub.flags).toEqual(['deprecated', 'dynamic', 'mngtmpaddr']);
    expect(pub.preferred).toBe('0sec');
    elapse(23 * DAY);
    expect(await globals(root)).toEqual([]);
    expect(await root('ip -6 addr show eth0')).toMatch(/scope link/);
  });
});

describe('use_tempaddr', () => {
  it('WITNESS — 0 creates no temporary address', async () => {
    const { root } = await lab(['sysctl -w net.ipv6.conf.eth0.use_tempaddr=0']);
    expect(temporaries(await globals(root))).toEqual([]);
  });

  it('is 2 on interfaces by default (Ubuntu\'s 10-ipv6-privacy.conf), -1 on lo', async () => {
    const { root } = await lab();
    expect(await root('cat /proc/sys/net/ipv6/conf/eth0/use_tempaddr')).toBe('2');
    expect(await root('cat /proc/sys/net/ipv6/conf/all/use_tempaddr')).toBe('2');
    expect(await root('cat /proc/sys/net/ipv6/conf/default/use_tempaddr')).toBe('2');
    expect(await root('cat /proc/sys/net/ipv6/conf/lo/use_tempaddr')).toBe('-1');
    expect(await root('cat /etc/sysctl.d/10-ipv6-privacy.conf')).toContain('net.ipv6.conf.all.use_tempaddr = 2');
  });

  it('creates a temporary address with the temporary lifetimes', async () => {
    const { root } = await lab();
    const rows = await globals(root);
    const [temp] = temporaries(rows);
    expect(temporaries(rows)).toHaveLength(1);
    expect(temp.flags).toEqual(['temporary', 'dynamic']);
    expect(seconds(temp.valid)).toBe(7 * DAY);
    expect(seconds(temp.preferred)).toBeGreaterThan(DAY - 600);
    expect(seconds(temp.preferred)).toBeLessThanOrEqual(DAY);
    expect(temp.address.startsWith('2001:db8::')).toBe(true);
    expect(temp.address).not.toBe(publics(rows)[0].address);
  });

  it('draws the interface identifier at random, not from the MAC', async () => {
    const { root } = await lab();
    const rows = await globals(root);
    expect(temporaries(rows)[0].address).not.toMatch(/ff:fe/);
    expect(publics(rows)[0].address).toMatch(/ff:fe/);
  });

  it('1 creates a temporary address but keeps the public one as the source', async () => {
    const { root, host } = await lab(['sysctl -w net.ipv6.conf.eth0.use_tempaddr=1']);
    const rows = await globals(root);
    expect(temporaries(rows)).toHaveLength(1);
    expect(await echoSource(host, root)).toBe(publics(rows)[0].address);
  });

  it('2 prefers the temporary address as the source', async () => {
    const { root, host } = await lab();
    const rows = await globals(root);
    expect(await echoSource(host, root)).toBe(temporaries(rows)[0].address);
  });

  it('the temporary address is deprecated after its preferred lifetime and replaced by a new one', async () => {
    const { root, elapse } = await lab();
    const first = temporaries(await globals(root))[0];
    elapse(DAY + 60);
    const rows = await globals(root);
    const old = rows.find((row) => row.address === first.address)!;
    expect(old.flags).toEqual(['temporary', 'deprecated', 'dynamic']);
    expect(old.preferred).toBe('0sec');
    const fresh = temporaries(rows).filter((row) => !row.flags.includes('deprecated'));
    expect(fresh).toHaveLength(1);
    expect(fresh[0].address).not.toBe(first.address);
  });

  it('the source switches to the new temporary address, never a deprecated one', async () => {
    const { root, host, elapse } = await lab();
    const first = temporaries(await globals(root))[0];
    elapse(DAY + 60);
    const rows = await globals(root);
    const fresh = temporaries(rows).find((row) => !row.flags.includes('deprecated'))!;
    const source = await echoSource(host, root);
    expect(source).toBe(fresh.address);
    expect(source).not.toBe(first.address);
  });

  it('a temporary address never outlives temp_valid_lft: the old one disappears after 7 days, and with the public address deprecated no temporary address is preferred', async () => {
    const { root, elapse } = await lab();
    const first = temporaries(await globals(root))[0];
    elapse(7 * DAY + 60);
    const rows = await globals(root);
    expect(rows.some((row) => row.address === first.address)).toBe(false);
    expect(temporaries(rows).every((row) => row.flags.includes('deprecated'))).toBe(true);
  });

  it('temp_prefered_lft shortens the preferred lifetime of the temporary address', async () => {
    const { root } = await lab(['sysctl -w net.ipv6.conf.eth0.temp_prefered_lft=3600', 'sysctl -w net.ipv6.conf.eth0.max_desync_factor=0']);
    expect(seconds(temporaries(await globals(root))[0].preferred)).toBe(3600);
  });

  it('a preferred lifetime too short for regeneration creates no temporary address', async () => {
    const { root } = await lab(['sysctl -w net.ipv6.conf.eth0.temp_prefered_lft=3', 'sysctl -w net.ipv6.conf.eth0.max_desync_factor=0']);
    expect(temporaries(await globals(root))).toEqual([]);
  });

  it('deleting the public address deletes its temporary addresses', async () => {
    const { root } = await lab();
    const pub = publics(await globals(root))[0];
    await root(`ip -6 addr del ${pub.address}/64 dev eth0`);
    expect(await globals(root)).toEqual([]);
  });
});

describe('max_addresses', () => {
  it('stops the creation of autoconfigured addresses', async () => {
    const { root } = await lab(['sysctl -w net.ipv6.conf.eth0.max_addresses=1']);
    expect(await globals(root)).toEqual([]);
  });
});

describe('ip -6 route get', () => {
  it('on-link destination: connected route, source chosen by the same rule as the wire', async () => {
    const { root, host } = await lab();
    const rows = await globals(root);
    const out = await root('ip -6 route get 2001:db8::1');
    expect(out).toBe(`2001:db8::1 from :: dev eth0 proto ra src ${temporaries(rows)[0].address} metric 0 pref medium`);
    expect(await echoSource(host, root)).toBe(temporaries(rows)[0].address);
  });

  it('use_tempaddr=1 keeps the public address as the source', async () => {
    const { root } = await lab(['sysctl -w net.ipv6.conf.eth0.use_tempaddr=1']);
    const rows = await globals(root);
    expect(await root('ip -6 route get 2001:db8::1')).toContain(`src ${publics(rows)[0].address} `);
  });

  it('off-link destination: through the router learned from the advertisement', async () => {
    const { root } = await lab();
    const out = await root('ip -6 route get 2001:4860:4860::8888');
    expect(out).toMatch(/^2001:4860:4860::8888 from :: via fe80::[0-9a-f:]+ dev eth0 proto ra src 2001:db8::[0-9a-f:]+ metric \d+ pref medium$/);
  });

  it('works without -6 when the destination is an IPv6 address', async () => {
    const { root } = await lab();
    expect(await root('ip route get 2001:db8::1')).toBe(await root('ip -6 route get 2001:db8::1'));
  });

  it('a local address is local, on lo', async () => {
    const { root } = await lab();
    expect(await root('ip -6 route get ::1')).toBe('local ::1 from :: dev lo table local proto kernel src ::1 metric 0 pref medium');
    const pub = publics(await globals(root))[0].address;
    expect(await root(`ip -6 route get ${pub}`)).toBe(`local ${pub} from :: dev lo table local proto kernel src ${pub} metric 0 pref medium`);
  });

  it('dev restricts the lookup to that interface', async () => {
    const { root } = await lab();
    expect(await root('ip -6 route get 2001:db8::1 dev eth0')).toContain('dev eth0');
    expect(await root('ip -6 route get 2001:db8::1 dev eth1')).toBe('RTNETLINK answers: Network is unreachable');
  });

  it('a destination with no route is unreachable', async () => {
    const { root } = await lab(['sysctl -w net.ipv6.conf.eth0.accept_ra=0']);
    expect(await root('ip -6 route get 2001:db8:9::1')).toBe('RTNETLINK answers: Network is unreachable');
  });

  it('refuses something that is not an IPv6 address', async () => {
    const { root } = await lab();
    expect(await root('ip -6 route get zz')).toBe('Error: inet6 address is expected rather than "zz".');
  });

  it('show and get agree: the default route learned from an advertisement is proto ra, without the zone', async () => {
    const { root } = await lab();
    const shown = (await root('ip -6 route show')).split('\n').find((line) => line.startsWith('default'))!;
    expect(shown).toMatch(/^default via fe80::[0-9a-f:]+ dev eth0 proto ra metric \d+ pref medium$/);
    expect(shown).not.toContain('%');
  });
});
