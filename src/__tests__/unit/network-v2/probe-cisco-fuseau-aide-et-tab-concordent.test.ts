/*
 * `?` and Tab answer the same question on a place that declares
 * `tabSuggestions` (`clock timezone`, `clock summer-time`).
 *
 * Measured before the change: 3 of the 4 cases fall. Tab completed
 * `clock timezone C` to CAT / CET / CST while `?` on the same input
 * answered nothing, and `clock timezone ?` showed only `WORD  Name of time
 * zone` although Tab knew seventeen names. The witness (Tab candidates
 * themselves) passes either way.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = {
  executeCommand(line: string): Promise<string>;
  cliHelp(line: string): string;
  cliTabCandidates(line: string): string[];
};

async function router(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  for (const l of ['enable', 'configure terminal']) await r.executeCommand(l);
  return r;
}

const helpWords = (help: string): string[] =>
  help.split('\n').map((line) => line.trim().split(/\s+/)[0]).filter((w) => w !== '');

describe('help and Tab agree on declared completion candidates', () => {
  it('witness: Tab completes a typed prefix of a time zone', async () => {
    const r = await router();
    expect(r.cliTabCandidates('clock timezone C'))
      .toEqual(['clock timezone CAT', 'clock timezone CET', 'clock timezone CST']);
  });

  it('`?` after a typed prefix names the same zones as Tab', async () => {
    const r = await router();
    expect(helpWords(r.cliHelp('clock timezone C'))).toEqual(['CAT', 'CET', 'CST']);
  });

  it('`?` on the empty place lists the zones next to the WORD type', async () => {
    const r = await router();
    const words = helpWords(r.cliHelp('clock timezone '));
    expect(words).toContain('WORD');
    expect(words).toEqual(expect.arrayContaining(['CET', 'PST', 'UTC']));
  });

  it('the summer-time zone place behaves the same way', async () => {
    const r = await router();
    expect(helpWords(r.cliHelp('clock summer-time CE'))).toEqual(['CEST']);
    expect(helpWords(r.cliHelp('clock summer-time '))).toEqual(
      expect.arrayContaining(['WORD', 'CEST', 'BST']));
  });
});
