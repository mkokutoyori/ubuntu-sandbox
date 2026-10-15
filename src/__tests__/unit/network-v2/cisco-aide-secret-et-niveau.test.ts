/**
 * Help (`?`) and parsing of the secret/password forms of `enable` and `username`, on the socle.
 *
 * Reference behaviour (Cisco IOS Security Command Reference, enable secret / enable password / username):
 * `enable secret ?` offers the format digits, `level` and the cleartext line; a format digit is followed by
 * exactly one more word, so `enable secret 5 ?` offers only that word and no `<cr>`; `enable secret level ?`
 * offers the level range; `username NAME secret 5 ?` and `password 0|7 ?` offer the word that follows too.
 *
 * Ours, not in the reference: the descriptions of the digit forms are the ones of the simulator.
 *
 * Measured with src stashed to HEAD (enable secret was a greedy trie command): `enable secret ?` offered only
 * LINE, `enable secret level ?` offered LINE/level/<cr>, `username admin password 0 ?` and `secret 5 ?` answered
 * <cr>: 8 of the 10 cases fall. Witnesses: the range of `username … privilege ?` and the caret on a bad level,
 * which were already right.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

beforeEach(() => { resetCounters(); resetDeviceCounters(); });

async function router(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  return r;
}

const words = (help: string): string[] => help.split('\n').map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);

describe('enable secret / password help', () => {
  it('enable secret ? offers the formats, level and the cleartext line', async () => {
    expect(words(await (await router()).executeCommand('enable secret ?'))).toEqual(['0', '5', '8', '9', 'LINE', 'level']);
  });
  it('a format digit is followed by one more word and no <cr>', async () => {
    const out = await (await router()).executeCommand('enable secret 5 ?');
    expect(words(out)).toEqual(['LINE']);
    expect(out).not.toContain('<cr>');
  });
  it('level offers its range, then the formats again', async () => {
    const r = await router();
    expect(words(await r.executeCommand('enable secret level ?'))).toEqual(['<1-15>']);
    expect(words(await r.executeCommand('enable secret level 5 ?'))).toEqual(['0', '5', '8', '9', 'LINE']);
  });
  it('a completed secret offers <cr> only', async () => {
    expect(words(await (await router()).executeCommand('enable secret level 5 5 abc ?'))).toEqual(['<cr>']);
  });
  it('enable password has its own formats', async () => {
    const r = await router();
    expect(words(await r.executeCommand('enable password ?'))).toEqual(['0', '7', 'LINE', 'level']);
    expect(words(await r.executeCommand('enable password 7 ?'))).toEqual(['LINE']);
  });
  it('enable secret lev? completes the keyword', async () => {
    expect(words(await (await router()).executeCommand('enable secret lev?'))).toEqual(['level']);
  });
  it('a format digit without its word is incomplete, and a bad level carries a caret', async () => {
    const r = await router();
    expect(await r.executeCommand('enable secret 5')).toContain('Incomplete command');
    expect(await r.executeCommand('enable secret level 99 x')).toContain('Invalid input detected');
  });
});

describe('username help', () => {
  it('password 0 ? and secret 5 ? offer the word that follows', async () => {
    const r = await router();
    expect(words(await r.executeCommand('username admin password 0 ?'))).toEqual(['LINE']);
    expect(words(await r.executeCommand('username admin secret 5 ?'))).toEqual(['LINE']);
  });
  it('witness (right before the change too): the privilege range', async () => {
    expect(words(await (await router()).executeCommand('username admin privilege ?'))).toEqual(['<0-15>']);
  });
  it('the secret is stored and removed by the socle forms', async () => {
    const r = await router();
    await r.executeCommand('enable secret level 4 mysecret');
    expect(await r.executeCommand('show running-config | include enable')).toContain('enable secret level 4');
    await r.executeCommand('no enable secret level 4');
    expect(await r.executeCommand('show running-config | include enable')).not.toContain('enable secret level 4');
  });
});
