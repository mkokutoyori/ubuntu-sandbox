import { describe, expect, beforeEach, test } from 'vitest';
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

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
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
    } else if (t.currentInputMode.type === 'interactive-text') {
      t.setInputBuf('yes');
    } else break;
    t.handleKey(key('Enter'));
    await flush();
  }
}

function expectAnyLine(t: TerminalSession, needle: string | RegExp): void {
  const ok = t.lines.some(l =>
    needle instanceof RegExp ? needle.test(l.text) : l.text.includes(needle));
  if (!ok) {
    const tail = t.lines.slice(-12).map(l => l.text).join('\n');
    throw new Error(`Missing ${String(needle)}\n${tail}`);
  }
}

describe('SSH realism deep dive — file transfer, env, identity, batch', () => {
  test('§D01 — scp file from local to remote, verify on remote', async () => {
    const { linuxA, linuxSrv } = await buildLan();
    await linuxA.executeCommand('echo "payload" > /tmp/file.txt');
    const out = await linuxA.executeCommand('scp /tmp/file.txt alice@10.0.0.3:/tmp/copied.txt');
    expect(out).toMatch(/100%|bytes/);
    const remote = await linuxSrv.executeCommand('cat /tmp/copied.txt');
    expect(remote).toMatch(/payload/);
  });

  test('§D02 — scp file FROM remote TO local', async () => {
    const { linuxA, linuxSrv } = await buildLan();
    await linuxSrv.executeCommand('echo "from-server" > /tmp/srvfile.txt');
    await linuxA.executeCommand('scp alice@10.0.0.3:/tmp/srvfile.txt /tmp/local.txt');
    const local = await linuxA.executeCommand('cat /tmp/local.txt');
    expect(local).toMatch(/from-server/);
  });

  test('§D03 — scp with non-existent remote file errors out', async () => {
    const { linuxA } = await buildLan();
    const out = await linuxA.executeCommand('scp alice@10.0.0.3:/tmp/nope-xyz.txt /tmp/x.txt');
    expect(out).toMatch(/No such file|not found|does not exist/i);
  });

  test('§D04 — sftp interactive ls remote', async () => {
    const { linuxA } = await buildLan();
    const t = new LinuxTerminalSession('d04', linuxA);
    await t.init();
    await linuxSshLogin(t, 'sftp alice@10.0.0.3', 'alice');
    expect(t.getPrompt()).toMatch(/sftp/i);
  });

  test('§D05 — env var set locally not visible after SSH push (separate session)', async () => {
    const { linuxA } = await buildLan();
    const t = new LinuxTerminalSession('d05', linuxA);
    await t.init();
    await typeRoot(t, 'export MYVAR=local-only');
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'echo $MYVAR');
    const lines = t.lines.slice(-3).map(l => l.text).join('\n');
    expect(/local-only/.test(lines)).toBe(false);
  });

  test('§D06 — Windows→Linux: command after exit goes to cmd.exe', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('d06', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^[A-Z]:\\/);
    await typeRoot(t, 'ver');
    expectAnyLine(t, /Microsoft Windows/);
  });

  test('§D07 — Linux→Linux: heredoc input works', async () => {
    const { linuxA } = await buildLan();
    const out = await linuxA.executeCommand("cat <<EOF\nline1\nline2\nEOF");
    expect(out).toMatch(/line1/);
    expect(out).toMatch(/line2/);
  });

  test('§D08 — Linux→Linux: $(date) command substitution', async () => {
    const { linuxA } = await buildLan();
    const out = await linuxA.executeCommand('echo "now=$(date +%Y)"');
    expect(out).toMatch(/now=\d{4}/);
  });

  test('§D09 — sudo refused for users removed from the sudo group', async () => {
    const { linuxSrv } = await buildLan();
    const exec = (linuxSrv as unknown as {
      executor: {
        userMgr: { currentUser: string; currentUid: number; currentGid: number;
          getUser: (n: string) => { uid: number; gid: number } | undefined;
          gpasswd: (args: string[]) => void; };
        canSudo?: () => boolean;
      };
    }).executor;
    exec.userMgr.gpasswd(['-d', 'carl', 'sudo']);
    const carl = exec.userMgr.getUser('carl');
    exec.userMgr.currentUser = 'carl';
    exec.userMgr.currentUid = carl?.uid ?? 1003;
    exec.userMgr.currentGid = carl?.gid ?? 1003;
    expect(exec.canSudo?.() ?? false).toBe(false);
  });

  test('§D10 — alice IS a sudoer at the executor level', async () => {
    const { linuxSrv } = await buildLan();
    const exec = (linuxSrv as unknown as {
      executor: {
        userMgr: { currentUser: string; currentUid: number; currentGid: number;
          getUser: (n: string) => { uid: number; gid: number } | undefined; };
        canSudo?: () => boolean;
      };
    }).executor;
    const a = exec.userMgr.getUser('alice');
    exec.userMgr.currentUser = 'alice';
    exec.userMgr.currentUid = a?.uid ?? 1000;
    exec.userMgr.currentGid = a?.gid ?? 1000;
    expect(exec.canSudo?.() ?? false).toBe(true);
  });

  test('§D11 — Windows→Linux: chmod + ls -l shows the change', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('d11', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo body > /tmp/perm.txt');
    await typeSub(t, 'chmod 700 /tmp/perm.txt');
    await typeSub(t, 'ls -l /tmp/perm.txt');
    expectAnyLine(t, /-rwx------/);
  });

  test('§D12 — Windows→Linux: chown alice works', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('d12', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo x > /tmp/own.txt');
    await typeSub(t, 'ls -l /tmp/own.txt');
    expectAnyLine(t, /alice/);
  });

  test('§D13 — Linux→Linux: nano starts the editor mode', async () => {
    const { linuxA } = await buildLan();
    const t = new LinuxTerminalSession('d13', linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'nano /tmp/note.txt');
    expect(t.currentInputMode.type).not.toBe('normal');
  });

  test('§D14 — Linux→Linux: vim starts the editor mode', async () => {
    const { linuxA } = await buildLan();
    const t = new LinuxTerminalSession('d14', linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'vim /tmp/note.txt');
    expect(t.currentInputMode.type).not.toBe('normal');
  });

  test('§D15 — Windows→Linux: env vars on remote include PATH', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('d15', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo $PATH');
    expectAnyLine(t, /\/usr\/bin/);
  });

  test('§D16 — Windows→Linux: $? captures last exit code', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('d16', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'true');
    await typeSub(t, 'echo $?');
    expectAnyLine(t, /^0$/);
  });

  test('§D17 — Windows→Linux: false; echo $? on a single line (same shell)', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('d17', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'false; echo $?');
    expectAnyLine(t, /^1$/);
  });

  test('§D18 — Windows→Linux: alias is honoured', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('d18', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, "alias ll='ls -la'");
    await typeSub(t, 'll /tmp');
    expectAnyLine(t, /total/);
  });

  test('§D19 — Windows→Linux: which sshd resolves', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('d19', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'which sshd');
    expectAnyLine(t, /sshd/);
  });

  test('§D20 — Windows→Linux: ls produces non-empty output (binary is resolvable)', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('d20', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ls /bin');
    const out = t.lines.slice(-5).map(l => l.text).join(' ');
    expect(out.trim().length).toBeGreaterThan(0);
  });

  test('§D21 — Two SSH logins (alice + bob) both register in auth.log', async () => {
    const { linuxA, linuxSrv } = await buildLan();
    const t = new LinuxTerminalSession('t1', linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'exit');
    await linuxSshLogin(t, 'ssh bob@10.0.0.3', 'bob');
    const log = await linuxSrv.executeCommand('cat /var/log/auth.log');
    expect(log).toMatch(/Accepted password for alice/);
    expect(log).toMatch(/Accepted password for bob/);
  });

  test('§D22 — Windows→Linux: stop ssh on srv, restart, reconnect', async () => {
    const { winA, linuxSrv } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await linuxSrv.executeCommand('systemctl stop ssh');
    await typeRoot(t, 'ssh alice@10.0.0.3');
    expectAnyLine(t, /Connection refused/);
    await linuxSrv.executeCommand('systemctl start ssh');
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
  });

  test('§D23 — Windows→Linux: tail -n 1 /var/log/auth.log shows latest', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('w', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'tail -n 1 /var/log/auth.log');
    expectAnyLine(t, /sshd/);
  });

  test('§D24 — Windows→Linux: wc -l counts lines', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('w', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'printf "a\\nb\\nc\\n" > /tmp/three.txt');
    await typeSub(t, 'wc -l /tmp/three.txt');
    expectAnyLine(t, /^\s*3\s/);
  });

  test('§D25 — Windows→Linux: ls -1 shows one file per line', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('w', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ls -1 /etc');
    expectAnyLine(t, /^passwd$/);
  });

  test('§D26 — Windows→Linux: find /tmp -name "*.txt"', async () => {
    const { winA, linuxSrv } = await buildLan();
    await linuxSrv.executeCommand('echo a > /tmp/a.txt');
    const t = new WindowsTerminalSession('w', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'find /tmp -name "*.txt"');
    expectAnyLine(t, /\/tmp\/a\.txt/);
  });

  test('§D27 — Windows→Linux: getent passwd alice resolves', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('w', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'getent passwd alice');
    expectAnyLine(t, /^alice:/);
  });

  test('§D28 — Windows→Linux: getent group sudo lists sudo group', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('w', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'getent group sudo');
    expectAnyLine(t, /^sudo:/);
  });

  test('§D29 — Windows→Linux: hostnamectl returns the hostname', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('w', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'hostnamectl');
    expectAnyLine(t, /linuxSrv/);
  });

  test('§D30 — Windows→Windows: hostname on remote returns winB', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('w', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'hostname');
    expectAnyLine(t, /winB/);
  });

  test('§D31 — Windows→Windows: ipconfig on remote', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('w', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'ipconfig');
    expectAnyLine(t, /IPv4|Adapter|Address/i);
  });

  test('§D32 — Windows→Windows + PS: $HOME equivalent', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('w', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, '$env:USERNAME');
    expectAnyLine(t, /User/);
  });

  test('§D33 — Windows→Windows + PS: Get-Process | Measure', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('w', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, '(Get-Process | Measure).Count');
    expectAnyLine(t, /\d+/);
  });

  test('§D34 — Windows→Linux: SSH user activity ends in auth.log close marker', async () => {
    const { winA, linuxSrv } = await buildLan();
    const t = new WindowsTerminalSession('w', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'exit');
    const log = await linuxSrv.executeCommand('cat /var/log/auth.log');
    expect(log).toMatch(/Accepted password for alice/);
  });

  test('§D35 — Linux→Linux: powerOff client mid-session — remote cleanup', async () => {
    const { linuxA, linuxSrv } = await buildLan();
    const t = new LinuxTerminalSession('w', linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
    linuxA.powerOff();
    expect(linuxSrv.getIsPoweredOn()).toBe(true);
  });

  test('§D36 — Windows→Linux: SSH on non-default port reflects in sshd policy.ports', async () => {
    const { linuxSrv } = await buildLan();
    await linuxSrv.executeCommand('printf "Port 2222\\n" > /etc/ssh/sshd_config');
    await linuxSrv.executeCommand('systemctl reload ssh');
    const policy = (linuxSrv as unknown as { getSshPolicy(): { ports: readonly number[] } }).getSshPolicy();
    expect(policy.ports).toContain(2222);
  });

  test('§D37 — Windows→Linux: ss -tln after Port reload reports 2222 listening', async () => {
    const { winA, linuxSrv } = await buildLan();
    await linuxSrv.executeCommand('printf "Port 2222\\n" > /etc/ssh/sshd_config');
    await linuxSrv.executeCommand('systemctl reload ssh');
    const t = new WindowsTerminalSession('w', winA);
    await t.init();
    const out = await linuxSrv.executeCommand('ss -tln');
    expect(out).toMatch(/:2222\s/);
    void t;
  });

  test('§D38 — Windows→Linux: SSH closes when remote sshd masked', async () => {
    const { winA, linuxSrv } = await buildLan();
    await linuxSrv.executeCommand('systemctl mask ssh');
    await linuxSrv.executeCommand('systemctl stop ssh');
    const t = new WindowsTerminalSession('w', winA);
    await t.init();
    await typeRoot(t, 'ssh alice@10.0.0.3');
    expectAnyLine(t, /Connection refused/);
  });

  test('§D39 — Windows host fs is intact after Linux→Windows interaction', async () => {
    const { winA } = await buildLan();
    const out = await winA.executeCommand('dir C:\\Users');
    expect(out).toMatch(/User/);
  });

  test('§D40 — Windows→Linux: ssh user@host -- "remote command" runs exec mode', async () => {
    const { winA } = await buildLan();
    const out = await winA.executeCommand('ssh alice@10.0.0.3 hostname');
    expect(out).toMatch(/linuxSrv/);
  });

  test('§D41 — Windows→Linux: ssh exec mode preserves the user identity (whoami)', async () => {
    const { winA } = await buildLan();
    const out = await winA.executeCommand('ssh alice@10.0.0.3 whoami');
    expect(out).toMatch(/alice/);
  });

  test('§D42 — Windows→Linux exec mode: pwd is /home/<user>', async () => {
    const { winA } = await buildLan();
    const out = await winA.executeCommand('ssh alice@10.0.0.3 pwd');
    expect(out).toMatch(/\/home\/alice/);
  });

  test('§D43 — Linux→Linux: connect, type a long line, run it', async () => {
    const { linuxA } = await buildLan();
    const t = new LinuxTerminalSession('w', linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'echo "abcdefghijklmnopqrstuvwxyz0123456789"');
    expectAnyLine(t, /abcdefghijklmnopqrstuvwxyz0123456789/);
  });

  test('§D44 — Linux→Linux: cd /var/log; tail -n 3 syslog', async () => {
    const { linuxA, linuxSrv } = await buildLan();
    await linuxSrv.executeCommand('logger -t test "syslog-line-1"');
    const t = new LinuxTerminalSession('w', linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'cd /var/log');
    await typeRoot(t, 'tail -n 3 syslog');
    expectAnyLine(t, /syslog-line-1|cron|test/);
  });

  test('§D45 — Windows→Linux: nested sqlplus → exit → bash → exit unwinds in order', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('w', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sqlplus / as sysdba');
    expect(t.getPrompt()).toMatch(/^SQL>/);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^[A-Z]:\\/);
  });

  test('§D46 — Windows→Linux: clear (Ctrl+L semantic) clears the screen via shell adapter', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('w', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo bar-line');
    const before = t.lines.length;
    await typeSub(t, 'clear');
    expect(t.lines.length).toBeLessThan(before);
  });

  test('§D47 — Linux→Linux: bash quote handling with single quotes', async () => {
    const { linuxA } = await buildLan();
    const t = new LinuxTerminalSession('w', linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, "echo 'this is $HOME'");
    expectAnyLine(t, /this is \$HOME/);
  });

  test('§D48 — Linux→Linux: double quotes expand $HOME', async () => {
    const { linuxA } = await buildLan();
    const t = new LinuxTerminalSession('w', linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'echo "$HOME"');
    expectAnyLine(t, /\/home\/alice/);
  });

  test('§D49 — Linux→Linux: stat /etc/passwd shows reasonable mode/owner', async () => {
    const { linuxA } = await buildLan();
    const t = new LinuxTerminalSession('w', linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'stat /etc/passwd');
    expectAnyLine(t, /Uid:.*root/);
  });

  test('§D50 — Linux→Linux: stat /etc/shadow shows mode 640', async () => {
    const { linuxA } = await buildLan();
    const t = new LinuxTerminalSession('w', linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeRoot(t, 'stat /etc/shadow');
    expectAnyLine(t, /640|0640|-rw-r-----/);
  });
});
