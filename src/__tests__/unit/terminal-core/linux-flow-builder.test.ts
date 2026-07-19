/**
 * Tests for LinuxFlowBuilder.
 *
 * Verifies that the correct interactive step sequences are built for:
 *   - sudo <command>
 *   - sudo passwd <user>
 *   - sudo adduser <user> (with various flags)
 *   - su [user]
 *   - passwd (own password)
 *   - passwd <user> (as root)
 *   - adduser <user> (as root)
 *   - Edge cases: non-sudoer, flags, root user
 */

import { describe, it, expect, vi } from 'vitest';
import { buildLinuxInteractionPlan } from '@/network/devices/linux/interaction/LinuxInteractionPlanner';

/** Compat shim over the device-layer planner (ex-LinuxFlowBuilder API). */
const buildFlow = (
  cmd: string, user: string, uid: number, device: unknown,
) => buildLinuxInteractionPlan(
  cmd, { currentUser: user, currentUid: uid },
  device as import('@/network/devices/linux/interaction/LinuxInteractionPlanner').LinuxPlannerDevice,
)?.steps ?? null;


// ─── Mock device ────────────────────────────────────────────────────

function createMockDevice(overrides?: Record<string, unknown>) {
  return {
    canSudo: vi.fn().mockReturnValue(true),
    checkPassword: vi.fn().mockReturnValue(true),
    setUserPassword: vi.fn(),
    setUserGecos: vi.fn(),
    ...overrides,
  };
}

// ─── sudo flows ─────────────────────────────────────────────────────

describe('LinuxFlowBuilder.build — sudo', () => {
  it('returns null for non-sudo commands from non-root', () => {
    const device = createMockDevice();
    expect(buildFlow('ls -la', 'user', 1000, device)).toBeNull();
  });

  it('returns null for sudo from root user', () => {
    const device = createMockDevice();
    expect(buildFlow('sudo ls', 'root', 0, device)).toBeNull();
  });

  it('returns null when user cannot sudo', () => {
    const device = createMockDevice({ canSudo: vi.fn().mockReturnValue(false) });
    expect(buildFlow('sudo ls', 'user', 1000, device)).toBeNull();
  });

  it('returns null for sudo with no sub-command', () => {
    const device = createMockDevice();
    expect(buildFlow('sudo', 'user', 1000, device)).toBeNull();
  });

  it('returns null for sudo -l', () => {
    const device = createMockDevice();
    expect(buildFlow('sudo -l', 'user', 1000, device)).toBeNull();
  });

  it('builds password + execute for generic sudo command', () => {
    const device = createMockDevice();
    const steps = buildFlow('sudo apt update', 'user', 1000, device);
    expect(steps).not.toBeNull();
    expect(steps!.length).toBe(2);
    expect(steps![0].kind).toBe('password');
    expect(steps![0].prompt).toContain('[sudo] password for user');
    expect(steps![1].kind).toBe('run');
  });

  it('builds sudo passwd <user> flow with new/retype steps', () => {
    const device = createMockDevice();
    const steps = buildFlow('sudo passwd john', 'admin', 1000, device);
    expect(steps).not.toBeNull();

    const types = steps!.map(s => s.kind);
    // sudo pwd → new pwd → retype pwd → execute (setPassword) → output
    expect(types[0]).toBe('password'); // sudo password
    expect(types[1]).toBe('password'); // new password
    expect(types[2]).toBe('password'); // retype
    expect(types[3]).toBe('run');  // setUserPassword
    expect(types[4]).toBe('output');   // success message
  });

  it('builds sudo passwd with flags (e.g., -l) as password + execute only', () => {
    const device = createMockDevice();
    const steps = buildFlow('sudo passwd -l john', 'admin', 1000, device);
    expect(steps).not.toBeNull();
    expect(steps!.length).toBe(2);
    expect(steps![0].kind).toBe('password');
    expect(steps![1].kind).toBe('run');
  });

  it('builds sudo adduser with full interactive flow', () => {
    const device = createMockDevice();
    const steps = buildFlow('sudo adduser newuser', 'admin', 1000, device);
    expect(steps).not.toBeNull();

    const types = steps!.map(s => s.kind);
    // Should include: sudo pwd, execute (adduser), new pwd, retype, execute (setPassword), output, GECOS steps
    expect(types[0]).toBe('password'); // sudo password
    expect(types).toContain('text');   // GECOS fields
    expect(types).toContain('confirmation'); // "Is the information correct?"
  });

  it('builds sudo adduser --disabled-password --gecos as password + execute only', () => {
    const device = createMockDevice();
    const steps = buildFlow('sudo adduser --disabled-password --gecos "" newuser', 'admin', 1000, device);
    expect(steps).not.toBeNull();
    expect(steps!.length).toBe(2); // sudo pwd + execute
  });

  it('builds sudo adduser --disabled-password without --gecos (GECOS prompts remain)', () => {
    const device = createMockDevice();
    const steps = buildFlow('sudo adduser --disabled-password newuser', 'admin', 1000, device);
    expect(steps).not.toBeNull();
    const types = steps!.map(s => s.kind);
    // No password steps for user, but GECOS steps should be present
    expect(types.filter(t => t === 'text').length).toBeGreaterThanOrEqual(5); // 5 GECOS fields
    // No 'new password' / 'retype' password steps
    const passwordPrompts = steps!.filter(s => s.kind === 'password').map(s => s.prompt);
    expect(passwordPrompts.every(p => p?.includes('[sudo]'))).toBe(true);
  });

  it('builds sudo su flow', () => {
    const device = createMockDevice();
    const steps = buildFlow('sudo su', 'user', 1000, device);
    expect(steps).not.toBeNull();
    expect(steps!.length).toBe(2);
    expect(steps![0].kind).toBe('password');
    expect(steps![1].kind).toBe('run');
  });
});

// ─── su flows ───────────────────────────────────────────────────────

describe('LinuxFlowBuilder.build — su', () => {
  it('builds su flow with password for root by default', () => {
    const device = createMockDevice();
    const steps = buildFlow('su', 'user', 1000, device);
    expect(steps).not.toBeNull();
    expect(steps![0].kind).toBe('password');
    expect(steps![0].prompt).toBe('Password:');
  });

  it('builds su flow targeting a specific user', () => {
    const device = createMockDevice();
    const steps = buildFlow('su john', 'user', 1000, device);
    expect(steps).not.toBeNull();
    expect(steps![0].kind).toBe('password');
  });

  it('builds su - flow (login shell)', () => {
    const device = createMockDevice();
    const steps = buildFlow('su -', 'user', 1000, device);
    expect(steps).not.toBeNull();
    expect(steps![0].kind).toBe('password');
  });

  it('returns null for su when already root', () => {
    const device = createMockDevice();
    expect(buildFlow('su', 'root', 0, device)).toBeNull();
  });
});

// ─── passwd flows ───────────────────────────────────────────────────

describe('LinuxFlowBuilder.build — passwd', () => {
  it('builds own-password flow for non-root (current → new → retype)', () => {
    const device = createMockDevice();
    const steps = buildFlow('passwd', 'user', 1000, device);
    expect(steps).not.toBeNull();

    const types = steps!.map(s => s.kind);
    expect(types[0]).toBe('output');   // "Changing password for user."
    expect(types[1]).toBe('password'); // current password
    expect(types[2]).toBe('password'); // new password
    expect(types[3]).toBe('password'); // retype
    expect(types[4]).toBe('run');  // setUserPassword
    expect(types[5]).toBe('output');   // success
  });

  it('builds own-password flow for root (no current password needed)', () => {
    const device = createMockDevice();
    const steps = buildFlow('passwd', 'root', 0, device);
    expect(steps).not.toBeNull();

    const types = steps!.map(s => s.kind);
    // Root: new → retype → set → output (no current password step)
    expect(types[0]).toBe('password'); // new
    expect(types[1]).toBe('password'); // retype
    expect(types[2]).toBe('run');
    expect(types[3]).toBe('output');
  });

  it('builds passwd <user> flow for root', () => {
    const device = createMockDevice();
    const steps = buildFlow('passwd john', 'root', 0, device);
    expect(steps).not.toBeNull();
    expect(steps!.length).toBeGreaterThanOrEqual(3);
    expect(steps![0].kind).toBe('password'); // new password
  });

  it('returns null for passwd with flags from non-root', () => {
    const device = createMockDevice();
    expect(buildFlow('passwd -l john', 'user', 1000, device)).toBeNull();
  });
});

// ─── adduser flows (as root) ────────────────────────────────────────

describe('LinuxFlowBuilder.build — adduser (root)', () => {
  it('builds full adduser flow with password + GECOS', () => {
    const device = createMockDevice();
    const steps = buildFlow('adduser newuser', 'root', 0, device);
    expect(steps).not.toBeNull();

    const types = steps!.map(s => s.kind);
    expect(types).toContain('run');      // create user
    expect(types).toContain('password');      // new password
    expect(types).toContain('text');          // GECOS fields
    expect(types).toContain('confirmation');  // confirm
  });

  it('returns null for adduser with --disabled-password --gecos (no interaction)', () => {
    const device = createMockDevice();
    expect(buildFlow('adduser --disabled-password --gecos "" newuser', 'root', 0, device)).toBeNull();
  });

  it('returns null for adduser without enough args', () => {
    const device = createMockDevice();
    expect(buildFlow('adduser', 'root', 0, device)).toBeNull();
  });

  it('returns null for adduser from non-root without sudo', () => {
    const device = createMockDevice();
    expect(buildFlow('adduser newuser', 'user', 1000, device)).toBeNull();
  });
});
