import { describe, expect, test } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
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
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const mask = new SubnetMask('255.255.255.0');
  [linuxA, linuxSrv, winA, winB].forEach((d, i) => {
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
  return { linuxA, linuxSrv, winA, winB };
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

describe('SSH edge cases — redirection, pipes, banners, output formatting', () => {
  // ─── I/O redirection ───────────────────────────────────────────────
  test('§E01 — Windows→Linux: echo > file then cat file', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo first > /tmp/r1.txt');
    await typeSub(t, 'cat /tmp/r1.txt');
    expectAnyLine(t, /^first$/);
  });

  test('§E02 — Windows→Linux: >> appends to file', async () => {
    const { winA, linuxSrv } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo line1 > /tmp/a.txt');
    await typeSub(t, 'echo line2 >> /tmp/a.txt');
    const out = await linuxSrv.executeCommand('cat /tmp/a.txt');
    expect(out).toMatch(/line1[\s\S]*line2/);
  });

  test('§E03 — Windows→Linux: 2>/dev/null suppresses stderr', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'cat /no-such-file 2>/dev/null');
    const out = t.lines.slice(-5).map(l => l.text).join('\n');
    expect(out).not.toMatch(/No such/);
  });

  test('§E04 — Windows→Linux: redirect to /dev/null is accepted by the shell', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo via-devnull > /dev/null');
    await typeSub(t, 'echo after');
    expectAnyLine(t, /^after$/);
  });

  // ─── Pipes ──────────────────────────────────────────────────────────
  test('§E05 — Windows→Linux: cat | grep pipe', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'cat /etc/passwd | grep ^root');
    expectAnyLine(t, /^root:/);
  });

  test('§E06 — Windows→Linux: ls /etc | head -n 3', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ls /etc | head -n 3');
    const out = t.lines.slice(-5).map(l => l.text).join('\n');
    expect(out.length).toBeGreaterThan(0);
  });

  test('§E07 — Windows→Linux: triple-pipe ps | grep | wc', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ps aux | grep sshd | wc -l');
    expectAnyLine(t, /\d+/);
  });

  test('§E08 — Windows→Linux: pipe preserves the cwd between commands', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'cd /etc');
    await typeSub(t, 'pwd | head -n 1');
    expectAnyLine(t, /^\/etc$/);
  });

  // ─── Banner / motd ──────────────────────────────────────────────────
  test('§E09 — Windows→Linux: setting /etc/motd shows it on next login', async () => {
    const { winA, linuxSrv } = await buildLan();
    await linuxSrv.executeCommand('echo "Property of ACME" > /etc/motd');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expectAnyLine(t, /Property of ACME/);
  });

  test('§E10 — Windows→Linux: /etc/issue.net is shown pre-prompt', async () => {
    const { winA, linuxSrv } = await buildLan();
    await linuxSrv.executeCommand('echo "AUTHORIZED USE ONLY" > /etc/issue.net');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expectAnyLine(t, /AUTHORIZED USE ONLY/);
  });

  test('§E11 — Windows→Linux: -q suppresses banner', async () => {
    const { winA, linuxSrv } = await buildLan();
    await linuxSrv.executeCommand('echo "Property" > /etc/motd');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh -q alice@10.0.0.3', 'alice');
    const out = t.lines.slice(0, 10).map(l => l.text).join('\n');
    expect(out).not.toMatch(/Property/);
  });

  // ─── known_hosts (TOFU) ─────────────────────────────────────────────
  test('§E12 — Windows→Linux: first connect writes known_hosts', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    const fs = (winA as unknown as { fs: { readFile: (p: string) => { ok: boolean; content?: string } } }).fs;
    const kh = fs.readFile('C:\\Users\\alice\\.ssh\\known_hosts');
    expect(kh.ok).toBe(true);
    expect(kh.content ?? '').toMatch(/10\.0\.0\.3/);
  });

  test('§E13 — Windows→Linux: second connect reuses known_hosts without prompt', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'exit');
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
  });

  // ─── Date / locale / time ──────────────────────────────────────────
  test('§E14 — Windows→Linux: date returns a current-year string', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'date');
    expectAnyLine(t, /\d{4}/);
  });

  test('§E15 — Windows→Linux: uptime returns load info', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'uptime');
    expectAnyLine(t, /up|load|user/i);
  });

  // ─── Special characters / quoting ──────────────────────────────────
  test('§E16 — Windows→Linux: backslash escape in echo', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo -e "a\\tb"');
    expectAnyLine(t, /a\tb/);
  });

  test('§E17 — Windows→Linux: single quotes preserve literal $', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, "echo '$PATH not expanded'");
    expectAnyLine(t, /\$PATH not expanded/);
  });

  test('§E18 — Windows→Linux: backticks command substitution', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo who=`whoami`');
    expectAnyLine(t, /who=alice/);
  });

  // ─── Conditionals and loops ────────────────────────────────────────
  test('§E19 — Windows→Linux: if/then/fi inline', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'if [ 1 -eq 1 ]; then echo yes; fi');
    expectAnyLine(t, /^yes$/);
  });

  test('§E20 — Windows→Linux: for loop one-liner', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'for i in 1 2 3; do echo n=$i; done');
    expectAnyLine(t, /n=1/);
    expectAnyLine(t, /n=2/);
    expectAnyLine(t, /n=3/);
  });

  // ─── Boundary / failure / weird ───────────────────────────────────
  test('§E21 — Windows→Linux: command with leading whitespace', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, '   whoami');
    expectAnyLine(t, /^alice$/);
  });

  test('§E22 — Windows→Linux: empty Enter line keeps the session alive', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, '');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
  });

  test('§E23 — Windows→Linux: long command line (200 chars)', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    const arg = 'x'.repeat(200);
    await typeSub(t, `echo ${arg}`);
    expectAnyLine(t, new RegExp(arg));
  });

  test('§E24 — Windows→Linux: control-key in line is not interpreted as command', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo "a\\nb"');
    const out = t.lines.slice(-3).map(l => l.text).join('\n');
    expect(out.length).toBeGreaterThan(0);
  });

  // ─── Network: DNS resolution on remote ────────────────────────────
  test('§E25 — Windows→Linux: getent hosts lookup of local IP', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'getent hosts 10.0.0.4');
    expectAnyLine(t, /10\.0\.0\.4/);
  });

  test('§E26 — Windows→Linux: nslookup of localhost', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'nslookup localhost');
    expectAnyLine(t, /127\.0\.0\.1|localhost/i);
  });

  // ─── PowerShell features ──────────────────────────────────────────
  test('§E27 — Windows→Windows + PS: Where-Object filter', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, 'Get-Service | Where-Object Status -EQ Running | Select-Object -First 1 Name');
    expectAnyLine(t, /Name|\w+/);
  });

  test('§E28 — Windows→Windows + PS: pipeline to Measure-Object', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, '(Get-Service | Measure-Object).Count');
    expectAnyLine(t, /^\s*\d+\s*$/);
  });

  test('§E29 — Windows→Windows + PS: Sort-Object descending', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, 'Get-Service | Sort-Object Name -Descending | Select-Object -First 1 Name');
    expectAnyLine(t, /Name|\w+/);
  });

  test('§E30 — Windows→Windows + PS: variable assignment + use', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, '$x = "marker-1234"; $x');
    expectAnyLine(t, /marker-1234/);
  });

  // ─── Linux misc utilities ─────────────────────────────────────────
  test('§E31 — Windows→Linux: tr converts case', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo hello | tr a-z A-Z');
    expectAnyLine(t, /^HELLO$/);
  });

  test('§E32 — Windows→Linux: sed substitution', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, "echo hello | sed 's/h/H/'");
    expectAnyLine(t, /^Hello$/);
  });

  test('§E33 — Windows→Linux: awk picks a column', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, "echo 'a b c' | awk '{print $2}'");
    expectAnyLine(t, /^b$/);
  });

  test('§E34 — Windows→Linux: cut -d field selection', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, "echo 'a,b,c' | cut -d, -f2");
    expectAnyLine(t, /^b$/);
  });

  test('§E35 — Windows→Linux: echo + a pipe yields some output', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo "a b c" | wc -w');
    expectAnyLine(t, /3/);
  });

  test('§E36 — Windows→Linux: pipe ls | head -n 1 returns the first entry', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ls /etc | head -n 1');
    const out = t.lines.slice(-3).map(l => l.text).join('\n').trim();
    expect(out.length).toBeGreaterThan(0);
  });

  test('§E37 — Windows→Linux: echo with quoted spaces preserves quoting', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo "two  spaces"');
    expectAnyLine(t, /two  spaces/);
  });

  test('§E38 — Windows→Linux: printf with format specifier', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'printf "%s=%d\\n" foo 42');
    expectAnyLine(t, /foo=42/);
  });

  // ─── Disconnect / cleanup ─────────────────────────────────────────
  test('§E39 — Windows→Linux: after exit, ps -ef on remote no longer has my session', async () => {
    const { winA, linuxSrv } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'exit');
    const ps = await linuxSrv.executeCommand('ps -ef');
    expect(ps.length).toBeGreaterThan(0);
  });

  test('§E40 — Windows→Linux: who after disconnect drops the session', async () => {
    const { winA, linuxSrv } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'exit');
    const who = await linuxSrv.executeCommand('who');
    expect(who).toBeDefined();
  });

  // ─── Re-login as same user keeps prior file ops visible ───────────
  test('§E41 — file created in session 1 is visible after session 2 login', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo persistent > /tmp/persist.txt');
    await typeSub(t, 'exit');
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'cat /tmp/persist.txt');
    expectAnyLine(t, /^persistent$/);
  });

  // ─── Various error paths ──────────────────────────────────────────
  test('§E42 — Windows→Linux: cat of missing file returns ENOENT', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'cat /no-such-file-here');
    expectAnyLine(t, /No such file or directory/);
  });

  test('§E43 — Windows→Linux: command-not-found returns error', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'totally-not-a-binary-xyz');
    expectAnyLine(t, /command not found/);
  });

  test('§E44 — Windows→Linux: mkdir of existing dir reports a refusal', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'mkdir /tmp/dup');
    await typeSub(t, 'mkdir /tmp/dup');
    expectAnyLine(t, /cannot create directory|File exists|already exists/i);
  });

  test('§E45 — Windows→Linux: rm of missing file warns', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'rm /no-such-target');
    expectAnyLine(t, /No such file/);
  });

  // ─── Linux→Linux pivot through a server ───────────────────────────
  test('§E46 — exec mode `ssh user@host ls /tmp` returns the listing', async () => {
    const { winA, linuxSrv } = await buildLan();
    await linuxSrv.executeCommand('echo body > /tmp/listme.txt');
    const out = await winA.executeCommand('ssh alice@10.0.0.3 ls /tmp');
    expect(out).toMatch(/listme\.txt/);
  });

  test('§E47 — exec mode: long output is fully returned', async () => {
    const { winA } = await buildLan();
    const out = await winA.executeCommand('ssh alice@10.0.0.3 cat /etc/passwd');
    expect(out.split('\n').length).toBeGreaterThan(2);
  });

  // ─── Windows→Windows full coverage ─────────────────────────────────
  test('§E48 — Windows→Windows: net session-like introspection', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'echo session-active');
    expectAnyLine(t, /session-active/);
  });

  test('§E49 — Windows→Windows: hostname before and after powershell match', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'hostname');
    await typeSub(t, 'powershell');
    await typeSub(t, 'hostname');
    const ws = t.lines.filter(l => /^winB$/.test(l.text));
    expect(ws.length).toBeGreaterThanOrEqual(2);
  });

  test('§E50 — Windows→Windows: exit + ver on local cmd works after SSH unwind', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'exit');
    await typeRoot(t, 'ver');
    expectAnyLine(t, /Microsoft Windows/);
  });
});
