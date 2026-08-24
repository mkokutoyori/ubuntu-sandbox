/**
 * `where`, `disconnect`, `resume`, `ssh` et `telnet` passent au socle.
 *
 * Les cinq etaient enregistrees DEUX FOIS — une par arbre d'EXEC — la ou
 * le socle les declare une seule fois avec `modes: ['user','privileged']`.
 * C'est exactement la duplication que la migration existe pour retirer :
 * deux enregistrements d'une meme commande finissent par diverger.
 *
 * Les cas d'ACCEPTATION sont verts avant comme apres. Les cas d'AIDE
 * sont ce que la migration apporte, et `disconnect all` est epingle ici
 * parce qu'il dit ce que la place ne doit PAS faire : le gestionnaire
 * decide, la place nomme les formes sans restreindre.
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

const refuse = (sortie: string): boolean =>
  /Invalid input|Incomplete command|Unrecognized|Unknown command/.test(sortie);

const motsAides = (aide: string): string[] =>
  aide.split('\n').map(l => l.trim().split(/\s{2,}/)[0])
    .filter(m => m.length > 0 && !m.startsWith('%'));

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`${nom} — les sessions sortantes repondent`, () => {
    it('`where` liste les connexions ouvertes', async () => {
      const out = await (await privilegie(fabrique)).executeCommand('where');
      expect(refuse(out)).toBe(false);
    });

    it('`where` repond aussi en EXEC utilisateur', async () => {
      expect(refuse(await fabrique().executeCommand('where'))).toBe(false);
    });

    it('`disconnect` seul, sans connexion, le dit', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('disconnect'))
        .toBe('% No connections open');
    });

    it('`disconnect 1` nomme la connexion inconnue', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('disconnect 1'))
        .toBe('% No information for this connection');
    });

    it('`disconnect all` n est pas REFUSEE — le gestionnaire tranche', async () => {
      const out = await (await privilegie(fabrique)).executeCommand('disconnect all');
      expect(refuse(out), out).toBe(false);
    });

    it('`resume` seul, sans connexion, le dit', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('resume'))
        .toBe('% No connection open');
    });

    it('`resume 1` le dit aussi', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('resume 1'))
        .toBe('% No connection open');
    });

    it('`ssh` seul est INCOMPLET, pas inconnu', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('ssh'))
        .toContain('Incomplete command');
    });

    it('`telnet` seul est INCOMPLET', async () => {
      expect(await (await privilegie(fabrique)).executeCommand('telnet'))
        .toContain('Incomplete command');
    });

    it('`ssh -l zoe <hote>` garde ses options — plusieurs mots', async () => {
      const out = await (await privilegie(fabrique)).executeCommand('ssh -l zoe 10.0.0.9');
      expect(refuse(out), out).toBe(false);
    });

    it('`telnet <hote>` sans interface le dit', async () => {
      const out = await (await privilegie(fabrique)).executeCommand('telnet 10.0.0.9');
      expect(refuse(out), out).toBe(false);
    });

    it('les cinq repondent en EXEC utilisateur comme en privilegie', async () => {
      const d = fabrique();
      for (const c of ['where', 'disconnect', 'resume', 'ssh', 'telnet']) {
        const out = await d.executeCommand(c);
        expect(/Invalid input|Unrecognized/.test(out), `${c} => ${out}`).toBe(false);
      }
    });
  });

  describe(`${nom} — ce que \`?\` annonce des sessions`, () => {
    it('`where ?` ne prend rien', async () => {
      expect(motsAides((await privilegie(fabrique)).cliHelp('where ')))
        .toEqual(['<cr>']);
    });

    it('`disconnect ?` annonce le numero et laisse la place FACULTATIVE', async () => {
      const aide = (await privilegie(fabrique)).cliHelp('disconnect ');
      expect(motsAides(aide)).toContain('<1-16>');
      expect(motsAides(aide)).toContain('<cr>');
    });

    it('`resume ?` annonce le numero', async () => {
      expect(motsAides((await privilegie(fabrique)).cliHelp('resume ')))
        .toContain('<1-16>');
    });

    it('`ssh ?` et `telnet ?` annoncent un hote EXIGE', async () => {
      const d = await privilegie(fabrique);
      for (const c of ['ssh', 'telnet']) {
        const aide = motsAides(d.cliHelp(`${c} `));
        expect(aide, c).toContain('WORD');
        expect(aide, c).not.toContain('<cr>');
      }
    });

    it('`whe?` decrit la commande', async () => {
      expect((await privilegie(fabrique)).cliHelp('whe')).toContain('where');
    });
  });
}
