import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { isOk } from '@/network/protocols/ssh/Result';
import type { ISshShellChannel } from '@/network/protocols/ssh/channels/ISshChannel';
import type { VimEditorView, NanoEditorView } from '@/network/devices/linux/editors/EditorView';
import { installDefaultShells } from '@/shell/registerDefaults';

beforeEach(() => {
  installDefaultShells();
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const MASK = new SubnetMask('255.255.255.0');

interface Wired {
  channel: ISshShellChannel;
  server: LinuxServer;
}

async function wire(): Promise<Wired> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'SRV1');
  pc.getPorts()[0].configureIP(new IPAddress('10.0.15.1'), MASK);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.15.2'), MASK);
  new Cable('c1').connect(pc.getPorts()[0], srv.getPorts()[0]);

  const dev = pc as unknown as { tcpConnect(h: string, p: number): Promise<unknown> };
  const session = new SshSession({
    tcpConnector: ((h: string, p: number) => dev.tcpConnect(h, p)) as never,
    vfs: { readFile: () => null, writeFile: () => undefined, resolveInode: () => null, mkdirp: () => undefined } as never,
    localUser: 'user', localUid: 1000, localGid: 1000,
    knownHostsPath: '/home/user/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler(),
  } as never);
  const opts = SshConnectOptionsBuilder.create()
    .host('10.0.15.2').user('alice').password('alice').strictHostKeyChecking('no').build();
  const connected = await session.connect(opts);
  if (!isOk(connected)) throw new Error('connect failed: ' + JSON.stringify((connected as { error: unknown }).error));
  const channel = session.openShellChannel();
  if (!isOk(channel)) throw new Error('shell channel failed');
  return { channel: channel.value, server: srv };
}

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
