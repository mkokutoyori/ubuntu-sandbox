/*
 * `header login` et `header shell` d'un equipement Huawei ne faisaient pas ce que dit le manuel.
 *
 * Mesure de depart, sur un routeur et un commutateur VRP, apres
 *   header login information "Acces reserve"
 *   header shell information "Bienvenue"
 * - la commande etait declaree TROIS fois (deux fois dans le shell du routeur, une troisieme dans la
 *   partie commune), et celle du commutateur etait un « no-op reconnu » : le texte n'etait stocke nulle
 *   part ;
 * - sur le routeur, les deux commandes ecrasaient la MEME banniere SSH et gardaient les guillemets
 *   (`information "Bienvenue` s'affichait avant l'invite de mot de passe) ;
 * - `display current-configuration` ne rendait aucune ligne `header` ;
 * - `undo header login` effacait la banniere sans regarder ce qu'on lui demandait de retirer ;
 * - apres l'authentification, le routeur rendait une banniere inventee (« Huawei Versatile Routing
 *   Platform Software ») au lieu du texte `header shell`.
 *
 * Corrige : une seule definition (`HuaweiHeaders`) ; `header login` est la banniere AVANT
 * authentification (celle de `login`, aussi servie par SSH et telnet), `header shell` celle d'APRES ;
 * les deux sont rendues par `display current-configuration` et `undo header login|shell` retire
 * celle qu'on nomme. La commande `file` n'est pas modelisable (aucun systeme de fichiers flash) et
 * repond « The file does not exist. ».
 *
 * Linux affichait en outre la banniere `issue.net` DEUX fois par une session interactive : le client
 * l'affiche avant le mot de passe puis la recompose apres l'authentification.
 *
 * Discrimine contre l'etat d'avant (`git stash push -- src/network src/terminal src/shell`) : 10 des 11 cas
 * tombent. Le onzieme passe dans les deux etats et est nomme : « le texte `shell` suit l'authentification »
 * sur le ROUTEUR, parce que l'ancien code y affichait deja le texte `header shell`, entre guillemets
 * tronques, apres le mot de passe ; il ne prouve que la presence du mot, pas la correction du rendu, que
 * les autres cas pincent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildMatrixLab, ADMIN, SECRET, Console, type Kind } from './_helpers/sshMatrixLab';

interface Cli { executeCommand(command: string, input?: unknown): Promise<string> }

const CLASSES: readonly Kind[] = ['router-huawei', 'switch-huawei'];

for (const kind of CLASSES) {
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

    const connect = async (): Promise<Console> => {
      const session = await Console.open(pc as never);
      await session.login(`ssh ${ADMIN}@${address}`, SECRET, ADMIN);
      return session;
    };

    it('`display current-configuration` rend les deux textes', async () => {
      await configure('header login information "Acces reserve"', 'header shell information "Bienvenue"');
      const out = await device.executeCommand('display current-configuration | include header');
      expect(out).toContain('header login information "Acces reserve"');
      expect(out).toContain('header shell information "Bienvenue"');
    });

    it('la banniere de login precede le mot de passe, sans guillemets, une seule fois', async () => {
      await configure('header login information "Acces reserve"', 'header shell information "Bienvenue"');
      const text = (await connect()).transcript;
      const beforePassword = text.slice(0, text.indexOf("'s password"));
      expect(beforePassword).toContain('Acces reserve');
      expect(text).not.toContain('"');
      expect(text.match(/Acces reserve/g)?.length).toBe(1);
    });

    it('le texte `shell` suit l\'authentification', async () => {
      await configure('header login information "Acces reserve"', 'header shell information "Bienvenue"');
      const text = (await connect()).transcript;
      expect(text.slice(text.indexOf("'s password"))).toContain('Bienvenue');
    });

    it('`undo header login` retire le texte de login et garde celui du shell', async () => {
      await configure('header login information "Acces reserve"', 'header shell information "Bienvenue"', 'undo header login');
      const out = await device.executeCommand('display current-configuration | include header');
      expect(out).not.toContain('header login');
      expect(out).toContain('header shell information "Bienvenue"');
    });

    it('`header login file` repond que le fichier n\'existe pas', async () => {
      await device.executeCommand('system-view');
      expect(await device.executeCommand('header login file banner.txt')).toBe('Error: The file does not exist.');
    });
  });
}

describe('linux', () => {
  it('la banniere issue.net est affichee une seule fois par une session interactive', async () => {
    const lab = await buildMatrixLab(['linux-pc', 'linux-server']);
    const [pc, server] = lab.nodes.map((n) => n.device as unknown as Cli);
    await server.executeCommand('echo "Acces reserve" | sudo tee /etc/issue.net');
    await server.executeCommand('echo "Banner /etc/issue.net" | sudo tee -a /etc/ssh/sshd_config');
    await server.executeCommand('sudo systemctl restart ssh');
    const session = await Console.open(pc as never);
    await session.login(`ssh ${ADMIN}@10.0.0.12`, SECRET, ADMIN);
    expect(session.transcript.match(/Acces reserve/g)?.length).toBe(1);
  });
});
