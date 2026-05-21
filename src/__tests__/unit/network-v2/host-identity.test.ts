/**
 * Host system identity — unit tests.
 *
 * Covers the third vertical of the host-management model:
 *   - the identity domain model (OsRelease, KernelInfo, SystemIdentity)
 *   - its filesystem coherence on Linux (/etc/os-release, /etc/machine-id,
 *     /etc/timezone, /proc/version, /proc/sys/kernel/*) and the commands it
 *     drives (uname, hostnamectl, timedatectl)
 *   - the host.identity.changed event stream and on-disk re-sync
 *   - its surfacing through Windows `systeminfo`
 */

import { describe, it, expect } from 'vitest';
import {
  OsRelease, KernelInfo, SystemIdentity,
} from '@/network/devices/host/identity';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EventBus } from '@/events/EventBus';
import type { DomainEvent } from '@/events/types';

// ═══════════════════════════════════════════════════════════════════
// OsRelease / KernelInfo
// ═══════════════════════════════════════════════════════════════════

describe('OsRelease', () => {
  it('renders /etc/os-release', () => {
    const out = OsRelease.ubuntu().render();
    expect(out).toContain('NAME="Ubuntu"');
    expect(out).toContain('VERSION_ID="22.04"');
    expect(out).toContain('ID=ubuntu');
  });

  it('renders /etc/lsb-release', () => {
    const out = OsRelease.ubuntu().renderLsbRelease();
    expect(out).toContain('DISTRIB_ID=Ubuntu');
    expect(out).toContain('DISTRIB_RELEASE=22.04');
  });
});

describe('KernelInfo', () => {
  it('renders /proc/version', () => {
    const out = KernelInfo.ubuntu().toProcVersion();
    expect(out).toContain('Linux version 5.15.0-130-generic');
    expect(out).toContain('#140-Ubuntu');
  });
});

// ═══════════════════════════════════════════════════════════════════
// SystemIdentity
// ═══════════════════════════════════════════════════════════════════

describe('SystemIdentity', () => {
  it('renders a hostnamectl report', () => {
    const out = SystemIdentity.ubuntu().toHostnamectl('myhost');
    expect(out).toContain('Static hostname: myhost');
    expect(out).toContain('Operating System: Ubuntu 22.04');
    expect(out).toContain('Kernel: Linux 5.15.0-130-generic');
    expect(out).toContain('Machine ID:');
  });

  it('renders a timedatectl report', () => {
    const out = SystemIdentity.ubuntu().toTimedatectl(new Date(Date.UTC(2026, 4, 21, 14, 0, 0)));
    expect(out).toContain('Time zone: Etc/UTC');
    expect(out).toContain('Universal time: Thu 2026-05-21 14:00:00 UTC');
  });

  it('exposes a Windows preset distinct from the Ubuntu one', () => {
    expect(SystemIdentity.windows().os.name).toBe('Microsoft Windows');
    expect(SystemIdentity.windows().kernel.sysname).toBe('Windows_NT');
    expect(SystemIdentity.ubuntu().os.name).toBe('Ubuntu');
  });

  it('renders /etc/default/locale', () => {
    expect(SystemIdentity.ubuntu().toLocaleConf()).toBe('LANG=en_US.UTF-8\n');
  });
});

type IdentityEvent = Extract<DomainEvent, { topic: 'host.identity.changed' }>;

describe('SystemIdentity events', () => {
  function collect(): { id: SystemIdentity; events: IdentityEvent[] } {
    const id = SystemIdentity.ubuntu();
    const bus = new EventBus();
    const events: IdentityEvent[] = [];
    bus.subscribe('host.identity.changed', (e) => events.push(e));
    id.attachBus(bus, 'dev-1');
    return { id, events };
  }

  it('publishes a change event on setTimezone', () => {
    const { id, events } = collect();
    id.setTimezone('Europe/Paris');
    expect(id.timezone).toBe('Europe/Paris');
    expect(events).toHaveLength(1);
    expect(events[0].payload.field).toBe('timezone');
    expect(events[0].payload.to).toBe('Europe/Paris');
  });

  it('does not publish when the value is unchanged', () => {
    const { id, events } = collect();
    id.setTimezone(id.timezone);
    expect(events).toHaveLength(0);
  });

  it('publishes change events for locale and machine-id', () => {
    const { id, events } = collect();
    id.setLocale('fr_FR.UTF-8');
    id.setMachineId('ffffffffffffffffffffffffffffffff');
    expect(events.map((e) => e.payload.field)).toEqual(['locale', 'machine-id']);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Linux integration — coherence with /etc, /proc and commands
// ═══════════════════════════════════════════════════════════════════

describe('Linux host identity coherence', () => {
  it('exposes the identity on the device', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect(pc.getIdentity().os.name).toBe('Ubuntu');
  });

  it('drives uname from the kernel model', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect((await pc.executeCommand('uname -r')).trim()).toBe(pc.getIdentity().kernel.release);
    expect((await pc.executeCommand('uname -o')).trim()).toBe('GNU/Linux');
  });

  it('drives hostnamectl from the identity model', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('hostnamectl');
    expect(out).toContain('Operating System: Ubuntu 22.04');
    expect(out).toContain(`Machine ID: ${pc.getIdentity().machineId}`);
  });

  it('drives timedatectl from the identity model', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('timedatectl');
    expect(out).toContain('Time zone: Etc/UTC');
  });

  it('materialises /etc/machine-id and /etc/os-release from the model', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect((await pc.executeCommand('cat /etc/machine-id')).trim())
      .toBe(pc.getIdentity().machineId);
    expect(await pc.executeCommand('cat /etc/os-release')).toContain('NAME="Ubuntu"');
    expect((await pc.executeCommand('cat /etc/timezone')).trim()).toBe('Etc/UTC');
  });

  it('exposes /proc/version and /proc/sys/kernel/* as live pseudo-files', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    expect(await pc.executeCommand('cat /proc/version')).toContain('Linux version');
    expect((await pc.executeCommand('cat /proc/sys/kernel/osrelease')).trim())
      .toBe(pc.getIdentity().kernel.release);
  });

  it('re-syncs /etc/timezone when the identity changes at runtime', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.getIdentity().setTimezone('Europe/Paris');
    expect((await pc.executeCommand('cat /etc/timezone')).trim()).toBe('Europe/Paris');
    expect(await pc.executeCommand('timedatectl')).toContain('Time zone: Europe/Paris');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Windows integration
// ═══════════════════════════════════════════════════════════════════

describe('Windows host identity coherence', () => {
  it('carries a Windows identity preset', () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    expect(pc.getIdentity().os.name).toBe('Microsoft Windows');
  });

  it('drives the systeminfo OS lines from the identity model', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1');
    const out = await pc.executeCommand('systeminfo');
    expect(out).toContain(`OS Name:                   ${pc.getIdentity().os.prettyName}`);
    expect(out).toContain(`OS Version:                ${pc.getIdentity().os.version}`);
  });
});
