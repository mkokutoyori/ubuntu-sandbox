/**
 * Cisco IOS Security Command Reference.
 *
 * `aaa authentication suppress null-username`: "prevent an Access Request with a blank username from being sent
 * to the RADIUS server"; the no form allows it; default: not enabled; "ensures that unnecessary RADIUS server
 * interaction is avoided, and RADIUS logs are kept short".
 *
 * `aaa max-sessions maximum-number-of-sessions`: range 1024 to 64000, default platform dependent, "can be used
 * only if the aaa new-model command is configured". The page contradicts itself on the meaning (simultaneous
 * connections per user in the Usage Guidelines, initial hash size in the example and the Syntax Description:
 * "estimated AAA maximum sessions"): the value is stored, rendered and range-checked, and nothing observable on
 * the wire depends on it. That is a limit of the simulator, stated rather than hidden.
 *
 * Lab: radiusAaaLab (a NAS and two RADIUS server routers on one switch); the probe counts the Access-Requests that
 * reach the servers, by user name, through the taps of that lab. Two cases drive the whole path from a LinuxPC over
 * telnet (a user name typed as a single space, the scripted client drops empty lines); the others call the NAS
 * authenticator directly, and only the NAS-to-server leg of those crosses the wire.
 *
 * Ours, not in the reference: the verdict of a suppressed request (the RADIUS method yields no verdict, so the
 * method list moves on and ends in a failure) and the refusal wording without aaa new-model.
 *
 * Measured with src stashed to HEAD: the commands were refused; 4 of the 6 cases fall. Two pass either way: the
 * named-user witness, and the first case (without the command a blank user name does reach the server), which is
 * the non-regression baseline of the lab.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { radiusLab, radiusLogin, attachTelnetClient } from './_helpers/radiusAaaLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

describe('aaa authentication suppress null-username', () => {
  it('without it a blank user name reaches the RADIUS server', async () => {
    const lab = await radiusLab([]);
    await radiusLogin(clock, lab.nas, '');
    expect(lab.toLive.usernames.concat(lab.toSilent.usernames)).toContain('');
  });

  it('with it the blank user name is not sent and the login fails', async () => {
    const lab = await radiusLab(['aaa authentication suppress null-username']);
    expect(await radiusLogin(clock, lab.nas, '')).toBe(false);
    expect(lab.toLive.count + lab.toSilent.count).toBe(0);
  });

  it('end to end over telnet: a blank user name typed at the prompt sends nothing to the servers', async () => {
    const lab = await radiusLab(['aaa authentication suppress null-username', 'line vty 0 4', 'transport input all', 'exit']);
    const pc = await attachTelnetClient(clock, lab);
    const out = await clock.advanceUntilSettled(pc.executeCommand('telnet 10.0.0.1', ' \nnope\nalice\npw\nshow clock\nexit\n'));
    expect(out).toMatch(/UTC/);
    expect(lab.toLive.usernames).not.toContain('');
    expect(lab.toLive.usernames).toContain('alice');
  });

  it('end to end over telnet, without the command: the blank user name does reach the server', async () => {
    const lab = await radiusLab(['line vty 0 4', 'transport input all', 'exit']);
    const pc = await attachTelnetClient(clock, lab);
    await clock.advanceUntilSettled(pc.executeCommand('telnet 10.0.0.1', ' \nnope\nalice\npw\nexit\n'));
    expect(lab.toLive.usernames).toContain('');
  });

  it('witness (passes either way): a named user is still sent and accepted', async () => {
    const lab = await radiusLab(['aaa authentication suppress null-username']);
    expect(await radiusLogin(clock, lab.nas, 'alice')).toBe(true);
    expect(lab.toLive.usernames).toContain('alice');
  });

  it('the no form allows the blank user name again, and the setting is rendered', async () => {
    const lab = await radiusLab(['aaa authentication suppress null-username']);
    await lab.nas.executeCommand('enable');
    expect(await lab.nas.executeCommand('show running-config | include suppress')).toContain('aaa authentication suppress null-username');
    for (const line of ['configure terminal', 'no aaa authentication suppress null-username', 'end']) await lab.nas.executeCommand(line);
    await radiusLogin(clock, lab.nas, '');
    expect(lab.toLive.usernames.concat(lab.toSilent.usernames)).toContain('');
  });
});

describe('aaa max-sessions', () => {
  async function router(newModel: boolean): Promise<CiscoRouter> {
    const r = new CiscoRouter('R1');
    for (const line of ['enable', 'configure terminal', ...(newModel ? ['aaa new-model'] : [])]) await r.executeCommand(line);
    return r;
  }

  it('is refused without aaa new-model and outside 1024-64000', async () => {
    expect(await (await router(false)).executeCommand('aaa max-sessions 2000')).toContain('aaa new-model');
    const r = await router(true);
    expect(await r.executeCommand('aaa max-sessions 1023')).toContain('Invalid input');
    expect(await r.executeCommand('aaa max-sessions 64001')).toContain('Invalid input');
    expect(await r.executeCommand('aaa max-sessions ?')).toContain('<1024-64000>');
  });

  it('is rendered with the aaa lines and removed by its no form', async () => {
    const r = await router(true);
    await r.executeCommand('aaa max-sessions 1025');
    expect(await r.executeCommand('do show running-config | include max-sessions')).toContain('aaa max-sessions 1025');
    await r.executeCommand('no aaa max-sessions');
    expect(await r.executeCommand('do show running-config | include max-sessions')).not.toContain('max-sessions');
  });
});
