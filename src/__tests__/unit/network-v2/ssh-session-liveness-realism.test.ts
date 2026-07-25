import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
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

interface Lab { term: LinuxTerminalSession; server: LinuxServer; cable: Cable }

async function sshedIn(): Promise<Lab> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'SRV1');
  pc.getPorts()[0].configureIP(new IPAddress('10.0.30.1'), MASK);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.30.2'), MASK);
  const cable = new Cable('c1');
  cable.connect(pc.getPorts()[0], srv.getPorts()[0]);

  const term = new LinuxTerminalSession('t1', pc);
  await term.init?.();
  term.setInput('ssh alice@10.0.30.2');
  term.handleKey(key('Enter'));
  for (let i = 0; i < 60 && term.currentInputMode.type !== 'password'; i++) await flush();
  term.setPasswordBuf('alice');
  term.handleKey(key('Enter'));
  await flush();
  return { term, server: srv, cable };
}

async function type(term: LinuxTerminalSession, line: string): Promise<void> {
  term.setInputBuf(line);
  term.handleKey(key('Enter'));
  await flush();
}

/** How many inbound TCP connections sshd has logged so far. */
function acceptedConnections(server: LinuxServer): number {
  const log = server.executeShellCommandSync('cat /var/log/auth.log');
  return (log.match(/Connection from \S+ port \d+ on/g) ?? []).length;
}

describe('an open SSH session does not reconnect to stay alive', () => {
  it('the session is established', async () => {
    const { term } = await sshedIn();
    expect(term.getPrompt()).toMatch(/alice@/);
  }, 30000);

  it('running commands opens no further connections', async () => {
    const { term, server } = await sshedIn();
    const afterLogin = acceptedConnections(server);

    for (const cmd of ['whoami', 'pwd', 'echo one', 'echo two', 'hostname']) {
      await type(term, cmd);
    }

    expect(
      acceptedConnections(server),
      'a real ssh client reuses its channel; it does not reconnect per command',
    ).toBe(afterLogin);
  }, 30000);

  it('but a pulled cable still breaks the session on the next command', async () => {
    const { term, cable } = await sshedIn();
    await type(term, 'whoami');
    cable.disconnect();
    await type(term, 'whoami');
    const text = term.lines.map((l) => l.text).join('\n');
    expect(text).toMatch(/Broken pipe/);
  }, 30000);
});
