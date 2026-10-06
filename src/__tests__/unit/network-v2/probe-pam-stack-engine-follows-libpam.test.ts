/**
 * Sonde — le moteur de pile PAM (`devices/linux/pam/`) suit libpam 1.4.0, la version d'Ubuntu 22.04.
 *
 * Mesure de depart : le simulateur n'avait AUCUN moteur PAM. `/etc/pam.d/*` n'etait qu'une
 * projection d'un objet de politique (common-password ecrit depuis PasswordQualityPolicy) que
 * rien ne relisait, et `LinuxUserManager.checkPassword` melangeait pam_unix, pam_faillock et le
 * compte verrouille dans une seule fonction. Il n'existe donc pas de base a laquelle rejouer la
 * sonde (`git stash` ne retire rien : chaque cas tombe sur l'import) ; le TEMOIN (« required
 * pam_permit accepte ») prouve que le labo est sain, et les vecteurs ci-dessous sont derives
 * ligne a ligne de libpam/pam_dispatch.c, libpam/pam_handlers.c et libpam/pam_misc.c (tag v1.4.0,
 * lus dans le depot linux-pam/linux-pam, hors depot).
 *
 * Limites assumees : `@include` est une extension Debian/Ubuntu dont le source n'est pas
 * accessible d'ici ; il est lu comme l'inclusion du fichier pour les quatre types. PAM_INCOMPLETE
 * rend la main sans reprise (la conversation est un generateur, il n'y a pas de reprise a faire),
 * et le delai d'echec (`pam_fail_delay`) n'est pas modelise : le temps est virtuel.
 */
import { describe, it, expect } from 'vitest';
import { PamModuleRegistry } from '@/network/devices/linux/pam/PamModule';
import { PamReturn } from '@/network/devices/linux/pam/PamReturnCode';
import { PamTransaction, NO_CONVERSATION, runPamSync } from '@/network/devices/linux/pam/PamTransaction';
import { loadPamStacks, tokenizePamLine } from '@/network/devices/linux/pam/PamStackConfig';
import { parseBracketControl } from '@/network/devices/linux/pam/PamControl';
import type { PamHost, PamLogEntry } from '@/network/devices/linux/pam/PamHandle';

interface Lab {
  readonly calls: string[];
  readonly logs: PamLogEntry[];
  authenticate(): number;
  setcred(): number;
  account(): number;
  session(): number;
}

function lab(files: Record<string, string>, outcomes: Record<string, number>): Lab {
  const calls: string[] = [];
  const logs: PamLogEntry[] = [];
  const registry = new PamModuleRegistry();
  for (const [name, code] of Object.entries(outcomes)) {
    const make = (label: string) => (): number => { calls.push(`${name}:${label}`); return code; };
    registry.register(name, {
      authenticate: make('auth'), setcred: make('setcred'), acctMgmt: make('account'),
      openSession: make('open'), closeSession: make('close'), chauthtok: make('chauthtok'),
    });
  }
  const host: PamHost = { readFile: (path) => files[path] ?? null, now: () => 0, log: (entry) => logs.push(entry) };
  const transaction = new PamTransaction('svc', host, registry, host);
  const run = (flow: ReturnType<PamTransaction['authenticate']>): number => runPamSync(flow, NO_CONVERSATION);
  return {
    calls, logs,
    authenticate: () => run(transaction.authenticate()),
    setcred: () => run(transaction.setcred()),
    account: () => run(transaction.acctMgmt()),
    session: () => run(transaction.openSession()),
  };
}

const svc = (body: string): Record<string, string> => ({ '/etc/pam.d/svc': body });

describe('control keywords', () => {
  it('WITNESS -- a lone required pam_permit succeeds', () => {
    expect(lab(svc('auth required pam_permit.so\n'), { pam_permit: PamReturn.SUCCESS }).authenticate()).toBe(PamReturn.SUCCESS);
  });

  it('required: a failure is remembered but every later module still runs', () => {
    const l = lab(svc('auth required a.so\nauth required b.so\nauth required c.so\n'),
      { a: PamReturn.SUCCESS, b: PamReturn.AUTH_ERR, c: PamReturn.SUCCESS });
    expect(l.authenticate()).toBe(PamReturn.AUTH_ERR);
    expect(l.calls).toEqual(['a:auth', 'b:auth', 'c:auth']);
  });

  it('requisite: the first failure ends the stack and is what the stack returns', () => {
    const l = lab(svc('auth requisite a.so\nauth required b.so\n'), { a: PamReturn.AUTH_ERR, b: PamReturn.SUCCESS });
    expect(l.authenticate()).toBe(PamReturn.AUTH_ERR);
    expect(l.calls).toEqual(['a:auth']);
  });

  it('sufficient: a success with no earlier failure ends the stack in success', () => {
    const l = lab(svc('auth required a.so\nauth sufficient b.so\nauth required c.so\n'),
      { a: PamReturn.SUCCESS, b: PamReturn.SUCCESS, c: PamReturn.AUTH_ERR });
    expect(l.authenticate()).toBe(PamReturn.SUCCESS);
    expect(l.calls).toEqual(['a:auth', 'b:auth']);
  });

  it('sufficient: a success AFTER a required failure does not rescue the stack', () => {
    const l = lab(svc('auth required a.so\nauth sufficient b.so\nauth required c.so\n'),
      { a: PamReturn.AUTH_ERR, b: PamReturn.SUCCESS, c: PamReturn.SUCCESS });
    expect(l.authenticate()).toBe(PamReturn.AUTH_ERR);
    expect(l.calls).toEqual(['a:auth', 'b:auth', 'c:auth']);
  });

  it('sufficient: a failure is ignored', () => {
    const l = lab(svc('auth sufficient a.so\nauth required b.so\n'), { a: PamReturn.AUTH_ERR, b: PamReturn.SUCCESS });
    expect(l.authenticate()).toBe(PamReturn.SUCCESS);
  });

  it('optional: only a success counts, and an all-optional failing stack is PERM_DENIED, not the module code', () => {
    expect(lab(svc('auth optional a.so\n'), { a: PamReturn.SUCCESS }).authenticate()).toBe(PamReturn.SUCCESS);
    expect(lab(svc('auth optional a.so\n'), { a: PamReturn.AUTH_ERR }).authenticate()).toBe(PamReturn.PERM_DENIED);
  });

  it('PAM_IGNORE under required leaves the stack undecided: an ignored lone module is PERM_DENIED', () => {
    expect(lab(svc('auth required a.so\n'), { a: PamReturn.IGNORE }).authenticate()).toBe(PamReturn.PERM_DENIED);
  });

  it('a module that is not registered answers PAM_MODULE_UNKNOWN, which required turns into a failure', () => {
    const l = lab(svc('auth required missing.so\n'), {});
    expect(l.authenticate()).toBe(PamReturn.MODULE_UNKNOWN);
  });
});

describe('bracket controls and jumps', () => {
  const COMMON_AUTH = [
    'auth [success=1 default=ignore] pam_unix.so nullok',
    'auth requisite pam_deny.so',
    'auth required pam_permit.so',
  ].join('\n');

  it('Ubuntu common-auth: pam_unix success jumps over pam_deny', () => {
    const l = lab(svc(COMMON_AUTH), { pam_unix: PamReturn.SUCCESS, pam_deny: PamReturn.AUTH_ERR, pam_permit: PamReturn.SUCCESS });
    expect(l.authenticate()).toBe(PamReturn.SUCCESS);
    expect(l.calls).toEqual(['pam_unix:auth', 'pam_permit:auth']);
  });

  it('Ubuntu common-auth: pam_unix failure falls through to pam_deny, whose code is returned', () => {
    const l = lab(svc(COMMON_AUTH), { pam_unix: PamReturn.AUTH_ERR, pam_deny: PamReturn.AUTH_ERR, pam_permit: PamReturn.SUCCESS });
    expect(l.authenticate()).toBe(PamReturn.AUTH_ERR);
    expect(l.calls).toEqual(['pam_unix:auth', 'pam_deny:auth']);
  });

  it('module_unknown=ignore lets a stack survive a module the machine does not have (pam_selinux)', () => {
    const l = lab(svc([
      'session [success=ok ignore=ignore module_unknown=ignore default=bad] pam_selinux.so close',
      'session required pam_permit.so',
    ].join('\n')), { pam_permit: PamReturn.SUCCESS });
    expect(l.session()).toBe(PamReturn.SUCCESS);
  });

  it('a jump past the end of the stack is a configuration error and fails', () => {
    expect(lab(svc('auth [success=5 default=bad] a.so\n'), { a: PamReturn.SUCCESS }).authenticate()).toBe(PamReturn.PERM_DENIED);
  });

  it('new_authtok_reqd=done ends the account stack and is returned (common-account)', () => {
    const l = lab(svc([
      'account [success=1 new_authtok_reqd=done default=ignore] pam_unix.so',
      'account requisite pam_deny.so',
      'account required pam_permit.so',
    ].join('\n')), { pam_unix: PamReturn.NEW_AUTHTOK_REQD, pam_deny: PamReturn.AUTH_ERR, pam_permit: PamReturn.SUCCESS });
    expect(l.account()).toBe(PamReturn.NEW_AUTHTOK_REQD);
    expect(l.calls).toEqual(['pam_unix:account']);
  });

  it('control tokens: default= sets every unset code, and a syntax error makes every code bad', () => {
    const parsed = parseBracketControl('success=ok default=die');
    expect(parsed.actions[0]).toBe(-1);
    expect(parsed.actions[7]).toBe(-4);
    const broken = parseBracketControl('success=banana');
    expect(broken.error).not.toBeNull();
    expect(new Set(broken.actions)).toEqual(new Set([-3]));
    expect(parseBracketControl('success=0').error).toBe('expecting non-zero');
  });
});

describe('substack and include', () => {
  it('substack: a sufficient success ends only the substack, the outer stack goes on', () => {
    const l = lab({
      '/etc/pam.d/svc': 'auth required a.so\nauth substack inner\nauth required d.so\n',
      '/etc/pam.d/inner': 'auth sufficient b.so\nauth required c.so\n',
    }, { a: PamReturn.SUCCESS, b: PamReturn.SUCCESS, c: PamReturn.AUTH_ERR, d: PamReturn.SUCCESS });
    expect(l.authenticate()).toBe(PamReturn.SUCCESS);
    expect(l.calls).toEqual(['a:auth', 'b:auth', 'd:auth']);
  });

  it('include: a sufficient success ends the WHOLE stack, because the included lines are in-line', () => {
    const l = lab({
      '/etc/pam.d/svc': 'auth required a.so\nauth include inner\nauth required d.so\n',
      '/etc/pam.d/inner': 'auth sufficient b.so\nauth required c.so\n',
    }, { a: PamReturn.SUCCESS, b: PamReturn.SUCCESS, c: PamReturn.AUTH_ERR, d: PamReturn.AUTH_ERR });
    expect(l.authenticate()).toBe(PamReturn.SUCCESS);
    expect(l.calls).toEqual(['a:auth', 'b:auth']);
  });

  it('an include only brings the lines of its own module type', () => {
    const l = lab({
      '/etc/pam.d/svc': 'auth include common\naccount include common\n',
      '/etc/pam.d/common': 'auth required a.so\naccount required b.so\nsession required c.so\n',
    }, { a: PamReturn.SUCCESS, b: PamReturn.SUCCESS, c: PamReturn.SUCCESS });
    l.authenticate();
    l.account();
    expect(l.calls).toEqual(['a:auth', 'b:account']);
  });

  it('@include brings every type of the named file', () => {
    const l = lab({
      '/etc/pam.d/svc': '@include common-all\n',
      '/etc/pam.d/common-all': 'auth required a.so\nsession required c.so\n',
    }, { a: PamReturn.SUCCESS, c: PamReturn.SUCCESS });
    l.authenticate();
    l.session();
    expect(l.calls).toEqual(['a:auth', 'c:open']);
  });

  it('an include of a missing file installs a handler that fails', () => {
    const l = lab(svc('auth include nowhere\n'), {});
    expect(l.authenticate()).toBe(PamReturn.PERM_DENIED);
    expect(l.logs.some((entry) => /unable to open config for nowhere/.test(entry.message))).toBe(true);
  });
});

describe('frozen chain', () => {
  it('setcred replays the authenticate decision: modules skipped by sufficient stay skipped', () => {
    const l = lab(svc('auth sufficient a.so\nauth required b.so\n'), { a: PamReturn.SUCCESS, b: PamReturn.SUCCESS });
    l.authenticate();
    l.calls.length = 0;
    expect(l.setcred()).toBe(PamReturn.SUCCESS);
    expect(l.calls).toEqual(['a:setcred']);
  });

  it('setcred without a prior authenticate still runs the chain with live results', () => {
    const l = lab(svc('auth required a.so\n'), { a: PamReturn.SUCCESS });
    expect(l.setcred()).toBe(PamReturn.SUCCESS);
  });
});

describe('service file reading', () => {
  it('a missing service file falls back to /etc/pam.d/other', () => {
    const loaded = loadPamStacks('nosuch', { readFile: (path) => (path === '/etc/pam.d/other' ? 'auth required pam_deny.so\n' : null) });
    expect(loaded.service).toBe('other');
    expect(loaded.stacks.auth).toHaveLength(1);
  });

  it('with neither file the stack is empty and the dispatch refuses', () => {
    const l = lab({}, {});
    expect(l.authenticate()).toBe(PamReturn.PERM_DENIED);
    expect(l.logs.some((entry) => /no modules loaded for `svc' service/.test(entry.message))).toBe(true);
  });

  it('comments, blank lines and backslash continuations are read as libpam reads them', () => {
    const loaded = loadPamStacks('svc', { readFile: () => [
      '# a comment',
      '',
      'auth  required   pam_unix.so \\',
      '   nullok try_first_pass   # trailing comment',
      'session optional pam_motd.so motd=/run/motd.dynamic',
    ].join('\n') });
    expect(loaded.stacks.auth[0].args).toEqual(['nullok', 'try_first_pass']);
    expect(loaded.stacks.session[0].module).toBe('pam_motd');
  });

  it('a leading - marks the module silent, and brackets keep spaces and escaped brackets in one argument', () => {
    const loaded = loadPamStacks('svc', { readFile: () => '-session optional pam_systemd.so\nauth required pam_x.so [a b\\]c] d\n' });
    expect(loaded.stacks.session[0].kind).toBe('silent-module');
    expect(loaded.stacks.auth[0].args).toEqual(['a b]c', 'd']);
    expect(tokenizePamLine('[success=1 default=ignore] pam_unix.so')).toEqual(['success=1 default=ignore', 'pam_unix.so']);
  });

  it('an illegal type or a missing control flag becomes a handler that always fails', () => {
    const loaded = loadPamStacks('svc', { readFile: () => 'banana required pam_x.so\nauth\n' });
    expect(loaded.stacks.auth.map((handler) => handler.kind)).toEqual(['must-fail', 'must-fail']);
    expect(loaded.diagnostics.join('\n')).toMatch(/illegal module type: banana/);
  });

  it('a module name drops its directory and extension', () => {
    const loaded = loadPamStacks('svc', { readFile: () => 'auth required /lib/security/pam_unix.so\n' });
    expect(loaded.stacks.auth[0].module).toBe('pam_unix');
  });
});
