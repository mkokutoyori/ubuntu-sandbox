/**
 * Les appels systeme d'un programme vu par audit : cat, ls (un repertoire), whoami, hostname et uname rejouent la
 * trace strace -X raw de leur binaire reel (coreutils 9.4, Ubuntu 24.04.4, enregistree par
 * scripts/oracle/record_syscall_traces.py : chargeur dynamique, bibliotheques, lecture, ecriture, fermeture). Les
 * quantites que le simulateur connait remplacent celles de l'enregistrement : le read d'un operande rend la taille
 * du fichier simule, le write de la sortie rend la longueur affichee, getdents64 la taille des entrees du repertoire
 * simule (. et .. comptes, 8 octets d'alignement : le ls reel d'un repertoire a deux fichiers rend 96). Rien n'est
 * rejoue sans regle `exit` active, avec une option, ou si un operande manque : l'ancien chemin reste. Limites :
 * exit_group n'est pas rejoue ; ls sans operande, avec option ou plusieurs operandes, et les autres commandes
 * gardent le seul execve/openat.
 *
 * Mesure avant : `autrace /usr/bin/cat f` ne voyait que l'execve et l'openat ; une regle sur /etc/ld.so.cache ne
 * se declenchait jamais. Avec src/network remis avant, 6 cas sur 8 tombent ; 2 passent dans les deux etats : le
 * temoin (une surveillance -w ne declenche qu'un enregistrement, sans rejeu) et « un fichier absent n'est pas
 * rejoue » ; ils bornent les cas qui rejouent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

async function rootHost(): Promise<LinuxPC> {
  const pc = new LinuxPC('AuditHost', 0, 0);
  await pc.executeCommand('sudo su -');
  return pc;
}

const pidOf = (out: string): string => /-p (\d+)'/.exec(out)?.[1] ?? '';
const records = (pc: LinuxPC, pid: string): Promise<string> => pc.executeCommand(`ausearch -i -p ${pid}`);
const calls = (text: string): string[] => [...text.matchAll(/syscall=(\w+) /g)].map((match) => match[1]);

beforeEach(() => { resetCounters(); MACAddress.resetCounter(); Logger.reset(); });

describe('program syscall traces', () => {
  it('witness: a watch rule is hit once by cat, with no replayed syscalls', async () => {
    const pc = await rootHost();
    await pc.executeCommand('auditctl -w /etc/hostname -p r -k watched');
    await pc.executeCommand('cat /etc/hostname');
    expect((await pc.executeCommand('ausearch -k watched -r | grep -c "type=SYSCALL"')).trim()).toBe('1');
  });

  it('autrace on cat shows the loader, the file read and the write', async () => {
    const pc = await rootHost();
    await pc.executeCommand('printf "abcdefghij" > /tmp/ten');
    const text = await records(pc, pidOf(await pc.executeCommand('autrace /usr/bin/cat /tmp/ten')));
    expect(text).toContain('name=/etc/ld.so.cache');
    expect(text).toContain('name=/lib/x86_64-linux-gnu/libc.so.6');
    expect(text).toMatch(/syscall=read success=yes exit=10 a0=0x3 .* a2=0x20000/);
    expect(text).toMatch(/syscall=write success=yes exit=10 a0=0x1 .* a2=0xa /);
    expect(calls(text)).toEqual(expect.arrayContaining(['execve', 'brk', 'mmap', 'openat', 'read', 'write', 'close']));
    expect(calls(text).length).toBeGreaterThan(30);
  });

  it('the read and write sizes follow the file, not the recording', async () => {
    const pc = await rootHost();
    await pc.executeCommand('printf "xy" > /tmp/two');
    const text = await records(pc, pidOf(await pc.executeCommand('autrace /usr/bin/cat /tmp/two')));
    expect(text).toMatch(/syscall=read success=yes exit=2 /);
    expect(text).toMatch(/syscall=write success=yes exit=2 /);
  });

  it('two operands run the per-file block twice', async () => {
    const pc = await rootHost();
    await pc.executeCommand('printf "a" > /tmp/one; printf "bb" > /tmp/two');
    const text = await records(pc, pidOf(await pc.executeCommand('autrace /usr/bin/cat /tmp/one /tmp/two')));
    expect((text.match(/name=\/tmp\/one/g) ?? []).length).toBe(1);
    expect((text.match(/name=\/tmp\/two/g) ?? []).length).toBe(1);
    expect(calls(text).filter((name) => name === 'write').length).toBe(2);
  });

  it('ls on a directory of two files reads 96 bytes of entries, as the real ls does', async () => {
    const pc = await rootHost();
    await pc.executeCommand('mkdir -p /tmp/d1 && touch /tmp/d1/a /tmp/d1/b');
    const text = await records(pc, pidOf(await pc.executeCommand('autrace /usr/bin/ls /tmp/d1')));
    expect(text).toMatch(/syscall=getdents64 success=yes exit=96 /);
    expect(text).toMatch(/syscall=getdents64 success=yes exit=0 /);
    expect(text).toMatch(/syscall=write success=yes exit=5 /);
  });

  it('a no-operand program replays its own trace', async () => {
    const pc = await rootHost();
    const text = await records(pc, pidOf(await pc.executeCommand('autrace /usr/bin/whoami')));
    expect(text).toMatch(/syscall=write success=yes exit=5 a0=0x1 /);
    expect(calls(text).length).toBeGreaterThan(30);
  });

  it('a rule on the dynamic loader fires for every traced program run', async () => {
    const pc = await rootHost();
    await pc.executeCommand('auditctl -a always,exit -F arch=b64 -S openat -F path=/etc/ld.so.cache -k loader');
    await pc.executeCommand('cat /etc/hostname');
    await pc.executeCommand('whoami');
    expect((await pc.executeCommand('ausearch -k loader -r | grep -c "type=SYSCALL"')).trim()).toBe('2');
  });

  it('a file that does not exist is not replayed', async () => {
    const pc = await rootHost();
    const text = await records(pc, pidOf(await pc.executeCommand('autrace /usr/bin/cat /tmp/absent')));
    expect(text).not.toContain('name=/etc/ld.so.cache');
  });
});
