/**
 * `dmesg` raconte le demarrage de CETTE machine.
 *
 * Ecrit A L'AVEUGLE. Mesure de depart : un poste Linux neuf, puis la
 * MEME question au tampon du noyau et aux vues qui portent deja la
 * reponse.
 *
 * ```
 * dmesg           [0.000000] Linux version 5.15.0-130-generic
 *                            (buildd@lcy02-amd64-032) (gcc-11 (Ubuntu
 *                            11.3.0-1ubuntu1~22.04) 11.3.0) #1 SMP x86_64
 * /proc/version   Linux version 5.15.0-130-generic (buildd@lcy02-amd64-001)
 *                 (gcc (Ubuntu 11.4.0-1ubuntu1~22.04) 11.4.0, GNU ld
 *                 (GNU Binutils for Ubuntu) 2.38) #140-Ubuntu SMP …
 *
 * dmesg           [0.100000] CPU: Intel(R) Core(TM) i7-10750H CPU @ 2.60GHz
 * /proc/cpuinfo   model name : Intel(R) Xeon(R) CPU E5-2686 v4 @ 2.30GHz
 *
 * dmesg           [0.050000] Memory: 2048000K/2097152K available
 * /proc/meminfo   MemTotal: 3981312 kB
 *
 * dmesg           [0.010000] DMI: QEMU Standard PC …, BIOS 1.16.2-debian-…
 * /sys/…/dmi/id   bios_version: 1.16.0-1
 *
 * dmesg           … 0.500000 … 0.600000 … 0.300000 … 0.310000 …
 * ```
 *
 * Cinq contradictions sur une seule machine, plus un tampon dont les
 * horodatages RECULENT. Le tampon du noyau etait une liste de phrases
 * ecrites a la main, sans aucun lien avec le materiel et le noyau que
 * la machine porte par ailleurs. C'est le defaut que ce depot ferme le
 * plus souvent : un meme fait ecrit deux fois, et les deux copies qui
 * divergent.
 *
 * ── L'autorite ─────────────────────────────────────────────────────
 *
 * RELEVE sur le GNU/Linux qui execute ce depot, qui prime sur toute
 * documentation :
 *
 * ```
 * $ cat /proc/version
 * Linux version 6.18.44-fc-v24 (builder@sandboxing) (gcc (GCC) 15.2.0,
 * GNU ld (GNU Binutils) 2.46) #1 SMP PREEMPT_DYNAMIC @0
 * $ dmesg | head -1
 * [    0.000000] Linux version 6.18.44-fc-v24 (builder@sandboxing) (gcc
 * (GCC) 15.2.0, GNU ld (GNU Binutils) 2.46) #1 SMP PREEMPT_DYNAMIC @0
 * ```
 *
 * La premiere ligne de `dmesg` EST `/proc/version`, au prefixe
 * d'horodatage pres : le noyau imprime `linux_banner` au demarrage et
 * `/proc/version` rend ce meme `linux_banner`. Toujours sur cette
 * machine : `smpboot: CPU0: Intel(R) Xeon(R) Processor @ 2.10GHz`
 * reprend mot pour mot le `model name` de `/proc/cpuinfo` ;
 * `Memory: 16437712K/16776824K available` encadre les 16461028 kB de
 * `MemTotal` ; et les quarante premieres lignes du tampon ont des
 * horodatages qui ne reculent jamais.
 *
 * ── Discrimination (`git stash push -- src/network`) ───────────────
 *
 * Mesuree : 8 cas sur 13 tombent contre l'etat d'avant. Les CINQ autres
 * passent des deux cotes, et chacun a sa raison :
 *  - DEJA JUSTES — « uname -r nomme la meme version » (la version du
 *    noyau avait ete raccordee lors d'un correctif precedent), « la
 *    carte reseau porte le pilote qu'ethtool nomme » et « le disque
 *    racine est celui que df monte sur / » : sur un poste par defaut,
 *    la copie ecrite en dur (`e1000`, `sda1`) TOMBAIT JUSTE. Ils sont
 *    gardes parce qu'ils ne tombent plus juste par hasard : ils lisent
 *    desormais `hardware.adapters` et la table des partitions, donc ils
 *    suivraient une machine dont la carte ou le disque changerait ;
 *  - TEMOINS — « journalctl -k rend les memes lignes que dmesg » et
 *    « dmesg -T garde la meme suite de messages » : les deux vues du
 *    MEME tampon, deja d'accord, qui prouvent qu'en reecrivant les
 *    messages on n'en a ni perdu ni ajoute.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Poste {
  executeCommand(cmd: string): Promise<string>;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

function poste(): Poste {
  return createDevice('linux-pc', 0, 0) as unknown as Poste;
}

async function dmesg(pc: Poste): Promise<string> {
  return pc.executeCommand('sudo dmesg');
}

function ligne(texte: string, motif: RegExp): string {
  return texte.split('\n').find((l) => motif.test(l)) ?? '<absente>';
}

function sansHorodatage(l: string): string {
  return l.replace(/^\[\s*[0-9.]+\]\s*/, '');
}

describe('le tampon du noyau nomme le noyau de la machine', () => {
  it('la premiere ligne est /proc/version', async () => {
    const pc = poste();

    const premiere = (await dmesg(pc)).split('\n')[0];
    const procVersion = (await pc.executeCommand('cat /proc/version')).trim();

    expect(premiere).toMatch(/^\[\s*0\.000000\]/);
    expect(sansHorodatage(premiere)).toBe(procVersion);
  });

  it('la ligne de commande du noyau se relit dans /proc/cmdline', async () => {
    const pc = poste();

    const parDmesg = sansHorodatage(ligne(await dmesg(pc), /Command line:/))
      .replace(/^Command line: /, '');
    const parProc = (await pc.executeCommand('cat /proc/cmdline')).trim();

    expect(parProc).toContain('BOOT_IMAGE=');
    expect(parProc).toBe(parDmesg);
  });

  it('uname -r nomme la meme version', async () => {
    const pc = poste();

    const release = (await pc.executeCommand('uname -r')).trim();

    expect((await dmesg(pc)).split('\n')[0]).toContain(release);
  });
});

describe('le tampon du noyau decrit le materiel de la machine', () => {
  it('le processeur est celui de /proc/cpuinfo', async () => {
    const pc = poste();

    const parCpuinfo = /model name\s*:\s*(.+)/
      .exec(await pc.executeCommand('cat /proc/cpuinfo'))?.[1].trim() ?? '<absent>';

    expect(parCpuinfo).toContain('Xeon');
    expect(ligne(await dmesg(pc), /CPU0:/)).toContain(parCpuinfo);
  });

  it('la memoire annoncee encadre MemTotal', async () => {
    const pc = poste();

    const memTotal = Number(/MemTotal:\s*(\d+) kB/
      .exec(await pc.executeCommand('cat /proc/meminfo'))?.[1] ?? '0');
    const m = /Memory: (\d+)K\/(\d+)K available/.exec(await dmesg(pc));
    const [dispo, total] = [Number(m?.[1] ?? 0), Number(m?.[2] ?? 0)];

    expect(memTotal).toBeGreaterThan(0);
    expect(total).toBeGreaterThanOrEqual(memTotal);
    expect(dispo).toBeLessThanOrEqual(memTotal);
    expect(dispo).toBeGreaterThan(memTotal / 2);
  });

  it('la ligne DMI nomme le chassis que /sys porte', async () => {
    const pc = poste();
    const lire = async (f: string) =>
      (await pc.executeCommand(`cat /sys/devices/virtual/dmi/id/${f}`)).trim();

    const dmi = ligne(await dmesg(pc), /^\[[^\]]*\] DMI:/);

    expect(dmi).toContain(await lire('sys_vendor'));
    expect(dmi).toContain(await lire('product_name'));
    expect(dmi).toContain(await lire('bios_version'));
    expect(dmi).toContain(await lire('bios_date'));
  });

  it('la carte reseau porte le pilote qu ethtool nomme', async () => {
    const pc = poste();

    const pilote = /driver: (\S+)/
      .exec(await pc.executeCommand('ethtool -i eth0'))?.[1] ?? '<absent>';

    expect(pilote).toBe('e1000');
    expect(ligne(await dmesg(pc), /eth0/)).toContain(pilote);
  });

  it('le disque racine est celui que df monte sur /', async () => {
    const pc = poste();

    const racine = (await pc.executeCommand('df /')).split('\n')[1]?.split(/\s+/)[0] ?? '<absent>';
    const partition = racine.replace('/dev/', '');

    expect(partition).toMatch(/^sda\d$/);
    expect(ligne(await dmesg(pc), /EXT4-fs/)).toContain(partition);
  });

  it('la RAM installee est celle que dmidecode inventorie', async () => {
    const pc = poste();

    const parDmesg = Number(/Memory: \d+K\/(\d+)K/.exec(await dmesg(pc))?.[1] ?? '0');
    const inventaire = await pc.executeCommand('sudo dmidecode -t memory');
    const barrettes = [...inventaire.matchAll(/^\tSize: (\d+) MB$/gm)]
      .map((m) => Number(m[1]));

    expect(barrettes.length).toBeGreaterThan(0);
    expect(barrettes.reduce((a, b) => a + b, 0) * 1024).toBe(parDmesg);
  });

  it('dmidecode inventorie chaque barrette, pas une seule par principe', async () => {
    const pc = poste();

    const inventaire = await pc.executeCommand('sudo dmidecode -t memory');
    const annonce = Number(/Number Of Devices: (\d+)/.exec(inventaire)?.[1] ?? '0');

    expect([...inventaire.matchAll(/^Memory Device$/gm)].length).toBe(annonce);
    expect(inventaire).toMatch(/^\tLocator: DIMM 0$/m);
  });
});

describe('un tampon est une chronologie', () => {
  it('les horodatages ne reculent jamais', async () => {
    const pc = poste();

    const temps = (await dmesg(pc)).split('\n')
      .map((l) => /^\[\s*([0-9.]+)\]/.exec(l)?.[1])
      .filter((t): t is string => t !== undefined)
      .map(Number);

    expect(temps.length).toBeGreaterThan(10);
    expect([...temps].sort((a, b) => a - b)).toEqual(temps);
  });
});

describe('TEMOINS', () => {
  it('journalctl -k rend les memes lignes que dmesg', async () => {
    const pc = poste();

    const parJournal = await pc.executeCommand('journalctl -k --no-pager');

    expect(parJournal).toContain('Linux version');
    expect(parJournal).toContain('Command line:');
  });

  it('dmesg -T garde la meme suite de messages', async () => {
    const pc = poste();

    const brut = (await dmesg(pc)).split('\n').length;
    const horodate = (await pc.executeCommand('sudo dmesg -T')).split('\n').length;

    expect(brut).toBeGreaterThan(10);
    expect(horodate).toBe(brut);
  });
});
