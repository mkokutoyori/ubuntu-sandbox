/**
 * `sudo <cmd>` when already root must trigger the same interactive flow
 * as `<cmd>`.
 *
 * Real sudo exempts uid 0 from the password challenge and re-enters the
 * standard exec path. The simulator was *only* triggering adduser /
 * passwd prompts on the bare command — `sudo adduser zoe` when already
 * root ran silently, dropping the GECOS / password prompts.
 *
 * LinuxFlowBuilder.build() now strips the `sudo` prefix (and its
 * valueless flags) when isRoot and recurses on the remainder so the
 * right per-command flow fires regardless of whether the user typed
 * sudo or not. `sudo -u <user>` is intentionally NOT stripped because
 * the dispatcher handles the identity swap on a separate path.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxFlowBuilder } from '@/terminal/flows/LinuxFlowBuilder';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';

describe('sudo <cmd> consistency when already root', () => {
  let pc: LinuxPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    const bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    pc = new LinuxPC('pc1');
    pc.setEventBus(bus);
    // Power-on must succeed so the IAM/filesystem is provisioned.
    pc.powerOn();
  });

  it('`sudo adduser zoe` as root triggers the same flow as `adduser zoe`', () => {
    const bare = LinuxFlowBuilder.build('adduser zoe', 'root', 0, pc);
    const sudo = LinuxFlowBuilder.build('sudo adduser zoe', 'root', 0, pc);
    expect(bare).not.toBeNull();
    expect(sudo).not.toBeNull();
    // Same number of steps (execute + password + GECOS).
    expect(sudo!.length).toBe(bare!.length);
    // First step is the executeCommandStep — both must run the same
    // command (the recursion uses the stripped form).
    expect(sudo![0].type).toBe(bare![0].type);
  });

  it('`sudo passwd zoe` as root triggers the same flow as `passwd zoe`', () => {
    const bare = LinuxFlowBuilder.build('passwd zoe', 'root', 0, pc);
    const sudo = LinuxFlowBuilder.build('sudo passwd zoe', 'root', 0, pc);
    expect(bare).not.toBeNull();
    expect(sudo).not.toBeNull();
    expect(sudo!.length).toBe(bare!.length);
  });

  it('`sudo passwd` as root triggers the same flow as `passwd` (own password)', () => {
    const bare = LinuxFlowBuilder.build('passwd', 'root', 0, pc);
    const sudo = LinuxFlowBuilder.build('sudo passwd', 'root', 0, pc);
    expect(bare).not.toBeNull();
    expect(sudo).not.toBeNull();
    expect(sudo!.length).toBe(bare!.length);
  });

  it('`sudo -n adduser zoe` (non-interactive flag) is stripped and the flow still fires', () => {
    const bare = LinuxFlowBuilder.build('adduser zoe', 'root', 0, pc);
    const sudo = LinuxFlowBuilder.build('sudo -n adduser zoe', 'root', 0, pc);
    expect(sudo).not.toBeNull();
    expect(sudo!.length).toBe(bare!.length);
  });

  it('`sudo -S adduser zoe` (read-pass-from-stdin) is stripped too', () => {
    const sudo = LinuxFlowBuilder.build('sudo -S adduser zoe', 'root', 0, pc);
    expect(sudo).not.toBeNull();
    // execute + password steps + gecos
    expect(sudo!.length).toBeGreaterThan(1);
  });

  it('`sudo -u alice useradd zoe` falls through to silent dispatch (-u special-case)', () => {
    // Identity swap is dispatcher-driven; the flow builder hands off.
    const out = LinuxFlowBuilder.build('sudo -u alice useradd zoe', 'root', 0, pc);
    expect(out).toBeNull();
  });

  it('`sudo useradd zoe` as root remains silent — useradd is non-interactive', () => {
    const bare = LinuxFlowBuilder.build('useradd zoe', 'root', 0, pc);
    const sudo = LinuxFlowBuilder.build('sudo useradd zoe', 'root', 0, pc);
    expect(bare).toBeNull();
    expect(sudo).toBeNull();
  });

  it('`sudo` alone as root returns null (no command to dispatch)', () => {
    expect(LinuxFlowBuilder.build('sudo', 'root', 0, pc)).toBeNull();
  });

  it('`sudo adduser` (no user) as root returns null — usage error path', () => {
    // The dispatcher will print the usage banner; no prompts to inject.
    const out = LinuxFlowBuilder.build('sudo adduser', 'root', 0, pc);
    expect(out).toBeNull();
  });

  it('non-root `sudo adduser zoe` still uses the existing sudo-flow path', () => {
    // Sanity check that the new branch did not regress the !isRoot path.
    pc.executor.userMgr.useradd('user', { p: 'pass' });
    pc.executor.userMgr.usermod('user', { aG: 'sudo' });
    const out = LinuxFlowBuilder.build('sudo adduser zoe', 'user', 1000, pc);
    expect(out).not.toBeNull();
    // First step is the sudo password prompt.
    expect(out![0].type).toBe('password');
  });

  it('non-root `adduser zoe` returns null — needs sudo on Ubuntu/Debian', () => {
    pc.executor.userMgr.useradd('user', { p: 'pass' });
    const out = LinuxFlowBuilder.build('adduser zoe', 'user', 1000, pc);
    expect(out).toBeNull();
  });
});
