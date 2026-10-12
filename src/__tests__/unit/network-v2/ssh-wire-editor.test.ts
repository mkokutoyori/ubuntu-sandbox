import { describe, it, expect } from 'vitest';
import type { VimEditorView, NanoEditorView } from '@/network/devices/linux/editors/EditorView';
import { resetSshShellLab, wireShellChannel as wire } from './_helpers/sshShellChannelLab';

resetSshShellLab();

function typeText(text: string): Array<{ key: string }> {
  return [...text].map((c) => ({ key: c }));
}

describe('editors run on the server side of the SSH wire (docs/PRD-SSH-Unification.md §4bis B3)', () => {
  it('a plain command line opens no editor', async () => {
    const { channel } = await wire();
    expect(await channel.openEditor('echo hello')).toBeNull();
  }, 30000);

  it('vim opens a buffer on the remote file, not a local one', async () => {
    const { channel, server } = await wire();
    await channel.runLine('echo remote-content > /tmp/b3.txt');
    const view = await channel.openEditor('vim /tmp/b3.txt') as VimEditorView;
    expect(view.kind).toBe('vim');
    expect(view.lines.join('\n')).toContain('remote-content');
    expect(server.executeShellCommandSync('cat /tmp/b3.txt')).toContain('remote-content');
  }, 30000);

  it('keystrokes edit the buffer and :wq writes the REMOTE file', async () => {
    const { channel, server } = await wire();
    await channel.runLine('echo before > /tmp/b3w.txt');
    await channel.openEditor('vim /tmp/b3w.txt');
    for (const k of [{ key: 'd' }, { key: 'd' }, { key: 'i' }, ...typeText('after'), { key: 'Escape' }]) {
      await channel.sendEditorKey(k);
    }
    let view = await channel.sendEditorKey({ key: ':' }) as VimEditorView;
    for (const k of typeText('wq')) view = await channel.sendEditorKey(k) as VimEditorView;
    view = await channel.sendEditorKey({ key: 'Enter' }) as VimEditorView;

    expect(view.exited).toBe(true);
    expect(view.savedOnExit).toBe(true);
    expect(server.executeShellCommandSync('cat /tmp/b3w.txt')).toContain('after');
  }, 30000);

  it('nano opens with its own view shape', async () => {
    const { channel } = await wire();
    await channel.runLine('echo nano-line > /tmp/b3n.txt');
    const view = await channel.openEditor('nano /tmp/b3n.txt') as NanoEditorView;
    expect(view.kind).toBe('nano');
    expect(view.lines.join('\n')).toContain('nano-line');
    expect(view.statusMessage).toContain('Read');
  }, 30000);

  it('a new file opens empty and is created on the remote when saved', async () => {
    const { channel, server } = await wire();
    const opened = await channel.openEditor('vim /tmp/b3new.txt') as VimEditorView;
    expect(opened.lines).toEqual(['']);

    for (const k of [{ key: 'i' }, ...typeText('created'), { key: 'Escape' }, { key: ':' }, ...typeText('wq'), { key: 'Enter' }]) {
      await channel.sendEditorKey(k);
    }
    expect(server.executeShellCommandSync('cat /tmp/b3new.txt')).toContain('created');
  }, 30000);

  it('the shell keeps working once the editor has closed', async () => {
    const { channel } = await wire();
    await channel.openEditor('vim /tmp/b3q.txt');
    for (const k of [{ key: ':' }, { key: 'q' }, { key: '!' }, { key: 'Enter' }]) {
      await channel.sendEditorKey(k);
    }
    const res = await channel.runLine('whoami') as { stdout: string };
    expect(res.stdout).toContain('alice');
  }, 30000);

  it('an unwritable path reports the remote refusal, not a local success', async () => {
    const { channel, server } = await wire();
    await channel.openEditor('vim /etc/b3-denied.txt');
    let view: VimEditorView | null = null;
    for (const k of [{ key: 'i' }, ...typeText('x'), { key: 'Escape' }, { key: ':' }, ...typeText('w'), { key: 'Enter' }]) {
      view = await channel.sendEditorKey(k) as VimEditorView;
    }
    expect(view!.message).toMatch(/E212|can't open|denied/i);
    expect(server.executeShellCommandSync('cat /etc/b3-denied.txt')).toMatch(/No such file/);
  }, 30000);
});
