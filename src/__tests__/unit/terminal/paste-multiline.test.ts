/**
 * Multi-line paste — LinuxTerminalSession.pasteText spec.
 *
 * A pasted block of commands runs each newline-terminated line in turn
 * (waiting for each to finish before the next) and leaves the final
 * unterminated line editable in the prompt, the way a real terminal
 * handles a bracketed paste.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function lineTexts(s: LinuxTerminalSession): string[] {
  return s.lines.map((l) => l.text);
}

let pc: LinuxPC;
let session: LinuxTerminalSession;
beforeEach(() => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  session = new LinuxTerminalSession('term-1', pc);
});

describe('LinuxTerminalSession.pasteText', () => {
  it('executes every complete line of a pasted block', async () => {
    await session.pasteText('echo alpha\necho beta\necho gamma\n');
    const out = lineTexts(session).join('\n');
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
    expect(out).toContain('gamma');
    expect(session.input).toBe('');
  });

  it('leaves the final unterminated line editable in the prompt', async () => {
    await session.pasteText('echo done\npartial-command');
    expect(lineTexts(session).join('\n')).toContain('done');
    expect(session.input).toBe('partial-command');
  });

  it('appends the pasted block to whatever is already typed', async () => {
    session.setInput('echo ');
    await session.pasteText('first\necho second');
    const out = lineTexts(session).join('\n');
    expect(out).toContain('first');
    expect(session.input).toBe('echo second');
  });

  it('runs the lines in order', async () => {
    await session.pasteText('echo one\necho two\necho three\n');
    const out = lineTexts(session).join('\n');
    expect(out.indexOf('one')).toBeLessThan(out.indexOf('two'));
    expect(out.indexOf('two')).toBeLessThan(out.indexOf('three'));
  });

  it('a single line without a newline is just inserted, not executed', async () => {
    await session.pasteText('echo not-run-yet');
    expect(session.input).toBe('echo not-run-yet');
    expect(lineTexts(session).join('\n')).not.toContain('not-run-yet\n');
  });

  it('normalises CRLF line endings', async () => {
    await session.pasteText('echo win\r\necho lines\r\n');
    const out = lineTexts(session).join('\n');
    expect(out).toContain('win');
    expect(out).toContain('lines');
    expect(session.input).toBe('');
  });

  it('carriage-return only endings are handled too', async () => {
    await session.pasteText('echo mac\recho classic\r');
    const out = lineTexts(session).join('\n');
    expect(out).toContain('mac');
    expect(out).toContain('classic');
  });

  it('insertText flattens embedded newlines into the current input', () => {
    session.setInput('pre-');
    session.insertText('a\nb\nc');
    expect(session.input).toBe('pre-a b c');
  });
});
