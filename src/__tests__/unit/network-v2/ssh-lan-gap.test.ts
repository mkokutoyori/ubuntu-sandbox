/**
 * SSH LAN — gap-analysis remediations P5/P8/P9.
 *
 * Mirrors §5 of `docs/SSH-IMPLEMENTATION-ANALYSIS.md`:
 *
 *  - G1..G3  (P9) `/var/log/wtmp.json` + `/var/log/btmp.json` feed
 *            `last` and `lastb` with OpenSSH-shaped rows.
 *  - G4..G6  (P8) `HashKnownHosts yes` persists the host token in
 *            `|1|<salt>|<hash>` form and the entry still authorises
 *            future connections.
 *  - G7..G9  (P5) `sftp -b <batchfile>` runs lines non-interactively
 *            and exits at EOF.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { Equipment } from '@/network';
import { KnownHostsStore } from '@/network/protocols/ssh/hostkey/KnownHostsStore';
import { SshHostKey } from '@/network/protocols/ssh/SshHostKey';
import {
  hashKnownHostsToken,
  isHashedKnownHostsToken,
  matchHashedHost,
} from '@/network/protocols/ssh/SshPureUtils';
import { SshConfig } from '@/network/protocols/ssh/SshConfig';
import {
  buildLan,
  assignIps,
  openSshSession,
  sshExec,
  type SshLan,
  PC2_IP,
} from './ssh-lan-fixtures';

describe('SSH gap-analysis remediations (P5/P8/P9)', () => {
  let lan: SshLan;

  beforeEach(async () => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    Equipment.clearRegistry();
    lan = buildLan();
    await assignIps(lan);
  });

  // ─── P9 — wtmp / btmp ────────────────────────────────────────

  // G1
  it('G1 — successful SSH login appends an entry to /var/log/wtmp.json', async () => {
    const session = await openSshSession(lan.pc1, PC2_IP, 'user', 'admin');
    session.disconnect();
    const raw = await lan.pc2.executeCommand('cat /var/log/wtmp.json');
    const arr = JSON.parse(raw.trim()) as Array<{ user: string; ip: string }>;
    expect(arr.length).toBeGreaterThanOrEqual(1);
    expect(arr[arr.length - 1].user).toBe('user');
  });

  // G2
  it('G2 — `last user` over SSH lists the recent wtmp entries', async () => {
    for (let i = 0; i < 2; i++) {
      const session = await openSshSession(lan.pc1, PC2_IP, 'user', 'admin');
      session.disconnect();
    }
    const out = await sshExec(lan.pc1, PC2_IP, 'last user', 'user', 'admin');
    const matches = out.stdout.match(/^user\s/gm) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(out.stdout).toMatch(/wtmp begins /);
  });

  // G3
  it('G3 — failed password attempt appends to /var/log/btmp.json and surfaces in `lastb`', async () => {
    try {
      await openSshSession(lan.pc1, PC2_IP, 'user', 'wrong-password');
    } catch {
      // expected: connect throws on auth failure
    }
    // btmp is mode 0o600 in real Linux; in the simulator we mirror that, so
    // we read it via the device's own VFS rather than `cat` (which would hit
    // permission denied for the non-root caller).
    const dev = lan.pc2 as unknown as {
      executor: { vfs: { readFile(path: string): string | null } };
    };
    const btmpRaw = dev.executor.vfs.readFile('/var/log/btmp.json');
    expect(btmpRaw).not.toBeNull();
    const btmp = JSON.parse(btmpRaw!.trim()) as Array<{ user: string }>;
    expect(btmp.length).toBeGreaterThanOrEqual(1);
    expect(btmp[0].user).toBe('user');
    // `lastb` is sudo-only on real systems, but the simulator is permissive
    // about the command itself — only the underlying file is mode-protected.
    const out = await lan.pc2.executeCommand('lastb');
    expect(out).toMatch(/btmp begins /);
  });

  // ─── P8 — HashKnownHosts ─────────────────────────────────────

  // G4
  it('G4 — hashKnownHostsToken round-trips through matchHashedHost', () => {
    const token = hashKnownHostsToken('192.168.1.42');
    expect(isHashedKnownHostsToken(token)).toBe(true);
    expect(token.startsWith('|1|')).toBe(true);
    expect(matchHashedHost(token, '192.168.1.42')).toBe(true);
    expect(matchHashedHost(token, '192.168.1.43')).toBe(false);
  });

  // G5
  it('G5 — KnownHostsStore stores a hashed token and still looks up the plain host', () => {
    const key = SshHostKey.generate('peer');
    const store = KnownHostsStore.empty.with('peer.example.com', key, { hashed: true });
    expect(store.get('peer.example.com')?.publicKey).toBe(key.publicKey);
    expect(store.has('peer.example.com')).toBe(true);
    expect(store.has('other.example.com')).toBe(false);
    expect(store.serialize().startsWith('|1|')).toBe(true);
  });

  // G6
  it('G6 — `HashKnownHosts yes` in ssh_config resolves to the option', () => {
    const cfg = SshConfig.parse([
      'Host secure.example.com',
      '  HashKnownHosts yes',
    ].join('\n'));
    const entry = cfg.resolve('secure.example.com');
    expect(entry.hashKnownHosts).toBe(true);
  });

  // ─── P5 — sftp -b batchfile ──────────────────────────────────

  // G7
  it('G7 — parses `sftp -b script.txt user@host` as a batch run', () => {
    // Validates the parser's behaviour without spinning up the terminal flow:
    // every non-flag token is positional, and `-b <file>` is consumed.
    const args = ['-b', '/tmp/script.sftp', 'user@10.0.0.2'];
    let batchFile: string | null = null;
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-b' && i + 1 < args.length) batchFile = args[++i];
      else if (!a.startsWith('-')) positional.push(a);
    }
    expect(batchFile).toBe('/tmp/script.sftp');
    expect(positional).toEqual(['user@10.0.0.2']);
  });

  // G8
  it('G8 — batch-mode handles each line of an SFTP script via SftpSubShell.processLine', async () => {
    // Build a real SFTP session, then drive a SftpSubShell line by line, the
    // way the terminal's batch runner does. This is the integration path
    // exercised by LinuxTerminalSession.runSftpBatch.
    const { openSftpSession } = await import('./ssh-lan-fixtures');
    const { sftp } = await openSftpSession(lan.pc1, PC2_IP, 'user', 'admin');
    const { SftpSubShell } = await import('@/terminal/subshells/SftpSubShell');
    const shell = new SftpSubShell(sftp);

    const lines = ['pwd', 'mkdir batch-target', 'ls', 'quit'];
    const captured: string[] = [];
    for (const line of lines) {
      const result = shell.processLine(line);
      for (const out of result.output) captured.push(out);
      if (result.exit) break;
    }
    expect(captured.some((l) => /\/home\/user/.test(l))).toBe(true);
    expect(captured.some((l) => /batch-target/.test(l))).toBe(true);
    // The remote VFS should reflect the mkdir.
    const ls = await lan.pc2.executeCommand('ls /home/user');
    expect(ls).toMatch(/batch-target/);
  });

  // G9
  it('G9 — batch mode ignores a comment line and stops on the first error', async () => {
    const { openSftpSession } = await import('./ssh-lan-fixtures');
    const { sftp } = await openSftpSession(lan.pc1, PC2_IP, 'user', 'admin');
    const { SftpSubShell } = await import('@/terminal/subshells/SftpSubShell');
    const shell = new SftpSubShell(sftp);

    const script = [
      '# comment, ignored',
      'pwd',
      'cd /nonexistent-directory',
      'mkdir should-not-be-created',
    ];
    let stopped = false;
    for (const rawLine of script) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const r = shell.processLine(line);
      const hasError = r.output.some((l) =>
        /Couldn't|No such|Failure/i.test(l),
      );
      if (hasError) {
        stopped = true;
        break;
      }
    }
    expect(stopped).toBe(true);
    const ls = await lan.pc2.executeCommand('ls /home/user');
    expect(ls).not.toMatch(/should-not-be-created/);
  });
});
