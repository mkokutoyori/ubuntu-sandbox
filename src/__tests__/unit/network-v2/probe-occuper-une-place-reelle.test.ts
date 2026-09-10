/**
 * `dd`, `fallocate`, `sync` : occuper une place, et la voir occupee.
 *
 * Ecrit A L'AVEUGLE. Mesure de depart sur un poste Linux ordinaire :
 *
 * ```
 * dd if=/dev/zero of=/tmp/x bs=1M count=8   dd: command not found
 * fallocate -l 8M /tmp/y                    fallocate: command not found
 * sync                                      sync: command not found
 * cat /proc/swaps                           No such file or directory
 * ```
 *
 * `dd` est LA commande par laquelle on remplit un disque, on fabrique un
 * fichier d'echange, on copie une image, on mesure un debit. Son absence
 * laisse `truncate` seul, qui pose une taille mais ne copie rien. Et
 * `/proc/swaps` manquait alors que `free` annonce 2 Gio d'echange et que
 * `swapon -s` rend deja EXACTEMENT ce tableau : une troisieme vue du
 * meme fait, absente.
 *
 * ── L'autorite ─────────────────────────────────────────────────────
 *
 * Les formats ci-dessous ne sont pas devines : ils sont RELEVES sur la
 * machine reelle qui execute ce depot (`dd (coreutils) 9.4`), ce qu'un
 * transcrit capture autorise avant toute documentation. Trois regles en
 * sortent, qu'aucune page de manuel n'ecrit :
 *
 * ```
 * 999 octets      999 bytes copied, ...
 * 1000 octets     1000 bytes (1.0 kB) copied, ...
 * 1024 octets     1024 bytes (1.0 kB, 1.0 KiB) copied, ...
 * ```
 *
 * La forme SI apparait a 1000 octets, la forme IEC seulement a 1024 ; et
 * un bloc incomplet se compte a part (`0+1 records in` pour 11 octets
 * lus par blocs de 512).
 *
 * ── Discrimination (`git stash push -- src/network`) ───────────────
 *
 * Mesuree : 13 cas sur 15 tombent contre l'etat d'avant. Les DEUX
 * autres sont les TEMOINS, et c'est leur role : `truncate`, le voisin
 * qui existait deja et qui partage desormais son joint
 * (`declaredSizeBytes`) avec `dd` et `fallocate` — il doit continuer de
 * poser sa taille ; et `swapon -s`, dont `/proc/swaps` reprend les
 * chiffres sans les recalculer, ce qui n'a de valeur que si `swapon -s`
 * rend toujours son tableau.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Cmd { executeCommand(cmd: string): Promise<string> }

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

function poste(): Cmd {
  return createDevice('linux-pc', 0, 0) as unknown as Cmd;
}

function tailleDeLs(sortie: string): number {
  return Number(sortie.trim().split('\n').pop()?.trim().split(/\s+/)[4] ?? -1);
}

describe('dd copie, compte, et occupe', () => {
  it('huit mebioctets sont rendus dans les trois lignes de coreutils', async () => {
    const pc = poste();

    const sortie = await pc.executeCommand('dd if=/dev/zero of=/tmp/x bs=1M count=8');

    expect(sortie).toMatch(/^8\+0 records in$/m);
    expect(sortie).toMatch(/^8\+0 records out$/m);
    expect(sortie).toMatch(/^8388608 bytes \(8\.4 MB, 8\.0 MiB\) copied, [\d.e-]+ s, .+\/s$/m);
  });

  it('la place occupee est vue par ls et par df', async () => {
    const pc = poste();
    const avant = await pc.executeCommand('df /');

    await pc.executeCommand('dd if=/dev/zero of=/tmp/x bs=1M count=8');

    expect(tailleDeLs(await pc.executeCommand('ls -l /tmp/x'))).toBe(8388608);
    const utilise = (s: string) => Number(s.split('\n')[1].trim().split(/\s+/)[2]);
    expect(utilise(await pc.executeCommand('df /')))
      .toBeGreaterThan(utilise(avant) + 8000);
  });

  it('sous mille octets, aucune forme lisible n est ajoutee', async () => {
    const pc = poste();

    const sortie = await pc.executeCommand('dd if=/dev/zero of=/tmp/p bs=999 count=1');

    expect(sortie).toMatch(/^999 bytes copied, /m);
  });

  it('a mille octets la forme SI parait, la forme IEC seulement a 1024', async () => {
    const pc = poste();

    expect(await pc.executeCommand('dd if=/dev/zero of=/tmp/a bs=1000 count=1'))
      .toMatch(/^1000 bytes \(1\.0 kB\) copied, /m);
    expect(await pc.executeCommand('dd if=/dev/zero of=/tmp/b bs=1024 count=1'))
      .toMatch(/^1024 bytes \(1\.0 kB, 1\.0 KiB\) copied, /m);
  });

  it('un bloc incomplet se compte a part', async () => {
    const pc = poste();
    await pc.executeCommand('echo -n "hello world" > /tmp/src');

    const sortie = await pc.executeCommand('dd if=/tmp/src of=/tmp/dst');

    expect(sortie).toMatch(/^0\+1 records in$/m);
    expect(sortie).toMatch(/^11 bytes copied, /m);
    expect(await pc.executeCommand('cat /tmp/dst')).toContain('hello world');
  });

  it('une entree absente est REFUSEE', async () => {
    const pc = poste();

    expect(await pc.executeCommand('dd if=/tmp/nope of=/tmp/out'))
      .toContain("dd: failed to open '/tmp/nope': No such file or directory");
  });

  it('status=none ne dit rien', async () => {
    const pc = poste();

    expect((await pc.executeCommand('dd if=/dev/zero of=/tmp/q bs=1M count=1 status=none')).trim())
      .toBe('');
  });

  it('un disque plein arrete la copie, avec le mot du noyau', async () => {
    const pc = poste();
    await pc.executeCommand('truncate -s 47G /tmp/plein');

    const sortie = await pc.executeCommand('dd if=/dev/zero of=/tmp/trop bs=1M count=4096');

    expect(sortie).toContain('No space left on device');
  });
});

describe('fallocate et sync', () => {
  it('fallocate pose la taille sans rien dire', async () => {
    const pc = poste();

    expect((await pc.executeCommand('fallocate -l 8M /tmp/f')).trim()).toBe('');
    expect(tailleDeLs(await pc.executeCommand('ls -l /tmp/f'))).toBe(8388608);
  });

  it('ses deux manques ont chacun leur mot', async () => {
    const pc = poste();

    expect(await pc.executeCommand('fallocate -l 8M')).toContain('fallocate: no filename specified');
    expect(await pc.executeCommand('fallocate /tmp/f')).toContain('fallocate: no length argument specified');
  });

  it('sync ne dit rien et reussit', async () => {
    const pc = poste();

    expect((await pc.executeCommand('sync')).trim()).toBe('');
    expect((await pc.executeCommand('sync; echo $?')).trim().split('\n').pop()).toBe('0');
  });
});

describe('/proc/swaps est la troisieme vue du meme echange', () => {
  it('il porte l en-tete tabule du noyau', async () => {
    const pc = poste();

    expect(await pc.executeCommand('cat /proc/swaps'))
      .toContain('Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority');
  });

  it('ses chiffres sont ceux de swapon -s', async () => {
    const pc = poste();

    const parProc = (await pc.executeCommand('cat /proc/swaps')).split('\n')[1] ?? '';
    const parSwapon = (await pc.executeCommand('swapon -s')).split('\n')[1] ?? '';

    expect(parProc).toBe(parSwapon);
  });
});

describe('TEMOINS', () => {
  it('truncate, le voisin qui existait deja, marche toujours', async () => {
    const pc = poste();

    await pc.executeCommand('truncate -s 64M /tmp/t');

    expect(tailleDeLs(await pc.executeCommand('ls -l /tmp/t'))).toBe(67108864);
  });

  it('swapon -s garde son tableau', async () => {
    const pc = poste();

    expect(await pc.executeCommand('swapon -s')).toContain('/swapfile');
  });
});
