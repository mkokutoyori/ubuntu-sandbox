/**
 * The CLI session a router mints for an SSH or telnet channel plays the
 * interaction plans of its shell: `enable` asks for the secret, a vty with
 * no secret refuses, an outbound `ssh` asks for its password.
 *
 * Measured before the fix: `createVtyShell().execute()` went straight to the
 * trie. `enable` raised the session to level 15 without any secret on a
 * network line, and `ssh -l admin <host>` typed inside a remote Cisco session
 * answered "% Password: required. Outbound SSH asks for it through its
 * interaction prompt." with no way to give one. The wire already carries a
 * pendingInput / provideInput pair (the Windows and Linux contexts use it);
 * the router context did not forward it.
 *
 * Discriminated with `git stash push -- src/network`: 4 of the 5 router cases
 * and both switch cases fall before the fix. The one that passes either way is the WITNESS: the lab's
 * router really carries an enable secret (the console accepts it
 * headlessly), so a refusal on the vty is the vty's doing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Vty {
  execute(c: string): Promise<string> | string;
  lastPendingInput(): { kind: string; promptText: string } | null;
  handleInput(v: string): Promise<string>;
  getPrompt(): string;
}

async function configured(secret: boolean): Promise<CiscoRouter> {
  const r = new CiscoRouter('router-cisco', 'R1', 0, 0);
  const lines = ['enable', 'configure terminal', ...(secret ? ['enable secret s3cret'] : []), 'end', 'disable'];
  for (const c of lines) await r.executeCommand(c);
  return r;
}

const vtyOf = (r: CiscoRouter): Vty => (r as unknown as { createVtyShell(u?: string): Vty }).createVtyShell('guest');

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

describe('a router vty plays interaction plans', () => {
  it('WITNESS: the console accepts the secret headlessly', async () => {
    const r = await configured(true);
    await r.executeCommand('enable', { passwordInput: 's3cret' });
    expect(r.getPrompt()).toContain('#');
  });

  it('enable asks for the secret on a vty', async () => {
    const vty = vtyOf(await configured(true));
    await vty.execute('enable');
    expect(vty.lastPendingInput()?.kind).toBe('password');
    expect(vty.getPrompt()).toContain('>');
  });

  it('the right secret raises the session, a wrong one does not', async () => {
    const vty = vtyOf(await configured(true));
    await vty.execute('enable');
    await vty.handleInput('wrong');
    expect(vty.getPrompt()).toContain('>');
    await vty.handleInput('s3cret');
    expect(vty.getPrompt()).toContain('#');
  });

  it('a vty with no enable secret refuses instead of granting level 15', async () => {
    const vty = vtyOf(await configured(false));
    const out = await vty.execute('enable');
    expect(out).toContain('% No password set');
    expect(vty.getPrompt()).toContain('>');
  });

  it('an outbound ssh typed on the vty asks for its password', async () => {
    const vty = vtyOf(await configured(true));
    await vty.execute('enable');
    await vty.handleInput('s3cret');
    await vty.execute('ssh -l admin 10.0.0.8');
    expect(vty.lastPendingInput()?.promptText).toMatch(/Password/i);
  });
});

describe('a switch vty plays interaction plans too', () => {
  it('enable asks for the secret on a Cisco switch vty', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 24, 0, 0);
    for (const c of ['enable', 'configure terminal', 'enable secret s3cret', 'end', 'disable']) await sw.executeCommand(c);
    const vty = (sw as unknown as { createVtyShell(u?: string): Vty }).createVtyShell('guest');
    await vty.execute('enable');
    expect(vty.lastPendingInput()?.kind).toBe('password');
    await vty.handleInput('s3cret');
    expect(vty.getPrompt()).toContain('#');
  });

  it('a Cisco switch vty with no enable secret refuses', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 24, 0, 0);
    const vty = (sw as unknown as { createVtyShell(u?: string): Vty }).createVtyShell('guest');
    expect(await vty.execute('enable')).toContain('% No password set');
  });
});
