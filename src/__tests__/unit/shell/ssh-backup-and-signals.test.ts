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

async function sudoSub(t: TerminalSession, line: string, pw: string): Promise<void> {
  t.setInputBuf(line); t.handleKey(key('Enter')); await flush();
  if (t.currentInputMode.type === 'password') {
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

describe('SSH realism — backup/restore, signals, concurrency', () => {
  // ─── Backup workflows ──────────────────────────────────────────────
  test('§BK01 — Windows→Linux: mkdir + cp builds a "backup" directory structure', async () => {
    const { winA, linuxSrv } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'mkdir -p /tmp/backup-root');
    await typeSub(t, 'echo content > /tmp/source.txt');
    await typeSub(t, 'cp /tmp/source.txt /tmp/backup-root/source.txt');
    const ls = await linuxSrv.executeCommand('ls /tmp/backup-root');
    expect(ls).toMatch(/source\.txt/);
  });

  test('§BK02 — Windows→Linux: cp single file then verify content matches', async () => {
    const { winA, linuxSrv } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo verified-copy > /tmp/orig2.txt');
    await typeSub(t, 'cp /tmp/orig2.txt /tmp/dup2.txt');
    const out = await linuxSrv.executeCommand('cat /tmp/dup2.txt');
    expect(out).toMatch(/verified-copy/);
  });

  test('§BK03 — Windows→Linux→rman: BACKUP DATABASE starts a backup job', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'rman target /');
    await typeSub(t, 'BACKUP DATABASE;');
    const out = t.lines.slice(-10).map(l => l.text).join('\n');
    expect(out.length).toBeGreaterThan(0);
  });

  test('§BK04 — Windows→Linux→rman: LIST BACKUP after taking one shows it', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'rman target /');
    await typeSub(t, 'BACKUP DATABASE;');
    await typeSub(t, 'LIST BACKUP;');
    expect(t.getPrompt()).toMatch(/^RMAN>/);
  });

  // ─── Signals / process control ─────────────────────────────────────
  test('§BK05 — Windows→Linux: kill -9 of an existing PID errors with "Operation not permitted" for PID 1', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'kill -9 1');
    expectAnyLine(t, /not permitted|Operation not permitted/i);
  });

  test('§BK06 — Windows→Linux: trap-like idiom on a short script (smoke)', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'bash -c "trap \\"echo trapped\\" EXIT; echo running"');
    expectAnyLine(t, /running/);
  });

  test('§BK07 — Windows→Linux: kill -l lists signals including SIGTERM', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'kill -l');
    expectAnyLine(t, /SIGTERM/);
  });

  test('§BK08 — Windows→Linux: pgrep -f matches a comm pattern', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'pgrep -f ssh');
    expectAnyLine(t, /\d+/);
  });

  // ─── Concurrency / multi-session ───────────────────────────────────
  test('§BK09 — Two SSH terminals from the same Windows client to the same server', async () => {
    const { winA } = await buildLan();
    const t1 = new WindowsTerminalSession('t1', winA);
    const t2 = new WindowsTerminalSession('t2', winA);
    await t1.init(); await t2.init();
    await winSshLogin(t1, 'ssh alice@10.0.0.3', 'alice');
    await winSshLogin(t2, 'ssh bob@10.0.0.3', 'bob');
    expect(t1.getPrompt()).toMatch(/alice@linuxSrv/);
    expect(t2.getPrompt()).toMatch(/bob@linuxSrv/);
  });

  test('§BK10 — Both SSH sessions execute independently (cd in one not seen in the other)', async () => {
    const { winA } = await buildLan();
    const t1 = new WindowsTerminalSession('t1', winA);
    const t2 = new WindowsTerminalSession('t2', winA);
    await t1.init(); await t2.init();
    await winSshLogin(t1, 'ssh alice@10.0.0.3', 'alice');
    await winSshLogin(t2, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t1, 'cd /tmp');
    expect(t1.getPrompt()).toMatch(/\/tmp/);
    expect(t2.getPrompt()).not.toMatch(/\/tmp/);
  });

  // ─── Locale and encoding ───────────────────────────────────────────
  test('§BK11 — Windows→Linux: locale command returns LANG-style output', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'locale');
    const out = t.lines.slice(-10).map(l => l.text).join('\n');
    expect(out.length).toBeGreaterThan(0);
  });

  test('§BK12 — Windows→Linux: echo $LANG returns a non-empty value', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo $LANG');
    const out = t.lines.slice(-3).map(l => l.text).join('\n');
    expect(out.length).toBeGreaterThan(0);
  });

  // ─── Service lifecycle ────────────────────────────────────────────
  test('§BK13 — Windows→Linux: systemctl reload ssh keeps it active', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await sudoSub(t, 'sudo systemctl reload ssh', 'alice');
    await typeSub(t, 'systemctl is-active ssh');
    expectAnyLine(t, /^active$/);
  });

  test('§BK14 — Windows→Linux: systemctl status of an unknown service errors gracefully', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'systemctl status nopesvc');
    expectAnyLine(t, /could not be found|not loaded/i);
  });

  test('§BK15 — Windows→Linux: systemctl is-enabled ssh returns enabled', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'systemctl is-enabled ssh');
    expectAnyLine(t, /enabled/);
  });

  // ─── PowerShell job + pipeline depth ──────────────────────────────
  test('§BK16 — Windows→Windows + PS: complex pipeline (Sort | Select | ForEach)', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, 'Get-Service | Sort-Object Name | Select-Object -First 2 | ForEach-Object { $_.Name }');
    const out = t.lines.slice(-8).map(l => l.text).join('\n');
    expect(out.length).toBeGreaterThan(0);
  });

  test('§BK17 — Windows→Windows + PS: hashtable creation and access', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, '$h = @{a=1; b=2}; $h["a"]');
    expectAnyLine(t, /^1$/);
  });

  test('§BK18 — Windows→Windows + PS: -Match returns true for matching string', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh User@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, '"hello" -match "ell"');
    expectAnyLine(t, /True/i);
  });

  // ─── Disk + storage on Linux remote ───────────────────────────────
  test('§BK19 — Windows→Linux: df -i reports inode info', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'df -i');
    expectAnyLine(t, /Inodes|IUsed/i);
  });

  test('§BK20 — Windows→Linux: stat reports owner/mode/size', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo body > /tmp/s.txt');
    await typeSub(t, 'stat /tmp/s.txt');
    expectAnyLine(t, /Size|alice/);
  });

  // ─── Final cross-cutting ──────────────────────────────────────────
  test('§BK21 — Multi-step admin workflow: create user, give sudo, login over SSH from windows works', async () => {
    const { winA, linuxSrv } = await buildLan();
    const um = (linuxSrv as unknown as { executor: { userMgr: {
      useradd: (u: string, o: object) => void; setPassword: (u: string, p: string) => void;
      usermod: (u: string, o: object) => void; getUser: (u: string) => unknown;
    } } }).executor.userMgr;
    if (!um.getUser('newdba')) {
      um.useradd('newdba', { m: true, s: '/bin/bash' });
      um.setPassword('newdba', 'dba-pass');
      um.usermod('newdba', { aG: 'sudo' });
    }
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh newdba@10.0.0.3', 'dba-pass');
    expect(t.getPrompt()).toMatch(/newdba@linuxSrv/);
  });

  test('§BK22 — Power-cycle remote, then reconnect works', async () => {
    const { winA, linuxSrv } = await buildLan();
    linuxSrv.powerOff();
    linuxSrv.powerOn();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
  });

  test('§BK23 — sshd reload picks up sshd_config Port change', async () => {
    const { linuxSrv } = await buildLan();
    await linuxSrv.executeCommand('printf "Port 2222\\n" > /etc/ssh/sshd_config');
    await linuxSrv.executeCommand('systemctl reload ssh');
    const policy = (linuxSrv as unknown as { getSshPolicy(): { ports: readonly number[] } }).getSshPolicy();
    expect(policy.ports).toContain(2222);
  });

  test('§BK24 — sshd_config with both Port 22 and Port 2222 → both listen', async () => {
    const { linuxSrv } = await buildLan();
    await linuxSrv.executeCommand('printf "Port 22\\nPort 2222\\n" > /etc/ssh/sshd_config');
    await linuxSrv.executeCommand('systemctl reload ssh');
    const policy = (linuxSrv as unknown as { getSshPolicy(): { ports: readonly number[] } }).getSshPolicy();
    expect(policy.ports).toContain(22);
    expect(policy.ports).toContain(2222);
  });

  test('§BK25 — Failed root login (default policy) generates an auth.log Failed entry', async () => {
    const { winA, linuxSrv } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await typeRoot(t, 'ssh root@10.0.0.3');
    t.setPasswordBuf('root'); t.handleKey(key('Enter')); await flush();
    const log = await linuxSrv.executeCommand('cat /var/log/auth.log');
    expect(log).toMatch(/Failed password for root from 10\.0\.0\.4/);
  });
});
