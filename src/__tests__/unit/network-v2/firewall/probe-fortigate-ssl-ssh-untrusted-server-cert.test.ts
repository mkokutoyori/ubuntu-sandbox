/*
 * Probe: the SSL/SSH profile carried the action for an untrusted server certificate as a top-level `untrusted-cert`, a word the
 * FortiOS 7.4.12 reference (firewall ssl-ssh-profile, p.665-667) does not have. The reference puts `untrusted-server-cert
 * [allow|block|ignore]` (default allow) inside each protocol block, `config https` among them, so a learner typing the documented
 * line was refused and the invented one accepted. The engine setting is unchanged (a session to an untrusted server is allowed,
 * blocked or re-signed as trusted, see utm-criteres-de-securite-echouent-fermes); only its place and word follow the reference.
 * Discriminated with git stash on src/network: 3 of 4 fall before the change; the witness (the documented https `status` word)
 * passes either way.
 */
import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';

async function profile(...lines: string[]): Promise<{ fgt: FortiGate; typed: string[] }> {
  const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const typed: string[] = [];
  for (const line of ['config firewall ssl-ssh-profile', 'edit "p"', ...lines, 'next', 'end']) typed.push(await fgt.executeCommand(line));
  return { fgt, typed };
}

describe('ssl-ssh-profile untrusted-server-cert', () => {
  it('witness: the documented https status word is accepted', async () => {
    const { fgt } = await profile('config https', 'set status deep-inspection', 'end');
    expect(await fgt.executeCommand('show firewall ssl-ssh-profile p')).toContain('set status deep-inspection');
  });

  it('untrusted-server-cert is accepted inside config https and rendered there', async () => {
    const { fgt, typed } = await profile('config https', 'set untrusted-server-cert block', 'end');
    expect(typed.join('\n')).not.toMatch(/Command fail|unknown/i);
    expect(await fgt.executeCommand('show firewall ssl-ssh-profile p')).toContain('set untrusted-server-cert block');
  });

  it('the three documented values are accepted and another is refused', async () => {
    for (const value of ['allow', 'block', 'ignore']) {
      const { typed } = await profile('config https', `set untrusted-server-cert ${value}`, 'end');
      expect(typed.join('\n')).not.toMatch(/Command fail|unknown/i);
    }
    const { typed } = await profile('config https', 'set untrusted-server-cert maybe', 'end');
    expect(typed.join('\n')).toMatch(/Command fail|invalid|parse error/i);
  });

  it('the invented top-level untrusted-cert is refused', async () => {
    const { typed } = await profile('set untrusted-cert block');
    expect(typed.join('\n')).toMatch(/unknown attribute "untrusted-cert"/);
  });
});
