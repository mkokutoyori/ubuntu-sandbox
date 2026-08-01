/**
 * The two halves of "the files are the account database" that a reverse
 * parser alone does not give you.
 *
 * 1. **Allocation reads the database, not a counter.** `useradd` picks a
 *    new id by scanning what is actually in `/etc/passwd` right now
 *    (shadow-utils' `find_new_uid()`), so an id an operator added or freed
 *    by editing the file is visible to the very next `useradd`. A stored
 *    cursor that only moved forward could not see either, and would
 *    eventually hand out an id already present in the file.
 *
 * 2. **`/etc/nsswitch.conf` governs this manager too.** nsswitch decides
 *    which sources answer a lookup for the whole C library — `id`, `su`,
 *    every permission check — not just `getent`. Dropping `files` from the
 *    `passwd:` line makes the accounts stop resolving with the file
 *    perfectly intact, which is precisely the confusing failure that line
 *    exists to cause.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

async function box(): Promise<LinuxPC> {
  const d = new LinuxPC('linux-pc', 'PC1');
  await d.executeCommand('sudo su -');
  return d;
}

const run = (d: LinuxPC, cmd: string) => d.executeCommand(cmd);
const uidOf = (out: string): number => Number(/uid=(\d+)/.exec(out)?.[1] ?? -1);

describe('id allocation reads the live database', () => {
  it('a uid added to /etc/passwd by hand pushes the next allocation past it', async () => {
    const d = await box();
    await run(d, `sh -c "echo 'zoe:x:2000:2000:Zoe:/home/zoe:/bin/bash' >> /etc/passwd"`);

    await run(d, 'useradd -m nouveau');

    // A forward-only counter would still be sitting just above the accounts
    // it created itself, and would hand out a uid well below 2000.
    expect(uidOf(await run(d, 'id nouveau'))).toBe(2001);
  });

  it('never re-issues a uid that is already in the file', async () => {
    const d = await box();
    await run(d, `sh -c "echo 'zoe:x:2000:2000:Zoe:/home/zoe:/bin/bash' >> /etc/passwd"`);
    await run(d, 'useradd -m nouveau');

    const taken = new Set(
      (await run(d, 'cat /etc/passwd')).split('\n')
        .map((l) => l.split(':')[2]).filter(Boolean),
    );
    // Every uid appears once: the collision a stale cursor would cause is
    // the one failure that silently gives two accounts the same identity.
    expect(taken.size).toBe(
      (await run(d, 'cat /etc/passwd')).split('\n').filter((l) => l.trim()).length,
    );
  });

  it('a hole left in the middle of the range is NOT filled', async () => {
    const d = await box();
    const bobUid = uidOf(await run(d, 'id bob'));
    const daveUid = uidOf(await run(d, 'id dave'));
    expect(daveUid).toBeGreaterThan(bobUid);

    // Remove a user from the MIDDLE of the range, leaving a gap.
    await run(d, `sed -i '/^bob:/d' /etc/passwd`);
    await run(d, 'useradd -m nouveau');

    // shadow-utils takes "highest used + 1" and only falls back to filling
    // holes once the range is exhausted. Recycling ids eagerly would let a
    // new account inherit a departed user's files.
    expect(uidOf(await run(d, 'id nouveau'))).toBe(daveUid + 1);
  });

  it('but deleting the HIGHEST account does free its id for the next one', async () => {
    const d = await box();
    const daveUid = uidOf(await run(d, 'id dave'));
    await run(d, `sed -i '/^dave:/d' /etc/passwd`);

    await run(d, 'useradd -m nouveau');

    // Not a contradiction with the case above: "highest used + 1" simply
    // moves down when the highest goes away. Real useradd does exactly
    // this, and it is why `userdel` of the last account then `useradd`
    // hands the same uid straight back.
    expect(uidOf(await run(d, 'id nouveau'))).toBe(daveUid);
  });

  it('an explicit -u is still honoured, and still checked for uniqueness', async () => {
    const d = await box();
    await run(d, 'useradd -m -u 3000 explicite');
    expect(uidOf(await run(d, 'id explicite'))).toBe(3000);

    expect(await run(d, 'useradd -m -u 3000 doublon')).toContain('not unique');
  });

  it('groupadd allocates from the live group file too', async () => {
    const d = await box();
    await run(d, `sh -c "echo 'projet:x:2500:' >> /etc/group"`);

    await run(d, 'groupadd equipe');

    const line = await run(d, 'getent group equipe');
    expect(Number(line.split(':')[2])).toBe(2501);
  });

  it('a system account (`useradd -r`) allocates DOWNWARD from SYS_UID_MAX', async () => {
    const d = await box();

    await run(d, 'useradd -r svcA');
    await run(d, 'useradd -r svcB');

    // Debian's SYS_UID_MAX is 999, and daemons really do get 999, 998, 997…
    expect(uidOf(await run(d, 'id svcA'))).toBe(999);
    expect(uidOf(await run(d, 'id svcB'))).toBe(998);
  });

  it('the two ranges grow APART, so filling one never eats the other', async () => {
    const d = await box();
    await run(d, 'useradd -r service');
    await run(d, 'useradd -m humain');

    // System ids come down from 999, regular ids climb from 1000. Had both
    // grown upward they would meet at the boundary as soon as either range
    // filled up — which is exactly why the real allocator uses opposite
    // directions.
    expect(uidOf(await run(d, 'id service'))).toBeLessThan(1000);
    expect(uidOf(await run(d, 'id humain'))).toBeGreaterThanOrEqual(1000);
  });

  it('a name added by hand is refused as a duplicate by useradd', async () => {
    const d = await box();
    await run(d, `sh -c "echo 'zoe:x:2000:2000:Zoe:/home/zoe:/bin/bash' >> /etc/passwd"`);

    expect(await run(d, 'useradd -m zoe')).toContain('already exists');
  });
});

describe('/etc/nsswitch.conf governs the account model', () => {
  it('nominal: with `files` listed, accounts resolve', async () => {
    const d = await box();
    expect(await run(d, 'id bob')).toContain('(bob)');
  });

  it('dropping `files` from `passwd:` stops accounts resolving', async () => {
    const d = await box();

    await run(d, `sed -i 's|^passwd:.*|passwd:         systemd|' /etc/nsswitch.conf`);

    expect(await run(d, 'id bob')).toContain('no such user');
  });

  it('and the file is untouched — that is what makes it confusing', async () => {
    const d = await box();
    await run(d, `sed -i 's|^passwd:.*|passwd:         systemd|' /etc/nsswitch.conf`);

    // The operator stares at a perfectly good /etc/passwd while nothing
    // resolves. Looking at the file is the wrong move; reading nsswitch is
    // the right one.
    expect((await run(d, 'grep -c "^bob:" /etc/passwd')).trim()).toBe('1');
  });

  it('restoring the line brings every account back', async () => {
    const d = await box();
    await run(d, `sed -i 's|^passwd:.*|passwd:         systemd|' /etc/nsswitch.conf`);
    expect(await run(d, 'id bob')).toContain('no such user');

    await run(d, `sed -i 's|^passwd:.*|passwd:         files systemd|' /etc/nsswitch.conf`);

    expect(await run(d, 'id bob')).toContain('(bob)');
  });

  it('`compat` counts as files — it is the historical spelling', async () => {
    const d = await box();

    await run(d, `sed -i 's|^passwd:.*|passwd:         compat|' /etc/nsswitch.conf`);

    expect(await run(d, 'id bob')).toContain('(bob)');
  });

  it('dropping `group:` loses the memberships but keeps the identities', async () => {
    const d = await box();

    await run(d, `sed -i 's|^group:.*|group:          systemd|' /etc/nsswitch.conf`);

    // The two databases are independent lines, and switching one off must
    // not switch off the other.
    expect(await run(d, 'id bob')).toContain('uid=');
    expect(await run(d, 'getent group sudo')).not.toContain('sudo:');
  });

  it('`systemd` still answers for root and nobody when `files` is gone', async () => {
    const d = await box();

    await run(d, `sed -i 's|^passwd:.*|passwd:         systemd|' /etc/nsswitch.conf`);

    // glibc does not stop at the first source, and nss-systemd(8) exists
    // precisely so these two survive a corrupt or missing /etc/passwd.
    // Honouring only the `files` entry left the machine with no root at all.
    expect(await run(d, 'id root')).toContain('uid=0(root)');
    expect(await run(d, 'id nobody')).toContain('65534');
  });

  it('but the synthesised root carries no password', async () => {
    const d = await box();
    await run(d, `sed -i 's|^passwd:.*|passwd:         systemd|' /etc/nsswitch.conf`);

    const mgr = (d as unknown as {
      executor: { userMgr: { checkPassword(u: string, p: string): boolean } };
    }).executor.userMgr;
    // Resolving a name and authenticating it are different questions: the
    // synthetic record makes the box usable, not open.
    expect(mgr.checkPassword('root', 'admin')).toBe(false);
  });

  it('the file wins over the synthetic record when both could answer', async () => {
    const d = await box();

    // Default chain is `files systemd`, and root is in /etc/passwd, so the
    // real entry (home /root, shell /bin/bash) must be the one that shows —
    // nss-systemd only synthesises what is not defined by other means.
    expect(await run(d, 'getent passwd root')).toContain('/bin/bash');
  });

  it('the chain applies to `group:` as well', async () => {
    const d = await box();

    await run(d, `sed -i 's|^group:.*|group:          systemd|' /etc/nsswitch.conf`);

    expect(await run(d, 'getent group root')).toContain('root:x:0:');
    expect(await run(d, 'getent group sudo')).not.toContain('sudo:');
  });

  it('an absent nsswitch.conf falls back to the built-in default', async () => {
    const d = await box();

    await run(d, 'rm /etc/nsswitch.conf');

    // glibc has `passwd: files` compiled in; a missing file is not a
    // machine with no name resolution.
    expect(await run(d, 'id bob')).toContain('(bob)');
  });
});
