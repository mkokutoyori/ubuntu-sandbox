/*
 * `interface loopback 99999999999` created an interface: the number is a
 * signed 32-bit value on IOS (<0-2147483647>), so a larger one is refused
 * with `% Invalid input detected at '^' marker.` The same range holds for
 * Tunnel. The caret sits on the number. Port-channel and virtual-template
 * keep their platform ranges (not bounded here: not sourced).
 *
 * Measured with `git stash`: 6 cases, 3 fall before the change (loopback
 * spaced, loopback glued, tunnel); the 3 witnesses (the largest valid
 * number, the `lo` abbreviation, loopback 0) pass either way.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

async function inConfig(line: string): Promise<string> {
  const router = new CiscoRouter('R1');
  router.powerOn();
  const cli = router as unknown as { executeCommand(command: string): Promise<string> };
  await cli.executeCommand('enable');
  await cli.executeCommand('configure terminal');
  return cli.executeCommand(line);
}

describe('the number of a virtual interface is bounded', () => {
  it.each(['interface loopback 99999999999', 'interface loopback99999999999', 'interface tunnel 2147483648'])('`%s`', async (line) => {
    expect(await inConfig(line)).toContain("% Invalid input detected at '^' marker.");
  });
});

describe('witness: valid numbers are accepted', () => {
  it.each(['interface loopback 2147483647', 'interface lo 7', 'interface loopback 0'])('`%s`', async (line) => {
    expect(await inConfig(line)).toBe('');
  });
});
