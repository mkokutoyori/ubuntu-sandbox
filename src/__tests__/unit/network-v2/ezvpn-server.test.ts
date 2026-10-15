/**
 * Cisco IOS Security Command Reference: `crypto isakmp client configuration group`, `crypto map
 * client authentication list`, `crypto map isakmp authorization list`, `crypto map client configuration
 * address respond`, `show crypto session group|summary`. A remote-access client names its group in
 * the IKE identity, proves the group key, authenticates a user (extended authentication, here the
 * `local` method of an AAA list) and receives an address, DNS, WINS, domain and split-tunnel networks
 * from the pool and the group policy. max-users and max-logins bound the sessions.
 *
 * Lab: HUB (dynamic crypto map, EzVPN server) with two spokes over real frames. The clients are
 * plain crypto-map routers that announce the group as their IKE identity and ask for a
 * configuration through the engine's configuration payload (the EzVPN client CLI is a later change);
 * the hub's answer is read back from the client engine and the hub's own views.
 *
 * `ip local pool` and the group submode are not in the security reference (the pool is IP addressing
 * documentation) and are written from IOS usage; the `show crypto session` layouts are the reference's examples.
 *
 * Measured with src stashed to HEAD: 9 of the 13 cases fall (no group submode, no pool, no address ever pushed, no
 * limits, no session views). Four pass either way: the witness, and the three refusals (other key, unknown group,
 * exhausted pool), which are refusals before the change for want of any answer; each is paired with a positive
 * case in this file that does fall.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

async function run(router: CiscoRouter, lines: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) out.push(await router.executeCommand(line));
  return out;
}

const IKE = ['crypto isakmp policy 10', 'encryption aes 256', 'hash sha256', 'authentication pre-share', 'group 14', 'exit'];
const TSET = ['crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit'];

interface EzLab { hub: CiscoRouter; spokes: CiscoRouter[]; pcs: LinuxPC[] }

async function lab(hubExtra: string[] = [], groupLines: string[] = ['key GROUPKEY', 'pool VPNPOOL']): Promise<EzLab> {
  const hub = new CiscoRouter('HUB');
  const spokes = [new CiscoRouter('S1'), new CiscoRouter('S2')];
  const pcs = [new LinuxPC('linux-pc', 'PC1'), new LinuxPC('linux-pc', 'PC2')];
  const wan = ['10.0.12', '10.0.13'];
  await run(hub, [
    'interface Loopback0', 'ip address 10.1.0.1 255.255.255.0', 'exit',
    ...spokes.flatMap((_, i) => [`interface GigabitEthernet0/${i + 1}`, `ip address ${wan[i]}.1 255.255.255.252`, 'no shutdown', 'exit']),
    ...IKE, 'crypto isakmp key WILDKEY address 0.0.0.0 0.0.0.0', ...TSET,
    'crypto dynamic-map DMAP 10', 'set transform-set TSET', 'exit',
    'crypto map CMAP 65535 ipsec-isakmp dynamic DMAP',
    'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit',
    'interface GigabitEthernet0/2', 'crypto map CMAP', 'exit',
    'aaa new-model', 'aaa authentication login XAUTH local', 'aaa authorization network GROUPAUTH local',
    'username alice secret alicepw', 'username bob secret bobpw',
    'ip local pool VPNPOOL 10.9.9.1 10.9.9.2',
    'access-list 150 permit ip 10.1.0.0 0.0.0.255 any',
    'crypto isakmp client configuration group VPNGROUP', ...groupLines, 'exit',
    'crypto map CMAP client configuration address respond',
    ...hubExtra,
  ]);
  for (const [i, spoke] of spokes.entries()) {
    new Cable(`wan${i}`).connect(hub.getPort(`GigabitEthernet0/${i + 1}`)!, spoke.getPort('GigabitEthernet0/1')!);
    await run(spoke, [
      'interface GigabitEthernet0/1', `ip address ${wan[i]}.2 255.255.255.252`, 'no shutdown', 'exit',
      'interface GigabitEthernet0/0', `ip address 192.168.${i + 10}.1 255.255.255.0`, 'no shutdown', 'exit',
      ...IKE, `crypto isakmp key GROUPKEY address ${wan[i]}.1`, ...TSET,
      `ip access-list extended VPN_ACL`, `permit ip 192.168.${i + 10}.0 0.0.0.255 10.1.0.0 0.0.0.255`, 'exit',
      'crypto map CMAP 10 ipsec-isakmp', `set peer ${wan[i]}.1`, 'set transform-set TSET', 'match address VPN_ACL', 'exit',
      'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit',
      `ip route 10.1.0.0 255.255.255.0 ${wan[i]}.1`,
    ]);
    new Cable(`lan${i}`).connect(pcs[i].getPort('eth0')!, spoke.getPort('GigabitEthernet0/0')!);
    await pcs[i].executeCommand(`sudo ip addr add 192.168.${i + 10}.10/24 dev eth0`);
    await pcs[i].executeCommand(`sudo ip route add default via 192.168.${i + 10}.1`);
  }
  await run(hub, ['ip route 192.168.10.0 255.255.255.0 10.0.12.2', 'ip route 192.168.11.0 255.255.255.0 10.0.13.2']);
  current = { hub, spokes, pcs };
  return current;
}

function asClient(spoke: CiscoRouter, peer: string, group: string, user: string, password: string): void {
  const engine = spoke._getOrCreateIPSecEngine();
  engine.getOrCreateCryptoMapEntry('CMAP', 10).localIdentity = group;
  engine.requestConfigFor(peer, { wantAddress: true, identity: user, credential: password });
}

let current: EzLab;
const reach = (_spoke: CiscoRouter, i: number) =>
  clock.advanceUntilSettled(current.pcs[i].executeCommand('ping -c 1 10.1.0.1'));

describe('EzVPN server', () => {
  it('witness (passes either way): a spoke with the plain wildcard key brings its tunnel up', async () => {
    const l = await lab();
    await run(l.spokes[0], ['crypto isakmp key WILDKEY address 10.0.12.1']);
    await reach(l.spokes[0], 0);
    expect(await l.hub.executeCommand('show crypto isakmp sa')).toContain('10.0.12.2');
  });

  it('the group key authenticates a client that names its group', async () => {
    const l = await lab();
    asClient(l.spokes[0], '10.0.12.1', 'VPNGROUP', 'alice', 'alicepw');
    await reach(l.spokes[0], 0);
    expect(l.spokes[0]._getOrCreateIPSecEngine().hasIkeSA('10.0.12.1')).toBe(true);
    expect(l.spokes[0]._getOrCreateIPSecEngine().configReplyFor('10.0.12.1')?.address).toBe('10.9.9.1');
  });

  it('a client proving another key than its group key is refused', async () => {
    const l = await lab();
    await run(l.spokes[0], ['crypto isakmp key OTHERKEY address 10.0.12.1']);
    asClient(l.spokes[0], '10.0.12.1', 'VPNGROUP', 'alice', 'alicepw');
    await reach(l.spokes[0], 0);
    expect(l.spokes[0]._getOrCreateIPSecEngine().configReplyFor('10.0.12.1')).toBeUndefined();
  });

  it('the pool, dns, wins, domain, netmask and split-tunnel networks are pushed', async () => {
    const l = await lab([], ['key GROUPKEY', 'pool VPNPOOL', 'dns 10.1.0.53 10.1.0.54', 'wins 10.1.0.60', 'domain corp.lab', 'acl 150', 'netmask 255.255.255.0']);
    asClient(l.spokes[0], '10.0.12.1', 'VPNGROUP', 'alice', 'alicepw');
    await reach(l.spokes[0], 0);
    const reply = l.spokes[0]._getOrCreateIPSecEngine().configReplyFor('10.0.12.1')!;
    expect(reply.address).toBe('10.9.9.1');
    expect(reply.netmask).toBe('255.255.255.0');
    expect(reply.dnsServers).toEqual(['10.1.0.53', '10.1.0.54']);
    expect(reply.winsServers).toEqual(['10.1.0.60']);
    expect(reply.domain).toBe('corp.lab');
    expect(reply.splitInclude).toEqual(['10.1.0.0/255.255.255.0']);
  });

  it('extended authentication: a wrong password gets no address, the right one does', async () => {
    const l = await lab(['crypto map CMAP client authentication list XAUTH']);
    asClient(l.spokes[0], '10.0.12.1', 'VPNGROUP', 'alice', 'wrong');
    await reach(l.spokes[0], 0);
    expect(l.spokes[0]._getOrCreateIPSecEngine().configReplyFor('10.0.12.1')).toBeUndefined();
    asClient(l.spokes[0], '10.0.12.1', 'VPNGROUP', 'alice', 'alicepw');
    await clock.advance(400_000);
    await reach(l.spokes[0], 0);
    expect(l.spokes[0]._getOrCreateIPSecEngine().configReplyFor('10.0.12.1')?.address).toBe('10.9.9.1');
  });

  it('group authorization: an unknown group name is refused', async () => {
    const l = await lab(['crypto map CMAP isakmp authorization list GROUPAUTH']);
    asClient(l.spokes[0], '10.0.12.1', 'NOGROUP', 'alice', 'alicepw');
    await reach(l.spokes[0], 0);
    expect(l.spokes[0]._getOrCreateIPSecEngine().configReplyFor('10.0.12.1')).toBeUndefined();
  });

  it('max-users bounds the group: the second client is refused', async () => {
    const l = await lab([], ['key GROUPKEY', 'pool VPNPOOL', 'max-users 1']);
    asClient(l.spokes[0], '10.0.12.1', 'VPNGROUP', 'alice', 'alicepw');
    asClient(l.spokes[1], '10.0.13.1', 'VPNGROUP', 'bob', 'bobpw');
    await reach(l.spokes[0], 0);
    await reach(l.spokes[1], 1);
    expect(l.spokes[0]._getOrCreateIPSecEngine().configReplyFor('10.0.12.1')?.address).toBe('10.9.9.1');
    expect(l.spokes[1]._getOrCreateIPSecEngine().configReplyFor('10.0.13.1')).toBeUndefined();
  });

  it('max-logins bounds one user: the same user on a second client is refused, another user is not', async () => {
    const l = await lab([], ['key GROUPKEY', 'pool VPNPOOL', 'max-logins 1']);
    asClient(l.spokes[0], '10.0.12.1', 'VPNGROUP', 'alice', 'alicepw');
    asClient(l.spokes[1], '10.0.13.1', 'VPNGROUP', 'alice', 'alicepw');
    await reach(l.spokes[0], 0);
    await reach(l.spokes[1], 1);
    expect(l.spokes[1]._getOrCreateIPSecEngine().configReplyFor('10.0.13.1')).toBeUndefined();
    asClient(l.spokes[1], '10.0.13.1', 'VPNGROUP', 'bob', 'bobpw');
    await clock.advance(400_000);
    await reach(l.spokes[1], 1);
    expect(l.spokes[1]._getOrCreateIPSecEngine().configReplyFor('10.0.13.1')?.address).toBe('10.9.9.2');
  });

  it('an exhausted pool refuses the next client', async () => {
    const l = await lab();
    await run(l.hub, ['no ip local pool VPNPOOL', 'ip local pool VPNPOOL 10.9.9.1']);
    asClient(l.spokes[0], '10.0.12.1', 'VPNGROUP', 'alice', 'alicepw');
    asClient(l.spokes[1], '10.0.13.1', 'VPNGROUP', 'bob', 'bobpw');
    await reach(l.spokes[0], 0);
    await reach(l.spokes[1], 1);
    expect(l.spokes[1]._getOrCreateIPSecEngine().configReplyFor('10.0.13.1')).toBeUndefined();
  });

  it('show crypto session summary and group follow the reference layouts, blank without limits', async () => {
    const l = await lab([], ['key GROUPKEY', 'pool VPNPOOL', 'max-users 5']);
    asClient(l.spokes[0], '10.0.12.1', 'VPNGROUP', 'alice', 'alicepw');
    await reach(l.spokes[0], 0);
    expect(await l.hub.executeCommand('show crypto session summary')).toBe('Group VPNGROUP has 1 connections\nUser (Logins)\nalice (1)');
    expect(await l.hub.executeCommand('show crypto session group')).toBe('Group: Connections\nVPNGROUP: 1');
    expect(await l.hub.executeCommand('show ip local pool VPNPOOL')).toMatch(/VPNPOOL\s+10\.9\.9\.1\s+10\.9\.9\.2\s+1\s+1/);
    await run(l.hub, ['crypto isakmp client configuration group VPNGROUP', 'no max-users 5', 'exit']);
    expect(await l.hub.executeCommand('show crypto session summary')).toBe('');
  });

  it('the group, the pool and the map policy are read back by the running-config', async () => {
    const l = await lab(['crypto map CMAP client authentication list XAUTH', 'crypto map CMAP isakmp authorization list GROUPAUTH'],
      ['key GROUPKEY', 'pool VPNPOOL', 'dns 10.1.0.53', 'max-users 3', 'max-logins 2']);
    const config = await l.hub.executeCommand('show running-config');
    for (const line of [
      'crypto isakmp client configuration group VPNGROUP', ' key GROUPKEY', ' pool VPNPOOL', ' dns 10.1.0.53', ' max-users 3', ' max-logins 2',
      'ip local pool VPNPOOL 10.9.9.1 10.9.9.2', 'crypto map CMAP client authentication list XAUTH',
      'crypto map CMAP isakmp authorization list GROUPAUTH', 'crypto map CMAP client configuration address respond',
    ]) expect(config).toContain(line);
  });

  it('`client configuration address initiate` makes the router ask its peer for an address', async () => {
    const l = await lab();
    await run(l.spokes[0], ['crypto map CMAP client configuration address initiate']);
    await reach(l.spokes[0], 0);
    expect(l.spokes[0]._getOrCreateIPSecEngine().configReplyFor('10.0.12.1')).toBeUndefined();
    await run(l.hub, ['crypto isakmp client configuration group VPNGROUP', 'exit']);
    await run(l.spokes[0], ['crypto map CMAP client configuration address initiate']);
    const engine = l.spokes[0]._getOrCreateIPSecEngine();
    engine.getOrCreateCryptoMapEntry('CMAP', 10).localIdentity = 'VPNGROUP';
    await clock.advance(400_000);
    await reach(l.spokes[0], 0);
    expect(engine.configReplyFor('10.0.12.1')?.address).toBe('10.9.9.1');
  });

  it('the default pool serves groups that name none, and is read back', async () => {
    const l = await lab([], ['key GROUPKEY']);
    expect(await run(l.hub, ['crypto isakmp client configuration address-pool local NOSUCH']).then((o) => o.join('\n'))).toContain('not defined');
    await run(l.hub, ['crypto isakmp client configuration address-pool local VPNPOOL']);
    asClient(l.spokes[0], '10.0.12.1', 'VPNGROUP', 'alice', 'alicepw');
    await reach(l.spokes[0], 0);
    expect(l.spokes[0]._getOrCreateIPSecEngine().configReplyFor('10.0.12.1')?.address).toBe('10.9.9.1');
    expect(await l.hub.executeCommand('show running-config')).toContain('crypto isakmp client configuration address-pool local VPNPOOL');
  });
});
