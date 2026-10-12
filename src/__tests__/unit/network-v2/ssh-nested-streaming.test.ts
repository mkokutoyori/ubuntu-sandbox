/*
 * Streaming commands over the SSH shell channel.  The catalogue the local terminal streams (terminal/streams/LinuxStreamPlans)
 * now also runs server-side on the channel's own session, and Ctrl+C reaches it.
 * Measured before the shared catalogue was wired (git stash push -- src/network src/terminal): all 5 new cases fall
 * (dmesg -w, tail -f, vmstat 1 3, top, ip monitor address - nothing streams, the command runs once or not at all; top
 * additionally requires the interrupt to be echoed as ^C, which only happens when a foreground job was running).
 * The ip monitor case also pinned a gap on the way: a secondary address added with ip addr add was never announced on
 * the bus, so monitor stayed silent.  The ping and journalctl -f cases already in the file are the witnesses.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import { SshInteractiveSubShell } from '@/terminal/subshells/SshInteractiveSubShell';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 25));
function texts(s: TerminalSession): string[] { return s.lines.map((l) => l.text); }
async function waitFor(s: TerminalSession, pred: (l: string[]) => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred(texts(s))) return; await tick(); }
}
async function sshLogin(host: TerminalSession, line: string, password: string): Promise<void> {
  host.setInput(line);
  host.setInputBuf(line);
  host.handleKey(key('Enter'));
  for (let i = 0; i < 4 && host.currentInputMode.type !== 'password'; i++) await tick();
  if (host.currentInputMode.type === 'password') {
    host.setPasswordBuf(password);
    host.handleKey(key('Enter'));
  }
  for (let i = 0; i < 4; i++) await tick();
}
function runOnForeground(host: TerminalSession, line: string): void {
  host.foreground.setInput(line);
  host.foreground.setInputBuf(line);
  host.handleKey(key('Enter'));
}

const subShellOf = (host: TerminalSession): unknown =>
  (host as unknown as { activeSubShell: unknown }).activeSubShell;

describe('SSH Windows -> Linux is a transparent transport for behaviour', () => {
  let win: WindowsPC;
  let host: WindowsTerminalSession;
  let linuxHost: LinuxPC;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    win = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const linux = new LinuxPC('linux-pc', 'PC2', 0, 0);
    linuxHost = linux;
    const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 0, 0);
    win.powerOn(); linux.powerOn(); sw.powerOn();
    new Cable('c1').connect(win.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(linux.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    await win.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.10 255.255.255.0');
    await linux.executeCommand('ifconfig eth0 192.168.1.20');
    host = new WindowsTerminalSession('term-1', win);
    await host.init?.();
  });

  it('lands on the real-wire sub-shell after login, not a local child session', async () => {
    await sshLogin(host, 'ssh user@192.168.1.20', 'admin');

    // The hop is driven over the real, authenticated SSH channel: no
    // child session is pushed, so `foreground` stays the host and the
    // sub-shell is the tell (docs/PRD-SSH-Unification.md §4bis B4).
    expect(host.foreground).toBe(host);
    expect(subShellOf(host)).toBeInstanceOf(SshInteractiveSubShell);
  });

  it('ping streams reply-by-reply over SSH, exactly like a local Linux terminal', async () => {
    await sshLogin(host, 'ssh user@192.168.1.20', 'admin');
    runOnForeground(host, 'ping 192.168.1.10');

    await waitFor(host, (l) => l.some((t) => /bytes from 192\.168\.1\.10/.test(t)));
    expect(texts(host).some((t) => /bytes from 192\.168\.1\.10/.test(t))).toBe(true);

    host.handleKey(key('c', { ctrlKey: true }));
    await waitFor(host, (l) => l.some((t) => /ping statistics/.test(t)));
  });

  it('journalctl -f follows the log over SSH', async () => {
    await sshLogin(host, 'ssh user@192.168.1.20', 'admin');
    const before = texts(host).length;
    runOnForeground(host, 'journalctl -f');

    await waitFor(host, (l) => l.length > before);
    host.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(subShellOf(host)).toBeInstanceOf(SshInteractiveSubShell);
  });

  it('journalctl -f streams records written after it started, with its own filters, over SSH', async () => {
    await sshLogin(host, 'ssh user@192.168.1.20', 'admin');
    runOnForeground(host, 'journalctl -f -t sshfollow -o cat');
    await tick();
    await linuxHost.executeCommand('logger -t other "not selected"');
    await linuxHost.executeCommand('logger -t sshfollow "streamed over ssh"');
    await waitFor(host, (l) => l.includes('streamed over ssh'));
    expect(texts(host)).toContain('streamed over ssh');
    expect(texts(host)).not.toContain('not selected');
    host.handleKey(key('c', { ctrlKey: true }));
    for (let i = 0; i < 10; i++) await tick();
    await linuxHost.executeCommand('logger -t sshfollow "after interrupt"');
    for (let i = 0; i < 4; i++) await tick();
    expect(texts(host)).not.toContain('after interrupt');
  });

  it('dmesg -w streams kernel messages logged after it started, over SSH', async () => {
    await sshLogin(host, 'ssh user@192.168.1.20', 'admin');
    runOnForeground(host, 'dmesg -w');
    await tick();
    const logMgr = (linuxHost as unknown as { executor: { logMgr: { logAt(f: string, t: string, m: string): void } } }).executor.logMgr;
    logMgr.logAt('kern.warn', 'kernel', 'sshprobe: link flapped');
    await waitFor(host, (l) => l.some((t) => t.includes('sshprobe: link flapped')));
    expect(texts(host).some((t) => t.includes('sshprobe: link flapped'))).toBe(true);
    host.handleKey(key('c', { ctrlKey: true }));
    for (let i = 0; i < 10; i++) await tick();
    logMgr.logAt('kern.warn', 'kernel', 'sshprobe: after interrupt');
    for (let i = 0; i < 4; i++) await tick();
    expect(texts(host).some((t) => t.includes('sshprobe: after interrupt'))).toBe(false);
  });

  it('tail -f streams the lines appended after it started, over SSH', async () => {
    await sshLogin(host, 'ssh user@192.168.1.20', 'admin');
    await linuxHost.executeCommand('echo first > /tmp/followed.log');
    runOnForeground(host, 'tail -f /tmp/followed.log');
    await waitFor(host, (l) => l.includes('first'));
    await linuxHost.executeCommand('echo second >> /tmp/followed.log');
    await waitFor(host, (l) => l.includes('second'));
    expect(texts(host)).toContain('second');
    host.handleKey(key('c', { ctrlKey: true }));
    for (let i = 0; i < 10; i++) await tick();
    await linuxHost.executeCommand('echo third >> /tmp/followed.log');
    for (let i = 0; i < 4; i++) await tick();
    expect(texts(host)).not.toContain('third');
  });

  it('vmstat 1 3 prints its header and three samples then returns to the prompt, over SSH', async () => {
    await sshLogin(host, 'ssh user@192.168.1.20', 'admin');
    runOnForeground(host, 'vmstat 1 3');
    await waitFor(host, (l) => l.filter((t) => /^\s*\d+\s+\d+\s+\d+/.test(t)).length >= 3, 8000);
    expect(texts(host).filter((t) => /^\s*\d+\s+\d+\s+\d+/.test(t)).length).toBe(3);
    expect(texts(host).some((t) => /procs/.test(t))).toBe(true);
    runOnForeground(host, 'echo back');
    await waitFor(host, (l) => l.includes('back'));
    expect(texts(host)).toContain('back');
  }, 15_000);

  it('top repaints in place over SSH instead of appending frames', async () => {
    await sshLogin(host, 'ssh user@192.168.1.20', 'admin');
    runOnForeground(host, 'top -d 0.1');
    await waitFor(host, (l) => l.some((t) => /^top - /.test(t)));
    const headers = (): number => texts(host).filter((t) => /^top - /.test(t)).length;
    for (let i = 0; i < 12; i++) await tick();
    expect(headers()).toBe(1);
    host.handleKey(key('c', { ctrlKey: true }));
    await waitFor(host, (l) => l.includes('^C'));
    expect(texts(host)).toContain('^C');
  });

  it('ip monitor reports an address event raised after it started, over SSH', async () => {
    await sshLogin(host, 'ssh user@192.168.1.20', 'admin');
    runOnForeground(host, 'ip monitor address');
    await tick();
    await linuxHost.executeCommand('ip addr add 10.9.9.9/24 dev eth0');
    await waitFor(host, (l) => l.some((t) => /10\.9\.9\.9/.test(t)));
    expect(texts(host).some((t) => /10\.9\.9\.9/.test(t))).toBe(true);
    host.handleKey(key('c', { ctrlKey: true }));
  });

  it('tail -f piped into grep streams only the matching lines, over SSH', async () => {
    await sshLogin(host, 'ssh user@192.168.1.20', 'admin');
    await linuxHost.executeCommand('echo seed > /tmp/piped.log');
    runOnForeground(host, "tail -f /tmp/piped.log | grep 'ERROR'");
    await tick();
    await linuxHost.executeCommand('echo "INFO boot" >> /tmp/piped.log');
    await linuxHost.executeCommand('echo "ERROR disk full" >> /tmp/piped.log');
    await waitFor(host, (l) => l.includes('ERROR disk full'));
    expect(texts(host)).toContain('ERROR disk full');
    expect(texts(host)).not.toContain('INFO boot');
    host.handleKey(key('c', { ctrlKey: true }));
    await waitFor(host, (l) => l.includes('^C'));
    for (let i = 0; i < 8; i++) await tick();
    await linuxHost.executeCommand('echo "ERROR after interrupt" >> /tmp/piped.log');
    for (let i = 0; i < 4; i++) await tick();
    expect(texts(host)).not.toContain('ERROR after interrupt');
  });

  it('journalctl -f piped into grep filters the initial snapshot and the followed records, over SSH', async () => {
    await sshLogin(host, 'ssh user@192.168.1.20', 'admin');
    await linuxHost.executeCommand('logger -t pipetag "keep before"');
    await linuxHost.executeCommand('logger -t pipetag "drop before"');
    runOnForeground(host, "journalctl -f -t pipetag -o cat | grep keep");
    await waitFor(host, (l) => l.includes('keep before'));
    await linuxHost.executeCommand('logger -t pipetag "keep after"');
    await linuxHost.executeCommand('logger -t pipetag "drop after"');
    await waitFor(host, (l) => l.includes('keep after'));
    expect(texts(host)).toContain('keep after');
    expect(texts(host).filter((t) => t.startsWith('drop'))).toEqual([]);
    host.handleKey(key('c', { ctrlKey: true }));
  });

  it('a pipe into a command that needs the whole input is not streamed (WITNESS: runs once and returns)', async () => {
    await sshLogin(host, 'ssh user@192.168.1.20', 'admin');
    await linuxHost.executeCommand('printf "a\\nb\\n" > /tmp/whole.log');
    runOnForeground(host, 'tail -f /tmp/whole.log | wc -l');
    await waitFor(host, (l) => l.includes('2'));
    runOnForeground(host, 'echo prompt-back');
    await waitFor(host, (l) => l.includes('prompt-back'));
    expect(texts(host)).toContain('prompt-back');
  });

  it('a sequence runs its leading commands once then streams the last one, over SSH', async () => {
    await sshLogin(host, 'ssh user@192.168.1.20', 'admin');
    await linuxHost.executeCommand('echo seed > /tmp/seq.log');
    runOnForeground(host, 'echo starting-watch; tail -f /tmp/seq.log');
    await waitFor(host, (l) => l.includes('seed'));
    expect(texts(host)).toContain('starting-watch');
    await linuxHost.executeCommand('echo later >> /tmp/seq.log');
    await waitFor(host, (l) => l.includes('later'));
    expect(texts(host)).toContain('later');
    host.handleKey(key('c', { ctrlKey: true }));
  });

  it('&& does not stream the last command when the first one failed, over SSH', async () => {
    await sshLogin(host, 'ssh user@192.168.1.20', 'admin');
    runOnForeground(host, 'false && tail -f /tmp/never.log');
    for (let i = 0; i < 6; i++) await tick();
    runOnForeground(host, 'echo after-skip');
    await waitFor(host, (l) => l.includes('after-skip'));
    expect(texts(host)).toContain('after-skip');
    expect(texts(host).some((t) => /never\.log/.test(t) && !t.startsWith('false'))).toBe(false);
  });

  it('exit closes the remote session and returns to the Windows host', async () => {
    await sshLogin(host, 'ssh user@192.168.1.20', 'admin');
    expect(subShellOf(host)).toBeInstanceOf(SshInteractiveSubShell);

    runOnForeground(host, 'exit');
    await tick();
    expect(host.foreground).toBe(host);
    expect(subShellOf(host)).toBeNull();
    expect(texts(host)).toContain('Connection to 192.168.1.20 closed.');
  });
});
