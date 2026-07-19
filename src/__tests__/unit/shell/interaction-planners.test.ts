/**
 * Command-owned interactive flows — planner unit tests (IoC refactor,
 * audit AUDIT-COHERENCE-CMD-PS-UX-HELP.md §3).
 *
 * The device SHELLS declare their interactive commands through
 * `interactionPlanFor`; the terminal owns nothing vendor-specific.
 * These tests exercise the planners directly, without any terminal.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  type CommandInteractionPlan,
  type InteractionRuntime,
  isInteractionPlanner,
} from '@/shell/interaction/CommandInteraction';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

/** Minimal runtime that executes against a device and records output. */
function makeRuntime(exec: (cmd: string) => Promise<string>): InteractionRuntime & { outputs: string[] } {
  const outputs: string[] = [];
  return {
    exec,
    output: (text: string) => { outputs.push(text); },
    clearScreen: () => {},
    values: new Map<string, string>(),
    metadata: new Map<string, unknown>(),
    outputs,
  };
}

/** Run every `run` step of a plan against the given executor. */
async function runPlan(plan: CommandInteractionPlan, exec: (cmd: string) => Promise<string>): Promise<void> {
  const rt = makeRuntime(exec);
  for (const step of plan.steps) {
    if (step.kind === 'run') await step.run(rt);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Cisco IOS — the shell owns copy/reload/erase interactivity
// ═══════════════════════════════════════════════════════════════════

describe('Cisco shell interaction planner', () => {
  function shellOf(router: CiscoRouter) {
    const shell = router.getShell();
    expect(isInteractionPlanner(shell)).toBe(true);
    return shell as unknown as { interactionPlanFor(line: string, ctx?: { mode?: string }): CommandInteractionPlan | null };
  }

  it('plans erase startup-config in privileged mode, for every spelling and abbreviation', () => {
    const router = new CiscoRouter('R1');
    const shell = shellOf(router);
    for (const line of ['erase startup-config', 'write erase', 'erase nvram:', 'era sta', 'wr er']) {
      const plan = shell.interactionPlanFor(line, { mode: 'privileged' });
      expect(plan, `"${line}" must yield an erase plan`).not.toBeNull();
      expect(plan!.steps.some((s) => s.kind === 'confirmation')).toBe(true);
      expect(plan!.steps.some((s) => s.kind === 'run')).toBe(true);
    }
  });

  it('offers no plans outside privileged mode', () => {
    const router = new CiscoRouter('R1');
    const shell = shellOf(router);
    expect(shell.interactionPlanFor('erase startup-config', { mode: 'user' })).toBeNull();
    expect(shell.interactionPlanFor('reload', { mode: 'user' })).toBeNull();
  });

  it('plans reload only for the bare command (reload in 5 stays non-interactive)', () => {
    const router = new CiscoRouter('R1');
    const shell = shellOf(router);
    expect(shell.interactionPlanFor('reload', { mode: 'privileged' })).not.toBeNull();
    expect(shell.interactionPlanFor('rel', { mode: 'privileged' })).not.toBeNull();
    expect(shell.interactionPlanFor('reload in 5', { mode: 'privileged' })).toBeNull();
  });

  it('plans copy running-config startup-config for IOS abbreviations', () => {
    const router = new CiscoRouter('R1');
    const shell = shellOf(router);
    for (const line of ['copy running-config startup-config', 'copy run start', 'cop runn star']) {
      const plan = shell.interactionPlanFor(line, { mode: 'privileged' });
      expect(plan, `"${line}" must yield a copy plan`).not.toBeNull();
      expect(plan!.steps.some((s) => s.kind === 'text')).toBe(true);
    }
    // Other copy destinations stay non-interactive here (device handles them).
    expect(shell.interactionPlanFor('copy running-config tftp:', { mode: 'privileged' })).toBeNull();
  });

  it('the erase plan really erases when its run steps execute', async () => {
    const router = new CiscoRouter('R1');
    await router.executeCommand('enable');
    await router.executeCommand('configure terminal');
    await router.executeCommand('hostname PLAN-SAVED');
    await router.executeCommand('end');
    await router.executeCommand('write memory');
    expect(await router.executeCommand('show startup-config')).toContain('hostname PLAN-SAVED');

    const plan = shellOf(router).interactionPlanFor('erase startup-config', { mode: 'privileged' })!;
    await runPlan(plan, (cmd) => router.executeCommand(cmd));

    expect(await router.executeCommand('show startup-config')).not.toContain('hostname PLAN-SAVED');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Huawei VRP — the shell owns save/reset/reboot interactivity, and
// save/reset now have REAL saved-configuration semantics
// ═══════════════════════════════════════════════════════════════════

describe('Huawei shell interaction planner', () => {
  function shellOf(router: HuaweiRouter) {
    const shell = router.getShell();
    expect(isInteractionPlanner(shell)).toBe(true);
    return shell as unknown as { interactionPlanFor(line: string): CommandInteractionPlan | null };
  }

  it('plans save / reset saved-configuration / reboot', () => {
    const router = new HuaweiRouter('H1');
    const shell = shellOf(router);
    for (const line of ['save', 'reset saved-configuration', 'reboot']) {
      const plan = shell.interactionPlanFor(line);
      expect(plan, `"${line}" must yield a plan`).not.toBeNull();
      expect(plan!.steps.some((s) => s.kind === 'confirmation')).toBe(true);
    }
  });

  it('save plan really captures the configuration (visible to display saved-configuration)', async () => {
    const router = new HuaweiRouter('H1');
    await router.executeCommand('system-view');
    await router.executeCommand('sysname VRP-SAVED');
    await router.executeCommand('quit');

    const plan = shellOf(router).interactionPlanFor('save')!;
    await runPlan(plan, (cmd) => router.executeCommand(cmd));

    const saved = await router.executeCommand('display saved-configuration');
    expect(saved).toContain('VRP-SAVED');
  });

  it('reset saved-configuration plan really clears the saved configuration', async () => {
    const router = new HuaweiRouter('H1');
    await router.executeCommand('system-view');
    await router.executeCommand('sysname VRP-TO-CLEAR');
    await router.executeCommand('quit');
    await runPlan(shellOf(router).interactionPlanFor('save')!, (c) => router.executeCommand(c));
    expect(await router.executeCommand('display saved-configuration')).toContain('VRP-TO-CLEAR');

    await runPlan(shellOf(router).interactionPlanFor('reset saved-configuration')!, (c) => router.executeCommand(c));
    expect(await router.executeCommand('display saved-configuration')).not.toContain('VRP-TO-CLEAR');
  });

  it('display saved-configuration no longer mirrors the running config without a save', async () => {
    const router = new HuaweiRouter('H1');
    await router.executeCommand('system-view');
    await router.executeCommand('sysname NEVER-SAVED');
    await router.executeCommand('quit');
    const saved = await router.executeCommand('display saved-configuration');
    expect(saved).not.toContain('NEVER-SAVED');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Linux — the device owns sudo/su/passwd/adduser interactivity
// ═══════════════════════════════════════════════════════════════════

describe('Linux device interaction planner', () => {
  function plannerOf(pc: LinuxPC) {
    expect(isInteractionPlanner(pc)).toBe(true);
    return pc as unknown as {
      interactionPlanFor(line: string, ctx?: { currentUser?: string; currentUid?: number }): CommandInteractionPlan | null;
    };
  }

  it('useradd is never interactive (faithful), adduser is', () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const p = plannerOf(pc);
    expect(p.interactionPlanFor('useradd newacct', { currentUser: 'root', currentUid: 0 })).toBeNull();
    expect(p.interactionPlanFor('useradd -m -s /bin/bash newacct', { currentUser: 'root', currentUid: 0 })).toBeNull();
    const plan = p.interactionPlanFor('adduser newacct', { currentUser: 'root', currentUid: 0 });
    expect(plan).not.toBeNull();
    expect(plan!.steps.some((s) => s.kind === 'password')).toBe(true);
  });

  it('passwd for self prompts for the current password first (non-root)', () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const plan = plannerOf(pc).interactionPlanFor('passwd', { currentUser: 'user', currentUid: 1000 });
    expect(plan).not.toBeNull();
    const prompts = plan!.steps.filter((s) => s.kind === 'password').map((s) => (s as { prompt: string }).prompt);
    expect(prompts[0]).toContain('Current password');
  });

  it('sudo <cmd> for a non-root sudoer authenticates then executes', () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const plan = plannerOf(pc).interactionPlanFor('sudo ls /root', { currentUser: 'user', currentUid: 1000 });
    expect(plan).not.toBeNull();
    expect(plan!.steps[0].kind).toBe('password');
    expect(plan!.steps.some((s) => s.kind === 'run')).toBe(true);
  });

  it('plain commands are not interactive', () => {
    const pc = new LinuxPC('PC1', 0, 0);
    expect(plannerOf(pc).interactionPlanFor('ls -la', { currentUser: 'user', currentUid: 1000 })).toBeNull();
  });
});
