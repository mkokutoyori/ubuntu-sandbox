/**
 * F7.3 / F7.4 — deleting the account database must break identity, for real.
 *
 * The two files fail DIFFERENTLY, and telling them apart is the whole
 * diagnostic skill this scenario teaches (docs/PRD-Pannes.md §F7.3, §F7.4):
 *
 *   - `/etc/passwd` gone → nothing can be NAMED. `id` prints bare numbers,
 *     `whoami` cannot answer at all, `ls -l` shows numeric owners.
 *   - `/etc/shadow` gone → everything is still named, but no password can
 *     ever be verified. SSH by key keeps working; SSH by password dies.
 *
 * An operator who cannot tell those two apart repairs neither.
 *
 * Nothing here is special-cased on "the file is missing". The account
 * database is genuinely read back from the files
 * (`iam/fs/AccountDatabaseParser.ts`), so a deleted file simply parses to
 * nothing — which is what NSS does with no source to answer from — and a
 * restored file rebuilds the accounts for real. See
 * `account-database-is-file-backed.test.ts` for the round-trip itself.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const MASK = new SubnetMask('255.255.255.0');

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

function pc(): LinuxPC {
  return new LinuxPC('linux-pc', 'PC1');
}

const run = (d: LinuxPC | LinuxServer, cmd: string) => d.executeCommand(cmd);

describe('F7.3 — /etc/passwd deleted', () => {
  it('nominal: identities resolve to names', async () => {
    const d = pc();
    expect(await run(d, 'id')).toContain('(user)');
    expect(await run(d, 'whoami')).toContain('user');
  });

  it('`id` falls back to bare numbers — the signature symptom', async () => {
    const d = pc();
    await run(d, 'sudo rm /etc/passwd');

    // The kernel still knows which ids the process runs as; only the
    // name lookup is gone, so the numbers survive and the names do not.
    const out = await run(d, 'id');
    expect(out).toMatch(/uid=1000\b/);
    expect(out).not.toContain('(user)');
  });

  it('`whoami` reports it cannot name the uid, rather than inventing one', async () => {
    const d = pc();
    await run(d, 'sudo rm /etc/passwd');

    expect(await run(d, 'whoami')).toBe('whoami: cannot find name for user ID 1000');
  });

  it('`ls -l` shows a numeric owner', async () => {
    const d = pc();
    expect(await run(d, 'ls -l /etc/hostname')).toContain('root');

    await run(d, 'sudo rm /etc/passwd');

    const out = await run(d, 'ls -l /etc/hostname');
    expect(out).toMatch(/\s0\s/);
  });

  it('`getent passwd` no longer enumerates the accounts', async () => {
    const d = pc();
    expect(await run(d, 'getent passwd user')).toContain('user');

    await run(d, 'sudo rm /etc/passwd');

    expect(await run(d, 'getent passwd user')).not.toContain('user:');
  });

  it('but root and nobody survive — nss-systemd synthesises them', async () => {
    const d = pc();
    await run(d, 'sudo rm /etc/passwd');

    // Real nss-systemd(8) answers for root and nobody without any file,
    // precisely so a broken /etc/passwd does not make the box unbootable.
    // Losing this would be a bug, not extra breakage.
    expect(await run(d, 'getent passwd root')).toContain('root:x:0:0:');
    expect(await run(d, 'getent passwd nobody')).toContain('nobody');
  });

  it('the file the shadow tools keep as a backup is really there', async () => {
    const d = pc();

    // `useradd`/`passwd` maintain `/etc/passwd-` on every write. It is the
    // documented way back, so it has to exist before the incident, not be
    // conjured during the repair.
    expect(await run(d, 'ls -l /etc/passwd-')).toContain('/etc/passwd-');
  });

  it('restoring from /etc/passwd- brings names back, with no residue', async () => {
    const d = pc();
    await run(d, 'sudo rm /etc/passwd');
    expect(await run(d, 'id')).not.toContain('(user)');

    // sudo is gone with it (it cannot resolve the invoking user any more),
    // which is exactly why this repair is a root-shell job.
    const vfs = (d as unknown as {
      executor: { vfs: { readFile(p: string): string | null; writeFile(p: string, c: string, u: number, g: number, m: number): unknown } };
    }).executor.vfs;
    vfs.writeFile('/etc/passwd', vfs.readFile('/etc/passwd-') ?? '', 0, 0, 0o022);

    expect(await run(d, 'id')).toContain('(user)');
    expect(await run(d, 'whoami')).toBe('user');
    expect(await run(d, 'ls -l /etc/hostname')).toContain('root');
  });
});

describe('F7.4 — /etc/shadow deleted', () => {
  interface Lab { cli: LinuxPC; srv: LinuxServer }

  async function lab(): Promise<Lab> {
    const cli = new LinuxPC('linux-pc', 'CLI');
    const srv = new LinuxServer('linux-server', 'SRV');
    cli.configureInterface('eth0', new IPAddress('10.2.0.1'), MASK);
    srv.configureInterface('eth0', new IPAddress('10.2.0.2'), MASK);
    new Cable('c1').connect(cli.getPort('eth0')!, srv.getPort('eth0')!);
    await run(srv, 'useradd -m alice');
    await run(srv, 'sh -c "echo \'alice:secret\' | chpasswd"');
    return { cli, srv };
  }

  /** Publish CLI's public key into alice's authorized_keys on SRV. */
  async function trustKey({ cli, srv }: Lab): Promise<void> {
    await run(cli, "ssh-keygen -t ed25519 -N '' -f /root/.ssh/id_ed25519");
    const pub = (await run(cli, 'cat /root/.ssh/id_ed25519.pub')).trim();
    await run(srv, 'mkdir -p /home/alice/.ssh');
    await run(srv, `sh -c "echo '${pub}' > /home/alice/.ssh/authorized_keys"`);
    await run(srv, 'chown -R alice:alice /home/alice/.ssh');
    await run(srv, 'chmod 700 /home/alice/.ssh');
    await run(srv, 'chmod 600 /home/alice/.ssh/authorized_keys');
  }

  it('nominal: a password login works', async () => {
    const l = await lab();
    expect(await run(l.cli, 'sshpass -p secret ssh alice@10.2.0.2 whoami')).toContain('alice');
  });

  it('password authentication dies — there is nothing left to compare against', async () => {
    const l = await lab();
    await run(l.srv, 'rm /etc/shadow');

    // No key is installed in this lab, so the client has only the password
    // to offer — which is the point: the offer is refused.
    expect(await run(l.cli, 'sshpass -p secret ssh alice@10.2.0.2 whoami'))
      .toContain('Permission denied');
  });

  it('but public-key authentication keeps working — it never reads shadow', async () => {
    const l = await lab();
    await trustKey(l);
    expect(await run(l.cli, 'ssh alice@10.2.0.2 whoami')).toContain('alice');

    await run(l.srv, 'rm /etc/shadow');

    // This dissociation is the whole lesson: the account is intact, the
    // key path is intact, only the password path is gone.
    expect(await run(l.cli, 'ssh alice@10.2.0.2 whoami')).toContain('alice');
  });

  it('identities still resolve — only verification is lost', async () => {
    const l = await lab();
    await run(l.srv, 'rm /etc/shadow');

    // /etc/passwd is untouched, so naming keeps working. Confusing this
    // with F7.3 sends the operator after the wrong file.
    expect(await run(l.srv, 'id alice')).toContain('(alice)');
    expect(await run(l.srv, 'getent passwd alice')).toContain('alice');
  });

  it('restoring from /etc/shadow- brings password login back', async () => {
    const l = await lab();
    await run(l.srv, 'rm /etc/shadow');
    expect(await run(l.cli, 'sshpass -p secret ssh alice@10.2.0.2 whoami'))
      .toContain('Permission denied');

    await run(l.srv, 'cp /etc/shadow- /etc/shadow');

    expect(await run(l.cli, 'sshpass -p secret ssh alice@10.2.0.2 whoami')).toContain('alice');
  });
});
