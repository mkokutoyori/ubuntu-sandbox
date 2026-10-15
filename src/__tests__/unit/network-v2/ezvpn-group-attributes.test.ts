/**
 * Cisco IOS Security Command Reference, `crypto isakmp client configuration group`: the `default` group
 * (policy for users who offer no matching group name), `access-restrict`, `group-lock`, `banner`,
 * `configuration url|version`, `backup-gateway`, `include-local-lan`, `save-password`, `browser-proxy`
 * (+ `crypto isakmp client configuration browser-proxy` and its `proxy` subcommands). The server pushes
 * them in the mode configuration reply; the Easy VPN remote router shows the URL, version, save-password
 * and proxy in `show crypto ipsec client ezvpn`, logs the banner, adds the backup gateways to its failover
 * list, keeps traffic to its outside subnet out of the tunnel with include-local-lan, and saves the
 * extended authentication password when the group allows it.
 *
 * Not declared, because nothing here can evaluate them: pfs, split-dns, firewall are-u-there, firewall
 * policy, auto-update client, dhcp giaddr|server|timeout, crypto aaa attribute list (software-client
 * features, a DHCP proxy, an attribute store). `key 6` and `password 6` need the master key whose
 * algorithm is not in the reference: they are refused.
 *
 * Measured with src stashed to HEAD: 9 of the 10 cases fall (the subcommands did not exist); the case where a
 * group without save-password reports Disallowed is the witness that passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress } from '@/network/core/types';
import type { IPv4Packet } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { run, ezvpnClientLab as lab, configureClient, assignInterfaces as assign } from './_helpers/ezvpnClientLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

const status = (l: Awaited<ReturnType<typeof lab>>) => l.client.executeCommand('show crypto ipsec client ezvpn');
const NEM = ['mode network-extension'];

describe('EzVPN group attributes', () => {
  it('the default group answers a client whose group name matches none, with the default key', async () => {
    const l = await lab([], ['key GROUPKEY', 'pool VPNPOOL']);
    await run(l.hub, ['crypto isakmp client configuration group default', 'key DEFKEY', 'pool VPNPOOL', 'exit',
      'no crypto isakmp client configuration group VPNGROUP']);
    await run(l.client, [...configureClient([...NEM, 'group OTHER key DEFKEY']), ...assign]);
    expect(await status(l)).toContain('IPSEC_ACTIVE');
  });

  it('access-restrict ties the group to an interface', async () => {
    const right = await lab([], ['key GROUPKEY', 'pool VPNPOOL', 'access-restrict Gi0/1']);
    await run(right.client, [...configureClient(NEM), ...assign]);
    expect(await status(right)).toContain('IPSEC_ACTIVE');
    const wrong = await lab([], ['key GROUPKEY', 'pool VPNPOOL', 'access-restrict Gi0/0']);
    await run(wrong.client, [...configureClient(NEM), ...assign]);
    expect(await status(wrong)).not.toContain('IPSEC_ACTIVE');
  });

  it('group-lock demands user@group and strips the group before the AAA list', async () => {
    const hub = ['crypto map CMAP client authentication list XAUTH'];
    const plain = await lab(hub, ['key GROUPKEY', 'pool VPNPOOL', 'group-lock']);
    await run(plain.client, [...configureClient([...NEM, 'username alice password 0 alicepw']), ...assign]);
    expect(await status(plain)).not.toContain('IPSEC_ACTIVE');
    const locked = await lab(hub, ['key GROUPKEY', 'pool VPNPOOL', 'group-lock']);
    await run(locked.client, [...configureClient([...NEM, 'username alice@VPNGROUP password 0 alicepw']), ...assign]);
    expect(await status(locked)).toContain('IPSEC_ACTIVE');
    const other = await lab(hub, ['key GROUPKEY', 'pool VPNPOOL', 'group-lock']);
    await run(other.client, [...configureClient([...NEM, 'username alice@ELSEWHERE password 0 alicepw']), ...assign]);
    expect(await status(other)).not.toContain('IPSEC_ACTIVE');
  });

  it('the banner, configuration url and version, save-password and browser proxy reach the remote', async () => {
    const l = await lab(['crypto isakmp client configuration browser-proxy bproxy', 'proxy server 10.1.1.1:2000', 'proxy exception-list 10.2.2.*,www.*org', 'proxy by-pass-local', 'exit'], [
      'key GROUPKEY', 'pool VPNPOOL', 'banner Authorised users only', 'configuration url http://10.8.8.88/easy.cfg',
      'configuration version 10', 'save-password']);
    await run(l.hub, ['crypto isakmp client configuration group VPNGROUP', 'browser-proxy bproxy', 'exit']);
    await run(l.client, [...configureClient(NEM), ...assign]);
    const shown = await status(l);
    for (const text of ['Configuration URL: http://10.8.8.88/easy.cfg', 'Configuration Version: 10', 'Save Password: Allowed',
      'Browser Proxy: 10.1.1.1:2000', 'Browser Proxy Exception List: 10.2.2.*,www.*org', 'Browser Proxy By-pass Local: yes']) {
      expect(shown).toContain(text);
    }
    expect(await l.client.executeCommand('show logging')).toContain('Authorised users only');
  });

  it('without save-password the remote reports Disallowed', async () => {
    const l = await lab();
    await run(l.client, [...configureClient(NEM), ...assign]);
    expect(await status(l)).toContain('Save Password: Disallowed');
  });

  it('save-password: the password typed once is kept, so the next connection is unattended', async () => {
    const l = await lab(['crypto map CMAP client authentication list XAUTH'], ['key GROUPKEY', 'pool VPNPOOL', 'save-password']);
    await run(l.client, [...configureClient(NEM), ...assign]);
    expect(await status(l)).toContain('XAUTH_REQ');
    l.client._getOrCreateIPSecEngine().ezvpnClient.connect('EZ', { user: 'alice', password: 'alicepw' });
    expect(await status(l)).toContain('IPSEC_ACTIVE');
    await l.client.executeCommand('enable');
    await l.client.executeCommand('clear crypto ipsec client ezvpn');
    expect(await status(l)).toContain('IPSEC_ACTIVE');
    expect(await l.client.executeCommand('show running-config')).toContain(' username alice password 0 alicepw');
  });

  it('without save-password the interactive password is not kept', async () => {
    const l = await lab(['crypto map CMAP client authentication list XAUTH']);
    await run(l.client, [...configureClient(NEM), ...assign]);
    l.client._getOrCreateIPSecEngine().ezvpnClient.connect('EZ', { user: 'alice', password: 'alicepw' });
    await l.client.executeCommand('enable');
    await l.client.executeCommand('clear crypto ipsec client ezvpn');
    expect(await status(l)).toContain('XAUTH_REQ');
  });

  it('backup gateways pushed by the group join the failover list', async () => {
    const l = await lab([], ['key GROUPKEY', 'pool VPNPOOL', 'backup-gateway 10.0.77.1', 'backup-gateway gw2.lab']);
    await run(l.client, [...configureClient(NEM), ...assign]);
    expect(l.client._getOrCreateIPSecEngine().ezvpnClient.runtimeOf('EZ').pushedBackups).toEqual(['10.0.77.1', 'gw2.lab']);
  });

  it('include-local-lan keeps traffic to the outside subnet out of the tunnel', async () => {
    const withLan = await lab([], ['key GROUPKEY', 'pool VPNPOOL', 'include-local-lan']);
    await run(withLan.client, [...configureClient(), ...assign]);
    const without = await lab();
    await run(without.client, [...configureClient(), ...assign]);
    const packet = (l: typeof withLan): IPv4Packet => ({
      sourceIP: new IPAddress(l.client._getOrCreateIPSecEngine().ezvpnClient.runtimeOf('EZ').reply!.address),
      destinationIP: new IPAddress('10.0.12.3'), protocol: 1,
    } as unknown as IPv4Packet);
    expect(withLan.client._getOrCreateIPSecEngine().findMatchingCryptoEntry(packet(withLan), 'GigabitEthernet0/1')).toBeNull();
    expect(without.client._getOrCreateIPSecEngine().findMatchingCryptoEntry(packet(without), 'GigabitEthernet0/1')).not.toBeNull();
  });

  it('the new attributes are read back by the running-config; type-6 secrets are refused', async () => {
    const l = await lab(['crypto isakmp client configuration browser-proxy bproxy', 'proxy auto-detect', 'exit'], [
      'key GROUPKEY', 'pool VPNPOOL', 'banner Hello', 'configuration url http://x/y.cfg', 'configuration version 3',
      'backup-gateway 10.0.77.1', 'include-local-lan', 'save-password', 'group-lock', 'access-restrict GigabitEthernet0/1']);
    await run(l.hub, ['crypto isakmp client configuration group VPNGROUP', 'browser-proxy bproxy', 'exit']);
    const config = await l.hub.executeCommand('show running-config');
    for (const line of [' banner Hello', ' configuration url http://x/y.cfg', ' configuration version 3', ' backup-gateway 10.0.77.1',
      ' include-local-lan', ' save-password', ' group-lock', ' access-restrict GigabitEthernet0/1', ' browser-proxy bproxy',
      'crypto isakmp client configuration browser-proxy bproxy', ' proxy auto-detect']) expect(config).toContain(line);
    const refused = await run(l.client, ['crypto ipsec client ezvpn EZ', 'username alice password 6 JK_JHZPeJV', 'exit']);
    expect(refused.join('\n')).toContain('% Invalid input');
    const key6 = await run(l.hub, ['crypto isakmp client configuration group VPNGROUP', 'key 6 JK_JHZPeJV', 'exit']);
    expect(key6.join('\n')).toContain('% Invalid input');
  });
});
