/*
 * Probe - the journal files of a Linux host are real bytes in its file system, and `journalctl --verify` reads them back from there.
 * Until now the verification looked at the daemon's own objects, so no edit of /var/log/journal/<machine-id>/system.journal could ever be detected: dd, cat, cp
 * and a write through the VFS changed bytes nobody read.  The file is now the systemd 255 format (journal-file.c, byte-checked against the installed
 * systemd-journald in journal-image-oracle.test.ts) and `--verify` is the port of journal-verify.c (journal-verify-oracle.test.ts), so what a learner does to the
 * file decides what the tool says about it.
 * Measured before the change (git stash push -- src/network): the 8 cases fall (no LPKSHHRH signature in the file, an edited payload still PASSes, --file is
 * refused, no rotation of the same bytes; the untouched-file witness falls too, the stash leaving the new untracked modules half-wired to the old sources).
 */
import { describe, expect, it } from 'vitest';
import { bytesToFileText, fileTextToBytes } from '@/crypto/encoding';
import type { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';
import { LinuxServer } from '@/network/devices/LinuxServer';

interface Lab {
  readonly server: LinuxServer;
  readonly exec: LinuxCommandExecutor;
}

function lab(): Lab {
  const server = new LinuxServer('linux-server', 'journal-files');
  return { server, exec: (server as unknown as { executor: LinuxCommandExecutor }).executor };
}

function activeFile(exec: LinuxCommandExecutor): string {
  const files = exec.logMgr.journald.files().filter((file) => file.state !== 'ARCHIVED');
  return files[files.length - 1].path;
}

function bytesOf(exec: LinuxCommandExecutor, path: string): Uint8Array {
  return fileTextToBytes(exec.vfs.readFile(path) as string);
}

function overwrite(exec: LinuxCommandExecutor, path: string, bytes: Uint8Array): void {
  expect(exec.vfs.writeFile(path, bytesToFileText(bytes), 0, 4, 0o640)).toBe(true);
}

function indexOfText(bytes: Uint8Array, needle: string): number {
  return Buffer.from(bytes).indexOf(Buffer.from(needle, 'latin1'));
}

describe('journal files in the file system', () => {
  it('the active file starts with the journal signature and its header counts what journalctl --header counts', () => {
    const { exec } = lab();
    exec.execute('logger -t probe hello-bytes');
    const bytes = bytesOf(exec, activeFile(exec));
    expect(Buffer.from(bytes.subarray(0, 8)).toString('latin1')).toBe('LPKSHHRH');
    const entries = Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(152, true));
    expect(exec.execute('journalctl --header')).toContain(`Entry objects: ${entries}`);
    expect(entries).toBeGreaterThan(0);
    expect(indexOfText(bytes, 'MESSAGE=hello-bytes')).toBeGreaterThan(272);
  });

  it('witness: the untouched file passes', () => {
    const { exec } = lab();
    exec.execute('logger -t probe fine');
    const out = exec.execute('journalctl --verify');
    expect(out).toContain(`PASS: ${activeFile(exec)}`);
    expect(out).not.toContain('FAIL');
  });

  it('a payload edited in the file is reported as an invalid hash, and the entry reads back changed', () => {
    const { exec } = lab();
    exec.execute('logger -t probe tamper-me');
    const path = activeFile(exec);
    const bytes = bytesOf(exec, path);
    const at = indexOfText(bytes, 'MESSAGE=tamper-me');
    const edited = Uint8Array.from(bytes);
    edited.set(Buffer.from('tamper-XX'), at + 'MESSAGE='.length);
    overwrite(exec, path, edited);
    const out = exec.execute('journalctl --verify');
    expect(out).toContain('Invalid hash');
    expect(out).toContain(`FAIL: ${path} (Bad message)`);
    expect(exec.execute('journalctl -o cat')).toContain('tamper-XX');
    overwrite(exec, path, bytes);
    expect(exec.execute('journalctl --verify')).toContain(`PASS: ${path}`);
  });

  it('--file verifies any copy of the file, and only the copy that was edited fails', () => {
    const { exec } = lab();
    exec.execute('logger -t probe copy-me');
    const path = activeFile(exec);
    exec.execute(`cp ${path} /tmp/copy.journal`);
    expect(exec.execute('journalctl --file=/tmp/copy.journal --verify')).toContain('PASS: /tmp/copy.journal');
    const bytes = bytesOf(exec, '/tmp/copy.journal');
    const edited = Uint8Array.from(bytes);
    edited[indexOfText(bytes, 'MESSAGE=copy-me') + 12] ^= 0x20;
    overwrite(exec, '/tmp/copy.journal', edited);
    const out = exec.execute('journalctl --file=/tmp/copy.journal --verify');
    expect(out).toContain('FAIL: /tmp/copy.journal (Bad message)');
    expect(exec.execute(`journalctl --file=${path} --verify`)).toContain(`PASS: ${path}`);
  });

  it('a file that is not a journal is refused in the words of journalctl', () => {
    const { exec } = lab();
    exec.vfs.writeFile('/tmp/not-a-journal', 'x'.repeat(4096), 0, 0, 0o644);
    expect(exec.execute('journalctl --file=/tmp/not-a-journal --verify')).toContain('Failed to open files: Bad message');
    expect(exec.execute('journalctl --file=/tmp/missing --verify')).toContain('Failed to open files: No such file or directory');
  });

  it('a payload past the compression threshold is stored compressed and still verifies and reads back', () => {
    const { exec } = lab();
    const long = 'compressible '.repeat(200).trim();
    exec.execute(`logger -t probe ${long}`);
    const path = activeFile(exec);
    const bytes = bytesOf(exec, path);
    expect(indexOfText(bytes, long)).toBe(-1);
    expect(exec.execute('journalctl --verify')).toContain(`PASS: ${path}`);
    expect(exec.execute('journalctl -o cat').split(/\s+/).join(' ')).toContain(long);
  });

  it('rotation renames the file and keeps its bytes verifiable', () => {
    const { exec } = lab();
    exec.execute('logger -t probe before-rotation');
    const before = activeFile(exec);
    exec.execute('journalctl --rotate');
    const names = (exec.vfs.listDirectory(before.slice(0, before.lastIndexOf('/'))) ?? []).map((entry) => entry.name);
    expect(names.some((name) => name.startsWith('system@'))).toBe(true);
    const archived = `${before.slice(0, before.lastIndexOf('/'))}/${names.find((name) => name.startsWith('system@'))}`;
    expect(Buffer.from(bytesOf(exec, archived).subarray(0, 8)).toString('latin1')).toBe('LPKSHHRH');
    expect(bytesOf(exec, archived)[16]).toBe(2);
    const out = exec.execute('journalctl --verify');
    expect(out).toContain(`PASS: ${archived}`);
    expect(out).not.toContain('FAIL');
  });

  it('a sealed file passes with its key, and an edit of a sealed entry is caught by the tag', async () => {
    const { server, exec } = lab();
    const setup = exec.execute('sudo journalctl --setup-keys --interval=5min');
    const key = /([0-9a-f]{6}(?:-[0-9a-f]{6}){3}\/[0-9a-f]+-[0-9a-f]+)/.exec(setup)?.[1] ?? '';
    await server.executeCommand('systemctl restart systemd-journald');
    exec.execute('sudo journalctl --rotate');
    exec.execute('logger -t probe sealed-entry');
    server.advanceTime(6 * 60 * 1000);
    exec.execute('logger -t probe later-entry');
    exec.execute('sudo journalctl --rotate');
    const out = exec.execute(`sudo journalctl --verify --verify-key=${key}`);
    expect(out).not.toContain('FAIL');
    const archived = exec.logMgr.journald.files().filter((file) => file.state === 'ARCHIVED').map((file) => file.path);
    const path = archived[archived.length - 1];
    const bytes = bytesOf(exec, path);
    const edited = Uint8Array.from(bytes);
    edited[indexOfText(bytes, 'sealed-entry') + 2] ^= 0x01;
    overwrite(exec, path, edited);
    const failed = exec.execute(`sudo journalctl --verify --verify-key=${key}`);
    expect(failed).toContain(`FAIL: ${path}`);
  });
});
