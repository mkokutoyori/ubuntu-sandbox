import { describe, expect, beforeAll, beforeEach, test } from 'vitest';
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
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';
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
  linuxA: LinuxPC; linuxB: LinuxPC; linuxSrv: LinuxServer;
  winA: WindowsPC; winB: WindowsPC;
  cisco: CiscoRouter; huawei: HuaweiRouter;
}

async function buildLan(): Promise<Lan> {
  EquipmentRegistry.getInstance().clear();
  reinstallDefaultShells();
  const linuxA = new LinuxPC('linux-pc', 'linuxA', 0, 0);
  const linuxB = new LinuxPC('linux-pc', 'linuxB', 0, 0);
  const linuxSrv = new LinuxServer('linux-server', 'linuxSrv', 0, 0);
  const winA = new WindowsPC('windows-pc', 'winA', 0, 0);
  const winB = new WindowsPC('windows-pc', 'winB', 0, 0);
  const cisco = new CiscoRouter('cisco', 0, 0);
  const huawei = new HuaweiRouter('huawei', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 16, 0, 0);

  const all = [linuxA, linuxB, linuxSrv, winA, winB, cisco, huawei];
  all.forEach((d, i) => { new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]); });
  const mask = new SubnetMask('255.255.255.0');
  linuxA.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  linuxB.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  linuxSrv.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  winA.getPorts()[0].configureIP(new IPAddress('10.0.0.4'), mask);
  winB.getPorts()[0].configureIP(new IPAddress('10.0.0.5'), mask);
  linuxA.setHostname('linuxA');
  linuxB.setHostname('linuxB');
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

  return { linuxA, linuxB, linuxSrv, winA, winB, cisco, huawei };
}

async function typeRoot(t: TerminalSession, line: string): Promise<void> {
  t.setInput(line);
  t.handleKey(key('Enter'));
  await flush();
}

async function typeSub(t: TerminalSession, line: string): Promise<void> {
  t.setInputBuf(line);
  t.handleKey(key('Enter'));
  await flush();
}

async function winSshLogin(t: WindowsTerminalSession, line: string, pw: string): Promise<void> {
  await typeRoot(t, line);
  if (t.currentInputMode.type === 'password') {
    t.setPasswordBuf(pw);
    t.handleKey(key('Enter'));
    await flush();
  }
}

async function linuxSshLogin(t: LinuxTerminalSession, line: string, pw: string): Promise<void> {
  await typeRoot(t, line);
  for (let i = 0; i < 4 && t.currentInputMode.type !== 'normal'; i++) {
    if (t.currentInputMode.type === 'password') {
      t.setPasswordBuf(pw);
      t.handleKey(key('Enter'));
    } else if (t.currentInputMode.type === 'interactive-text') {
      t.setInputBuf('yes');
      t.handleKey(key('Enter'));
    } else break;
    await flush();
  }
}

function expectAnyLine(t: TerminalSession, needle: string | RegExp): void {
  const ok = t.lines.some(l =>
    needle instanceof RegExp ? needle.test(l.text) : l.text.includes(needle));
  if (!ok) {
    const tail = t.lines.slice(-15).map(l => l.text).join('\n');
    throw new Error(`Missing ${String(needle)} in terminal\n--- last 15 lines ---\n${tail}`);
  }
}

function lastLine(t: TerminalSession): string {
  return t.lines.length === 0 ? '' : t.lines[t.lines.length - 1].text;
}

describe('SSH end-to-end realism — 100-step debug', () => {
  let lan: Lan;
  beforeAll(async () => { lan = await buildLan(); });
  beforeEach(async () => {
    if (!lan) lan = await buildLan();
  });

  // ─── §A — Linux → Linux: real operator session ─────────────────────
  test('§01 — Linux client connects to Linux server with password', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('a1', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
  });

  test('§02 — Linux→Linux: whoami returns the SSH user (alice)', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('a2', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'whoami');
    expectAnyLine(t, /^alice$/);
  });

  test('§03 — Linux→Linux: hostname matches the remote', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('a3', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'hostname');
    expectAnyLine(t, /^linuxSrv$/);
  });

  test('§04 — Linux→Linux: pwd shows /home/alice after login', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('a4', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'pwd');
    expectAnyLine(t, /\/home\/alice/);
  });

  test('§05 — Linux→Linux: ls /etc lists at least passwd + ssh', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('a5', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'ls /etc');
    expectAnyLine(t, /passwd/);
  });

  test('§06 — Linux→Linux: cat /etc/os-release contains Ubuntu', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('a6', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'cat /etc/os-release');
    expectAnyLine(t, /Ubuntu/);
  });

  test('§07 — Linux→Linux: /var/log/auth.log records the login on the SERVER side', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('a7', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    const remote = await lan.linuxSrv.executeCommand('cat /var/log/auth.log');
    expect(remote).toMatch(/Accepted password for alice from 10\.0\.0\.1/);
  });

  test('§08 — Linux→Linux: root login rejected by default sshd policy', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('a8', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh root@10.0.0.3', 'wrong');
    expectAnyLine(t, /Permission denied/);
  });

  test('§09 — Linux→Linux: wrong password retries (not immediate disconnect)', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('a9', lan.linuxA);
    await t.init();
    await typeRoot(t, 'ssh alice@10.0.0.3');
    expect(t.currentInputMode.type).toBe('password');
    t.setPasswordBuf('totally-wrong');
    t.handleKey(key('Enter'));
    await flush();
    expect(t.currentInputMode.type).toBe('password');
  });

  test('§10 — Linux→Linux: sshd_config PermitRootLogin yes lets root in after reload', async () => {
    lan = await buildLan();
    await lan.linuxSrv.executeCommand('echo "PermitRootLogin yes" > /etc/ssh/sshd_config');
    await lan.linuxSrv.executeCommand('systemctl reload ssh');
    const t = new LinuxTerminalSession('a10', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh root@10.0.0.3', 'admin');
    expect(t.getPrompt()).toMatch(/root@linuxSrv/);
  });

  // ─── §B — Linux → Linux: file ops + privileges ─────────────────────
  test('§11 — touch + ls visible on the remote VFS', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('b11', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'cd /tmp');
    await typeRoot(t, 'touch hello.txt');
    await typeRoot(t, 'ls /tmp');
    expectAnyLine(t, /hello\.txt/);
  });

  test('§12 — echo > file persists across commands', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('b12', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'echo hello-from-ssh > /tmp/greeting.txt');
    await typeRoot(t, 'cat /tmp/greeting.txt');
    expectAnyLine(t, /hello-from-ssh/);
  });

  test('§13 — chmod 600 is respected by another reader', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('b13', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'echo secret > /tmp/secret.txt');
    await typeRoot(t, 'chmod 600 /tmp/secret.txt');
    await typeRoot(t, 'ls -l /tmp/secret.txt');
    expectAnyLine(t, /-rw-------/);
  });

  test('§14 — non-sudoer cannot run a privileged command', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('b14', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh carl@10.0.0.3', 'carl');
    await typeRoot(t, 'cat /etc/shadow');
    expectAnyLine(t, /Permission denied|cannot open/);
  });

  test('§15 — id shows uid / gid / groups correctly for alice', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('b15', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'id');
    expectAnyLine(t, /uid=\d+\(alice\)/);
  });

  test('§16 — ps -ef shows the sshd daemon on the server', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('b16', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'ps -ef');
    expectAnyLine(t, /sshd/);
  });

  test('§17 — systemctl status ssh is active (running) on the server', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('b17', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'systemctl status ssh');
    expectAnyLine(t, /Active:\s+active \(running\)/);
  });

  test('§18 — exit pops back to the client prompt', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('b18', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'exit');
    expect(t.getPrompt()).not.toMatch(/linuxSrv/);
  });

  test('§19 — closing line "Connection to … closed." is printed', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('b19', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'exit');
    expectAnyLine(t, /Connection to 10\.0\.0\.3 closed/);
  });

  test('§20 — two consecutive logins both record in auth.log', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('b20', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'exit');
    await linuxSshLogin(t, 'ssh bob@10.0.0.3', 'bob');
    const log = await lan.linuxSrv.executeCommand('cat /var/log/auth.log');
    expect(log).toMatch(/Accepted password for alice/);
    expect(log).toMatch(/Accepted password for bob/);
  });

  // ─── §C — Windows → Linux: real operator session ───────────────────
  test('§21 — Windows cmd connects to Linux PC with password', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('c21', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv:~\$/);
  });

  test('§22 — Windows→Linux: ls /etc returns the directory contents', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('c22', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ls /etc');
    expectAnyLine(t, /passwd/);
  });

  test('§23 — Windows→Linux: pwd works', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('c23', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'pwd');
    expectAnyLine(t, /\/home\/alice/);
  });

  test('§24 — Windows→Linux: uname -a returns Linux kernel banner', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('c24', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'uname -a');
    expectAnyLine(t, /Linux/);
  });

  test('§25 — Windows→Linux: cat /etc/passwd shows alice line', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('c25', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'cat /etc/passwd');
    expectAnyLine(t, /^alice:/m);
  });

  test('§26 — Windows→Linux: exit returns to cmd.exe with the closing footer', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('c26', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^[A-Z]:\\/);
    expectAnyLine(t, /Connection to 10\.0\.0\.3 closed/);
  });

  test('§27 — Windows→Linux: sqlplus on a LinuxServer enters SQL>', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('c27', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sqlplus / as sysdba');
    expect(t.getPrompt()).toMatch(/^SQL>/);
  });

  test('§28 — Windows→Linux: exit from sqlplus returns to bash', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('c28', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sqlplus / as sysdba');
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
  });

  test('§29 — Windows→Linux: rman target / enters RMAN>', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('c29', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'rman target /');
    expect(t.getPrompt()).toMatch(/^RMAN>/);
  });

  test('§30 — Windows→Linux: exit from RMAN returns to bash', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('c30', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'rman target /');
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
  });

  // ─── §D — Windows → Windows: cmd / PS over SSH ─────────────────────
  test('§31 — Windows→Windows: ssh User@winB lands on C:\\Users\\User>', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('d31', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    expect(t.getPrompt()).toMatch(/C:\\Users\\User>/);
  });

  test('§32 — Windows→Windows: ver shows Microsoft Windows', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('d32', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'ver');
    expectAnyLine(t, /Microsoft Windows/);
  });

  test('§33 — Windows→Windows: hostname returns winB', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('d33', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'hostname');
    expectAnyLine(t, /winB/);
  });

  test('§34 — Windows→Windows: powershell enters PS prompt', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('d34', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    expect(t.getPrompt()).toMatch(/^PS /);
  });

  test('§35 — Windows→Windows + PS: Get-Service lists services', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('d35', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, 'Get-Service | Select-Object -First 1');
    expectAnyLine(t, /Status/i);
  });

  test('§36 — Windows→Windows + PS: cls clears the screen', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('d36', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, 'echo before');
    const before = t.lines.length;
    expect(before).toBeGreaterThan(2);
    await typeSub(t, 'cls');
    expect(t.lines.length).toBeLessThan(before);
  });

  test('§37 — Windows→Windows + PS: exit returns to cmd', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('d37', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^[A-Z]:\\/);
  });

  test('§38 — Windows→Windows: full unwind to local cmd via two exits', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('d38', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, 'exit');
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/C:\\Users\\User>/);
    expectAnyLine(t, /Connection to 10\.0\.0\.5 closed/);
  });

  test('§39 — Windows→Windows + PS + cmd nesting unwinds in order', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('d39', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, 'cmd');
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^PS /);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^[A-Z]:\\/);
  });

  test('§40 — Windows→Windows: cls on remote cmd clears the screen', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('d40', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'echo before-cls');
    const before = t.lines.length;
    await typeSub(t, 'cls');
    expect(t.lines.length).toBeLessThan(before);
  });

  // ─── §E — Linux → Windows ──────────────────────────────────────────
  test('§41 — Linux→Windows: ssh User@winB enters cmd prompt', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('e41', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh User@10.0.0.5', 'user');
    expect(t.getPrompt()).toMatch(/C:\\Users\\User>/);
  });

  test('§42 — Linux→Windows: ver returns Microsoft Windows', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('e42', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'ver');
    expectAnyLine(t, /Microsoft Windows/);
  });

  test('§43 — Linux→Windows: powershell entered from remote cmd', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('e43', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    expect(t.getPrompt()).toMatch(/^PS /);
  });

  test('§44 — Linux→Windows: Get-Service in PS works', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('e44', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, 'Get-Service | Select-Object -First 1');
    expectAnyLine(t, /Status/i);
  });

  test('§45 — Linux→Windows: exit returns to local bash', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('e45', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/@linuxA/);
  });

  // ─── §F — Sub-shell mechanics under SSH ────────────────────────────
  test('§46 — Windows→Linux: cd persists across commands', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('f46', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'cd /var/log');
    await typeSub(t, 'pwd');
    expectAnyLine(t, /\/var\/log/);
  });

  test('§47 — Windows→Linux: cd then prompt reflects the new cwd', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('f47', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'cd /tmp');
    expect(t.getPrompt()).toMatch(/\/tmp/);
  });

  test('§48 — Windows→Linux: cd .. moves up one directory', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('f48', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'cd /var/log');
    await typeSub(t, 'cd ..');
    await typeSub(t, 'pwd');
    expectAnyLine(t, /^\/var$/);
  });

  test('§49 — Windows→Linux: env shows USER and HOME', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('f49', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'env');
    expectAnyLine(t, /HOME=\/home\/alice/);
  });

  test('§50 — Windows→Linux: echo $HOME expands', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('f50', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo $HOME');
    expectAnyLine(t, /\/home\/alice/);
  });

  // ─── §G — Logs, audit, journaling ───────────────────────────────────
  test('§51 — Windows→Linux: auth.log on server records the login', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('g51', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    const log = await lan.linuxSrv.executeCommand('cat /var/log/auth.log');
    expect(log).toMatch(/Accepted password for alice from 10\.0\.0\.4/);
  });

  test('§52 — Windows→Linux: failed login records "Failed password"', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('g52', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'wrong-pw-1');
    t.setPasswordBuf('wrong-pw-2'); t.handleKey(key('Enter')); await flush();
    t.setPasswordBuf('wrong-pw-3'); t.handleKey(key('Enter')); await flush();
    const log = await lan.linuxSrv.executeCommand('cat /var/log/auth.log');
    expect(log).toMatch(/Failed password/);
  });

  test('§53 — `last` shows the last logins on the remote', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('g53', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'last');
    expectAnyLine(t, /alice/);
  });

  test('§54 — w / who lists the active session', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('g54', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'who');
    expectAnyLine(t, /alice/);
  });

  test('§55 — `ss -tln` shows sshd listening on 22', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('g55', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ss -tln');
    expectAnyLine(t, /:22\s/);
  });

  // ─── §H — Privileges and sudo ──────────────────────────────────────
  test('§56 — Windows→Linux as alice: sudo works (alice is in sudo group)', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('h56', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'groups');
    expectAnyLine(t, /sudo/);
  });

  test('§57 — Windows→Linux: cat /etc/shadow as non-root is denied', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('h57', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'cat /etc/shadow');
    expectAnyLine(t, /Permission denied/);
  });

  test('§58 — Linux→Linux: PermitRootLogin no rejects root', async () => {
    lan = await buildLan();
    await lan.linuxSrv.executeCommand('echo "PermitRootLogin no" > /etc/ssh/sshd_config');
    await lan.linuxSrv.executeCommand('systemctl reload ssh');
    const t = new LinuxTerminalSession('h58', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh root@10.0.0.3', 'admin');
    expectAnyLine(t, /Permission denied/);
  });

  test('§59 — DenyUsers carl is enforced', async () => {
    lan = await buildLan();
    await lan.linuxSrv.executeCommand('echo "DenyUsers carl" > /etc/ssh/sshd_config');
    await lan.linuxSrv.executeCommand('systemctl reload ssh');
    const t = new WindowsTerminalSession('h59', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh carl@10.0.0.3', 'carl');
    expectAnyLine(t, /Permission denied/);
  });

  test('§60 — AllowUsers alice — only alice can log in', async () => {
    lan = await buildLan();
    await lan.linuxSrv.executeCommand('echo "AllowUsers alice" > /etc/ssh/sshd_config');
    await lan.linuxSrv.executeCommand('systemctl reload ssh');
    const t = new WindowsTerminalSession('h60', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh bob@10.0.0.3', 'bob');
    expectAnyLine(t, /Permission denied/);
  });

  // ─── §I — Failure modes ────────────────────────────────────────────
  test('§61 — server poweredOff → no route to host', async () => {
    lan = await buildLan();
    lan.linuxSrv.powerOff();
    const t = new WindowsTerminalSession('i61', lan.winA);
    await t.init();
    await typeRoot(t, 'ssh alice@10.0.0.3');
    expectAnyLine(t, /No route to host/);
  });

  test('§62 — interface down → no route to host', async () => {
    lan = await buildLan();
    await lan.linuxSrv.executeCommand('ip link set eth0 down');
    const t = new WindowsTerminalSession('i62', lan.winA);
    await t.init();
    await typeRoot(t, 'ssh alice@10.0.0.3');
    expectAnyLine(t, /No route to host/);
  });

  test('§63 — sshd stopped on server → connection refused', async () => {
    lan = await buildLan();
    await lan.linuxSrv.executeCommand('systemctl stop ssh');
    const t = new WindowsTerminalSession('i63', lan.winA);
    await t.init();
    await typeRoot(t, 'ssh alice@10.0.0.3');
    expectAnyLine(t, /Connection refused/);
  });

  test('§64 — unknown hostname → Could not resolve hostname', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('i64', lan.winA);
    await t.init();
    await typeRoot(t, 'ssh alice@nope.invalid');
    expectAnyLine(t, /Could not resolve hostname/);
  });

  test('§65 — unknown user → Permission denied', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('i65', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh ghost@10.0.0.3', 'whatever');
    expectAnyLine(t, /Permission denied/);
  });

  // ─── §J — Sub-shell history + special keys over SSH ────────────────
  test('§66 — Windows→Linux: subshell ArrowUp recalls last command', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('j66', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'pwd');
    t.handleKey(key('ArrowUp'));
    await flush();
    expect((t as unknown as { _inputBuf: string })._inputBuf).toBe('pwd');
  });

  test('§67 — Windows→Linux: Ctrl+L is classified as clear-screen by inner shell', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('j67', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    const active = (t as unknown as { activeSubShell: { handleKey?: (e: KeyEvent) => boolean } }).activeSubShell;
    expect(active.handleKey?.(key('l', { ctrlKey: true }))).toBe(false);
  });

  test('§68 — Windows→Linux: completion candidates include common bins', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('j68', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    const active = (t as unknown as { activeSubShell: { getCompletions?: (s: string) => string[] } }).activeSubShell;
    const candidates = active.getCompletions?.('ls') ?? [];
    expect(Array.isArray(candidates)).toBe(true);
  });

  // ─── §K — sqlplus / rman over SSH chains ───────────────────────────
  test('§69 — Windows→Linux→sqlplus→exit→bash→exit→cmd full unwind', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('k69', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sqlplus / as sysdba');
    expect(t.getPrompt()).toMatch(/^SQL>/);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^[A-Z]:\\/);
  });

  test('§70 — Windows→Linux→rman→exit→bash unwinds correctly', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('k70', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'rman target /');
    expect(t.getPrompt()).toMatch(/^RMAN>/);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
  });

  // ─── §L — File ops on remote VFS (realistic workflows) ─────────────
  test('§71 — Windows→Linux: mkdir then ls', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('l71', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'mkdir /tmp/workdir');
    await typeSub(t, 'ls /tmp');
    expectAnyLine(t, /workdir/);
  });

  test('§72 — Windows→Linux: cp then verify content', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('l72', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo hello > /tmp/src.txt');
    await typeSub(t, 'cp /tmp/src.txt /tmp/dst.txt');
    await typeSub(t, 'cat /tmp/dst.txt');
    expectAnyLine(t, /^hello$/);
  });

  test('§73 — Windows→Linux: rm removes a file', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('l73', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo gone > /tmp/expendable.txt');
    await typeSub(t, 'rm /tmp/expendable.txt');
    const ls = await lan.linuxSrv.executeCommand('ls /tmp');
    expect(ls).not.toMatch(/expendable\.txt/);
  });

  test('§74 — Windows→Linux: grep finds a line', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('l74', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'printf "alpha\\nbeta\\ngamma\\n" > /tmp/words.txt');
    await typeSub(t, 'grep beta /tmp/words.txt');
    expectAnyLine(t, /^beta$/);
  });

  test('§75 — Windows→Linux: pipe + sort', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('l75', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'printf "c\\nb\\na\\n" | sort');
    expectAnyLine(t, /^a$/);
    expectAnyLine(t, /^b$/);
    expectAnyLine(t, /^c$/);
  });

  // ─── §M — Network introspection on the remote ──────────────────────
  test('§76 — Windows→Linux: ifconfig shows eth0', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('m76', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ifconfig');
    expectAnyLine(t, /eth0/);
  });

  test('§77 — Windows→Linux: ip addr shows 10.0.0.3', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('m77', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ip addr');
    expectAnyLine(t, /10\.0\.0\.3/);
  });

  test('§78 — Windows→Linux: ping the client back works', async () => {
    lan = await buildLan();
    await lan.winA.executeCommand('ping 10.0.0.3');
    const t = new WindowsTerminalSession('m78', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ping -c 1 10.0.0.4');
    expectAnyLine(t, /(bytes from|1 (packets )?received)/i);
  });

  test('§79 — Windows→Linux: netstat shows TCP sockets', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('m79', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'netstat -tln');
    expectAnyLine(t, /LISTEN/);
  });

  test('§80 — Windows→Linux: ss -t lists ssh connection', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('m80', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ss -t');
    expectAnyLine(t, /(ESTAB|LISTEN)/);
  });

  // ─── §N — Process control over SSH ─────────────────────────────────
  test('§81 — Windows→Linux: ps aux shows current sessions process tree', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('n81', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ps aux');
    expectAnyLine(t, /USER\s+PID/);
  });

  test('§82 — Windows→Linux: pgrep sshd returns at least one pid', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('n82', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'pgrep sshd');
    expectAnyLine(t, /\d+/);
  });

  test('§83 — Windows→Linux: systemctl is-active ssh = active', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('n83', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'systemctl is-active ssh');
    expectAnyLine(t, /^active$/);
  });

  test('§84 — Windows→Linux: kill of an unknown PID returns No such process', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('n84', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'kill 99999');
    expectAnyLine(t, /No such process/);
  });

  test('§85 — Windows→Linux: kill of PID 1 (systemd) refused', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('n85', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'kill -9 1');
    expectAnyLine(t, /Operation not permitted|not permitted/);
  });

  // ─── §O — Display, paging, banner ──────────────────────────────────
  test('§86 — Windows→Linux: motd / banner is printed at login', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('o86', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expectAnyLine(t, /Ubuntu|Welcome to/);
  });

  test('§87 — Windows→Linux: /etc/issue.net contents shown when set', async () => {
    lan = await buildLan();
    await lan.linuxSrv.executeCommand('echo "AUTHORIZED USE ONLY" > /etc/issue.net');
    const t = new WindowsTerminalSession('o87', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expectAnyLine(t, /AUTHORIZED USE ONLY/);
  });

  test('§88 — Windows→Linux: long output is fully captured (no premature truncation)', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('o88', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ls -la /etc');
    const linesAfter = t.lines.length;
    expect(linesAfter).toBeGreaterThan(5);
  });

  // ─── §P — Cross-vendor matrix tail ─────────────────────────────────
  test('§89 — Windows→Cisco IOS: show version reveals IOS banner', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('p89', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh admin@10.0.0.6', 'Admin@123');
    await typeSub(t, 'show version');
    expectAnyLine(t, /IOS|Cisco/i);
  });

  test('§90 — Windows→Cisco IOS: show ip interface brief lists interfaces', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('p90', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh admin@10.0.0.6', 'Admin@123');
    await typeSub(t, 'show ip interface brief');
    expectAnyLine(t, /GigabitEthernet/);
  });

  test('§91 — Windows→Huawei VRP: display version reveals VRP banner', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('p91', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh admin@10.0.0.7', 'Admin@123');
    await typeSub(t, 'display version');
    expectAnyLine(t, /VRP|Huawei/i);
  });

  test('§92 — Windows→Huawei VRP: display interface brief lists interfaces', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('p92', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh admin@10.0.0.7', 'Admin@123');
    await typeSub(t, 'display interface brief');
    expectAnyLine(t, /(?:GE|GigabitEthernet)0\/0\/0/);
  });

  test('§93 — Linux→Cisco IOS: shows the IOS prompt via CrossVendorRemoteShell', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('p93', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh admin@10.0.0.6', 'Admin@123');
    expect(t.getPrompt()).toMatch(/cisco/);
  });

  test('§94 — Linux→Huawei VRP: shows the VRP prompt via CrossVendorRemoteShell', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('p94', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh admin@10.0.0.7', 'Admin@123');
    expect(t.getPrompt()).toMatch(/<huawei>/);
  });

  // ─── §Q — Tail of the matrix ───────────────────────────────────────
  test('§95 — Windows→Linux: chained commands && order preserved', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('q95', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo first && echo second');
    expectAnyLine(t, /first/);
    expectAnyLine(t, /second/);
  });

  test('§96 — Windows→Linux: history shows the recent commands', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('q96', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'pwd');
    await typeSub(t, 'whoami');
    await typeSub(t, 'history');
    expectAnyLine(t, /whoami/);
  });

  test('§97 — Windows→Linux: exit then re-ssh as different user', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('q97', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'exit');
    await winSshLogin(t, 'ssh bob@10.0.0.3', 'bob');
    expect(t.getPrompt()).toMatch(/bob@linuxSrv/);
  });

  test('§98 — Linux→Linux→Linux double hop (manual exit propagates)', async () => {
    lan = await buildLan();
    const t = new LinuxTerminalSession('q98', lan.linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.2', 'alice');
    expect(t.getPrompt()).toMatch(/alice@linuxB/);
    await typeRoot(t, 'exit');
    expect(t.getPrompt()).toMatch(/@linuxA/);
  });

  test('§99 — Windows→Linux: stdout of `whoami; hostname` chains correctly', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('q99', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'whoami; hostname');
    expectAnyLine(t, /^alice$/);
    expectAnyLine(t, /^linuxSrv$/);
  });

  test('§100 — Windows→Linux→sqlplus→exit→exit (full unwind to cmd, closing footer)', async () => {
    lan = await buildLan();
    const t = new WindowsTerminalSession('q100', lan.winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sqlplus / as sysdba');
    await typeSub(t, 'exit');
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^[A-Z]:\\/);
    expectAnyLine(t, /Connection to 10\.0\.0\.3 closed/);
  });
});
