/**
 * Probe: clock summer-time positional grammar and the line settings
 * (exec-timeout, login-timeout, access-class, logging synchronous) declared
 * on the socle.
 * Discriminated with git stash of src/network: 4 of 12 (first batch); second batch: 2 of 6 fail before (`escape-character` bare
 * accepted, `no length`/`no width` leaving the line); the other four are
 * witnesses/non-regressions; third batch: 1 of 5 fails before (`no accounting
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
