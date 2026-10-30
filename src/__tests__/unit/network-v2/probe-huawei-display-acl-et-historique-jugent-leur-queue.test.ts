/*
 * Two VRP views answered whatever followed them: `display acl all zorglub`
 * printed the list, `display history-command zorglub` printed the history.
 * VRP refuses an extra word after `display acl {all | <number>}` and
 * `display acl name <name>` with `Error: Too many parameters found at '^'
 * position.`, and an unknown keyword after `display history-command` (whose
 * only keyword is `all-users`) with `Error: Unrecognized command found at
 * '^' position.` The refusal carries no echoed line and caret for the
 * too-many case (the exit normaliser only decorates the other families):
 * recorded in TODO.md.
 *
 * Measured with `git stash`: 8 cases, 4 fall before the change (extra word
 * after all / a number / name x, and the unknown history keyword); the 4
 * witnesses pass either way.
 */
import { describe, it, expect } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';

async function run(line: string): Promise<string> {
  const router = new HuaweiRouter('R1');
  router.powerOn();
  return (router as unknown as { executeCommand(command: string): Promise<string> }).executeCommand(line);
}

describe('the tail of a display verb is judged', () => {
  it.each(['display acl all zorglub', 'display acl 2000 zorglub', 'display acl name x zorglub'])('`%s`', async (line) => {
    expect(await run(line)).toContain("Error: Too many parameters found at '^' position.");
  });
  it('display history-command zorglub', async () => {
    expect(await run('display history-command zorglub')).toContain("Error: Unrecognized command found at '^' position.");
  });
});

describe('witness: valid forms are accepted', () => {
  it.each(['display acl all', 'display acl 2000', 'display history-command', 'display history-command all-users'])('`%s`', async (line) => {
    const out = await run(line);
    expect(out).not.toContain('Too many parameters');
    expect(out).not.toContain('Unrecognized command');
  });
});
