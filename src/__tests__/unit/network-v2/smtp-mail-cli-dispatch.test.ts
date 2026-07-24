import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

let exec: LinuxCommandExecutor;
beforeEach(() => {
  exec = new LinuxCommandExecutor(false);
  exec.userMgr.useradd('walter', { u: 2001, m: true });
});

describe('mail/mailx/sendmail CLI dispatch (objective 14, P19)', () => {
  it('mail -s "subject" recipient delivers piped stdin to the local mailbox', () => {
    const out = exec.execute('echo hello walter | mail -s "hi there" walter');
    expect(out).toBe('');
    const mailbox = exec.vfs.readFile('/var/mail/walter');
    expect(mailbox).toContain('Subject: hi there');
    expect(mailbox).toContain('hello walter');
  });

  it('mailx is an alias for mail', () => {
    exec.execute('echo test body | mailx -s subj walter');
    expect(exec.vfs.readFile('/var/mail/walter')).toContain('test body');
  });

  it('sendmail delivers piped stdin the same way', () => {
    exec.execute('echo sm body | sendmail walter');
    expect(exec.vfs.readFile('/var/mail/walter')).toContain('sm body');
  });

  it('mail with no recipients and an empty mailbox reports no mail', () => {
    expect(exec.execute('mail')).toBe('No mail for user');
  });

  it('mail with no recipients reads the current user mailbox summary', () => {
    exec.userMgr.currentUser = 'walter';
    const walter = exec.userMgr.getUser('walter')!;
    exec.vfs.writeFile(
      '/var/mail/walter',
      'From alice@localhost Mon Jan 1\r\nSubject: greetings\r\n\r\nhi\r\n',
      walter.uid, walter.gid, 0o022,
    );
    const out = exec.execute('mail');
    expect(out).toContain('1 message');
    expect(out).toContain('"greetings"');
  });

  it('delivers to multiple recipients in one call', () => {
    exec.userMgr.useradd('carol', { u: 2002, m: true });
    exec.execute('echo team update | mail -s update walter carol');
    expect(exec.vfs.readFile('/var/mail/walter')).toContain('team update');
    expect(exec.vfs.readFile('/var/mail/carol')).toContain('team update');
  });

  it('a non-local recipient (foreign domain) is not written to the local mailbox', () => {
    exec.execute('echo far away | mail -s hi walter@remote.example');
    expect(exec.vfs.readFile('/var/mail/walter')).not.toContain('far away');
  });
});
