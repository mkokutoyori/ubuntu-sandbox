/**
 * `nc -W n` (netcat-openbsd 1.226-1ubuntu2) termine apres avoir recu n paquets du reseau. L'option etait lue
 * (NetcatOptions.receiveLimit, erreurs « receive limit too small » incluses) mais jamais evaluee : le client restait
 * connecte jusqu'a la fin du serveur (regle 6). Releve sur la machine de reference, serveur qui emet a, b, c, d
 * separement a 0,4 s d'intervalle :
 *   nc -W 2 127.0.0.1 P  -> « a » « b », rc 0          nc -W 1 127.0.0.1 P -> « a », rc 0
 *   nc -W 0 ... -> « nc: receive limit too small: 0 », rc 1     nc -W abc ... -> « nc: receive limit invalid: abc », rc 1
 * Corrige : converse compte les arrivees de donnees et s'arrete a la n-ieme, apres avoir ecrit ce qu'il a recu. Le serveur
 * `nc -i S -l` envoyait par ailleurs son entree d'un seul bloc ; il l'envoie maintenant ligne par ligne, S secondes avant
 * chacune, comme le client (sans quoi le serveur de la sonde ne se distinguait pas d'un envoi unique).
 * Le client de la sonde est alimente par `printf ''` : sans entree standard, nc se comporte comme sur un terminal et part
 * aussitot (indicateur `terminal` de converse), ce qui n'est pas le cas releve.
 *
 * Discrimine par `git stash` sur src/network : 2 des 4 cas tombent avant (-W 1 et -W 2 recevaient tout). TEMOINS : les
 * deux refus d'argument, deja evalues.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let pc: LinuxPC;

async function root(line: string): Promise<string> {
  const machine = pc as unknown as { executor: { runAsUser<T>(user: string, run: () => Promise<T>): Promise<T> } };
  return (await machine.executor.runAsUser('root', () => pc.executeCommand(line))).replace(/^\[\d+\] \d+\n?/gm, '').replace(/\n$/, '');
}

beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  await root('ip link set lo up');
  await root('cd /tmp');
});

const SERVER = (port: number) => `printf 'a\\nb\\nc\\nd\\n' | nc -i 1 -l 127.0.0.1 ${port} > /dev/null & sleep 0.3`;

describe('nc -W', () => {
  it('stops after the second packet', async () => {
    await root(SERVER(9401));
    expect(await root("printf '' | nc -W 2 127.0.0.1 9401; echo rc=$?")).toBe('a\nb\nrc=0');
  });

  it('stops after the first packet', async () => {
    await root(SERVER(9402));
    expect(await root("printf '' | nc -W 1 127.0.0.1 9402; echo rc=$?")).toBe('a\nrc=0');
  });

  it('WITNESS — a receive limit of 0 is refused', async () => {
    expect(await root('nc -W 0 127.0.0.1 9403; echo rc=$?')).toBe('nc: receive limit too small: 0\nrc=1');
  });

  it('WITNESS — a receive limit that is not a number is refused', async () => {
    expect(await root('nc -W abc 127.0.0.1 9404; echo rc=$?')).toBe('nc: receive limit invalid: abc\nrc=1');
  });
});
