/**
 * Scénario 6 — Édition de fichiers de configuration réseau critiques :
 * /etc/hosts, /etc/resolv.conf, /etc/network/interfaces, avec sauvegarde
 * préalable, validation syntaxique via les outils natifs (getent,
 * awk, ifup --no-act), et xxd pour l'inspection binaire.
 *
 * TDD: written against the real device (LinuxPC) + the production
 * LinuxEditorFsContext adapter, driving NanoEngine/VimEngine exactly as
 * the real UI would, then validating through genuine `pc.executeCommand`
 * calls — no shortcuts, no direct VFS pokes for the parts under test.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { LinuxEditorFsContext } from '@/terminal/sessions/LinuxEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';

function typeText(engine: { applyKey(k: EditorKeyInput): void }, text: string): void {
  for (const ch of text) engine.applyKey(editorKey(ch));
}
function press(engine: { applyKey(k: EditorKeyInput): void }, key: string, mods: Partial<EditorKeyInput> = {}): void {
  engine.applyKey(editorKey(key, mods));
}
function ctrl(engine: { applyKey(k: EditorKeyInput): void }, key: string): void {
  engine.applyKey(editorKey(key, { ctrl: true }));
}

let pc: LinuxPC;
beforeEach(() => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
});

describe('Scénario 6 — édition sécurisée de /etc/hosts avec nano', () => {
  it('sauvegarde, ajoute les entrées, et la validation getent/awk passe', async () => {
    const original = await pc.executeCommand('cat /etc/hosts');
    await pc.executeCommand('cp /etc/hosts /tmp/hosts.bak');

    const fsCtx = new LinuxEditorFsContext(pc);
    const nano = new NanoEngine(fsCtx, '/etc/hosts', fsCtx.readFile('/etc/hosts')!, false);

    // Navigate to end of buffer and append the new entries.
    for (let i = 0; i < nano.lines.length; i++) press(nano, 'ArrowDown');
    press(nano, 'End');
    const entries = [
      '192.168.10.101\tpc-linux-1\tlinux1',
      '192.168.10.102\tpc-linux-2\tlinux2',
      '192.168.10.10\tswitch\tswitch-huawei',
      '192.168.10.20\tsrv-oracle\toracle-db',
    ];
    for (const entry of entries) {
      press(nano, 'Enter');
      typeText(nano, entry);
    }
    ctrl(nano, 'o');
    press(nano, 'Enter');
    ctrl(nano, 'x');
    expect(nano.exited).toBe(true);
    expect(nano.swapFileExists).toBe(false);

    // Real getent hosts resolution — proves the edit propagated to NSS.
    const getentLinux2 = await pc.executeCommand('getent hosts pc-linux-2');
    expect(getentLinux2).toContain('192.168.10.102');
    expect(getentLinux2).toContain('pc-linux-2');
    const getentOracle = await pc.executeCommand('getent hosts srv-oracle');
    expect(getentOracle).toContain('192.168.10.20');

    // awk syntax check: every non-comment, non-blank line has >= 2 fields
    // and a plausible IPv4/IPv6 first field.
    const awkCheck = await pc.executeCommand(String.raw`awk '!/^#/ && !/^$/ { if (NF < 2) print "ERR", NR; else if ($1 !~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ && $1 !~ /^[0-9a-fA-F:]+$/) print "BADIP", NR }' /etc/hosts`);
    expect(awkCheck.trim()).toBe('');

    // The backup lets us diff — only the appended lines should differ.
    const diffOut = await pc.executeCommand('diff /tmp/hosts.bak /etc/hosts');
    for (const entry of entries) {
      expect(diffOut).toContain(entry.split('\t')[0]);
    }
    expect(await pc.executeCommand('cat /tmp/hosts.bak')).toBe(original);
  });
});

describe('Scénario 6 — édition sécurisée de /etc/resolv.conf avec vim', () => {
  it('vérification préalable des permissions : root:root 0644, non modifiable par un utilisateur non privilégié', async () => {
    const perms = await pc.executeCommand('ls -la /etc/resolv.conf');
    expect(perms).toMatch(/^-rw-r--r--\s+1\s+root\s+root/);

    // Attempting the edit as the default unprivileged "user" must NOT
    // silently succeed — the write is correctly rejected by the VFS.
    const fsCtx = new LinuxEditorFsContext(pc);
    const before = fsCtx.readFile('/etc/resolv.conf');
    fsCtx.writeFile('/etc/resolv.conf', 'nameserver 10.0.0.1\n');
    expect(fsCtx.readFile('/etc/resolv.conf')).toBe(before);
  });

  it('ajoute les serveurs DNS et options, validés par awk', async () => {
    await pc.executeCommand('cp /etc/resolv.conf /tmp/resolv.conf.bak');

    // /etc/resolv.conf is root:root 0644 — a real, correctly-enforced
    // permission wall for the default unprivileged "user" account.
    // Editing it for real requires root, exactly like `sudo nano
    // /etc/resolv.conf` would on a real system.
    const rootSession = pc.openShellSession({ user: 'root' });
    const fsCtx = new LinuxEditorFsContext(pc, rootSession);
    const vim = new VimEngine(fsCtx, '/etc/resolv.conf', fsCtx.readFile('/etc/resolv.conf')!, false, 'vim');

    press(vim, 'G');
    press(vim, 'o');
    typeText(vim, 'nameserver 192.168.10.1');
    press(vim, 'Escape');
    press(vim, 'o');
    typeText(vim, 'nameserver 192.168.10.2');
    press(vim, 'Escape');
    press(vim, 'o');
    typeText(vim, 'options ndots:5 timeout:2 attempts:3');
    press(vim, 'Escape');

    press(vim, ':'); typeText(vim, 'wq'); press(vim, 'Enter');
    expect(vim.exited).toBe(true);
    expect(vim.swapFileExists).toBe(false);

    const content = await pc.executeCommand('cat /etc/resolv.conf');
    expect(content).toContain('nameserver 192.168.10.1');
    expect(content).toContain('nameserver 192.168.10.2');
    expect(content).toContain('options ndots:5 timeout:2 attempts:3');

    const awkCheck = await pc.executeCommand(String.raw`awk '/^nameserver/ { if ($2 !~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) print "BADNS" } /^options/ { next } !/^nameserver/ && !/^options/ && !/^$/ { print "UNKNOWN:", $0 }' /etc/resolv.conf`);
    expect(awkCheck).not.toContain('BADNS');
  });
});

describe('Scénario 6 — édition de /etc/network/interfaces avec vim, validée par ifup --no-act', () => {
  it('crée une interface statique complète et ifup --no-act la valide sans erreur', async () => {
    const fsCtx = new LinuxEditorFsContext(pc);
    const existing = fsCtx.readFile('/etc/network/interfaces');
    expect(existing).toBeNull(); // no /etc/network/interfaces by default on a fresh LinuxPC
    const vim = new VimEngine(fsCtx, '/etc/network/interfaces', '', true, 'vim');

    press(vim, 'i'); // empty new-file buffer: insert directly on the blank line
    const block = [
      'auto eth0',
      'iface eth0 inet static',
      '    address 192.168.10.101',
      '    netmask 255.255.255.0',
      '    gateway 192.168.10.254',
      '    dns-nameservers 192.168.10.1 192.168.10.2',
      '    dns-search lan.local',
    ];
    typeText(vim, block[0]);
    for (const line of block.slice(1)) {
      press(vim, 'Enter');
      typeText(vim, line);
    }
    press(vim, 'Escape');

    press(vim, ':'); typeText(vim, 'wq'); press(vim, 'Enter');
    expect(vim.exited).toBe(true);

    const ifupOut = await pc.executeCommand('ifup --no-act eth0');
    expect(ifupOut).not.toContain('could not read');
    expect(ifupOut).not.toContain('unknown interface');
    expect(ifupOut).toContain('192.168.10.101');

    // Confirm --no-act is a genuine dry-run: no actual IP was applied.
    const ipShow = await pc.executeCommand('ip addr show eth0');
    expect(ipShow).not.toContain('192.168.10.101');
  });
});

describe('Scénario 6 — xxd pour l\'inspection binaire des fichiers édités', () => {
  it('produit un dump hexadécimal fidèle, utilisable pour comparer deux fichiers octet par octet', async () => {
    await pc.executeCommand('echo "Hello, World!" > /tmp/xxd-test.txt');
    const out = await pc.executeCommand('xxd /tmp/xxd-test.txt');
    expect(out).toBe('00000000: 4865 6c6c 6f2c 2057 6f72 6c64 210a       Hello, World!.');
  });

  it('detects a trailing-newline difference between two otherwise-identical files', async () => {
    await pc.executeCommand("printf 'same content' > /tmp/a.txt");
    await pc.executeCommand("printf 'same content\\n' > /tmp/b.txt");
    const xxdA = await pc.executeCommand('xxd /tmp/a.txt');
    const xxdB = await pc.executeCommand('xxd /tmp/b.txt');
    expect(xxdA).not.toBe(xxdB);
    expect(xxdB.split('\n').at(-1)).toMatch(/0a/); // trailing newline byte visible
  });

  it('reports a clean error for a missing file rather than throwing', async () => {
    const out = await pc.executeCommand('xxd /tmp/does-not-exist.txt');
    expect(out).toContain('No such file or directory');
  });
});
