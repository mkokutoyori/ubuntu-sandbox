/**
 * Cisco IOS Security Command Reference: `crypto ipsec client ezvpn` (global, interface, connect, xauth),
 * `clear crypto ipsec client ezvpn`, `show crypto ipsec client ezvpn`, `xauth userid mode`.
 * An Easy VPN remote names its group and key, reaches the server through IKE in aggressive mode with the
 * group as its identity, answers extended authentication, and takes the address, DNS, WINS, domain and
 * split-tunnel networks the server pushes. Client mode translates the inside networks to the pushed
 * address (PAT) and encrypts that address; network-extension mode encrypts the inside networks as they
 * are. `connect manual` waits for the exec command; `peer ... default` marks the primary of a failover list.
 *
 * Lab: HUB (EzVPN server of ezvpn-server.test.ts) and CLIENT with a PC behind it, real frames. The tap on
 * the client's outside port counts ESP; the PC's ping crosses the tunnel and the hub's loopback answers.
 *
 * Not in the security reference and written from IOS usage: the state names other than the ones printed
 * in the `show` examples (IDLE, IPSEC_ACTIVE, CONNECT_REQUIRED) and XAUTH_REQ. Not evaluated, hence not
 * declared: connect acl, xauth userid mode http-intercept, backup/track, virtual-interface, flow, nat acl.
 *
 * Measured with src stashed to HEAD: every case falls (the commands did not exist).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { run, ezvpnClientLab as lab, configureClient, assignInterfaces as assign, type EzvpnClientLab as Lab } from './_helpers/ezvpnClientLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

const ping = (l: Lab) => clock.advanceUntilSettled(l.pc.executeCommand('ping -c 1 10.1.0.1'));
const status = (l: Lab) => l.client.executeCommand('show crypto ipsec client ezvpn');

describe('EzVPN client', () => {
  it('network-extension: auto connect brings the tunnel up and the inside network crosses it as ESP', async () => {
    const l = await lab();
    await run(l.client, [...configureClient(['mode network-extension']), ...assign]);
    expect(await status(l)).toContain('Current State: IPSEC_ACTIVE');
    expect(await status(l)).toContain('Last Event: SOCKET_UP');
    const before = l.esp.count;
    expect(await ping(l)).toContain('1 received');
    expect(l.esp.count).toBeGreaterThan(before);
  });

  it('client mode: the pushed address appears, the inside is translated to it and the ping crosses ESP', async () => {
    const l = await lab();
    await run(l.client, [...configureClient(), ...assign]);
    const shown = await status(l);
    expect(shown).toContain('Current State: IPSEC_ACTIVE');
    expect(shown).toContain('Address: 10.9.9.1');
    const before = l.esp.count;
    expect(await ping(l)).toContain('1 received');
    expect(l.esp.count).toBeGreaterThan(before);
    expect(await l.client.executeCommand('show ip interface brief')).toContain('10.9.9.1');
  });

  it('the group DNS, WINS, domain and split-tunnel list are shown', async () => {
    const l = await lab([], ['key GROUPKEY', 'pool VPNPOOL', 'dns 10.1.0.53 10.1.0.54', 'wins 10.1.0.60', 'domain corp.lab', 'acl 150']);
    await run(l.client, [...configureClient(), ...assign]);
    const shown = await status(l);
    for (const text of ['DNS Primary: 10.1.0.53', 'DNS Secondary: 10.1.0.54', 'NBMS/WINS Primary: 10.1.0.60', 'Default Domain: corp.lab', 'Split Tunnel List: 1', 'Address    : 10.1.0.0']) {
      expect(shown).toContain(text);
    }
  });

  it('split tunnel: traffic outside the pushed networks is not translated nor encrypted', async () => {
    const l = await lab([], ['key GROUPKEY', 'pool VPNPOOL', 'acl 150']);
    await run(l.client, [...configureClient(), ...assign]);
    await run(l.client, ['ip route 172.16.0.0 255.255.0.0 10.0.12.1']);
    const before = l.esp.count;
    await clock.advanceUntilSettled(l.pc.executeCommand('ping -c 1 172.16.0.5'));
    expect(l.esp.count).toBe(before);
    expect(await ping(l)).toContain('1 received');
    expect(l.esp.count).toBeGreaterThan(before);
  });

  it('connect manual waits for the exec command, and `no` disconnects', async () => {
    const l = await lab();
    await run(l.client, [...configureClient(['mode network-extension', 'connect manual']), ...assign]);
    expect(await status(l)).toContain('Current State: CONNECT_REQUIRED');
    await ping(l);
    expect(l.esp.count).toBe(0);
    await l.client.executeCommand('enable');
    await l.client.executeCommand('crypto ipsec client ezvpn connect EZ');
    expect(await status(l)).toContain('Current State: IPSEC_ACTIVE');
    expect(await ping(l)).toContain('1 received');
    await l.client.executeCommand('no crypto ipsec client ezvpn connect EZ');
    expect(await status(l)).toContain('Current State: CONNECT_REQUIRED');
  });

  it('a wrong group key leaves the client idle', async () => {
    const l = await lab();
    await run(l.client, [...configureClient(['mode network-extension', 'group VPNGROUP key WRONG']), ...assign]);
    expect(await status(l)).not.toContain('IPSEC_ACTIVE');
    await ping(l);
    expect(l.esp.count).toBe(0);
  });

  it('extended authentication, saved credentials: the right password connects, the wrong one does not', async () => {
    const good = await lab(['crypto map CMAP client authentication list XAUTH']);
    await run(good.client, [...configureClient(['mode network-extension', 'username alice password 0 alicepw']), ...assign]);
    expect(await status(good)).toContain('IPSEC_ACTIVE');
  });

  it('extended authentication, wrong saved password: no tunnel', async () => {
    const bad = await lab(['crypto map CMAP client authentication list XAUTH']);
    await run(bad.client, [...configureClient(['mode network-extension', 'username alice password 0 nope']), ...assign]);
    expect(await status(bad)).not.toContain('IPSEC_ACTIVE');
  });

  it('interactive extended authentication waits in XAUTH_REQ until the credentials are given', async () => {
    const l = await lab(['crypto map CMAP client authentication list XAUTH']);
    await run(l.client, [...configureClient(['mode network-extension']), ...assign]);
    expect(await status(l)).toContain('Current State: XAUTH_REQ');
    const client = l.client._getOrCreateIPSecEngine().ezvpnClient;
    expect(client.pendingTunnel(null)).toEqual({ name: 'EZ' });
    client.connect('EZ', { user: 'alice', password: 'alicepw' });
    expect(await status(l)).toContain('Current State: IPSEC_ACTIVE');
  });

  it('the xauth command is a console dialogue: user name, password, then the connection', async () => {
    const l = await lab(['crypto map CMAP client authentication list XAUTH']);
    await run(l.client, [...configureClient(['mode network-extension']), ...assign]);
    const shell = (l.client as unknown as { shell: { interactionPlanFor(line: string, ctx: object): { steps: Array<{ kind: string; prompt?: string; run?: (rt: object) => Promise<void> }> } | null } }).shell;
    const plan = shell.interactionPlanFor('crypto ipsec client ezvpn xauth', { mode: 'privileged', device: l.client })!;
    expect(plan.steps.map((s) => s.kind)).toEqual(['text', 'password', 'run']);
    expect(plan.steps[0].prompt).toBe('Enter Username and Password: ');
    const values = new Map([['ezvpn_user', 'alice'], ['ezvpn_password', 'alicepw']]);
    await plan.steps[2].run!({ values, output: () => undefined });
    expect(await status(l)).toContain('IPSEC_ACTIVE');
  });

  it('the failover list: an unreachable primary is skipped for the next peer', async () => {
    const l = await lab();
    await run(l.client, [...configureClient(['mode network-extension', 'peer 10.0.99.99 default']), ...assign]);
    expect(await status(l)).toContain('Current EzVPN Peer: 10.0.12.1');
  });

  it('clear resets the state machine and reconnects', async () => {
    const l = await lab();
    await run(l.client, [...configureClient(['mode network-extension']), ...assign]);
    await l.client.executeCommand('enable');
    await l.client.executeCommand('clear crypto ipsec client ezvpn');
    expect(await status(l)).toContain('Current State: IPSEC_ACTIVE');
  });

  it('removing the interface assignment idles the client, and a configuration still assigned cannot be deleted', async () => {
    const l = await lab();
    await run(l.client, [...configureClient(['mode network-extension']), ...assign]);
    expect((await run(l.client, ['no crypto ipsec client ezvpn EZ'])).join('\n')).toContain('crypto map in use by interface; cannot delete');
    await run(l.client, ['interface GigabitEthernet0/1', 'no crypto ipsec client ezvpn EZ outside', 'exit']);
    const shown = await status(l);
    expect(shown).toContain('Last Event: REMOVE INTERFACE CFG');
    expect(shown).not.toContain('IPSEC_ACTIVE');
  });

  it('the configuration is read back by the running-config and the managed map stays hidden', async () => {
    const l = await lab();
    await run(l.client, [...configureClient(['mode network-extension', 'connect manual', 'username alice password 0 alicepw', 'xauth userid mode local']), ...assign]);
    const config = await l.client.executeCommand('show running-config');
    for (const line of ['crypto ipsec client ezvpn EZ', ' connect manual', ' group VPNGROUP key GROUPKEY', ' mode network-extension',
      ' peer 10.0.12.1', ' username alice password 0 alicepw', ' xauth userid mode local',
      ' crypto ipsec client ezvpn EZ', ' crypto ipsec client ezvpn EZ inside']) expect(config).toContain(line);
    expect(config).not.toContain('_ezvpn_');
    expect(config).not.toContain('#$!ezvpn');
  });
});
