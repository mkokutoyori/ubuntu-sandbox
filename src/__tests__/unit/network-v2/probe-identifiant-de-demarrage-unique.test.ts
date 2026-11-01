/**
 * Une machine a UN identifiant de demarrage. Mesure de depart : `journalctl --list-boots` en donnait un (derive du nom, du machine-id et de l'heure de demarrage
 * par journald), `hostnamectl` un autre (une constante ecrite en dur, la MEME pour toutes les machines) et `/proc/sys/kernel/random/boot_id` n'existait pas
 * (alors que DnssdFiles le lit pour `%b`) ; `/proc/sys/kernel/random/uuid`, qui rend un UUID neuf a chaque lecture, non plus. Corrige : `SystemIdentity.bootId`,
 * propre a la machine (UUID version 4, comme le noyau le forme), est la seule source ; journald le lit, `hostnamectl` le rend, `/proc` l'expose avec ses tirets.
 * Format releve sur la machine de reference : `9675cd6a-8fde-4b5c-a21c-eb5f8900d4c3` (version 4, variante 8-b) pour boot_id et uuid.
 *
 * Discrimine par `git stash` sur src : 6 des 10 cas tombent avant (version 4, uuid, les trois accords entre vues, deux machines). TEMOINS : l'identifiant de `hostnamectl`
 * est stable, `journalctl --list-boots` nomme un seul demarrage, deux machines ont des machine-id differents ; « le meme a chaque lecture » passe avant le lot
 * pour une mauvaise raison (les deux lectures echouent pareil), c'est le cas de format qui le garde honnete.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function machine(name: string) {
  const pc = new LinuxPC('linux-pc', name);
  pc.powerOn();
  return async (command: string): Promise<string> => String(await pc.executeCommand(command)).trim();
}

describe('one boot id per machine', () => {
  it('WITNESS — hostnamectl names a boot id of 32 hex digits, stable between two calls', async () => {
    const run = machine('A');
    const first = (await run('hostnamectl')).match(/Boot ID: (\S+)/)?.[1];
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect((await run('hostnamectl')).match(/Boot ID: (\S+)/)?.[1]).toBe(first);
  });

  it('WITNESS — journalctl --list-boots lists one boot', async () => {
    const rows = (await machine('A')('journalctl --list-boots')).split('\n').filter((line) => /^\s*0\s/.test(line));
    expect(rows).toHaveLength(1);
  });

  it('WITNESS — two machines have different machine ids', async () => {
    const id = async (name: string) => machine(name)('cat /etc/machine-id');
    expect(await id('A')).not.toBe(await id('B'));
  });

  it('/proc/sys/kernel/random/boot_id is a version 4 UUID', async () => {
    expect(await machine('A')('cat /proc/sys/kernel/random/boot_id')).toMatch(V4);
  });

  it('boot_id is the same on every read', async () => {
    const run = machine('A');
    expect(await run('cat /proc/sys/kernel/random/boot_id')).toBe(await run('cat /proc/sys/kernel/random/boot_id'));
  });

  it('sysctl reads the same file', async () => {
    const run = machine('A');
    expect(await run('sysctl -n kernel.random.boot_id')).toBe(await run('cat /proc/sys/kernel/random/boot_id'));
  });

  it('journalctl names the boot id that /proc names', async () => {
    const run = machine('A');
    const proc = (await run('cat /proc/sys/kernel/random/boot_id')).replace(/-/g, '');
    expect(await run('journalctl --list-boots')).toContain(proc);
  });

  it('hostnamectl names the boot id that /proc names', async () => {
    const run = machine('A');
    const proc = (await run('cat /proc/sys/kernel/random/boot_id')).replace(/-/g, '');
    expect((await run('hostnamectl')).match(/Boot ID: (\S+)/)?.[1]).toBe(proc);
  });

  it('two machines do not share a boot id', async () => {
    const id = async (name: string) => machine(name)('cat /proc/sys/kernel/random/boot_id');
    expect(await id('A')).not.toBe(await id('B'));
  });

  it('/proc/sys/kernel/random/uuid is a new version 4 UUID on every read', async () => {
    const run = machine('A');
    const first = await run('cat /proc/sys/kernel/random/uuid');
    const second = await run('cat /proc/sys/kernel/random/uuid');
    expect(first).toMatch(V4);
    expect(second).toMatch(V4);
    expect(second).not.toBe(first);
  });
});
