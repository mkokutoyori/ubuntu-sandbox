/*
 * Mesure de depart : `ip scp server enable` exposait seulement running-config et startup-config, en
 * lecture. `scp fichier user@routeur:flash:fichier` echouait et `scp user@routeur:flash:fichier .`
 * ne trouvait rien alors que `dir flash:` listait des fichiers : deux magasins pour un seul flash.
 * Source : la fiche Cisco « Copy Files Securely from Cisco Routers and Switches » n'est pas joignable
 * d'ici (le mandataire refuse cisco.com) ; les transcriptions retrouvees par recherche decrivent
 * `scp -O user@ip:flash:/fichier` pour tirer et `ip scp server enable` comme seul prerequis cote
 * serveur. Ce sondage s'en tient a cela et n'epingle ni les invites de `copy scp:` ni
 * l'autorisation AAA, non attestees.
 * Seconde mesure, trouvee en route : chaque `scp` laissait sa session SSH ouverte (le client ne
 * fermait jamais la connexion apres le transfert), si bien que la sixieme copie vers un IOS repondait
 * `Connection refused` — les cinq lignes vty etaient occupees. Le dernier cas enchaine assez de copies
 * pour le provoquer des qu'on corrige le reste.
 * Sans correctif : 8 cas sur 14 tombent (4 par plateforme) (envoi, `dir flash:`/`more flash:`, relecture, fichier copie
 * depuis la console) ; les 6 temoins qui passent dans les deux etats : le serveur SCP eteint refuse,
 * running-config se tire une fois le serveur allume, un fichier absent est refuse.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { buildMatrixLab, ADMIN, SECRET, type MatrixLab, type Node } from './_helpers/sshMatrixLab';

interface Cli { executeCommand(command: string): Promise<string> }

let lab: MatrixLab;
const node = (kind: string): Node => lab.nodes.find((n) => n.kind === kind)!;
const cli = (kind: string): Cli => node(kind).device as unknown as Cli;
const scp = (args: string) => cli('linux-pc').executeCommand(
  `sshpass -p ${SECRET} scp -O -o StrictHostKeyChecking=no -o ConnectTimeout=3 ${args}`);
const target = () => `${ADMIN}@${node(kindUnderTest).ip}`;
let kindUnderTest = 'router-cisco';

beforeAll(async () => {
  lab = await buildMatrixLab(['linux-pc', 'router-cisco', 'switch-cisco']);
  await cli('linux-pc').executeCommand('echo "contenu-flash" > /tmp/Lab.txt');
}, 120000);

describe.each(['router-cisco', 'switch-cisco'])('scp vers et depuis flash: sur %s', (kind) => {
  beforeAll(() => { kindUnderTest = kind; });

  it('temoin : serveur SCP eteint, le transfert est refuse', async () => {
    const out = await scp(`/tmp/Lab.txt ${target()}:flash:Lab.txt`);
    expect(out).not.toContain('100%');
  });

  it('temoin : running-config se tire une fois le serveur SCP allume', async () => {
    for (const line of ['enable', 'configure terminal', 'ip scp server enable', 'end']) await cli(kindUnderTest).executeCommand(line);
    await scp(`${target()}:running-config /tmp/rc.txt`);
    expect(await cli('linux-pc').executeCommand('cat /tmp/rc.txt')).toContain('hostname');
  });

  it('l\'envoi vers flash: reussit', async () => {
    expect(await scp(`/tmp/Lab.txt ${target()}:flash:Lab.txt`)).toContain('100%');
  });

  it('dir flash: et more flash: voient le fichier envoye', async () => {
    expect(await cli(kindUnderTest).executeCommand('dir flash:')).toContain('Lab.txt');
    expect(await cli(kindUnderTest).executeCommand('more flash:Lab.txt')).toContain('contenu-flash');
  });

  it('la relecture depuis flash: rend le meme contenu, casse comprise', async () => {
    await scp(`${target()}:flash:Lab.txt /tmp/retour.txt`);
    expect(await cli('linux-pc').executeCommand('cat /tmp/retour.txt')).toContain('contenu-flash');
  });

  it('temoin : un fichier absent est refuse', async () => {
    const out = await scp(`${target()}:flash:absent.txt /tmp/absent.txt`);
    expect(out).not.toContain('100%');
  });

  it('un fichier copie depuis la console est lisible par scp', async () => {
    await cli(kindUnderTest).executeCommand('copy running-config flash:backup.cfg');
    await scp(`${target()}:flash:backup.cfg /tmp/backup.cfg`);
    expect(await cli('linux-pc').executeCommand('cat /tmp/backup.cfg')).toContain('hostname');
  });
});
