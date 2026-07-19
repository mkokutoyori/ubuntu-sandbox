/**
 * Interactive line continuation (PS2) in the Linux terminal session.
 *
 * Typing an incomplete command (open quote, trailing `\`, dangling
 * connector, unfinished block, here-document) makes the terminal show the
 * `>` continuation prompt and keep collecting until the command is whole,
 * then runs the assembled multi-line command — exactly like real bash.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 10));

describe('Linux terminal PS2 continuation', () => {
  let session: LinuxTerminalSession;

  beforeEach(async () => {
    resetCounters();
    resetDeviceCounters();
    MACAddress.resetCounter();
    Logger.reset();
    EquipmentRegistry.resetInstance();
    const bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    const manager = new TerminalManager(bus);
    const pc = new LinuxPC('PC1', 0, 0);
    pc.setEventBus(bus);
    const sid = manager.openTerminal(pc)!;
    session = manager.getSession(sid) as LinuxTerminalSession;
    await session.init?.();
  });

  async function type(cmd: string): Promise<void> {
    session.setInput(cmd);
    session.handleKey(key('Enter'));
    await flush();
  }

  function screen(): string {
    return session.lines.map((l) => (typeof l === 'string' ? l : (l as { text?: string }).text ?? '')).join('\n');
  }

  it('shows the > prompt after a trailing backslash, then runs the joined command', async () => {
    await type('echo hello \\');
    expect(session.getPrompt()).toBe('> ');
    await type('world');
    expect(session.getPrompt()).not.toBe('> ');
    expect(screen()).toContain('hello world');
  });

  it('continues an open single quote until it closes', async () => {
    await type("echo 'line one");
    expect(session.getPrompt()).toBe('> ');
    await type("line two'");
    expect(session.getPrompt()).not.toBe('> ');
    expect(screen()).toContain('line one\nline two');
  });

  it('collects a here-document until its delimiter', async () => {
    await type('cat <<EOF');
    expect(session.getPrompt()).toBe('> ');
    await type('alpha');
    expect(session.getPrompt()).toBe('> ');
    await type('beta');
    expect(session.getPrompt()).toBe('> ');
    await type('EOF');
    expect(session.getPrompt()).not.toBe('> ');
    const out = screen();
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
  });

  it('continues a dangling pipe onto the next line', async () => {
    await type('echo foo |');
    expect(session.getPrompt()).toBe('> ');
    await type('grep foo');
    expect(session.getPrompt()).not.toBe('> ');
    expect(screen()).toContain('foo');
  });

  it('a complete command never enters continuation', async () => {
    await type('echo direct');
    expect(session.getPrompt()).not.toBe('> ');
    expect(screen()).toContain('direct');
  });
});
