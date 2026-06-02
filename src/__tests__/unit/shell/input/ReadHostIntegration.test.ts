import { describe, it, expect } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { PromiseInputBroker } from '@/shell/input';
import type { InputHost, InputCompletion, StreamAttachOptions, StreamAttachment } from '@/shell/input';
import type { InputRequest } from '@/shell/input/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function makeHost() {
  let pending: ((o: InputCompletion) => void) | null = null;
  const prompts: string[] = [];
  const modes: ('password' | 'text')[] = [];
  const host: InputHost = {
    requestInput(req: InputRequest, complete) {
      prompts.push(req.prompt);
      modes.push(req.kind === 'password' || req.mask === true || req.echo === false ? 'password' : 'text');
      pending = complete;
    },
    cancelRequest() { pending = null; },
    emit() {},
    attachStream(_opts: StreamAttachOptions): StreamAttachment {
      return { id: 'x', description: '', active: true, cancel() {} };
    },
    detachAllStreams() {},
    capabilities() { return { interactive: true, maskedSupported: true, streaming: true }; },
  };
  return {
    host,
    prompts, modes,
    pump(value: string) { const cb = pending; pending = null; cb?.({ status: 'submitted', value }); },
    cancel() { const cb = pending; pending = null; cb?.({ status: 'cancelled' }); },
  };
}

function setup() {
  EquipmentRegistry.resetInstance();
  const pc = new WindowsPC('win-pc', 'WIN', 0, 0);
  pc.powerOn();
  const { subShell } = PowerShellSubShell.create(pc);
  const h = makeHost();
  subShell.setInputHost(h.host);
  return { pc, subShell, h };
}

describe('Read-Host via the unified input broker', () => {
  it('Read-Host -Prompt prompts in text mode and returns the response', async () => {
    const { subShell, h } = setup();
    const p = subShell.processLine('Read-Host -Prompt "Name"');
    await new Promise(r => setTimeout(r, 5));
    expect(h.modes[0]).toBe('text');
    expect(h.prompts[0]).toBe('Name');
    h.pump('Alice');
    const r = await p;
    expect(r.output.join('')).toBe('Alice');
  });

  it('$user = Read-Host binds the result to the named PS variable', async () => {
    const { subShell, h } = setup();
    const p = subShell.processLine('$user = Read-Host -Prompt "Enter user"');
    await new Promise(r => setTimeout(r, 5));
    h.pump('admin');
    await p;
    const r = await subShell.processLine('$user');
    expect(r.output.join('')).toContain('admin');
  });

  it('Read-Host -AsSecureString prompts in password mode', async () => {
    const { subShell, h } = setup();
    const p = subShell.processLine('Read-Host -AsSecureString -Prompt "Password"');
    await new Promise(r => setTimeout(r, 5));
    expect(h.modes[0]).toBe('password');
    h.pump('s3cret');
    const r = await p;
    expect(r.output.join('')).toBe('s3cret');
  });

  it('cancellation surfaces an empty binding', async () => {
    const { subShell, h } = setup();
    const p = subShell.processLine('$x = Read-Host -Prompt "X"');
    await new Promise(r => setTimeout(r, 5));
    h.cancel();
    const r = await p;
    expect(r.output).toEqual([]);
    expect((await subShell.processLine('$x')).output.join('')).toBe('');
  });
});

describe('PromiseInputBroker reuses across PS sub-shell prompts', () => {
  it('two consecutive Read-Host invocations both reach the host', async () => {
    const { subShell, h } = setup();
    const broker = new PromiseInputBroker(h.host);
    expect(broker.capabilities().interactive).toBe(true);
    const first = subShell.processLine('$a = Read-Host -Prompt "first"');
    await new Promise(r => setTimeout(r, 5));
    h.pump('one');
    await first;
    const second = subShell.processLine('$b = Read-Host -Prompt "second"');
    await new Promise(r => setTimeout(r, 5));
    h.pump('two');
    await second;
    const a = await subShell.processLine('$a');
    const b = await subShell.processLine('$b');
    expect(a.output.join('')).toBe('one');
    expect(b.output.join('')).toBe('two');
  });

  it('read-host (lowercase) is recognised — PowerShell verbs are case-insensitive', async () => {
    const { subShell, h } = setup();
    const p = subShell.processLine('$x = read-host -Prompt "lc"');
    await new Promise(r => setTimeout(r, 5));
    h.pump('answer');
    const r = await p;
    expect(r.output.join('\n')).not.toMatch(/not recognized/i);
    const x = await subShell.processLine('$x');
    expect(x.output.join('')).toBe('answer');
  });
});
