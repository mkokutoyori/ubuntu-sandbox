import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { NanoLaunch } from '@/network/devices/linux/editors/editorLaunch';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 5));

let pc: LinuxPC;
let session: LinuxTerminalSession;
beforeEach(() => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  session = new LinuxTerminalSession('term-1', pc);
});

async function type(cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await flush();
}

const output = (count: number): string => session.lines.slice(-count).map((l) => l.text).join('\n');

describe('nano reads its command line in the local terminal', () => {
  it('bundled flags and a +LINE,COLUMN reach the engine as settings and a start', async () => {
    await pc.executeCommand('printf "a\\nb\\nc\\n" > /tmp/x.txt');
    await type('nano -lSc +2,1 /tmp/x.txt');
    const mode = session.inputMode as { type: string; nano?: NanoLaunch };
    expect(mode.type).toBe('editor');
    expect(mode.nano?.settings).toMatchObject({ linenumbers: true, softwrap: true, constantshow: true });
    expect(mode.nano?.start).toMatchObject({ line: 2, column: 1 });
  });

  it('options after the file name are honoured like GNU getopt does', async () => {
    await pc.executeCommand('printf "a\\n" > /tmp/y.txt');
    await type('nano /tmp/y.txt -v');
    const mode = session.inputMode as { type: string; nano?: NanoLaunch };
    expect(mode.nano?.settings.view).toBe(true);
  });

  it('-T with a bad number prints nano\'s sentence and stays at the prompt', async () => {
    await type('nano -T abc /tmp/z.txt');
    expect(session.inputMode.type).toBe('normal');
    expect(output(3)).toContain('Requested tab size "abc" is invalid');
  });

  it('an ambiguous long option lists the candidates in the order of nano\'s table', async () => {
    await type('nano --no /tmp/z.txt');
    expect(session.inputMode.type).toBe('normal');
    expect(output(4)).toContain("nano: option '--no' is ambiguous; possibilities: '--nowrap' '--nohelp' '--nonewlines' '--noconvert' '--noread'");
  });
});
