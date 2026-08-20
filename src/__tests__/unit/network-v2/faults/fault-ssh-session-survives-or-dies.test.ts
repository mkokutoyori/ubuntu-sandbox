/**
 * What an ESTABLISHED ssh session does when something breaks under it.
 *
 * The operator is logged in and typing. Then: the daemon is stopped, the
 * remote is switched off, a switch or router in the middle loses power, a
 * cable is pulled. Each of those is a different fault, and — this is the
 * part worth simulating — they do NOT all end the session.
 *
 * A real client never reconnects to find out. It writes on the channel it
 * already holds and learns from the failure. So liveness here is READ,
 * never provoked: from this side's own socket, and from the cabled path.
 * Neither moves a frame, and neither makes the server log an accept/close
 * pair for every command typed.
 *
 * The one that surprises people is `systemctl stop ssh`: the session
 * SURVIVES. Debian's `ssh.service` is `KillMode=process`, so stopping it
 * kills the listener and leaves established sessions alone — which is
 * exactly why restarting sshd over ssh is safe. Getting that "right" by
 * killing the session would be wrong, not stricter.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

const MASK = new SubnetMask('255.255.255.0');
const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

interface Lab {
  cli: LinuxPC; srv: LinuxServer; sw: GenericSwitch;
  cableToServer: Cable; t: LinuxTerminalSession;
}

/** CLI —— SW —— SRV, with an interactive ssh session already open on SRV. */
async function connectedLab(): Promise<Lab> {
  const cli = new LinuxPC('linux-pc', 'CLI');
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV');
  cli.configureInterface('eth0', new IPAddress('10.0.0.1'), MASK);
  srv.configureInterface('eth0', new IPAddress('10.0.0.2'), MASK);
  new Cable('c1').connect(cli.getPort('eth0')!, sw.getPorts()[0]);
  const cableToServer = new Cable('c2');
  cableToServer.connect(srv.getPort('eth0')!, sw.getPorts()[1]);

  await srv.executeCommand('useradd -m alice');
  await srv.executeCommand('sh -c "echo \'alice:secret\' | chpasswd"');

  const t = new LinuxTerminalSession('t', cli);
  await t.init();
  t.setInput('ssh alice@10.0.0.2');
  t.handleKey(key('Enter'));
  await flush();
  if (t.foreground.currentInputMode.type === 'password') {
    t.setPasswordBuf('secret');
    t.handleKey(key('Enter'));
    await flush();
  }
  return { cli, srv, sw, cableToServer, t };
}

/** Type a line into whatever is in the foreground (remote or local). */
async function type(t: LinuxTerminalSession, line: string): Promise<void> {
  t.foreground.setInput(line);
  t.foreground.setInputBuf(line);
  t.handleKey(key('Enter'));
  await flush();
}

const screen = (t: LinuxTerminalSession): string =>
  t.lines.map((l) => l.text).join('\n');
/** True while the prompt still belongs to the remote host. */
const onRemote = (t: LinuxTerminalSession): boolean =>
  t.getPrompt().includes('@SRV');

describe('the session is genuinely established first', () => {
  it('the prompt is the remote host, and commands run there', async () => {
    const { t } = await connectedLab();

    expect(onRemote(t)).toBe(true);
    await type(t, 'hostname');
    expect(screen(t)).toContain('linux-server');
  });
});

describe('faults that END the session', () => {
  it('the remote machine is switched off', async () => {
    const { srv, t } = await connectedLab();

    srv.powerOff();
    await type(t, 'hostname');

    // OpenSSH's own wording for a write that never lands.
    expect(screen(t)).toContain('client_loop: send disconnect: Broken pipe');
    expect(onRemote(t)).toBe(false);
  });

  it('a switch in the middle loses power', async () => {
    const { sw, t } = await connectedLab();

    sw.powerOff();
    await type(t, 'hostname');

    // Nothing is wrong with either endpoint — and the session still dies,
    // which is the point of drawing the path rather than pinging the peer.
    expect(screen(t)).toContain('Broken pipe');
    expect(onRemote(t)).toBe(false);
  });

  it('the cable at the FAR end is pulled', async () => {
    const { cableToServer, t } = await connectedLab();

    cableToServer.disconnect();
    await type(t, 'hostname');

    // This is the case this side's own socket cannot see: the client's
    // link is perfectly up. Only the path notices.
    expect(screen(t)).toContain('Broken pipe');
    expect(onRemote(t)).toBe(false);
  });

  it('the remote interface is shut down administratively', async () => {
    const { srv, t } = await connectedLab();

    await srv.executeCommand('ip link set eth0 down');
    await type(t, 'hostname');

    expect(screen(t)).toContain('Broken pipe');
    expect(onRemote(t)).toBe(false);
  });

  it('the command typed is echoed before the failure, as a real terminal does', async () => {
    const { srv, t } = await connectedLab();
    srv.powerOff();

    await type(t, 'uptime');

    // The terminal is on the CLIENT side: it shows what was typed, then
    // reports that the write failed. Swallowing the line would make the
    // transcript unreadable.
    const lines = screen(t).split('\n');
    const typed = lines.findIndex((l) => l.includes('uptime'));
    const broke = lines.findIndex((l) => l.includes('Broken pipe'));
    expect(typed).toBeGreaterThanOrEqual(0);
    expect(broke).toBeGreaterThan(typed);
  });

  it('the operator is back on their own machine afterwards', async () => {
    const { srv, t } = await connectedLab();
    srv.powerOff();
    await type(t, 'hostname');

    // Not merely "an error was printed": the session is gone, so the next
    // command must run locally rather than vanish into a dead channel.
    await type(t, 'hostname');
    expect(screen(t)).toContain('linux-pc');
  });
});

describe('faults that do NOT end the session', () => {
  it('`systemctl stop ssh` leaves the established session alone', async () => {
    const { srv, t } = await connectedLab();

    await srv.executeCommand('systemctl stop ssh');
    await type(t, 'hostname');

    // Debian's ssh.service is KillMode=process: stopping it kills the
    // listener, not the children serving open connections. This is why
    // administrators can restart sshd over ssh without locking themselves
    // out — and treating it as a disconnect would teach the opposite.
    expect(onRemote(t)).toBe(true);
    expect(screen(t)).toContain('linux-server');
    expect(screen(t)).not.toContain('Broken pipe');
  });

  it('…but a NEW connection is refused while it is stopped', async () => {
    const { cli, srv } = await connectedLab();

    await srv.executeCommand('systemctl stop ssh');

    // The other half of the same fact: the listener really is gone.
    expect(await cli.executeCommand('ssh alice@10.0.0.2 hostname'))
      .toMatch(/Connection refused|refused/i);
  });

  it('restarting sshd from the remote console does not drop the session', async () => {
    const { srv, t } = await connectedLab();

    // The classic manoeuvre, stated as the fault it is: the daemon goes
    // down and back up under a live session, which must not notice.
    await srv.executeCommand('systemctl restart ssh');
    await type(t, 'hostname');

    expect(onRemote(t)).toBe(true);
    expect(screen(t)).toContain('linux-server');
    expect(screen(t)).not.toContain('Broken pipe');
  });

  it('a cable elsewhere in the topology is irrelevant', async () => {
    const { sw, t } = await connectedLab();
    // A third machine, on its own port, unplugged.
    const other = new LinuxPC('linux-pc', 'OTHER');
    other.configureInterface('eth0', new IPAddress('10.0.0.9'), MASK);
    const c3 = new Cable('c3');
    c3.connect(other.getPort('eth0')!, sw.getPorts()[2]);

    c3.disconnect();
    await type(t, 'hostname');

    // Liveness must follow the path this session actually uses, not react
    // to any change in the topology.
    expect(onRemote(t)).toBe(true);
    expect(screen(t)).toContain('linux-server');
  });
});

describe('recovery', () => {
  it('reconnecting after the cable is plugged back works', async () => {
    const { cli, cableToServer, sw, srv, t } = await connectedLab();
    cableToServer.disconnect();
    await type(t, 'hostname');
    expect(onRemote(t)).toBe(false);

    new Cable('c2b').connect(srv.getPort('eth0')!, sw.getPorts()[1]);

    // The fault leaves no residue: the same login works again.
    expect(await cli.executeCommand('sshpass -p secret ssh alice@10.0.0.2 hostname'))
      .toContain('linux-server');
  });

  it('a powered-off remote answers again once switched back on', async () => {
    const { cli, srv, t } = await connectedLab();
    srv.powerOff();
    await type(t, 'hostname');
    expect(onRemote(t)).toBe(false);

    srv.powerOn();

    expect(await cli.executeCommand('sshpass -p secret ssh alice@10.0.0.2 hostname'))
      .toContain('linux-server');
  });
});

describe('the same rules from a Windows client', () => {
  interface WinLab { srv: LinuxServer; sw: GenericSwitch; cable: Cable; t: WindowsTerminalSession }

  async function winLab(): Promise<WinLab> {
    const win = new WindowsPC('windows-pc', 'WIN');
    const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
    const srv = new LinuxServer('linux-server', 'SRV');
    win.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), MASK);
    srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), MASK);
    new Cable('c1').connect(win.getPorts()[0], sw.getPorts()[0]);
    const cable = new Cable('c2');
    cable.connect(srv.getPorts()[0], sw.getPorts()[1]);
    await srv.executeCommand('useradd -m alice');
    await srv.executeCommand('sh -c "echo \'alice:secret\' | chpasswd"');

    const t = new WindowsTerminalSession('t', win);
    await t.init();
    t.setInput('ssh alice@10.0.0.2');
    t.handleKey(key('Enter'));
    await flush();
    if (t.currentInputMode.type === 'password') {
      t.setPasswordBuf('secret');
      t.handleKey(key('Enter'));
      await flush();
    }
    return { srv, sw, cable, t };
  }

  const winType = async (t: WindowsTerminalSession, line: string): Promise<void> => {
    t.foreground.setInput(line);
    t.foreground.setInputBuf(line);
    t.handleKey(key('Enter'));
    await flush();
  };
  const winScreen = (t: WindowsTerminalSession): string => t.lines.map((l) => l.text).join('\n');

  // A Windows client reaches the remote through a different mechanism (an
  // adopted child session rather than a wire sub-shell), so the rules have
  // to hold there too or the same lab teaches two different lessons
  // depending on which machine the student sits at.

  it('is genuinely connected', async () => {
    const { t } = await winLab();
    await winType(t, 'hostname');
    expect(winScreen(t)).toContain('linux-server');
  });

  it('dies when the remote is switched off', async () => {
    const { srv, t } = await winLab();
    srv.powerOff();
    await winType(t, 'hostname');
    expect(winScreen(t)).toContain('Broken pipe');
    expect(t.getPrompt()).toMatch(/^[A-Z]:\\/);
  });

  it('dies when the far cable is pulled', async () => {
    const { cable, t } = await winLab();
    cable.disconnect();
    await winType(t, 'hostname');
    expect(winScreen(t)).toContain('Broken pipe');
  });

  it('dies when a switch in the middle loses power', async () => {
    const { sw, t } = await winLab();
    sw.powerOff();
    await winType(t, 'hostname');
    expect(winScreen(t)).toContain('Broken pipe');
  });

  it('survives `systemctl stop ssh`, exactly as the Linux client does', async () => {
    const { srv, t } = await winLab();
    await srv.executeCommand('systemctl stop ssh');
    await winType(t, 'hostname');
    expect(winScreen(t)).toContain('linux-server');
    expect(winScreen(t)).not.toContain('Broken pipe');
  });
});
