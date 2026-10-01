/*
 * Commandes d'activation DHCPv6 par plateforme, avec leur source :
 *  - FortiGate : `set rapid-commit [disable|enable]` dans `config system dhcp6 server`
 *    (reference FortiOS 7.4.12 fournie dans official_docs/forti-cli-ref-7412.txt, page
 *    1494 et suivantes). La meme reference ne connait ni Reconfigure ni Server Unicast :
 *    il n'y a donc rien a ajouter, et rien n'est invente.
 *  - Huawei : `dhcpv6 rapid-commit` / `undo dhcpv6 rapid-commit` (vue systeme, sans
 *    parametre) et `information-refresh <600-4294967295>` / `undo information-refresh`
 *    (vue du pool, defaut 86400 s), d'apres la reference de commandes Huawei (AR,
 *    chapitre « DHCPv6 Configuration Commands ») lue par recherche : les pages ne sont
 *    pas joignables depuis cet environnement, seuls des extraits l'ont ete. Le defaut
 *    du Rapid Commit Huawei n'est pas etabli par ces extraits : le simulateur prend
 *    « inactif » (RFC 8415 §18.3.1 : le serveur doit etre configure pour l'accepter).
 *  - Cisco IOS : la prise en charge du message Reconfigure est declaree absente par la
 *    documentation consultee (fil de la communaute Cisco, non lisible ici non plus) :
 *    aucune commande a ajouter ; `rapid-commit` et `information refresh` existent deja.
 *
 * Discrimine par git stash des sources : 6 cas tombent (enable, relecture show, dhcpv6
 * rapid-commit, rendu display, information-refresh renvoye, refus sous 600 s). Les 6
 * autres passent avant comme apres, par nature : le temoin sans commande, les defauts
 * (quatre messages sans configuration, apres disable, apres undo, 86400 s apres undo)
 * et le refus d'une valeur hors liste, que le schema FortiOS refusait deja faute de
 * connaitre l'attribut.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
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
const run = async (d: Cmd, cmds: string[]) => {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
};

async function forti(rapid: 'enable' | 'disable' | null) {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC-LAN', -200, 0);
  new Cable('lan').connect(pc.getPort('eth0')!, fgt.getPort('port2')!);
  await run(pc, ['ip link set eth0 up']);
  await run(fgt, [
    'config system interface', 'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping',
    'config ipv6', 'set ip6-address 2001:db8:1:1::1/64', 'set ip6-send-adv enable', 'end', 'next', 'end',
    'config system dhcp6 server', 'edit 1', 'set interface "port2"', 'set subnet 2001:db8:1:1::/64',
    'config ip-range', 'edit 1', 'set start-ip 2001:db8:1:1::1000', 'set end-ip 2001:db8:1:1::1fff', 'next', 'end',
    ...(rapid ? [`set rapid-commit ${rapid}`] : []),
    'set status enable', 'next', 'end',
  ]);
  return { fgt, pc };
}

describe('FortiGate : set rapid-commit', () => {
  it('temoin : sans commande, un client qui le demande fait quatre messages', async () => {
    const { pc } = await forti(null);
    expect(pc.requestDhcpv6Lease('eth0', true, { rapidCommit: true })).toContain('DHCPv6 REQUEST');
  });

  it('enable : le client obtient son adresse en deux messages', async () => {
    const { pc } = await forti('enable');
    const out = pc.requestDhcpv6Lease('eth0', true, { rapidCommit: true });
    expect(out).toContain('(rapid commit)');
    expect(out).not.toContain('DHCPv6 REQUEST');
  });

  it('disable : quatre messages', async () => {
    const { pc } = await forti('disable');
    expect(pc.requestDhcpv6Lease('eth0', true, { rapidCommit: true })).toContain('DHCPv6 REQUEST');
  });

  it('la valeur se relit dans show', async () => {
    const { fgt } = await forti('enable');
    expect(await fgt.executeCommand('show system dhcp6 server')).toContain('set rapid-commit enable');
  });

  it('une valeur hors liste est refusee', async () => {
    const { fgt } = await forti(null);
    const out = await run(fgt, ['config system dhcp6 server', 'edit 1', 'set rapid-commit maybe']);
    expect(out[2]).toMatch(/invalid|parse error|unknown|Command fail/i);
  });
});

async function huawei(extra: string[] = []) {
  const h1 = new LinuxPC('linux-pc', 'H1');
  const r1 = new HuaweiRouter('R1');
  new Cable('a').connect(h1.getPort('eth0')!, r1.getPort('GE0/0/0')!);
  await run(r1, [
    'system-view', 'dhcpv6 pool V6POOL', 'address prefix 2001:db8:1::/64', 'dns-server 2001:4860:4860::8888',
    ...extra,
    'interface GigabitEthernet0/0/0', 'ipv6 enable', 'ipv6 address 2001:db8:1::1/64',
    'dhcpv6 server V6POOL', 'undo shutdown', 'quit',
  ]);
  return { h1, r1 };
}

describe('Huawei : dhcpv6 rapid-commit', () => {
  it('par defaut : quatre messages', async () => {
    const { h1 } = await huawei();
    expect(h1.requestDhcpv6Lease('eth0', true, { rapidCommit: true })).toContain('DHCPv6 REQUEST');
  });

  it('dhcpv6 rapid-commit : deux messages', async () => {
    const { h1, r1 } = await huawei();
    await run(r1, ['dhcpv6 rapid-commit']);
    const out = h1.requestDhcpv6Lease('eth0', true, { rapidCommit: true });
    expect(out).toContain('(rapid commit)');
    expect(out).not.toContain('DHCPv6 REQUEST');
  });

  it('undo dhcpv6 rapid-commit : retour a quatre messages', async () => {
    const { h1, r1 } = await huawei();
    await run(r1, ['dhcpv6 rapid-commit', 'undo dhcpv6 rapid-commit']);
    expect(h1.requestDhcpv6Lease('eth0', true, { rapidCommit: true })).toContain('DHCPv6 REQUEST');
  });

  it('rendu dans display current-configuration', async () => {
    const { r1 } = await huawei();
    await run(r1, ['dhcpv6 rapid-commit']);
    expect(await r1.executeCommand('display current-configuration')).toContain('dhcpv6 rapid-commit');
  });
});

describe('Huawei : information-refresh', () => {
  it('la valeur du pool est renvoyee au client stateless', async () => {
    const { h1, r1 } = await huawei(['information-refresh 10000']);
    h1.requestDhcpv6Information('eth0');
    expect(h1.getDhcpv6Information('eth0')?.refreshSeconds).toBe(10000);
    expect(await r1.executeCommand('display current-configuration')).toContain(' information-refresh 10000');
  });

  it('en dessous de 600 s : refus', async () => {
    const { r1 } = await huawei();
    const out = await run(r1, ['dhcpv6 pool V6POOL', 'information-refresh 599']);
    expect(out[1]).toContain('Wrong parameter');
  });

  it('undo information-refresh : retour a 86400 s', async () => {
    const { h1, r1 } = await huawei(['information-refresh 10000']);
    await run(r1, ['dhcpv6 pool V6POOL', 'undo information-refresh']);
    h1.requestDhcpv6Information('eth0');
    expect(h1.getDhcpv6Information('eth0')?.refreshSeconds).toBe(86400);
  });
});
