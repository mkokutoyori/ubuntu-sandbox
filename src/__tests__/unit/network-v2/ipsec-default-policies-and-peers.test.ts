/**
 * Cisco IOS Security Command Reference (official_docs/cisco/ios-security): `crypto isakmp default
 * policy`, `crypto ipsec transform-set default`, `show crypto isakmp default policy`, `show crypto
 * ipsec transform-set default`, `show crypto isakmp policy`, `show crypto isakmp peers`.
 *
 * Book: with neither a manual `crypto isakmp policy` nor `no crypto isakmp default policy`, IKE
 * negotiates with eight default policies (priorities 65507-65514: AES/SHA/DH5 down to 3DES/MD5/DH2,
 * RSA signature or pre-shared key, 86400 s); `show crypto isakmp default policy` prints them and prints
 * nothing once a manual policy exists or the defaults are disabled. A crypto map or profile with no
 * transform set uses the two default sets (esp-aes esp-sha-hmac and esp-3des esp-sha-hmac, transport)
 * unless `no crypto ipsec transform-set default`.
 *
 * Lab: ipsecLab (two routers, two PCs). The tunnel is real: the ping crosses the WAN as ESP and the
 * state is read from `show crypto isakmp sa` on the initiator.
 *
 * Measured with src stashed to HEAD: 10 of the 12 cases fall (no IKE policy meant no negotiation, the
 * default commands and the peers view were refused, a crypto map without transform set never negotiated,
 * `show crypto isakmp policy` printed an invented DES/DH1 suite). Two pass either way: the witness with
 * a manual policy and the non-matching manual policy that the defaults must not rescue.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { ipsecLab, type IpsecLab } from './_helpers/ipsecLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

const ping = (lab: IpsecLab) => clock.advanceUntilSettled(lab.pc1.executeCommand('ping -c 1 192.168.2.10'));

async function both(lab: IpsecLab, ...lines: string[]): Promise<void> {
  for (const router of [lab.r1, lab.r2]) {
    for (const line of ['enable', 'configure terminal', ...lines, 'end']) await router.executeCommand(line);
  }
}

const NO_MANUAL_POLICY = ['no crypto isakmp policy 10'];
const NO_TRANSFORM_SET = ['crypto map CMAP 10 ipsec-isakmp', 'no set transform-set TSET', 'exit'];

describe('default IKE policies', () => {
  it('witness (passes either way): a manual policy brings the tunnel up', async () => {
    const lab = await ipsecLab();
    expect(await ping(lab)).toContain('1 received');
  });

  it('with no manual policy the default pre-shared-key suite negotiates the tunnel', async () => {
    const lab = await ipsecLab();
    await both(lab, ...NO_MANUAL_POLICY);
    expect(await ping(lab)).toContain('1 received');
    expect(await lab.r1.executeCommand('show crypto isakmp sa')).toContain('QM_IDLE');
  });

  it('no crypto isakmp default policy leaves IKE without a proposal', async () => {
    const lab = await ipsecLab();
    await both(lab, ...NO_MANUAL_POLICY, 'no crypto isakmp default policy');
    expect(await ping(lab)).not.toContain('1 received');
    expect(await lab.r1.executeCommand('show crypto isakmp sa')).not.toContain('QM_IDLE');
    expect(await lab.r1.executeCommand('show running-config')).toContain('no crypto isakmp default policy');
  });

  it('the command restores the defaults', async () => {
    const lab = await ipsecLab();
    await both(lab, ...NO_MANUAL_POLICY, 'no crypto isakmp default policy', 'crypto isakmp default policy');
    expect(await ping(lab)).toContain('1 received');
  });

  it('show crypto isakmp default policy prints the eight suites of the book', async () => {
    const lab = await ipsecLab();
    await both(lab, ...NO_MANUAL_POLICY);
    const shown = await lab.r1.executeCommand('show crypto isakmp default policy');
    expect(shown.match(/Default protection suite of priority/g)?.length).toBe(8);
    expect(shown).toContain('Default protection suite of priority 65507');
    expect(shown).toContain('Default protection suite of priority 65514');
    const first = shown.split('Default protection suite of priority 65508')[0];
    expect(first).toContain('encryption algorithm:   AES - Advanced Encryption Standard (128 bit keys).');
    expect(first).toContain('authentication method:  Rivest-Shamir-Adleman Signature');
    expect(first).toContain('Diffie-Hellman group:   #5 (1536 bit)');
    expect(first).toContain('lifetime:               86400 seconds, no volume limit');
    expect(shown).toContain('Diffie-Hellman group:   #2 (1024 bit)');
  });

  it('prints nothing when a manual policy exists or the defaults are disabled', async () => {
    const lab = await ipsecLab();
    expect((await lab.r1.executeCommand('show crypto isakmp default policy')).trim()).toBe('');
    await both(lab, ...NO_MANUAL_POLICY, 'no crypto isakmp default policy');
    expect((await lab.r1.executeCommand('show crypto isakmp default policy')).trim()).toBe('');
  });

  it('show crypto isakmp policy shows the manual policies only, or the defaults when there are none', async () => {
    const lab = await ipsecLab();
    const manual = await lab.r1.executeCommand('show crypto isakmp policy');
    expect(manual).toContain('Protection suite of priority 10');
    expect(manual).not.toContain('Default protection suite');
    await both(lab, ...NO_MANUAL_POLICY);
    const defaults = await lab.r1.executeCommand('show crypto isakmp policy');
    expect(defaults).toContain('Default protection suite of priority 65507');
    expect(defaults).not.toContain('Protection suite of priority 10');
  });

  it('a manual policy that does not match is not rescued by the defaults', async () => {
    const lab = await ipsecLab();
    await lab.r2.executeCommand('configure terminal');
    for (const line of ['crypto isakmp policy 10', 'encryption 3des', 'hash md5', 'group 2', 'exit', 'end']) await lab.r2.executeCommand(line);
    expect(await ping(lab)).not.toContain('1 received');
  });
});

describe('default transform sets', () => {
  it('a crypto map entry without a transform set uses the default sets', async () => {
    const lab = await ipsecLab();
    await both(lab, ...NO_TRANSFORM_SET);
    expect(await lab.r1.executeCommand('show crypto map')).not.toContain('TSET');
    expect(await ping(lab)).toContain('1 received');
    expect(await lab.r1.executeCommand('show crypto isakmp sa')).toContain('QM_IDLE');
  });

  it('no crypto ipsec transform-set default leaves the entry without a proposal', async () => {
    const lab = await ipsecLab();
    await both(lab, ...NO_TRANSFORM_SET, 'no crypto ipsec transform-set default');
    expect(await ping(lab)).not.toContain('1 received');
    expect(await lab.r1.executeCommand('show running-config')).toContain('no crypto ipsec transform-set default');
  });

  it('show crypto ipsec transform-set default prints the two sets of the book, and nothing once disabled', async () => {
    const lab = await ipsecLab();
    expect(await lab.r1.executeCommand('show crypto ipsec transform-set default')).toBe([
      'Transform set #$!default_transform_set_1: { esp-aes esp-sha-hmac }',
      '   will negotiate = { Transport, },',
      'Transform set #$!default_transform_set_0: { esp-3des esp-sha-hmac }',
      '   will negotiate = { Transport, },',
    ].join('\n'));
    await both(lab, 'no crypto ipsec transform-set default');
    expect((await lab.r1.executeCommand('show crypto ipsec transform-set default')).trim()).toBe('');
  });
});

describe('show crypto isakmp peers', () => {
  it('lists the peer of an established IKE SA, by address or all of them', async () => {
    const lab = await ipsecLab();
    expect((await lab.r1.executeCommand('show crypto isakmp peers')).trim()).toBe('');
    await ping(lab);
    expect(await lab.r1.executeCommand('show crypto isakmp peers')).toBe('Peer: 10.0.12.2 Port: 500\nPhase1 id: 10.0.12.2');
    expect(await lab.r1.executeCommand('show crypto isakmp peers 10.0.12.2')).toContain('Peer: 10.0.12.2');
    expect((await lab.r1.executeCommand('show crypto isakmp peers 10.0.12.99')).trim()).toBe('');
  });
});
