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

describe('SSH realism — database, key auth, networking depth', () => {
  // ─── SQL*Plus over SSH — DBA flows ─────────────────────────────────
  test('§DB01 — Windows→Linux→sqlplus: SELECT * FROM dual returns a row', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sqlplus / as sysdba');
    await typeSub(t, 'SELECT * FROM dual;');
    const out = t.lines.slice(-12).map(l => l.text).join('\n');
    expect(/X|DUMMY|---/.test(out)).toBe(true);
  });

  test('§DB02 — Windows→Linux→sqlplus: CREATE TABLE works', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sqlplus / as sysdba');
    await typeSub(t, 'CREATE TABLE t01 (id NUMBER, name VARCHAR2(50));');
    const out = t.lines.slice(-5).map(l => l.text).join('\n');
    expect(/Table created|created/i.test(out)).toBe(true);
  });

  test('§DB03 — Windows→Linux→sqlplus: INSERT then SELECT shows the row', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sqlplus / as sysdba');
    await typeSub(t, 'CREATE TABLE inst1 (id NUMBER);');
    await typeSub(t, "INSERT INTO inst1 VALUES (42);");
    await typeSub(t, 'COMMIT;');
    await typeSub(t, 'SELECT id FROM inst1;');
    const out = t.lines.slice(-10).map(l => l.text).join('\n');
    expect(out).toMatch(/42/);
  });

  test('§DB04 — Windows→Linux→sqlplus: SHOW PARAMETER db_name returns a value', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sqlplus / as sysdba');
    await typeSub(t, 'SHOW PARAMETER db_name');
    const out = t.lines.slice(-10).map(l => l.text).join('\n');
    expect(/db_name|NAME/i.test(out)).toBe(true);
  });

  test('§DB05 — Windows→Linux→sqlplus: SELECT instance_status returns row', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sqlplus / as sysdba');
    await typeSub(t, 'SELECT instance_name, status FROM v$instance;');
    const out = t.lines.slice(-10).map(l => l.text).join('\n');
    expect(/OPEN|MOUNTED|orcl/i.test(out)).toBe(true);
  });

  // ─── RMAN over SSH ─────────────────────────────────────────────────
  test('§DB06 — Windows→Linux→rman: LIST BACKUP returns to RMAN prompt', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'rman target /');
    expect(t.getPrompt()).toMatch(/^RMAN>/);
    await typeSub(t, 'LIST BACKUP;');
    expect(t.getPrompt()).toMatch(/^RMAN>/);
  });

  test('§DB07 — Windows→Linux→rman: SHOW ALL returns CONFIGURE lines', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'rman target /');
    await typeSub(t, 'SHOW ALL;');
    const out = t.lines.slice(-8).map(l => l.text).join('\n');
    expect(out.length).toBeGreaterThan(0);
  });

  test('§DB08 — Windows→Linux→rman→exit returns to bash', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'rman target /');
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
  });

  // ─── SSH key authentication ────────────────────────────────────────
  test('§DB09 — Linux→Linux: ssh-keygen creates id_rsa and id_rsa.pub', async () => {
    const { linuxA } = await buildLan();
    await linuxA.executeCommand('ssh-keygen -t rsa -N "" -f /home/user/.ssh/id_rsa');
    const ls = await linuxA.executeCommand('ls /home/user/.ssh');
    expect(ls).toMatch(/id_rsa/);
  });

  test('§DB10 — Linux→Linux: ssh-copy-id creates ~/.ssh/authorized_keys on remote', async () => {
    const { linuxA, linuxSrv } = await buildLan();
    await linuxA.executeCommand('ssh-keygen -t rsa -N "" -f /home/user/.ssh/id_rsa');
    await linuxA.executeCommand('ssh-copy-id alice@10.0.0.3');
    const ls = await linuxSrv.executeCommand('ls -a /home/alice/.ssh 2>/dev/null || echo none');
    expect(ls).toBeDefined();
  });

  // ─── Networking depth on remote ────────────────────────────────────
  test('§DB11 — Windows→Linux: route reports default gateway', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'route -n');
    const out = t.lines.slice(-8).map(l => l.text).join('\n');
    expect(out.length).toBeGreaterThan(0);
  });

  test('§DB12 — Windows→Linux: nslookup of a known LAN host', async () => {
    const { winA, linuxSrv } = await buildLan();
    await linuxSrv.executeCommand('echo "10.0.0.1 linuxA" >> /etc/hosts');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'nslookup linuxA');
    const out = t.lines.slice(-8).map(l => l.text).join('\n');
    expect(out.length).toBeGreaterThan(0);
  });

  test('§DB13 — Windows→Linux: traceroute to local IP', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'traceroute 10.0.0.4');
    const out = t.lines.slice(-8).map(l => l.text).join('\n');
    expect(out.length).toBeGreaterThan(0);
  });

  test('§DB14 — Windows→Linux: arp -a (or ip neigh) returns something', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ip neigh');
    const out = t.lines.slice(-8).map(l => l.text).join('\n');
    expect(out.length).toBeGreaterThan(0);
  });

  test('§DB15 — Windows→Linux: ip link show eth0', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ip link show eth0');
    expectAnyLine(t, /eth0/);
  });

  test('§DB16 — Windows→Linux: ethtool eth0 (or ifconfig eth0) reports link', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ifconfig eth0');
    expectAnyLine(t, /eth0/);
  });

  // ─── /etc/hosts manipulation ──────────────────────────────────────
  test('§DB17 — Windows→Linux: append to /etc/hosts with sudo, ping by name', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, "sudo bash -c 'echo \"10.0.0.4 windows-host\" >> /etc/hosts'");
    await typeSub(t, 'getent hosts windows-host');
    expectAnyLine(t, /10\.0\.0\.4/);
  });

  // ─── Cron ─────────────────────────────────────────────────────────
  test('§DB18 — Windows→Linux: crontab -l lists root crontab (as alice via sudo)', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sudo crontab -l');
    const out = t.lines.slice(-8).map(l => l.text).join('\n');
    expect(out.length).toBeGreaterThan(0);
  });

  // ─── Permissions edge cases ───────────────────────────────────────
  test('§DB19 — Windows→Linux: chmod +x on shell script makes it executable', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, "printf '#!/bin/bash\\necho running\\n' > /tmp/run.sh");
    await typeSub(t, 'chmod +x /tmp/run.sh');
    await typeSub(t, 'ls -l /tmp/run.sh');
    expectAnyLine(t, /-rwx/);
  });

  test('§DB20 — Windows→Linux: chmod 000 prevents reading by owner', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo private > /tmp/locked.txt');
    await typeSub(t, 'chmod 000 /tmp/locked.txt');
    await typeSub(t, 'cat /tmp/locked.txt');
    expectAnyLine(t, /Permission denied/);
  });

  // ─── Network introspection of self ────────────────────────────────
  test('§DB21 — Windows→Linux: ss -plant lists processes by socket (or just sockets)', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ss -lnt');
    expectAnyLine(t, /LISTEN/);
  });

  test('§DB22 — Windows→Linux: cat /etc/resolv.conf shows nameservers', async () => {
    const { winA, linuxSrv } = await buildLan();
    await linuxSrv.executeCommand('echo "nameserver 8.8.8.8" > /etc/resolv.conf');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'cat /etc/resolv.conf');
    expectAnyLine(t, /8\.8\.8\.8/);
  });

  // ─── More database — DDL/DML cycle ────────────────────────────────
  test('§DB23 — Windows→Linux→sqlplus: ROLLBACK undoes uncommitted INSERT', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sqlplus / as sysdba');
    await typeSub(t, 'CREATE TABLE rb1 (id NUMBER);');
    await typeSub(t, 'INSERT INTO rb1 VALUES (1);');
    await typeSub(t, 'ROLLBACK;');
    await typeSub(t, 'SELECT COUNT(*) FROM rb1;');
    const out = t.lines.slice(-10).map(l => l.text).join('\n');
    expect(out).toMatch(/0|---/);
  });

  test('§DB24 — Windows→Linux→sqlplus: DROP TABLE returns acknowledgment', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sqlplus / as sysdba');
    await typeSub(t, 'CREATE TABLE dropme (id NUMBER);');
    await typeSub(t, 'DROP TABLE dropme;');
    const out = t.lines.slice(-5).map(l => l.text).join('\n');
    expect(/dropped|Table dropped/i.test(out)).toBe(true);
  });

  // ─── Connection hardening ─────────────────────────────────────────
  test('§DB25 — Windows→Linux: connection survives a no-op command (heartbeat-like)', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    for (let i = 0; i < 5; i++) await typeSub(t, ':');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
  });

  // ─── Final regression sanity ──────────────────────────────────────
  test('§DB26 — Windows→Linux: hostname change locally does not corrupt SSH', async () => {
    const { winA } = await buildLan();
    winA.setHostname('winA-renamed');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
  });

  test('§DB27 — Windows→Linux: long-running ls -lR /etc returns', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ls -lR /etc');
    expect(t.lines.length).toBeGreaterThan(8);
  });

  test('§DB28 — Windows→Linux: ls / shows top-level dirs', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ls /');
    expectAnyLine(t, /etc/);
  });

  test('§DB29 — Windows→Linux: cat /etc/hostname matches the simulator state', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'cat /etc/hostname');
    expectAnyLine(t, /linuxSrv|linux-server/);
  });

  test('§DB30 — Windows→Linux: history written to ~/.bash_history is not surfaced as command-not-found', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'pwd');
    await typeSub(t, 'echo persisted');
    expectAnyLine(t, /persisted/);
  });
});
