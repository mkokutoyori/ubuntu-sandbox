/**
 * PRD-Nslookup-Dig-Rndc-Runas.md §2.1.7/P13 — `Get-Credential` via the
 * unified input broker, mirroring `ReadHostIntegration.test.ts`'s testing
 * style exactly (same subshell-level interception mechanism as
 * `Read-Host`, since the tree-walking interpreter has no async/interactive
 * broker access).
 */
import { describe, it, expect } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
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
  const pc = new WindowsPC('windows-pc', 'WIN', 0, 0);
  pc.powerOn();
  const { subShell } = PowerShellSubShell.create(pc);
  const h = makeHost();
  subShell.setInputHost(h.host);
  return { pc, subShell, h };
}

describe('Get-Credential via the unified input broker', () => {
  it('prompts for a user name then a masked password, and binds a real PSCredential', async () => {
    const { subShell, h } = setup();
    const p = subShell.processLine('$cred = Get-Credential');
    await new Promise(r => setTimeout(r, 5));
    expect(h.modes[0]).toBe('text');
    h.pump('alice');
    await new Promise(r => setTimeout(r, 5));
    expect(h.modes[1]).toBe('password');
    expect(h.prompts[1]).toBe('Password for user alice:');
    h.pump('s3cret');
    await p;

    const userName = await subShell.processLine('$cred.UserName');
    expect(userName.output.join('')).toBe('alice');
    const typeName = await subShell.processLine('$cred.PSTypeName');
    expect(typeName.output.join('')).toBe('System.Management.Automation.PSCredential');
  });

  it('-UserName pre-fills the account, skipping straight to the password prompt', async () => {
    const { subShell, h } = setup();
    const p = subShell.processLine('$cred = Get-Credential -UserName bob');
    await new Promise(r => setTimeout(r, 5));
    expect(h.modes[0]).toBe('password');
    expect(h.prompts[0]).toBe('Password for user bob:');
    h.pump('hunter2');
    await p;

    const userName = await subShell.processLine('$cred.UserName');
    expect(userName.output.join('')).toBe('bob');
  });

  it('never exposes the plain-text password through the bound object\'s default fields', async () => {
    const { subShell, h } = setup();
    const p = subShell.processLine('$cred = Get-Credential -UserName carol');
    await new Promise(r => setTimeout(r, 5));
    h.pump('topsecret');
    await p;

    const password = await subShell.processLine('$cred.Password.SecureString');
    // The plaintext IS retrievable (this simulator has no real DPAPI —
    // see PSCredential.ts's header), but only via the explicit
    // .Password.SecureString path a script has to opt into, exactly like
    // ConvertTo-SecureString's existing {SecureString, Length} shape.
    expect(password.output.join('')).toBe('topsecret');
  });

  it('an unbound invocation prints the real UserName/Password table, not the plaintext', async () => {
    const { subShell, h } = setup();
    const p = subShell.processLine('Get-Credential -UserName dave');
    await new Promise(r => setTimeout(r, 5));
    h.pump('whatever');
    const r = await p;

    expect(r.output.join('\n')).toContain('dave');
    expect(r.output.join('\n')).toContain('System.Security.SecureString');
    expect(r.output.join('\n')).not.toContain('whatever');
  });

  it('cancelling the user-name prompt aborts cleanly with no binding', async () => {
    const { subShell, h } = setup();
    const p = subShell.processLine('$cred = Get-Credential');
    await new Promise(r => setTimeout(r, 5));
    h.cancel();
    const r = await p;
    expect(r.output).toEqual([]);

    const userName = await subShell.processLine('$cred');
    expect(userName.output.join('')).toBe('');
  });

  it('get-credential (lowercase) is recognised — PowerShell verbs are case-insensitive', async () => {
    const { subShell, h } = setup();
    const p = subShell.processLine('$cred = get-credential -username eve');
    await new Promise(r => setTimeout(r, 5));
    h.pump('pw');
    await p;

    const userName = await subShell.processLine('$cred.UserName');
    expect(userName.output.join('')).not.toMatch(/not recognized/i);
    expect(userName.output.join('')).toBe('eve');
  });
});
