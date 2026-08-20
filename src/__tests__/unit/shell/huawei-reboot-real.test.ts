/**
 * Huawei VRP `reboot` — a REAL device restart, not a printed prompt.
 *
 * Parity with Cisco `reload` (performImmediateReload): confirming the
 * reboot power-cycles the device and drops the shell back to user view.
 * The interactive Y/N dialogue stays owned by the shell's interaction
 * plan; the inline (vty) form assumes confirmation like Cisco's does.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { CommandInteractionPlan, InteractionRuntime } from '@/shell/interaction/CommandInteraction';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function shellOf(router: HuaweiRouter) {
  return router.getShell() as unknown as {
    interactionPlanFor(line: string): CommandInteractionPlan | null;
    getPrompt(r: HuaweiRouter): string;
  };
}

async function runPlan(plan: CommandInteractionPlan, exec: (cmd: string) => Promise<string>): Promise<void> {
  const rt: InteractionRuntime = {
    exec,
    output: () => {},
    clearScreen: () => {},
    values: new Map(),
    metadata: new Map(),
  };
  for (const step of plan.steps) {
    if (step.kind === 'run') await step.run(rt);
  }
}

describe('Huawei reboot really restarts the device', () => {
  it('the reboot plan has a run step that executes the device reboot', () => {
    const router = new HuaweiRouter('H1');
    const plan = shellOf(router).interactionPlanFor('reboot');
    expect(plan).not.toBeNull();
    expect(plan!.steps.some((s) => s.kind === 'run')).toBe(true);
  });

  it('after the reboot plan runs, the shell is back in user view', async () => {
    const router = new HuaweiRouter('H1');
    await router.executeCommand('system-view');
    expect(shellOf(router).getPrompt(router)).toContain('[');

    const plan = shellOf(router).interactionPlanFor('reboot')!;
    await runPlan(plan, (cmd) => router.executeCommand(cmd));

    expect(shellOf(router).getPrompt(router)).toContain('<');
  });

  it('the device stays operational after the power-cycle (commands still run)', async () => {
    const router = new HuaweiRouter('H1');
    const plan = shellOf(router).interactionPlanFor('reboot')!;
    await runPlan(plan, (cmd) => router.executeCommand(cmd));

    const out = await router.executeCommand('display version');
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain('powered off');
  });

  it('inline vty `reboot` reports the restart instead of a dangling prompt', async () => {
    const router = new HuaweiRouter('H1');
    const out = await router.executeCommand('reboot');
    expect(out).toContain('reboot');
    expect(out).not.toBe('Info: This operation will reboot the system. Continue? [Y/N]:');
  });
});
