import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPv6Address } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('ipconfig — IPv6 display', () => {
  it('basic ipconfig shows the link-local IPv6 address once IPv6 is enabled', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    await pc.executeCommand('netsh interface ipv6 add address "Ethernet 0" 2001:db8::10');
    const out = await pc.executeCommand('ipconfig');
    expect(out).toMatch(/Link-local IPv6 Address[ .]*: fe80::/);
  });

  it('basic ipconfig shows a configured global IPv6 address ahead of the link-local one', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    await pc.executeCommand('netsh interface ipv6 add address "Ethernet 0" 2001:db8::10');
    const out = await pc.executeCommand('ipconfig');
    const ipv6Idx = out.indexOf('IPv6 Address');
    const linkLocalIdx = out.indexOf('Link-local IPv6 Address');
    expect(ipv6Idx).toBeGreaterThan(-1);
    expect(linkLocalIdx).toBeGreaterThan(-1);
    expect(ipv6Idx).toBeLessThan(linkLocalIdx);
    expect(out).toContain('2001:db8::10');
  });

  it('ipconfig /all marks the preferred IPv6 addresses like real Windows', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    await pc.executeCommand('netsh interface ipv6 add address "Ethernet 0" 2001:db8::20/64');
    const out = await pc.executeCommand('ipconfig /all');
    expect(out).toMatch(/IPv6 Address[ .]*: 2001:db8::20\(Preferred\)/);
    expect(out).toMatch(/Link-local IPv6 Address[ .]*: fe80::[0-9a-f:]+%\S+\(Preferred\)/);
  });

  it('an adapter without IPv6 configured shows no IPv6 lines at all', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    const out = await pc.executeCommand('ipconfig');
    expect(out).not.toContain('IPv6');
  });

  it('a disconnected adapter shows Media disconnected and no IPv6 lines even if IPv6 was previously configured', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    await pc.executeCommand('netsh interface ipv6 add address "Ethernet 0" 2001:db8::10');
    await pc.executeCommand('netsh interface set interface "Ethernet 0" admin=disable');
    const out = await pc.executeCommand('ipconfig');
    expect(out).toContain('Media disconnected');
    expect(out).not.toContain('IPv6');
  });

  it('the IPv6 default gateway (router advertisement) is shown ahead of the IPv4 gateway', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    await pc.executeCommand('netsh interface ip set address "Ethernet 0" static 10.0.0.5 255.255.255.0 10.0.0.1');
    await pc.executeCommand('netsh interface ipv6 add address "Ethernet 0" 2001:db8::10');
    pc.setDefaultGateway6(new IPv6Address('fe80::abcd'));
    const out = await pc.executeCommand('ipconfig');
    const v6GwIdx = out.indexOf('fe80::abcd');
    const v4GwIdx = out.indexOf('10.0.0.1');
    expect(v6GwIdx).toBeGreaterThan(-1);
    expect(v4GwIdx).toBeGreaterThan(-1);
    expect(v6GwIdx).toBeLessThan(v4GwIdx);
  });

  it('removing the IPv6 address via netsh makes it disappear from ipconfig', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    await pc.executeCommand('netsh interface ipv6 add address "Ethernet 0" 2001:db8::10');
    let out = await pc.executeCommand('ipconfig');
    expect(out).toContain('2001:db8::10');

    await pc.executeCommand('netsh interface ipv6 delete address "Ethernet 0" 2001:db8::10');
    out = await pc.executeCommand('ipconfig');
    expect(out).not.toContain('2001:db8::10');
    // Link-local (auto-created when IPv6 was enabled) still stands.
    expect(out).toMatch(/Link-local IPv6 Address/);
  });

  it('netsh interface ipv6 show addresses reflects the exact same real Port state ipconfig reads', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    await pc.executeCommand('netsh interface ipv6 add address "Ethernet 0" 2001:db8::30/64');
    const netshOut = await pc.executeCommand('netsh interface ipv6 show addresses "Ethernet 0"');
    const ipconfigOut = await pc.executeCommand('ipconfig');
    expect(netshOut).toContain('2001:db8::30/64');
    expect(ipconfigOut).toContain('2001:db8::30');
  });

  it('deleting a non-existent IPv6 address reports failure without touching existing state', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    await pc.executeCommand('netsh interface ipv6 add address "Ethernet 0" 2001:db8::40');
    const out = await pc.executeCommand('netsh interface ipv6 delete address "Ethernet 0" 2001:db8::ffff');
    expect(out).toMatch(/does not exist/i);
    const stillThere = await pc.executeCommand('ipconfig');
    expect(stillThere).toContain('2001:db8::40');
  });
});
