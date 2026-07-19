/**
 * Interaction plans over SSH — the same command-owned dialogues the UI
 * terminal renders must drive the SSH path (IoC refactor, follow-up).
 *
 * The router shell adapters (cisco-ios / huawei-vrp) consult
 * `interactionPlanFor` and walk the plan through the IShell
 * pendingInput/handleInput protocol, so `erase startup-config` over SSH
 * confirms interactively and REALLY erases — one source of truth.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { ShellFactory } from '@/shell/ShellFactory';
import { installDefaultShells } from '@/shell/registerDefaults';
import type { IShell, ShellLineResult } from '@/shell/IShell';
import {
  InteractionPlanRunner,
} from '@/shell/interaction/InteractionPlanRunner';
import type { CommandInteractionPlan } from '@/shell/interaction/CommandInteraction';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  installDefaultShells();
});

function makeShell(kind: string, device: unknown): IShell {
  return ShellFactory.create(kind, { device: device as never, user: 'admin', connection: 'ssh' });
}

// ═══════════════════════════════════════════════════════════════════
// InteractionPlanRunner — generic plan walker
// ═══════════════════════════════════════════════════════════════════

describe('InteractionPlanRunner', () => {
  const plan: CommandInteractionPlan = {
    steps: [
      { kind: 'output', lines: ['header'] },
      {
        kind: 'confirmation', prompt: 'Continue? [confirm]', defaultAnswer: 'yes', storeAs: 'ok',
        validate: (v) => (v.toLowerCase().startsWith('n')
          ? { valid: false, errorMessage: 'Cancelled.', maxRetries: 0 }
          : { valid: true }),
      },
      { kind: 'run', run: async (rt) => { rt.output(`ran with ok=${rt.values.get('ok')}`); } },
      { kind: 'output', lines: ['done'] },
    ],
  };

  it('emits output then pauses at the first prompt', async () => {
    const r = new InteractionPlanRunner(plan, async () => '');
    const first = await r.start();
    expect(first.done).toBe(false);
    expect(first.lines).toEqual(['header']);
    expect(first.pending?.promptText).toBe('Continue? [confirm]');
  });

  it('an empty answer takes the confirmation default and completes', async () => {
    const r = new InteractionPlanRunner(plan, async () => '');
    await r.start();
    const end = await r.provide('');
    expect(end.done).toBe(true);
    expect(end.lines).toEqual(['ran with ok=yes', 'done']);
  });

  it('a rejected answer aborts with the validation message', async () => {
    const r = new InteractionPlanRunner(plan, async () => '');
    await r.start();
    const end = await r.provide('n');
    expect(end.done).toBe(true);
    expect(end.lines).toEqual(['Cancelled.']);
  });

  it('run steps execute through the provided exec', async () => {
    const calls: string[] = [];
    const p: CommandInteractionPlan = {
      steps: [{ kind: 'run', run: async (rt) => { await rt.exec('erase startup-config'); } }],
    };
    const r = new InteractionPlanRunner(p, async (cmd) => { calls.push(cmd); return ''; });
    const res = await r.start();
    expect(res.done).toBe(true);
    expect(calls).toEqual(['erase startup-config']);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Cisco over SSH — erase/copy dialogues
// ═══════════════════════════════════════════════════════════════════

describe('Cisco erase startup-config over SSH is interactive AND real', () => {
  async function seed(router: CiscoRouter): Promise<void> {
    await router.executeCommand('enable');
    await router.executeCommand('configure terminal');
    await router.executeCommand('hostname SSH-SAVED');
    await router.executeCommand('end');
    await router.executeCommand('write memory');
  }

  it('prompts for confirmation, then really erases on accept', async () => {
    const router = new CiscoRouter('R1');
    await seed(router);
    expect(await router.executeCommand('show startup-config')).toContain('hostname SSH-SAVED');

    const shell = makeShell('cisco-ios', router);
    await shell.processLine('enable');
    const ask = await shell.processLine('erase startup-config') as ShellLineResult;
    expect(ask.pendingInput?.promptText).toContain('Continue? [confirm]');

    const done = await shell.handleInput!('');
    expect(done.output.join('\n')).toContain('Erase of nvram: complete');
    expect(await router.executeCommand('show startup-config')).not.toContain('hostname SSH-SAVED');
  });

  it('copy run start prompts for the destination filename over SSH and saves', async () => {
    const router = new CiscoRouter('R1');
    const shell = makeShell('cisco-ios', router);
    await shell.processLine('enable');
    await shell.processLine('configure terminal');
    await shell.processLine('hostname SSH-COPY');
    await shell.processLine('end');

    const ask = await shell.processLine('copy run start') as ShellLineResult;
    expect(ask.pendingInput?.promptText).toContain('Destination filename [startup-config]?');

    const done = await shell.handleInput!('');
    expect(done.output.join('\n')).toContain('[OK]');
    expect(await router.executeCommand('show startup-config')).toContain('hostname SSH-COPY');
  });

  it('plans stay privileged-only: erase in user EXEC goes to the device untouched', async () => {
    const router = new CiscoRouter('R1');
    const shell = makeShell('cisco-ios', router);
    const res = await shell.processLine('erase startup-config') as ShellLineResult;
    expect(res.pendingInput).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Huawei over SSH — save dialogue
// ═══════════════════════════════════════════════════════════════════

describe('Huawei save over SSH is interactive AND real', () => {
  it('asks Y/N, then really captures the saved configuration', async () => {
    const router = new HuaweiRouter('H1');
    const shell = makeShell('huawei-vrp', router);
    await shell.processLine('system-view');
    await shell.processLine('sysname SSH-VRP');
    await shell.processLine('quit');

    const ask = await shell.processLine('save') as ShellLineResult;
    expect(ask.output.join('\n')).toContain('Are you sure to continue? [Y/N]:');
    expect(ask.pendingInput).toBeDefined();

    const done = await shell.handleInput!('y');
    expect(done.output.join('\n')).toContain('[OK]');
    expect(await router.executeCommand('display saved-configuration')).toContain('SSH-VRP');
  });

  it('answering N cancels without saving', async () => {
    const router = new HuaweiRouter('H1');
    const shell = makeShell('huawei-vrp', router);
    await shell.processLine('system-view');
    await shell.processLine('sysname SSH-NOSAVE');
    await shell.processLine('quit');

    await shell.processLine('save');
    const done = await shell.handleInput!('n');
    expect(done.output.join('\n')).toContain('canceled');
    expect(await router.executeCommand('display saved-configuration')).not.toContain('SSH-NOSAVE');
  });
});
