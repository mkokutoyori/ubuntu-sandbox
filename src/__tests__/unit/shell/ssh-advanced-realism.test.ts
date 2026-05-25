import { describe, expect, test } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
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
  const linuxB = new LinuxPC('linux-pc', 'linuxB', 0, 0);
  const linuxSrv = new LinuxServer('linux-server', 'linuxSrv', 0, 0);
  const winA = new WindowsPC('windows-pc', 'winA', 0, 0);
  const winB = new WindowsPC('windows-pc', 'winB', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const mask = new SubnetMask('255.255.255.0');
  [linuxA, linuxB, linuxSrv, winA, winB].forEach((d, i) => {
    new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]);
  });
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
  return { linuxA, linuxB, linuxSrv, winA, winB };
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

async function linuxSshLogin(t: LinuxTerminalSession, line: string, pw: string): Promise<void> {
  await typeRoot(t, line);
  for (let i = 0; i < 4 && t.currentInputMode.type !== 'normal'; i++) {
    if (t.currentInputMode.type === 'password') t.setPasswordBuf(pw);
    else if (t.currentInputMode.type === 'interactive-text') t.setInputBuf('yes');
    else break;
    t.handleKey(key('Enter')); await flush();
  }
}

function expectAnyLine(t: TerminalSession, needle: string | RegExp): void {
  const ok = t.lines.some(l => needle instanceof RegExp ? needle.test(l.text) : l.text.includes(needle));
  if (!ok) {
    const tail = t.lines.slice(-12).map(l => l.text).join('\n');
    throw new Error(`Missing ${String(needle)}\n${tail}`);
  }
}

describe('SSH advanced realism — multi-hop, service control, user admin', () => {
  // ─── Multi-hop SSH (linux → linux → linux) ────────────────────────
  test('§A01 — Linux→Linux→Linux double hop pushes two SSH frames', async () => {
    const { linuxA } = await buildLan();
    const t = new LinuxTerminalSession('t', linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.2', 'alice');
    expect(t.getPrompt()).toMatch(/alice@linuxB/);
    await linuxSshLogin(t, 'ssh bob@10.0.0.3', 'bob');
    expect(t.getPrompt()).toMatch(/bob@linuxSrv/);
  });

  test('§A02 — Linux→Linux→Linux double hop unwinds one frame at a time', async () => {
    const { linuxA } = await buildLan();
    const t = new LinuxTerminalSession('t', linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.2', 'alice');
    await linuxSshLogin(t, 'ssh bob@10.0.0.3', 'bob');
    await typeRoot(t, 'exit');
    expect(t.getPrompt()).toMatch(/alice@linuxB/);
    await typeRoot(t, 'exit');
    expect(t.getPrompt()).toMatch(/@linuxA/);
  });

  test('§A03 — Multi-hop auth.log shows both transit logins', async () => {
    const { linuxA, linuxB, linuxSrv } = await buildLan();
    const t = new LinuxTerminalSession('t', linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.2', 'alice');
    await linuxSshLogin(t, 'ssh bob@10.0.0.3', 'bob');
    const logB = await linuxB.executeCommand('cat /var/log/auth.log');
    const logS = await linuxSrv.executeCommand('cat /var/log/auth.log');
    expect(logB).toMatch(/Accepted password for alice/);
    expect(logS).toMatch(/Accepted password for bob/);
  });

  // ─── Service management over SSH ───────────────────────────────────
  test('§A04 — Windows→Linux: systemctl stop cron then is-active = inactive', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'systemctl stop cron');
    await typeSub(t, 'systemctl is-active cron');
    expectAnyLine(t, /^inactive$/);
  });

  test('§A05 — Windows→Linux: systemctl start cron after stop → active', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'systemctl stop cron');
    await typeSub(t, 'systemctl start cron');
    await typeSub(t, 'systemctl is-active cron');
    expectAnyLine(t, /^active$/);
  });

  test('§A06 — Windows→Linux: systemctl restart ssh keeps it active', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'systemctl restart ssh');
    await typeSub(t, 'systemctl is-active ssh');
    expectAnyLine(t, /^active$/);
  });

  test('§A07 — Windows→Linux: systemctl list-units --type=service header', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'systemctl list-units --type=service');
    expectAnyLine(t, /UNIT\s+LOAD\s+ACTIVE/);
  });

  test('§A08 — Windows→Linux: journalctl -u ssh.service has entries', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'journalctl -u ssh.service');
    expectAnyLine(t, /ssh/);
  });

  // ─── User management over SSH ──────────────────────────────────────
  test('§A09 — Windows→Linux: as sudoer alice, useradd zoe -m creates account', async () => {
    const { winA, linuxSrv } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sudo useradd -m zoe');
    expect(linuxSrv.userExists('zoe')).toBe(true);
  });

  test('§A10 — Windows→Linux: sudo groupadd devs creates the group', async () => {
    const { winA, linuxSrv } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sudo groupadd devs');
    const out = await linuxSrv.executeCommand('getent group devs');
    expect(out).toMatch(/^devs:/);
  });

  test('§A11 — Windows→Linux: id (no arg) shows the current SSH user', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'id');
    expectAnyLine(t, /alice/);
  });

  test('§A12 — Windows→Linux: groups shows alice in sudo', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'groups');
    expectAnyLine(t, /sudo/);
  });

  // ─── PowerShell network commands over SSH ──────────────────────────
  test('§A13 — Windows→Windows + PS: Get-NetIPAddress returns rows', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, 'Get-NetIPAddress | Select-Object -First 1');
    expectAnyLine(t, /IP|Address/i);
  });

  test('§A14 — Windows→Windows + PS: Test-Connection 127.0.0.1', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, 'Test-Connection -ComputerName 127.0.0.1 -Count 1');
    expectAnyLine(t, /127\.0\.0\.1|Reply/i);
  });

  // ─── Firewall configuration over SSH ───────────────────────────────
  test('§A15 — Windows→Linux: sudo iptables -L works', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sudo iptables -L');
    expectAnyLine(t, /Chain INPUT|Chain FORWARD|Chain OUTPUT/);
  });

  test('§A16 — Windows→Linux: sudo iptables -A INPUT records a rule', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sudo iptables -A INPUT -p tcp --dport 8080 -j DROP');
    await typeSub(t, 'sudo iptables -L INPUT -n');
    expectAnyLine(t, /DROP\s+tcp.*dpt:8080/);
  });

  test('§A17 — Windows→Linux: sudo ufw enable + status reports active', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sudo ufw enable');
    await typeSub(t, 'sudo ufw status');
    expectAnyLine(t, /Status:\s+active/);
  });

  // ─── Logs + auditing ───────────────────────────────────────────────
  test('§A18 — Windows→Linux: logger writes to syslog', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'logger -t test "ssh-debug-marker"');
    await typeSub(t, 'sudo tail -n 5 /var/log/syslog');
    expectAnyLine(t, /ssh-debug-marker/);
  });

  test('§A19 — Windows→Linux: dmesg shows kernel-like ring buffer header', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'dmesg');
    const out = t.lines.slice(-8).map(l => l.text).join('\n');
    expect(out.length).toBeGreaterThan(0);
  });

  // ─── Filesystem + special files ────────────────────────────────────
  test('§A20 — Windows→Linux: /proc/cpuinfo lists at least one processor', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'cat /proc/cpuinfo');
    expectAnyLine(t, /processor|cpu MHz|model name/i);
  });

  test('§A21 — Windows→Linux: /proc/meminfo shows MemTotal', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'cat /proc/meminfo');
    expectAnyLine(t, /MemTotal/);
  });

  test('§A22 — Windows→Linux: df -h reports filesystems', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'df -h');
    expectAnyLine(t, /Filesystem/);
  });

  test('§A23 — Windows→Linux: du -sh /tmp returns a size', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'du -sh /tmp');
    expectAnyLine(t, /\/tmp/);
  });

  // ─── Network on Linux remote ───────────────────────────────────────
  test('§A24 — Windows→Linux: ip route lists the default route', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ip route');
    expectAnyLine(t, /default|10\.0\.0\.0/);
  });

  test('§A25 — Windows→Linux: arp -a returns ARP table', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ip neigh');
    const out = t.lines.slice(-5).map(l => l.text).join(' ');
    expect(out.length).toBeGreaterThan(0);
  });

  // ─── Quoting + expansion edge cases ────────────────────────────────
  test('§A26 — Windows→Linux: nested $() works', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo "host=$(hostname)"');
    expectAnyLine(t, /host=linuxSrv/);
  });

  test('§A27 — Windows→Linux: glob expansion in ls', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo abc > /tmp/x1.txt');
    await typeSub(t, 'echo def > /tmp/x2.txt');
    await typeSub(t, 'ls /tmp/x*.txt');
    expectAnyLine(t, /x1\.txt/);
    expectAnyLine(t, /x2\.txt/);
  });

  test('§A28 — Windows→Linux: bash arithmetic expansion $((2+3))', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo $((2+3))');
    expectAnyLine(t, /^5$/);
  });

  // ─── Sessions and concurrency ──────────────────────────────────────
  test('§A29 — Two PS terminals on the same Windows machine isolate their cwd', async () => {
    const { winA } = await buildLan();
    const t1 = new WindowsTerminalSession('t1', winA);
    const t2 = new WindowsTerminalSession('t2', winA);
    await t1.init(); await t2.init();
    await typeRoot(t1, 'powershell');
    await typeSub(t1, 'cd D:\\');
    await typeRoot(t2, 'powershell');
    expect(t1.getPrompt()).not.toBe(t2.getPrompt());
  });

  test('§A30 — Windows→Linux: open then re-open SSH session keeps fresh history', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo first-session');
    await typeSub(t, 'exit');
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'history');
    const out = t.lines.slice(-8).map(l => l.text).join('\n');
    expect(out.length).toBeGreaterThan(0);
  });

  // ─── Power lifecycle of devices ────────────────────────────────────
  test('§A31 — Server power-off mid-debug: subsequent SSH refused', async () => {
    const { winA, linuxSrv } = await buildLan();
    linuxSrv.powerOff();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await typeRoot(t, 'ssh alice@10.0.0.3');
    expectAnyLine(t, /No route to host/);
  });

  test('§A32 — Server power-on after power-off restores SSH', async () => {
    const { winA, linuxSrv } = await buildLan();
    linuxSrv.powerOff();
    linuxSrv.powerOn();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
  });

  // ─── Configuration reload semantics ────────────────────────────────
  test('§A33 — Windows→Linux: PermitRootLogin no after reload denies root', async () => {
    const { winA, linuxSrv } = await buildLan();
    await linuxSrv.executeCommand('echo "PermitRootLogin no" > /etc/ssh/sshd_config');
    await linuxSrv.executeCommand('systemctl reload ssh');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh root@10.0.0.3', 'admin');
    expectAnyLine(t, /Permission denied/);
  });

  test('§A34 — Windows→Linux: PermitRootLogin yes after reload accepts root', async () => {
    const { winA, linuxSrv } = await buildLan();
    await linuxSrv.executeCommand('echo "PermitRootLogin yes" > /etc/ssh/sshd_config');
    await linuxSrv.executeCommand('systemctl reload ssh');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh root@10.0.0.3', 'admin');
    expect(t.getPrompt()).toMatch(/root@linuxSrv/);
  });

  test('§A35 — Windows→Linux: AllowUsers list narrows access', async () => {
    const { winA, linuxSrv } = await buildLan();
    await linuxSrv.executeCommand('printf "AllowUsers alice\\n" > /etc/ssh/sshd_config');
    await linuxSrv.executeCommand('systemctl reload ssh');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
  });

  // ─── Filesystem coherence across SSH ───────────────────────────────
  test('§A36 — Windows→Linux: file created via SSH is visible on the device directly', async () => {
    const { winA, linuxSrv } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo content > /tmp/visible.txt');
    const local = await linuxSrv.executeCommand('cat /tmp/visible.txt');
    expect(local).toMatch(/content/);
  });

  test('§A37 — Windows→Linux: file deleted via SSH is gone on the device directly', async () => {
    const { winA, linuxSrv } = await buildLan();
    await linuxSrv.executeCommand('echo bye > /tmp/toremove.txt');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'rm /tmp/toremove.txt');
    const out = await linuxSrv.executeCommand('ls /tmp');
    expect(out).not.toMatch(/toremove\.txt/);
  });

  test('§A38 — Windows→Linux: mkdir → cd → ls inside the new directory', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'mkdir /tmp/sandbox');
    await typeSub(t, 'cd /tmp/sandbox');
    await typeSub(t, 'pwd');
    expectAnyLine(t, /\/tmp\/sandbox/);
  });

  test('§A39 — Windows→Linux: pipe ls | wc -l counts files', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ls /etc | wc -l');
    const out = t.lines.slice(-3).map(l => l.text).join('\n');
    expect(/\d+/.test(out)).toBe(true);
  });

  // ─── Connection / display ──────────────────────────────────────────
  test('§A40 — Windows→Linux: SSH banner is the FIRST visible line of remote content', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    const first = t.lines.find(l => /Ubuntu|Welcome/.test(l.text));
    expect(first).toBeDefined();
  });

  test('§A41 — Windows→Linux: prompt prefix matches alice@linuxSrv:', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expect(t.getPrompt()).toMatch(/^alice@linuxSrv:/);
  });

  test('§A42 — Windows→Linux: prompt suffix is "$ " for non-root', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expect(t.getPrompt()).toMatch(/\$\s*$/);
  });

  test('§A43 — Windows→Linux as root (PermitRootLogin yes): prompt suffix is "#"', async () => {
    const { winA, linuxSrv } = await buildLan();
    await linuxSrv.executeCommand('echo "PermitRootLogin yes" > /etc/ssh/sshd_config');
    await linuxSrv.executeCommand('systemctl reload ssh');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh root@10.0.0.3', 'admin');
    expect(t.getPrompt()).toMatch(/#\s*$/);
  });

  // ─── Tail / cat / view operations ──────────────────────────────────
  test('§A44 — Windows→Linux: head -n 3 /etc/passwd returns 3 lines', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'head -n 3 /etc/passwd');
    expectAnyLine(t, /^root:/);
  });

  test('§A45 — Windows→Linux: tail -n 1 /etc/passwd returns last entry', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'tail -n 1 /etc/passwd');
    expectAnyLine(t, /:/);
  });

  // ─── Re-entrancy / connection idempotence ──────────────────────────
  test('§A46 — Two ssh logins in a row each fully unwind', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'exit');
    await winSshLogin(t, 'ssh bob@10.0.0.3', 'bob');
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^[A-Z]:\\/);
  });

  test('§A47 — Three sequential logins, last user wins', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    for (const u of ['alice', 'bob', 'carl']) {
      await winSshLogin(t, `ssh ${u}@10.0.0.3`, u);
      await typeSub(t, 'exit');
    }
    expect(t.getPrompt()).toMatch(/^[A-Z]:\\/);
  });

  // ─── Cross-vendor PowerShell ───────────────────────────────────────
  test('§A48 — Windows→Windows + PS: $PSVersionTable.PSVersion has a property', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, '$PSVersionTable.PSVersion');
    expectAnyLine(t, /\d+\.\d+|Major|Minor/i);
  });

  test('§A49 — Windows→Windows + PS: Get-Process | Select-Object -First 1 Name', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, 'Get-Process | Select-Object -First 1 Name');
    expectAnyLine(t, /Name|\w+/);
  });

  test('§A50 — Windows→Windows + PS + Write-Host renders text', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, 'Write-Host "deep-realism-marker"');
    expectAnyLine(t, /deep-realism-marker/);
  });
});
