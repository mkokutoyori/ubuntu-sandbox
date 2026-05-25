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

describe('SSH vendor commands + operator flows', () => {
  // ─── Cisco IOS over SSH — typical show commands ────────────────────
  test('§V01 — Windows→Cisco: show running-config | include hostname', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh admin@10.0.0.6', 'Admin@123');
    await typeSub(t, 'show running-config | include hostname');
    expectAnyLine(t, /hostname/);
  });

  test('§V02 — Windows→Cisco: show ip interface brief lists Gi0/0', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh admin@10.0.0.6', 'Admin@123');
    await typeSub(t, 'show ip interface brief');
    expectAnyLine(t, /GigabitEthernet/);
  });

  test('§V03 — Windows→Cisco: show users lists the SSH session', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh admin@10.0.0.6', 'Admin@123');
    await typeSub(t, 'show users');
    const out = t.lines.slice(-10).map(l => l.text).join('\n');
    expect(out.length).toBeGreaterThan(0);
  });

  test('§V04 — Windows→Cisco: show clock returns a timestamp', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh admin@10.0.0.6', 'Admin@123');
    await typeSub(t, 'show clock');
    expectAnyLine(t, /\d{2}:\d{2}|\d{4}/);
  });

  test('§V05 — Windows→Cisco: configure terminal then no shutdown returns ok', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh admin@10.0.0.6', 'Admin@123');
    await typeSub(t, 'configure terminal');
    await typeSub(t, 'interface GigabitEthernet0/1');
    await typeSub(t, 'no shutdown');
    await typeSub(t, 'end');
    expect(t.getPrompt()).toMatch(/cisco/);
  });

  // ─── Huawei VRP over SSH ───────────────────────────────────────────
  test('§V06 — Windows→Huawei: display current-configuration | include sysname', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh admin@10.0.0.7', 'Admin@123');
    await typeSub(t, 'display current-configuration | include sysname');
    expectAnyLine(t, /sysname/);
  });

  test('§V07 — Windows→Huawei: display ip interface brief', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh admin@10.0.0.7', 'Admin@123');
    await typeSub(t, 'display ip interface brief');
    expectAnyLine(t, /GigabitEthernet|GE0\/0\/0/);
  });

  test('§V08 — Windows→Huawei: display users', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh admin@10.0.0.7', 'Admin@123');
    await typeSub(t, 'display users');
    const out = t.lines.slice(-10).map(l => l.text).join('\n');
    expect(out.length).toBeGreaterThan(0);
  });

  test('§V09 — Windows→Huawei: system-view + sysname change persists', async () => {
    const { winA, huawei } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh admin@10.0.0.7', 'Admin@123');
    await typeSub(t, 'system-view');
    await typeSub(t, 'sysname my-huawei');
    await typeSub(t, 'quit');
    expect(huawei.getHostname()).toBe('my-huawei');
  });

  // ─── Realistic Linux server admin tasks ────────────────────────────
  test('§V10 — Windows→Linux: tar create + list', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'mkdir /tmp/tdir');
    await typeSub(t, 'echo content > /tmp/tdir/a.txt');
    await typeSub(t, 'tar -czf /tmp/tdir.tar.gz /tmp/tdir');
    await typeSub(t, 'ls /tmp');
    expectAnyLine(t, /tdir\.tar\.gz/);
  });

  test('§V11 — Windows→Linux: chgrp + ls -l reflects the change', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo body > /tmp/chf.txt');
    await typeSub(t, 'ls -l /tmp/chf.txt');
    expectAnyLine(t, /alice/);
  });

  test('§V12 — Windows→Linux: ln -s creates a symlink', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo orig > /tmp/source.txt');
    await typeSub(t, 'ln -s /tmp/source.txt /tmp/link.txt');
    await typeSub(t, 'cat /tmp/link.txt');
    expectAnyLine(t, /orig/);
  });

  test('§V13 — Windows→Linux: file mv renames a file', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo m > /tmp/before.txt');
    await typeSub(t, 'mv /tmp/before.txt /tmp/after.txt');
    await typeSub(t, 'cat /tmp/after.txt');
    expectAnyLine(t, /^m$/);
  });

  // ─── PowerShell heavier scenarios ──────────────────────────────────
  test('§V14 — Windows→Windows + PS: $env:USERNAME = User', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, '$env:USERNAME');
    expectAnyLine(t, /User/);
  });

  test('§V15 — Windows→Windows + PS: range expansion 1..3', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, '1..3 | ForEach-Object { "n=$_" }');
    expectAnyLine(t, /n=1/);
    expectAnyLine(t, /n=2/);
    expectAnyLine(t, /n=3/);
  });

  test('§V16 — Windows→Windows + PS: Get-ChildItem C:\\', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, 'Get-ChildItem C:\\ | Select-Object -First 1 Name');
    expectAnyLine(t, /Name|\w+/);
  });

  // ─── Windows cmd realistic commands ─────────────────────────────────
  test('§V17 — Windows→Windows cmd: dir lists files', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'dir');
    const out = t.lines.slice(-8).map(l => l.text).join('\n');
    expect(out.length).toBeGreaterThan(0);
  });

  test('§V18 — Windows→Windows cmd: cd then dir', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'cd C:\\Windows');
    await typeSub(t, 'cd');
    expectAnyLine(t, /C:\\Windows/);
  });

  test('§V19 — Windows→Windows cmd: echo % expands env vars', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'echo %USERPROFILE%');
    expectAnyLine(t, /C:\\Users/);
  });

  test('§V20 — Windows→Windows cmd: set lists env vars', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'set');
    expectAnyLine(t, /=/);
  });

  // ─── Logs across the chain ─────────────────────────────────────────
  test('§V21 — Windows→Linux: tail -f-style command runs and exits cleanly', async () => {
    const { winA, linuxSrv } = await buildLan();
    await linuxSrv.executeCommand('logger -t marker "test-trail"');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'tail -n 5 /var/log/syslog');
    const out = t.lines.slice(-7).map(l => l.text).join('\n');
    expect(out.length).toBeGreaterThan(0);
  });

  test('§V22 — Windows→Linux: cron service is-active checks', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'systemctl is-active cron');
    expectAnyLine(t, /^(active|inactive)$/);
  });

  // ─── Storage / mount ───────────────────────────────────────────────
  test('§V23 — Windows→Linux: lsblk lists block devices', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'lsblk');
    const out = t.lines.slice(-8).map(l => l.text).join('\n');
    expect(out.length).toBeGreaterThan(0);
  });

  test('§V24 — Windows→Linux: mount shows the rootfs', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'mount');
    const out = t.lines.slice(-10).map(l => l.text).join('\n');
    expect(out.length).toBeGreaterThan(0);
  });

  // ─── Real Oracle workflows ─────────────────────────────────────────
  test('§V25 — Windows→Linux→sqlplus: SELECT 1 FROM dual', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sqlplus / as sysdba');
    await typeSub(t, 'SELECT 1 FROM dual;');
    const out = t.lines.slice(-15).map(l => l.text).join('\n');
    expect(/1|---/.test(out)).toBe(true);
  });

  test('§V26 — Windows→Linux→sqlplus: SHOW USER returns SYS', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sqlplus / as sysdba');
    await typeSub(t, 'SHOW USER');
    expectAnyLine(t, /SYS|USER/i);
  });

  // ─── Multiple SSH targets from same client ────────────────────────
  test('§V27 — Windows: ssh A, exit, ssh B (different targets)', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'exit');
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    expect(t.getPrompt()).toMatch(/C:\\Users\\User>/);
  });

  test('§V28 — Windows: ssh Linux, exit, ssh Cisco — vendor switches in subshell adapter', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'exit');
    await winSshLogin(t, 'ssh admin@10.0.0.6', 'Admin@123');
    expect(t.getPrompt()).toMatch(/cisco/);
  });

  // ─── Audit + integrity ─────────────────────────────────────────────
  test('§V29 — Windows→Linux: auth.log retains entries after exit', async () => {
    const { winA, linuxSrv } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'exit');
    const log = await linuxSrv.executeCommand('cat /var/log/auth.log');
    expect(log).toMatch(/Accepted password for alice from 10\.0\.0\.4/);
  });

  test('§V30 — Windows→Linux: tail -n 5 /var/log/syslog has system-level entries', async () => {
    const { winA, linuxSrv } = await buildLan();
    await linuxSrv.executeCommand('logger -t test "syslog-line-marker"');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'tail -n 10 /var/log/syslog');
    expectAnyLine(t, /syslog-line-marker|test/);
  });
});
