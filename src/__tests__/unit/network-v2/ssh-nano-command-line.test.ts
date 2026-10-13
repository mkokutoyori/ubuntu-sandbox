import { describe, it, expect } from 'vitest';
import type { NanoEditorView } from '@/network/devices/linux/editors/EditorView';
import { plainRowText } from '@/network/devices/linux/editors/screen/EditorScreen';
import { resetSshShellLab, wireShellChannel } from './_helpers/sshShellChannelLab';

resetSshShellLab();

const row = (view: NanoEditorView, index: number): string => plainRowText(view.screen.rows[index]).trimEnd();

describe('nano over SSH reads its command line like nano 7.2', () => {
  it('TEMOIN : a plain file opens on the server and says how many lines it read', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'one\\ntwo foo\\nthree\\n' > /tmp/c0.txt`);
    const view = await channel.openEditor('nano /tmp/c0.txt') as NanoEditorView;
    expect(row(view, 1)).toBe('one');
    expect(row(view, 21)).toContain('[ Read 3 lines ]');
  }, 30000);

  it('-l +2 turns the line numbers on and puts the cursor on line 2', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'one\\ntwo foo\\nthree\\n' > /tmp/c1.txt`);
    const view = await channel.openEditor('nano -l +2 /tmp/c1.txt') as NanoEditorView;
    expect(row(view, 1)).toBe(' 1 one');
    expect(view.screen.cursor).toEqual({ row: 2, col: 3 });
  }, 30000);

  it('+/foo searches from the top and lands on the first match', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'one\\ntwo foo\\nthree\\n' > /tmp/c2.txt`);
    const view = await channel.openEditor('nano +/foo /tmp/c2.txt') as NanoEditorView;
    expect(view.screen.cursor).toEqual({ row: 2, col: 4 });
  }, 30000);

  it('-v opens the buffer in view mode', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'one\\n' > /tmp/c3.txt`);
    const view = await channel.openEditor('nano -v /tmp/c3.txt') as NanoEditorView;
    expect(row(view, 0)).toContain('View');
  }, 30000);

  it('prints the usage of nano 7.2 and opens nothing for -h', async () => {
    const { channel } = await wireShellChannel();
    const result = await channel.runLine('nano -h');
    expect(result.stdout.split('\n')[0]).toBe('Usage: nano [OPTIONS] [[+LINE[,COLUMN]] FILE]...');
    expect(result.stdout).toContain(' -T <number>    --tabsize=<number>      Make a tab this number of columns wide');
  }, 30000);

  it('refuses an unknown option with the words and the hint of nano', async () => {
    const { channel } = await wireShellChannel();
    const result = await channel.runLine('nano --zork=3 /tmp/c4.txt');
    expect(result.stdout).toContain("nano: unrecognized option '--zork=3'");
    expect(result.stdout).toContain("Type 'nano -h' for a list of available options.");
    expect(result.exitCode).toBe(1);
  }, 30000);

  it('refuses a tab size that is not a positive number', async () => {
    const { channel } = await wireShellChannel();
    const result = await channel.runLine('nano -T 0 /tmp/c5.txt');
    expect(result.stdout).toContain('Requested tab size "0" is invalid');
    expect(result.exitCode).toBe(1);
  }, 30000);
});
