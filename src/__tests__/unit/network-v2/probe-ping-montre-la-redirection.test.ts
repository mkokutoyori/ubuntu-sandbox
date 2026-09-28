/*
 * `ping` taisait la redirection ICMP que la passerelle lui renvoyait.
 *
 * Mesure de depart, sur le lab de l'utilisateur construit a la CLI : PC1
 * ping 10.99.99.1, un reseau qui n'existe nulle part. Router2, passerelle
 * de PC1, route tout vers FW1 sur le MEME LAN : il transmet l'echo a FW1
 * et renvoie a PC1 une redirection « use 192.168.1.99 ». PC1 l'a bien
 * prise (`ip route get` : `cache <redirected>`), mais le terminal
 * n'affichait que
 *
 *   PING 10.99.99.1 (10.99.99.1) 56(84) bytes of data.
 *   ^C
 *   5 packets transmitted, 0 received, 100% packet loss, time 6009ms
 *
 * L'AUTORITE EST LE NOYAU ET IPUTILS. Un utilisateur ordinaire pinge par
 * une socket ICMP datagramme. `ping_err` (`net/ipv4/ping.c`) traite la
 * redirection (`ipv4_sk_redirect`) PUIS la remet a la socket comme une
 * erreur (`ip_icmp_error`). `ping4_receive_error_msg` (`ping/ping.c`)
 * l'affiche — « From 192.168.1.1 icmp_seq=1 Redirect Host(New nexthop:
 * 192.168.1.99) », par `ping_print_error_packet` puis `pr_icmph` — et la
 * compte dans `nerrors` : la ligne de statistiques porte `+N errors`.
 * `acknowledge` ne fait que cadencer l'emetteur : la reponse a ce meme
 * echo, si elle vient, s'affiche aussi. Et `main_loop` s'arrete des que
 * `nreceived + nerrors >= npackets` : une redirection compte pour `-c`.
 *
 * Le voisin 192.168.1.99 n'est pas connu de PC1 quand arrive la premiere
 * redirection : `__ip_do_redirect` l'interroge par ARP et ne retient rien.
 * Le deuxieme echo repart donc par Router2 et vaut une seconde
 * redirection ; le troisieme suit l'exception.
 *
 * Ecrite a l'aveugle contre ces sources, avant de lire la reception. Une
 * premiere version supposait qu'apres les deux redirections venait le
 * silence ; dans ce banc, FW1 est un routeur IOS sans route vers
 * 10.99.99.1, qui repond « Destination Net Unreachable ». Le banc sait
 * donc faire taire FW1 (`no ip unreachables`) ou lui donner la cible.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 6 des 8 cas tombent. Passent des deux cotes les deux TEMOINS : l'hote
 * prend la redirection (`ip route get`), et `ping` sous Windows n'affiche
 * aucune ligne de redirection.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

let scheduler: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
  scheduler = new VirtualTimeScheduler();
  __setDefaultScheduler(scheduler);
});

afterEach(() => { __setDefaultScheduler(null); });

type Cli = { executeCommand(c: string): Promise<string> };

const run = (device: Cli, command: string): Promise<string> =>
  scheduler.advanceUntilSettled(Promise.resolve(device.executeCommand(command)));

type Firewall = 'unreachables' | 'silent' | 'owns-target';

const FIREWALL_EXTRA: Record<Firewall, { onLan: string[]; after: string[] }> = {
  unreachables: { onLan: [], after: [] },
  silent: { onLan: ['no ip unreachables'], after: [] },
  'owns-target': { onLan: [], after: ['interface Loopback0', 'ip address 10.99.99.1 255.255.255.255', 'exit'] },
};

async function lab(firewall: Firewall = 'unreachables'): Promise<{ pc: LinuxPC; win: WindowsPC }> {
  const lan = new GenericSwitch('switch-generic', 'LAN', 4, 0, 0);
  const router2 = new CiscoRouter('Router2', 0, 0);
  const fw = new CiscoRouter('FW1', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const win = new WindowsPC('windows-pc', 'PC2', 0, 0);
  new Cable('c1').connect(router2.getPorts()[0], lan.getPorts()[0]);
  new Cable('c2').connect(fw.getPorts()[0], lan.getPorts()[1]);
  new Cable('c3').connect(pc.getPorts()[0], lan.getPorts()[2]);
  new Cable('c4').connect(win.getPorts()[0], lan.getPorts()[3]);
  for (const c of ['enable', 'configure terminal',
    `interface ${router2.getPorts()[0].getName()}`, 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 0.0.0.0 0.0.0.0 192.168.1.99', 'end']) await run(router2, c);
  const extra = FIREWALL_EXTRA[firewall];
  for (const c of ['enable', 'configure terminal',
    `interface ${fw.getPorts()[0].getName()}`, 'ip address 192.168.1.99 255.255.255.0', ...extra.onLan,
    'no shutdown', 'exit', ...extra.after, 'end']) await run(fw, c);
  await run(pc, 'sudo ip addr add 192.168.1.3/24 dev eth0');
  await run(pc, 'sudo ip route add default via 192.168.1.1');
  await run(win, 'netsh interface ip set address "Ethernet 0" static 192.168.1.2 255.255.255.0 192.168.1.1');
  return { pc, win };
}

const fromLines = (out: string): string[] => out.split('\n').filter((l) => l.startsWith('From '));
const redirectLines = (out: string): string[] => out.split('\n').filter((l) => /Redirect/.test(l));

describe('ping shows the redirect its gateway sends back', () => {
  it('each echo sent through the old gateway is answered by a redirect line, then by what lies beyond', async () => {
    const { pc } = await lab();

    expect(fromLines(await run(pc, 'ping -c 4 10.99.99.1'))).toEqual([
      'From 192.168.1.1 icmp_seq=1 Redirect Host(New nexthop: 192.168.1.99)',
      'From 192.168.1.99 icmp_seq=1 Destination Net Unreachable',
      'From 192.168.1.1 icmp_seq=2 Redirect Host(New nexthop: 192.168.1.99)',
      'From 192.168.1.99 icmp_seq=2 Destination Net Unreachable',
    ]);
  });

  it('the second echo is redirected too, the new gateway not being known yet; then silence', async () => {
    const { pc } = await lab('silent');

    expect(fromLines(await run(pc, 'ping -c 4 10.99.99.1'))).toEqual([
      'From 192.168.1.1 icmp_seq=1 Redirect Host(New nexthop: 192.168.1.99)',
      'From 192.168.1.1 icmp_seq=2 Redirect Host(New nexthop: 192.168.1.99)',
    ]);
  });

  it('the statistics count them as errors', async () => {
    const { pc } = await lab('silent');

    expect(await run(pc, 'ping -c 4 10.99.99.1'))
      .toMatch(/^4 packets transmitted, 0 received, \+2 errors, 100% packet loss, time 3000ms$/m);
  });

  it('a redirect does not settle the echo: its reply is still printed, after it', async () => {
    const { pc } = await lab('owns-target');

    const out = await run(pc, 'ping -c 1 10.99.99.1');

    expect(out.split('\n').filter((l) => /icmp_seq=1 /.test(l)).map((l) => l.replace(/ time=.*/, ''))).toEqual([
      'From 192.168.1.1 icmp_seq=1 Redirect Host(New nexthop: 192.168.1.99)',
      '64 bytes from 10.99.99.1: icmp_seq=1 ttl=255',
    ]);
  });

  it('errors count toward -c, as nreceived + nerrors do in iputils', async () => {
    const { pc } = await lab('owns-target');

    expect(await run(pc, 'ping -c 3 10.99.99.1'))
      .toMatch(/^2 packets transmitted, 2 received, \+2 errors, 0% packet loss, time 1000ms$/m);
  });

  it('-n keeps the addresses numeric in the redirect line', async () => {
    const { pc } = await lab();

    expect(await run(pc, 'ping -n -c 1 10.99.99.1'))
      .toMatch(/^From 192\.168\.1\.1 icmp_seq=1 Redirect Host\(New nexthop: 192\.168\.1\.99\)$/m);
  });

  it('the host still takes the redirect — WITNESS', async () => {
    const { pc } = await lab();
    await run(pc, 'ping -c 4 10.99.99.1');

    expect(await run(pc, 'ip route get 10.99.99.1')).toMatch(/^10\.99\.99\.1 via 192\.168\.1\.99 dev eth0 /);
  });

  it('Windows ping prints no redirect line — WITNESS', async () => {
    const { win } = await lab();

    expect(redirectLines(await run(win, 'ping -n 2 10.99.99.1'))).toEqual([]);
  });
});
