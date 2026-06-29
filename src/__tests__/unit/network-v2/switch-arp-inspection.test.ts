/**
 * Tests for Dynamic ARP Inspection (DAI) on the L2 switch.
 *
 * Covers:
 *   - Pipeline pass / drop verdicts (engine semantics)
 *   - Trusted-port bypass
 *   - DHCP-snooping binding integration (spoofed sender-IP → drop)
 *   - ARP ACL permit / deny
 *   - Extra `validate src-mac` check (eth src != arp sender)
 *   - Rate limiting + err-disable + auto recovery
 *   - Switch's management ARP table is populated by snooping (`show arp`)
 *   - Reactive bus emissions for inspected / violation / err-disabled
 *   - Running-config round-trip persistence
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { LinuxPC } from '@/network/devices/LinuxPC';
import {
  MACAddress, IPAddress, ETHERTYPE_ARP, ARPPacket,
} from '@/network/core/types';
import { EventBus } from '@/events/EventBus';

// ─── Helpers ──────────────────────────────────────────────────────────

function makeArpFrame(
  ethSrc: string, ethDst: string,
  senderIp: string, senderMac: string,
  targetIp: string, targetMac: string,
  op: 'request' | 'reply' = 'request',
) {
  const arp: ARPPacket = {
    type: 'arp',
    operation: op,
    senderMAC: new MACAddress(senderMac),
    senderIP: new IPAddress(senderIp),
    targetMAC: new MACAddress(targetMac),
    targetIP: new IPAddress(targetIp),
  };
  return {
    srcMAC: new MACAddress(ethSrc),
    dstMAC: new MACAddress(ethDst),
    etherType: ETHERTYPE_ARP,
    payload: arp,
  };
}

function injectArp(sw: CiscoSwitch, port: string, frame: ReturnType<typeof makeArpFrame>) {
  // protected handleFrame is the canonical ingress for the L2 pipeline.
  (sw as unknown as { handleFrame: (p: string, f: ReturnType<typeof makeArpFrame>) => void }).handleFrame(port, frame);
}

function setupSwitch(bus?: EventBus) {
  const sw = new CiscoSwitch('sw-id', 'SW1', 8, 0, 0);
  if (bus) sw.setEventBus(bus);
  // Bring all ports up so handleFrame isn't gated by link state.
  for (const name of sw.getPortNames()) sw.getPort(name)!.setUp(true);
  return sw;
}

const HOST1_MAC = 'aa:aa:aa:00:00:01';
const HOST1_IP = '10.0.0.1';
const HOST2_MAC = 'bb:bb:bb:00:00:02';
const HOST2_IP = '10.0.0.2';
const VICTIM_MAC = 'cc:cc:cc:00:00:03';
const VICTIM_IP = '10.0.0.99';
const BCAST = 'ff:ff:ff:ff:ff:ff';

// ─── Engine semantics ─────────────────────────────────────────────────

describe('DAI — base semantics', () => {
  let bus: EventBus;
  let sw: CiscoSwitch;

  beforeEach(() => {
    bus = new EventBus();
    sw = setupSwitch(bus);
  });

  it('passes ARP frames when DAI is off on the VLAN (default)', () => {
    let dropped = 0;
    bus.subscribe('arp.inspected', (e) => { if (e.payload.verdict === 'drop') dropped++; });

    injectArp(sw, 'FastEthernet0/1',
      makeArpFrame(HOST1_MAC, BCAST, HOST1_IP, HOST1_MAC, VICTIM_IP, '00:00:00:00:00:00'));

    expect(dropped).toBe(0);
    expect(sw._getArpTableInternal().has(HOST1_IP)).toBe(true);
  });

  it('drops a spoofed ARP when DAI is on and no binding matches', () => {
    sw._getArpInspectionConfig().vlans.add(1);
    const events: Array<{ reason: string }> = [];
    bus.subscribe('arp.violation', (e) => events.push(e.payload));

    injectArp(sw, 'FastEthernet0/1',
      makeArpFrame(HOST2_MAC, BCAST, HOST1_IP, HOST2_MAC, VICTIM_IP, '00:00:00:00:00:00'));

    expect(events.length).toBe(1);
    expect(events[0].reason).toBe('binding-mismatch');
    expect(sw._getArpInspectionPortStats('FastEthernet0/1')!.dropped).toBe(1);
    expect(sw._getArpTableInternal().has(HOST1_IP)).toBe(false);
  });

  it('passes a legitimate ARP when the snooping binding matches', () => {
    const cfg = sw._getArpInspectionConfig();
    cfg.vlans.add(1);
    sw._getSnoopingBindings().push({
      macAddress: HOST1_MAC, ipAddress: HOST1_IP, lease: 86400,
      type: 'dhcp-snooping', vlan: 1, port: 'FastEthernet0/1',
    });

    injectArp(sw, 'FastEthernet0/1',
      makeArpFrame(HOST1_MAC, BCAST, HOST1_IP, HOST1_MAC, VICTIM_IP, '00:00:00:00:00:00'));

    const stats = sw._getArpInspectionPortStats('FastEthernet0/1')!;
    expect(stats.forwarded).toBe(1);
    expect(stats.dropped).toBe(0);
    expect(sw._getArpTableInternal().get(HOST1_IP)?.iface).toBe('FastEthernet0/1');
  });

  it('binding-port mismatch drops the frame (host moved to wrong port)', () => {
    const cfg = sw._getArpInspectionConfig();
    cfg.vlans.add(1);
    sw._getSnoopingBindings().push({
      macAddress: HOST1_MAC, ipAddress: HOST1_IP, lease: 86400,
      type: 'dhcp-snooping', vlan: 1, port: 'FastEthernet0/1',
    });

    injectArp(sw, 'FastEthernet0/2',
      makeArpFrame(HOST1_MAC, BCAST, HOST1_IP, HOST1_MAC, VICTIM_IP, '00:00:00:00:00:00'));

    expect(sw._getArpInspectionPortStats('FastEthernet0/2')!.droppedBindingMismatch).toBe(1);
  });
});

// ─── Trust port bypass ────────────────────────────────────────────────

describe('DAI — trusted ports', () => {
  it('bypasses inspection for trusted ports', () => {
    const sw = setupSwitch();
    const cfg = sw._getArpInspectionConfig();
    cfg.vlans.add(1);
    cfg.trustedPorts.add('FastEthernet0/1');

    injectArp(sw, 'FastEthernet0/1',
      makeArpFrame(HOST2_MAC, BCAST, HOST1_IP, HOST2_MAC, VICTIM_IP, '00:00:00:00:00:00'));

    const s = sw._getArpInspectionPortStats('FastEthernet0/1')!;
    expect(s.forwarded).toBe(1);
    expect(s.dropped).toBe(0);
  });
});

// ─── Extra validations ────────────────────────────────────────────────

describe('DAI — extra validations', () => {
  it('validate src-mac drops when eth-src != arp sender-mac', () => {
    const sw = setupSwitch();
    const cfg = sw._getArpInspectionConfig();
    cfg.vlans.add(1);
    cfg.validate.srcMac = true;
    sw._getSnoopingBindings().push({
      macAddress: HOST1_MAC, ipAddress: HOST1_IP, lease: 86400,
      type: 'dhcp-snooping', vlan: 1, port: 'FastEthernet0/1',
    });

    injectArp(sw, 'FastEthernet0/1',
      makeArpFrame(HOST2_MAC, BCAST, HOST1_IP, HOST1_MAC, VICTIM_IP, '00:00:00:00:00:00'));

    expect(sw._getArpInspectionPortStats('FastEthernet0/1')!.droppedSrcMacMismatch).toBe(1);
  });

  it('validate ip drops 0.0.0.0 sender (probe addresses are filtered)', () => {
    const sw = setupSwitch();
    const cfg = sw._getArpInspectionConfig();
    cfg.vlans.add(1);
    cfg.validate.ip = true;

    injectArp(sw, 'FastEthernet0/1',
      makeArpFrame(HOST1_MAC, BCAST, '0.0.0.0', HOST1_MAC, VICTIM_IP, '00:00:00:00:00:00'));

    expect(sw._getArpInspectionPortStats('FastEthernet0/1')!.droppedInvalidIp).toBe(1);
  });
});

// ─── ARP ACL ──────────────────────────────────────────────────────────

describe('DAI — ARP ACL filter', () => {
  it('permit clause is honoured before DHCP bindings (static mode)', () => {
    const sw = setupSwitch();
    const cfg = sw._getArpInspectionConfig();
    cfg.vlans.add(1);
    cfg.vlanAclFilters.set(1, { aclName: 'HOSTS', staticMode: true });
    sw._getArpAccessLists().set('HOSTS', {
      name: 'HOSTS',
      entries: [
        { action: 'permit', senderIp: HOST1_IP, senderMac: HOST1_MAC, raw: `permit ip host ${HOST1_IP} mac host ${HOST1_MAC}` },
      ],
    });

    injectArp(sw, 'FastEthernet0/1',
      makeArpFrame(HOST1_MAC, BCAST, HOST1_IP, HOST1_MAC, VICTIM_IP, '00:00:00:00:00:00'));
    expect(sw._getArpInspectionPortStats('FastEthernet0/1')!.forwarded).toBe(1);

    injectArp(sw, 'FastEthernet0/2',
      makeArpFrame(HOST2_MAC, BCAST, HOST2_IP, HOST2_MAC, VICTIM_IP, '00:00:00:00:00:00'));
    expect(sw._getArpInspectionPortStats('FastEthernet0/2')!.droppedAclDeny).toBe(1);
  });
});

// ─── Rate limit + err-disable + recovery ──────────────────────────────

describe('DAI — rate limit + err-disable', () => {
  it('err-disables the port when rate exceeds the limit', () => {
    const bus = new EventBus();
    const sw = setupSwitch(bus);
    const cfg = sw._getArpInspectionConfig();
    cfg.vlans.add(1);
    cfg.rateLimits.set('FastEthernet0/1', 2);

    const errd: Array<{ port: string }> = [];
    bus.subscribe('arp.errdisable.set', (e) => errd.push(e.payload));

    for (let i = 0; i < 5; i++) {
      injectArp(sw, 'FastEthernet0/1',
        makeArpFrame(HOST1_MAC, BCAST, HOST1_IP, HOST1_MAC, VICTIM_IP, '00:00:00:00:00:00'));
    }

    expect(errd.length).toBe(1);
    expect(errd[0].port).toBe('FastEthernet0/1');
    expect(sw.getPort('FastEthernet0/1')!.getIsUp()).toBe(false);
    expect(sw._getArpInspectionPortStats('FastEthernet0/1')!.droppedRateLimit).toBeGreaterThan(0);
  });

  it('clears err-disable explicitly and brings the port back up', () => {
    const bus = new EventBus();
    const sw = setupSwitch(bus);
    const cfg = sw._getArpInspectionConfig();
    cfg.vlans.add(1);
    cfg.rateLimits.set('FastEthernet0/1', 1);

    for (let i = 0; i < 5; i++) {
      injectArp(sw, 'FastEthernet0/1',
        makeArpFrame(HOST1_MAC, BCAST, HOST1_IP, HOST1_MAC, VICTIM_IP, '00:00:00:00:00:00'));
    }
    expect(sw.getPort('FastEthernet0/1')!.getIsUp()).toBe(false);

    const recovered: Array<{ port: string }> = [];
    bus.subscribe('arp.errdisable.cleared', (e) => recovered.push(e.payload));
    expect(sw._clearArpInspectionErrDisable('FastEthernet0/1')).toBe(true);
    expect(recovered.length).toBe(1);
    expect(sw.getPort('FastEthernet0/1')!.getIsUp()).toBe(true);
  });
});

// ─── Reactive: snoop-learned ──────────────────────────────────────────

describe('DAI — management ARP snoop-learn', () => {
  it('populates the management ARP table when a passed ARP is observed', () => {
    const bus = new EventBus();
    const sw = setupSwitch(bus);
    const learned: Array<{ ip: string; mac: string; vlan: number }> = [];
    bus.subscribe('arp.snoop.learned', (e) => learned.push(e.payload));

    injectArp(sw, 'FastEthernet0/1',
      makeArpFrame(HOST1_MAC, BCAST, HOST1_IP, HOST1_MAC, VICTIM_IP, '00:00:00:00:00:00'));

    expect(learned.length).toBe(1);
    expect(learned[0]).toMatchObject({ ip: HOST1_IP, mac: HOST1_MAC, vlan: 1 });
    const arp = sw._getArpTableInternal().get(HOST1_IP)!;
    expect(arp.mac.toString().toLowerCase()).toBe(HOST1_MAC);
    expect(arp.iface).toBe('FastEthernet0/1');
    expect(arp.type).toBe('dynamic');
  });

  it('never overwrites a static management ARP entry', () => {
    const sw = setupSwitch();
    sw._addStaticARP(new IPAddress(HOST1_IP), new MACAddress(VICTIM_MAC), 'FastEthernet0/3');

    injectArp(sw, 'FastEthernet0/1',
      makeArpFrame(HOST1_MAC, BCAST, HOST1_IP, HOST1_MAC, VICTIM_IP, '00:00:00:00:00:00'));

    const arp = sw._getArpTableInternal().get(HOST1_IP)!;
    expect(arp.type).toBe('static');
    expect(arp.mac.toString().toLowerCase()).toBe(VICTIM_MAC);
  });
});

// ─── CLI integration ──────────────────────────────────────────────────

describe('DAI — Cisco CLI', () => {
  it('configures DAI through running-config and round-trips', async () => {
    const sw = setupSwitch();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('ip arp inspection vlan 10,20');
    await sw.executeCommand('ip arp inspection validate src-mac ip');
    await sw.executeCommand('errdisable recovery cause arp-inspection');
    await sw.executeCommand('errdisable recovery interval 60');
    await sw.executeCommand('arp access-list HOSTS');
    await sw.executeCommand('permit ip host 10.0.0.1 mac host aa:aa:aa:00:00:01');
    await sw.executeCommand('exit');
    await sw.executeCommand('ip arp inspection filter HOSTS vlan 10 static');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('ip arp inspection trust');
    await sw.executeCommand('interface FastEthernet0/2');
    await sw.executeCommand('ip arp inspection limit rate 20');
    await sw.executeCommand('end');

    const cfg = sw._getArpInspectionConfig();
    expect(cfg.vlans.has(10)).toBe(true);
    expect(cfg.vlans.has(20)).toBe(true);
    expect(cfg.validate.srcMac).toBe(true);
    expect(cfg.validate.ip).toBe(true);
    expect(cfg.errDisableRecoverySec).toBe(60);
    expect(cfg.trustedPorts.has('FastEthernet0/1')).toBe(true);
    expect(cfg.rateLimits.get('FastEthernet0/2')).toBe(20);
    expect(cfg.vlanAclFilters.get(10)?.aclName).toBe('HOSTS');
    expect(cfg.vlanAclFilters.get(10)?.staticMode).toBe(true);

    const running = sw.getRunningConfig();
    expect(running).toMatch(/ip arp inspection vlan 10,20/);
    expect(running).toMatch(/ip arp inspection validate src-mac ip/);
    expect(running).toMatch(/arp access-list HOSTS/);
    expect(running).toMatch(/ permit ip host 10\.0\.0\.1 mac host aa:aa:aa:00:00:01/);
    expect(running).toMatch(/ip arp inspection filter HOSTS vlan 10 static/);
    expect(running).toMatch(/errdisable recovery interval 60/);
    expect(running).toMatch(/ ip arp inspection trust/);
    expect(running).toMatch(/ ip arp inspection limit rate 20/);
  });

  it('show ip arp inspection reports per-VLAN state', async () => {
    const sw = setupSwitch();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('ip arp inspection vlan 10');
    await sw.executeCommand('end');
    const out = await sw.executeCommand('show ip arp inspection');
    expect(out).toMatch(/Source Mac Validation\s+:\s+Disabled/);
    expect(out).toMatch(/ 10\s+Enabled\s+Active/);
  });

  it('show ip arp inspection statistics aggregates counters', async () => {
    const sw = setupSwitch();
    sw._getArpInspectionConfig().vlans.add(1);

    injectArp(sw, 'FastEthernet0/1',
      makeArpFrame(HOST2_MAC, BCAST, HOST1_IP, HOST2_MAC, VICTIM_IP, '00:00:00:00:00:00'));

    const out = await sw.executeCommand('show ip arp inspection statistics');
    expect(out).toMatch(/Interface/);
    expect(out).toMatch(/Fa0\/1/);
  });
});

// ─── End-to-end through a real frame path ─────────────────────────────

describe('DAI — end-to-end with LinuxPC', () => {
  it('legitimate ping populates the switch management ARP table via snooping', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    const pc2 = new LinuxPC('PC2', 0, 0);
    const sw = setupSwitch();
    new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

    await pc1.executeCommand('ping -c 1 10.0.0.2');

    const table = sw._getArpTableInternal();
    expect(table.has('10.0.0.1')).toBe(true);
    expect(table.has('10.0.0.2')).toBe(true);
  });
});
