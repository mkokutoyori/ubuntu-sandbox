/*
 * `cpu-defend policy 1 zorglub` entered the policy view: the handler read the
 * name and ignored the rest. VRP takes `cpu-defend policy <name>` and, on the
 * models that have it, a trailing `global`; any other word is refused with
 * `Error: Unrecognized command found at '^' position.` ('global' is from
 * memory, not a fetched page).
 *
 * Measured with `git stash`: 3 cases, 1 falls before the change (the
 * refusal); the 2 witnesses pass either way.
 */
import { describe, it, expect } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';

async function inSystemView(line: string): Promise<string> {
  const router = new HuaweiRouter('R1');
  router.powerOn();
  const cli = router as unknown as { executeCommand(command: string): Promise<string> };
  await cli.executeCommand('system-view');
  return cli.executeCommand(line);
}

describe('cpu-defend policy judges its tail', () => {
  it('an unknown word is refused', async () => {
    expect(await inSystemView('cpu-defend policy 1 zorglub')).toContain("Error: Unrecognized command found at '^' position.");
  });
  it('witness: the bare form enters the view', async () => {
    expect(await inSystemView('cpu-defend policy 1')).toBe('');
  });
  it('witness: the global form is accepted', async () => {
    expect(await inSystemView('cpu-defend policy 1 global')).toBe('');
  });
});
