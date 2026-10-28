/**
 * Probe: clock summer-time positional grammar and the line settings
 * (exec-timeout, login-timeout, access-class, logging synchronous) declared
 * on the socle.
 * Discriminated with git stash of src/network: 4 of 12 (first batch); second batch: 2 of 6 fail before (`escape-character` bare
 * accepted, `no length`/`no width` leaving the line); the other four are
 * witnesses/non-regressions; eighth batch (archive EXEC commands): 0 of 6 fail before, by design (behaviour-preserving;
 * the migration deletes the second registration on the privileged trie); seventh
 * batch (transport): 1 of 6 fails before (`transport output` was accepted and
 * dropped); the others are witnesses or non-regressions (`no transport output` is
 * trivially true before, nothing was stored). Sixth batch (archive sub-modes): 0 of 5 fail before, by design (the trie adapter
 * already typed these places; the migration removes the duplicate registrations
 * in both shells and the cases pin the behaviour); fifth batch (serial keywords): 2 of 5 fail before (console and aux rendering); the
 * other three are non-regressions (range refusal, vty refusal, removal). Fourth
 * batch (login, password): 0 of 6 fail
 * before, by design: it is a behaviour-preserving migration and the cases pin the
 * behaviour (vty warning, incomplete, stray word, console round trip); third batch: 1 of 5 fails before (`no accounting
 * exec default` left the list in the running-config), the other four are
 * witnesses/non-regressions cases fail before
 * (week and weekday help after recurring, day-or-month help after date,
 * `no logging synchronous` on a vty leaving the line in the config).
 * Pass either way: the accepted recurring and dated rules, the vty
 * exec-timeout round trip, range refusals, access-class removal by
 * direction (witnesses/non-regression), and the Tab zone suggestion
 * already committed.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = {
  executeCommand(c: string): Promise<string>;
  cliHelp(s: string): string;
  cliTabCandidates(s: string): string[];
  powerOn(): void;
};

async function router(...lines: string[]): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli;
  r.powerOn();
  for (const l of ['enable', 'configure terminal', ...lines]) await r.executeCommand(l);
  return r;
}

describe('clock summer-time grammar', () => {
  it('witness: the full recurring rule is accepted', async () => {
    const r = await router();
    const out = await r.executeCommand(
      'clock summer-time CEST recurring last Sun Mar 2:00 last Sun Oct 3:00');
    expect(out).toBe('');
  });
  it('names the week after recurring', async () => {
    const r = await router();
    const help = r.cliHelp('clock summer-time CEST recurring ');
    expect(help).toContain('last');
    expect(help).toContain('<cr>');
  });
  it('names the weekday after the week', async () => {
    const r = await router();
    expect(r.cliHelp('clock summer-time CEST recurring last ')).toContain('Sunday');
  });
  it('refuses a weekday that is not one', async () => {
    const r = await router();
    const out = await r.executeCommand(
      'clock summer-time CEST recurring last Zorglub Mar 2:00 last Sun Oct 3:00');
    expect(out).toContain('Invalid input');
  });
  it('offers the day or the month after date', async () => {
    const r = await router();
    expect(r.cliHelp('clock summer-time CEST date ')).toContain('<1-31>');
  });
  it('accepts the dated rule, day first and month first', async () => {
    const r = await router();
    expect(await r.executeCommand(
      'clock summer-time CEST date 10 Mar 2026 2:00 25 Oct 2026 3:00')).toBe('');
    expect(await r.executeCommand(
      'clock summer-time CEST date Mar 10 2026 2:00 Oct 25 2026 3:00')).toBe('');
  });
  it('suggests summer zone names on Tab', async () => {
    const r = await router();
    expect(r.cliTabCandidates('clock summer-time CE')).toContain('clock summer-time CEST');
  });
});

describe('line settings', () => {
  it('witness: vty exec-timeout appears in the running-config and goes away', async () => {
    const r = await router('line vty 0 4', 'exec-timeout 5 30');
    await r.executeCommand('end');
    expect(await r.executeCommand('show running-config')).toContain('exec-timeout 5 30');
    await r.executeCommand('configure terminal');
    await r.executeCommand('line vty 0 4');
    await r.executeCommand('no exec-timeout');
    await r.executeCommand('end');
    expect(await r.executeCommand('show running-config')).not.toContain('exec-timeout 5 30');
  });
  it('refuses an exec-timeout out of range', async () => {
    const r = await router('line vty 0 4');
    expect(await r.executeCommand('exec-timeout 99999')).toContain('Invalid input');
  });
  it('refuses a login-timeout of zero', async () => {
    const r = await router('line vty 0 4');
    expect(await r.executeCommand('login-timeout 0')).toContain('Invalid input');
  });
  it('stores access-class in both directions and removes only the one named', async () => {
    const r = await router('line vty 0 4', 'access-class 10 in', 'access-class 11 out',
      'no access-class 11 out');
    await r.executeCommand('end');
    const config = await r.executeCommand('show running-config');
    expect(config).toContain('access-class 10 in');
    expect(config).not.toContain('access-class 11 out');
  });
  it('clears logging synchronous on a vty', async () => {
    const r = await router('line vty 0 4', 'logging synchronous', 'no logging synchronous');
    await r.executeCommand('end');
    expect(await r.executeCommand('show running-config')).not.toContain('logging synchronous');
  });
});

describe('line settings, second batch', () => {
  const config = async (r: Cli): Promise<string> => {
    await r.executeCommand('end');
    return r.executeCommand('show running-config');
  };
  it('witness: session-timeout is stored on a vty', async () => {
    const r = await router('line vty 0 4', 'session-timeout 20');
    expect(await config(r)).toContain('session-timeout 20');
  });
  it('refuses a rotary group out of range', async () => {
    const r = await router('line vty 0 4');
    expect(await r.executeCommand('rotary 101')).toContain('Invalid input');
  });
  it('refuses escape-character without its value', async () => {
    const r = await router('line vty 0 4');
    expect(await r.executeCommand('escape-character')).toContain('Incomplete');
  });
  it('clears length and width with no', async () => {
    const r = await router('line vty 0 4', 'length 30', 'width 100', 'no length', 'no width');
    const out = await config(r);
    expect(out).not.toContain(' length 30');
    expect(out).not.toContain(' width 100');
  });
  it('stores a vty privilege level and clears it', async () => {
    const r = await router('line vty 0 4', 'privilege level 7');
    expect(await config(r)).toContain('privilege level 7');
    await r.executeCommand('configure terminal');
    await r.executeCommand('line vty 0 4');
    await r.executeCommand('no privilege level');
    expect(await config(r)).not.toContain('privilege level 7');
  });
  it('witness: console history size is stored', async () => {
    const r = await router('line console 0', 'history size 50');
    expect(await config(r)).toContain('history size 50');
  });
});

describe('line settings, third batch', () => {
  const config = async (r: Cli): Promise<string> => {
    await r.executeCommand('end');
    return r.executeCommand('show running-config');
  };
  it('witness: accounting exec is stored on a vty', async () => {
    const r = await router('line vty 0 4', 'accounting exec default');
    expect(await config(r)).toContain('accounting exec default');
  });
  it('removes the accounting list it is asked to remove', async () => {
    const r = await router('line vty 0 4', 'accounting exec default',
      'authorization exec default', 'no accounting exec default');
    const out = await config(r);
    expect(out).not.toContain('accounting exec default');
    expect(out).toContain('authorization exec default');
  });
  it('refuses a command level out of range', async () => {
    const r = await router('line vty 0 4');
    expect(await r.executeCommand('accounting commands 16 default')).toContain('Invalid input');
  });
  it('answers incomplete to accounting exec without its list', async () => {
    const r = await router('line vty 0 4');
    expect(await r.executeCommand('accounting exec')).toContain('Incomplete');
  });
  it('witness: motd-banner round trip on a vty', async () => {
    const r = await router('line vty 0 4', 'no motd-banner');
    expect(await config(r)).toContain('no motd-banner');
  });
});

describe('line settings, fourth batch (login and password)', () => {
  const config = async (r: Cli): Promise<string> => {
    await r.executeCommand('end');
    return r.executeCommand('show running-config');
  };
  it('witness: vty password and login round trip', async () => {
    const r = await router('line vty 0 4', 'password secret1', 'login');
    const out = await config(r);
    expect(out).toContain('password');
    expect(out).toContain(' login');
  });
  it('warns when login is set with no password', async () => {
    const r = await router('line vty 0 4');
    expect(await r.executeCommand('login')).toContain('until \'password\' is set');
  });
  it('answers incomplete to password with no text', async () => {
    const r = await router('line vty 0 4');
    expect(await r.executeCommand('password')).toContain('Incomplete');
  });
  it('refuses a stray word after login authentication <list>', async () => {
    const r = await router('line vty 0 4');
    expect(await r.executeCommand('login authentication a b')).toContain('Invalid input');
  });
  it('names the method list place after login authentication', async () => {
    const r = await router('line vty 0 4');
    expect(r.cliHelp('login authentication ')).toContain('default');
  });
  it('witness: console login local is rendered and no login local removes it', async () => {
    const r = await router('line console 0', 'login local');
    expect(await config(r)).toContain(' login local');
    await r.executeCommand('configure terminal');
    await r.executeCommand('line console 0');
    await r.executeCommand('no login local');
    expect(await config(r)).not.toContain(' login local');
  });
});

describe('line settings, fifth batch (serial keywords)', () => {
  const config = async (r: Cli): Promise<string> => {
    await r.executeCommand('end');
    return r.executeCommand('show running-config');
  };
  it('renders the console serial settings it was given', async () => {
    const r = await router('line console 0', 'speed 115200', 'parity even', 'stopbits 2');
    const out = await config(r);
    expect(out).toContain(' speed 115200');
    expect(out).toContain(' parity even');
    expect(out).toContain(' stopbits 2');
  });
  it('removes a serial setting with no', async () => {
    const r = await router('line console 0', 'speed 115200', 'no speed');
    expect(await config(r)).not.toContain(' speed 115200');
  });
  it('refuses a speed that is not offered', async () => {
    const r = await router('line console 0');
    expect(await r.executeCommand('speed 1234')).toContain('Invalid input');
  });
  it('refuses a serial keyword on a vty', async () => {
    const r = await router('line vty 0 4');
    expect(await r.executeCommand('speed 9600')).toContain('Invalid input');
  });
  it('renders the aux serial settings', async () => {
    const r = await router('line aux 0', 'flowcontrol hardware');
    expect(await config(r)).toContain(' flowcontrol hardware');
  });
});

describe('archive sub-modes', () => {
  it('witness: archive path and maximum are applied', async () => {
    const r = await router('archive', 'path flash:backup', 'maximum 5');
    await r.executeCommand('end');
    const out = await r.executeCommand('show archive');
    expect(out).toContain('flash:backup');
  });
  it('refuses a maximum out of range', async () => {
    const r = await router('archive');
    expect(await r.executeCommand('maximum 15')).toContain('Invalid input');
  });
  it('answers incomplete to path without its value', async () => {
    const r = await router('archive');
    expect(await r.executeCommand('path')).toContain('Incomplete');
  });
  it('enters the log sub-mode and accepts the syslog format', async () => {
    const r = await router('archive', 'log config');
    expect(await r.executeCommand('notify syslog contenttype xml')).toBe('');
    expect(await r.executeCommand('notify syslog contenttype zorglub')).toContain('Invalid input');
  });
  it('refuses a log buffer size of zero', async () => {
    const r = await router('archive', 'log config');
    expect(await r.executeCommand('logging size 0')).toContain('Invalid input');
  });
});

describe('line transport', () => {
  const config = async (r: Cli): Promise<string> => {
    await r.executeCommand('end');
    return r.executeCommand('show running-config');
  };
  it('witness: vty transport input is rendered', async () => {
    const r = await router('line vty 0 4', 'transport input ssh');
    expect(await config(r)).toContain(' transport input ssh');
  });
  it('stores and renders transport output on a vty', async () => {
    const r = await router('line vty 0 4', 'transport output none');
    expect(await config(r)).toContain(' transport output none');
  });
  it('removes transport output with no', async () => {
    const r = await router('line vty 0 4', 'transport output none', 'no transport output');
    expect(await config(r)).not.toContain(' transport output none');
  });
  it('does not let a console transport input rewrite the vty lines', async () => {
    const r = await router('line vty 0 4', 'transport input ssh', 'exit', 'line console 0',
      'transport input none');
    const out = await config(r);
    expect(out).toContain(' transport input ssh');
  });
  it('refuses transport preferred and a protocol that does not exist', async () => {
    const r = await router('line vty 0 4');
    expect(await r.executeCommand('transport preferred ssh')).toContain('Invalid input');
    expect(await r.executeCommand('transport input zorglub')).toContain('Invalid input');
  });
  it('answers incomplete to transport input alone', async () => {
    const r = await router('line vty 0 4');
    expect(await r.executeCommand('transport input')).toContain('Incomplete');
  });
});

describe('archive EXEC commands', () => {
  it('witness: show archive answers on a fresh router', async () => {
    const r = await router('end');
    expect(await r.executeCommand('show archive')).toContain('No archives configured');
  });
  it('archive config without a path says so', async () => {
    const r = await router('end');
    expect(await r.executeCommand('archive config')).toContain('Archive path not configured');
  });
  it('archives the running configuration once a path is set', async () => {
    const r = await router('archive', 'path flash:bk', 'end');
    expect(await r.executeCommand('archive config')).toContain('Writing flash:bk');
  });
  it('answers incomplete to configure replace with no file', async () => {
    const r = await router('end');
    expect(await r.executeCommand('configure replace')).toContain('Incomplete');
  });
  it('refuses an unknown configure replace option', async () => {
    const r = await router('end');
    expect(await r.executeCommand('configure replace flash:x zorglub')).toContain('Invalid input');
  });
  it('lists the archive log statistics', async () => {
    const r = await router('end');
    expect(await r.executeCommand('show archive log config statistics')).toContain('Config Log');
  });
});

/*
 * Ninth batch (ntp server options as an option bag): 2 of 6 fail before (the help after `key` and
 * after `version` named nothing); the other four are witnesses/non-regressions.
 */
describe('ntp server options named by position', () => {
  it('witness: a server with key, version and prefer is stored', async () => {
    const r = await router('ntp server 10.0.0.9 version 3 prefer');
    await r.executeCommand('end');
    expect(await r.executeCommand('show running-config')).toContain('ntp server 10.0.0.9');
  });
  it('names the key number after key', async () => {
    const r = await router();
    expect(r.cliHelp('ntp server 10.0.0.9 key ')).toContain('<1-4294967295>');
  });
  it('names the version range after version', async () => {
    const r = await router();
    expect(r.cliHelp('ntp server 10.0.0.9 version ')).toContain('<1-4>');
  });
  it('refuses a version out of range at the value', async () => {
    const r = await router();
    expect(await r.executeCommand('ntp server 10.0.0.9 version 5')).toContain('Invalid input');
  });
  it('refuses a poll exponent out of range', async () => {
    const r = await router();
    expect(await r.executeCommand('ntp server 10.0.0.9 minpoll 3')).toContain('Invalid input');
  });
  it('does not offer an option already given', async () => {
    const r = await router();
    expect(r.cliHelp('ntp server 10.0.0.9 prefer ')).not.toMatch(/^\s*prefer\b/m);
  });
});

/*
 * Tenth batch (aaa methods named per phase): 2 of 4 fail before (no method was named after the list
 * name, and nothing kept `local` out of accounting help); the other two are witnesses.
 */
describe('aaa method lists name their methods', () => {
  it('witness: a full authentication list is accepted', async () => {
    const r = await router();
    expect(await r.executeCommand('aaa authentication login default local none')).toBe('');
  });
  it('names the authentication methods after the list name', async () => {
    const r = await router();
    const help = r.cliHelp('aaa authentication login default ');
    expect(help).toContain('local');
    expect(help).toContain('group');
  });
  it('does not offer local in accounting', async () => {
    const r = await router();
    const help = r.cliHelp('aaa accounting exec default start-stop ');
    expect(help).toContain('group');
    expect(help).not.toMatch(/^\s*local\b/m);
  });
  it('refuses a method of another phase', async () => {
    const r = await router();
    expect(await r.executeCommand('aaa accounting exec default start-stop local')).toContain('Invalid input');
  });
});

/*
 * Eleventh batch (snmp-server host by position): 2 of 6 fail before (the help after `version` and after
 * `version 3` named nothing); the other four are witnesses/non-regressions.
 */
describe('snmp-server host names its values by position', () => {
  it('witness: the legacy form stores the community', async () => {
    const r = await router('snmp-server host 10.0.0.9 public');
    await r.executeCommand('end');
    expect(await r.executeCommand('show running-config')).toContain('snmp-server host 10.0.0.9');
  });
  it('names the versions after version', async () => {
    const r = await router();
    const help = r.cliHelp('snmp-server host 10.0.0.9 version ');
    expect(help).toContain('2c');
    expect(help).toContain('3');
  });
  it('names the security levels after version 3', async () => {
    const r = await router();
    const help = r.cliHelp('snmp-server host 10.0.0.9 version 3 ');
    expect(help).toContain('noauth');
    expect(help).toContain('priv');
  });
  it('refuses a version that does not exist', async () => {
    const r = await router();
    expect(await r.executeCommand('snmp-server host 10.0.0.9 version 4 public')).toContain('Invalid input');
  });
  it('accepts a typed v2c host and a v3 host', async () => {
    const r = await router();
    expect(await r.executeCommand('snmp-server host 10.0.0.9 traps version 2c public')).toBe('');
    expect(await r.executeCommand('snmp-server host 10.0.0.10 informs version 3 priv admin')).toBe('');
  });
  it('removes a host with no', async () => {
    const r = await router('snmp-server host 10.0.0.9 public', 'no snmp-server host 10.0.0.9');
    await r.executeCommand('end');
    expect(await r.executeCommand('show running-config')).not.toContain('snmp-server host 10.0.0.9');
  });
});

/*
 * Twelfth batch (outgoing session commands): 0 of 5 fail before, by design. The commands were
 * registered twice (the trie and the adapter); the cases pin the behaviour the single declaration
 * must keep.
 */
describe('outgoing session commands', () => {
  it('where answers on a fresh router', async () => {
    const r = await router('end');
    expect(await r.executeCommand('where')).toContain('No connections open');
  });
  it('disconnect with no connection says so', async () => {
    const r = await router('end');
    expect(await r.executeCommand('disconnect')).toContain('No connections open');
  });
  it('disconnect of an unknown number says so', async () => {
    const r = await router('end');
    expect(await r.executeCommand('disconnect 4')).toContain('No information for this connection');
  });
  it('resume with nothing open says so', async () => {
    const r = await router('end');
    expect(await r.executeCommand('resume')).toContain('No connection open');
  });
  it('lists the verbs in help', async () => {
    const r = await router('end');
    const help = r.cliHelp('');
    for (const verb of ['telnet', 'ssh', 'where', 'resume', 'disconnect']) {
      expect(help).toContain(verb);
    }
  });
});

/*
 * Thirteenth batch (shared show commands): 0 of 8 fail before, by design. These commands were
 * registered twice (the trie and the adapter) and one table (SHOW_PARTAGEES) listed names that no
 * longer existed (`terminal`, `show ntp packets`); the cases pin the behaviour of the single
 * declaration, including the two privilege rules the old scoped trie applied.
 */
describe('shared show commands', () => {
  it('witness: show hosts answers in privileged mode', async () => {
    const r = await router('end');
    expect(await r.executeCommand('show hosts')).toContain('Name servers');
  });
  it('show snmp is refused at the user prompt and answered at the privileged one', async () => {
    const r = await router('end');
    expect(await r.executeCommand('show snmp')).not.toContain('Invalid input');
    await r.executeCommand('disable');
    expect(await r.executeCommand('show snmp')).toContain('Invalid input');
  });
  it('show cdp neighbors answers', async () => {
    const r = await router('end');
    expect(await r.executeCommand('show cdp neighbors')).not.toContain('Invalid input');
  });
  it('show parser view answers with the current view', async () => {
    const r = await router('end');
    expect(await r.executeCommand('show parser view')).toContain('Current view is');
  });
  it('show parser view refuses an unknown scope', async () => {
    const r = await router('end');
    expect(await r.executeCommand('show parser view zorglub')).toContain('Invalid input');
  });
  it('names the cdp forms in help', async () => {
    const r = await router('end');
    const help = r.cliHelp('show cdp ');
    expect(help).toContain('neighbors');
    expect(help).toContain('traffic');
  });
  it('show interfaces counters errors answers', async () => {
    const r = await router('end');
    expect(await r.executeCommand('show interfaces counters errors')).toContain('Port');
  });
  it('show aaa answers', async () => {
    const r = await router('end');
    expect(await r.executeCommand('show aaa')).not.toContain('Invalid input');
  });
});

/*
 * Fourteenth batch (flash: file commands): 0 of 7 fail before, by design. dir, more, verify, delete,
 * mkdir, rmdir, squeeze and pwd were registered twice (the trie through registerCommonShowCommands
 * and the adapter); the cases pin the behaviour of the single declaration.
 */
describe('file system commands', () => {
  it('witness: dir flash: lists the directory', async () => {
    const r = await router('end');
    expect(await r.executeCommand('dir flash:')).toContain('Directory of');
  });
  it('pwd answers flash:', async () => {
    const r = await router('end');
    expect(await r.executeCommand('pwd')).toBe('flash:');
  });
  it('mkdir then rmdir round trip', async () => {
    const r = await router('end');
    expect(await r.executeCommand('mkdir flash:backups')).toContain('Created dir flash:backups');
    expect(await r.executeCommand('rmdir flash:backups')).toContain('Removed dir flash:backups');
  });
  it('more on a missing file says so', async () => {
    const r = await router('end');
    expect(await r.executeCommand('more flash:absent.txt')).toContain('No such file or directory');
  });
  it('more with no file is incomplete', async () => {
    const r = await router('end');
    expect(await r.executeCommand('more')).toContain('Incomplete');
  });
  it('verify accepts the /md5 option before the file name', async () => {
    const r = await router('end');
    expect(await r.executeCommand('verify /md5 flash:absent.bin')).toContain('No such file or directory');
  });
  it('squeeze of an unknown device is refused with its own wording', async () => {
    const r = await router('end');
    expect(await r.executeCommand('squeeze usb0:')).toContain('No such device');
  });
});

/*
 * Fifteenth batch (ip http family): 0 of 7 fail before, by design. The commands were registered
 * twice (the global config trie and the adapter) and the port was range-checked twice (the
 * handler and the typed place); one declaration and one check remain. The cases pin the behaviour.
 */
describe('ip http server family', () => {
  const config = async (r: Cli): Promise<string> => {
    await r.executeCommand('end');
    return r.executeCommand('show running-config');
  };
  it('witness: ip http server is rendered and no ip http server removes it', async () => {
    const r = await router('ip http server');
    expect(await config(r)).toContain('ip http server');
    await r.executeCommand('configure terminal');
    await r.executeCommand('no ip http server');
    expect(await config(r)).not.toMatch(/^ip http server$/m);
  });
  it('stores a port and restores 80 with no', async () => {
    const r = await router('ip http port 8080');
    expect(await config(r)).toContain('ip http port 8080');
    await r.executeCommand('configure terminal');
    await r.executeCommand('no ip http port');
    expect(await config(r)).not.toContain('ip http port 8080');
  });
  it('refuses a port out of range', async () => {
    const r = await router();
    expect(await r.executeCommand('ip http port 70000')).toContain('Invalid input');
  });
  it('answers incomplete to ip http port alone', async () => {
    const r = await router();
    expect(await r.executeCommand('ip http port')).toContain('Incomplete');
  });
  it('refuses an unknown authentication method', async () => {
    const r = await router();
    expect(await r.executeCommand('ip http authentication zorglub')).toContain('Invalid input');
  });
  it('refuses max-connections out of range', async () => {
    const r = await router();
    expect(await r.executeCommand('ip http max-connections 99')).toContain('Invalid input');
  });
  it('requires the three timeout-policy words in order', async () => {
    const r = await router();
    expect(await r.executeCommand('ip http timeout-policy life 5 idle 5 requests 5')).toContain('Invalid input');
    expect(await r.executeCommand('ip http timeout-policy idle 5 life 5 requests 5')).toBe('');
  });
});

/*
 * Sixteenth batch (ip domain / ip name-server / ip host / ip dns): 0 of 9 fail before, by design.
 * The family was a trie registration adapted at build time; it is now declared per command, with
 * typed places (the spoofing address is an IP_ADDR place, the retry and timeout counts are ranges).
 */
describe('dns client and server configuration', () => {
  const config = async (r: Cli): Promise<string> => {
    await r.executeCommand('end');
    return r.executeCommand('show running-config');
  };
  it('witness: a domain name is stored and removed', async () => {
    const r = await router('ip domain-name example.com');
    expect(await config(r)).toContain('ip domain-name example.com');
    await r.executeCommand('configure terminal');
    await r.executeCommand('no ip domain-name');
    expect(await config(r)).not.toContain('example.com');
  });
  it('stores name servers', async () => {
    const r = await router('ip name-server 10.0.0.53 10.0.0.54');
    expect(await config(r)).toContain('ip name-server 10.0.0.53');
  });
  it('refuses a name server that is not an address', async () => {
    const r = await router();
    expect(await r.executeCommand('ip name-server zorglub')).toContain('Invalid input');
  });
  it('adds and removes a host table entry', async () => {
    const r = await router('ip host r2 10.0.0.2');
    expect(await config(r)).toContain('ip host r2 10.0.0.2');
    await r.executeCommand('configure terminal');
    await r.executeCommand('no ip host r2');
    expect(await config(r)).not.toContain('ip host r2 10.0.0.2');
  });
  it('answers incomplete to ip host with no address', async () => {
    const r = await router();
    expect(await r.executeCommand('ip host r2')).toContain('Incomplete');
  });
  it('refuses a retry count out of range', async () => {
    const r = await router();
    expect(await r.executeCommand('ip domain retry 101')).toContain('Invalid input');
  });
  it('restores the default timeout with no', async () => {
    const r = await router('ip domain timeout 9', 'no ip domain timeout');
    expect(await config(r)).not.toContain('ip domain timeout 9');
  });
  it('refuses a spoofing address that is not one', async () => {
    const r = await router();
    expect(await r.executeCommand('ip dns spoofing zorglub')).toContain('Invalid input');
  });
  it('names source-interface after ip domain-lookup', async () => {
    const r = await router();
    expect(r.cliHelp('ip domain-lookup ')).toContain('source-interface');
  });
});

/*
 * Seventeenth batch (hostname, boot, line entry): 0 of 10 fail before, by design. These were the
 * remains of registerCommonConfigCommands, registered on the config trie and re-adapted three
 * times (line, identity and boot, services); that function and the three adapters are gone. The
 * line head is now a typed path (kind keyword, then a ranged first and last), so the three
 * hand-written checks of analyserTeteLigne are the parser's.
 */
describe('hostname, boot and line entry', () => {
  it('witness: hostname changes the prompt name and no hostname restores it', async () => {
    const r = await router('hostname EDGE1');
    expect(await r.executeCommand('show running-config')).toContain('hostname EDGE1');
    await r.executeCommand('no hostname');
    expect(await r.executeCommand('show running-config')).not.toContain('hostname EDGE1');
  });
  it('answers incomplete to hostname alone', async () => {
    const r = await router();
    expect(await r.executeCommand('hostname')).toContain('Incomplete');
  });
  it('line vty 0 4 enters the line mode', async () => {
    const r = await router('line vty 0 4');
    expect(await r.executeCommand('exec-timeout 5 0')).toBe('');
  });
  it('refuses a line number out of range', async () => {
    const r = await router();
    expect(await r.executeCommand('line vty 99')).toContain('Invalid input');
  });
  it('refuses a reversed range', async () => {
    const r = await router();
    expect(await r.executeCommand('line vty 5 2')).toContain('Invalid input');
  });
  it('refuses an unknown line kind', async () => {
    const r = await router();
    expect(await r.executeCommand('line zorglub 0')).toContain('Invalid input');
  });
  it('answers incomplete to line vty alone', async () => {
    const r = await router();
    expect(await r.executeCommand('line vty')).toContain('Incomplete');
  });
  it('accepts the con abbreviation', async () => {
    const r = await router('line con 0');
    expect(await r.executeCommand('login local')).toBe('');
  });
  it('no line vty removes the block and refuses the console', async () => {
    const r = await router('line vty 0 4', 'exit', 'no line vty 0 4');
    expect(await r.executeCommand('no line console 0')).toContain("Can't delete console line");
    await r.executeCommand('end');
    expect(await r.executeCommand('show running-config')).not.toContain('line vty 0 4');
  });
  it('boot system stores an image and no boot system removes it', async () => {
    const r = await router('boot system flash:image.bin', 'end');
    expect(await r.executeCommand('show boot')).toContain('flash:image.bin');
    await r.executeCommand('configure terminal');
    await r.executeCommand('no boot system');
    await r.executeCommand('end');
    expect(await r.executeCommand('show boot')).not.toContain('flash:image.bin');
  });
});

/*
 * Eighteenth batch (arp): the cases that move are named. The old adapter judged the address with a
 * regular expression that also accepts 999.999.999.999, then the handler judged it a second time
 * (`% Invalid IP address "x"`); the places are now IP_ADDR and MAC_ADDR values, refused at the
 * caret. Fails before: the address that is not one (the old answer is the handler's message, not
 * the caret), and the hardware address that is not one. Pass either way: the witnesses.
 */
describe('arp commands', () => {
  it('witness: a static entry is added and removed', async () => {
    const r = await router('arp 10.0.0.9 aaaa.bbbb.cccc arpa');
    await r.executeCommand('end');
    expect(await r.executeCommand('show arp')).toContain('10.0.0.9');
    await r.executeCommand('configure terminal');
    await r.executeCommand('no arp 10.0.0.9');
    await r.executeCommand('end');
    expect(await r.executeCommand('show arp')).not.toContain('10.0.0.9');
  });
  it('refuses an address with an octet out of range at the caret', async () => {
    const r = await router();
    const out = await r.executeCommand('arp 999.1.1.1 aaaa.bbbb.cccc arpa');
    expect(out).toContain("Invalid input detected at '^' marker");
  });
  it('refuses a hardware address that is not one at the caret', async () => {
    const r = await router();
    const out = await r.executeCommand('arp 10.0.0.9 zorglub arpa');
    expect(out).toContain("Invalid input detected at '^' marker");
  });
  it('answers incomplete to arp with an address only', async () => {
    const r = await router();
    expect(await r.executeCommand('arp 10.0.0.9')).toContain('Incomplete');
  });
  it('witness: show arp answers on a fresh router', async () => {
    const r = await router('end');
    expect(await r.executeCommand('show arp')).not.toContain('Invalid input');
    expect(await r.executeCommand('show ip arp')).not.toContain('Invalid input');
  });
});

/*
 * Nineteenth batch (show prefix-list / route-map): the cases that move are named. The old filter
 * `/^detail|summary$/` binds as (^detail)|(summary$), so a prefix-list whose name merely starts
 * with detail or ends with summary was taken for a view keyword and not looked up; the filter is
 * now ^(detail|summary)$. Fails before: the list named detail_edge (1 of 4). The rest are witnesses.
 */
describe('show prefix-list and route-map', () => {
  it('witness: show route-map answers', async () => {
    const r = await router('end');
    expect(await r.executeCommand('show route-map')).not.toContain('Invalid input');
  });
  it('refuses a second word after show route-map NAME', async () => {
    const r = await router('end');
    expect(await r.executeCommand('show route-map A B')).toContain('Invalid input');
  });
  it('finds a prefix-list whose name starts with detail', async () => {
    const r = await router('ip prefix-list OTHER seq 5 permit 192.168.0.0/16',
      'ip prefix-list detail_edge seq 5 permit 10.0.0.0/8', 'end');
    const out = await r.executeCommand('show ip prefix-list detail_edge');
    expect(out).toContain('detail_edge');
    expect(out).not.toContain('OTHER');
  });
  it('witness: show ip prefix-list detail answers', async () => {
    const r = await router('ip prefix-list EDGE seq 5 permit 10.0.0.0/8', 'end');
    expect(await r.executeCommand('show ip prefix-list detail')).not.toContain('Invalid input');
  });
});

/*
 * Twentieth batch (show access-lists): 0 of 4 fail before, by design. The three show verbs were
 * registered on the trie and through the adapter; one declaration remains. The cases pin the
 * behaviour, including that a second word is refused at the caret.
 */
describe('show access-lists', () => {
  it('witness: a named list is shown', async () => {
    const r = await router('ip access-list standard EDGE', 'permit 10.0.0.0 0.255.255.255', 'end');
    expect(await r.executeCommand('show access-lists EDGE')).toContain('EDGE');
  });
  it('show ip access-lists answers', async () => {
    const r = await router('end');
    expect(await r.executeCommand('show ip access-lists')).not.toContain('Invalid input');
  });
  it('show ipv6 access-lists answers', async () => {
    const r = await router('end');
    expect(await r.executeCommand('show ipv6 access-lists')).not.toContain('Invalid input');
  });
  it('refuses a second word', async () => {
    const r = await router('end');
    expect(await r.executeCommand('show access-lists A B')).toContain('Invalid input');
  });
});

/*
 * Twenty-first batch (key chain): the lifetimes move. The old handler split a lifetime at a
 * heuristic (the first `infinite` or the second time-of-day token, else the middle) and stored any
 * words; `accept-lifetime garbage` was accepted and rendered. The lifetime is now typed
 * (hh:mm:ss day-or-month month-or-day year, then infinite, duration <seconds> or an end time).
 * Fails before: the garbage lifetime refusal and the missing-end refusal (2 of 7). The rest are
 * witnesses: the chain, key, key-string and show round trips.
 */
describe('key chains', () => {
  const chainWithKey = (...more: string[]) =>
    router('key chain KC', 'key 1', 'key-string secret1', ...more);
  it('witness: a key chain, a key and a key string are stored and shown', async () => {
    const r = await chainWithKey('end');
    const out = await r.executeCommand('show key chain KC');
    expect(out).toContain('Key-chain KC:');
    expect(out).toContain('key 1');
  });
  it('witness: no key chain removes it', async () => {
    const r = await router('key chain KC', 'exit', 'no key chain KC', 'end');
    expect(await r.executeCommand('show key chain KC')).toContain('not found');
  });
  it('witness: a lifetime with an end time is stored', async () => {
    const r = await chainWithKey(
      'accept-lifetime 10:00:00 Jan 1 2026 12:00:00 Dec 31 2026', 'end');
    expect(await r.executeCommand('show key chain KC')).toContain('accept lifetime 10:00:00 Jan 1 2026');
  });
  it('accepts infinite and duration', async () => {
    const r = await chainWithKey();
    expect(await r.executeCommand('send-lifetime 10:00:00 Jan 1 2026 infinite')).toBe('');
    expect(await r.executeCommand('send-lifetime 10:00:00 Jan 1 2026 duration 3600')).toBe('');
  });
  it('refuses a lifetime that is not a date', async () => {
    const r = await chainWithKey();
    expect(await r.executeCommand('accept-lifetime garbage')).toContain('Invalid input');
  });
  it('refuses a lifetime with no end', async () => {
    const r = await chainWithKey();
    expect(await r.executeCommand('accept-lifetime 10:00:00 Jan 1 2026')).not.toBe('');
  });
  it('refuses a send-id out of range', async () => {
    const r = await chainWithKey();
    expect(await r.executeCommand('send-id 300')).toContain('Invalid input');
  });
});

/*
 * Twenty-second batch (track list submode): the options are typed. The handlers scanned the word
 * list for up, down, weight and not and parsed with parseInt, so `delay up` (no value) and
 * `delay up 999` were taken for something; `object 5 weight` stored NaN. Measured with git stash:
 * 1 of 7 fails before (the bare threshold, which stored nothing and answered empty); the range and
 * weight refusals were already given by the adapter's typed places, so they pass either way as
 * non-regressions, like the witnesses.
 */
describe('track list submode', () => {
  const list = (...more: string[]) => router('track 10 list boolean and', ...more);
  it('witness: a boolean list takes an object with not', async () => {
    const r = await list();
    expect(await r.executeCommand('object 1 not')).toBe('');
  });
  it('witness: a delay is stored', async () => {
    const r = await list();
    expect(await r.executeCommand('delay up 10 down 20')).toBe('');
  });
  it('witness: no delay answers', async () => {
    const r = await list('delay up 10');
    expect(await r.executeCommand('no delay')).toBe('');
  });
  it('refuses a delay out of range', async () => {
    const r = await list();
    expect(await r.executeCommand('delay up 999')).toContain('Invalid input');
  });
  it('refuses a weight with no value', async () => {
    const r = await list();
    expect(await r.executeCommand('object 5 weight')).toMatch(/Incomplete|Invalid input/);
  });
  it('answers incomplete to a bare threshold', async () => {
    const r = await list();
    expect(await r.executeCommand('threshold')).toContain('Incomplete');
  });
  it('witness: threshold up and down are accepted', async () => {
    const r = await list();
    expect(await r.executeCommand('threshold up 2 down 1')).toBe('');
  });
});

/*
 * Twenty-third batch (igmp interface and show): 0 of 7 fail before, by design. The commands were
 * registered on the config-if trie and through the adapter; one declaration remains and the cases
 * pin the behaviour, including the messages other tests rely on (IGMPv3 not supported, invalid
 * group address).
 */
describe('igmp', () => {
  const onInterface = (...more: string[]) =>
    router('interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', ...more);
  it('witness: ip igmp join-group is stored and no ip igmp join-group removes it', async () => {
    const r = await onInterface('ip igmp join-group 239.1.1.1');
    await r.executeCommand('end');
    expect(await r.executeCommand('show running-config')).toContain('ip igmp join-group 239.1.1.1');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('no ip igmp join-group 239.1.1.1');
    await r.executeCommand('end');
    expect(await r.executeCommand('show running-config')).not.toContain('ip igmp join-group 239.1.1.1');
  });
  it('says IGMPv3 is not supported', async () => {
    const r = await onInterface();
    expect(await r.executeCommand('ip igmp version 3')).toContain('IGMPv3 is not supported');
  });
  it('rejects a group that is not multicast', async () => {
    const r = await onInterface();
    expect(await r.executeCommand('ip igmp join-group 10.0.0.1')).toContain('Invalid group address');
  });
  it('answers incomplete to join-group alone', async () => {
    const r = await onInterface();
    expect(await r.executeCommand('ip igmp join-group')).toContain('Incomplete');
  });
  it('witness: version 1 is rendered and no ip igmp version restores v2', async () => {
    const r = await onInterface('ip igmp version 1');
    await r.executeCommand('end');
    expect(await r.executeCommand('show running-config')).toContain('ip igmp version 1');
  });
  it('show ip igmp interface answers', async () => {
    const r = await onInterface('ip igmp', 'end');
    expect(await r.executeCommand('show ip igmp interface')).toContain('IGMP is enabled');
  });
  it('show ip igmp groups answers with its header', async () => {
    const r = await onInterface('ip igmp', 'end');
    expect(await r.executeCommand('show ip igmp groups')).toContain('IGMP Connected Group Membership');
  });
});

/*
 * Twenty-fourth batch (bfd interface): 0 of 4 fail before, by design. bfd interval and bfd neighbor
 * were registered on the config-if trie and through the adapter; one declaration remains.
 */
describe('bfd interface commands', () => {
  const onInterface = (...more: string[]) =>
    router('interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', ...more);
  it('witness: bfd neighbor creates a session', async () => {
    const r = await onInterface('bfd neighbor 10.0.0.2', 'end');
    expect(await r.executeCommand('show bfd neighbors')).toContain('10.0.0.2');
  });
  it('no bfd neighbor removes it', async () => {
    const r = await onInterface('bfd neighbor 10.0.0.2', 'no bfd neighbor 10.0.0.2', 'end');
    expect(await r.executeCommand('show bfd neighbors')).not.toContain('10.0.0.2');
  });
  it('refuses a neighbor that is not an address', async () => {
    const r = await onInterface();
    expect(await r.executeCommand('bfd neighbor zorglub')).toContain('Invalid neighbor');
  });
  it('bfd interval answers incomplete alone', async () => {
    const r = await onInterface();
    expect(await r.executeCommand('bfd interval')).toContain('Incomplete');
  });
});

/*
 * Twenty-fifth batch (addresses judged by a regular expression): ^\d+\.\d+\.\d+\.\d+$ accepts
 * 999.1.1.1. bfd neighbor 999.1.1.1 created a session, ip pim rp-address 999.1.1.1 stored a
 * rendezvous point, and ping ... source 999.1.1.1 was sent from an address no interface can hold.
 * The three now judge with isValidIPv4. Fails before: the three refusals (3 of 4); the fourth is
 * the witness that a valid RP address is still stored.
 */
describe('addresses are judged as addresses', () => {
  it('bfd neighbor refuses 999.1.1.1', async () => {
    const r = await router('interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0');
    expect(await r.executeCommand('bfd neighbor 999.1.1.1')).toContain('Invalid neighbor');
    await r.executeCommand('end');
    expect(await r.executeCommand('show bfd neighbors')).not.toContain('999.1.1.1');
  });
  it('ip pim rp-address refuses 999.1.1.1 and keeps a valid one', async () => {
    const r = await router('ip multicast-routing');
    expect(await r.executeCommand('ip pim rp-address 999.1.1.1')).toContain('Invalid RP address');
    expect(await r.executeCommand('ip pim rp-address 10.0.0.9')).toBe('');
  });
  it('ping source refuses 999.1.1.1', async () => {
    const r = await router('interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end');
    expect(await r.executeCommand('ping 10.0.0.9 source 999.1.1.1')).not.toContain('Success rate');
  });
});

/*
 * Twenty-sixth batch (outbound ssh to a target that does not resolve): the Cisco shell handed any
 * name that was not in the host table to resolveSshTarget, which calls device.resolveHostname,
 * a method only the hosts have, so `ssh -l u zorglub` and `ssh -l u 999.1.1.1` threw
 * `resolver.resolveHostname is not a function`. The target is now resolved through the router's
 * own DNS client (the one ping and traceroute use) and the IOS dialect's wording answers when it
 * does not resolve. Fails before: the two throws (2 of 3); the third is the witness that a
 * literal address still goes to the wire.
 */
describe('outbound ssh target resolution', () => {
  const lab = () => router('interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end');
  it('answers for a name that does not resolve', async () => {
    const r = await lab();
    expect(await r.executeCommand('ssh -l u zorglub')).toContain('Bad IP address or host name');
  });
  it('answers for an address that is not one', async () => {
    const r = await lab();
    expect(await r.executeCommand('ssh -l u 999.1.1.1')).toContain('Bad IP address or host name');
  });
  it('witness: a literal address goes to the wire', async () => {
    const r = await lab();
    expect(await r.executeCommand('ssh -l u 10.0.0.9')).not.toContain('Bad IP address');
  });
});

/*
 * Twenty-seventh batch (crypto isakmp key address): `address 999.1.1.1` stored a pre-shared key
 * for a peer address that cannot exist. Fails before: the refusal (1 of 2); the witness is that a
 * valid peer address still stores.
 */
describe('crypto isakmp key address', () => {
  it('refuses a peer address that is not one', async () => {
    const r = await router();
    expect(await r.executeCommand('crypto isakmp key K address 999.1.1.1')).toContain('Invalid input');
  });
  it('witness: a valid peer address stores the key', async () => {
    const r = await router();
    expect(await r.executeCommand('crypto isakmp key K address 10.0.0.2')).toBe('');
  });
});
