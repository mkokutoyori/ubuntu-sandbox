/**
 * CDP (Cisco Discovery Protocol) — protocol-level tests.
 *
 * Validates the real protocol engine, not just the cable-graph fake:
 *   - Bidirectional discovery across a Cable (Router↔Router and
 *     Switch↔Switch) through real `port.link.up`-driven advertising
 *   - `no cdp run` flushes the local table and stops advertising;
 *     `cdp run` re-emits and restores discovery in the same tick
 *   - `no cdp enable` on an interface expires that port's neighbours
 *   - Per-port disable persists into running-config and is read back by
 *     `show cdp interface`
 *   - `cdp timer N` / `cdp holdtime N` knobs are reflected by `show cdp`
 *     and persist into running-config
 *   - `port.link.down` synthetically expires the peer with cause
 *     `link-down`
 *   - Reactive bus topics fire (`cdp.frame.sent`, `cdp.neighbor.*`)
 *   - CDP frames never leak through a Switch (no flood, no MAC learn)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { CDP_MULTICAST_MAC, ETHERTYPE_CDP } from '@/network/cdp/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

// ─── Discovery across a cable ─────────────────────────────────────────

describe('CDP — bidirectional discovery', () => {
  it('two routers cabled together discover each other synchronously', () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    new Cable('w').connect(r1.getPort('GigabitEthernet0/1')!,
                            r2.getPort('GigabitEthernet0/1')!);

    const n1 = r1.getCdpAgent().getNeighbors();
    const n2 = r2.getCdpAgent().getNeighbors();
    expect(n1.length).toBe(1);
    expect(n1[0].remoteHost).toBe('R2');
    expect(n1[0].remotePort).toBe('GigabitEthernet0/1');
    expect(n1[0].remoteCapability).toBe('Router');
    expect(n2.length).toBe(1);
    expect(n2[0].remoteHost).toBe('R1');
  });

  it('two switches cabled together discover each other', () => {
    const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    new Cable('w').connect(sw1.getPort('FastEthernet0/0')!,
                            sw2.getPort('FastEthernet0/0')!);
    expect(sw1.getCdpAgent().getNeighbors()[0]?.remoteHost).toBe('SW2');
    expect(sw2.getCdpAgent().getNeighbors()[0]?.remoteHost).toBe('SW1');
  });

  it('a LinuxPC peer does not speak CDP — the agent learns nothing for it', () => {
    const r1 = new CiscoRouter('R1');
    const pc = new LinuxPC('linux-pc', 'L1', 0, 0);
    new Cable('w').connect(r1.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    const learnt = r1.getCdpAgent().getNeighbors();
    expect(learnt.length).toBe(0);
  });
});

// ─── Reactive: enable / disable / link-down ──────────────────────────

describe('CDP — enable / disable lifecycle', () => {
  it('no cdp run flushes the table and stops responding; cdp run restores it', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    new Cable('w').connect(r1.getPort('GigabitEthernet0/1')!,
                            r2.getPort('GigabitEthernet0/1')!);

    expect(r1.getCdpAgent().getNeighbors().length).toBe(1);

    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('no cdp run');
    await r1.executeCommand('end');

    expect(r1.getCdpAgent().getNeighbors().length).toBe(0);
    expect(r1.getCdpAgent().getConfig().enabled).toBe(false);

    await r1.executeCommand('configure terminal');
    await r1.executeCommand('cdp run');
    await r1.executeCommand('end');
    // Re-enable advertises; peer's reply (advertise-back on first
    // contact) is processed synchronously → table is repopulated.
    expect(r1.getCdpAgent().getConfig().enabled).toBe(true);
    expect(r1.getCdpAgent().getNeighbors().some(n => n.remoteHost === 'R2')).toBe(true);
  });

  it('no cdp enable on an interface flushes neighbours learned on that port', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    new Cable('w').connect(r1.getPort('GigabitEthernet0/1')!,
                            r2.getPort('GigabitEthernet0/1')!);
    expect(r1.getCdpAgent().getNeighbors().length).toBe(1);

    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/1');
    await r1.executeCommand('no cdp enable');
    await r1.executeCommand('end');

    expect(r1.getCdpAgent().getNeighbors().length).toBe(0);
    expect(r1.getCdpAgent().isPortEnabled('GigabitEthernet0/1')).toBe(false);
  });

  it('port.link.down on a port expires its neighbour with cause "link-down"', () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const cable = new Cable('w');
    cable.connect(r1.getPort('GigabitEthernet0/1')!,
                  r2.getPort('GigabitEthernet0/1')!);

    expect(r1.getCdpAgent().getNeighbors().length).toBe(1);

    const events: Array<{ cause: string; remoteHost: string }> = [];
    // Use the default bus — agents subscribed there at construction.
    // We need to subscribe on the bus the agent uses; the routers use
    // the default bus by default.
    // To capture events, re-bind via setEventBus on both devices.
    const bus = new EventBus();
    r1.setEventBus(bus);
    r2.setEventBus(bus);
    bus.subscribe('cdp.neighbor.expired', (e) => events.push(e.payload));

    // The setEventBus restart re-installed agents → caches were flushed.
    // Reconnect: bringing port down then up cleanly fires the event.
    r1.getPort('GigabitEthernet0/1')!.setUp(false);

    expect(events.some(e => e.cause === 'link-down')).toBe(true);
  });
});

// ─── Bus topics ──────────────────────────────────────────────────────

describe('CDP — reactive events', () => {
  it('fires frame.sent / neighbor.discovered when a cable is connected', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    r1.setEventBus(bus);
    r2.setEventBus(bus);

    const sent: Array<{ port: string; reason: string }> = [];
    const found: Array<{ remoteHost: string }> = [];
    bus.subscribe('cdp.frame.sent', (e) => sent.push(e.payload));
    bus.subscribe('cdp.neighbor.discovered', (e) => found.push(e.payload));

    new Cable('w').connect(r1.getPort('GigabitEthernet0/1')!,
                            r2.getPort('GigabitEthernet0/1')!);

    expect(sent.some(s => s.reason === 'link-up')).toBe(true);
    expect(found.some(f => f.remoteHost === 'R2')).toBe(true);
    expect(found.some(f => f.remoteHost === 'R1')).toBe(true);
  });
});

// ─── L2 isolation through a Switch ───────────────────────────────────

describe('CDP — frame is link-local (never crosses a switch)', () => {
  it('CDP frames are consumed at the switch and not flooded', () => {
    // Topology:  R1 ─ SW ─ R2
    // R1 cables into SW.Fa0/0; R2 cables into SW.Fa0/1. SW must NOT
    // forward CDP between them. Real switches consume the multicast
    // 01:00:0c:cc:cc:cc and treat the protocol as terminating.
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!,
                           sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!,
                           sw.getPort('FastEthernet0/1')!);

    // SW sees both routers as neighbours (one per port).
    const swNbrs = sw.getCdpAgent().getNeighbors();
    expect(swNbrs.length).toBe(2);

    // R1 sees SW (not R2 — the switch did not forward CDP).
    const r1Nbrs = r1.getCdpAgent().getNeighbors();
    expect(r1Nbrs.length).toBe(1);
    expect(r1Nbrs[0].remoteHost).toBe('SW');
  });

  it('CDP frames use the reserved multicast MAC and CDP ethertype', () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const bus = new EventBus();
    r1.setEventBus(bus);
    r2.setEventBus(bus);

    let inspected: { srcMAC: string; dstMAC: string; etherType: number } | null = null;
    bus.subscribe('cable.frame.delivered', (e) => {
      if (e.payload.frame.etherType === ETHERTYPE_CDP) {
        inspected = {
          srcMAC: e.payload.frame.srcMAC.toString().toLowerCase(),
          dstMAC: e.payload.frame.dstMAC.toString().toLowerCase(),
          etherType: e.payload.frame.etherType,
        };
      }
    });
    const cable = new Cable('w');
    cable.setEventBus(bus);
    cable.connect(r1.getPort('GigabitEthernet0/1')!,
                  r2.getPort('GigabitEthernet0/1')!);

    expect(inspected).not.toBeNull();
    expect(inspected!.dstMAC).toBe(CDP_MULTICAST_MAC);
    expect(inspected!.etherType).toBe(ETHERTYPE_CDP);
  });
});

// ─── CLI ──────────────────────────────────────────────────────────────

describe('CDP — Cisco CLI', () => {
  it('cdp timer / cdp holdtime mutate the agent and round-trip into running-config', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('cdp timer 30');
    await sw.executeCommand('cdp holdtime 90');
    await sw.executeCommand('end');

    expect(sw.getCdpAgent().getConfig().timerSec).toBe(30);
    expect(sw.getCdpAgent().getConfig().holdtimeSec).toBe(90);

    const running = sw.getRunningConfig();
    expect(running).toMatch(/cdp timer 30/);
    expect(running).toMatch(/cdp holdtime 90/);

    // show cdp reflects the same values.
    const show = await sw.executeCommand('show cdp');
    expect(show).toMatch(/Sending CDP packets every 30 seconds/);
    expect(show).toMatch(/holdtime value of 90 seconds/);
  });

  it('no cdp enable per-interface persists into running-config', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    await sw.executeCommand('no cdp enable');
    await sw.executeCommand('end');

    expect(sw.getCdpAgent().isPortEnabled('FastEthernet0/0')).toBe(false);
    const out = await sw.executeCommand('show running-config interface FastEthernet0/0');
    expect(out).toMatch(/no cdp enable/);
  });

  it('show cdp interface omits ports where CDP is administratively disabled', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    await sw.executeCommand('no cdp enable');
    await sw.executeCommand('end');

    const out = await sw.executeCommand('show cdp interface');
    expect(out).not.toMatch(/FastEthernet0\/0 is/);
    expect(out).toMatch(/FastEthernet0\/1 is/);
  });
});

// ─── Detail view ──────────────────────────────────────────────────────

describe('CDP — show cdp neighbors detail', () => {
  it('detail view reports platform + capability + interface', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    new Cable('w').connect(r1.getPort('GigabitEthernet0/1')!,
                            r2.getPort('GigabitEthernet0/1')!);
    await r1.executeCommand('enable');
    const out = await r1.executeCommand('show cdp neighbors detail');
    expect(out).toMatch(/Device ID: R2/);
    expect(out).toMatch(/Platform: Cisco 2911/);
    expect(out).toMatch(/Interface: GigabitEthernet0\/1/);
  });
});
