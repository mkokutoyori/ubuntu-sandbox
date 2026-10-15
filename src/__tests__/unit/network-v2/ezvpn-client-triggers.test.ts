/**
 * Cisco IOS Security Command Reference, `crypto ipsec client ezvpn` configuration mode: `connect acl`
 * (interesting traffic from an inside interface raises the tunnel), `flow restrict` (inside traffic does
 * not leave in clear text while the tunnel is down), `idle-time` (the tunnel goes down after the idle
 * time), `nat acl` (local split-tunnel list), `backup NAME track N` (another configuration takes over
 * when the tracked object goes down, and gives the interfaces back when it is up: Last Event
 * TRACKED OBJECT UP / DOWN), `peer ... default` (when the primary peer is available again the
 * connection is torn down and the primary reconnected).
 *
 * The 60 s probing interval of the primary peer is not in the reference and is ours.
 * Not declared: local-address (the reference limits it to the uBR905/uBR925 cable routers), flow allow acl
 * (the reference describes it with the opposite verb of its name), nat allow, virtual-interface (needs
 * routing into a virtual-access interface), xauth userid mode http-intercept (needs a transparent TCP
 * proxy on the inside interface).
 *
 * Measured with src stashed to HEAD: every case falls (the subcommands did not exist).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Hub } from '@/network/devices/Hub';
import { Cable } from '@/network/hardware/Cable';
import { run, IKE, ezvpnHubLines, ezvpnClientLab as lab, configureClient, assignInterfaces as assign, type EzvpnClientLab as Lab } from './_helpers/ezvpnClientLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

const status = (l: Lab) => l.client.executeCommand('show crypto ipsec client ezvpn');
const ping = (l: Lab, target = '10.1.0.1') => clock.advanceUntilSettled(l.pc.executeCommand(`ping -c 1 ${target}`));
const NEM = 'mode network-extension';

describe('EzVPN client triggers', () => {
  it('connect acl: interesting traffic raises the tunnel, other traffic does not', async () => {
    const l = await lab();
    await run(l.client, ['access-list 120 permit ip 192.168.10.0 0.0.0.255 10.1.0.0 0.0.0.255',
      ...configureClient([NEM, 'connect acl 120']), ...assign, 'ip route 172.16.0.0 255.255.0.0 10.0.12.1']);
    expect(await status(l)).toContain('Current State: CONNECT_REQUIRED');
    await ping(l, '172.16.0.5');
    expect(await status(l)).toContain('Current State: CONNECT_REQUIRED');
    const before = l.esp.count;
    await ping(l);
    expect(await status(l)).toContain('Current State: IPSEC_ACTIVE');
    expect(l.esp.count).toBeGreaterThan(before);
  });

  it('flow restrict: clear text does not leave while the tunnel is down, and flows once it is up', async () => {
    const free = await lab();
    await run(free.client, [...configureClient([NEM, 'connect manual']), ...assign]);
    expect(await ping(free)).toContain('1 received');
    const l = await lab();
    await run(l.client, [...configureClient([NEM, 'connect manual', 'flow restrict']), ...assign]);
    expect(await ping(l)).toContain('0 received');
    await l.client.executeCommand('enable');
    await l.client.executeCommand('crypto ipsec client ezvpn connect EZ');
    expect(await ping(l)).toContain('1 received');
    expect(l.esp.count).toBeGreaterThan(0);
  });

  it('idle-time: the tunnel goes down after the idle time, and traffic postpones it', async () => {
    const l = await lab();
    await run(l.client, [...configureClient([NEM, 'idle-time 120']), ...assign]);
    expect(await status(l)).toContain('IPSEC_ACTIVE');
    await clock.advance(80_000);
    await ping(l);
    await clock.advance(80_000);
    expect(await status(l)).toContain('IPSEC_ACTIVE');
    await clock.advance(60_000);
    const shown = await status(l);
    expect(shown).toContain('Current State: CONNECT_REQUIRED');
    expect(shown).toContain('Last Event: IDLE_TIMEOUT');
    expect(l.client._getOrCreateIPSecEngine().hasIkeSA('10.0.12.1')).toBe(false);
  });

  it('nat acl: only the traffic the access list matches is translated and encrypted (client mode)', async () => {
    const l = await lab();
    await run(l.client, ['access-list 130 permit ip 192.168.10.0 0.0.0.255 host 10.1.0.1',
      ...configureClient(['nat acl 130']), ...assign, 'ip route 10.1.0.0 255.255.255.0 10.0.12.1']);
    const before = l.esp.count;
    await ping(l, '10.1.0.77');
    expect(l.esp.count).toBe(before);
    await ping(l);
    expect(l.esp.count).toBeGreaterThan(before);
  });

  it('the primary peer is probed again and the connection moves back to it', async () => {
    const primary = new CiscoRouter('PRIMARY');
    const standby = new CiscoRouter('STANDBY');
    const client = new CiscoRouter('CLIENT');
    const pc = new LinuxPC('linux-pc', 'PC1');
    const wire = new Hub('WIRE', 4);
    new Cable('p').connect(primary.getPort('GigabitEthernet0/1')!, wire.getPort('eth0')!);
    new Cable('s').connect(standby.getPort('GigabitEthernet0/1')!, wire.getPort('eth1')!);
    new Cable('c').connect(client.getPort('GigabitEthernet0/1')!, wire.getPort('eth2')!);
    new Cable('l').connect(pc.getPort('eth0')!, client.getPort('GigabitEthernet0/0')!);
    await run(primary, ezvpnHubLines('10.0.12.1', '10.0.12.2', [], ['key GROUPKEY', 'pool VPNPOOL']).map((l) => l.replace('255.255.255.252', '255.255.255.248')));
    await run(standby, ezvpnHubLines('10.0.12.3', '10.0.12.2', [], ['key GROUPKEY', 'pool VPNPOOL']).map((l) => l.replace('255.255.255.252', '255.255.255.248')));
    await run(primary, ['no crypto isakmp enable']);
    await run(client, ['interface GigabitEthernet0/1', 'ip address 10.0.12.2 255.255.255.248', 'no shutdown', 'exit',
      'interface GigabitEthernet0/0', 'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit', ...IKE,
      ...configureClient(['mode network-extension', 'peer 10.0.12.1 default', 'peer 10.0.12.3']), ...assign]);
    const engine = client._getOrCreateIPSecEngine();
    expect(engine.ezvpnClient.runtimeOf('EZ').peer).toBe('10.0.12.3');
    await run(primary, ['crypto isakmp enable']);
    await clock.advance(70_000);
    expect(engine.ezvpnClient.runtimeOf('EZ').peer).toBe('10.0.12.1');
  });

  it('backup ... track: the backup configuration takes over while the tracked object is down', async () => {
    const l = await lab();
    await run(l.hub, ['crypto isakmp client configuration group BACKUPGROUP', 'key BACKUPKEY', 'pool VPNPOOL', 'exit']);
    await run(l.client, ['interface Loopback5', 'ip address 10.5.5.5 255.255.255.255', 'exit', 'track 1 interface Loopback5 line-protocol',
      'crypto ipsec client ezvpn EZB', 'group BACKUPGROUP key BACKUPKEY', 'peer 10.0.12.1', NEM, 'exit',
      ...configureClient([NEM, 'backup EZB track 1']), ...assign]);
    await clock.advance(1000);
    const first = await status(l);
    expect(first).toContain('Tunnel name : EZ');
    expect(first).toContain('IPSEC_ACTIVE');
    await run(l.client, ['interface Loopback5', 'shutdown', 'exit']);
    await clock.advance(2000);
    const down = await status(l);
    expect(down).toContain('Tunnel name : EZB');
    expect(down).toMatch(/Tunnel name : EZB[\s\S]*Current State: IPSEC_ACTIVE/);
    expect(down).toContain('Last Event: TRACKED OBJECT DOWN');
    await run(l.client, ['interface Loopback5', 'no shutdown', 'exit']);
    await clock.advance(2000);
    const up = await status(l);
    expect(up).toMatch(/Tunnel name : EZ\n[\s\S]*Current State: IPSEC_ACTIVE[\s\S]*Last Event: SOCKET_UP/);
    expect(up).not.toContain('Tunnel name : EZB');
  });

  it('the new subcommands are read back by the running-config', async () => {
    const l = await lab();
    await run(l.client, ['access-list 120 permit ip any any', 'access-list 130 permit ip any any', 'crypto ipsec client ezvpn EZB',
      ...configureClient([NEM, 'connect acl 120', 'flow restrict', 'idle-time 300', 'nat acl 130', 'backup EZB track 7'])]);
    const config = await l.client.executeCommand('show running-config');
    for (const line of [' connect acl 120', ' flow restrict', ' idle-time 300', ' nat acl 130', ' backup EZB track 7']) expect(config).toContain(line);
  });
});
