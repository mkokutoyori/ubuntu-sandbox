/**
 * Probe: clock summer-time positional grammar and the line settings
 * (exec-timeout, login-timeout, access-class, logging synchronous) declared
 * on the socle.
 * Discriminated with git stash of src/network: 4 of 12 cases fail before
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
