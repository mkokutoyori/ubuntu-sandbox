/**
 * Host lifecycle & power — unit tests.
 *
 * Covers the second vertical of the host-management model:
 *   - the HostLifecycle power/boot state machine and its guarded transitions
 *   - live uptime derived from the boot clock
 *   - the host.lifecycle.transitioned event stream
 *   - integration: powerOff/powerOn drive the lifecycle, `uptime` / `w`
 *     track it on Linux, and Windows `systeminfo` reports the boot time
 */

import { describe, it, expect } from 'vitest';
import { HostLifecycle } from '@/network/devices/host/lifecycle';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EventBus } from '@/events/EventBus';
import type { DomainEvent } from '@/events/types';

// ═══════════════════════════════════════════════════════════════════
// HostLifecycle state machine
// ═══════════════════════════════════════════════════════════════════

describe('HostLifecycle', () => {
  it('starts running, as a simulated host comes up already booted', () => {
    const lc = new HostLifecycle(1_000);
    expect(lc.getState()).toBe('running');
    expect(lc.isRunning()).toBe(true);
    expect(lc.isPoweredOn()).toBe(true);
    expect(lc.bootCountValue).toBe(1);
  });

  it('derives live uptime from the boot clock', () => {
    const lc = new HostLifecycle(1_000);
    expect(lc.uptimeSeconds(1_000 + 5_000)).toBe(5);
    expect(lc.uptimeMinutes(1_000 + 125_000)).toBe(2);
  });

  it('reports zero uptime once powered off', () => {
    const lc = new HostLifecycle(1_000);
    lc.powerOff(2_000);
    expect(lc.getState()).toBe('off');
    expect(lc.isPoweredOn()).toBe(false);
    expect(lc.uptimeSeconds(9_999)).toBe(0);
    expect(lc.bootedAt()).toBeNull();
  });

  it('powers back on with a fresh boot clock and an incremented boot count', () => {
    const lc = new HostLifecycle(1_000);
    lc.powerOff(2_000);
    lc.powerOn(10_000);
    expect(lc.getState()).toBe('running');
    expect(lc.bootCountValue).toBe(2);
    expect(lc.uptimeSeconds(10_000 + 3_000)).toBe(3);
  });

  it('resets the boot clock on reboot', () => {
    const lc = new HostLifecycle(1_000);
    lc.reboot(50_000);
    expect(lc.getState()).toBe('running');
    expect(lc.bootCountValue).toBe(2);
    expect(lc.uptimeSeconds(50_000 + 1_000)).toBe(1);
  });

  it('suspends and resumes', () => {
    const lc = new HostLifecycle(1_000);
    lc.suspend(2_000);
    expect(lc.getState()).toBe('suspended');
    expect(lc.isSuspended()).toBe(true);
    lc.resume(3_000);
    expect(lc.getState()).toBe('running');
  });

  it('treats powerOn as a no-op when already running', () => {
    const lc = new HostLifecycle(1_000);
    lc.powerOn(2_000);
    expect(lc.bootCountValue).toBe(1);
  });

  it('treats powerOff as a no-op when already off', () => {
    const lc = new HostLifecycle(1_000);
    lc.powerOff(2_000);
    lc.powerOff(3_000);
    expect(lc.getState()).toBe('off');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Reactive transition events
// ═══════════════════════════════════════════════════════════════════

type LifecycleEvent = Extract<DomainEvent, { topic: 'host.lifecycle.transitioned' }>;

describe('HostLifecycle events', () => {
  function collect(): { lc: HostLifecycle; events: LifecycleEvent[] } {
    const lc = new HostLifecycle(1_000);
    const bus = new EventBus();
    const events: LifecycleEvent[] = [];
    bus.subscribe('host.lifecycle.transitioned', (e) => events.push(e));
    lc.attachBus(bus, 'dev-1', 'host-1');
    return { lc, events };
  }

  it('emits a single transition on power-off', () => {
    const { lc, events } = collect();
    lc.powerOff(2_000);
    expect(events).toHaveLength(1);
    expect(events[0].payload.from).toBe('running');
    expect(events[0].payload.to).toBe('off');
    expect(events[0].payload.deviceId).toBe('dev-1');
  });

  it('traverses booting on power-on', () => {
    const { lc, events } = collect();
    lc.powerOff(2_000);
    events.length = 0;
    lc.powerOn(3_000);
    expect(events.map((e) => e.payload.to)).toEqual(['booting', 'running']);
  });

  it('traverses halting on shutdown and rebooting on reboot', () => {
    const { lc, events } = collect();
    lc.shutdown(2_000);
    expect(events.map((e) => e.payload.to)).toEqual(['halting', 'off']);
    events.length = 0;
    lc.powerOn(3_000);
    events.length = 0;
    lc.reboot(4_000);
    expect(events.map((e) => e.payload.to)).toEqual(['rebooting', 'running']);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Integration — EndHost power drives the lifecycle
// ═══════════════════════════════════════════════════════════════════

describe('Linux host lifecycle integration', () => {
  it('exposes the lifecycle on the device', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect(pc.getLifecycle().isRunning()).toBe(true);
  });

  it('drives the lifecycle from powerOff / powerOn', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.powerOff();
    expect(pc.getLifecycle().getState()).toBe('off');
    pc.powerOn();
    expect(pc.getLifecycle().getState()).toBe('running');
    expect(pc.getLifecycle().bootCountValue).toBe(2);
  });

  it('renders uptime live from the boot clock', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const pretty = (await pc.executeCommand('uptime -p')).trim();
    expect(pretty).toMatch(/^up .*(minute|second)/);
    const header = (await pc.executeCommand('uptime')).trim();
    expect(header).toMatch(/up\s+.+,\s+\d+\s+users?,\s+load average:/);
  });

  it('resets uptime after a power-cycle', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.powerOff();
    pc.powerOn();
    const pretty = (await pc.executeCommand('uptime -p')).trim();
    expect(pretty).toMatch(/up 0 minute/);
  });

  it('exposes /proc/uptime as a live generated pseudo-file', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect((await pc.executeCommand('cat /proc/uptime')).trim()).toMatch(/^\d+\.\d{2} \d+\.\d{2}$/);
  });
});

describe('Windows host lifecycle integration', () => {
  it('reports the system boot time in systeminfo', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    const out = await pc.executeCommand('systeminfo');
    expect(out).toContain('System Boot Time:');
  });
});
