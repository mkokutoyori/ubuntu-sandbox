/**
 * Cisco IOS Security Command Reference, `radius-server optional-passwords`: "specify that the first RADIUS
 * request to a RADIUS server be made without password verification". Usage Guidelines: when the user enters the
 * login name, the login request is transmitted with the name and a zero-length password; if accepted, the login
 * procedure completes; if the server refuses it, the router prompts for a password and tries again when the user
 * supplies one; the server must support authentication for users without passwords. Default: disabled.
 *
 * Lab: radiusAaaLab (NAS + two RADIUS routers on one switch) plus a LinuxPC that telnets to the NAS. The RADIUS
 * server holds `bob` with an empty password and `alice` with `pw`. The probe reads what the client sees (is the
 * password asked at all?) and counts the Access-Requests per user name at the servers.
 *
 * Ours, not in the reference: only telnet is wired (the line dialogue of the router); a request that is refused
 * for lack of a password is not counted as a bad password attempt of the line.
 *
 * Measured with src stashed to HEAD: 3 of the 5 cases fall (the two that need the command, and the rendering one).
 * The default-behaviour witness and the wrong-password case pass either way. The RADIUS server also used to treat a
 * zero-length decrypted password as a wrong shared secret; it is a legitimate value, which this feature needs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { radiusLab, attachTelnetClient } from './_helpers/radiusAaaLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

async function lab(optional: boolean) {
  const l = await radiusLab([...(optional ? ['radius-server optional-passwords'] : []), 'line vty 0 4', 'transport input all', 'exit']);
  for (const server of [l.silent, l.live]) server.getRadiusServer().addUser('bob', '');
  const pc = await attachTelnetClient(clock, l);
  return { ...l, pc };
}

const requestsFor = (l: Awaited<ReturnType<typeof lab>>, name: string): number =>
  l.toLive.usernames.filter((u) => u === name).length;

const telnet = (l: Awaited<ReturnType<typeof lab>>, script: string) =>
  clock.advanceUntilSettled(l.pc.executeCommand('telnet 10.0.0.1', script));

describe('radius-server optional-passwords', () => {
  it('witness (default): the password is asked and a user with a password sends one request', async () => {
    const l = await lab(false);
    const out = await telnet(l, 'alice\npw\nshow clock\nexit\n');
    expect(out).toMatch(/UTC/);
    expect(requestsFor(l, 'alice')).toBe(1);
  });

  it('a user the server accepts without password gets in without being asked for one', async () => {
    const l = await lab(true);
    const out = await telnet(l, 'bob\nshow clock\nexit\n');
    expect(out).toMatch(/UTC/);
    expect(requestsFor(l, 'bob')).toBe(1);
  });

  it('a user the server refuses without password is asked for it and a second request follows', async () => {
    const l = await lab(true);
    const out = await telnet(l, 'alice\npw\nshow clock\nexit\n');
    expect(out).toMatch(/UTC/);
    expect(requestsFor(l, 'alice')).toBe(2);
  });

  it('a wrong password is still refused after the zero-length request', async () => {
    const l = await lab(true);
    const out = await telnet(l, 'alice\nbad\nshow clock\nexit\n');
    expect(out).not.toMatch(/UTC/);
  });

  it('is rendered and removed by its no form', async () => {
    const l = await lab(true);
    await l.nas.executeCommand('enable');
    expect(await l.nas.executeCommand('show running-config | include optional')).toContain('radius-server optional-passwords');
    for (const line of ['configure terminal', 'no radius-server optional-passwords', 'end']) await l.nas.executeCommand(line);
    expect(await l.nas.executeCommand('show running-config | include optional')).not.toContain('optional-passwords');
  });
});
