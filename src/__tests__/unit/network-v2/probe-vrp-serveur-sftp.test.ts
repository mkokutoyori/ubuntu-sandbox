/*
 * Un equipement Huawei affichait « SFTP server : Disable » et servait SFTP quand meme.
 *
 * Mesure de depart, routeur et commutateur VRP avec un compte `ssh user netadmin service-type stelnet` :
 *  - `display ssh server status` rendait la ligne `SFTP server : Disable` EN DUR ;
 *  - `sftp server enable` etait refusee (« Unrecognized command ») ;
 *  - `sftp netadmin@routeur` ouvrait pourtant une session SFTP (« Connected to ... »).
 * Un auditeur lisait « SFTP desactive » sur l'equipement qui le servait : une vue qui ment sur la machine.
 *
 * Corrige : `sftp server enable` / `undo sftp server enable` pilotent l'etat, `display ssh server status`
 * le lit, et le serveur SSH refuse le sous-systeme `sftp` tant que le service est eteint OU que le
 * compte n'a pas le type de service `sftp` ou `all` (`ssh user X service-type`).
 *
 * Discrimine contre l'etat d'avant (`git stash push -- src/network`) : 8 des 14 cas tombent (4 par
 * plateforme). Les 6 qui passent dans les deux etats sont nommes : « par defaut, le service est eteint »
 * et `undo sftp server enable` passent parce que la ligne etait EN DUR a `Disable` (ils ne prouvent
 * rien seuls, ils encadrent le cas qui allume), et « le service allume et le compte autorise, la
 * session s'ouvre » est la NON-REGRESSION du chemin heureux, que l'ancien code ouvrait toujours.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildMatrixLab, ADMIN, SECRET, type Kind } from './_helpers/sshMatrixLab';

interface Cli { executeCommand(command: string, input?: unknown): Promise<string> }

for (const kind of ['router-huawei', 'switch-huawei'] as Kind[]) {
  describe(kind, () => {
    let pc: Cli;
    let device: Cli;
    let address: string;

    beforeEach(async () => {
      const lab = await buildMatrixLab(['linux-pc', kind]);
      pc = lab.nodes[0].device as unknown as Cli;
      device = lab.nodes[1].device as unknown as Cli;
      address = lab.nodes[1].ip;
    });

    const configure = async (...lines: string[]) => {
      for (const line of ['system-view', ...lines, 'return']) await device.executeCommand(line);
    };
    const sftp = () => pc.executeCommand(`sshpass -p ${SECRET} sftp -o StrictHostKeyChecking=no ${ADMIN}@${address}`);
    const status = () => device.executeCommand('display ssh server status');

    it('par defaut, le service est eteint et l\'affichage le dit', async () => {
      expect(await status()).toContain('SFTP server                     : Disable');
    });

    it('`sftp server enable` allume le service et l\'affichage suit', async () => {
      await configure('sftp server enable');
      expect(await status()).toContain('SFTP server                     : Enable');
    });

    it('`undo sftp server enable` l\'eteint de nouveau', async () => {
      await configure('sftp server enable', 'undo sftp server enable');
      expect(await status()).toContain('SFTP server                     : Disable');
    });

    it('le service eteint, le serveur refuse le sous-systeme', async () => {
      await configure(`ssh user ${ADMIN} service-type all`);
      expect(await sftp()).not.toContain('Connected to');
    });

    it('le service allume et le compte autorise, la session SFTP s\'ouvre', async () => {
      await configure('sftp server enable', `ssh user ${ADMIN} service-type all`);
      expect(await sftp()).toContain('Connected to');
    });

    it('le service allume mais le compte reste en stelnet seul : refus', async () => {
      await configure('sftp server enable');
      expect(await sftp()).not.toContain('Connected to');
    });

    it('une valeur inconnue est refusee comme toute commande VRP', async () => {
      await device.executeCommand('system-view');
      expect(await device.executeCommand('sftp server zorglub')).toContain('Error: Wrong parameter found');
    });
  });
}
