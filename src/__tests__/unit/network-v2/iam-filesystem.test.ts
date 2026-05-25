/**
 * IAM filesystem coherence — unit tests.
 *
 * Verifies that account-management state stays coherent on disk:
 *   - policy / defaults config: /etc/login.defs, /etc/default/useradd,
 *     /etc/adduser.conf, the /etc/skel skeleton
 *   - the account database quartet incl. /etc/gshadow + subordinate maps
 *   - the `-` backup files left by each modification
 *   - per-user mail spools under /var/mail
 *   - /var/log/auth.log fed reactively by the IAM event stream
 */

import { describe, it, expect } from 'vitest';
import { LoginDefs } from '@/network/devices/linux/iam/fs/LoginDefs';
import { UseraddDefaults } from '@/network/devices/linux/iam/fs/UseraddDefaults';
import { IAM_PATHS } from '@/network/devices/linux/iam/fs/IamPaths';
import { LinuxUserManager } from '@/network/devices/linux/LinuxUserManager';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxServer } from '@/network/devices/LinuxServer';

// ═══════════════════════════════════════════════════════════════════
// Config models
// ═══════════════════════════════════════════════════════════════════

describe('LoginDefs', () => {
  it('renders the key shadow-suite directives', () => {
    const content = LoginDefs.defaults().render();
    expect(content).toContain('UID_MIN');
    expect(content).toContain('1000');
    expect(content).toContain('SYS_UID_MIN');
    expect(content).toContain('PASS_MAX_DAYS');
    expect(content).toContain('USERGROUPS_ENAB yes');
  });

  it('honours overridden policy values', () => {
    const defs = new LoginDefs({ uidMin: 5000, encryptMethod: 'SHA512' });
    expect(defs.uidMin).toBe(5000);
    expect(defs.render()).toContain('UID_MIN         5000');
    expect(defs.render()).toContain('ENCRYPT_METHOD  SHA512');
  });
});

describe('UseraddDefaults', () => {
  it('renders the useradd default directives', () => {
    const content = UseraddDefaults.defaults().render();
    expect(content).toContain('SHELL=/bin/sh');
    expect(content).toContain('SKEL=/etc/skel');
    expect(content).toContain('CREATE_MAIL_SPOOL=yes');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Manager ⇄ filesystem coherence
// ═══════════════════════════════════════════════════════════════════

function freshManager(): { mgr: LinuxUserManager; vfs: VirtualFileSystem } {
  const vfs = new VirtualFileSystem();
  return { mgr: new LinuxUserManager(vfs), vfs };
}

describe('IAM configuration seeding', () => {
  it('seeds /etc/login.defs at boot', () => {
    const { vfs } = freshManager();
    expect(vfs.readFile(IAM_PATHS.loginDefs)).toContain('UID_MIN');
  });

  it('seeds /etc/default/useradd at boot', () => {
    const { vfs } = freshManager();
    expect(vfs.readFile(IAM_PATHS.useraddDefaults)).toContain('SHELL=');
  });

  it('seeds /etc/adduser.conf at boot', () => {
    const { vfs } = freshManager();
    expect(vfs.readFile(IAM_PATHS.adduserConf)).toContain('DSHELL=');
  });

  it('seeds the /etc/skel skeleton directory', () => {
    const { vfs } = freshManager();
    expect(vfs.readFile('/etc/skel/.bashrc')).toContain('HISTSIZE');
    expect(vfs.readFile('/etc/skel/.profile')).toContain('BASH_VERSION');
  });

  it('exposes the policy as a read-back model driving UID allocation', () => {
    const { mgr } = freshManager();
    expect(mgr.getLoginDefs().uidMin).toBe(1000);
    mgr.useradd('alice', {});
    expect(mgr.getAccount('alice')!.uid).toBe(1000);
  });
});

describe('account database projection', () => {
  it('writes /etc/gshadow alongside passwd/shadow/group', () => {
    const { mgr, vfs } = freshManager();
    mgr.useradd('bob', {});
    const gshadow = vfs.readFile(IAM_PATHS.gshadow);
    expect(gshadow).toContain('bob:');
    expect(gshadow).toContain('root:');
  });

  it('writes /etc/subuid & /etc/subgid for regular users', () => {
    const { mgr, vfs } = freshManager();
    mgr.useradd('alice', {});
    expect(vfs.readFile(IAM_PATHS.subuid)).toContain('alice:100000:65536');
    expect(vfs.readFile(IAM_PATHS.subgid)).toContain('alice:100000:65536');
  });

  it('excludes system accounts from the subordinate-id maps', () => {
    const { mgr, vfs } = freshManager();
    mgr.useradd('svc', { r: true });
    expect(vfs.readFile(IAM_PATHS.subuid) ?? '').not.toContain('svc:');
  });

  it('keeps a /etc/passwd- backup of the previous state', () => {
    const { mgr, vfs } = freshManager();
    mgr.useradd('bob', {});
    const backup = vfs.readFile(IAM_PATHS.passwdBackup);
    expect(backup).toContain('root:');
    expect(backup).not.toContain('bob:');
  });
});

describe('mail spool coherence', () => {
  it('creates /var/mail/<user> on account creation', () => {
    const { mgr, vfs } = freshManager();
    mgr.useradd('bob', {});
    expect(vfs.exists(`${IAM_PATHS.mailSpoolDir}/bob`)).toBe(true);
  });

  it('does not create a mailbox for a system account', () => {
    const { mgr, vfs } = freshManager();
    mgr.useradd('svc', { r: true });
    expect(vfs.exists(`${IAM_PATHS.mailSpoolDir}/svc`)).toBe(false);
  });

  it('removes the mailbox on userdel', () => {
    const { mgr, vfs } = freshManager();
    mgr.useradd('bob', {});
    mgr.userdel('bob', false);
    expect(vfs.exists(`${IAM_PATHS.mailSpoolDir}/bob`)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Reactive auth.log projection (executor-level)
// ═══════════════════════════════════════════════════════════════════

describe('/var/log/auth.log coherence', () => {
  // The boot sequence auto-provisions alice/bob/carl/dave, so tests
  // that exercise creation events must pick a fresh name.
  it('records a useradd entry when an account is created', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('adduser zoe');
    const authLog = await srv.executeCommand('cat /var/log/auth.log');
    expect(authLog).toContain('new user: name=zoe');
  });

  it('records a userdel entry when an account is removed', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('adduser zoe');
    await srv.executeCommand('deluser zoe');
    const authLog = await srv.executeCommand('cat /var/log/auth.log');
    expect(authLog).toContain("delete user 'zoe'");
  });

  it('records a group membership change', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    await srv.executeCommand('adduser zoe');
    await srv.executeCommand('adduser zoe sudo');
    const authLog = await srv.executeCommand('cat /var/log/auth.log');
    expect(authLog).toContain("'zoe' to group 'sudo'");
  });
});
