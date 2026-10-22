/**
 * Probe: RFC 3927 claim, announce and defend (docs/rfc/addressing/rfc3927.txt
 * §2.1, §2.2.1, §2.4, §2.5, §2.2.1 MAX_CONFLICTS).
 * Before the fix two cases fail (the Windows client took the MAC-derived
 * 169.254.x.y without probing, so a holder was usurped, and never defended).
 * Pass either way: the witness (nobody holds the address), the generator
 * cases (new module), and the announcement (configureIP already sent one
 * gratuitous ARP; the second is timer-driven).
 */
import { describe, it, expect } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { LinkLocalCandidates } from '@/network/dhcp/LinkLocalClaim';

function lab() {
  const claimer = new WindowsPC('windows-pc', 'CLAIMER');
  const holder = new WindowsPC('windows-pc', 'HOLDER');
  const claimerPort = claimer.getPorts()[0];
  const holderPort = holder.getPorts()[0];
  new Cable('wire').connect(claimerPort, holderPort);
  const firstCandidate = new LinkLocalCandidates(claimerPort.getMAC().toString()).next().toString();
  return { claimer, holder, claimerPort, holderPort, firstCandidate };
}

async function claimedAddress(pc: WindowsPC): Promise<string> {
  await pc.executeCommand('ipconfig /renew');
  return pc.getPorts()[0].getIPAddress()?.toString() ?? '';
}

describe('candidate generation (§2.1)', () => {
  it('stays inside 169.254.1.0-169.254.254.255 and is stable per MAC', () => {
    const a = new LinkLocalCandidates('00:11:22:33:44:55');
    const b = new LinkLocalCandidates('00:11:22:33:44:55');
    for (let i = 0; i < 2000; i++) {
      const [x, y, z, w] = a.next().getOctets();
      expect([x, y]).toEqual([169, 254]);
      expect(z).toBeGreaterThanOrEqual(1);
      expect(z).toBeLessThanOrEqual(254);
      expect(w).toBeLessThanOrEqual(255);
    }
    expect(b.next().toString()).toBe(new LinkLocalCandidates('00:11:22:33:44:55').next().toString());
  });
  it('different MACs diverge', () => {
    const one = new LinkLocalCandidates('00:11:22:33:44:55');
    const two = new LinkLocalCandidates('00:11:22:33:44:56');
    one.next(); two.next();
    expect(one.next().toString()).not.toBe(two.next().toString());
  });
});

describe('claiming on a wire', () => {
  it('WITNESS: nobody holds the address, the first candidate is taken', async () => {
    const { claimer, firstCandidate } = lab();
    expect(await claimedAddress(claimer)).toBe(firstCandidate);
  });

  it('an address already held on the link is not usurped (§2.2.1)', async () => {
    const { claimer, holder, holderPort, firstCandidate } = lab();
    holder.configureInterface(holderPort.getName(), new IPAddress(firstCandidate), new SubnetMask('255.255.0.0'));
    const claimed = await claimedAddress(claimer);
    expect(claimed).toMatch(/^169\.254\./);
    expect(claimed).not.toBe(firstCandidate);
    const third = Number(claimed.split('.')[2]);
    expect(third).toBeGreaterThanOrEqual(1);
    expect(third).toBeLessThanOrEqual(254);
  });

  it('the claimed address is announced with sender = target (§2.4)', async () => {
    const { claimer, holder } = lab();
    const seen: string[] = [];
    holder.getBus().subscribe('host.arp.entry-learned', (e) => { if (e.payload.ip.startsWith('169.254.')) seen.push(e.payload.source); });
    await claimedAddress(claimer);
    expect(seen).toContain('gratuitous');
  });

  it('a first conflict is defended, a repeat within DEFEND_INTERVAL abandons the address (§2.5)', async () => {
    const { claimer, holder, holderPort } = lab();
    const first = await claimedAddress(claimer);
    holder.sendGratuitousArp(holderPort.getName(), new IPAddress(first));
    expect(claimer.getPorts()[0].getIPAddress()?.toString()).toBe(first);
    expect(claimer.getDHCPLogs(claimer.getPorts()[0].getName())).toContain(`defending ${first}`);
    holder.sendGratuitousArp(holderPort.getName(), new IPAddress(first));
    const after = claimer.getPorts()[0].getIPAddress()?.toString();
    expect(after).toMatch(/^169\.254\./);
    expect(after).not.toBe(first);
    expect(claimer.getDHCPLogs(claimer.getPorts()[0].getName())).toContain('abandoning');
  });
});
