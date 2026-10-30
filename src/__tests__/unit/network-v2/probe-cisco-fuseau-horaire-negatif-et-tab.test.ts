/**
 * Probe: clock timezone completion and negative offsets.
 * Discriminated with git stash on src/cli/ArgumentTypes.ts and
 * CompletionEngine.ts: 3 of 5 cases fail before the fix (negative offset
 * refused, placeholder `<-23-23>`, no zone suggestions on Tab). Witnesses
 * that pass either way: positive offset accepted (the lab is sound),
 * out-of-range offset refused (non-regression).
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = {
  executeCommand(c: string): Promise<string>;
  cliHelp(s: string): string;
  cliTabCandidates(s: string): string[];
  powerOn(): void;
};

describe('clock timezone', () => {
  const router = (): Cli => {
    const r = new CiscoRouter('R1', 0, 0) as unknown as Cli;
    r.powerOn();
    return r;
  };
  it('accepts a negative hour offset', async () => {
    const r = router();
    await r.executeCommand('enable'); await r.executeCommand('configure terminal');
    expect(await r.executeCommand('clock timezone PST -8')).not.toContain('Invalid');
  });
  it('witness: positive offset accepted', async () => {
    const r = router();
    await r.executeCommand('enable'); await r.executeCommand('configure terminal');
    expect(await r.executeCommand('clock timezone CET 1')).not.toContain('Invalid');
  });
  it('refuses an offset out of range', async () => {
    const r = router();
    await r.executeCommand('enable'); await r.executeCommand('configure terminal');
    expect(await r.executeCommand('clock timezone PST -24')).toContain('Invalid');
  });
  it('announces the signed range', async () => {
    const r = router();
    await r.executeCommand('enable'); await r.executeCommand('configure terminal');
    expect(r.cliHelp('clock timezone PST ')).toContain('<-23 - 23>');
  });
  it('suggests common zones on Tab', async () => {
    const r = router();
    await r.executeCommand('enable'); await r.executeCommand('configure terminal');
    expect(r.cliTabCandidates('clock timezone C')).toEqual(expect.arrayContaining(['clock timezone CET', 'clock timezone CST']));
  });
});
