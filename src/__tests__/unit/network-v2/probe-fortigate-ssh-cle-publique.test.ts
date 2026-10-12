/*
 * FortiGate : un administrateur ne pouvait se connecter en SSH que par mot de passe.
 *
 * Mesure de depart : `config system admin / edit netadmin / set ssh-public-key1 "ssh-ed25519 AAAA..."`
 * rendait « unknown attribute », et le serveur SSH du pare-feu n'annoncait que `password` (sa
 * methode `publickey` repondait toujours faux). Un auditeur qui exige « pas de mot de passe sur les
 * acces d'administration » n'avait donc aucun moyen de configurer l'equipement conformement.
 *
 * Corrige : `ssh-public-key1` a `ssh-public-key3` sont des attributs de `system admin` (valides a la
 * saisie, rendus par `show`), et le serveur admet la cle si ELLE figure chez cet administrateur ET
 * si la source respecte ses `trusthost` ; la signature de la cle est prouvee par le transport comme
 * pour tout serveur, donc copier la cle publique ne suffit pas a se connecter.
 *
 * Discrimine contre l'etat d'avant (`git stash push -- src/network`) : 5 des 7 cas tombent. Les 2
 * autres sont nommes : le TEMOIN DU MOT DE PASSE (la connexion par mot de passe marche dans les deux
 * etats, ce qui prouve le laboratoire) et « une cle etrangere est refusee » (refusee avant parce que
 * AUCUNE cle n'etait admise : il devient discriminant avec le cas qui admet la bonne cle a cote).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildMatrixLab, ADMIN, SECRET } from './_helpers/sshMatrixLab';

interface Cli { executeCommand(command: string, input?: unknown): Promise<string> }

let pc: Cli;
let server: Cli;
let fortigate: Cli;
let pcKey: string;
let serverKey: string;

const FGT_IP = '10.0.0.13';
const byKey = (who: Cli) =>
  who.executeCommand(`ssh -o PasswordAuthentication=no -o StrictHostKeyChecking=no -o ConnectTimeout=3 ${ADMIN}@${FGT_IP} "get system status"`);

const configureAdmin = async (...lines: string[]) => {
  for (const line of ['config system admin', `edit ${ADMIN}`, ...lines, 'next', 'end']) {
    await fortigate.executeCommand(line);
  }
};

beforeEach(async () => {
  const lab = await buildMatrixLab(['linux-pc', 'linux-server', 'firewall-fortinet']);
  [pc, server, fortigate] = lab.nodes.map((n) => n.device as unknown as Cli);
  await pc.executeCommand('ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519');
  await server.executeCommand('ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519');
  pcKey = (await pc.executeCommand('cat ~/.ssh/id_ed25519.pub')).trim();
  serverKey = (await server.executeCommand('cat ~/.ssh/id_ed25519.pub')).trim();
});

describe('la cle publique d\'un administrateur ouvre une session sans mot de passe', () => {
  it('temoin : le mot de passe ouvre la session', async () => {
    const out = await pc.executeCommand(
      `sshpass -p ${SECRET} ssh -o StrictHostKeyChecking=no ${ADMIN}@${FGT_IP} "get system status"`);
    expect(out).toContain('Version: FortiGate');
  });

  it('la cle declaree est admise, mot de passe interdit cote client', async () => {
    await configureAdmin(`set ssh-public-key1 "${pcKey}"`);
    expect(await byKey(pc)).toContain('Version: FortiGate');
  });

  it('la deuxieme cle declaree est admise elle aussi', async () => {
    await configureAdmin(`set ssh-public-key1 "${pcKey}"`, `set ssh-public-key2 "${serverKey}"`);
    expect(await byKey(server)).toContain('Version: FortiGate');
  });

  it('une cle qui n\'est pas declaree est refusee', async () => {
    await configureAdmin(`set ssh-public-key1 "${pcKey}"`);
    expect(await byKey(server)).toMatch(/Permission denied/);
  });

  it('une cle declaree ne passe pas hors des trusthost de l\'administrateur', async () => {
    await configureAdmin(
      `set ssh-public-key1 "${pcKey}"`, `set ssh-public-key2 "${serverKey}"`,
      'set trusthost1 10.0.0.12 255.255.255.255');
    expect(await byKey(pc)).toMatch(/Permission denied/);
    expect(await byKey(server)).toContain('Version: FortiGate');
  });
});

describe('la cle est saisie et rendue comme un attribut de l\'administrateur', () => {
  it('une valeur qui n\'est pas une cle SSH est refusee a la saisie', async () => {
    await fortigate.executeCommand('config system admin');
    await fortigate.executeCommand(`edit ${ADMIN}`);
    expect(await fortigate.executeCommand('set ssh-public-key1 "not a key"')).toMatch(/not an SSH public key/);
  });

  it('`show system admin` rend la cle', async () => {
    await configureAdmin(`set ssh-public-key1 "${pcKey}"`);
    expect(await fortigate.executeCommand(`show system admin ${ADMIN}`)).toContain(`set ssh-public-key1 "${pcKey}"`);
  });
});
