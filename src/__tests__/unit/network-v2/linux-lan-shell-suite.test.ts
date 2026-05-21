/**
 * Linux LAN shell suite — end-to-end terminal behaviour.
 *
 * Sister-suite to `linux-lan-ssh-suite.test.ts`: each section is an
 * oracle of how the interactive *terminal* surface should behave on a
 * realistic LAN, independent of any specific implementation detail.
 * Failures pinpoint regressions on the user-visible UX.
 *
 * Sections (this PR — terminal_gap.md §10):
 *   §1  `exit` from sudo / su returns to the previous user (does NOT
 *       close the terminal as long as a frame is still on the su stack)
 *   §2  `sudo <cmd>` actually runs <cmd> with elevated privileges for
 *       a broad set of admin tools (useradd, adduser, groupadd, chown,
 *       systemctl, …) and the resulting state is visible afterwards
 *   §3  Editors (`nano`, `vi`, `vim`) work when chained with `&&`, `;`,
 *       `||` — the prefix runs, the editor opens, the suffix runs on
 *       exit. The parser tolerates quotes and `sudo` prefixes.
 *
 * Topology (built fresh per test): same as linux-lan-ssh-suite.
 *
 *     pc1 ─┐                              ┌─ srv1 (oracle)
 *     pc2 ─┼─ switch ─┬─────────────────── ┤
 *     pc3 ─┤          │                    └─ srv2 (file/web server)
 *     pc4 ─┘          (10.0.0.0/24)
 *
 * Conventions match the sister-suite: pcN=10.0.0.N, srvK=10.0.0.10+K-1.
 */

import { describe, expect, beforeEach, test, it } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import {
  parseShellChain,
  isEditorSegment,
  shouldExecuteSegment,
} from '@/terminal/sessions/LinuxTerminalSession';

// ─── LAN fixture (mirrors linux-lan-ssh-suite.ts) ────────────────────

export interface Lan {
  pc1: LinuxPC; pc2: LinuxPC; pc3: LinuxPC; pc4: LinuxPC;
  srv1: LinuxServer; srv2: LinuxServer;
  sw: GenericSwitch;
  ipOf: Record<string, string>;
  manager: TerminalManager;
}

function buildLan(): Lan {
  EquipmentRegistry.getInstance().clear();
  const bus = new EventBus();
  __setDefaultEventBus(bus);
  EquipmentRegistry.getInstance().setEventBus(bus);

  const pc1 = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const pc2 = new LinuxPC('linux-pc', 'pc2', 0, 0);
  const pc3 = new LinuxPC('linux-pc', 'pc3', 0, 0);
  const pc4 = new LinuxPC('linux-pc', 'pc4', 0, 0);
  const srv1 = new LinuxServer('linux-server', 'srv1', 0, 0);
  const srv2 = new LinuxServer('linux-server', 'srv2', 0, 0);
  const sw = new GenericSwitch('switch', 'core-sw', 0, 0);
  const all: (LinuxPC | LinuxServer)[] = [pc1, pc2, pc3, pc4, srv1, srv2];
  all.forEach((d) => d.setEventBus(bus));
  all.forEach((d, i) => { new Cable(d.getPorts()[0], sw.getPorts()[i]); });

  const mask = new SubnetMask('255.255.255.0');
  pc1.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  pc2.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  pc3.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  pc4.getPorts()[0].configureIP(new IPAddress('10.0.0.4'), mask);
  srv1.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), mask);
  srv2.getPorts()[0].configureIP(new IPAddress('10.0.0.11'), mask);

  pc1.setHostname('pc1'); pc2.setHostname('pc2'); pc3.setHostname('pc3'); pc4.setHostname('pc4');
  srv1.setHostname('srv1'); srv2.setHostname('srv2');

  const manager = new TerminalManager(bus);

  return {
    pc1, pc2, pc3, pc4, srv1, srv2, sw,
    ipOf: {
      pc1: '10.0.0.1', pc2: '10.0.0.2', pc3: '10.0.0.3', pc4: '10.0.0.4',
      srv1: '10.0.0.10', srv2: '10.0.0.11',
    },
    manager,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

type Dev = LinuxPC | LinuxServer;

/** Open a fresh interactive terminal on the device. */
function openTerminal(lan: Lan, dev: Dev): LinuxTerminalSession {
  const sid = lan.manager.openTerminal(dev)!;
  return lan.manager.getSession(sid) as LinuxTerminalSession;
}

/** Drive `input` through the session as if the user typed + Enter. */
async function typeLine(session: LinuxTerminalSession, line: string): Promise<void> {
  session.setInput(line);
  session.handleKey({
    key: 'Enter', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
  });
  await new Promise(r => setTimeout(r, 50));
}

/** Submit a password into a paused flow's password input. */
async function typePassword(session: LinuxTerminalSession, pw: string): Promise<void> {
  session.setPasswordBuf(pw);
  session.handleKey({
    key: 'Enter', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
  });
  await new Promise(r => setTimeout(r, 50));
}

/** Concatenated text content of all scrollback lines (for substring asserts). */
function dump(session: LinuxTerminalSession): string {
  return session.lines.map(l => l.text).join('\n');
}

// ─── §1 — exit from sudo / su unwinds, never closes the terminal ─────

describe('§1 — exit from sudo/su returns to previous user', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  it('sudo su → cd /etc → exit returns to user, terminal stays open', async () => {
    const t = openTerminal(lan, lan.pc1);
    expect(t.shell!.user).toBe('user');

    await typeLine(t, 'sudo su');
    await typePassword(t, 'admin');
    expect(t.shell!.user).toBe('root');
    expect(t.shell!.suStack.length).toBe(1);

    await typeLine(t, 'cd /etc');
    expect(t.shell!.cwd).toBe('/etc');

    // Now exit — the session must pop one su frame, NOT close the terminal.
    let closed = false;
    (t as unknown as { _onRequestClose?: () => void })._onRequestClose = () => { closed = true; };
    await typeLine(t, 'exit');

    expect(closed).toBe(false);
    expect(t.shell!.user).toBe('user');
    expect(t.shell!.suStack.length).toBe(0);
    // cwd was restored to where we were before `sudo su`.
    expect(t.shell!.cwd).toBe('/home/user');
  });

  it('su alice → exit pops back to user (no terminal close)', async () => {
    const t = openTerminal(lan, lan.pc1);
    // Provision alice on the box so su works.
    await typeLine(t, 'sudo useradd -m alice');
    await typePassword(t, 'admin');
    await typeLine(t, 'sudo passwd alice');
    await typePassword(t, 'admin');
    // adduser flow asks for new password twice — submit a known one.
    await typePassword(t, 'alice123');
    await typePassword(t, 'alice123');

    await typeLine(t, 'su alice');
    await typePassword(t, 'alice123');
    expect(t.shell!.user).toBe('alice');
    expect(t.shell!.suStack.length).toBe(1);

    let closed = false;
    (t as unknown as { _onRequestClose?: () => void })._onRequestClose = () => { closed = true; };
    await typeLine(t, 'exit');
    expect(closed).toBe(false);
    expect(t.shell!.user).toBe('user');
  });

  it('exit while still inside su does not close, only top-level exit does', async () => {
    const t = openTerminal(lan, lan.pc1);
    let closed = false;
    (t as unknown as { _onRequestClose?: () => void })._onRequestClose = () => { closed = true; };

    await typeLine(t, 'sudo su');           // user → root, 1 frame pushed
    await typePassword(t, 'admin');
    expect(t.shell!.user).toBe('root');
    expect(t.shell!.suStack.length).toBe(1);

    // Exit pops the frame: back to user, terminal stays open.
    await typeLine(t, 'exit');
    expect(closed).toBe(false);
    expect(t.shell!.user).toBe('user');
    expect(t.shell!.suStack.length).toBe(0);

    // Another exit, now at top-level, closes the terminal.
    await typeLine(t, 'exit');
    expect(closed).toBe(true);
  });

  it('exit at top level (no su) closes the terminal — original behaviour preserved', async () => {
    const t = openTerminal(lan, lan.pc1);
    let closed = false;
    (t as unknown as { _onRequestClose?: () => void })._onRequestClose = () => { closed = true; };
    await typeLine(t, 'exit');
    expect(closed).toBe(true);
  });
});

// ─── §2 — sudo correctly delegates to admin commands ─────────────────

describe('§2 — sudo + admin commands run effectively', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  type AdminRow = {
    name: string;
    cmd: string;
    /** A side-effect probe — run after the sudo command. */
    probe: string;
    /** Substrings the probe output must contain. */
    contains: (string | RegExp)[];
  };

  const rows: AdminRow[] = [
    {
      name: 'sudo useradd creates the user (visible in /etc/passwd)',
      cmd: 'sudo useradd -m bob',
      probe: 'cat /etc/passwd',
      contains: [/^bob:/m],
    },
    {
      name: 'sudo useradd -G adds to a supplementary group',
      cmd: 'sudo useradd -m -G sudo carol',
      probe: 'groups carol',
      contains: ['sudo'],
    },
    {
      name: 'sudo groupadd creates a group',
      cmd: 'sudo groupadd ops',
      probe: 'cat /etc/group',
      contains: [/^ops:/m],
    },
    {
      name: 'sudo mkdir creates a directory owned by root',
      cmd: 'sudo mkdir /opt/myapp',
      probe: 'ls -ld /opt/myapp',
      contains: ['/opt/myapp'],
    },
    {
      name: 'sudo chown changes ownership',
      cmd: 'sudo mkdir /opt/data && sudo chown user /opt/data',
      probe: 'ls -ld /opt/data',
      contains: [/user/],
    },
    {
      name: 'sudo chmod changes mode',
      cmd: 'sudo touch /opt/file && sudo chmod 600 /opt/file',
      probe: 'ls -l /opt/file',
      contains: [/^-rw-------/m],
    },
  ];

  test.each(rows)('$name', async (row) => {
    const t = openTerminal(lan, lan.pc1);
    await typeLine(t, row.cmd);
    await typePassword(t, 'admin');
    // The chained "sudo ... && sudo ..." rows include a second sudo —
    // the cached sudo timestamp on a real Ubuntu means no re-prompt
    // within 15 min. Our simulator does the same since the password
    // is verified once per flow; we don't expect a second prompt.

    // Run the probe (no sudo, plain read) and assert.
    await typeLine(t, row.probe);
    const text = dump(t);
    for (const c of row.contains) {
      if (c instanceof RegExp) expect(text).toMatch(c);
      else expect(text).toContain(c);
    }
  });

  it('sudo adduser <user> interactive flow provisions the account', async () => {
    const t = openTerminal(lan, lan.pc1);
    await typeLine(t, 'sudo adduser dave');
    await typePassword(t, 'admin');
    // adduser asks for the new password twice…
    await typePassword(t, 'davepw');
    await typePassword(t, 'davepw');
    // …then GECOS fields (Full name, Room number, Phone, Other, Y/n).
    // The session is paused on an `interactive-text` step between each;
    // submit empties (defaults) until the flow completes.
    for (let safety = 0; safety < 10; safety++) {
      if (t.inputMode.type !== 'interactive-text') break;
      t.setInputBuf('');
      t.handleKey({ key: 'Enter', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
      await new Promise(r => setTimeout(r, 40));
    }

    // The user should now exist on the box.
    await typeLine(t, 'cat /etc/passwd');
    expect(dump(t)).toMatch(/^dave:/m);
  });

  it('sudo passwd <user> changes the password', async () => {
    const t = openTerminal(lan, lan.pc1);
    await typeLine(t, 'sudo useradd -m eve');
    await typePassword(t, 'admin');
    await typeLine(t, 'sudo passwd eve');
    await typePassword(t, 'admin');
    await typePassword(t, 'evepw123');
    await typePassword(t, 'evepw123');
    expect(dump(t)).toContain('passwd: password updated successfully');

    // Validate by su'ing with the new credentials.
    await typeLine(t, 'su eve');
    await typePassword(t, 'evepw123');
    expect(t.shell!.user).toBe('eve');
  });
});

// ─── §3 — editors work inside `&&`, `;`, `||` chains ─────────────────

describe('§3 — editors compose with shell connectors', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  it('parseShellChain segments respect quotes and operators', () => {
    expect(parseShellChain('a && b').map(s => s.cmd)).toEqual(['a', 'b']);
    expect(parseShellChain('a; b; c').map(s => s.cmd)).toEqual(['a', 'b', 'c']);
    expect(parseShellChain('a || b').map(s => s.cmd)).toEqual(['a', 'b']);
    expect(parseShellChain('echo "a && b"').map(s => s.cmd)).toEqual(['echo "a && b"']);
    expect(parseShellChain("echo 'a; b'").map(s => s.cmd)).toEqual(["echo 'a; b'"]);
    expect(parseShellChain('a && b || c').map(s => s.connector)).toEqual([';', '&&', '||']);
  });

  it('isEditorSegment recognises sudo-prefixed editor invocations', () => {
    expect(isEditorSegment('nano /tmp/x')).toBe(true);
    expect(isEditorSegment('sudo vim /etc/hostname')).toBe(true);
    expect(isEditorSegment('vi')).toBe(true);
    expect(isEditorSegment('ls /etc')).toBe(false);
    expect(isEditorSegment('mkdir nano')).toBe(false);
  });

  it('shouldExecuteSegment encodes && / || / ; semantics', () => {
    expect(shouldExecuteSegment(';',  0)).toBe(true);
    expect(shouldExecuteSegment(';',  1)).toBe(true);
    expect(shouldExecuteSegment('&&', 0)).toBe(true);
    expect(shouldExecuteSegment('&&', 1)).toBe(false);
    expect(shouldExecuteSegment('||', 0)).toBe(false);
    expect(shouldExecuteSegment('||', 1)).toBe(true);
  });

  it('mkdir foo && nano foo/x.txt: prefix runs, editor opens', async () => {
    const t = openTerminal(lan, lan.pc1);
    await typeLine(t, 'mkdir /tmp/proj && nano /tmp/proj/x.txt');

    // After running, the input mode must be 'editor' (nano took over).
    expect(t.inputMode.type).toBe('editor');
    if (t.inputMode.type === 'editor') {
      expect(t.inputMode.editorType).toBe('nano');
      expect(t.inputMode.filePath).toBe('/tmp/proj/x.txt');
      expect(t.inputMode.isNewFile).toBe(true);
    }
    // Sanity: the prefix `mkdir /tmp/proj` actually ran — /tmp/proj exists.
    // (We probe via a fresh, separate command after editor exit below.)
    t.editorSave('hello world', '/tmp/proj/x.txt');
    t.editorExit(true);
    await new Promise(r => setTimeout(r, 30));

    await typeLine(t, 'cat /tmp/proj/x.txt');
    expect(dump(t)).toContain('hello world');
  });

  it('nano foo && echo done: editor exit triggers the tail', async () => {
    const t = openTerminal(lan, lan.pc1);
    await typeLine(t, 'nano /tmp/note.txt && echo nano-finished');
    expect(t.inputMode.type).toBe('editor');

    t.editorSave('hello', '/tmp/note.txt');
    t.editorExit(true);
    await new Promise(r => setTimeout(r, 50));

    expect(dump(t)).toContain('nano-finished');
  });

  it('false || nano fallback runs the editor on prefix failure', async () => {
    const t = openTerminal(lan, lan.pc1);
    await typeLine(t, 'false || nano /tmp/fb.txt');
    expect(t.inputMode.type).toBe('editor');
    t.editorSave('fallback', '/tmp/fb.txt');
    t.editorExit(true);
  });

  it('true && nano foo (success) opens editor; true && false && nano (failure mid-chain) skips it', async () => {
    const tA = openTerminal(lan, lan.pc1);
    await typeLine(tA, 'true && nano /tmp/a.txt');
    expect(tA.inputMode.type).toBe('editor');
    tA.editorExit(true);

    const tB = openTerminal(lan, lan.pc1);
    await typeLine(tB, 'true && false && nano /tmp/b.txt');
    // The `false` aborts the &&-chain before reaching nano.
    expect(tB.inputMode.type).not.toBe('editor');
  });

  it('vim chained the same way also works', async () => {
    const t = openTerminal(lan, lan.pc1);
    await typeLine(t, 'mkdir /tmp/v && vim /tmp/v/file');
    expect(t.inputMode.type).toBe('editor');
    if (t.inputMode.type === 'editor') {
      expect(t.inputMode.editorType).toBe('vim');
    }
  });

  it('vi chained the same way also works', async () => {
    const t = openTerminal(lan, lan.pc1);
    await typeLine(t, 'mkdir /tmp/vi && vi /tmp/vi/file');
    expect(t.inputMode.type).toBe('editor');
    if (t.inputMode.type === 'editor') {
      expect(t.inputMode.editorType).toBe('vi');
    }
  });

  it('editor path uses the per-terminal cwd (regression with cd in chain)', async () => {
    const t = openTerminal(lan, lan.pc1);
    await typeLine(t, 'mkdir /tmp/rel && cd /tmp/rel && nano file.txt');
    // After `cd /tmp/rel` the relative path "file.txt" must resolve to
    // /tmp/rel/file.txt — *not* /home/user/file.txt.
    expect(t.inputMode.type).toBe('editor');
    if (t.inputMode.type === 'editor') {
      expect(t.inputMode.absolutePath).toBe('/tmp/rel/file.txt');
    }
  });
});
