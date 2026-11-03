/*
 * Lab "DNS - Agence bancaire", the Linux workstation: ping, traceroute and tracepath name the address that answers (a PTR question) before they print the line, as iputils and traceroute do, waiting for
 * the resolver. PC-CONSEILLER reads the stub of systemd-resolved, and DC1 behind it recurses asynchronously, so a lookup that cannot wait comes back empty: the first line showed the bare address and the
 * next, the PTR having reached the cache meanwhile, the name.
 *
 * Measured first (git stash push -- src/network, 6 tests): the first ping, the first traceroute and the first tracepath show the address where the second shows the name; 3 of the 6 fall. The 3 that pass
 * either way are the WITNESS (the reverse name exists: getent hosts), the second ping (the cache holds the PTR) and the one that shows `-n` never asks (no PTR frame on the wire).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { bench, resetWorld } from './_dnsLabBench';

beforeEach(resetWorld);

const ASK = 'PC-CONSEILLER';

describe('Lab DNS - agence bancaire : the reverse name is waited for', () => {
  it('WITNESS: the address of the site has a reverse name that the workstation resolves', async () => {
    const lab = await bench();
    const reverse = await lab.asked(ASK, 'sh', 'getent hosts 203.0.113.20');
    expect(reverse.output).toContain('web.banquehorizon.com');
  });

  it('the first reply of ping carries the name, not the bare address', async () => {
    const lab = await bench();
    const first = await lab.asked(ASK, 'sh', 'ping -c 1 www.banquehorizon.com');
    expect(first.output).toMatch(/64 bytes from web\.banquehorizon\.com \(203\.0\.113\.20\)/);
  });

  it('the second ping gives the same line and asks nothing: the PTR is in the cache', async () => {
    const lab = await bench();
    await lab.asked(ASK, 'sh', 'ping -c 1 www.banquehorizon.com');
    const again = await lab.asked(ASK, 'sh', 'ping -c 1 www.banquehorizon.com');
    expect(again.output).toMatch(/64 bytes from web\.banquehorizon\.com \(203\.0\.113\.20\)/);
    expect(again.sent[ASK]).toBe(0);
  });

  it('ping -n never asks for a name', async () => {
    const lab = await bench();
    await lab.asked(ASK, 'sh', 'ping -n -c 1 203.0.113.20');
    const numeric = await lab.asked(ASK, 'sh', 'ping -n -c 1 203.0.113.20');
    expect(numeric.output).toMatch(/64 bytes from 203\.0\.113\.20: icmp_seq=1/);
    expect(numeric.sent[ASK]).toBe(0);
  });

  it('the last hop of the first traceroute is named', async () => {
    const lab = await bench();
    const trace = await lab.asked(ASK, 'sh', 'traceroute 203.0.113.20');
    expect(trace.output).toMatch(/web\.banquehorizon\.com \(203\.0\.113\.20\)/);
  });

  it('the last hop of the first tracepath is named', async () => {
    const lab = await bench();
    const path = await lab.asked(ASK, 'sh', 'tracepath 203.0.113.20');
    expect(path.output).toMatch(/web\.banquehorizon\.com/);
  });
});
