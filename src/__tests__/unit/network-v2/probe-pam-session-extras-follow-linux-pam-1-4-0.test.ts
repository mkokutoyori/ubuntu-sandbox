/**
 * Sonde — pam_keyinit, pam_mail, pam_motd et pam_selinux (SELinux absent) portes depuis
 * Linux-PAM 1.4.0 (modules/pam_keyinit, pam_mail, pam_motd, pam_selinux) ; la table des
 * trousseaux du noyau (KeyringTable, /proc/keys) que pam_keyinit pilote.
 *
 * Mesure de depart : aucun de ces modules n'existait, et la machine n'avait ni trousseau de
 * session ni /proc/keys : chaque cas tombait sur « module inconnu ». Les piles Ubuntu semees
 * (sshd, login, su) les citent. Temoins : « pam_permit ouvre la session » (labo sain) et
 * « un trousseau rendu par /proc/keys porte son uid » (la table elle-meme).
 *
 * Divergence assumee avec le source : pam_keyinit garde ses variables statiques par processus
 * (sshd forke par connexion) ; elles sont ici par transaction. pam_motd d'Ubuntu ajoute `noupdate`
 * et le rafraichissement de /run/motd.dynamic par run-parts de /etc/update-motd.d : l'option est
 * reconnue et le rafraichissement passe par `host.updateMotd` (absent de la machine tant qu'elle
 * ne livre pas /etc/update-motd.d). Le texte exact de /proc/keys n'a pas de transcription
 * de reference ici : le format suit la fonction de procfs, pas une capture.
 */
import { describe, it, expect } from 'vitest';
import { KeyringTable } from '@/network/devices/linux/kernel/KeyringTable';
import { PamFlag, PamReturn } from '@/network/devices/linux/pam/PamReturnCode';
import { PamLab, recording, runPamSync, type LabUser } from './pamLab';

const ALICE: LabUser = { name: 'alice', uid: 1000, gid: 1000, password: 'secret' };
const ROOT: LabUser = { name: 'root', uid: 0, gid: 0, password: 'rootpw' };
const RAW = '[success=ok ignore=ok default=die]';

function open(lab: PamLab, line: string, options: { user?: string; flags?: number } = {}) {
  lab.files.set('/etc/pam.d/svc', `session ${RAW} ${line}\n`);
  const transaction = lab.transaction('svc');
  transaction.handle.user = options.user ?? 'alice';
  const conversation = recording();
  const code = runPamSync(transaction.openSession(options.flags ?? 0), conversation.converse);
  return { code, transaction, conversation };
}

describe('labo', () => {
  it('WITNESS -- pam_permit opens a session; the keyring table renders the uid of what it holds', () => {
    expect(open(new PamLab({ users: [ALICE] }), 'pam_permit.so').code).toBe(PamReturn.SUCCESS);
    const table = new KeyringTable();
    table.userKeyring(1000);
    expect(table.renderProcKeys()).toMatch(/ {2}1000 65534 keyring {3}_uid\.1000: empty\n$/);
  });
});

describe('KeyringTable', () => {
  it('numbers keyrings, links one into another, revokes only as owner or root', () => {
    const table = new KeyringTable();
    const user = table.userKeyring(1000);
    const session = table.joinAnonymousSession(1000, 1000);
    expect(session.id).not.toBe(user.id);
    expect(table.link(user.id, session.id)).toBe(true);
    expect(table.get(session.id)?.links).toEqual([user.id]);
    expect(table.revoke(session.id, 1001)).toBe(false);
    expect(table.revoke(session.id, 1000)).toBe(true);
    expect(table.link(user.id, session.id)).toBe(false);
    expect(table.userKeyring(1000)).toBe(user);
    expect(table.renderProcKeys()).toContain('_ses: 1');
  });
});

describe('pam_keyinit', () => {
  it('force joins a new session keyring and links the user keyring into it', () => {
    const lab = new PamLab({ users: [ALICE, ROOT], caller: { uid: 0 } });
    const before = lab.process.sessionKeyring;
    expect(open(lab, 'pam_keyinit.so force revoke').code).toBe(PamReturn.SUCCESS);
    expect(lab.process.sessionKeyring).not.toBe(before);
    const session = lab.keyringTable.get(lab.process.sessionKeyring!);
    expect(session).toMatchObject({ uid: 1000, gid: 1000, description: '_ses', kind: 'session' });
    expect(session?.links).toHaveLength(1);
    expect(lab.keyringTable.renderProcKeys()).toContain('_ses: 1');
  });

  it('without force a root caller opening alice\'s session keeps its keyring (it already differs from hers)', () => {
    const lab = new PamLab({ users: [ALICE, ROOT], caller: { uid: 0 } });
    const before = lab.process.sessionKeyring;
    expect(open(lab, 'pam_keyinit.so').code).toBe(PamReturn.SUCCESS);
    expect(lab.process.sessionKeyring).toBe(before);
  });

  it('without force a process that only has its user-session keyring joins a private one', () => {
    const lab = new PamLab({ users: [ALICE], caller: { uid: 1000 } });
    const before = lab.process.sessionKeyring;
    open(lab, 'pam_keyinit.so');
    expect(lab.process.sessionKeyring).not.toBe(before);
    const again = open(lab, 'pam_keyinit.so');
    expect(again.code).toBe(PamReturn.SUCCESS);
  });

  it('closing the session revokes the keyring when `revoke` was given, and only then', () => {
    const lab = new PamLab({ users: [ALICE, ROOT], caller: { uid: 0 } });
    lab.files.set('/etc/pam.d/svc', `session ${RAW} pam_keyinit.so force revoke\n`);
    const transaction = lab.transaction('svc');
    transaction.handle.user = 'alice';
    runPamSync(transaction.openSession(), recording().converse);
    const id = lab.process.sessionKeyring!;
    expect(lab.keyringTable.get(id)?.revoked).toBe(false);
    runPamSync(transaction.closeSession(), recording().converse);
    expect(lab.keyringTable.get(id)?.revoked).toBe(true);

    const plain = new PamLab({ users: [ALICE, ROOT], caller: { uid: 0 } });
    plain.files.set('/etc/pam.d/svc', `session ${RAW} pam_keyinit.so force\n`);
    const kept = plain.transaction('svc');
    kept.handle.user = 'alice';
    runPamSync(kept.openSession(), recording().converse);
    const keptId = plain.process.sessionKeyring!;
    runPamSync(kept.closeSession(), recording().converse);
    expect(plain.keyringTable.get(keptId)?.revoked).toBe(false);
  });

  it('setcred(ESTABLISH_CRED) initialises, setcred(DELETE_CRED) revokes, authenticate is ignored, an unknown user is refused', () => {
    const lab = new PamLab({ users: [ALICE, ROOT], caller: { uid: 0 } });
    lab.files.set('/etc/pam.d/svc', `auth ${RAW} pam_keyinit.so force revoke\n`);
    const transaction = lab.transaction('svc');
    transaction.handle.user = 'alice';
    expect(runPamSync(transaction.authenticate(), recording().converse)).toBe(PamReturn.IGNORE);
    expect(runPamSync(transaction.setcred(PamFlag.ESTABLISH_CRED), recording().converse)).toBe(PamReturn.SUCCESS);
    const id = lab.process.sessionKeyring!;
    expect(runPamSync(transaction.setcred(PamFlag.DELETE_CRED), recording().converse)).toBe(PamReturn.SUCCESS);
    expect(lab.keyringTable.get(id)?.revoked).toBe(true);
    expect(runPamSync(transaction.setcred(PamFlag.REINITIALIZE_CRED), recording().converse)).toBe(PamReturn.IGNORE);

    const unknown = new PamLab({ users: [ALICE] });
    expect(open(unknown, 'pam_keyinit.so force', { user: 'ghost' }).code).toBe(PamReturn.USER_UNKNOWN);
    expect(unknown.messages()).toContain('pam_keyinit(svc:session): Unable to look up user "ghost"\n');
  });

  it('debug traces the keyring calls in the journal (the OPEN trace precedes option parsing, so the first one is silent as in the source)', () => {
    const lab = new PamLab({ users: [ALICE], caller: { uid: 0 } });
    open(lab, 'pam_keyinit.so force debug');
    expect(lab.messages().some((line) => line.includes('OPEN'))).toBe(false);
    expect(lab.messages().some((line) => /JOIN = \d+/.test(line))).toBe(true);
  });
});

describe('pam_mail', () => {
  const mailbox = (lab: PamLab, user = 'alice', content = 'From x\n', times = { access: 1, modify: 5 }) => {
    lab.files.set(`/var/mail/${user}`, content);
    lab.times.set(`/var/mail/${user}`, times);
  };

  it('standard says "You have new mail." for a mailbox modified since it was read, and sets MAIL', () => {
    const lab = new PamLab({ users: [ALICE] });
    mailbox(lab);
    const { conversation, transaction } = open(lab, 'pam_mail.so standard');
    expect(conversation.shown).toEqual([{ style: 'info', text: 'You have new mail.' }]);
    expect(transaction.handle.getenv('MAIL')).toBe('/var/mail/alice');
  });

  it('without standard the folder is named, and the old/mail/no-mail variants follow the mailbox state', () => {
    const lab = new PamLab({ users: [ALICE] });
    mailbox(lab);
    expect(open(lab, 'pam_mail.so').conversation.shown[0].text).toBe('You have new mail in folder /var/mail/alice.');
    mailbox(lab, 'alice', 'From x\n', { access: 9, modify: 5 });
    expect(open(lab, 'pam_mail.so').conversation.shown[0].text).toBe('You have old mail in folder /var/mail/alice.');
    expect(open(lab, 'pam_mail.so standard').conversation.shown[0].text).toBe('You have mail.');
    mailbox(lab, 'alice', '');
    expect(open(lab, 'pam_mail.so').conversation.shown).toEqual([]);
    expect(open(lab, 'pam_mail.so empty').conversation.shown[0].text).toBe('You have no mail in folder /var/mail/alice.');
    expect(open(lab, 'pam_mail.so standard').conversation.shown[0].text).toBe('You have no mail.');
  });

  it('quiet only reports new mail, the SILENT flag nothing, nopen skips the report, noenv skips MAIL', () => {
    const lab = new PamLab({ users: [ALICE] });
    mailbox(lab, 'alice', 'From x\n', { access: 9, modify: 5 });
    expect(open(lab, 'pam_mail.so quiet standard').conversation.shown).toEqual([]);
    mailbox(lab);
    expect(open(lab, 'pam_mail.so quiet standard').conversation.shown).toHaveLength(1);
    expect(open(lab, 'pam_mail.so standard', { flags: PamFlag.SILENT }).conversation.shown).toEqual([]);
    expect(open(lab, 'pam_mail.so standard nopen').conversation.shown).toEqual([]);
    expect(open(lab, 'pam_mail.so standard noenv').transaction.handle.getenv('MAIL')).toBeNull();
  });

  it('close reports at the end of the session and unsets MAIL; setcred only acts on establish and delete', () => {
    const lab = new PamLab({ users: [ALICE] });
    mailbox(lab);
    lab.files.set('/etc/pam.d/svc', `session ${RAW} pam_mail.so standard close nopen\n`);
    const transaction = lab.transaction('svc');
    transaction.handle.user = 'alice';
    runPamSync(transaction.openSession(), recording().converse);
    expect(transaction.handle.getenv('MAIL')).toBe('/var/mail/alice');
    const closing = recording();
    runPamSync(transaction.closeSession(), closing.converse);
    expect(closing.shown).toEqual([{ style: 'info', text: 'You have new mail.' }]);
    expect(transaction.handle.getenv('MAIL')).toBeNull();
    lab.files.set('/etc/pam.d/svc', `auth ${RAW} pam_mail.so standard\n`);
    const auth = lab.transaction('svc');
    auth.handle.user = 'alice';
    expect(runPamSync(auth.authenticate(), recording().converse)).toBe(PamReturn.IGNORE);
    expect(runPamSync(auth.setcred(PamFlag.REINITIALIZE_CRED), recording().converse)).toBe(PamReturn.IGNORE);
  });

  it('dir=, hash= and ~ pick the mailbox location; a Maildir is read from new/ then cur/', () => {
    const lab = new PamLab({ users: [ALICE] });
    lab.files.set('/srv/mail/a/l/alice', 'x');
    lab.times.set('/srv/mail/a/l/alice', { access: 1, modify: 2 });
    expect(open(lab, 'pam_mail.so dir=/srv/mail hash=2').transaction.handle.getenv('MAIL')).toBe('/srv/mail/a/l/alice');
    lab.files.set('/home/alice/Mailbox', 'x');
    lab.times.set('/home/alice/Mailbox', { access: 1, modify: 2 });
    const home = open(lab, 'pam_mail.so dir=~/Mailbox standard');
    expect(home.transaction.handle.getenv('MAIL')).toBe('/home/alice/Mailbox');
    expect(home.conversation.shown[0].text).toBe('You have new mail.');
    expect(open(lab, 'pam_mail.so dir=~ standard').code).toBe(PamReturn.SERVICE_ERR);
    lab.files.set('/var/mail/alice/new/1', 'm');
    expect(open(lab, 'pam_mail.so standard').conversation.shown[0].text).toBe('You have new mail.');
    lab.files.delete('/var/mail/alice/new/1');
    lab.files.set('/var/mail/alice/cur/1', 'm');
    expect(open(lab, 'pam_mail.so standard').conversation.shown[0].text).toBe('You have old mail.');
  });

  it('an unknown user and an unknown option are journaled', () => {
    const lab = new PamLab({ users: [ALICE] });
    expect(open(lab, 'pam_mail.so frob', { user: 'ghost' }).code).toBe(PamReturn.USER_UNKNOWN);
    expect(lab.messages()).toContain('pam_mail(svc:session): unknown option: frob');
    expect(lab.messages()).toContain('pam_mail(svc:session): user unknown');
  });
});

describe('pam_motd', () => {
  it('shows /etc/motd without its final newline and sets MOTD_SHOWN', () => {
    const lab = new PamLab({ users: [ALICE], files: { '/etc/motd': 'Welcome to Ubuntu\nline two\n' } });
    const { conversation, code, transaction } = open(lab, 'pam_motd.so');
    expect(code).toBe(PamReturn.IGNORE);
    expect(conversation.shown).toEqual([{ style: 'info', text: 'Welcome to Ubuntu\nline two' }]);
    expect(transaction.handle.getenv('MOTD_SHOWN')).toBe('pam');
  });

  it('the default list stops at the first existing file, empty and oversized files print nothing', () => {
    const lab = new PamLab({ users: [ALICE], files: { '/etc/motd': '', '/run/motd': 'run' } });
    expect(open(lab, 'pam_motd.so').conversation.shown).toEqual([]);
    const second = new PamLab({ users: [ALICE], files: { '/run/motd': 'run\n' } });
    expect(open(second, 'pam_motd.so').conversation.shown[0].text).toBe('run');
    const big = new PamLab({ users: [ALICE], files: { '/etc/motd': 'x'.repeat(0x10001) } });
    expect(open(big, 'pam_motd.so').conversation.shown).toEqual([]);
  });

  it('motd= names the files, a missing explicit file is silent, motd_dir shows the sorted merge with earlier directories overriding', () => {
    const lab = new PamLab({
      users: [ALICE],
      files: {
        '/run/motd.dynamic': 'dynamic\n',
        '/etc/motd.d/20-b': 'etc b\n', '/etc/motd.d/10-a': 'etc a\n',
        '/usr/lib/motd.d/10-a': 'lib a\n', '/usr/lib/motd.d/30-c': 'lib c\n',
      },
    });
    expect(open(lab, 'pam_motd.so motd=/run/motd.dynamic').conversation.shown.map((entry) => entry.text)).toEqual(['dynamic']);
    expect(open(lab, 'pam_motd.so motd=/nowhere').conversation.shown).toEqual([]);
    const merged = open(lab, 'pam_motd.so motd_dir=/etc/motd.d:/usr/lib/motd.d');
    expect(merged.conversation.shown.map((entry) => entry.text)).toEqual(['etc a', 'etc b', 'lib c']);
  });

  it('explicit paths report a missing directory, the defaults do not', () => {
    const lab = new PamLab({ users: [ALICE] });
    open(lab, 'pam_motd.so');
    expect(lab.messages().some((line) => line.includes('error scanning directory'))).toBe(false);
    open(lab, 'pam_motd.so motd_dir=/etc/nowhere.d');
    expect(lab.messages()).toContain('pam_motd(svc:session): error scanning directory /etc/nowhere.d: No such file or directory');
  });

  it('the SILENT flag prints nothing and leaves the environment alone; an empty argument and unknown options are journaled', () => {
    const lab = new PamLab({ users: [ALICE], files: { '/etc/motd': 'hello\n' } });
    const result = open(lab, 'pam_motd.so', { flags: PamFlag.SILENT });
    expect(result.conversation.shown).toEqual([]);
    expect(result.transaction.handle.getenv('MOTD_SHOWN')).toBeNull();
    open(lab, 'pam_motd.so motd= frobnicate');
    expect(lab.messages()).toContain('pam_motd(svc:session): motd= specification missing argument - ignored');
    expect(lab.messages()).toContain('pam_motd(svc:session): unknown option: frobnicate');
  });

  it('without noupdate the host refreshes the dynamic motd and the module shows what it wrote; noupdate leaves it alone', () => {
    const lab = new PamLab({ users: [ALICE] });
    lab.updateMotdOutput = 'Welcome to Ubuntu 22.04.3 LTS\n';
    const refreshed = open(lab, 'pam_motd.so motd=/run/motd.dynamic');
    expect(lab.motdUpdates).toBe(1);
    expect(lab.files.get('/run/motd.dynamic')).toBe('Welcome to Ubuntu 22.04.3 LTS\n');
    expect(refreshed.conversation.shown[0].text).toBe('Welcome to Ubuntu 22.04.3 LTS');
    open(lab, 'pam_motd.so motd=/run/motd.dynamic noupdate');
    expect(lab.motdUpdates).toBe(1);
    open(lab, 'pam_motd.so noupdate');
    expect(lab.motdUpdates).toBe(1);
  });
});

describe('pam_selinux with SELinux absent', () => {
  it('succeeds for open and close so the `module_unknown=ignore` bracket never has to hide it', () => {
    const lab = new PamLab({ users: [ALICE] });
    expect(open(lab, 'pam_selinux.so open').code).toBe(PamReturn.SUCCESS);
    lab.files.set('/etc/pam.d/svc', `session ${RAW} pam_selinux.so close\n`);
    const transaction = lab.transaction('svc');
    transaction.handle.user = 'alice';
    expect(runPamSync(transaction.closeSession(), recording().converse)).toBe(PamReturn.SUCCESS);
  });
});
