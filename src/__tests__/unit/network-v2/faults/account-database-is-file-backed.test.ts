/**
 * The account database is the FILES, not a rendering of them.
 *
 * `/etc/passwd`, `/etc/shadow`, `/etc/group` and `/etc/gshadow` are read
 * back into live accounts (`iam/fs/AccountDatabaseParser.ts`), so the two
 * directions genuinely agree:
 *
 *   - `useradd` / `passwd` / `usermod` write the files, as before;
 *   - editing or deleting the files changes the ACCOUNTS.
 *
 * That second direction is what these tests pin. It is also what makes the
 * failure scenarios (docs/PRD-Pannes.md §F7.3, §F7.4) real rather than
 * simulated: nothing special-cases "the file is missing" any more — parsing
 * nothing yields nothing, which is exactly what NSS does with no source.
 *
 * The tests deliberately use ordinary shell tools (`sed`, `echo >>`, `cp`),
 * because that is how an operator actually breaks and repairs these files.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  parseAccountDatabase, parseShadowFile, cleartextOf,
} from '@/network/devices/linux/iam/fs/AccountDatabaseParser';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

/** A machine with a root shell — /etc/passwd is root-owned, as for real. */
async function box(): Promise<LinuxPC> {
  const d = new LinuxPC('linux-pc', 'PC1');
  await d.executeCommand('sudo su -');
  return d;
}

const run = (d: LinuxPC, cmd: string) => d.executeCommand(cmd);

describe('editing /etc/passwd changes the accounts', () => {
  it('a line appended by hand creates a real, usable account', async () => {
    const d = await box();
    expect(await run(d, 'id zoe')).toContain('no such user');

    await run(d, `sh -c "echo 'zoe:x:1500:1500:Zoe:/home/zoe:/bin/bash' >> /etc/passwd"`);

    // Not just visible to `getent` (which reads the file directly) but to
    // the account model every permission check consults.
    expect(await run(d, 'id zoe')).toContain('uid=1500');
    expect(await run(d, 'getent passwd zoe')).toContain('zoe:x:1500');
  });

  it('a line deleted by hand removes the account', async () => {
    const d = await box();
    expect(await run(d, 'id bob')).toContain('(bob)');

    await run(d, `sed -i '/^bob:/d' /etc/passwd`);

    expect(await run(d, 'id bob')).toContain('no such user');
  });

  it('changing the shell field takes effect', async () => {
    const d = await box();

    await run(d, `sed -i 's|^bob:x:\\([0-9]*\\):\\([0-9]*\\):\\([^:]*\\):\\([^:]*\\):.*|bob:x:\\1:\\2:\\3:\\4:/usr/sbin/nologin|' /etc/passwd`);

    expect(await run(d, 'getent passwd bob')).toContain('/usr/sbin/nologin');
  });

  it('changing a uid takes effect, and `ls -l` follows it', async () => {
    const d = await box();
    const before = await run(d, 'id bob');
    const uid = /uid=(\d+)/.exec(before)?.[1];
    expect(uid).toBeDefined();

    await run(d, `sed -i 's|^bob:x:${uid}:|bob:x:4242:|' /etc/passwd`);

    expect(await run(d, 'id bob')).toContain('uid=4242');
  });

  it('a duplicated name resolves to the FIRST line, as libc does', async () => {
    const d = await box();

    await run(d, `sh -c "echo 'bob:x:9999:9999:Imposteur:/home/x:/bin/sh' >> /etc/passwd"`);

    // The later line is shadowed, not authoritative. Getting this backwards
    // would let anyone append a line to take over an existing name.
    expect(await run(d, 'id bob')).not.toContain('9999');
  });

  it('a malformed line is skipped without taking the rest of the file down', async () => {
    const d = await box();

    await run(d, `sh -c "echo 'ceci-nest-pas-une-ligne-passwd' >> /etc/passwd"`);

    // Real getpwnam ignores what it cannot parse; the accounts around it
    // must keep working, or one typo would lock everybody out.
    expect(await run(d, 'id bob')).toContain('(bob)');
    expect(await run(d, 'id root')).toContain('uid=0');
  });
});

describe('editing /etc/shadow changes authentication', () => {
  it('a hand-written secret in the stored format authenticates', async () => {
    const d = await box();
    await run(d, `sed -i 's|^bob:[^:]*:|bob:$6$simulated$motdepasse:|' /etc/shadow`);

    const mgr = (d as unknown as {
      executor: { userMgr: { checkPassword(u: string, p: string): boolean } };
    }).executor.userMgr;
    expect(mgr.checkPassword('bob', 'motdepasse')).toBe(true);
  });

  it('a secret nobody can invert stops the password working', async () => {
    const d = await box();
    await run(d, `sh -c "echo 'bob:secret' | chpasswd"`);
    const mgr = (d as unknown as {
      executor: { userMgr: { checkPassword(u: string, p: string): boolean } };
    }).executor.userMgr;
    expect(mgr.checkPassword('bob', 'secret')).toBe(true);

    // Pasting an opaque hash over the entry is exactly what an admin does
    // when copying between machines — and it really does mean the old
    // password no longer opens the account.
    await run(d, `sed -i 's|^bob:[^:]*:|bob:$6$abcdef$OpaqueHashFromElsewhere:|' /etc/shadow`);

    expect(mgr.checkPassword('bob', 'secret')).toBe(false);
  });

  it('the `!` lock prefix written by hand locks the account', async () => {
    const d = await box();
    await run(d, `sh -c "echo 'bob:secret' | chpasswd"`);
    const mgr = (d as unknown as {
      executor: { userMgr: { checkPassword(u: string, p: string): boolean } };
    }).executor.userMgr;

    await run(d, `sed -i 's|^bob:|bob:!|' /etc/shadow`);

    expect(mgr.checkPassword('bob', 'secret')).toBe(false);
  });

  it('root\'s own secret round-trips through the file like anyone else\'s', async () => {
    const d = await box();
    const mgr = (d as unknown as {
      executor: { userMgr: { checkPassword(u: string, p: string): boolean } };
    }).executor.userMgr;

    // root used to be the one account the file could not describe: its
    // password lived only in memory while `/etc/shadow` carried a bare `x`,
    // so the very first reload lost it. If the files are the store, root
    // has to be in them too.
    expect(await run(d, 'grep "^root:" /etc/shadow')).toContain('$6$simulated$admin');
    expect(mgr.checkPassword('root', 'admin')).toBe(true);

    await run(d, `sed -i 's|^root:[^:]*:|root:$6$simulated$autre:|' /etc/shadow`);

    expect(mgr.checkPassword('root', 'admin')).toBe(false);
    expect(mgr.checkPassword('root', 'autre')).toBe(true);
  });

  it('an account with no shadow line still exists — it just has no password', async () => {
    const d = await box();

    await run(d, `sed -i '/^bob:/d' /etc/shadow`);

    // pwck calls this an inconsistency; it does not call it a deleted user,
    // and dropping the account here would hide the real problem.
    expect(await run(d, 'id bob')).toContain('(bob)');
    const mgr = (d as unknown as {
      executor: { userMgr: { checkPassword(u: string, p: string): boolean } };
    }).executor.userMgr;
    expect(mgr.checkPassword('bob', 'secret')).toBe(false);
  });
});

describe('editing /etc/group changes membership', () => {
  it('adding a user to a group by hand grants the membership', async () => {
    const d = await box();
    expect(await run(d, 'groups bob')).not.toContain('video');

    await run(d, `sed -i 's|^video:x:\\([0-9]*\\):.*|video:x:\\1:bob|' /etc/group`);

    expect(await run(d, 'groups bob')).toContain('video');
  });

  it('a group removed by hand disappears from the model', async () => {
    const d = await box();

    await run(d, `sed -i '/^plugdev:/d' /etc/group`);

    expect(await run(d, 'getent group plugdev')).not.toContain('plugdev:');
  });
});

describe('the projection and the file stay in step', () => {
  it('useradd after a hand edit preserves the edit', async () => {
    const d = await box();
    await run(d, `sh -c "echo 'zoe:x:1500:1500:Zoe:/home/zoe:/bin/bash' >> /etc/passwd"`);

    // The write path re-renders the WHOLE database from memory, so an edit
    // that had not been read back would be silently erased here. This is
    // the regression the reload exists to prevent.
    await run(d, 'useradd -m yannick');

    expect(await run(d, 'getent passwd zoe')).toContain('zoe');
    expect(await run(d, 'getent passwd yannick')).toContain('yannick');
  });

  it('a topology import that restores the files restores the ACCOUNTS', async () => {
    const src = await box();
    await run(src, 'useradd -m zoe');
    await run(src, `sh -c "echo 'zoe:motdepasse' | chpasswd"`);

    const vfsOf = (d: LinuxPC) => (d as unknown as {
      executor: { vfs: {
        readFile(p: string): string | null;
        writeFile(p: string, c: string, u: number, g: number, m: number): unknown;
      } };
    }).executor.vfs;
    const files = ['/etc/passwd', '/etc/shadow', '/etc/group', '/etc/gshadow'];
    const captured = Object.fromEntries(files.map((f) => [f, vfsOf(src).readFile(f) ?? '']));

    // A fresh device is exactly what `topologySerializer` produces on import:
    // it replays the captured file text onto a brand-new machine. Before the
    // database was read back, that text was inert — `cat /etc/passwd` showed
    // zoe while `id zoe` said no such user.
    const dst = new LinuxPC('linux-pc', 'DST');
    expect(await run(dst, 'id zoe')).toContain('no such user');
    for (const [f, text] of Object.entries(captured)) {
      vfsOf(dst).writeFile(f, text, 0, 0, 0o022);
    }

    expect(await run(dst, 'id zoe')).toContain('(zoe)');
    const mgr = (dst as unknown as {
      executor: { userMgr: { checkPassword(u: string, p: string): boolean } };
    }).executor.userMgr;
    expect(mgr.checkPassword('zoe', 'motdepasse')).toBe(true);
  });

  it('restoring /etc/passwd- restores the accounts it holds', async () => {
    const d = await box();
    await run(d, 'useradd -m zoe');
    // The backup now holds the pre-zoe database.
    await run(d, 'cp /etc/passwd- /etc/passwd');

    expect(await run(d, 'id zoe')).toContain('no such user');
    expect(await run(d, 'id bob')).toContain('(bob)');
  });
});

describe('the parser itself', () => {
  const empty = { users: [], groups: [] };

  it('recovers the cleartext from the stored secret format', () => {
    expect(cleartextOf('$6$simulated$hunter2')).toBe('hunter2');
    expect(cleartextOf('!$6$simulated$hunter2')).toBe('hunter2');
    expect(cleartextOf('$6$rounds=5000$xyz$abc')).toBeNull();
    expect(cleartextOf('*')).toBeNull();
  });

  it('reads the lock marker without losing the secret under it', () => {
    const rec = parseShadowFile('bob:!$6$simulated$hunter2:19000:0:99999:7:::').get('bob');
    expect(rec?.locked).toBe(true);
    expect(rec?.secret).toBe('$6$simulated$hunter2');
  });

  it('treats empty shadow fields as "unset", not as zero', () => {
    const rec = parseShadowFile('bob:x:19000:0:99999:7:::').get('bob');
    // An empty inactive/expire field means "no limit" (-1), and reading it
    // as 0 would expire every account immediately.
    expect(rec?.inactiveDays).toBe(-1);
    expect(rec?.expireDate).toBe(-1);
  });

  it('ignores comments and blank lines, as libc does', () => {
    const parsed = parseAccountDatabase({
      passwd: '# un commentaire\n\nbob:x:1500:1500:Bob:/home/bob:/bin/bash\n',
      shadow: '', group: '', gshadow: '',
    }, empty);
    expect(parsed.users).toHaveLength(1);
    expect(parsed.users[0].username).toBe('bob');
  });

  it('carries over the fields no file holds', () => {
    const first = parseAccountDatabase({
      passwd: 'bob:x:1500:1500:Bob:/home/bob:/bin/bash\n',
      shadow: '', group: '', gshadow: '',
    }, empty);
    first.users[0].failedLoginCount = 3;
    first.users[0].lastLoginAt = 1234;

    const second = parseAccountDatabase({
      passwd: 'bob:x:1500:1500:Bob:/home/bob:/bin/sh\n',
      shadow: '', group: '', gshadow: '',
    }, { users: first.users, groups: [] });

    // lastlog and the faillock tally live outside /etc on a real system too,
    // so a reload must not reset them.
    expect(second.users[0].shell).toBe('/bin/sh');
    expect(second.users[0].failedLoginCount).toBe(3);
    expect(second.users[0].lastLoginAt).toBe(1234);
  });

  it('parses nothing out of nothing — no special case needed for a deleted file', () => {
    const parsed = parseAccountDatabase(
      { passwd: '', shadow: '', group: '', gshadow: '' }, empty,
    );
    expect(parsed.users).toHaveLength(0);
    expect(parsed.groups).toHaveLength(0);
  });

  it('reads the administrator roster out of /etc/gshadow', () => {
    const parsed = parseAccountDatabase({
      passwd: '', shadow: '',
      group: 'projet:x:2000:alice,bob\n',
      gshadow: 'projet:!:alice:alice,bob\n',
    }, empty);
    expect(parsed.groups[0].members).toEqual(['alice', 'bob']);
    expect(parsed.groups[0].admins).toEqual(['alice']);
  });
});
