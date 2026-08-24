/**
 * `dir`, `more`, `verify`, `delete`, `mkdir`, `rmdir`, `squeeze`, `pwd`
 * passent au socle — et le releve est pris AVANT.
 *
 * La famille est declaree une fois pour les deux plateformes : le
 * routeur et le commutateur portent exactement les memes huit chemins,
 * et c'est le genre d'uniformite qu'une declaration unique garantit la
 * ou deux enregistrements finissent par diverger.
 *
 * Une PORTEE mesuree et laissee telle quelle : les huit repondent aussi
 * en EXEC utilisateur, bien que `registerFileSystemCommands` porte le
 * commentaire inverse — elle est appelee avec la trie BRUTE et non par
 * `scopedTrie`, qui est le mecanisme prevu pour cela. La reference Cisco
 * donne EXEC pour `dir`, `more`, `pwd`, `delete` et `squeeze`, et
 * privilegie pour `verify` ; ce lot DEPLACE et ne change pas, donc la
 * portee est preservee et la nuance restante inscrite au `TODO.md`.
 *
 * Les cas d'ACCEPTATION sont verts avant comme apres : ils gardent le
 * sens « la declaration refuse ce que la machine acceptait », celui qui
 * n'a pas de garde-fou ailleurs. Les cas d'AIDE sont ce que la migration
 * apporte.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

type Machine = { executeCommand(c: string): Promise<string>; cliHelp(i: string): string };

const PLATEFORMES: ReadonlyArray<[string, () => Machine]> = [
  ['routeur', () => new CiscoRouter('R1', 0, 0) as unknown as Machine],
  ['commutateur', () => new CiscoSwitch('switch-cisco', 'SW1') as unknown as Machine],
];

async function privilegie(fabrique: () => Machine): Promise<Machine> {
  const d = fabrique();
  await d.executeCommand('enable');
  return d;
}

const motsAides = (aide: string): string[] =>
  aide.split('\n').map(l => l.trim().split(/\s{2,}/)[0])
    .filter(m => m.length > 0 && !m.startsWith('%'));

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`${nom} — le systeme de fichiers repond`, () => {
    it('`pwd` rend la racine', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('pwd')).toBe('flash:');
    });

    it('`dir` liste flash: sans qu on le nomme', async () => {
      const out = await (await privilegie(fabrique)).executeCommand('dir');
      expect(out).toContain('Directory of flash:');
    });

    it('`dir flash:` liste la meme chose', async () => {
      const d = await privilegie(fabrique);
      expect(await d.executeCommand('dir flash:'))
        .toBe(await d.executeCommand('dir'));
    });

    it('`dir /all` est accepte, et l option ne devient pas la cible', async () => {
      const out = await (await privilegie(fabrique)).executeCommand('dir /all');
      expect(out).toContain('Directory of flash:');
    });

    it('`dir nvram:` rend les deux entrees de la NVRAM', async () => {
      const out = await (await privilegie(fabrique)).executeCommand('dir nvram:');
      expect(out).toContain('Directory of nvram:/');
    });

    it('`dir zorglub:` nomme le systeme de fichiers absent', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('dir zorglub:'))
        .toBe('%Error opening zorglub: (No such file or directory)');
    });

    it('`more` seul est INCOMPLET, pas inconnu', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('more'))
        .toContain('Incomplete command');
    });

    it('`more flash:absent.cfg` nomme le fichier absent', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('more flash:absent.cfg'))
        .toBe('%Error opening flash:absent.cfg (No such file or directory)');
    });

    it('`more nvram:startup-config` relit la configuration sauvee', async () => {
      const d = await privilegie(fabrique);
      await d.executeCommand('write memory');
      const out = await d.executeCommand('more nvram:startup-config');
      expect(out).not.toContain('Invalid input');
      expect(out.length).toBeGreaterThan(0);
    });

    it('`verify` seul est INCOMPLET', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('verify'))
        .toContain('Incomplete command');
    });

    it('`verify flash:absent.bin` nomme le fichier absent', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('verify flash:absent.bin'))
        .toBe('%Error opening flash:absent.bin (No such file or directory)');
    });

    it('`verify /md5 <image>` calcule une somme — l option est un jeton a part', async () => {
      const d = await privilegie(fabrique);
      const liste = await d.executeCommand('dir');
      const image = /([\w.-]+\.bin)/.exec(liste)?.[1];
      expect(image, `aucune image dans:\n${liste}`).toBeTruthy();
      const out = await d.executeCommand(`verify /md5 flash:${image}`);
      expect(out).toContain('Verifying file integrity');
      expect(out).toMatch(/Computed Hash\s+MD5 : [0-9a-f]{32}/);
    });

    it('`delete` seul est INCOMPLET', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('delete'))
        .toContain('Incomplete command');
    });

    it('`delete flash:absent.cfg` nomme le fichier absent', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('delete flash:absent.cfg'))
        .toBe('%Error deleting flash:absent.cfg (No such file or directory)');
    });

    it('`delete /force flash:<archive>` retire le fichier pour de bon', async () => {
      const d = await privilegie(fabrique);
      await d.executeCommand('configure terminal');
      await d.executeCommand('archive');
      await d.executeCommand('path flash:cfg');
      await d.executeCommand('end');
      await d.executeCommand('archive config');
      const avant = await d.executeCommand('dir');
      expect(avant).toContain('cfg-1');
      const out = await d.executeCommand('delete /force flash:cfg-1');
      expect(out).toContain('[confirm]');
      expect(await d.executeCommand('dir')).not.toContain('cfg-1');
    });

    it('`mkdir` seul est INCOMPLET', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('mkdir'))
        .toContain('Incomplete command');
    });

    it('`mkdir` puis `rmdir` font et defont un repertoire', async () => {
      const d = await privilegie(fabrique);
      expect(await d.executeCommand('mkdir flash:backups'))
        .toContain('Created dir flash:backups');
      expect(await d.executeCommand('mkdir flash:backups'))
        .toBe('%Error Creating dir flash:backups (File exists)');
      expect(await d.executeCommand('rmdir flash:backups'))
        .toContain('Removed dir flash:backups');
      expect(await d.executeCommand('rmdir flash:backups'))
        .toBe('%Error Removing dir flash:backups (No such file or directory)');
    });

    it('`rmdir` seul est INCOMPLET', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('rmdir'))
        .toContain('Incomplete command');
    });

    it('`squeeze` seul est INCOMPLET — la place est EXIGEE', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('squeeze'))
        .toContain('Incomplete command');
    });

    it('`squeeze flash:` recupere l espace', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('squeeze flash:'))
        .toContain('Squeeze of flash complete');
    });

    it('`squeeze zorglub:` nomme le peripherique absent', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('squeeze zorglub:'))
        .toBe('%Error squeezing zorglub: (No such device)');
    });

    it('les huit repondent AUSSI en EXEC utilisateur', async () => {
      const d = fabrique();
      for (const c of ['dir', 'more flash:x', 'verify flash:x', 'delete flash:x',
        'mkdir flash:x', 'rmdir flash:x', 'squeeze flash:', 'pwd']) {
        expect(await d.executeCommand(c), c).not.toContain('Invalid input');
      }
    });
  });

  describe(`${nom} — ce que \`?\` annonce`, () => {
    it('`dir ?` annonce une cible FACULTATIVE', async () => {
      const aide = (await privilegie(fabrique)).cliHelp('dir ');
      expect(motsAides(aide)).toContain('WORD');
      expect(motsAides(aide)).toContain('<cr>');
    });

    it('`more ?` annonce un fichier EXIGE', async () => {
      const aide = (await privilegie(fabrique)).cliHelp('more ');
      expect(motsAides(aide)).toContain('WORD');
      expect(motsAides(aide)).not.toContain('<cr>');
    });

    it('`mkdir ?` et `rmdir ?` annoncent un repertoire', async () => {
      const d = await privilegie(fabrique);
      for (const c of ['mkdir', 'rmdir']) {
        expect(motsAides(d.cliHelp(`${c} `)), c).toContain('WORD');
      }
    });

    it('`pwd ?` ne prend rien', async () => {
      expect(motsAides((await privilegie(fabrique)).cliHelp('pwd ')))
        .toEqual(['<cr>']);
    });

    it('`di?` decrit la commande', async () => {
      expect((await privilegie(fabrique)).cliHelp('di'))
        .toContain('dir');
    });
  });
}
