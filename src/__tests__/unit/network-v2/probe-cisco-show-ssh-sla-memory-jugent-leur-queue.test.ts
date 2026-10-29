/*
 * Three `show` verbs answered normally whatever followed them: `show ssh
 * zorglub`, `show ip sla summary zorglub` and `show processes memory
 * zorglub`. IOS refuses the word with `% Invalid input detected at '^'
 * marker.` Their grammar here: `show ssh` takes nothing; `show ip sla summary`
 * takes one operation number; `show processes memory` takes a process id or
 * one of sorted/platform/allocated/getbufs/freed/holding/retbufs (from
 * memory: the 'platform' and sort keywords are not backed by a fetched page).
 *
 * Measured with `git stash`: 8 cases, 3 fall before the change (the three
 * refusals); the 5 witnesses (bare forms, the operation number, sorted)
 * pass either way.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

async function show(line: string): Promise<string> {
  const router = new CiscoRouter('router-cisco', 'R1', 0, 0);
  router.powerOn();
  const cli = router as unknown as { executeCommand(command: string): Promise<string> };
  await cli.executeCommand('enable');
  return cli.executeCommand(line);
}

describe('the tail of a show verb is judged', () => {
  it.each(['show ssh zorglub', 'show ip sla summary zorglub', 'show processes memory zorglub'])('`%s`', async (line) => {
    expect(await show(line)).toContain("% Invalid input detected at '^' marker.");
  });
});

describe('witness: valid tails are accepted', () => {
  it.each(['show ssh', 'show ip sla summary', 'show ip sla summary 3', 'show processes memory', 'show processes memory sorted'])('`%s`', async (line) => {
    expect(await show(line)).not.toContain('% Invalid input');
  });
});
