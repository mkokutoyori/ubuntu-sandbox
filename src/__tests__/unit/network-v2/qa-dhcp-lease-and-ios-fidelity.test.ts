/**
 * Defects raised by the DHCP/IOS QA pass, each pinned against what the real
 * thing does:
 *
 *   - a Windows client shows the gateway it was just given, and gives it
 *     back when the lease stops carrying one (APIPA has no gateway);
 *   - ISC's client asks for the address it already holds instead of
 *     starting over at DISCOVER, and its lease database and the interface
 *     never tell two different stories;
 *   - `default-router` follows the IOS grammar (up to eight addresses, each
 *     a usable host address) instead of accepting anything and keeping one;
 *   - running-config lists the exclusions ahead of the pools;
 *   - the console shows %LINK/%LINEPROTO, and an operator `shutdown` is
 *     reported as administratively down.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { CiscoTerminalSession } from '@/terminal/sessions';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function settle(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) { await Promise.resolve(); await tick(); }
}

async function lab() {
  const r = new CiscoRouter('R1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const win = new WindowsPC('windows-pc', 'WIN', 0, 0);
  const lin = new LinuxPC('linux-pc', 'LIN', 0, 0);
  new Cable('c1').connect(r.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(win.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(lin.getPorts()[0], sw.getPorts()[2]);
  const [g0] = r.getPortNames();
  for (const c of [
    'enable', 'configure terminal',
    'ip dhcp excluded-address 192.168.1.1 192.168.1.10',
    'ip dhcp pool LAN',
    'network 192.168.1.0 255.255.255.0',
    'default-router 192.168.1.1',
    'dns-server 8.8.8.8',
    'exit',
    `interface ${g0}`, 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'end',
  ]) await r.executeCommand(c);
  return { r, win, lin, g0 };
}

/** Take the DHCP server off the air without touching the clients. */
async function killServer(r: CiscoRouter, g0: string): Promise<void> {
  for (const c of [
    'enable', 'configure terminal', 'no service dhcp',
    `interface ${g0}`, 'shutdown', 'end',
  ]) await r.executeCommand(c);
}

describe('a Windows client and its default gateway', () => {
  it('`ipconfig /renew` shows the gateway of the lease it just took', async () => {
    const { win } = await lab();
    const out = await win.executeCommand('ipconfig /renew');
    expect(
      out,
      'the adapter is re-displayed after the lease is taken, so it must show the new gateway',
    ).toMatch(/Default Gateway[ .]*: 192\.168\.1\.1/);
  }, 30000);

  it('falling back to APIPA takes the gateway away', async () => {
    const { win, r, g0 } = await lab();
    await win.executeCommand('ipconfig /renew');
    expect(win.getDefaultGatewayString()).toBe('192.168.1.1');
    await killServer(r, g0);
    await win.executeCommand('ipconfig /release');

    const out = await win.executeCommand('ipconfig /renew');
    expect(out).toMatch(/autoconfiguration IP address 169\.254\./);
    expect(
      win.getDefaultGatewayString(),
      'a link-local host has no route off the link — it cannot keep a gateway',
    ).toBeNull();
    expect(await win.executeCommand('ipconfig')).not.toMatch(/Default Gateway[ .]*: 192\.168\.1\.1/);
  }, 30000);

  it('a gateway the operator set by hand is not the DHCP client s to remove', async () => {
    const { win, r, g0 } = await lab();
    win.setDefaultGateway(new (await import('@/network/core/types')).IPAddress('10.9.9.9'));
    await killServer(r, g0);
    await win.executeCommand('ipconfig /renew');
    expect(win.getDefaultGatewayString()).toBe('10.9.9.9');
  }, 30000);
});

describe('the Linux client and its lease database', () => {
  it('a second run asks for the address it holds instead of starting over', async () => {
    const { lin } = await lab();
    expect(await lin.executeCommand('dhclient -v eth0')).toMatch(/DHCPDISCOVER/);

    const again = await lin.executeCommand('dhclient -v eth0');
    expect(again, 'a held lease is renewed, not rediscovered').toMatch(/DHCPREQUEST for 192\.168\.1\.11/);
    expect(again).not.toMatch(/DHCPDISCOVER/);
  }, 30000);

  it('with the server gone, a lease that is still valid stays in service', async () => {
    const { lin, r, g0 } = await lab();
    await lin.executeCommand('dhclient -v eth0');
    await killServer(r, g0);

    const out = await lin.executeCommand('dhclient -v eth0');
    expect(out).toMatch(/No DHCPOFFERS received\./);
    expect(
      out,
      'the database still holds an unexpired lease — that is what the client uses',
    ).toMatch(/Trying recorded lease 192\.168\.1\.11/);
    expect(out).not.toMatch(/No working leases/);
    expect(
      await lin.executeCommand('ip -4 addr show eth0'),
      'the client says it is bound, so the address has to be there',
    ).toMatch(/inet 192\.168\.1\.11/);
  }, 30000);

  it('with no lease left, the interface is not left holding an address', async () => {
    const { lin, r, g0 } = await lab();
    await lin.executeCommand('dhclient -v eth0');
    await lin.executeCommand('dhclient -r eth0');
    await killServer(r, g0);

    const out = await lin.executeCommand('dhclient -v eth0');
    expect(out).toMatch(/No working leases in persistent database/);
    expect(
      await lin.executeCommand('ip -4 addr show eth0'),
      'no lease means no address — the two must not disagree',
    ).not.toMatch(/inet 192\.168\.1\./);
  }, 30000);
});

describe('`default-router` follows the IOS grammar', () => {
  async function pool() {
    const { r } = await lab();
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip dhcp pool P2');
    return r;
  }

  it('takes several addresses and keeps every one of them', async () => {
    const r = await pool();
    expect(await r.executeCommand('default-router 192.168.1.1 192.168.1.2')).toBe('');
    await r.executeCommand('end');
    expect(
      await r.executeCommand('show running-config'),
      'a command that was accepted must be shown back as it was typed',
    ).toMatch(/default-router 192\.168\.1\.1 192\.168\.1\.2/);
  }, 30000);

  it('refuses a mask, a name, and a ninth address', async () => {
    const r = await pool();
    for (const bad of [
      'default-router 192.168.1.1 255.255.255.0',
      'default-router 255.255.255.0',
      'default-router notanip',
      'default-router 224.0.0.1',
      'default-router 1.1.1.1 2.2.2.2 3.3.3.3 4.4.4.4 5.5.5.5 6.6.6.6 7.7.7.7 8.8.8.8 9.9.9.9',
    ]) {
      expect(await r.executeCommand(bad), bad).toContain("% Invalid input detected at '^' marker.");
    }
  }, 30000);

  it('a refused command leaves nothing behind in the configuration', async () => {
    const r = await pool();
    await r.executeCommand('default-router 192.168.1.1 255.255.255.0');
    await r.executeCommand('end');
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).not.toMatch(/default-router 192\.168\.1\.1 255\.255\.255\.0/);
    expect(
      cfg.split('ip dhcp pool P2')[1] ?? '',
      'nothing was accepted, so nothing may be rewritten into the pool either',
    ).not.toMatch(/default-router/);
  }, 30000);
});

describe('running-config and console messages', () => {
  it('exclusions come before the pools they carve out of', async () => {
    const { r } = await lab();
    const cfg = await r.executeCommand('show running-config');
    expect(cfg.indexOf('ip dhcp excluded-address')).toBeGreaterThan(-1);
    expect(cfg.indexOf('ip dhcp excluded-address')).toBeLessThan(cfg.indexOf('ip dhcp pool'));
  }, 30000);

  it('the console reports the interface going down and back up', async () => {
    const { r, g0 } = await lab();
    const term = new CiscoTerminalSession('t1', r);
    await term.init?.();
    for (const c of ['enable', 'configure terminal', `interface ${g0}`, 'shutdown', 'no shutdown', 'end']) {
      await r.executeCommand(c);
    }
    await settle();

    // La configuration d'usine horodate : la ligne ne COMMENCE plus par
    // `%`, elle le contient après sa date.
    const console = term.lines.map((l) => l.text).filter((t) => t.includes('%')).join('\n');
    expect(
      console,
      'an operator shutdown is %LINK-5-CHANGED administratively down, not a carrier loss',
    ).toContain(`%LINK-5-CHANGED: Interface ${g0}, changed state to administratively down`);
    expect(console).toContain(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${g0}, changed state to down`);
    expect(console).toContain(`%LINK-3-UPDOWN: Interface ${g0}, changed state to up`);
    expect(console).toContain(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${g0}, changed state to up`);
  }, 30000);
});
