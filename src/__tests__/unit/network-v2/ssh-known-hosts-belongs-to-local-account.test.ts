import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import { installDefaultShells } from '@/shell/registerDefaults';

beforeEach(() => {
  installDefaultShells();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const MASK = new SubnetMask('255.255.255.0');
const key = (k: string) =>
  ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }) as never;

const flush = async () => {
  for (let i = 0; i < 40; i++) { await Promise.resolve(); await new Promise<void>((r) => setTimeout(r, 0)); }
};

interface Lab { term: WindowsTerminalSession; win: WindowsPC; linux: LinuxServer }

async function lab(): Promise<Lab> {
  const win = new WindowsPC('windows-pc', 'WIN1');
  const linux = new LinuxServer('linux-server', 'LNX1');
  win.getPorts()[0].configureIP(new IPAddress('10.0.40.1'), MASK);
  linux.getPorts()[0].configureIP(new IPAddress('10.0.40.2'), MASK);
  new Cable('c1').connect(win.getPorts()[0], linux.getPorts()[0]);
  const um = (linux as unknown as { executor: { userMgr: {
    useradd: (u: string, o?: object) => void;
    getUser: (u: string) => unknown;
    setPassword: (u: string, p: string) => void;
  } } }).executor.userMgr;
  // Set the password unconditionally: these accounts may already ship
  // with the image, in which case skipping would leave the fixture
  // asserting against a secret it never chose.
  for (const account of ['alice', 'bob']) {
    if (!um.getUser(account)) um.useradd(account, { m: true, s: '/bin/bash' });
    um.setPassword(account, 'admin');
  }
  const term = new WindowsTerminalSession('t1', win);
  await term.init?.();
  return { term, win, linux };
}

/** Drive `ssh <user>@10.0.40.2` to a successful login. */
async function sshAs(lab: Lab, user: string, password: string): Promise<void> {
  lab.term.setInput(`ssh ${user}@10.0.40.2`);
  lab.term.setInputBuf(`ssh ${user}@10.0.40.2`);
  lab.term.handleKey(key('Enter'));
  for (let i = 0; i < 60 && lab.term.foreground.currentInputMode.type !== 'password'; i++) await flush();
  lab.term.foreground.setPasswordBuf(password);
  lab.term.foreground.handleKey(key('Enter'));
  await flush();
}

const readFile = (win: WindowsPC, path: string) => win.getFileSystem().readFile(path);

/** The host key the target really presents, as the wire reads it. */
function realHostKey(linux: LinuxServer): { keyType: string; publicKey: string } {
  const raw = (linux as unknown as { executor: { vfs: { readFile: (p: string) => string | null } } })
    .executor.vfs.readFile('/etc/ssh/ssh_host_ed25519_key.pub') ?? '';
  const [keyType, publicKey] = raw.trim().split(/\s+/);
  return { keyType, publicKey };
}

describe('a client\'s known_hosts belongs to the account running the client', () => {
  it('records the host under the local profile, not the remote user\'s', async () => {
    const l = await lab();
    await sshAs(l, 'alice', 'admin');

    expect(
      readFile(l.win, 'C:\\Users\\User\\.ssh\\known_hosts').ok,
      'known_hosts is the local user\'s file — the remote account has no say in where it lives',
    ).toBe(true);
    expect(
      readFile(l.win, 'C:\\Users\\alice\\.ssh\\known_hosts').ok,
      'nothing should be written under a profile named after the remote account',
    ).toBe(false);
  }, 40000);

  it('two logins as different remote users share one store', async () => {
    const l = await lab();
    await sshAs(l, 'alice', 'admin');
    await sshAs(l, 'bob', 'admin');

    const store = readFile(l.win, 'C:\\Users\\User\\.ssh\\known_hosts');
    expect(store.ok).toBe(true);
    expect(
      (store.content ?? '').split('\n').filter((line) => line.includes('10.0.40.2')),
      'the host is known once, whichever account logged in',
    ).toHaveLength(1);
  }, 40000);

  it('records the key the target actually presents', async () => {
    const l = await lab();
    await sshAs(l, 'alice', 'admin');

    const expected = realHostKey(l.linux);
    const line = (readFile(l.win, 'C:\\Users\\User\\.ssh\\known_hosts').content ?? '')
      .split('\n').find((entry) => entry.includes('10.0.40.2')) ?? '';

    expect(
      line,
      'an entry that does not match what the server presents turns the next login into a host-key mismatch',
    ).toContain(expected.publicKey);
    expect(line.split(/\s+/).filter((t) => t === expected.keyType)).toHaveLength(1);
  }, 40000);
});
