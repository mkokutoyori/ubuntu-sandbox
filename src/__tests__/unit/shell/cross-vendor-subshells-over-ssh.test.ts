import { describe, expect, beforeEach, test } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { reinstallDefaultShells } from '@/shell/registerDefaults';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

interface Lan {
  winA: WindowsPC;
  linuxSrv: LinuxServer;
  winB: WindowsPC;
  cisco: CiscoRouter;
  huawei: HuaweiRouter;
}

async function buildLan(): Promise<Lan> {
  EquipmentRegistry.getInstance().clear();
  const winA = new WindowsPC('windows-pc', 'winA', 0, 0);
  const linuxSrv = new LinuxServer('linux-server', 'linuxSrv', 0, 0);
  const winB = new WindowsPC('windows-pc', 'winB', 0, 0);
  const cisco = new CiscoRouter('cisco', 0, 0);
  const huawei = new HuaweiRouter('huawei', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const mask = new SubnetMask('255.255.255.0');
  [winA, linuxSrv, winB, cisco, huawei].forEach((d, i) => {
    new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]);
  });
  winA.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  linuxSrv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  winB.getPorts()[0].configureIP(new IPAddress('10.0.0.4'), mask);

  await cisco.executeCommand('enable');
  await cisco.executeCommand('configure terminal');
  await cisco.executeCommand('interface GigabitEthernet0/0');
  await cisco.executeCommand('ip address 10.0.0.5 255.255.255.0');
  await cisco.executeCommand('no shutdown');
  await cisco.executeCommand('exit');
  await cisco.executeCommand('username admin privilege 15 secret Admin@123');
  await cisco.executeCommand('enable secret Admin@123');
  await cisco.executeCommand('ip domain-name lab.local');
  await cisco.executeCommand('crypto key generate rsa modulus 2048');
  await cisco.executeCommand('ip ssh version 2');
  await cisco.executeCommand('line vty 0 4');
  await cisco.executeCommand('login local');
  await cisco.executeCommand('transport input ssh');
  await cisco.executeCommand('end');

  await huawei.executeCommand('system-view');
  await huawei.executeCommand('interface GigabitEthernet0/0/0');
  await huawei.executeCommand('ip address 10.0.0.6 255.255.255.0');
  await huawei.executeCommand('undo shutdown');
  await huawei.executeCommand('quit');
  await huawei.executeCommand('aaa');
  await huawei.executeCommand('local-user admin password cipher Admin@123');
  await huawei.executeCommand('local-user admin service-type ssh');
  await huawei.executeCommand('local-user admin privilege level 15');
  await huawei.executeCommand('quit');
  await huawei.executeCommand('rsa local-key-pair create');
  await huawei.executeCommand('stelnet server enable');
  await huawei.executeCommand('user-interface vty 0 4');
  await huawei.executeCommand('authentication-mode aaa');
  await huawei.executeCommand('protocol inbound ssh');
  await huawei.executeCommand('quit');
  await huawei.executeCommand('ssh user admin authentication-type password');
  await huawei.executeCommand('ssh user admin service-type stelnet');
  await huawei.executeCommand('quit');

  return { winA, linuxSrv, winB, cisco, huawei };
}

async function sshLogin(t: WindowsTerminalSession, line: string, pw: string): Promise<void> {
  t.setInput(line);
  t.handleKey(key('Enter'));
  await flush();
  if (t.currentInputMode.type === 'password') {
    t.setPasswordBuf(pw);
    t.handleKey(key('Enter'));
    await flush();
  }
}

async function typeSub(t: WindowsTerminalSession, line: string): Promise<void> {
  t.setInputBuf(line);
  t.handleKey(key('Enter'));
  await flush();
}

describe('Sub-shells launched OVER SSH land in the right primary', () => {
  let lan: Lan;
  let term: WindowsTerminalSession;

  beforeEach(async () => {
    reinstallDefaultShells();
    lan = await buildLan();
    term = new WindowsTerminalSession('t', lan.winA);
    await term.init();
  });

  test('Windows → Linux + sqlplus enters the SQL*Plus prompt remotely', async () => {
    await sshLogin(term, 'ssh alice@10.0.0.2', 'alice');
    expect(term.getPrompt()).toMatch(/alice@linuxSrv/);
    await typeSub(term, 'sqlplus / as sysdba');
    expect(term.getPrompt()).toMatch(/^SQL>/);
  });

  test('Windows → Linux + sqlplus + exit returns to the remote bash', async () => {
    await sshLogin(term, 'ssh alice@10.0.0.2', 'alice');
    await typeSub(term, 'sqlplus / as sysdba');
    await typeSub(term, 'exit');
    expect(term.getPrompt()).toMatch(/alice@linuxSrv/);
  });

  test('Windows → Windows + powershell + cmd nests both children correctly', async () => {
    await sshLogin(term, 'ssh User@10.0.0.4', 'user');
    expect(term.getPrompt()).toMatch(/C:\\Users\\User>/);
    await typeSub(term, 'powershell');
    expect(term.getPrompt()).toMatch(/^PS /);
    await typeSub(term, 'cmd');
    expect(term.getPrompt()).toMatch(/^[A-Z]:\\/);
    await typeSub(term, 'exit');
    expect(term.getPrompt()).toMatch(/^PS /);
    await typeSub(term, 'exit');
    expect(term.getPrompt()).toMatch(/C:\\Users\\User>/);
  });

  test('Windows → Cisco IOS exit-words `quit` and `exit` both close cleanly', async () => {
    await sshLogin(term, 'ssh admin@10.0.0.5', 'Admin@123');
    expect(term.getPrompt()).toMatch(/cisco/);
    await typeSub(term, 'quit');
    expect(term.getPrompt()).toMatch(/^[A-Z]:\\/);
  });

  test('Windows → Huawei VRP exit-word `quit` closes cleanly (VRP-native)', async () => {
    await sshLogin(term, 'ssh admin@10.0.0.6', 'Admin@123');
    expect(term.getPrompt()).toMatch(/<huawei>/);
    await typeSub(term, 'quit');
    expect(term.getPrompt()).toMatch(/^[A-Z]:\\/);
  });

  test('SSH session connection-closed footer is emitted on every vendor', async () => {
    const targets: Array<[string, string, string]> = [
      ['ssh alice@10.0.0.2', 'alice', '10.0.0.2'],
      ['ssh User@10.0.0.4', 'user', '10.0.0.4'],
      ['ssh admin@10.0.0.5', 'Admin@123', '10.0.0.5'],
      ['ssh admin@10.0.0.6', 'Admin@123', '10.0.0.6'],
    ];
    for (const [cmd, pw, host] of targets) {
      const t = new WindowsTerminalSession(`tt-${host}`, lan.winA);
      await t.init();
      await sshLogin(t, cmd, pw);
      const exitWord = host === '10.0.0.6' ? 'quit' : 'exit';
      await typeSub(t, exitWord);
      const lines = t.lines.map(l => l.text);
      const found = lines.some(line => new RegExp(`Connection to ${host.replace(/\./g, '\\.')} closed`).test(line));
      expect(found).toBe(true);
    }
  });
});
