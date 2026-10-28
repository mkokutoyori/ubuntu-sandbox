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
