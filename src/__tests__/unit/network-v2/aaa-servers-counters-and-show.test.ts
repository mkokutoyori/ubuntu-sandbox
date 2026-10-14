/**
 * Cisco IOS Security Command Reference (official_docs/cisco/ios-security): `show aaa servers`,
 * `show aaa dead-criteria`, `show radius server-group`, `show radius statistics`,
 * `clear aaa counters servers` and `clear radius`.
 *
 * The counters shown are the ones the RADIUS client moves while it sends and receives real frames:
 * each case compares what the command prints with what a tap on the server's port counted.
 *
 * Lab: radiusLab (NAS + a silent RADIUS server 10.0.0.2 + a live one 10.0.0.3 on one switch).
 *
 * Measured with src stashed to HEAD: the first 15 cases fall; the 2 method-list cases were added after (before, `show aaa method-lists` fell through showAaa to the sessions line). The RADIUS rows of `show aaa servers` were
 * fixed zeros that never moved and always said UP (a dead server printed UP, a server that had
 * answered printed `request 0`), `show aaa dead-criteria` and `show radius server-group` answered
 * the sessions line of `show aaa`, and the `clear` forms were refused. Every case reads a counter
 * the lab moved before asserting what the command did, so none passes by reading zeros.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { radiusLab, radiusLogin } from './_helpers/radiusAaaLab';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

const login = (nas: CiscoRouter): Promise<boolean> => radiusLogin(clock, nas);

function block(output: string, address: string): string {
  const parts = output.split(/(?=^RADIUS: )/m);
  return parts.find((part) => part.includes(`host ${address},`)) ?? '';
}

function field(text: string, pattern: RegExp): number {
  const match = pattern.exec(text);
  if (!match) throw new Error(`missing ${pattern} in\n${text}`);
  return Number(match[1]);
}

describe('show aaa servers', () => {
  it('witness: both servers are listed with their id and ports', async () => {
    const { nas } = await radiusLab([]);
    const out = await nas.executeCommand('show aaa servers');
    expect(out).toMatch(/RADIUS: id 1, priority 1, host 10\.0\.0\.2, auth-port 1812, acct-port 1646/);
    expect(out).toMatch(/RADIUS: id 2, priority 2, host 10\.0\.0\.3, auth-port 1812, acct-port 1646/);
  });

  it('the live server counts one request, one accept and one successful transaction, as the wire does', async () => {
    const { nas, toLive } = await radiusLab([]);
    expect(await login(nas)).toBe(true);
    const out = block(await nas.executeCommand('show aaa servers'), '10.0.0.3');
    expect(toLive.count).toBe(1);
    expect(field(out, /Authen: request (\d+)/)).toBe(toLive.count);
    expect(field(out, /Response: accept (\d+)/)).toBe(1);
    expect(field(out, /Transaction: success (\d+)/)).toBe(1);
    expect(out).toContain('State: current UP');
  });

  it('the silent server counts every transmission, every timeout and the failover', async () => {
    const { nas, toSilent } = await radiusLab(['radius-server retransmit 2']);
    expect(await login(nas)).toBe(true);
    const out = block(await nas.executeCommand('show aaa servers'), '10.0.0.2');
    expect(toSilent.count).toBe(3);
    expect(field(out, /Authen: request (\d+)/)).toBe(toSilent.count);
    expect(field(out, /timeouts (\d+)/)).toBe(3);
    expect(field(out, /retransmission (\d+)/)).toBe(2);
    expect(field(out, /failover (\d+)/)).toBe(1);
    expect(field(out, /Transaction: success \d+, failure (\d+)/)).toBe(1);
  });

  it('a server marked dead prints DEAD, then UP again with the dead time it accumulated', async () => {
    const { nas } = await radiusLab(['radius-server deadtime 5', 'radius-server dead-criteria time 1 tries 1']);
    expect(await login(nas)).toBe(true);
    let out = block(await nas.executeCommand('show aaa servers'), '10.0.0.2');
    expect(out).toContain('State: current DEAD');
    expect(field(out, /Dead: total time \d+s, count (\d+)/)).toBe(1);
    await clock.advance(6 * 60_000);
    expect(await login(nas)).toBe(true);
    out = block(await nas.executeCommand('show aaa servers'), '10.0.0.2');
    expect(out).toContain('State: current');
    expect(field(out, /Dead: total time (\d+)s/)).toBe(300);
  });

  it('private lists nothing here and public lists the same servers as the plain form', async () => {
    const { nas } = await radiusLab([]);
    const all = await nas.executeCommand('show aaa servers');
    expect((await nas.executeCommand('show aaa servers private')).trim()).toBe('');
    expect(await nas.executeCommand('show aaa servers public')).toBe(all);
  });
});

describe('accounting counters', () => {
  it('a started and stopped session is counted as start/stop requests and responses', async () => {
    const { nas, live } = await radiusLab([]);
    const accounting = nas.getRadiusAccountingClient();
    accounting.start();
    accounting.addServer('10.0.0.3', 'secret', { timeoutMs: 200, retransmit: 0 });
    const session = accounting.startSession('alice', '10.0.0.3');
    await clock.advanceUntilSettled(Promise.resolve());
    accounting.stopSession(session as string);
    await clock.advanceUntilSettled(Promise.resolve());
    const out = block(await nas.executeCommand('show aaa servers'), '10.0.0.3');
    expect(live.getRadiusServer().listAccountingSessions().length).toBe(1);
    expect(out).toMatch(/Account: request 2, timeouts 0, failover 0, retransmission 0/);
    expect(out).toMatch(/Request: start 1, interim 0, stop 1/);
    expect(out).toMatch(/Response: start 1, interim 0, stop 1/);
  });
});

describe('clear aaa counters servers', () => {
  it('radius <id> clears that server only', async () => {
    const { nas } = await radiusLab([]);
    expect(await login(nas)).toBe(true);
    await nas.executeCommand('clear aaa counters servers radius 1');
    const out = await nas.executeCommand('show aaa servers');
    expect(field(block(out, '10.0.0.2'), /Authen: request (\d+)/)).toBe(0);
    expect(field(block(out, '10.0.0.3'), /Authen: request (\d+)/)).toBe(1);
  });

  it('all clears every server, and so does clear radius statistics', async () => {
    const { nas } = await radiusLab([]);
    expect(await login(nas)).toBe(true);
    expect(field(block(await nas.executeCommand('show aaa servers'), '10.0.0.3'), /Authen: request (\d+)/)).toBe(1);
    await nas.executeCommand('clear aaa counters servers all');
    let out = await nas.executeCommand('show aaa servers');
    expect(field(block(out, '10.0.0.3'), /Authen: request (\d+)/)).toBe(0);
    expect(await login(nas)).toBe(true);
    expect(field(block(await nas.executeCommand('show aaa servers'), '10.0.0.3'), /Authen: request (\d+)/)).toBe(1);
    await nas.executeCommand('clear radius statistics');
    out = await nas.executeCommand('show aaa servers');
    expect(field(block(out, '10.0.0.3'), /Authen: request (\d+)/)).toBe(0);
  });

  it('sg <name> clears the servers of that group', async () => {
    const { nas } = await radiusLab([]);
    expect(await login(nas)).toBe(true);
    expect(field(block(await nas.executeCommand('show aaa servers'), '10.0.0.3'), /Authen: request (\d+)/)).toBe(1);
    await nas.executeCommand('clear aaa counters servers sg G');
    const out = await nas.executeCommand('show aaa servers');
    expect(field(block(out, '10.0.0.3'), /Authen: request (\d+)/)).toBe(0);
  });

  it('an unknown id is refused and clears nothing', async () => {
    const { nas } = await radiusLab([]);
    expect(await login(nas)).toBe(true);
    expect(await nas.executeCommand('clear aaa counters servers radius 99')).toContain('Invalid input');
    const out = await nas.executeCommand('show aaa servers');
    expect(field(block(out, '10.0.0.3'), /Authen: request (\d+)/)).toBe(1);
  });
});

describe('show aaa dead-criteria', () => {
  it('prints the server, the criteria in force and the transmissions counted since the last reply', async () => {
    const { nas } = await radiusLab(['radius-server dead-criteria time 20 tries 7', 'radius-server timeout 1', 'radius-server retransmit 2']);
    expect(await login(nas)).toBe(true);
    const out = await nas.executeCommand('show aaa dead-criteria radius 10.0.0.2 auth-port 1812 acct-port 1646 G');
    expect(out).toContain('Address       : 10.0.0.2');
    expect(out).toContain('Auth Port     : 1812');
    expect(out).toContain('Server Group  : G');
    expect(out).toContain('Configured Retransmits         : 2');
    expect(out).toContain('Configured Timeout             : 1');
    expect(out).toContain('Dead Detect Time               : 20s');
    expect(out).toContain('Computed Retransmit Tries      : 7');
    expect(out).toContain('Max Computed Retransmits     : 3');
  });

  it('defaults to the global radius group and refuses a server that is not in the group', async () => {
    const { nas } = await radiusLab([]);
    expect(await nas.executeCommand('show aaa dead-criteria radius 10.0.0.3')).toContain('Server Group  : radius');
    expect((await nas.executeCommand('show aaa dead-criteria radius 10.9.9.9')).trim()).toBe('');
  });
});

describe('show radius server-group', () => {
  it('names the group and counts the method lists that share it', async () => {
    const { nas } = await radiusLab([]);
    const out = await nas.executeCommand('show radius server-group G');
    expect(out).toContain('Server group G');
    expect(out).toMatch(/Sharecount = 1\s+sg_unconfigured = FALSE/);
    expect(out).toContain('Type = standard');
  });

  it('all lists the global radius group too, and an unknown name is refused', async () => {
    const { nas } = await radiusLab([]);
    const out = await nas.executeCommand('show radius server-group all');
    expect(out).toContain('Server group radius');
    expect(out).toContain('Server group G');
    expect(await nas.executeCommand('show radius server-group nope')).toContain('Invalid input');
  });
});

describe('show radius statistics', () => {
  it('counts the responses seen and the timeouts, per column', async () => {
    const { nas } = await radiusLab([]);
    expect(await login(nas)).toBe(true);
    const out = await nas.executeCommand('show radius statistics');
    expect(out).toMatch(/Total responses seen:\s+1\s+0\s+1/);
    expect(out).toMatch(/Number of Radius timeouts:\s+1\s+0\s+1/);
    expect(out).toMatch(/Packets without responses:\s+1\s+0\s+1/);
  });
});

describe('show aaa method-lists', () => {
  it('lists the lists under their queue, with the group they use', async () => {
    const { nas } = await radiusLab(['aaa accounting exec default start-stop group G', 'aaa authentication enable default enable']);
    const out = await nas.executeCommand('show aaa method-lists authentication');
    expect(out).toMatch(/authen queue=AAA_ML_AUTHEN_LOGIN\nname=default valid=TRUE id=0 :state=ALIVE : SERVER_GROUP G/);
    expect(out).toMatch(/authen queue=AAA_ML_AUTHEN_ENABLE\nname=default valid=TRUE id=0 :state=ALIVE : ENABLE/);
    const acct = await nas.executeCommand('show aaa method-lists accounting');
    expect(acct).toMatch(/acct queue=AAA_ML_ACCT_SHELL\nname=default valid=TRUE id=0 Action=START STOP :state=ALIVE : SERVER_GROUP G/);
    expect(await nas.executeCommand('show aaa method-lists all')).toContain('acct queue=AAA_ML_ACCT_SHELL');
  });

  it('a list whose group has every server dead is DEAD, and ALIVE again after the deadtime', async () => {
    const { nas } = await radiusLab(['radius-server deadtime 5', 'radius-server dead-criteria time 1 tries 1'], { liveUp: false });
    expect(await login(nas)).toBe(false);
    expect(await nas.executeCommand('show aaa method-lists authentication')).toContain(':state=DEAD : SERVER_GROUP G');
    await clock.advance(6 * 60_000);
    expect(await nas.executeCommand('show aaa method-lists authentication')).toContain(':state=ALIVE : SERVER_GROUP G');
  });
});
