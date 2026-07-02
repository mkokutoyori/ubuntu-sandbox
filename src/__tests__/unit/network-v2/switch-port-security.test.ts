/**
 * Port-Security enhancement tests.
 *
 * Covers:
 *   - Default off / enable / disable lifecycle
 *   - Maximum + dynamic learning
 *   - Violation modes: shutdown (err-disable), restrict (drop+count),
 *     protect (silent drop)
 *   - Sticky learning toggle and per-MAC sticky binding
 *   - Static MAC binding survives evaluation
 *   - Aging: absolute vs inactivity, agingStatic flag
 *   - Reactive: bus emits `port.security.violation`,
 *     `port.security.errdisable.set` / `.cleared`,
 *     `port.security.sticky-saved`, `port.security.mac-aged`
 *   - Switch absorbs the violation event into the snooping log
 *   - `errdisable recovery cause psecure-violation` triggers
 *     `_clearPsecErrDisable` manually (timer is real-time)
 *   - CLI: all `switchport port-security …` knobs parse, round-trip
 *     into running-config, and `show port-security {interface|address}`
 *     read live state.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { Port } from '@/network/hardware/Port';
import { MACAddress, ETHERTYPE_IPV4 } from '@/network/core/types';
import { EventBus } from '@/events/EventBus';

const MAC_A = 'aa:aa:aa:00:00:01';
const MAC_B = 'bb:bb:bb:00:00:02';
const MAC_C = 'cc:cc:cc:00:00:03';

function setupSwitch(bus?: EventBus): CiscoSwitch {
  const sw = new CiscoSwitch('sw-id', 'SW1', 8, 0, 0);
  if (bus) sw.setEventBus(bus);
  for (const name of sw.getPortNames()) sw.getPort(name)!.setUp(true);
  return sw;
}

/**
 * Build a minimal valid Ethernet frame, then deliver it through the
 * real Port.receiveFrame path so port-security runs end-to-end.
 */
function deliver(port: Port, srcMac: string, dstMac = 'ff:ff:ff:ff:ff:ff') {
  port.receiveFrame({
    srcMAC: new MACAddress(srcMac),
    dstMAC: new MACAddress(dstMac),
    etherType: ETHERTYPE_IPV4,
    payload: {},
  });
}

// ─── PortSecurity unit ────────────────────────────────────────────────

describe('PortSecurity — base semantics', () => {
  let sw: CiscoSwitch;
  let port: Port;
  beforeEach(() => {
    sw = setupSwitch();
    port = sw.getPort('FastEthernet0/1')!;
    port.getPortSecurity().enable();
  });

  it('learns dynamic MAC up to maximum, drops the next one', () => {
    const sec = port.getPortSecurity();
    sec.setMaxMACAddresses(2);

    deliver(port, MAC_A);
    deliver(port, MAC_B);
    deliver(port, MAC_C);

    expect(sec.getEntries().length).toBe(2);
    expect(sec.getViolationCount()).toBe(1);
    expect(port.getIsUp()).toBe(false); // default shutdown mode
  });

  it('restrict mode keeps the port up but counts the violation', () => {
    const sec = port.getPortSecurity();
    sec.setViolationMode('restrict');
    deliver(port, MAC_A);
    deliver(port, MAC_B);
    expect(port.getIsUp()).toBe(true);
    expect(sec.getViolationCount()).toBe(1);
  });

  it('protect mode is silent (no shutdown, still counted internally)', () => {
    const sec = port.getPortSecurity();
    sec.setViolationMode('protect');
    deliver(port, MAC_A);
    deliver(port, MAC_B);
    expect(port.getIsUp()).toBe(true);
    expect(sec.getViolationCount()).toBe(1);
  });

  it('static MAC counts toward the maximum and never ages', () => {
    const sec = port.getPortSecurity();
    sec.setMaxMACAddresses(1);
    sec.addStaticMAC(new MACAddress(MAC_A));
    deliver(port, MAC_B);
    expect(sec.getEntries().length).toBe(1);
    expect(sec.getEntries()[0].type).toBe('static');
  });
});

// ─── Sticky ───────────────────────────────────────────────────────────

describe('PortSecurity — sticky learning', () => {
  it('captures learned MACs as sticky and emits sticky-saved on the bus', () => {
    const bus = new EventBus();
    const sw = setupSwitch(bus);
    const port = sw.getPort('FastEthernet0/1')!;
    port.getPortSecurity().enable();
    port.getPortSecurity().enableSticky();

    const events: Array<{ portName: string; mac: MACAddress }> = [];
    bus.subscribe('port.security.sticky-saved', (e) => events.push(e.payload));

    deliver(port, MAC_A);

    expect(port.getPortSecurity().getEntries()[0].type).toBe('sticky');
    expect(events.length).toBe(1);
    expect(events[0].mac.toString().toLowerCase()).toBe(MAC_A);
  });

  it('disableSticky downgrades sticky entries back to dynamic', () => {
    const sw = setupSwitch();
    const port = sw.getPort('FastEthernet0/1')!;
    const sec = port.getPortSecurity();
    sec.enable();
    sec.enableSticky();
    deliver(port, MAC_A);
    sec.disableSticky();
    expect(sec.getEntries()[0].type).toBe('dynamic');
  });
});

// ─── Aging ────────────────────────────────────────────────────────────

describe('PortSecurity — aging', () => {
  it('absolute aging removes entries older than the window', () => {
    const sw = setupSwitch();
    const port = sw.getPort('FastEthernet0/1')!;
    const sec = port.getPortSecurity();
    sec.enable();
    sec.setAgingTimeMin(1); // 1 min window
    deliver(port, MAC_A);
    const entry = sec.getEntries()[0];
    // Trick the entry to be older than the window.
    entry.learnedAtMs = Date.now() - 2 * 60_000;
    entry.lastSeenMs = entry.learnedAtMs;
    const aged = sec.ageOut(Date.now());
    expect(aged.length).toBe(1);
    expect(sec.getEntries().length).toBe(0);
  });

  it('inactivity aging spares an entry whose lastSeen is recent', () => {
    const sw = setupSwitch();
    const port = sw.getPort('FastEthernet0/1')!;
    const sec = port.getPortSecurity();
    sec.enable();
    sec.setAgingTimeMin(1);
    sec.setAgingType('inactivity');
    deliver(port, MAC_A);
    const entry = sec.getEntries()[0];
    entry.learnedAtMs = Date.now() - 10 * 60_000;
    entry.lastSeenMs = Date.now() - 10_000; // 10 s ago — well within window
    const aged = sec.ageOut(Date.now());
    expect(aged.length).toBe(0);
  });

  it('static entries are exempt unless agingStatic is on', () => {
    const sw = setupSwitch();
    const port = sw.getPort('FastEthernet0/1')!;
    const sec = port.getPortSecurity();
    sec.enable();
    sec.setAgingTimeMin(1);
    sec.addStaticMAC(new MACAddress(MAC_A));
    const e = sec.getEntries()[0];
    e.learnedAtMs = Date.now() - 60 * 60_000;
    expect(sec.ageOut(Date.now()).length).toBe(0);
    sec.setAgingStatic(true);
    expect(sec.ageOut(Date.now()).length).toBe(1);
  });
});

// ─── Reactive Switch integration ──────────────────────────────────────

describe('PortSecurity — switch reactive integration', () => {
  it('Switch absorbs the violation into its snooping log', () => {
    const bus = new EventBus();
    const sw = setupSwitch(bus);
    const port = sw.getPort('FastEthernet0/1')!;
    port.getPortSecurity().enable();
    port.getPortSecurity().setMaxMACAddresses(1);

    deliver(port, MAC_A);
    deliver(port, MAC_B); // violation

    const log = sw._getSnoopingLog().join('\n');
    expect(log).toMatch(/%PORT_SECURITY-2-PSECURE_VIOLATION/);
    expect(log).toMatch(MAC_B);
    expect(sw._getPsecErrDisabledPorts().has('FastEthernet0/1')).toBe(true);
  });

  it('errdisable cleared manually brings the port back up', () => {
    const bus = new EventBus();
    const sw = setupSwitch(bus);
    const port = sw.getPort('FastEthernet0/1')!;
    port.getPortSecurity().enable();
    port.getPortSecurity().setMaxMACAddresses(1);

    deliver(port, MAC_A);
    deliver(port, MAC_B);
    expect(port.getIsUp()).toBe(false);

    const recovered: Array<{ portName: string }> = [];
    bus.subscribe('port.security.errdisable.cleared', (e) => recovered.push(e.payload));
    expect(sw._clearPsecErrDisable('FastEthernet0/1')).toBe(true);
    expect(recovered.length).toBe(1);
    expect(port.getIsUp()).toBe(true);
    expect(port.getPortSecurity().getViolationCount()).toBe(0);
  });

  it('sticky-saved event fires for newly learned sticky MACs', () => {
    const bus = new EventBus();
    const sw = setupSwitch(bus);
    const port = sw.getPort('FastEthernet0/1')!;
    port.getPortSecurity().enable();
    port.getPortSecurity().enableSticky();

    const events: Array<{ portName: string; mac: MACAddress }> = [];
    bus.subscribe('port.security.sticky-saved', (e) => events.push(e.payload));

    deliver(port, MAC_A);

    expect(events.length).toBe(1);
    expect(events[0].portName).toBe('FastEthernet0/1');
  });
});

// ─── Cisco CLI ────────────────────────────────────────────────────────

describe('PortSecurity — Cisco CLI', () => {
  it('configures port-security via CLI and round-trips through running-config', async () => {
    const sw = setupSwitch();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('switchport port-security');
    await sw.executeCommand('switchport port-security maximum 3');
    await sw.executeCommand('switchport port-security violation restrict');
    await sw.executeCommand('switchport port-security mac-address sticky');
    await sw.executeCommand('switchport port-security mac-address aaaa.bbbb.cccc');
    await sw.executeCommand('switchport port-security aging time 5');
    await sw.executeCommand('switchport port-security aging type inactivity');
    await sw.executeCommand('errdisable recovery cause psecure-violation' as never).catch(() => '');
    await sw.executeCommand('end');

    const sec = sw.getPort('FastEthernet0/1')!.getPortSecurity();
    expect(sec.isEnabled()).toBe(true);
    expect(sec.getMaxMACAddresses()).toBe(3);
    expect(sec.getViolationMode()).toBe('restrict');
    expect(sec.isStickyEnabled()).toBe(true);
    expect(sec.getAgingTimeMin()).toBe(5);
    expect(sec.getAgingType()).toBe('inactivity');
    expect(sec.getEntries().some(e => e.type === 'static')).toBe(true);

    const running = sw.getRunningConfig();
    expect(running).toMatch(/switchport port-security/);
    expect(running).toMatch(/switchport port-security maximum 3/);
    expect(running).toMatch(/switchport port-security violation restrict/);
    expect(running).toMatch(/switchport port-security mac-address sticky\n/);
    expect(running).toMatch(/switchport port-security mac-address aaaa\.bbbb\.cccc/);
    expect(running).toMatch(/switchport port-security aging time 5/);
    expect(running).toMatch(/switchport port-security aging type inactivity/);
  });

  it('show port-security interface reads live state', async () => {
    const sw = setupSwitch();
    const port = sw.getPort('FastEthernet0/1')!;
    port.getPortSecurity().enable();
    port.getPortSecurity().setMaxMACAddresses(2);
    port.getPortSecurity().setViolationMode('restrict');
    deliver(port, MAC_A);

    const out = await sw.executeCommand('show port-security interface FastEthernet0/1');
    expect(out).toMatch(/Port Security\s+:\s+Enabled/);
    expect(out).toMatch(/Violation Mode\s+:\s+Restrict/);
    expect(out).toMatch(/Maximum MAC Addresses\s+:\s+2/);
    expect(out).toMatch(/Total MAC Addresses\s+:\s+1/);
  });

  it('show port-security address lists all secured MACs', async () => {
    const sw = setupSwitch();
    const port = sw.getPort('FastEthernet0/1')!;
    port.getPortSecurity().enable();
    port.getPortSecurity().enableSticky();
    deliver(port, MAC_A);
    port.getPortSecurity().addStaticMAC(new MACAddress(MAC_B));

    const out = await sw.executeCommand('show port-security address');
    expect(out).toMatch(/Vlan\s+Mac Address/);
    expect(out).toMatch(/SecureSticky/);
    expect(out).toMatch(/SecureConfigured/);
    expect(out).toMatch(/Total Addresses: 2/);
  });

  it('clear port-security dynamic flushes dynamic entries but keeps sticky/static', async () => {
    const sw = setupSwitch();
    const port = sw.getPort('FastEthernet0/1')!;
    const sec = port.getPortSecurity();
    sec.enable();
    sec.addStaticMAC(new MACAddress(MAC_A));
    sec.addStickyMAC(new MACAddress(MAC_B));
    sec.setMaxMACAddresses(3);
    deliver(port, MAC_C); // dynamic

    await sw.executeCommand('enable');
    await sw.executeCommand('clear port-security dynamic interface FastEthernet0/1');

    const types = sec.getEntries().map(e => e.type).sort();
    expect(types).toEqual(['static', 'sticky']);
  });
});

// ─── End-to-end via Cable ─────────────────────────────────────────────

describe('PortSecurity — end-to-end via cable', () => {
  it('shuts the port down when the second MAC arrives across a cable', () => {
    const sw = setupSwitch();
    const portA = sw.getPort('FastEthernet0/1')!;
    const portB = new Port('peer', 'ethernet');
    portB.setUp(true);
    portA.getPortSecurity().enable();
    portA.getPortSecurity().setMaxMACAddresses(1);
    new Cable('c0').connect(portA, portB);

    portB.sendFrame({
      srcMAC: new MACAddress(MAC_A), dstMAC: new MACAddress('ff:ff:ff:ff:ff:ff'),
      etherType: ETHERTYPE_IPV4, payload: {},
    });
    portB.sendFrame({
      srcMAC: new MACAddress(MAC_B), dstMAC: new MACAddress('ff:ff:ff:ff:ff:ff'),
      etherType: ETHERTYPE_IPV4, payload: {},
    });

    expect(portA.getIsUp()).toBe(false);
    expect(portA.getPortSecurity().getViolationCount()).toBe(1);
  });
});
