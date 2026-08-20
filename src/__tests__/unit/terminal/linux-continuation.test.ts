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
function ctrl(k: string): KeyEvent {
  return { key: k, ctrlKey: true, altKey: false, metaKey: false, shiftKey: false };
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

  describe('abandoning and ending a here-document', () => {
    it('Ctrl+C gives the prompt back and drops what was collected', async () => {
      await type('cat <<EOF');
      await type('alpha');
      expect(session.getPrompt()).toBe('> ');

      session.handleKey(ctrl('c'));
      await flush();
      expect(
        session.getPrompt(),
        'a Ctrl+C at a PS2 prompt returns to PS1, as in bash',
      ).not.toBe('> ');

      await type('echo after');
      const afterInterrupt = screen().split('^C')[1] ?? '';
      expect(afterInterrupt).toContain('after');
      expect(
        afterInterrupt,
        'the abandoned body must not come back attached to the next command',
      ).not.toContain('alpha');
    });

    it('Ctrl+C also abandons a continuation that is not a here-document', async () => {
      await type("echo 'open");
      expect(session.getPrompt()).toBe('> ');
      session.handleKey(ctrl('c'));
      await flush();
      expect(session.getPrompt()).not.toBe('> ');
    });

    it('Ctrl+D ends the here-document with a warning and keeps the session', async () => {
      await type('cat <<EOF');
      await type('alpha');
      session.setInput('');
      session.handleKey(ctrl('d'));
      await flush();

      const out = screen();
      expect(out).toMatch(/bash: warning: here-document at line \d+ delimited by end-of-file \(wanted `EOF'\)/);
      expect(out, 'the command still runs, with the body collected so far').toContain('alpha');
      expect(session.getPrompt(), 'and the shell is back at PS1').not.toBe('> ');
    });

    it('Ctrl+D on an empty line outside a here-document still closes the terminal', async () => {
      let closed = false;
      session.onRequestClose(() => { closed = true; });
      session.setInput('');
      session.handleKey(ctrl('d'));
      await flush();
      expect(closed).toBe(true);
    });
  });

  describe('Tab inside a here-document body', () => {
    it('inserts a tab instead of completing', async () => {
      await type('cat <<EOF');
      session.setInput('al');
      session.handleKey(key('Tab'));
      await flush();
      expect(session.input).toBe('al\t');
      expect(session.tabSuggestions).toBeNull();
    });

    it('still completes normally once the here-document is closed', async () => {
      await type('cat <<EOF');
      await type('EOF');
      session.setInput('ec');
      session.handleKey(key('Tab'));
      await flush();
      expect(session.input).not.toBe('ec\t');
    });
  });

  describe('several here-documents opened on one line', () => {
    it('waits for the first delimiter, then the second', async () => {
      await type('cat <<A <<B');
      expect(session.getPrompt()).toBe('> ');
      await type('body-a');
      await type('A');
      expect(
        session.getPrompt(),
        'closing A leaves B still open — the command is not complete yet',
      ).toBe('> ');
      await type('body-b');
      await type('B');
      expect(session.getPrompt()).not.toBe('> ');
    });
  });

  describe('the optional delimiter hint', () => {
    it('says nothing unless it is turned on', async () => {
      await type('cat <<EOF');
      expect(session.getHeredocHint()).toBeNull();
      expect(session.getPrompt(), 'the PS2 prompt itself stays bare').toBe('> ');
    });

    it('names the awaited delimiter once enabled, without touching the prompt', async () => {
      session.setHeredocHintEnabled(true);
      await type('cat <<EOF');
      expect(session.getHeredocHint()).toBe('waiting for: EOF');
      expect(session.getPrompt()).toBe('> ');
      await type('EOF');
      expect(session.getHeredocHint()).toBeNull();
    });

    it('stays quiet for a continuation that is not a here-document', async () => {
      session.setHeredocHintEnabled(true);
      await type('echo foo |');
      expect(session.getHeredocHint()).toBeNull();
    });
  });
});
