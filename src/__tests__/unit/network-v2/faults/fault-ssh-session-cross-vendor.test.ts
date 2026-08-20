/**
 * The same faults, against the other equipment in the lab.
 *
 * A student does not only ssh between Linux boxes: they reach a Cisco
 * router, a Huawei router, a Windows host — and they reach them FROM those
 * devices too. If a pulled cable ends the session on one vendor and not on
 * another, the same exercise teaches two different lessons depending on
 * which machine the student happens to sit at.
 *
 * So the physical faults are asserted identically everywhere, and the
 * SERVICE faults are asserted in each vendor's own vocabulary, because
 * that part genuinely differs:
 *
 *   Linux   `systemctl stop ssh`            — session survives (KillMode=process)
 *   Cisco   `transport input none`          — session survives, listener gone
 *   Cisco   `crypto key zeroize rsa`        — session survives, SSH disabled
 *   Huawei  `undo stelnet server enable`    — session survives, listener gone
 *
 * The common rule underneath all four: killing the LISTENER never kills an
 * established session. That is what makes reconfiguring a device over ssh
 * survivable, and it is the same reason on every one of these platforms.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';
import type { Equipment } from '@/network/equipment/Equipment';

const MASK = new SubnetMask('255.255.255.0');
const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

async function flush(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

const CISCO_SETUP = [
  'enable', 'configure terminal',
  'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
  'username admin privilege 15 secret Admin@123', 'enable secret Admin@123',
  'ip domain-name lab.local', 'crypto key generate rsa modulus 2048', 'ip ssh version 2',
  'line vty 0 4', 'login local', 'transport input ssh', 'end',
];
const HUAWEI_SETUP = [
  'system-view',
  'interface GigabitEthernet0/0/0', 'ip address 10.0.0.2 255.255.255.0', 'undo shutdown', 'quit',
  'aaa', 'local-user admin password cipher Admin@123', 'local-user admin service-type ssh',
  'local-user admin privilege level 15', 'quit',
  'rsa local-key-pair create', 'stelnet server enable',
  'user-interface vty 0 4', 'authentication-mode aaa', 'protocol inbound ssh', 'quit',
  'ssh user admin authentication-type password', 'ssh user admin service-type stelnet', 'quit',
];

type Vendor = 'cisco' | 'huawei' | 'windows';

interface Lab {
  cli: LinuxPC; target: Equipment; sw: GenericSwitch;
  cableToTarget: Cable; t: LinuxTerminalSession;
}

/** A Linux client with an open ssh session on the given kind of device. */
async function connectedTo(vendor: Vendor): Promise<Lab> {
  const cli = new LinuxPC('linux-pc', 'CLI');
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  cli.configureInterface('eth0', new IPAddress('10.0.0.1'), MASK);
  new Cable('c1').connect(cli.getPort('eth0')!, sw.getPorts()[0]);

  let target: Equipment;
  let user: string;
  let password: string;
  if (vendor === 'cisco') {
    const r = new CiscoRouter('cisco', 0, 0);
    target = r; user = 'admin'; password = 'Admin@123';
    new Cable('c2').connect(r.getPorts()[0], sw.getPorts()[1]);
    for (const c of CISCO_SETUP) await r.executeCommand(c);
  } else if (vendor === 'huawei') {
    const r = new HuaweiRouter('huawei', 0, 0);
    target = r; user = 'admin'; password = 'Admin@123';
    new Cable('c2').connect(r.getPorts()[0], sw.getPorts()[1]);
    for (const c of HUAWEI_SETUP) await r.executeCommand(c);
  } else {
    const w = new WindowsPC('windows-pc', 'WSRV');
    target = w; user = 'Administrator'; password = 'admin';
    w.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), MASK);
    new Cable('c2').connect(w.getPorts()[0], sw.getPorts()[1]);
  }
  const cableToTarget = sw.getPorts()[1].getCable()!;

  const t = new LinuxTerminalSession('t', cli);
  await t.init();
  t.setInput(`ssh ${user}@10.0.0.2`);
  t.handleKey(key('Enter'));
  await flush();
  if (t.foreground.currentInputMode.type === 'password') {
    t.setPasswordBuf(password);
    t.handleKey(key('Enter'));
    await flush();
  }
  return { cli, target, sw, cableToTarget, t };
}

async function type(t: TerminalSession, line: string): Promise<void> {
  t.foreground.setInput(line);
  t.foreground.setInputBuf(line);
  t.handleKey(key('Enter'));
  await flush();
}

const screen = (t: TerminalSession): string => t.lines.map((l) => l.text).join('\n');
/** Back on the client's own Linux prompt = the session is gone. */
const backHome = (t: TerminalSession): boolean => t.getPrompt().includes('user@CLI');

describe.each<[Vendor, string]>([
  ['cisco', 'show clock'],
  ['huawei', 'display clock'],
  ['windows', 'hostname'],
])('physical faults under a session on a %s device', (vendor, probeCommand) => {
  it('the session is genuinely open first', async () => {
    const { t } = await connectedTo(vendor);
    expect(backHome(t)).toBe(false);
    await type(t, probeCommand);
    expect(screen(t)).not.toContain('Broken pipe');
  });

  it('the device is switched off', async () => {
    const { target, t } = await connectedTo(vendor);

    target.powerOff();
    await type(t, probeCommand);

    expect(screen(t)).toContain('client_loop: send disconnect: Broken pipe');
    expect(backHome(t)).toBe(true);
  });

  it('a switch in the middle loses power', async () => {
    const { sw, t } = await connectedTo(vendor);

    sw.powerOff();
    await type(t, probeCommand);

    expect(screen(t)).toContain('Broken pipe');
    expect(backHome(t)).toBe(true);
  });

  it('the cable at the device end is pulled', async () => {
    const { cableToTarget, t } = await connectedTo(vendor);

    cableToTarget.disconnect();
    await type(t, probeCommand);

    expect(screen(t)).toContain('Broken pipe');
    expect(backHome(t)).toBe(true);
  });
});

describe('service faults, in each vendor\'s own vocabulary', () => {
  it('Cisco: `transport input none` leaves the session, closes the door', async () => {
    const { cli, target, t } = await connectedTo('cisco');

    for (const c of ['enable', 'configure terminal', 'line vty 0 4', 'transport input none', 'end']) {
      await target.executeCommand(c);
    }

    await type(t, 'show clock');
    expect(backHome(t)).toBe(false);
    expect(screen(t)).not.toContain('Broken pipe');
    // …while the listener really is gone for anyone arriving now.
    expect(await cli.executeCommand('ssh admin@10.0.0.2 show version'))
      .toMatch(/Connection refused/i);
  });

  it('Cisco: `crypto key zeroize rsa` disables SSH — the router\'s host keys', async () => {
    const { cli, target, t } = await connectedTo('cisco');

    for (const c of ['enable', 'configure terminal', 'crypto key zeroize rsa', 'end']) {
      await target.executeCommand(c);
    }

    // IOS runs no SSH server without RSA keys, which makes this the exact
    // router counterpart of deleting a Linux host's ssh_host_*_key
    // (docs/PRD-Pannes.md §F7.2) — and the classic way to lock yourself
    // out of a box you are reaching over ssh.
    expect(await cli.executeCommand('ssh admin@10.0.0.2 show version'))
      .toMatch(/Connection refused/i);
    // The session already open is untouched, exactly like every other
    // "the listener died" fault.
    await type(t, 'show clock');
    expect(backHome(t)).toBe(false);
  });

  it('Cisco: regenerating the keys brings SSH back', async () => {
    const { cli, target } = await connectedTo('cisco');
    for (const c of ['enable', 'configure terminal', 'crypto key zeroize rsa', 'end']) {
      await target.executeCommand(c);
    }
    expect(await cli.executeCommand('ssh admin@10.0.0.2 show version'))
      .toMatch(/Connection refused/i);

    for (const c of ['enable', 'configure terminal', 'crypto key generate rsa modulus 2048', 'end']) {
      await target.executeCommand(c);
    }

    // No residue: generating the keys is what turns the server back on.
    expect(await cli.executeCommand('ssh admin@10.0.0.2 show version'))
      .toContain('Cisco IOS Software');
  });

  it('Cisco: zeroizing with no keys says so rather than pretending', async () => {
    const { target } = await connectedTo('cisco');
    await target.executeCommand('enable');
    await target.executeCommand('configure terminal');
    await target.executeCommand('crypto key zeroize rsa');

    expect(await target.executeCommand('crypto key zeroize rsa'))
      .toContain('% No Signature RSA Keys found in configuration.');
  });

  it('Huawei: `undo stelnet server enable` leaves the session, closes the door', async () => {
    const { cli, target, t } = await connectedTo('huawei');

    await target.executeCommand('system-view');
    await target.executeCommand('undo stelnet server enable');
    await target.executeCommand('quit');

    await type(t, 'display clock');
    expect(backHome(t)).toBe(false);
    expect(screen(t)).not.toContain('Broken pipe');
    expect(await cli.executeCommand('ssh admin@10.0.0.2 display version'))
      .toMatch(/Connection refused/i);
  });

  it('Huawei: `rsa local-key-pair destroy` disables STelnet — the same fault, VRP\'s wording', async () => {
    const { cli, target, t } = await connectedTo('huawei');

    await target.executeCommand('system-view');
    expect(await target.executeCommand('rsa local-key-pair destroy'))
      .toContain('Info: The key pair has been destroyed.');
    await target.executeCommand('quit');

    // `stelnet server enable` is still configured; it is the KEY that is
    // gone, and VRP has nothing to present without one — the exact
    // counterpart of `crypto key zeroize rsa` above.
    expect(await cli.executeCommand('ssh admin@10.0.0.2 display version'))
      .toMatch(/Connection refused/i);
    await type(t, 'display clock');
    expect(backHome(t)).toBe(false);
  });

  it('Huawei: recreating the key pair brings STelnet back', async () => {
    const { cli, target } = await connectedTo('huawei');
    await target.executeCommand('system-view');
    await target.executeCommand('rsa local-key-pair destroy');
    await target.executeCommand('quit');
    expect(await cli.executeCommand('ssh admin@10.0.0.2 display version'))
      .toMatch(/Connection refused/i);

    await target.executeCommand('system-view');
    await target.executeCommand('rsa local-key-pair create');
    await target.executeCommand('quit');

    expect(await cli.executeCommand('ssh admin@10.0.0.2 display version'))
      .toMatch(/VRP|Huawei/i);
  });

  it('Huawei: destroying with no key pair says so rather than pretending', async () => {
    const { target } = await connectedTo('huawei');
    await target.executeCommand('system-view');
    await target.executeCommand('rsa local-key-pair destroy');

    expect(await target.executeCommand('rsa local-key-pair destroy'))
      .toContain('Error: The RSA host key does not exist.');
  });
});

describe('a Cisco router as the CLIENT', () => {
  it('loses its session when the far cable is pulled, like any other client', async () => {
    const r = new CiscoRouter('cisco', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
    const srv = new LinuxServer('linux-server', 'SRV');
    srv.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), MASK);
    new Cable('c1').connect(r.getPorts()[0], sw.getPorts()[0]);
    const cable = new Cable('c2');
    cable.connect(srv.getPorts()[0], sw.getPorts()[1]);
    for (const c of CISCO_SETUP) await r.executeCommand(c);
    await srv.executeCommand('useradd -m alice');
    await srv.executeCommand('sh -c "echo \'alice:secret\' | chpasswd"');

    const t = new CiscoTerminalSession('t', r);
    await t.init();
    t.setInput('ssh -l alice 10.0.0.3');
    t.handleKey(key('Enter'));
    await flush();
    if (t.foreground.currentInputMode.type === 'password') {
      t.setPasswordBuf('secret');
      t.handleKey(key('Enter'));
      await flush();
    }
    expect(t.getPrompt()).toContain('alice@');

    cable.disconnect();
    await type(t, 'hostname');

    // The IOS CLI reaches the remote through a different mechanism than a
    // Linux terminal does; the rule has to hold there too, or the same lab
    // behaves differently depending on where the student typed `ssh`.
    expect(screen(t)).toContain('Broken pipe');
    expect(t.getPrompt()).toMatch(/^cisco[>#]/);
  });
});
