import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { RemoteVimController } from '@/terminal/editors/RemoteEditorController';
import { installDefaultShells } from '@/shell/registerDefaults';

beforeEach(() => {
  installDefaultShells();
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const MASK = new SubnetMask('255.255.255.0');
const key = (k: string, mods: Record<string, boolean> = {}) =>
  ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods }) as never;

const flush = async () => {
  for (let i = 0; i < 40; i++) { await Promise.resolve(); await new Promise<void>((r) => setTimeout(r, 0)); }
};

interface Lab { term: LinuxTerminalSession; server: LinuxServer }

async function sshedIn(): Promise<Lab> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'SRV1');
  pc.getPorts()[0].configureIP(new IPAddress('10.0.16.1'), MASK);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.16.2'), MASK);
  new Cable('c1').connect(pc.getPorts()[0], srv.getPorts()[0]);

  const term = new LinuxTerminalSession('t1', pc);
  await term.init?.();
  term.setInput('ssh alice@10.0.16.2');
  term.handleKey(key('Enter'));
  for (let i = 0; i < 60 && term.currentInputMode.type !== 'password'; i++) await flush();
  term.setPasswordBuf('alice');
  term.handleKey(key('Enter'));
  await flush();
  return { term, server: srv };
}

async function typeInSubShell(term: LinuxTerminalSession, line: string): Promise<void> {
  term.setInputBuf(line);
  term.handleKey(key('Enter'));
  await flush();
}

describe('the terminal opens a remote editor when one is typed in an SSH session (docs/PRD-SSH-Unification.md §4bis B3)', () => {
  it('an ssh session is established first', async () => {
    const { term } = await sshedIn();
    expect(term.getPrompt()).toMatch(/alice@/);
  }, 30000);

  it('vim on a remote path opens the overlay in remote mode', async () => {
    const { term, server } = await sshedIn();
    server.executeShellCommandSync('echo remote-body > /tmp/t3.txt');
    await typeInSubShell(term, 'vim /tmp/t3.txt');

    const mode = term.currentInputMode;
    expect(mode.type).toBe('remote-editor');
    const controller = (mode as { controller: RemoteVimController }).controller;
    expect(controller.lines.join('\n')).toContain('remote-body');
  }, 30000);

  it('an ordinary command is still just a command', async () => {
    const { term } = await sshedIn();
    await typeInSubShell(term, 'echo not-an-editor');
    expect(term.currentInputMode.type).not.toBe('remote-editor');
    expect(term.lines.map((l) => l.text).join('\n')).toContain('not-an-editor');
  }, 30000);

  it('editing and saving writes the REMOTE file, then hands the prompt back', async () => {
    const { term, server } = await sshedIn();
    // Created through the session itself so the file belongs to alice —
    // the remote's own permissions apply to the editor's write.
    await typeInSubShell(term, 'echo old > /tmp/t3w.txt');
    await typeInSubShell(term, 'vim /tmp/t3w.txt');

    const controller = (term.currentInputMode as { controller: RemoteVimController }).controller;
    for (const k of [{ key: 'd' }, { key: 'd' }, { key: 'i' }, ...[...'fresh'].map((c) => ({ key: c })),
      { key: 'Escape' }, { key: ':' }, { key: 'w' }, { key: 'q' }, { key: 'Enter' }]) {
      controller.applyKey(k);
      await flush();
    }

    expect(server.executeShellCommandSync('cat /tmp/t3w.txt')).toContain('fresh');
    expect(controller.exited).toBe(true);
  }, 30000);

  it('quitting the editor returns to the remote shell prompt', async () => {
    const { term } = await sshedIn();
    await typeInSubShell(term, 'vim /tmp/t3q.txt');
    const controller = (term.currentInputMode as { controller: RemoteVimController }).controller;
    for (const k of [{ key: ':' }, { key: 'q' }, { key: '!' }, { key: 'Enter' }]) {
      controller.applyKey(k);
      await flush();
    }
    expect(term.currentInputMode.type).not.toBe('remote-editor');
    expect(term.getPrompt()).toMatch(/alice@/);
  }, 30000);

  it('nano over the wire opens its own overlay', async () => {
    const { term, server } = await sshedIn();
    server.executeShellCommandSync('echo nano-body > /tmp/t3n.txt');
    await typeInSubShell(term, 'nano /tmp/t3n.txt');
    const mode = term.currentInputMode as { type: string; editorType?: string };
    expect(mode.type).toBe('remote-editor');
    expect(mode.editorType).toBe('nano');
  }, 30000);
});
