/**
 * One chain walk, two callers.
 *
 * `getent` (through `NameServiceSwitch`) and the account model (through
 * `LinuxUserManager`) both resolve names by walking `/etc/nsswitch.conf`.
 * They used to have a copy of the `[STATUS=action]` rules each, which is
 * two chances to disagree — and a machine where `getent passwd alice` and
 * `id alice` answer differently is worse than one where both are wrong,
 * because nothing in the diagnosis adds up.
 *
 * `nss/chainWalk.ts` now holds the rule and both drive it. The first half
 * of this file tests that rule directly; the second half checks the two
 * callers still agree on a live machine, which is the property that would
 * actually break if they ever drifted again.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { startNssWalk, defaultNssMerge } from '@/network/devices/linux/nss/chainWalk';
import type { NssSourceSpec, NssResult, NssStatus } from '@/network/devices/linux/nss/types';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

const src = (name: string, actions: NssSourceSpec['actions'] = {}): NssSourceSpec =>
  ({ name, actions });
const ok = <T>(entry: T): NssResult<T> => ({ status: 'SUCCESS', entry });
const nf = <T>(): NssResult<T> => ({ status: 'NOTFOUND' });
const un = <T>(): NssResult<T> => ({ status: 'UNAVAIL' });

/** Drive a whole chain and report what it settled on. */
function walk<T>(
  steps: Array<[NssSourceSpec, NssResult<T>]>,
  merge?: (a: T, b: T) => T,
): NssResult<T> {
  const w = startNssWalk<T>(merge);
  for (const [spec, r] of steps) {
    const stop = w.step(spec, r);
    if (stop) return stop;
  }
  return w.finish();
}

describe('the shared [STATUS=action] rule', () => {
  it('by default the first success wins and the chain stops', () => {
    const r = walk([
      [src('files'), ok('depuis-le-fichier')],
      [src('systemd'), ok('depuis-systemd')],
    ]);
    expect(r).toEqual({ status: 'SUCCESS', entry: 'depuis-le-fichier' });
  });

  it('NOTFOUND continues by default, so a later source can answer', () => {
    const r = walk([
      [src('files'), nf<string>()],
      [src('systemd'), ok('depuis-systemd')],
    ]);
    expect(r.entry).toBe('depuis-systemd');
  });

  it('`[NOTFOUND=return]` ends the chain instead', () => {
    const r = walk([
      [src('files', { NOTFOUND: 'return' }), nf<string>()],
      [src('systemd'), ok('depuis-systemd')],
    ]);
    expect(r.status).toBe('NOTFOUND');
    expect(r.entry).toBeUndefined();
  });

  it('UNAVAIL continues by default — a dead source is not an answer', () => {
    const r = walk([
      [src('files', { NOTFOUND: 'return' }), un<string>()],
      [src('systemd'), ok('depuis-systemd')],
    ]);
    // The NOTFOUND action is irrelevant here: this source never got as far
    // as "not found". Confusing the two statuses is the mistake that turns
    // a deleted /etc/passwd into an unrecoverable machine.
    expect(r.entry).toBe('depuis-systemd');
  });

  it('`[UNAVAIL=return]` is what actually stops a dead source', () => {
    const r = walk([
      [src('files', { UNAVAIL: 'return' }), un<string>()],
      [src('systemd'), ok('depuis-systemd')],
    ]);
    expect(r.status).toBe('UNAVAIL');
  });

  it('`[SUCCESS=continue]` lets a later source replace the answer', () => {
    const r = walk([
      [src('files', { SUCCESS: 'continue' }), ok('depuis-le-fichier')],
      [src('systemd'), ok('depuis-systemd')],
    ]);
    // glibc's last-wins. Returning the first answer here — which is what a
    // `action !== 'merge'` test does — makes `continue` behave as `return`.
    expect(r.entry).toBe('depuis-systemd');
  });

  it('`[SUCCESS=continue]` keeps the earlier answer if nobody else has one', () => {
    const r = walk([
      [src('files', { SUCCESS: 'continue' }), ok('depuis-le-fichier')],
      [src('systemd'), nf<string>()],
    ]);
    expect(r.entry).toBe('depuis-le-fichier');
  });

  it('`[SUCCESS=merge]` combines the answers instead of replacing', () => {
    const r = walk<string[]>([
      [src('files', { SUCCESS: 'merge' }), ok(['alice'])],
      [src('systemd'), ok(['bob'])],
    ]);
    expect(r.entry).toEqual(['alice', 'bob']);
  });

  it('the default merger only combines arrays, and keeps the first otherwise', () => {
    expect(defaultNssMerge([1], [2])).toEqual([1, 2]);
    expect(defaultNssMerge('a', 'b')).toBe('a');
  });

  it('reports NOTFOUND over UNAVAIL when both were seen', () => {
    const r = walk([
      [src('ldap'), un<string>()],
      [src('files'), nf<string>()],
    ]);
    // "no such name" is a more specific fact than "could not ask".
    expect(r.status).toBe('NOTFOUND' as NssStatus);
  });

  it('an empty chain reports NOTFOUND rather than throwing', () => {
    expect(walk<string>([]).status).toBe('NOTFOUND');
  });
});

describe('getent and the account model agree, because they share the walk', () => {
  async function box(): Promise<LinuxPC> {
    const d = new LinuxPC('linux-pc', 'PC1');
    await d.executeCommand('sudo su -');
    return d;
  }
  const run = (d: LinuxPC, cmd: string) => d.executeCommand(cmd);

  /** Does `getent` see this name? Does the account model? */
  async function bothSee(d: LinuxPC, name: string): Promise<[boolean, boolean]> {
    const viaGetent = (await run(d, `getent passwd ${name}`)).includes(`${name}:`);
    const viaModel = (await run(d, `id ${name}`)).includes(`(${name})`);
    return [viaGetent, viaModel];
  }

  it('agree on a name added to /etc/passwd by hand', async () => {
    const d = await box();
    await run(d, `sh -c "echo 'zoe:x:1500:1500:Zoe:/home/zoe:/bin/bash' >> /etc/passwd"`);

    expect(await bothSee(d, 'zoe')).toEqual([true, true]);
  });

  it('agree on a name removed by hand', async () => {
    const d = await box();
    await run(d, `sed -i '/^bob:/d' /etc/passwd`);

    expect(await bothSee(d, 'bob')).toEqual([false, false]);
  });

  it('agree when `files` is dropped from the chain', async () => {
    const d = await box();
    await run(d, `sed -i 's|^passwd:.*|passwd:         systemd|' /etc/nsswitch.conf`);

    // Both lose the file's accounts…
    expect(await bothSee(d, 'bob')).toEqual([false, false]);
    // …and both keep the record nss-systemd synthesises.
    expect(await bothSee(d, 'root')).toEqual([true, true]);
  });

  it('agree when the file is deleted outright', async () => {
    const d = await box();
    await run(d, 'rm /etc/passwd');

    expect(await bothSee(d, 'bob')).toEqual([false, false]);
    expect(await bothSee(d, 'root')).toEqual([true, true]);
  });

  it('agree on a duplicated name — first line wins on both paths', async () => {
    const d = await box();
    await run(d, `sh -c "echo 'bob:x:9999:9999:Imposteur:/home/x:/bin/sh' >> /etc/passwd"`);

    expect(await run(d, 'getent passwd bob')).not.toContain('9999');
    expect(await run(d, 'id bob')).not.toContain('9999');
  });
});
