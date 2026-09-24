/*
 * Probe — several IPv4 default routes coexist in the main table when their
 * metrics differ, and the lowest metric carries the traffic.
 *
 * Before: `ip route add default via G metric M` went to a single default
 * gateway: the metric was dropped and a second default silently replaced
 * the first (FortiGate battery 02, test 76: `ip route show` listed only
 * "default via 192.168.1.254 dev eth0 proto static"). `ip route del
 * default` removed every default at once, and adding a default with the
 * metric of an existing one succeeded instead of failing.
 *
 * Authority: Linux FIB semantics as exposed by iproute2's ip-route(8):
 * routes are keyed by prefix, TOS and preference (metric); `add` of an
 * existing key fails with "RTNETLINK answers: File exists", `replace`
 * substitutes it, `del` removes the first route matching the selectors
 * given (via, metric); the route lookup picks the lowest metric among
 * equal prefixes.
 *
 * Measured before the change (git stash of src/network/devices): 5 of the
 * 7 cases fail.
 * Passing either way:
 *   - "a single default route" is the WITNESS.
 *   - "deleting a missing default" is non-regression.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

async function host(): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  pc.powerOn();
  for (const c of ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0']) await pc.executeCommand(c);
  return pc;
}

async function twoDefaults(): Promise<LinuxPC> {
  const pc = await host();
  await pc.executeCommand('ip route add default via 192.168.1.1 metric 10');
  await pc.executeCommand('ip route add default via 192.168.1.254 metric 20');
  return pc;
}

describe('ip route: several defaults, chosen by metric', () => {
  it('a single default route', async () => {
    const pc = await host();
    await pc.executeCommand('ip route add default via 192.168.1.1');
    expect(await pc.executeCommand('ip route show default')).toMatch(/^default via 192\.168\.1\.1 dev eth0/m);
  });

  it('two defaults with different metrics are both kept', async () => {
    const shown = await (await twoDefaults()).executeCommand('ip route show');
    expect(shown).toMatch(/^default via 192\.168\.1\.1 dev eth0 .*metric 10\b/m);
    expect(shown).toMatch(/^default via 192\.168\.1\.254 dev eth0 .*metric 20\b/m);
  });

  it('the lowest metric carries the traffic', async () => {
    const pc = await twoDefaults();
    expect(await pc.executeCommand('ip route get 8.8.8.8')).toMatch(/^8\.8\.8\.8 via 192\.168\.1\.1 dev eth0/m);
  });

  it('a default with an existing metric is refused', async () => {
    const pc = await twoDefaults();
    expect(await pc.executeCommand('ip route add default via 192.168.1.2 metric 10')).toBe('RTNETLINK answers: File exists');
  });

  it('replace substitutes the default of that metric', async () => {
    const pc = await twoDefaults();
    await pc.executeCommand('ip route replace default via 192.168.1.2 metric 10');
    const shown = await pc.executeCommand('ip route show');
    expect(shown).toMatch(/^default via 192\.168\.1\.2 dev eth0 .*metric 10\b/m);
    expect(shown).not.toMatch(/via 192\.168\.1\.1 /);
  });

  it('del removes only the default it names, and the next one takes over', async () => {
    const pc = await twoDefaults();
    await pc.executeCommand('ip route del default via 192.168.1.1');
    expect(await pc.executeCommand('ip route show')).toMatch(/^default via 192\.168\.1\.254 dev eth0 .*metric 20\b/m);
    expect(await pc.executeCommand('ip route get 8.8.8.8')).toMatch(/via 192\.168\.1\.254 /);
  });

  it('deleting a missing default', async () => {
    expect(await (await host()).executeCommand('ip route del default')).toBe('RTNETLINK answers: No such process');
  });
});
