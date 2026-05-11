/**
 * SSH UI — end-to-end flow tests through LinuxTerminalSession.
 *
 * Everything goes through the same surface a React view uses:
 *   - setInput / setInputBuf / setPasswordBuf for user typing
 *   - handleKey(KeyEvent) for Enter, Ctrl+C, Ctrl+L, arrows
 *   - session.lines + session.currentInputMode for assertions
 *
 * No SshSession is constructed directly — the production code paths
 * (enterSsh → connectAndEnterSsh → SshSession + TerminalSshInteractionHandler)
 * are exercised exactly as in the GUI.
 *
 * LAN topology:
 *
 *     PC1 (client, 10.0.0.1) ─┐
 *     PC2 (target, 10.0.0.2) ─┼── GenericSwitch (8 ports)
 *     PC3 (target, 10.0.0.3) ─┘
 *
 * Each PC auto-runs sshd on port 22 with the default user `user` / `admin`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

// ── LAN fixture ────────────────────────────────────────────────────

const PC1_IP = '10.0.0.1';
const PC2_IP = '10.0.0.2';
const PC3_IP = '10.0.0.3';
const NETMASK = '255.255.255.0';

interface Lan {
  pc1: LinuxPC;
  pc2: LinuxPC;
  pc3: LinuxPC;
  sw: GenericSwitch;
}

/** Reset the global Equipment registry — devices register themselves on
 *  construction, and findLinuxMachineByIp() would otherwise pick a stale
 *  instance from a previous test. */
function resetEquipmentRegistry(): void {
  EquipmentRegistry.resetInstance();
}

async function buildLan(): Promise<Lan> {
  const pc1 = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const pc2 = new LinuxPC('linux-pc', 'PC2', 100, 0);
  const pc3 = new LinuxPC('linux-pc', 'PC3', 200, 0);
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 50, 50);

  new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPort('eth0')!);
  new Cable('c2').connect(pc2.getPort('eth0')!, sw.getPort('eth1')!);
  new Cable('c3').connect(pc3.getPort('eth0')!, sw.getPort('eth2')!);

  await pc1.executeCommand(`ifconfig eth0 ${PC1_IP} netmask ${NETMASK}`);
  await pc2.executeCommand(`ifconfig eth0 ${PC2_IP} netmask ${NETMASK}`);
  await pc3.executeCommand(`ifconfig eth0 ${PC3_IP} netmask ${NETMASK}`);

  // Prime ARP cache so TCP handshakes don't fail on first packet.
  for (const ip of [PC2_IP, PC3_IP]) await pc1.executeCommand(`ping -c 1 ${ip}`);
  for (const ip of [PC1_IP, PC3_IP]) await pc2.executeCommand(`ping -c 1 ${ip}`);
  for (const ip of [PC1_IP, PC2_IP]) await pc3.executeCommand(`ping -c 1 ${ip}`);

  return { pc1, pc2, pc3, sw };
}

// ── UI helpers ─────────────────────────────────────────────────────

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return {
    key: k,
    ctrlKey: opts.ctrlKey ?? false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
  };
}

/** Drain pending microtasks AND macrotasks a few rounds. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

/** Wait until `predicate` is truthy or `timeoutMs` elapses. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

/** Type a command in normal (bash) mode and press Enter. */
async function typeNormal(session: LinuxTerminalSession, cmd: string) {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await flush();
}

/** Submit a password in password input mode. */
async function typePassword(session: LinuxTerminalSession, pw: string) {
  session.setPasswordBuf(pw);
  session.handleKey(key('Enter'));
  await flush();
}

/**
 * PasswordAuthMethod retries up to 3 times. To exhaust a wrong-password run
 * we have to re-submit each time a new password prompt appears.
 *
 * `until` is the predicate that ends the retry loop (Permission denied
 * line for instance). Returns when `until()` is true or after `maxTries`.
 */
async function typeWrongPasswordUntil(
  session: LinuxTerminalSession,
  pw: string,
  until: () => boolean,
  maxTries = 4,
): Promise<void> {
  for (let i = 0; i < maxTries; i++) {
    if (until()) return;
    await waitFor(
      () => until() || session.currentInputMode.type === 'password',
      2000,
    );
    if (until()) return;
    session.setPasswordBuf(pw);
    session.handleKey(key('Enter'));
    await flush();
  }
}

/** Submit a line in interactive-text input mode (host-key prompt, sub-shell). */
async function typeInteractive(session: LinuxTerminalSession, line: string) {
  session.setInputBuf(line);
  session.handleKey(key('Enter'));
  await flush();
}

function linesText(session: LinuxTerminalSession): string[] {
  return session.lines.map((l) => l.text);
}

function hasLine(session: LinuxTerminalSession, re: RegExp): boolean {
  return linesText(session).some((l) => re.test(l));
}

function lastLineMatches(session: LinuxTerminalSession, re: RegExp): boolean {
  const last = linesText(session).slice(-1)[0] ?? '';
  return re.test(last);
}

/** Access the (protected) LinuxCommandExecutor on a LinuxPC for VFS assertions. */
function vfsOf(pc: LinuxPC): import('@/network/devices/linux/VirtualFileSystem').VirtualFileSystem {
  return (pc as unknown as { executor: { vfs: import('@/network/devices/linux/VirtualFileSystem').VirtualFileSystem } })
    .executor.vfs;
}

// ── Tests ───────────────────────────────────────────────────────────

describe('SSH UI — basic password authentication flow', () => {
  let lan: Lan;
  let session: LinuxTerminalSession;

  beforeEach(async () => {
    resetEquipmentRegistry();
    lan = await buildLan();
    session = new LinuxTerminalSession('term-1', lan.pc1);
  });

  it('switches to password input mode after typing `ssh user@host`', async () => {
    await typeNormal(session, `ssh user@${PC2_IP}`);
    await waitFor(() => session.currentInputMode.type === 'password');

    const mode = session.currentInputMode;
    expect(mode.type).toBe('password');
    expect(mode.type === 'password' && mode.promptText).toMatch(
      /user@10\.0\.0\.2's password:/,
    );
  });

  it('completes a full login with the correct password', async () => {
    await typeNormal(session, `ssh user@${PC2_IP}`);
    await waitFor(() => session.currentInputMode.type === 'password');
    await typePassword(session, 'admin');
    await waitFor(() => session.isInsideSshSession);

    expect(session.isInsideSshSession).toBe(true);
    expect(hasLine(session, /Welcome to Ubuntu/)).toBe(true);
  });

  it('refuses login with a wrong password (after the 3 retries)', async () => {
    await typeNormal(session, `ssh user@${PC2_IP}`);
    await typeWrongPasswordUntil(session, 'wrong', () =>
      hasLine(session, /Permission denied/),
    );
    await waitFor(() => hasLine(session, /Permission denied/));

    expect(hasLine(session, /Permission denied/)).toBe(true);
    expect(session.isInsideSshSession).toBe(false);
  });

  it('shows "No route to host" when the target is unreachable', async () => {
    await typeNormal(session, `ssh user@99.99.99.99`);
    // Unreachable target — connect fails at TCP level before the auth phase,
    // so the password prompt never opens. Just wait for the error line.
    await waitFor(() =>
      hasLine(session, /No route to host|Connection refused/),
    );

    expect(session.isInsideSshSession).toBe(false);
  });

  it('returns to local prompt after exit', async () => {
    await typeNormal(session, `ssh user@${PC2_IP}`);
    await waitFor(() => session.currentInputMode.type === 'password');
    await typePassword(session, 'admin');
    await waitFor(() => session.isInsideSshSession);
    expect(session.isInsideSshSession).toBe(true);

    await typeNormal(session, 'exit');
    await waitFor(() => !session.isInsideSshSession);

    expect(session.isInsideSshSession).toBe(false);
    expect(hasLine(session, /Connection to 10\.0\.0\.2 closed\./)).toBe(true);
  });

  it('runs remote commands after login (whoami, hostname)', async () => {
    await typeNormal(session, `ssh user@${PC2_IP}`);
    await waitFor(() => session.currentInputMode.type === 'password');
    await typePassword(session, 'admin');
    await waitFor(() => session.isInsideSshSession);

    const before = session.lines.length;
    await typeNormal(session, 'whoami');
    await waitFor(() => session.lines.length > before);
    expect(linesText(session).slice(before).join('\n')).toMatch(/user/);

    const before2 = session.lines.length;
    await typeNormal(session, 'hostname');
    await waitFor(() => session.lines.length > before2);
    // /etc/hostname holds "linux-pc" (from the LinuxPC profile).
    expect(linesText(session).slice(before2).join('\n')).toMatch(/linux-pc/);
  });

  it('updates the prompt to the remote machine after connecting', async () => {
    await typeNormal(session, `ssh user@${PC2_IP}`);
    await waitFor(() => session.currentInputMode.type === 'password');
    await typePassword(session, 'admin');
    await waitFor(() => session.isInsideSshSession);

    expect(session.getPrompt()).toContain('PC2');
  });
});

describe('SSH UI — one-shot exec (ssh user@host command)', () => {
  let lan: Lan;
  let session: LinuxTerminalSession;

  beforeEach(async () => {
    resetEquipmentRegistry();
    lan = await buildLan();
    session = new LinuxTerminalSession('term-1', lan.pc1);
  });

  it('runs the remote command and returns to local prompt (no sub-shell)', async () => {
    await typeNormal(session, `ssh user@${PC2_IP} hostname`);
    await waitFor(() => session.currentInputMode.type === 'password');
    await typePassword(session, 'admin');
    // `hostname` reads /etc/hostname which the LinuxPC profile seeds as
    // "linux-pc". The device display name (PC2) lives at the Equipment level.
    await waitFor(() => hasLine(session, /linux-pc|PC2/));

    expect(session.isInsideSshSession).toBe(false);
    expect(session.currentInputMode.type).toBe('normal');
  });

  it('reports stderr lines from a failing remote command', async () => {
    await typeNormal(session, `ssh user@${PC2_IP} cat /nonexistent`);
    await waitFor(() => session.currentInputMode.type === 'password');
    await typePassword(session, 'admin');
    // Wait until the prompt mode has cleared (= connect/exec/disconnect cycle done).
    await waitFor(
      () => session.currentInputMode.type === 'normal' && session.lines.length > 2,
    );

    expect(
      hasLine(session, /No such file|cat:/) ||
        hasLine(session, /cannot read|cannot access/),
    ).toBe(true);
  });
});

describe('SSH UI — clearing the screen inside an SSH session', () => {
  let lan: Lan;
  let session: LinuxTerminalSession;

  beforeEach(async () => {
    lan = await buildLan();
    session = new LinuxTerminalSession('term-1', lan.pc1);
    await typeNormal(session, `ssh user@${PC2_IP}`);
    await waitFor(() => session.currentInputMode.type === 'password');
    await typePassword(session, 'admin');
    await waitFor(() => session.isInsideSshSession);
  });

  it('Ctrl+L wipes the terminal output buffer', async () => {
    expect(session.lines.length).toBeGreaterThan(0);
    session.handleKey(key('l', { ctrlKey: true }));
    await flush();
    expect(session.lines.length).toBe(0);
  });

  it('typing `clear` then Enter wipes the buffer (push-device mode)', async () => {
    // In push-device mode (local LAN target) the remote `clear` returns the
    // ANSI clear sequence that LinuxTerminalSession recognises and turns
    // into this.clear().
    expect(session.lines.length).toBeGreaterThan(0);
    await typeNormal(session, 'clear');
    await waitFor(() => session.lines.length < 5);
    expect(session.lines.length).toBeLessThan(5);
  });
});

describe('SSH UI — strict host key checking interactive prompt', () => {
  let lan: Lan;
  let session: LinuxTerminalSession;

  beforeEach(async () => {
    resetEquipmentRegistry();
    lan = await buildLan();
    session = new LinuxTerminalSession('term-1', lan.pc1);
  });

  it('prompts the user for `yes` when StrictHostKeyChecking=yes and the host is unknown', async () => {
    await typeNormal(
      session,
      `ssh -o StrictHostKeyChecking=yes user@${PC2_IP}`,
    );
    await waitFor(
      () =>
        session.currentInputMode.type === 'interactive-text' &&
        /Are you sure/.test(
          session.currentInputMode.type === 'interactive-text'
            ? session.currentInputMode.promptText
            : '',
        ),
    );

    expect(hasLine(session, /authenticity of host '10\.0\.0\.2'/)).toBe(true);
    expect(hasLine(session, /ED25519 key fingerprint is SHA256:/)).toBe(true);

    // Answer "yes" → proceed to password prompt.
    await typeInteractive(session, 'yes');
    await waitFor(() => session.currentInputMode.type === 'password');
    expect(session.currentInputMode.type).toBe('password');
  });

  it('rejects the connection when the user answers `no` to the host-key prompt', async () => {
    await typeNormal(
      session,
      `ssh -o StrictHostKeyChecking=yes user@${PC2_IP}`,
    );
    await waitFor(
      () => session.currentInputMode.type === 'interactive-text',
    );

    await typeInteractive(session, 'no');
    await waitFor(() => hasLine(session, /Host key verification failed/));
    expect(session.isInsideSshSession).toBe(false);
  });
});

describe('SSH UI — Ctrl+C and Ctrl+D inside SSH session', () => {
  let lan: Lan;
  let session: LinuxTerminalSession;

  beforeEach(async () => {
    resetEquipmentRegistry();
    lan = await buildLan();
    session = new LinuxTerminalSession('term-1', lan.pc1);
  });

  it('Ctrl+C during the password prompt cancels the connection', async () => {
    await typeNormal(session, `ssh user@${PC2_IP}`);
    await waitFor(() => session.currentInputMode.type === 'password');

    session.handleKey(key('c', { ctrlKey: true }));
    await flush();

    expect(session.currentInputMode.type).toBe('normal');
    expect(session.isInsideSshSession).toBe(false);
  });
});

describe('SSH UI — history and prompt rendering inside the remote session', () => {
  let lan: Lan;
  let session: LinuxTerminalSession;

  beforeEach(async () => {
    resetEquipmentRegistry();
    lan = await buildLan();
    session = new LinuxTerminalSession('term-1', lan.pc1);
  });

  it('updates the prompt path after a `cd` on the remote', async () => {
    await typeNormal(session, `ssh user@${PC2_IP}`);
    await waitFor(() => session.currentInputMode.type === 'password');
    await typePassword(session, 'admin');
    await waitFor(() => session.isInsideSshSession);

    await typeNormal(session, 'cd /tmp');
    await waitFor(() => session.getPrompt().includes('/tmp'));
    expect(session.getPrompt()).toContain('/tmp');

    const before = session.lines.length;
    await typeNormal(session, 'pwd');
    await waitFor(() => session.lines.length > before);
    expect(linesText(session).slice(before).join('\n')).toContain('/tmp');
  });

  it('preserves bash history across the SSH lifecycle (local before, remote during, local after)', async () => {
    await typeNormal(session, 'echo local-pre');
    await flush();
    await typeNormal(session, `ssh user@${PC2_IP}`);
    await waitFor(() => session.currentInputMode.type === 'password');
    await typePassword(session, 'admin');
    await waitFor(() => session.isInsideSshSession);

    await typeNormal(session, 'echo remote');
    await flush();

    await typeNormal(session, 'exit');
    await waitFor(() => !session.isInsideSshSession);

    await typeNormal(session, 'echo local-post');
    await flush();

    expect(hasLine(session, /local-pre/)).toBe(true);
    expect(hasLine(session, /remote/)).toBe(true);
    expect(hasLine(session, /local-post/)).toBe(true);
    expect(hasLine(session, /Connection to 10\.0\.0\.2 closed\./)).toBe(true);
  });
});

describe('SSH UI — multi-host scenarios', () => {
  let lan: Lan;
  let session: LinuxTerminalSession;

  beforeEach(async () => {
    resetEquipmentRegistry();
    lan = await buildLan();
    session = new LinuxTerminalSession('term-1', lan.pc1);
  });

  it('can connect to PC2, exit, then connect to PC3', async () => {
    // PC2
    await typeNormal(session, `ssh user@${PC2_IP}`);
    await waitFor(() => session.currentInputMode.type === 'password');
    await typePassword(session, 'admin');
    await waitFor(() => session.isInsideSshSession);
    expect(session.getPrompt()).toContain('PC2');

    await typeNormal(session, 'exit');
    await waitFor(() => !session.isInsideSshSession);
    expect(session.getPrompt()).toContain('PC1');

    // PC3
    await typeNormal(session, `ssh user@${PC3_IP}`);
    await waitFor(() => session.currentInputMode.type === 'password');
    await typePassword(session, 'admin');
    await waitFor(() => session.isInsideSshSession);
    expect(session.getPrompt()).toContain('PC3');
  });

  it('persists known_hosts so the second connection to PC2 does not prompt with -o StrictHostKeyChecking=yes', async () => {
    // First connection (accept-new — silent persist)
    await typeNormal(session, `ssh user@${PC2_IP}`);
    await waitFor(() => session.currentInputMode.type === 'password');
    await typePassword(session, 'admin');
    await waitFor(() => session.isInsideSshSession);
    await typeNormal(session, 'exit');
    await waitFor(() => !session.isInsideSshSession);

    // Second connection with strict checking — must not interrupt.
    await typeNormal(
      session,
      `ssh -o StrictHostKeyChecking=yes user@${PC2_IP}`,
    );
    await waitFor(() => session.currentInputMode.type === 'password');
    expect(session.currentInputMode.type).toBe('password'); // not interactive-text
  });
});

describe('SSH UI — public-key auth path (no password prompted)', () => {
  let lan: Lan;
  let session: LinuxTerminalSession;

  beforeEach(async () => {
    resetEquipmentRegistry();
    lan = await buildLan();
    session = new LinuxTerminalSession('term-1', lan.pc1);
  });

  it('does NOT prompt for a password when a working identity exists in ~/.ssh', async () => {
    // 1. Generate a key locally (creates ~/.ssh/id_ed25519{,.pub})
    await typeNormal(session, 'ssh-keygen -t ed25519 -f /home/user/.ssh/id_ed25519 -N ""');
    await flush();

    // 2. Add the public key to PC2's authorized_keys.
    const pubKey = vfsOf(lan.pc1).readFile(
      '/home/user/.ssh/id_ed25519.pub',
    );
    expect(pubKey).toBeTruthy();
    const pc2Vfs = vfsOf(lan.pc2);
    pc2Vfs.mkdirp('/home/user/.ssh', 0o700, 1000, 1000);
    pc2Vfs.writeFile('/home/user/.ssh/authorized_keys', pubKey ?? '', 1000, 1000, 0o022);
    pc2Vfs.chmod('/home/user/.ssh/authorized_keys', 0o600);

    // 3. Connect — no password prompt should appear.
    await typeNormal(session, `ssh user@${PC2_IP}`);
    await waitFor(() => session.isInsideSshSession, 3000);

    expect(session.isInsideSshSession).toBe(true);
    // currentInputMode should never have been 'password' at this point.
    expect(session.currentInputMode.type).not.toBe('password');
  });
});

describe('SSH UI — input routing precedence', () => {
  let lan: Lan;
  let session: LinuxTerminalSession;

  beforeEach(async () => {
    resetEquipmentRegistry();
    lan = await buildLan();
    session = new LinuxTerminalSession('term-1', lan.pc1);
  });

  it('SSH-IO key handler takes precedence over the flow engine and sub-shell handlers', async () => {
    await typeNormal(session, `ssh user@${PC2_IP}`);
    await waitFor(() => session.currentInputMode.type === 'password');

    // No active sub-shell, no flow — only pendingSshIO should be awaiting.
    expect(session.activeSubShell ?? null).toBeNull();
    expect(session.isFlowActive).toBe(false);

    // Pressing arrow keys must NOT navigate history while a prompt is pending.
    const historyBefore = session.history.length;
    session.handleKey(key('ArrowUp'));
    await flush();
    expect(session.history.length).toBe(historyBefore);
  });
});

describe('SSH UI — auth.log produced by the server side during a UI login', () => {
  let lan: Lan;
  let session: LinuxTerminalSession;

  beforeEach(async () => {
    resetEquipmentRegistry();
    lan = await buildLan();
    session = new LinuxTerminalSession('term-1', lan.pc1);
  });

  it('records "Accepted password for user" on PC2 after a successful UI login', async () => {
    await typeNormal(session, `ssh user@${PC2_IP}`);
    await waitFor(() => session.currentInputMode.type === 'password');
    await typePassword(session, 'admin');
    await waitFor(() => session.isInsideSshSession);

    const log = vfsOf(lan.pc2).readFile('/var/log/auth.log') ?? '';
    expect(log).toMatch(/Accepted password for user from 10\.0\.0\.1/);
  });

  it('records "Failed password" on PC2 after a wrong-password UI login', async () => {
    await typeNormal(session, `ssh user@${PC2_IP}`);
    await typeWrongPasswordUntil(session, 'wrong', () =>
      hasLine(session, /Permission denied/),
    );
    await waitFor(() => hasLine(session, /Permission denied/));

    const log = vfsOf(lan.pc2).readFile('/var/log/auth.log') ?? '';
    expect(log).toMatch(/Failed password for user from 10\.0\.0\.1/);
  });
});
