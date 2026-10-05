/**
 * Sonde — pam_access, pam_time, pam_group et pam_cap portes depuis Linux-PAM 1.4.0
 * (modules/pam_access, pam_time, pam_group) et libcap (pam_cap/pam_cap.c).
 *
 * Mesure de depart : ces modules n'existaient pas ; l'administrateur qui decommentait
 * `account required pam_access.so` ou `pam_time.so` dans les piles Ubuntu semees (sshd, login) ne
 * restreignait rien : la ligne tombait sur « module inconnu ». Chaque cas ci-dessous tombait donc
 * avant le correctif. Temoin vert des deux cotes : « pam_permit laisse passer » (le labo).
 *
 * Evaluation des syntaxes d'apres les sources : EXCEPT recursif, ALL, LOCAL, domaine `.suffixe`,
 * prefixe d'adresse `10.0.0.`, reseau `a.b.c.d/n` ou `/masque`, `user@host`, `(groupe)`, ancienne
 * syntaxe groupe nu et `nodefgroup`, access.d en repli ; pam_time : champs `;`, jours `Mo Tu Wk Wd
 * Al`, plages sur deux jours, negation, & | !, jokers `*` en queue, heure LOCALE de la zone de la machine ;
 * pam_group : groupes supplementaires ajoutes si root, CRED_ERR sinon.
 *
 * Limites : les netgroups NIS n'existent pas (`@groupe` ne correspond a rien, comme innetgr sans
 * base) ; la resolution des noms d'hote de pam_access passe par le NSS synchrone de la machine
 * (/etc/hosts), pas par une requete DNS ; le texte IAB de pam_cap n'accepte que les prefixes `!`, `^`
 * et nu (la grammaire complete de libcap n'a pas pu etre lue : tout autre prefixe est refuse) ;
 * les capacites sont l'etat du processus PAM, la machine n'a pas encore d'ensemble de capacites par
 * processus pour les appliquer.
 */
import { describe, it, expect } from 'vitest';
import { PamReturn, PamFlag } from '@/network/devices/linux/pam/PamReturnCode';
import { PamLab, recording, runPamSync, type LabUser } from './pamLab';

const ALICE: LabUser = { name: 'alice', uid: 1000, gid: 1000, password: 'secret' };
const BOB: LabUser = { name: 'bob', uid: 1001, gid: 1001, password: 'bobpw' };
const ROOT: LabUser = { name: 'root', uid: 0, gid: 0, password: 'rootpw' };
const GROUPS = [
  { name: 'staff', gid: 50, members: ['alice'] },
  { name: 'wheel', gid: 10, members: [] },
  { name: 'alice', gid: 1000, members: [] },
];
const RAW = '[success=ok ignore=ok default=die]';

function run(lab: PamLab, type: 'account' | 'session' | 'auth' | 'password', line: string, options: { user?: string; rhost?: string | null; tty?: string | null; flags?: number } = {}) {
  lab.files.set('/etc/pam.d/svc', `${type} ${RAW} ${line}\n`);
  const transaction = lab.transaction('svc');
  transaction.handle.user = options.user ?? 'alice';
  if (options.rhost !== null) transaction.handle.rhost = options.rhost ?? '10.0.0.7';
  if (options.tty !== null) transaction.handle.tty = options.tty ?? 'ssh';
  const conversation = recording();
  const flow = type === 'account' ? transaction.acctMgmt(options.flags ?? 0)
    : type === 'session' ? transaction.openSession()
      : type === 'auth' ? transaction.authenticate()
        : transaction.chauthtok();
  return { code: runPamSync(flow, conversation.converse), transaction, conversation };
}

const access = (rules: string[], extra: Record<string, string> = {}) =>
  new PamLab({ users: [ALICE, BOB, ROOT], groups: GROUPS, files: { '/etc/security/access.conf': `${rules.join('\n')}\n`, ...extra } });

describe('labo', () => {
  it('WITNESS -- pam_permit lets the account through', () => {
    expect(run(new PamLab({ users: [ALICE] }), 'account', 'pam_permit.so').code).toBe(PamReturn.SUCCESS);
  });
});

describe('pam_access', () => {
  it('the first matching line decides: allow alice, deny the rest, and the denial is journaled', () => {
    const lab = access(['+ : alice : ALL', '- : ALL : ALL']);
    expect(run(lab, 'account', 'pam_access.so').code).toBe(PamReturn.SUCCESS);
    const denied = run(lab, 'account', 'pam_access.so', { user: 'bob', rhost: '10.0.0.9' });
    expect(denied.code).toBe(PamReturn.PERM_DENIED);
    expect(lab.messages()).toContain('pam_access(svc:account): access denied for user `bob\' from `10.0.0.9\'');
  });

  it('no matching line (or no file) is not a denial; lines are tried in order', () => {
    expect(run(access(['- : bob : ALL']), 'account', 'pam_access.so').code).toBe(PamReturn.SUCCESS);
    const missing = new PamLab({ users: [ALICE] });
    expect(run(missing, 'account', 'pam_access.so').code).toBe(PamReturn.SUCCESS);
    expect(missing.messages()).toContain('pam_access(svc:account): warning: cannot open /etc/security/access.conf: No such file or directory');
  });

  it('EXCEPT removes users or origins from a list, recursively', () => {
    const lab = access(['- : ALL EXCEPT root alice : ALL']);
    expect(run(lab, 'account', 'pam_access.so', { user: 'bob' }).code).toBe(PamReturn.PERM_DENIED);
    expect(run(lab, 'account', 'pam_access.so', { user: 'alice' }).code).toBe(PamReturn.SUCCESS);
    expect(run(lab, 'account', 'pam_access.so', { user: 'root' }).code).toBe(PamReturn.SUCCESS);
    const origins = access(['- : bob : ALL EXCEPT 10.0.0.0/24']);
    expect(run(origins, 'account', 'pam_access.so', { user: 'bob', rhost: '10.0.0.9' }).code).toBe(PamReturn.SUCCESS);
    expect(run(origins, 'account', 'pam_access.so', { user: 'bob', rhost: '192.168.1.9' }).code).toBe(PamReturn.PERM_DENIED);
  });

  it('origins: LOCAL for a tty, a tty name with /dev/ stripped, ALL, a domain suffix, an address prefix', () => {
    const local = access(['- : bob : LOCAL']);
    expect(run(local, 'account', 'pam_access.so', { user: 'bob', rhost: null, tty: '/dev/tty1' }).code).toBe(PamReturn.PERM_DENIED);
    expect(run(local, 'account', 'pam_access.so', { user: 'bob', rhost: '10.0.0.9' }).code).toBe(PamReturn.SUCCESS);
    expect(run(access(['- : bob : tty1']), 'account', 'pam_access.so', { user: 'bob', rhost: null, tty: '/dev/tty1' }).code).toBe(PamReturn.PERM_DENIED);
    expect(run(access(['- : bob : pts/0']), 'account', 'pam_access.so', { user: 'bob', rhost: null, tty: '/dev/pts/0' }).code).toBe(PamReturn.PERM_DENIED);
    expect(run(access(['- : bob : .example.com']), 'account', 'pam_access.so', { user: 'bob', rhost: 'pc.example.com' }).code).toBe(PamReturn.PERM_DENIED);
    expect(run(access(['- : bob : .example.com']), 'account', 'pam_access.so', { user: 'bob', rhost: 'pc.example.org' }).code).toBe(PamReturn.SUCCESS);
    expect(run(access(['- : bob : 10.0.']), 'account', 'pam_access.so', { user: 'bob', rhost: '10.0.4.4' }).code).toBe(PamReturn.PERM_DENIED);
    expect(run(access(['- : bob : 10.0.']), 'account', 'pam_access.so', { user: 'bob', rhost: '10.1.4.4' }).code).toBe(PamReturn.SUCCESS);
  });

  it('with no tty and no host the service name stands in', () => {
    expect(run(access(['- : bob : svc']), 'account', 'pam_access.so', { user: 'bob', rhost: null, tty: null }).code).toBe(PamReturn.PERM_DENIED);
  });

  it('networks: /prefix, /netmask, exact address, IPv6 prefixes; bad masks never match and /0 means no mask at all (number_to_netmask returns NULL), so only the exact address matches', () => {
    const deny = (origin: string, rhost: string) => run(access([`- : bob : ${origin}`]), 'account', 'pam_access.so', { user: 'bob', rhost }).code;
    expect(deny('10.0.0.0/24', '10.0.0.200')).toBe(PamReturn.PERM_DENIED);
    expect(deny('10.0.0.0/24', '10.0.1.200')).toBe(PamReturn.SUCCESS);
    expect(deny('10.0.0.0/255.255.0.0', '10.0.9.9')).toBe(PamReturn.PERM_DENIED);
    expect(deny('10.0.0.5', '10.0.0.5')).toBe(PamReturn.PERM_DENIED);
    expect(deny('10.0.0.5', '10.0.0.6')).toBe(PamReturn.SUCCESS);
    expect(deny('2001:db8::/32', '2001:db8:1::5')).toBe(PamReturn.PERM_DENIED);
    expect(deny('2001:db8::/32', '2001:db9::5')).toBe(PamReturn.SUCCESS);
    expect(deny('10.0.0.0/33', '10.0.0.5')).toBe(PamReturn.SUCCESS);
    expect(deny('10.0.0.0/abc', '10.0.0.5')).toBe(PamReturn.SUCCESS);
    expect(deny('10.0.0.0/0', '10.0.0.5')).toBe(PamReturn.SUCCESS);
    expect(deny('10.0.0.5/0', '10.0.0.5')).toBe(PamReturn.PERM_DENIED);
  });

  it('a host name is resolved through the machine and then compared with the network', () => {
    const lab = access(['- : bob : 10.0.0.0/24']);
    lab.hostTable.set('pc.lan', ['10.0.0.5']);
    expect(run(lab, 'account', 'pam_access.so', { user: 'bob', rhost: 'pc.lan' }).code).toBe(PamReturn.PERM_DENIED);
    expect(run(lab, 'account', 'pam_access.so', { user: 'bob', rhost: 'unknown.lan' }).code).toBe(PamReturn.SUCCESS);
  });

  it('user lists: names, (group), a bare group (old syntax, switched off by nodefgroup), user@host, netgroups never match', () => {
    expect(run(access(['- : (staff) : ALL']), 'account', 'pam_access.so').code).toBe(PamReturn.PERM_DENIED);
    expect(run(access(['- : (staff) : ALL']), 'account', 'pam_access.so', { user: 'bob' }).code).toBe(PamReturn.SUCCESS);
    expect(run(access(['- : staff : ALL']), 'account', 'pam_access.so').code).toBe(PamReturn.PERM_DENIED);
    expect(run(access(['- : staff : ALL']), 'account', 'pam_access.so nodefgroup').code).toBe(PamReturn.SUCCESS);
    const atHost = access(['- : alice@lab : ALL']);
    expect(run(atHost, 'account', 'pam_access.so').code).toBe(PamReturn.PERM_DENIED);
    atHost.hostName = 'other';
    expect(run(atHost, 'account', 'pam_access.so').code).toBe(PamReturn.SUCCESS);
    expect(run(access(['- : @admins : ALL']), 'account', 'pam_access.so').code).toBe(PamReturn.SUCCESS);
  });

  it('comments, blank lines, bad field counts and bad first fields are journaled and skipped', () => {
    const lab = access(['# note', '', '+ : alice', '? : alice : ALL', '- : alice : ALL']);
    expect(run(lab, 'account', 'pam_access.so').code).toBe(PamReturn.PERM_DENIED);
    expect(lab.messages()).toContain('pam_access(svc:account): /etc/security/access.conf: line 3: bad field count');
    expect(lab.messages()).toContain('pam_access(svc:account): /etc/security/access.conf: line 4: bad first field');
  });

  it('falls back to access.d/*.conf in sorted order only when access.conf had no match', () => {
    const lab = access(['- : root : ALL'], {
      '/etc/security/access.d/20-b.conf': '+ : alice : ALL\n',
      '/etc/security/access.d/10-a.conf': '- : alice : ALL\n',
    });
    expect(run(lab, 'account', 'pam_access.so').code).toBe(PamReturn.PERM_DENIED);
    const decided = access(['+ : alice : ALL'], { '/etc/security/access.d/10-a.conf': '- : alice : ALL\n' });
    expect(run(decided, 'account', 'pam_access.so').code).toBe(PamReturn.SUCCESS);
  });

  it('accessfile=, fieldsep=, listsep= and nodefgroup/unknown options', () => {
    const lab = access([], { '/etc/other.conf': '- | bob | ALL\n' });
    expect(run(lab, 'account', 'pam_access.so accessfile=/etc/other.conf fieldsep=|', { user: 'bob' }).code).toBe(PamReturn.PERM_DENIED);
    expect(run(lab, 'account', 'pam_access.so accessfile=/etc/none.conf').code).toBe(PamReturn.ABORT);
    expect(lab.messages()).toContain('pam_access(svc:account): failed to open accessfile=[/etc/none.conf]: No such file or directory');
    const semi = access(['-:alice;bob:ALL']);
    expect(run(semi, 'account', 'pam_access.so listsep=;', { user: 'bob' }).code).toBe(PamReturn.PERM_DENIED);
    const spaced = access(['- : alice;bob : ALL']);
    expect(run(spaced, 'account', 'pam_access.so listsep=;', { user: 'bob' }).code).toBe(PamReturn.SUCCESS);
    run(lab, 'account', 'pam_access.so frob');
    expect(lab.messages()).toContain('pam_access(svc:account): unrecognized option [frob]');
  });

  it('unknown user is refused, and the same rules answer every entry point but setcred', () => {
    const lab = access(['- : bob : ALL']);
    expect(run(lab, 'account', 'pam_access.so', { user: 'ghost' }).code).toBe(PamReturn.USER_UNKNOWN);
    for (const type of ['auth', 'session', 'password'] as const) {
      expect(run(lab, type, 'pam_access.so', { user: 'bob' }).code).toBe(PamReturn.PERM_DENIED);
    }
    lab.files.set('/etc/pam.d/svc', `auth ${RAW} pam_access.so\n`);
    const transaction = lab.transaction('svc');
    transaction.handle.user = 'bob';
    expect(runPamSync(transaction.setcred(PamFlag.ESTABLISH_CRED), recording().converse)).toBe(PamReturn.IGNORE);
  });
});

describe('pam_time', () => {
  const timed = (rule: string, extra: Partial<ConstructorParameters<typeof PamLab>[0]> = {}, zone = 'UTC') => {
    const lab = new PamLab({ users: [ALICE, BOB], files: { '/etc/security/time.conf': `${rule}\n` }, now: Date.UTC(2023, 10, 14, 22, 13, 20), ...extra });
    lab.timezone = zone;
    return lab;
  };

  it('allows inside the listed days and hours, refuses outside (a Tuesday at 22:13 UTC)', () => {
    expect(run(timed('*;*;alice;Tu2000-2300'), 'account', 'pam_time.so').code).toBe(PamReturn.SUCCESS);
    expect(run(timed('*;*;alice;Mo2000-2300'), 'account', 'pam_time.so').code).toBe(PamReturn.PERM_DENIED);
    expect(run(timed('*;*;alice;Al0000-0600'), 'account', 'pam_time.so').code).toBe(PamReturn.PERM_DENIED);
    expect(run(timed('*;*;alice;Al0000-0600'), 'account', 'pam_time.so', { user: 'bob' }).code).toBe(PamReturn.SUCCESS);
  });

  it('day groups: Wk weekdays, Wd weekend, several days; a negated range', () => {
    expect(run(timed('*;*;alice;Wk0000-2400'), 'account', 'pam_time.so').code).toBe(PamReturn.SUCCESS);
    expect(run(timed('*;*;alice;Wd0000-2400'), 'account', 'pam_time.so').code).toBe(PamReturn.PERM_DENIED);
    expect(run(timed('*;*;alice;MoTu0000-2400'), 'account', 'pam_time.so').code).toBe(PamReturn.SUCCESS);
    expect(run(timed('*;*;alice;!Tu0000-2400'), 'account', 'pam_time.so').code).toBe(PamReturn.PERM_DENIED);
  });

  it('a range that spans midnight covers the evening of the first day and the morning of the next', () => {
    expect(run(timed('*;*;alice;Tu2200-0600'), 'account', 'pam_time.so').code).toBe(PamReturn.SUCCESS);
    expect(run(timed('*;*;alice;Mo2200-0600'), 'account', 'pam_time.so').code).toBe(PamReturn.PERM_DENIED);
    const morning = timed('*;*;alice;Mo2200-2359', {}, 'UTC');
    morning.now = Date.UTC(2023, 10, 14, 3, 0, 0);
    morning.files.set('/etc/security/time.conf', '*;*;alice;Mo2200-0600\n');
    expect(run(morning, 'account', 'pam_time.so').code).toBe(PamReturn.SUCCESS);
  });

  it('the hour is the machine\'s local hour', () => {
    expect(run(timed('*;*;alice;Al2300-2400', {}, 'Europe/Paris'), 'account', 'pam_time.so').code).toBe(PamReturn.SUCCESS);
    expect(run(timed('*;*;alice;Al2300-2400', {}, 'UTC'), 'account', 'pam_time.so').code).toBe(PamReturn.PERM_DENIED);
  });

  it('service, tty and user fields combine with & | ! and trailing wildcards', () => {
    expect(run(timed('svc&!login;*;alice;Al0000-0600'), 'account', 'pam_time.so').code).toBe(PamReturn.PERM_DENIED);
    expect(run(timed('login|sshd;*;alice;Al0000-0600'), 'account', 'pam_time.so').code).toBe(PamReturn.SUCCESS);
    expect(run(timed('sv*;*;alice;Al0000-0600'), 'account', 'pam_time.so').code).toBe(PamReturn.PERM_DENIED);
    expect(run(timed('*;pts/*;alice;Al0000-0600'), 'account', 'pam_time.so', { tty: '/dev/pts/3' }).code).toBe(PamReturn.PERM_DENIED);
    expect(run(timed('*;tty*;alice;Al0000-0600'), 'account', 'pam_time.so', { tty: '/dev/pts/3' }).code).toBe(PamReturn.SUCCESS);
    expect(run(timed('*;*;!alice;Al0000-0600'), 'account', 'pam_time.so').code).toBe(PamReturn.SUCCESS);
    expect(run(timed('*;*;alice|bob;Al0000-0600'), 'account', 'pam_time.so', { user: 'bob' }).code).toBe(PamReturn.PERM_DENIED);
  });

  it('every rule is evaluated: one failing time among several passing ones still refuses', () => {
    expect(run(timed('*;*;bob;Al0000-0600\n*;*;alice;Al0000-2400\n*;*;alice;Al0000-0600'), 'account', 'pam_time.so').code).toBe(PamReturn.PERM_DENIED);
  });

  it('comments, continuation lines and malformed rules', () => {
    expect(run(timed('# c\n*;*;alice;\\\nAl0000-2400 # tail'), 'account', 'pam_time.so').code).toBe(PamReturn.SUCCESS);
    const bad = timed('*;*;alice\n*;*;alice;Al0000-2400;\n*;*;a&&b;Al0000-2400');
    expect(run(bad, 'account', 'pam_time.so').code).toBe(PamReturn.SUCCESS);
    expect(bad.messages()).toContain('pam_time(svc:account): /etc/security/time.conf: malformed rule #1');
    expect(bad.messages()).toContain('pam_time(svc:account): /etc/security/time.conf: poorly terminated rule #2');
    const syntax = timed('*;*;alice;Zz0800-1700');
    run(syntax, 'account', 'pam_time.so');
    expect(syntax.messages()).toContain('pam_time(svc:account): bad day specified (rule #1)');
    const times = timed('*;*;alice;Al0800');
    run(times, 'account', 'pam_time.so');
    expect(times.messages()).toContain('pam_time(svc:account): no/bad times specified (rule #1)');
  });

  it('conffile=, a missing file, netgroup users (never match) and an unknown option', () => {
    const lab = timed('*;*;alice;Al0000-0600');
    lab.files.set('/etc/other.conf', '*;*;alice;Al0000-2400\n');
    expect(run(lab, 'account', 'pam_time.so conffile=/etc/other.conf').code).toBe(PamReturn.SUCCESS);
    expect(run(lab, 'account', 'pam_time.so conffile=/etc/nowhere.conf').code).toBe(PamReturn.SUCCESS);
    expect(lab.messages()).toContain('pam_time(svc:account): error opening /etc/nowhere.conf: No such file or directory');
    expect(run(timed('*;*;@admins;Al0000-0600'), 'account', 'pam_time.so').code).toBe(PamReturn.SUCCESS);
    run(lab, 'account', 'pam_time.so frob');
    expect(lab.messages()).toContain('pam_time(svc:account): unknown option: frob');
  });
});

describe('pam_group', () => {
  const grouped = (rules: string[], options: { caller?: { uid: number } } = {}) =>
    new PamLab({
      users: [ALICE, BOB, ROOT], groups: GROUPS, caller: options.caller ?? { uid: 0 },
      files: { '/etc/security/group.conf': `${rules.join('\n')}\n` }, now: Date.UTC(2023, 10, 14, 22, 13, 20),
    });
  const establish = (lab: PamLab, user = 'alice') => {
    lab.files.set('/etc/pam.d/svc', `auth ${RAW} pam_group.so\n`);
    const transaction = lab.transaction('svc');
    transaction.handle.user = user;
    transaction.handle.tty = 'ssh';
    return runPamSync(transaction.setcred(PamFlag.ESTABLISH_CRED), recording().converse);
  };

  it('adds the listed groups to the supplementary groups of the process when a rule matches', () => {
    const lab = grouped(['*;*;alice;Al0000-2400;staff,wheel']);
    lab.process.supplementaryGroups = [1000];
    expect(establish(lab)).toBe(PamReturn.SUCCESS);
    expect(lab.process.supplementaryGroups).toEqual([1000, 50, 10]);
  });

  it('a rule that does not match (user, time or service) adds nothing', () => {
    const lab = grouped(['*;*;bob;Al0000-2400;staff', '*;*;alice;Al0000-0600;wheel', 'login;*;alice;Al0000-2400;staff']);
    lab.process.supplementaryGroups = [1000];
    expect(establish(lab)).toBe(PamReturn.SUCCESS);
    expect(lab.process.supplementaryGroups).toEqual([1000]);
  });

  it('%group selects the members of a group, an unknown group is journaled', () => {
    const lab = grouped(['*;*;%staff;Al0000-2400;wheel,ghosts']);
    expect(establish(lab)).toBe(PamReturn.SUCCESS);
    expect(lab.process.supplementaryGroups).toEqual([10]);
    expect(lab.messages()).toContain('pam_group(svc:setcred): bad group: ghosts');
    const other = grouped(['*;*;%staff;Al0000-2400;wheel']);
    expect(establish(other, 'bob')).toBe(PamReturn.SUCCESS);
    expect(other.process.supplementaryGroups).toEqual([]);
  });

  it('only root can change the groups: anybody else gets PAM_CRED_ERR and an unchanged list', () => {
    const lab = grouped(['*;*;alice;Al0000-2400;staff'], { caller: { uid: 1000 } });
    expect(establish(lab)).toBe(PamReturn.CRED_ERR);
    expect(lab.messages()).toContain('pam_group(svc:setcred): unable to set the group membership for user: Operation not permitted');
    expect(lab.process.supplementaryGroups).toEqual([]);
  });

  it('authenticate is ignored, a setcred that does not establish succeeds without reading the file, a missing file is journaled', () => {
    const lab = grouped(['*;*;alice;Al0000-2400;staff']);
    lab.files.set('/etc/pam.d/svc', `auth ${RAW} pam_group.so\n`);
    const transaction = lab.transaction('svc');
    transaction.handle.user = 'alice';
    expect(runPamSync(transaction.authenticate(), recording().converse)).toBe(PamReturn.IGNORE);
    expect(runPamSync(transaction.setcred(PamFlag.DELETE_CRED), recording().converse)).toBe(PamReturn.SUCCESS);
    expect(lab.process.supplementaryGroups).toEqual([]);
    const none = new PamLab({ users: [ALICE] });
    expect(establish(none)).toBe(PamReturn.SUCCESS);
    expect(none.messages()).toContain('pam_group(svc:setcred): error opening /etc/security/group.conf: No such file or directory');
  });
});

describe('pam_cap', () => {
  const capped = (rules: string[], mode = 0o644) => {
    const lab = new PamLab({ users: [ALICE, BOB], groups: GROUPS, files: { '/etc/security/capability.conf': `${rules.join('\n')}\n` } });
    lab.modes.set('/etc/security/capability.conf', mode);
    return lab;
  };
  const credentials = (lab: PamLab, line: string, user = 'alice', flags: number = PamFlag.ESTABLISH_CRED) => {
    lab.files.set('/etc/pam.d/svc', `auth ${RAW} ${line}\n`);
    const transaction = lab.transaction('svc');
    transaction.handle.user = user;
    return runPamSync(transaction.setcred(flags), recording().converse);
  };
  const authenticate = (lab: PamLab, line: string, user = 'alice') => run(lab, 'auth', line, { user }).code;

  it('authenticate succeeds only for a user the file lists (name, @group or *), else is ignored', () => {
    const lab = capped(['cap_net_raw alice', 'cap_kill @staff', 'none *']);
    expect(authenticate(lab, 'pam_cap.so')).toBe(PamReturn.SUCCESS);
    expect(authenticate(lab, 'pam_cap.so', 'bob')).toBe(PamReturn.SUCCESS);
    expect(authenticate(capped(['cap_net_raw alice']), 'pam_cap.so', 'bob')).toBe(PamReturn.IGNORE);
    expect(authenticate(capped(['cap_kill @staff']), 'pam_cap.so')).toBe(PamReturn.SUCCESS);
    expect(authenticate(capped(['cap_kill @staff']), 'pam_cap.so', 'bob')).toBe(PamReturn.IGNORE);
  });

  it('autoauth always succeeds, and a world-writable file is not trusted', () => {
    expect(authenticate(capped(['cap_net_raw alice']), 'pam_cap.so autoauth', 'bob')).toBe(PamReturn.SUCCESS);
    expect(authenticate(capped(['cap_net_raw alice'], 0o666), 'pam_cap.so')).toBe(PamReturn.IGNORE);
  });

  it('setcred raises the listed capabilities into the inheritable set; the first matching line wins', () => {
    const lab = capped(['cap_net_raw alice', 'cap_kill alice']);
    expect(credentials(lab, 'pam_cap.so')).toBe(PamReturn.SUCCESS);
    expect([...lab.process.capabilities.inheritable]).toEqual(['cap_net_raw']);
    expect(credentials(capped(['cap_kill,cap_chown alice']), 'pam_cap.so')).toBe(PamReturn.SUCCESS);
  });

  it('^ makes a capability ambient (and inheritable), ! drops it from the bounding set', () => {
    const lab = capped(['^cap_kill,!cap_net_raw,cap_chown alice']);
    expect(credentials(lab, 'pam_cap.so')).toBe(PamReturn.SUCCESS);
    expect([...lab.process.capabilities.ambient]).toEqual(['cap_kill']);
    expect(lab.process.capabilities.inheritable.has('cap_chown')).toBe(true);
    expect(lab.process.capabilities.bounding.has('cap_net_raw')).toBe(false);
    expect(lab.process.capabilities.bounding.has('cap_kill')).toBe(true);
  });

  it('`none` clears the inheritable set, `all` leaves it alone, an unknown name or prefix is refused (ignored)', () => {
    const none = capped(['none alice']);
    none.process.capabilities.inheritable.add('cap_kill');
    expect(credentials(none, 'pam_cap.so')).toBe(PamReturn.SUCCESS);
    expect(none.process.capabilities.inheritable.size).toBe(0);
    const all = capped(['all alice']);
    all.process.capabilities.inheritable.add('cap_kill');
    expect(credentials(all, 'pam_cap.so')).toBe(PamReturn.SUCCESS);
    expect(all.process.capabilities.inheritable.has('cap_kill')).toBe(true);
    expect(credentials(capped(['cap_nonsense alice']), 'pam_cap.so')).toBe(PamReturn.IGNORE);
    expect(credentials(capped(['%cap_kill alice']), 'pam_cap.so')).toBe(PamReturn.IGNORE);
  });

  it('default= applies to users the file does not list, config= names another file, other setcred flags are ignored', () => {
    const lab = capped(['cap_net_raw alice']);
    expect(credentials(lab, 'pam_cap.so default=cap_chown', 'bob')).toBe(PamReturn.SUCCESS);
    expect([...lab.process.capabilities.inheritable]).toEqual(['cap_chown']);
    expect(credentials(capped(['cap_net_raw alice']), 'pam_cap.so', 'bob')).toBe(PamReturn.IGNORE);
    const other = capped([]);
    other.files.set('/etc/other.conf', 'cap_kill bob\n');
    expect(credentials(other, 'pam_cap.so config=/etc/other.conf', 'bob')).toBe(PamReturn.SUCCESS);
    expect(credentials(lab, 'pam_cap.so', 'alice', PamFlag.DELETE_CRED)).toBe(PamReturn.IGNORE);
    credentials(lab, 'pam_cap.so frob');
    expect(lab.messages()).toContain('pam_cap(svc:setcred): unknown option; frob');
  });
});
