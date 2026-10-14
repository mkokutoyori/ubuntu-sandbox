/**
 * RFC 8633 (BCP 223) read as an audit of a router's NTP configuration. Each
 * finding names the section of docs/rfc/ntp/rfc8633.txt it comes from and the
 * evidence in the configuration, so an auditor can reproduce it. Also pins
 * the one protocol rule of the BCP the engine had wrong: after repeated RATE
 * kisses the poll interval must not exceed 13 (section 5.4), tested in
 * ntp-rfc5905-engine.test.ts.
 *
 * Measured against HEAD (git worktree): the module did not exist, so all the
 * cases fall; the RATE ceiling case of ntp-rfc5905-engine.test.ts falls too
 * (minpoll climbed to 17).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '../../support/ntpTime';
import { auditNtpBestPractices, type BestPracticeFinding } from '@/network/ntp/NtpBestPractices';

beforeEach(() => {
  installVirtualClock();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function audit(lines: string[]): Promise<Map<string, BestPracticeFinding>> {
  const router = new CiscoRouter('R1');
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) await router.executeCommand(line);
  return new Map(auditNtpBestPractices(router.getNtpAgent()).map((f) => [f.id.replace('RFC 8633:', ''), f]));
}

describe('RFC 8633 audit of an NTP configuration', () => {
  it('witness: a router with no NTP configuration has nothing to fail except open control messages', async () => {
    const findings = await audit([]);
    expect(findings.get('sources')!.status).toBe('not-applicable');
    expect(findings.get('broadcast')!.status).toBe('not-applicable');
    expect(findings.get('control-messages')!.status).toBe('fail');
  });

  it('3.2: fewer than four upstream sources fails, four pass', async () => {
    const three = await audit(['ntp server 10.0.0.1', 'ntp server 10.0.0.2', 'ntp server 10.0.0.3']);
    expect(three.get('sources')).toMatchObject({ status: 'fail', section: '3.2', level: 'SHOULD' });
    expect(three.get('sources')!.evidence).toContain('3 upstream source(s)');
    const four = await audit(['ntp server 10.0.0.1', 'ntp server 10.0.0.2', 'ntp server 10.0.0.3', 'ntp server 10.0.0.4']);
    expect(four.get('sources')!.status).toBe('pass');
  });

  it('3.4 and 5.1: control messages are closed by an access group or by disabling mode 6', async () => {
    expect((await audit(['access-list 10 permit 10.0.0.0 0.0.0.255', 'ntp access-group peer 10'])).get('control-messages')!.status).toBe('pass');
    expect((await audit(['no ntp allow mode control'])).get('control-messages')!.status).toBe('pass');
  });

  it('5.1: a router that serves time to everyone fails, with an access group it passes', async () => {
    expect((await audit(['ntp master 3'])).get('time-queries')!.status).toBe('fail');
    expect((await audit(['access-list 10 permit 10.0.0.0 0.0.0.255', 'ntp master 3', 'ntp access-group serve-only 10'])).get('time-queries')!.status).toBe('pass');
  });

  it('4.1: an MD5 key is reported as too weak, and a key shared by two associations is not unique', async () => {
    const findings = await audit(['ntp authentication-key 1 md5 SECRET', 'ntp server 10.0.0.1 key 1', 'ntp server 10.0.0.2 key 1']);
    expect(findings.get('key-algorithm')).toMatchObject({ status: 'fail', section: '4.1' });
    expect(findings.get('unique-keys')).toMatchObject({ status: 'fail' });
    expect(findings.get('unique-keys')!.evidence).toContain('10.0.0.1');
  });

  it('5.6: a symmetric peer without a key fails and with a key passes', async () => {
    expect((await audit(['ntp peer 10.0.0.9'])).get('symmetric')!.status).toBe('fail');
    expect((await audit(['ntp authentication-key 2 md5 S', 'ntp peer 10.0.0.9 key 2'])).get('symmetric')!.status).toBe('pass');
  });

  it('5.5: broadcast without a key fails, broadcast with a key and authentication passes', async () => {
    const open = await audit(['interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'ntp broadcast', 'exit']);
    expect(open.get('broadcast')!.status).toBe('fail');
    const closed = await audit(['ntp authentication-key 1 md5 S', 'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0',
      'ntp broadcast key 1', 'exit']);
    expect(closed.get('broadcast')!.status).toBe('pass');
  });

  it('5.4: a time server without rate limiting fails', async () => {
    expect((await audit(['ntp master 3'])).get('kod-rate-limit')!.status).toBe('fail');
  });
});
