import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  CommandPrivilegePolicy,
  Satisfy,
  Deny,
  type PrivilegeActor,
} from '@/network/devices/linux/iam/policy/CommandPrivilegePolicy';

const root: PrivilegeActor = { uid: 0, user: 'root', groups: ['root'] };
const alice: PrivilegeActor = { uid: 1000, user: 'alice', groups: ['alice'] };
const admin: PrivilegeActor = { uid: 1001, user: 'ops', groups: ['ops', 'sudo'] };

function policyWith(...declares: Array<(p: CommandPrivilegePolicy) => void>): CommandPrivilegePolicy {
  const policy = new CommandPrivilegePolicy();
  for (const apply of declares) apply(policy);
  return policy;
}

describe('CommandPrivilegePolicy — declarative privileged commands', () => {
  it('ignores commands that were never declared', () => {
    const policy = new CommandPrivilegePolicy();
    expect(policy.check('ls', [], alice)).toBeNull();
  });

  it('denies a root-only command for a non-root actor with the default wording', () => {
    const policy = policyWith(p => p.declare('frobnicate'));
    expect(policy.check('frobnicate', [], alice)).toEqual({
      output: 'frobnicate: Permission denied',
      exitCode: 1,
    });
  });

  it('lets root run any declared command', () => {
    const policy = policyWith(p => p.declare('frobnicate'));
    expect(policy.check('frobnicate', [], root)).toBeNull();
  });

  it('admits an admin-group member when the satisfier allows the group', () => {
    const policy = policyWith(p =>
      p.declare('frobnicate', { satisfiedBy: Satisfy.rootOrGroup('sudo', 'wheel') }));
    expect(policy.check('frobnicate', [], admin)).toBeNull();
    expect(policy.check('frobnicate', [], alice)).not.toBeNull();
  });

  it('limits the rule to invocations matched by appliesWhen', () => {
    const policy = policyWith(p =>
      p.declare('tool', { appliesWhen: args => args.includes('--system') }));
    expect(policy.check('tool', ['--user'], alice)).toBeNull();
    expect(policy.check('tool', ['--system'], alice)).not.toBeNull();
  });

  it('gives appliesWhen access to the actor for self-versus-other rules', () => {
    const policy = policyWith(p =>
      p.declare('tool', { appliesWhen: (args, actor) => args[0] !== actor.user }));
    expect(policy.check('tool', ['alice'], alice)).toBeNull();
    expect(policy.check('tool', ['bob'], alice)).not.toBeNull();
  });

  it('renders a custom denial verbatim', () => {
    const policy = policyWith(p =>
      p.declare('tool', { deny: Deny.withMessage('tool: nope', 77) }));
    expect(policy.check('tool', [], alice)).toEqual({ output: 'tool: nope', exitCode: 77 });
  });

  it('declares several commands in one statement', () => {
    const policy = policyWith(p => p.declare(['alpha', 'beta']));
    expect(policy.check('alpha', [], alice)).not.toBeNull();
    expect(policy.check('beta', [], alice)).not.toBeNull();
  });

  it('evaluates stacked declarations for the same command until one denies', () => {
    const policy = policyWith(p => p
      .declare('tool', { appliesWhen: args => args.includes('--a'), deny: Deny.withMessage('a-denied') })
      .declare('tool', { appliesWhen: args => args.includes('--b'), deny: Deny.withMessage('b-denied') }));
    expect(policy.check('tool', ['--b'], alice)?.output).toBe('b-denied');
    expect(policy.check('tool', ['--a'], alice)?.output).toBe('a-denied');
    expect(policy.check('tool', [], alice)).toBeNull();
  });
});

describe('the Linux executor consults the declarative privilege policy', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  function buildPc(): LinuxPC {
    return new LinuxPC('linux-pc', 'pc1', 0, 0);
  }

  it('denies useradd for the unprivileged default user', async () => {
    const out = await buildPc().executeCommand('useradd -m bob');
    expect(out).toContain('useradd: Permission denied');
  });

  it('lets sudo elevate through the same gate', async () => {
    const pc = buildPc();
    await pc.executeCommand('sudo useradd -m bob');
    const out = await pc.executeCommand('id bob');
    expect(out).toContain('bob');
    expect(out).not.toContain('no such user');
  });

  it('refuses reboot for the unprivileged user', async () => {
    const out = await buildPc().executeCommand('reboot');
    expect(out).toContain('reboot: Permission denied');
  });

  it('refuses passwd against another account with the passwd wording', async () => {
    const out = await buildPc().executeCommand('passwd root');
    expect(out).toContain('passwd: You may not view or modify password information for root.');
  });

  it('keeps flag-only passwd invocations out of the gate', async () => {
    const out = await buildPc().executeCommand('passwd -S');
    expect(out).not.toContain('You may not view or modify');
  });

  it('refuses crontab -u for another user without privilege', async () => {
    const out = await buildPc().executeCommand('crontab -u root -l');
    expect(out).toContain('crontab: must be privileged to use -u');
  });

  it('allows crontab -u naming the caller', async () => {
    const out = await buildPc().executeCommand('crontab -u user -l');
    expect(out).not.toContain('must be privileged');
  });

  it('a freshly declared command becomes privileged immediately', async () => {
    const pc = buildPc();
    const policy = (pc as unknown as {
      executor: { commandPrivileges: CommandPrivilegePolicy };
    }).executor.commandPrivileges;
    policy.declare('uname');

    const denied = await pc.executeCommand('uname');
    const elevated = await pc.executeCommand('sudo uname');

    expect(denied).toContain('uname: Permission denied');
    expect(elevated).toContain('Linux');
  });
});
