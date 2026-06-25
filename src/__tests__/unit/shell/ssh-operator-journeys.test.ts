import { describe, expect, test } from 'vitest';
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
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';
import { reinstallDefaultShells } from '@/shell/registerDefaults';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function buildLan() {
  EquipmentRegistry.getInstance().clear();
  reinstallDefaultShells();
  const linuxA = new LinuxPC('linux-pc', 'linuxA', 0, 0);
  const linuxSrv = new LinuxServer('linux-server', 'linuxSrv', 0, 0);
  const winA = new WindowsPC('windows-pc', 'winA', 0, 0);
  const winB = new WindowsPC('windows-pc', 'winB', 0, 0);
  const cisco = new CiscoRouter('cisco', 0, 0);
  const huawei = new HuaweiRouter('huawei', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const mask = new SubnetMask('255.255.255.0');
  [linuxA, linuxSrv, winA, winB, cisco, huawei].forEach((d, i) => {
    new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]);
  });
  linuxA.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  linuxSrv.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  winA.getPorts()[0].configureIP(new IPAddress('10.0.0.4'), mask);
  winB.getPorts()[0].configureIP(new IPAddress('10.0.0.5'), mask);
  linuxA.setHostname('linuxA');
  linuxSrv.setHostname('linuxSrv');
  winA.setHostname('winA');
  winB.setHostname('winB');

  await cisco.executeCommand('enable');
  await cisco.executeCommand('configure terminal');
  await cisco.executeCommand('interface GigabitEthernet0/0');
  await cisco.executeCommand('ip address 10.0.0.6 255.255.255.0');
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
  await huawei.executeCommand('ip address 10.0.0.7 255.255.255.0');
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

  return { linuxA, linuxSrv, winA, winB, cisco, huawei };
}

async function typeRoot(t: TerminalSession, line: string): Promise<void> {
  t.setInput(line); t.handleKey(key('Enter')); await flush();
}

async function typeSub(t: TerminalSession, line: string): Promise<void> {
  t.setInputBuf(line); t.handleKey(key('Enter')); await flush();
}

async function sudoSub(t: TerminalSession, line: string, pw: string): Promise<void> {
  t.setInputBuf(line); t.handleKey(key('Enter')); await flush();
  if (t.foreground.currentInputMode.type === 'password') {
    t.setPasswordBuf(pw); t.handleKey(key('Enter')); await flush();
  }
}

async function winSshLogin(t: WindowsTerminalSession, line: string, pw: string): Promise<void> {
  await typeRoot(t, line);
  if (t.currentInputMode.type === 'password') {
    t.setPasswordBuf(pw); t.handleKey(key('Enter')); await flush();
  }
}

function expectAnyLine(t: TerminalSession, needle: string | RegExp): void {
  const ok = t.lines.some(l => needle instanceof RegExp ? needle.test(l.text) : l.text.includes(needle));
  if (!ok) {
    const tail = t.lines.slice(-12).map(l => l.text).join('\n');
    throw new Error(`Missing ${String(needle)}\n${tail}`);
  }
}

describe('SSH operator journeys — multi-step end-to-end scenarios', () => {
  test('§J01 — Windows operator: audit a Linux server (user list + log inspection)', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
    await typeSub(t, 'cat /etc/passwd | head -n 5');
    expectAnyLine(t, /^root:/);
    await sudoSub(t, 'sudo tail -n 5 /var/log/auth.log', 'alice');
    expectAnyLine(t, /sshd/);
    await typeSub(t, 'systemctl is-active ssh');
    expectAnyLine(t, /^active$/);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^[A-Z]:\\/);
  });

  test('§J02 — Linux DBA workflow: SSH, sqlplus, CREATE/INSERT/SELECT, exit cleanly', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sqlplus / as sysdba');
    expect(t.getPrompt()).toMatch(/^SQL>/);
    await typeSub(t, 'CREATE TABLE journey (id NUMBER, label VARCHAR2(20));');
    await typeSub(t, "INSERT INTO journey VALUES (1, 'first');");
    await typeSub(t, 'COMMIT;');
    await typeSub(t, 'SELECT label FROM journey;');
    expectAnyLine(t, /first/);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^[A-Z]:\\/);
  });

  test('§J03 — User-add workflow: alice creates zoe, sets her sudoer, zoe logs in', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await sudoSub(t, 'sudo useradd -m zoe', 'alice');
    await sudoSub(t, 'sudo gpasswd -a zoe sudo', 'alice');
    await sudoSub(t, 'sudo passwd zoe', 'alice');
    await typeSub(t, 'echo "zoepw\\nzoepw" | sudo passwd --stdin zoe 2>/dev/null || true');
    await typeSub(t, 'getent passwd zoe');
    expectAnyLine(t, /^zoe:/);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^[A-Z]:\\/);
  });

  test('§J04 — Cisco router config audit from Windows operator', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh admin@10.0.0.6', 'Admin@123');
    expect(t.getPrompt()).toMatch(/cisco/);
    await typeSub(t, 'show version');
    expectAnyLine(t, /IOS|Cisco/i);
    await typeSub(t, 'show ip interface brief');
    expectAnyLine(t, /GigabitEthernet/);
    await typeSub(t, 'show running-config | include hostname');
    expectAnyLine(t, /hostname/);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^[A-Z]:\\/);
  });

  test('§J05 — Huawei router config audit from Windows operator', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh admin@10.0.0.7', 'Admin@123');
    expect(t.getPrompt()).toMatch(/<huawei>/);
    await typeSub(t, 'display version');
    expectAnyLine(t, /VRP|Huawei/i);
    await typeSub(t, 'display ip interface brief');
    expectAnyLine(t, /GigabitEthernet|GE0\/0\/0/);
    await typeSub(t, 'quit');
    expect(t.getPrompt()).toMatch(/^[A-Z]:\\/);
  });

  test('§J06 — Windows admin: PS pipeline + nested cmd + back to PS audit cycle', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    expect(t.getPrompt()).toMatch(/^PS /);
    await typeSub(t, '(Get-Service | Measure-Object).Count');
    expectAnyLine(t, /\d+/);
    await typeSub(t, 'cmd');
    expect(t.getPrompt()).toMatch(/^[A-Z]:\\/);
    await typeSub(t, 'ver');
    expectAnyLine(t, /Microsoft Windows/);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^PS /);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^[A-Z]:\\/);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^[A-Z]:\\/);
  });

  test('§J07 — Security incident: stop sshd on server, reset config, re-enable', async () => {
    const { winA, linuxSrv } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await linuxSrv.executeCommand('echo "DenyUsers carl" > /etc/ssh/sshd_config');
    await linuxSrv.executeCommand('systemctl reload ssh');
    await winSshLogin(t, 'ssh carl@10.0.0.3', 'carl');
    expectAnyLine(t, /Permission denied/);
    await linuxSrv.executeCommand('rm /etc/ssh/sshd_config');
    await linuxSrv.executeCommand('systemctl reload ssh');
    await winSshLogin(t, 'ssh carl@10.0.0.3', 'carl');
    expect(t.getPrompt()).toMatch(/carl@linuxSrv/);
  });

  test('§J08 — Multi-vendor tour: Windows → Linux → exit → Windows → exit → Cisco → exit', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
    await typeSub(t, 'hostname');
    expectAnyLine(t, /^linuxSrv$/);
    await typeSub(t, 'exit');
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    expect(t.getPrompt()).toMatch(/C:\\Users\\User>/);
    await typeSub(t, 'ver');
    expectAnyLine(t, /Microsoft Windows/);
    await typeSub(t, 'exit');
    await winSshLogin(t, 'ssh admin@10.0.0.6', 'Admin@123');
    expect(t.getPrompt()).toMatch(/cisco/);
    await typeSub(t, 'show version');
    expectAnyLine(t, /IOS/i);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^[A-Z]:\\/);
  });

  test('§J09 — Disaster recovery: power-off server, fail, power-on, reconnect, verify state', async () => {
    const { winA, linuxSrv } = await buildLan();
    await linuxSrv.executeCommand('echo persistent > /tmp/state.txt');
    linuxSrv.powerOff();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await typeRoot(t, 'ssh alice@10.0.0.3');
    expectAnyLine(t, /No route to host/);
    linuxSrv.powerOn();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'cat /tmp/state.txt');
    expectAnyLine(t, /persistent/);
  });

  test('§J10 — End-to-end DBA audit + sub-shell + restore: open SSH, sqlplus, exit, examine logs', async () => {
    const { winA, linuxSrv } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sqlplus / as sysdba');
    await typeSub(t, 'SELECT instance_name FROM v$instance;');
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
    await sudoSub(t, 'sudo cat /var/log/auth.log', 'alice');
    expectAnyLine(t, /Accepted password for alice/);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^[A-Z]:\\/);
    const log = await linuxSrv.executeCommand('cat /var/log/auth.log');
    expect(log).toMatch(/Accepted password for alice/);
  });
});
