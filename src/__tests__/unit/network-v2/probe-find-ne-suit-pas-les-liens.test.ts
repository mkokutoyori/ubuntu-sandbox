/**
 * find walks the tree the way GNU findutils does by default (-P): a symbolic link met below the starting point is reported as a link and never
 * descended into. /proc/<pid>/root, /proc/<pid>/cwd and /proc/<pid>/exe are links, so a find that followed them re-entered / through every
 * process and never came back (two workers of a wide regression sweep ran for over an hour inside _findRecursive).
 *
 *   find /tmp -maxdepth 4            with /tmp/loop -> /  lists /tmp and /tmp/loop only (it listed /tmp/loop/bin, /tmp/loop/etc, ...)
 *   find /tmp -maxdepth 3 -type l    reports the links (the walk resolved every link, so -type l never matched one)
 *   find /proc/$$ -maxdepth 2        stops at /proc/<pid>/root instead of listing the children of /
 *   find /proc/$$/fd -type l         the descriptor entries are links
 *   find /tmp/etc-link/ -name x      the starting point itself is still resolved, as `find /lib` must work when /lib is a link
 *   find / -name <absent>            WITNESS built in the same lab: it returns, with a live process and its /proc/<pid>/root present.
 *                                    On the unfixed tree this case never returns (the walk is exponential and synchronous, so no test
 *                                    timeout can interrupt it), which is why the discrimination run leaves it out.
 *
 * Measured with the sources at HEAD: 4 of the 5 bounded cases fall (the loop listing, -type l, the /proc descent and the descriptor links);
 * the one that passes either way is the starting-point resolution (NON-REGRESSION).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let pc: LinuxPC;

async function root(line: string): Promise<string> {
  const machine = pc as unknown as { executor: { runAsUser<T>(user: string, run: () => Promise<T>): Promise<T> } };
  const text = await machine.executor.runAsUser('root', () => pc.executeCommand(line));
  return text.replace(/^\[\d+\] \d+\n?/gm, '').replace(/\n$/, '');
}

beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  await root('cd /tmp');
});

describe('find and symbolic links', () => {
  it('lists a link to / as one entry without entering it', async () => {
    await root('ln -s / /tmp/loop');
    expect(await root('find /tmp -maxdepth 4')).toBe('/tmp\n/tmp/loop');
  });

  it('reports links with -type l', async () => {
    await root('ln -s / /tmp/loop; ln -s /etc/hostname /tmp/name; touch /tmp/plain');
    expect((await root('find /tmp -maxdepth 3 -type l')).split('\n').sort()).toEqual(['/tmp/loop', '/tmp/name']);
  });

  it('does not descend into /proc/<pid>/root', async () => {
    const below = await root('find /proc/$$ -maxdepth 2 | grep -c "/root/"');
    expect(below).toBe('0');
  });

  it('WITNESS: the descriptor links of a process are links', async () => {
    await root('sleep 100 &');
    expect(await root('find /proc/$$/fd -type l | wc -l')).not.toBe('0');
  });

  it('still resolves the starting point when it is a link', async () => {
    await root('ln -s /etc /tmp/etc-link');
    expect(await root('find /tmp/etc-link/ -maxdepth 1 -name hostname')).toBe('/tmp/etc-link/hostname');
  });

  it('WITNESS: a search over / with a live process returns', async () => {
    await root('sleep 100 &');
    expect(await root('find / -name definitely-not-here-xyz')).toBe('');
  }, 60000);
});
