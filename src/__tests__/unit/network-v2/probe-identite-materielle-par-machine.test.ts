/**
 * Deux machines du meme canevas sont deux machines DIFFERENTES.
 *
 * Ecrit A L'AVEUGLE. Mesure de depart : deux `linux-pc` poses cote a
 * cote, la meme question a chacun.
 *
 * ```
 * blkid                       /dev/sda1: UUID="0035ca01-…"   IDENTIQUE
 * cat /etc/machine-id         0a1b2c3d4e5f60718293a4b5c6d7e8f9  IDENTIQUE
 * dmidecode -s system-uuid    00000000-0000-0000-0000-000000000000  (les deux)
 * dmidecode -s system-serial-number   Not Specified          (les deux)
 * lsblk -o NAME,SERIAL        sda  QM00001                   IDENTIQUE
 * hdparm -I /dev/sda          Serial Number: QM00001         IDENTIQUE
 * ```
 *
 * Rien de cosmetique. `/etc/machine-id` est ce qu'un client DHCP emet
 * comme identifiant (RFC 4361), ce qui journalise une machine, ce sur
 * quoi un inventaire s'appuie : deux machines qui le partagent est une
 * panne de production classique. Les UUID de `blkid` sont pires depuis
 * que `/etc/fstab` existe : la racine y est nommee `UUID=`, donc le
 * fstab d'une machine designe aussi bien le disque de sa voisine. Et
 * l'UUID SMBIOS a zero prive tout laboratoire d'inventaire, de PXE ou
 * de licence de la seule chose qui distingue un chassis.
 *
 * Le depot savait deja le faire : `WindowsFileSystem.getVolumeSerialNumber()`
 * derive un numero de serie de volume du nom d'hote, et les deux postes
 * Windows en ont bien deux differents. C'est ce mecanisme qui manquait a
 * l'inventaire materiel.
 *
 * ── DEUX cas ecrits a l'aveugle, puis RETIRES apres verification ────
 *
 * La premiere version de cette sonde exigeait aussi que le numero de
 * serie de CHASSIS et celui du DISQUE different d'une machine a l'autre.
 * La documentation dit le contraire, et c'est elle qui gagne. Un invite
 * QEMU nu ne porte pas de numero de serie SMBIOS — `dmidecode -s
 * system-serial-number` rend « Not Specified » tant que libvirt ou
 * Proxmox n'en pose pas un (`-smbios type=1,serial=...`) : le rendre
 * unique aurait EDULCORE le modele. Et `QM00001` n'est pas une constante
 * inventee ici : c'est le numero que QEMU donne par defaut a son premier
 * disque IDE, le second recevant `QM00002`
 * (`/dev/disk/by-id/ata-QEMU_HARDDISK_QM00002`). Deux VM QEMU portent
 * donc bien le meme `QM00001`. Le VRAI defaut du voisinage est ailleurs,
 * et il est mesure ci-dessous : les DEUX disques d'un serveur annoncent
 * `QM00001`, parce que le numero etait une constante et non l'index du
 * disque.
 *
 * ── Windows : wmic RANGE la question qu'on lui pose ─────────────────
 *
 * `wmic csproduct get uuid` ne rendait RIEN, et
 * `wmic diskdrive get model,size` non plus : les deux classes
 * n'existaient pas. Pire, `wmic logicaldisk get caption,freespace,size`
 * rendait la colonne `Name` et les lettres de lecteur — la liste de
 * proprietes etait purement IGNOREE, donc la commande repondait a une
 * autre question que celle posee, en silence. Un vrai wmic rend les
 * colonnes demandees, dans l'ordre ALPHABETIQUE du nom de propriete, et
 * refuse une propriete que la classe ne porte pas
 * (`Description = Invalid query`).
 *
 * ── Discrimination (`git stash push -- src/network src/powershell`) ─
 *
 * Mesuree : 10 cas sur 13 tombent contre l'etat d'avant. Les TROIS qui
 * passent des deux cotes, et pourquoi :
 *
 *  - « vol garde le numero de serie de volume » — TEMOIN. C'est le seul
 *    identifiant deja unique par machine ; il prouve que le mecanisme
 *    existant n'a pas ete deplace en route.
 *  - « wmic logicaldisk get name repond toujours les lettres » —
 *    TEMOIN/NON-REGRESSION. C'est la seule requete que l'ancienne
 *    branche codee en dur servait juste ; elle doit continuer.
 *  - « lsblk et hdparm nomment le MEME disque » — TEMOIN de coherence.
 *    Les deux vues lisaient deja l'inventaire ; le cas garde qu'en
 *    indexant le numero de serie par disque on n'en a pas fait diverger
 *    une seule.
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

function deuxPostes(): [Cmd, Cmd] {
  return [
    createDevice('linux-pc', 0, 0) as unknown as Cmd,
    createDevice('linux-pc', 200, 0) as unknown as Cmd,
  ];
}

function deuxPostesWindows(): [Cmd, Cmd] {
  return [
    createDevice('windows-pc', 0, 0) as unknown as Cmd,
    createDevice('windows-pc', 200, 0) as unknown as Cmd,
  ];
}

function uuidRacine(blkid: string): string {
  return /\/dev\/sda1: UUID="([^"]+)"/.exec(blkid)?.[1] ?? '<aucun>';
}

function colonnes(sortie: string): string[] {
  return sortie.split('\n')[0].trim().split(/\s+/);
}

describe('Linux — deux machines, deux identites', () => {
  it('leurs /etc/machine-id different, et chacun est 32 hexa minuscules', async () => {
    const [a, b] = deuxPostes();

    const ida = (await a.executeCommand('cat /etc/machine-id')).trim();
    const idb = (await b.executeCommand('cat /etc/machine-id')).trim();

    expect(ida).toMatch(/^[0-9a-f]{32}$/);
    expect(idb).toMatch(/^[0-9a-f]{32}$/);
    expect(ida).not.toBe(idb);
  });

  it('leurs systemes de fichiers ne portent pas le meme UUID', async () => {
    const [a, b] = deuxPostes();

    const ua = uuidRacine(await a.executeCommand('sudo blkid'));
    const ub = uuidRacine(await b.executeCommand('sudo blkid'));

    expect(ua).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(ua).not.toBe(ub);
  });

  it('chaque fstab designe le disque de SA machine', async () => {
    const [a, b] = deuxPostes();

    const ua = uuidRacine(await a.executeCommand('sudo blkid'));
    const fstabB = await b.executeCommand('cat /etc/fstab');

    expect(await a.executeCommand('cat /etc/fstab')).toContain(`UUID=${ua}`);
    expect(fstabB).not.toContain(`UUID=${ua}`);
  });

  it('leur UUID SMBIOS n est ni nul ni partage', async () => {
    const [a, b] = deuxPostes();

    const ua = (await a.executeCommand('sudo dmidecode -s system-uuid')).trim();
    const ub = (await b.executeCommand('sudo dmidecode -s system-uuid')).trim();

    expect(ua).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
    expect(ua).not.toBe('00000000-0000-0000-0000-000000000000');
    expect(ua).not.toBe(ub);
  });

  it('les deux disques d un serveur portent deux numeros de serie', async () => {
    const srv = createDevice('linux-server', 0, 0) as unknown as Cmd;

    const sortie = await srv.executeCommand('lsblk -o NAME,SERIAL');
    const serie = (dev: string) => sortie.split('\n')
      .find((l) => new RegExp(`^${dev}\\s`).test(l))?.trim().split(/\s+/)[1] ?? '<aucun>';

    expect(serie('sda')).toBe('QM00001');
    expect(serie('sdb')).toBe('QM00002');
  });

  it('lsblk et hdparm nomment le MEME disque', async () => {
    const [a] = deuxPostes();

    const parLsblk = (await a.executeCommand('lsblk -o NAME,SERIAL'))
      .split('\n').find((l) => /^sda\s/.test(l))?.trim().split(/\s+/)[1] ?? '<aucun>';
    const parHdparm = /Serial Number:\s+(\S+)/
      .exec(await a.executeCommand('sudo hdparm -I /dev/sda'))?.[1] ?? '<aucun>';

    expect(parHdparm).toBe(parLsblk);
  });
});

describe('Windows — wmic rend les proprietes demandees', () => {
  it('csproduct porte l UUID SMBIOS, et deux postes en ont deux', async () => {
    const [w1, w2] = deuxPostesWindows();

    const s1 = await w1.executeCommand('wmic csproduct get uuid');
    const s2 = await w2.executeCommand('wmic csproduct get uuid');

    expect(colonnes(s1)).toEqual(['UUID']);
    const val = (s: string) => s.split('\n')[1].trim();
    expect(val(s1)).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
    expect(val(s1)).not.toBe(val(s2));
  });

  it('diskdrive rend model, serialnumber et size, dans l ordre alphabetique', async () => {
    const [w1] = deuxPostesWindows();

    const sortie = await w1.executeCommand('wmic diskdrive get size,model,serialnumber');

    expect(colonnes(sortie)).toEqual(['Model', 'SerialNumber', 'Size']);
    const champs = sortie.split('\n')[1].trim().split(/\s{2,}/);
    expect(champs[champs.length - 1]).toMatch(/^\d+$/);
  });

  it('logicaldisk rend les colonnes demandees, pas la colonne Name', async () => {
    const [w1] = deuxPostesWindows();

    const sortie = await w1.executeCommand('wmic logicaldisk get caption,freespace,size');

    expect(colonnes(sortie)).toEqual(['Caption', 'FreeSpace', 'Size']);
    const ligneC = sortie.split('\n').slice(1).find((l) => l.trim().startsWith('C:')) ?? '';
    const champs = ligneC.trim().split(/\s+/);
    expect(champs[0]).toBe('C:');
    expect(champs[1]).toMatch(/^\d+$/);
    expect(champs[2]).toMatch(/^\d+$/);
  });

  it('la place libre annoncee par wmic est celle que dir compte', async () => {
    const [w1] = deuxPostesWindows();

    const sortie = await w1.executeCommand('wmic logicaldisk get caption,freespace');
    const parWmic = sortie.split('\n').slice(1)
      .find((l) => l.trim().startsWith('C:'))?.trim().split(/\s+/)[1] ?? '<aucun>';
    const parDir = /([\d,]+) bytes free/
      .exec(await w1.executeCommand('dir C:\\'))?.[1].replace(/,/g, '') ?? '<aucun>';

    expect(parWmic).toBe(parDir);
  });

  it('une propriete que la classe ne porte pas est REFUSEE', async () => {
    const [w1] = deuxPostesWindows();

    const sortie = await w1.executeCommand('wmic logicaldisk get zorglub');

    expect(sortie).toContain('Description = Invalid query');
    expect(sortie).not.toContain('C:');
  });
});

describe('TEMOINS', () => {
  it('vol garde le numero de serie de volume, deja unique par machine', async () => {
    const [w1, w2] = deuxPostesWindows();

    const serie = (s: string) => /Volume Serial Number is (\S+)/.exec(s)?.[1] ?? '<aucun>';
    const s1 = serie(await w1.executeCommand('vol'));

    expect(s1).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(s1).not.toBe(serie(await w2.executeCommand('vol')));
  });

  it('wmic logicaldisk get name repond toujours les lettres', async () => {
    const [w1] = deuxPostesWindows();

    const sortie = await w1.executeCommand('wmic logicaldisk get name');

    expect(colonnes(sortie)).toEqual(['Name']);
    expect(sortie).toContain('C:');
  });
});
