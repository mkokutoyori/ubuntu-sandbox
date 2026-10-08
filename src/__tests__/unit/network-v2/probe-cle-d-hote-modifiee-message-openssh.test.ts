/*
 * « WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! » : le message etait ecrit QUATRE fois, et faux.
 *
 * Mesure de depart, apres que le serveur eut regenere ses cles d'hote (`ssh-keygen -A`) :
 *  - le client synchrone (`ssh`, `sshpass ssh`, `scp`) et le lanceur de la console imprimaient
 *    « Add correct host key in /root/.ssh/known_hosts » pour un utilisateur dont le fichier est
 *    /home/user/.ssh/known_hosts, et toujours « :1 » comme numero de ligne ;
 *  - ni l'un ni l'autre ne disait l'empreinte presentee, ni la commande `ssh-keygen -R`, ni la phrase
 *    qui explique le refus (« Host key for X has changed and you have requested strict checking. ») ;
 *  - le client a canal (fil reel) avait un TROISIEME texte sans chemin, et SFTP un QUATRIEME qui
 *    repetait l'entete sans le reste. Quatre ecritures d'un meme fait ont fini par diverger.
 *
 * Corrige : un seul module (`hostkey/HostKeyChangedWarning`) compose le message d'OpenSSH 8.9 a partir
 * du chemin REEL du fichier, du numero de ligne de l'entree fautive (hachee ou non), de l'empreinte
 * presentee et du type de cle, et UNE fonction compare puis enregistre la cle pour les deux clients
 * synchrones, qui avaient chacun leur copie.
 *
 * Discrimine contre l'etat d'avant (`git stash push -- src/network src/shell src/terminal`) : 6 des 7 cas
 * tombent. Le septieme est le TEMOIN : la premiere connexion enregistre la cle et reussit dans les deux
 * etats, ce qui prouve le laboratoire (cables, comptes, serveur SSH) avant tout changement de cle.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildMatrixLab, ADMIN, SECRET, Console } from './_helpers/sshMatrixLab';

interface Cli { executeCommand(command: string, input?: unknown): Promise<string> }

let pc: Cli;
let server: Cli;

const SERVER_IP = '10.0.0.12';
const connect = `sshpass -p ${SECRET} ssh -o ConnectTimeout=3 ${ADMIN}@${SERVER_IP} hostname`;
const acceptNew = `sshpass -p ${SECRET} ssh -o StrictHostKeyChecking=accept-new ${ADMIN}@${SERVER_IP} hostname`;

beforeEach(async () => {
  const lab = await buildMatrixLab(['linux-pc', 'linux-server']);
  [pc, server] = lab.nodes.map((n) => n.device as unknown as Cli);
});

const regenerateServerKeys = async () => {
  await server.executeCommand('sudo rm /etc/ssh/ssh_host_*');
  await server.executeCommand('sudo ssh-keygen -A');
  await server.executeCommand('sudo systemctl restart ssh');
};

describe('premier contact', () => {
  it('temoin : la premiere connexion enregistre la cle et reussit', async () => {
    expect(await pc.executeCommand(acceptNew)).toContain('lsrv');
    expect(await pc.executeCommand('cat ~/.ssh/known_hosts')).toContain(SERVER_IP);
  });
});

describe('apres un changement de cle du serveur, le client synchrone', () => {
  beforeEach(async () => {
    await pc.executeCommand(acceptNew);
    await regenerateServerKeys();
  });

  it('nomme le vrai fichier known_hosts de l\'utilisateur, et non /root', async () => {
    const out = await pc.executeCommand(connect);
    expect(out).toContain('Add correct host key in /home/user/.ssh/known_hosts to get rid of this message.');
    expect(out).not.toContain('/root/.ssh');
  });

  it('donne le numero de ligne de l\'entree fautive', async () => {
    await pc.executeCommand('rm ~/.ssh/known_hosts');
    await pc.executeCommand('echo "# commentaire" > ~/.ssh/known_hosts');
    await pc.executeCommand('echo "10.9.9.9 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" >> ~/.ssh/known_hosts');
    await server.executeCommand('sudo rm /etc/ssh/ssh_host_*');
    await server.executeCommand('sudo ssh-keygen -A');
    await pc.executeCommand(acceptNew);
    await regenerateServerKeys();
    expect(await pc.executeCommand(connect)).toContain('Offending ED25519 key in /home/user/.ssh/known_hosts:3');
  }, 30000);

  it('donne l\'empreinte presentee et la commande qui retire l\'entree', async () => {
    const out = await pc.executeCommand(connect);
    expect(out).toMatch(/The fingerprint for the ED25519 key sent by the remote host is\nSHA256:[A-Za-z0-9+/]{43}\./);
    expect(out).toContain(`ssh-keygen -f "/home/user/.ssh/known_hosts" -R "${SERVER_IP}"`);
  });

  it('explique le refus et conclut comme OpenSSH', async () => {
    const out = (await pc.executeCommand(connect)).trimEnd();
    expect(out).toContain(`Host key for ${SERVER_IP} has changed and you have requested strict checking.`);
    expect(out.endsWith('Host key verification failed.')).toBe(true);
  });

  it('scp, qui passe par le meme client, dit la meme chose', async () => {
    const out = await pc.executeCommand(`sshpass -p ${SECRET} scp ${ADMIN}@${SERVER_IP}:/etc/hostname /tmp/h`);
    expect(out).toContain('Offending ED25519 key in /home/user/.ssh/known_hosts:1');
  });
});

describe('la session interactive (client a canal) dit la meme chose', () => {
  it('avec le chemin, la ligne et l\'empreinte, une seule fois', async () => {
    const first = await Console.open(pc as never);
    await first.login(`ssh ${ADMIN}@${SERVER_IP}`, SECRET, ADMIN);
    await first.type('exit');
    await regenerateServerKeys();
    const second = await Console.open(pc as never);
    await second.login(`ssh ${ADMIN}@${SERVER_IP}`, SECRET, ADMIN);
    const text = second.transcript;
    expect(text).toContain('Offending ED25519 key in /home/user/.ssh/known_hosts:1');
    expect(text).toMatch(/The fingerprint for the ED25519 key sent by the remote host is\nSHA256:/);
    expect(text.match(/WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED/g)?.length).toBe(1);
    expect(text.trimEnd().endsWith('Host key verification failed.')).toBe(true);
  }, 30000);
});
