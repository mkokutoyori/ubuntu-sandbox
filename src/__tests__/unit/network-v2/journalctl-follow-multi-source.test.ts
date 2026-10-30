/**
 * `journalctl -f` pendant que plusieurs choses arrivent au serveur : chaque
 * ligne UNE fois, et exactement celles que `journalctl` montre ensuite.
 *
 * Mesuré avant le correctif, sur deux machines reliées (un redémarrage de ssh
 * puis un ping, un nmap, un ssh refusé, un sudo, nginx, un curl) : le suivi
 * affichait CHAQUE ligne deux fois (18 lignes pour 9 enregistrements), alors
 * que `journalctl` n'en contenait que 9 et que le rappel d'abonnement était
 * appelé une seule fois par enregistrement. La différence venait du curseur :
 * `-f` relance `journalctl --after-cursor=<curseur du dernier enregistrement>`,
 * et ce curseur était `…;m=1d4cbe8.4;t=65f0f90d97748.4;…`. Les horodatages en
 * microsecondes du journal étaient FRACTIONNAIRES (l'horloge propre à chaque
 * machine, `clockPort.wall()`, rend des millisecondes non entières), donc leur
 * écriture hexadécimale portait un « .4 » qu'aucun vrai curseur n'a ; la
 * recherche de ce curseur ne retombait sur aucune entrée exacte, se posait
 * AVANT, et réémettait l'enregistrement précédent à chaque rappel.
 *
 * Un journald réel date en microsecondes ENTIÈRES (`sd_id128`/`dual_timestamp`
 * sont des `uint64_t`) ; le curseur n'en contient que des chiffres
 * hexadécimaux.
 *
 * Discrimination par `git stash` de src/network : voir le commit.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { labo, type Labo } from './_nginxProxyLab';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const CURSOR = /^s=[0-9a-f]{32};i=[0-9a-f]+;b=[0-9a-f]{32};m=[0-9a-f]+;t=[0-9a-f]+;x=[0-9a-f]+$/;

async function journal(lab: Labo): Promise<string[]> {
  return (await lab.front.executeCommand('journalctl --no-pager -q')).split('\n').filter(Boolean);
}

async function actions(lab: Labo): Promise<void> {
  await lab.front.executeCommand('systemctl restart ssh');
  await lab.back.executeCommand('ping -c 2 10.0.0.1');
  await lab.back.executeCommand('nmap -p 22,80 10.0.0.1');
  await lab.back.executeCommand('ssh -o StrictHostKeyChecking=no nobody@10.0.0.1 true');
  await lab.front.executeCommand('sudo -n true');
  await lab.front.executeCommand('systemctl start nginx');
  await lab.back.executeCommand('curl -s http://10.0.0.1/');
  await lab.front.executeCommand('logger -t probe fin');
}

describe('les curseurs du journal', () => {
  it('ne contiennent que des chiffres hexadécimaux entiers', async () => {
    const lab = labo();
    await actions(lab);
    const out = await lab.front.executeCommand('journalctl --no-pager -q -o export');
    const cursors = out.split('\n').filter((l) => l.startsWith('__CURSOR=')).map((l) => l.slice('__CURSOR='.length));
    expect(cursors.length).toBeGreaterThan(10);
    for (const cursor of cursors) expect(cursor, cursor).toMatch(CURSOR);
  });

  it('--after-cursor d\'un enregistrement ne le contient plus', async () => {
    const lab = labo();
    await actions(lab);
    const out = await lab.front.executeCommand('journalctl --no-pager -q -o export');
    const cursors = out.split('\n').filter((l) => l.startsWith('__CURSOR=')).map((l) => l.slice('__CURSOR='.length));
    const all = (await journal(lab));
    const middle = Math.floor(cursors.length / 2);
    const after = (await lab.front.executeCommand(`journalctl --no-pager -q --after-cursor='${cursors[middle]}'`)).split('\n').filter(Boolean);
    expect(after).toEqual(all.slice(middle + 1));
  });
});

describe('journalctl -f avec plusieurs sources', () => {
  it('ce que -f affiche est exactement ce qui s\'est ajouté au journal, dans l\'ordre', async () => {
    const lab = labo();
    const before = (await journal(lab)).length;
    const lines: string[] = [];
    const stop = lab.front.followJournal([], (line) => lines.push(line));
    await actions(lab);
    stop();
    expect(lines).toEqual((await journal(lab)).slice(before));
  });

  it('WITNESS : sur une seule machine à horloge entière, le suivi était déjà exact', async () => {
    const lab = labo();
    const lines: string[] = [];
    const stop = lab.front.followJournal([], (line) => lines.push(line));
    await lab.front.executeCommand('logger -t probe seul');
    stop();
    expect(lines.filter((l) => l.includes('seul'))).toHaveLength(1);
  });
});
