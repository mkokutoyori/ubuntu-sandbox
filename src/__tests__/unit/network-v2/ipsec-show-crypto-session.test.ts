/**
 * Cisco IOS Security Command Reference (official_docs/cisco/ios-security, Commands S to Z):
 * `show crypto session [brief|detail]`, `show crypto ipsec security-association lifetime`, and the
 * silence of `clear crypto sa` / `clear crypto isakmp`.
 *
 * The session table is one view over the IKE and IPsec SA databases: its status is UP-ACTIVE with
 * both, UP-IDLE with the IKE SA alone and UP-NO-IKE with the IPsec SAs alone (book, Table 74); the
 * packet counters are those `show crypto ipsec sa` prints; the connection id is the one
 * `show crypto isakmp sa` prints; the lifetimes count down with the (virtual) clock.
 *
 * Lab: ipsecLab with a virtual clock.
 *
 * Measured with src stashed to HEAD: the view invented "Session ID" and "IKEv1 SA:", printed the
 * same text for detail, never showed an IKE-only or IPsec-only session, had no brief form, always
 * printed connection id 1, rendered the flow as address + wildcard, announced "No active crypto
 * sessions." on an empty table, spelled the lifetime line another way and the clear commands
 * announced "Cleared 1 IPSec SA" (IOS says nothing), so 8 of the 9 cases fall. The one that passes
 * either way is the refusal of a value outside the grammar.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { ipsecLab } from './_helpers/ipsecLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

async function tunnel() {
  const lab = await ipsecLab();
  expect(await clock.advanceUntilSettled(lab.pc1.executeCommand('ping -c 3 192.168.2.10'))).toContain('3 received');
  return lab;
}

describe('show crypto session', () => {
  it('an empty table prints nothing before any traffic', async () => {
    const lab = await ipsecLab();
    expect((await lab.r1.executeCommand('show crypto session')).trim()).toBe('');
  });

  it('lists the session with the book wording and the flow as address/mask', async () => {
    const lab = await tunnel();
    const out = await lab.r1.executeCommand('show crypto session');
    expect(out).toContain('Crypto session current status');
    expect(out).toContain('Interface: GigabitEthernet0/1');
    expect(out).toContain('Session status: UP-ACTIVE');
    expect(out).toContain('Peer: 10.0.12.2 port 500');
    expect(out).toContain('IKE SA: local 10.0.12.1/500 remote 10.0.12.2/500 Active');
    expect(out).toContain('IPSEC FLOW: permit ip 192.168.1.0/255.255.255.0 192.168.2.0/255.255.255.0');
    expect(out).toContain('Active SAs: 2, origin: crypto map');
    expect(out).not.toContain('IKEv1');
    expect(out).not.toContain('Session ID');
  });

  it('detail agrees with show crypto ipsec sa on the packet counters and with show crypto isakmp sa on the connection id', async () => {
    const lab = await tunnel();
    const detail = await lab.r1.executeCommand('show crypto session detail');
    const sa = await lab.r1.executeCommand('show crypto ipsec sa');
    const isakmp = await lab.r1.executeCommand('show crypto isakmp sa');
    const encaps = Number(/#pkts encaps:\s*(\d+)/.exec(sa)![1]);
    const decaps = Number(/#pkts decaps:\s*(\d+)/.exec(sa)![1]);
    expect(encaps).toBeGreaterThan(0);
    expect(detail).toContain(`Outbound: #pkts enc'ed ${encaps} drop 0`);
    expect(detail).toContain(`Inbound:  #pkts dec'ed ${decaps} drop 0`);
    const connId = /connid:(\d+)/.exec(detail)![1];
    expect(isakmp).toMatch(new RegExp(`QM_IDLE\\s+${connId}\\s+ACTIVE`));
    expect(detail).toContain('Phase1_id: 10.0.12.2');
    expect(detail).toContain('Capabilities:');
  });

  it('the lifetimes count down with the clock', async () => {
    const lab = await tunnel();
    await clock.advance(600_000);
    const detail = await lab.r1.executeCommand('show crypto session detail');
    expect(detail).toMatch(/lifetime:23:49:\d\d/);
    expect(detail).toMatch(/life \(KB\/Sec\) \d+\/(29\d\d|30\d\d)/);
    expect(detail).toMatch(/Uptime: 00:1\d:\d\d/);
  });

  it('brief prints one row per session with the abbreviated interface and the status code', async () => {
    const lab = await tunnel();
    await clock.advance(65_000);
    const brief = await lab.r1.executeCommand('show crypto session brief');
    expect(brief).toContain('Status: A- Active, U - Up, D - Down, I - Idle, S - Standby, N - Negotiating');
    expect(brief).toMatch(/10\.0\.12\.2\s+Gi0\/1\s+-\s+10\.0\.12\.2\s+00:01:\d\d\s+UA/);
  });

  it('IPsec SAs cleared: the IKE SA alone is UP-IDLE; IKE cleared: the IPsec SAs alone are UP-NO-IKE', async () => {
    const lab = await tunnel();
    expect(await lab.r1.executeCommand('clear crypto sa')).toBe('');
    expect(await lab.r1.executeCommand('show crypto session')).toContain('Session status: UP-IDLE');
    const other = await tunnel();
    expect(await other.r1.executeCommand('clear crypto isakmp')).toBe('');
    expect(await other.r1.executeCommand('show crypto session')).toContain('Session status: UP-NO-IKE');
  });

  it('the status field of brief follows the same rule', async () => {
    const lab = await tunnel();
    await lab.r1.executeCommand('clear crypto sa');
    expect(await lab.r1.executeCommand('show crypto session brief')).toMatch(/\s+UI\s*$/m);
  });

  it('a value outside the grammar is refused', async () => {
    const lab = await ipsecLab();
    expect(await lab.r1.executeCommand('show crypto session zorglub')).toContain('Invalid input');
  });
});

describe('show crypto ipsec security-association lifetime', () => {
  it('uses the book spelling and follows the configured lifetime', async () => {
    const lab = await ipsecLab(['crypto ipsec security-association lifetime seconds 600']);
    expect(await lab.r1.executeCommand('show crypto ipsec security-association lifetime'))
      .toBe('Security-association lifetime: 4608000 kilobytes/600 seconds');
  });
});
