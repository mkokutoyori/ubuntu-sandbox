/**
 * `ping`/`tracert` inside PowerShell must stream identically to cmd —
 * same replies arriving one at a time with a delay, not the whole
 * output landing in a single blob (audit follow-up: cmd/PowerShell
 * behavioural parity).
 *
 * Root cause: the streaming interceptors (tryStartWinPingStream, …) were
 * gated to `shellMode === 'cmd'` and only wired into the ROOT command
 * loop — never consulted from the PowerShell sub-shell's key handler, so
 * `ping` typed inside `powershell` fell through to the native-command
 * delegation path, which returns the fully-formed output synchronously.
 *
 * The fix reuses the SAME interceptor methods for both shells (no
 * per-vendor/per-shell duplication) — only the entry-point wiring and an
 * internal guard changed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 25));
function texts(s: WindowsTerminalSession): string[] { return s.lines.map((l) => l.text); }
async function waitFor(s: WindowsTerminalSession, pred: (l: string[]) => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred(texts(s))) return; await tick(); }
}

let win: WindowsPC;
let session: WindowsTerminalSession;

beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  win = new WindowsPC('windows-pc', 'PC1', 0, 0);
  const linux = new LinuxPC('linux-pc', 'PC2', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 0, 0);
  win.powerOn(); linux.powerOn(); sw.powerOn();
  new Cable('c1').connect(win.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(linux.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  await win.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.10 255.255.255.0');
  await linux.executeCommand('ifconfig eth0 192.168.1.20');
  session = new WindowsTerminalSession('term-1', win);
  await session.init?.();
});

async function type(cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await tick();
}

async function typePsLine(cmd: string): Promise<void> {
  session.setInputBuf(cmd);
  session.handleKey(key('Enter'));
  await tick();
}

async function enterPowerShell(): Promise<void> {
  session.setInput('powershell');
  session.handleKey(key('Enter'));
  await new Promise((r) => setTimeout(r, 60));
  expect(session.shellMode).toBe('powershell');
}

describe('ping inside PowerShell streams exactly like cmd', () => {
  it('ping -n streams replies progressively (not all at once) and prints statistics', async () => {
    await enterPowerShell();
    await typePsLine('ping -n 3 192.168.1.20');

    // Immediately after submitting, at most the first reply (or none yet)
    // should be visible — a synchronous/batched implementation would show
    // all 3 replies right away.
    const early = texts(session).filter((t) => t.includes('Reply from 192.168.1.20')).length;
    expect(early).toBeLessThan(3);

    await waitFor(session, (l) => l.filter((t) => t.includes('Reply from 192.168.1.20')).length === 3);
    await waitFor(session, (l) => l.some((t) => t.includes('Ping statistics')));
    const lines = texts(session);
    expect(lines.filter((t) => t.includes('Reply from 192.168.1.20')).length).toBe(3);
    expect(lines.some((t) => t.includes('Sent = 3, Received = 3'))).toBe(true);
  });

  it('ping -t inside PowerShell runs continuously until Ctrl+C', async () => {
    await enterPowerShell();
    await typePsLine('ping -t 192.168.1.20');
    await waitFor(session, (l) => l.filter((t) => t.includes('Reply from')).length >= 2, 6000);
    expect(session.hasForegroundAsyncJob).toBe(true);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(texts(session).some((t) => t.includes('Ping statistics'))).toBe(true);
  });
});

describe('tracert inside PowerShell streams hop-by-hop like cmd', () => {
  it('the job is a real async foreground job, not a synchronous batch', async () => {
    await enterPowerShell();

    // Checked SYNCHRONOUSLY right after the keypress (mirrors the
    // equivalent cmd-mode assertion in windows-tracert-stream-ui.test.ts)
    // — a synchronous/batched implementation would already be finished by
    // the time even a single microtask tick elapses on this topology's
    // short, low-latency direct route.
    session.setInputBuf('tracert 192.168.1.20');
    session.handleKey(key('Enter'));
    expect(session.hasForegroundAsyncJob).toBe(true);

    await waitFor(session, (l) => l.some((t) => t.includes('Trace complete')), 6000);
    expect(session.hasForegroundAsyncJob).toBe(false);
    const out = texts(session);
    expect(out.some((t) => t.includes('Tracing route to'))).toBe(true);
    expect(out.some((t) => t.includes('192.168.1.20'))).toBe(true);
  });
});

describe('`powershell <command>` one-shot invocation from cmd streams natively too', () => {
  it('`powershell ping -n 3 192.168.1.20` typed directly at cmd streams progressively', async () => {
    // No `enterPowerShell()` here — this is the ONE-SHOT `powershell <cmd>`
    // form run straight from the root cmd.exe prompt (real powershell.exe
    // spawns a fresh process, but ping's own stdout still streams through
    // to the console as it arrives — it does not get buffered until the
    // whole invocation finishes).
    await type('powershell ping -n 3 192.168.1.20');

    const early = texts(session).filter((t) => t.includes('Reply from 192.168.1.20')).length;
    expect(early).toBeLessThan(3);

    await waitFor(session, (l) => l.filter((t) => t.includes('Reply from 192.168.1.20')).length === 3);
    await waitFor(session, (l) => l.some((t) => t.includes('Ping statistics')));
    expect(session.shellMode).toBe('cmd');
  });
});

describe('a non-native PowerShell cmdlet is unaffected by the streaming fix', () => {
  it('Test-Connection still renders as the PS table format (no cmd bleed-through)', async () => {
    await enterPowerShell();
    await typePsLine('Test-Connection -Count 1 192.168.1.20');
    await waitFor(session, (l) => l.some((t) => t.includes('Destination')));
    const out = texts(session).join('\n');
    expect(out).toContain('IPV4Address');
    expect(out).not.toContain('Pinging 192.168.1.20');
  });
});
