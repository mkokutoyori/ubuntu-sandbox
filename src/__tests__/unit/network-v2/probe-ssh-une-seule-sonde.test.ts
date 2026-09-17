/**
 * Sonde — un seul `ssh` faisait sonder le serveur TROIS fois.
 *
 * Mesure AVANT (sur `8b390498'), pour un unique `ssh alice@10.0.0.2' :
 *
 *   Connection from 10.0.0.1 port 22 on linux-server port 22
 *   Connection closed by 10.0.0.1 port 32768 [preauth]
 *   Connection from 10.0.0.1 port 22 on linux-server port 22
 *   Accepted password for alice from 10.0.0.1 port 32768 ssh2
 *   Connection from 10.0.0.1 port 22 on linux-server port 22
 *   Connection closed by 10.0.0.1 port 32768 [preauth]
 *
 * Trois connexions et deux fermetures avant authentification, la ou un
 * vrai `ssh' se connecte UNE fois. Le journal de l'administrateur etait
 * donc faux de deux lignes sur trois, et `fail2ban' ou n'importe quelle
 * lecture de `[preauth]' comptait deux tentatives fantomes par session
 * reussie.
 *
 * La cause est une question posee DEUX fois. `wireReachOutcome' repond
 * « ce port est-il ouvert, ferme, filtre ou injoignable ? » par une
 * sonde SYN sans connexion -- et elle etait appelee une fois par
 * `runSshExecAsync', avant d'ouvrir la session, puis une SECONDE fois
 * par `runSshClient', qui la reposait telle quelle. La reponse est
 * desormais calculee une fois et transmise (`SshClientOpts.wireOutcome') ;
 * `runSshClient' ne sonde plus que lorsque personne ne l'a fait pour lui,
 * ce qui reste le cas du chemin synchrone.
 *
 * TROIS cas sur huit tombent avant la correction (discrimines sur
 * `8b390498'). Les CINQ autres sont NOMMES :
 *
 *   - la session reelle est bien inscrite : TEMOIN. Un `Accepted
 *     password' et un seul -- il prouve que la sonde compte le bruit et
 *     non la session, et que supprimer le bruit n'a pas supprime la
 *     session avec.
 *   - un port ferme repond `Connection refused', une adresse que
 *     personne ne porte `No route to host', un port SILENCIEUSEMENT jete
 *     rend la main : NON-REGRESSIONS, et ce sont elles qui expliquent
 *     pourquoi il reste UNE sonde. Elles ont mesure ce que coute sa
 *     suppression complete : le nom ne se resout plus, et surtout un
 *     `iptables -j DROP' ne rend JAMAIS la main, faute de delai sur
 *     l'appel de connexion. La sonde n'est donc pas du bruit gratuit --
 *     elle est le seul chemin qui distingue « ferme » de « filtre » et
 *     le seul qui borne une connexion qui n'aboutira pas.
 *   - un NOM se resout toujours : NON-REGRESSION du meme groupe.
 *
 * LIMITE MESUREE ET NON FERMEE : il reste DEUX connexions la ou un vrai
 * client n'en ouvre qu'une, et la seconde est la sonde elle-meme. Sur
 * une vraie machine un demi-balayage SYN est repondu par le NOYAU seul ;
 * l'application n'apprend la connexion qu'une fois la poignee de main
 * terminee par l'ACK du client -- c'est precisement ce qui rend ce
 * balayage « furtif ». Ici la sonde traverse jusqu'a l'application, qui
 * l'inscrit puis la voit se fermer.
 *
 * LA CORRECTION A ETE ECRITE, MESUREE, ET REPOSEE -- et ce qui l'a
 * arretee merite d'etre ecrit ici plutot que redecouvert. Ne remettre la
 * socket a l'ecouteur qu'a l'ACK tient en quatre lignes de `TcpStack' et
 * donne exactement ce qu'on attend : `nmap -sS' voit toujours le port
 * ouvert, le journal du serveur ne voit plus le balayage (1 connexion ->
 * 0), et un `ssh' retombe a UNE connexion sans fermeture fantome. Le
 * rayon d'action complet -- 632 fichiers, puis les 156 autres qui
 * touchent la pile TCP -- a rendu son verdict : six cas tombent, et
 * DEUX familles expliquent pourquoi.
 *
 * La premiere est cosmetique : `tcp-flow-control' et `tcp-options'
 * posent `s.windowSize` DANS `onAccept', en comptant sur le fait que le
 * SYN/ACK n'est pas encore parti. C'est reparable -- une vraie pile lit
 * la taille du tampon sur la socket d'ECOUTE, pas dans le rappel
 * d'acceptation, donc l'option appartient a `listen()'.
 *
 * La seconde est structurelle et bloque. `linux-dnat-port-forward' et
 * `linux-nat-redirect-output' observent la socket AU MOMENT DE
 * L'ACCEPTATION, a l'etat `syn-received', et leur propre commentaire dit
 * pourquoi : le SYN/ACK du serveur repart avec sa VRAIE adresse et non
 * l'adresse publique composee, donc le client le refuse par RST et la
 * poignee de main d'une connexion DNAT ne se termine JAMAIS. C'est la
 * limite que `CLAUDE.md' nomme -- « The iptables NAT engine has no
 * reply-leg conntrack ». Tant qu'elle tient, deplacer l'acceptation a
 * l'ACK ne rend pas le balayage furtif : il rend la redirection de port
 * INVISIBLE, l'ecouteur ne recevant plus jamais la connexion. Le lot du
 * demi-balayage attend donc le conntrack de retour, et pas l'inverse.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const SERVER_IP = '10.0.0.2';
const CLIENT_IP = '10.0.0.1';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function lab(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'SRV1');
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  const mask = new SubnetMask('255.255.255.0');
  pc.getPort('eth0')!.configureIP(new IPAddress(CLIENT_IP), mask);
  srv.getPort('eth0')!.configureIP(new IPAddress(SERVER_IP), mask);
  await srv.executeCommand('sudo systemctl start ssh');
  await srv.executeCommand('sudo useradd -m alice');
  await srv.executeCommand('echo "alice:secret123" | sudo chpasswd');
  return { pc, srv };
}

async function journal(srv: LinuxServer): Promise<string> {
  return String(await srv.executeCommand('sudo journalctl -u ssh --no-pager'));
}

const lignes = (texte: string, mot: string): number =>
  texte.split('\n').filter((l) => l.includes(mot)).length;

describe('un `ssh` ne fait plus sonder le serveur deux fois', () => {
  it('temoin : la session reelle est bien inscrite', async () => {
    const { pc, srv } = await lab();
    await pc.executeCommand(
      `sshpass -p secret123 ssh -o StrictHostKeyChecking=no alice@${SERVER_IP} whoami`);
    expect(lignes(await journal(srv), 'Accepted password')).toBe(1);
  }, 30000);

  it('une commande distante ne laisse qu UNE fermeture avant authentification', async () => {
    const { pc, srv } = await lab();
    await pc.executeCommand(
      `sshpass -p secret123 ssh -o StrictHostKeyChecking=no alice@${SERVER_IP} whoami`);
    expect(lignes(await journal(srv), '[preauth]')).toBe(1);
  }, 30000);

  it('une session interactive ne laisse qu UNE fermeture avant authentification', async () => {
    const { pc, srv } = await lab();
    await pc.executeCommand(
      `ssh -o StrictHostKeyChecking=no alice@${SERVER_IP}`, 'secret123\nwhoami\nexit\n');
    expect(lignes(await journal(srv), '[preauth]')).toBe(1);
  }, 30000);

  it('le serveur ne voit pas plus de DEUX connexions pour un seul `ssh`', async () => {
    const { pc, srv } = await lab();
    await pc.executeCommand(
      `sshpass -p secret123 ssh -o StrictHostKeyChecking=no alice@${SERVER_IP} whoami`);
    expect(lignes(await journal(srv), 'Connection from')).toBe(2);
  }, 30000);

  it('non-regression : un port ferme repond `Connection refused`', async () => {
    const { pc, srv } = await lab();
    await srv.executeCommand('sudo systemctl stop ssh');
    expect(await pc.executeCommand(`ssh -o StrictHostKeyChecking=no alice@${SERVER_IP} whoami`))
      .toContain('Connection refused');
  }, 30000);

  it('non-regression : une adresse que personne ne porte repond `No route to host`', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('ssh -o StrictHostKeyChecking=no alice@10.0.0.77 whoami'))
      .toContain('No route to host');
  }, 30000);

  it('non-regression : un port SILENCIEUSEMENT jete rend la main', async () => {
    const { pc, srv } = await lab();
    await srv.executeCommand('sudo iptables -A INPUT -p tcp --dport 22 -j DROP');
    expect(await pc.executeCommand(`ssh -o StrictHostKeyChecking=no alice@${SERVER_IP} whoami`))
      .toMatch(/No route to host|Connection timed out|refused/);
  }, 30000);

  it('non-regression : un NOM, et non une adresse, se resout toujours', async () => {
    const { pc } = await lab();
    await pc.executeCommand(
      `echo "${SERVER_IP} srv1" | sudo tee -a /etc/hosts > /dev/null`);
    expect(await pc.executeCommand(
      'sshpass -p secret123 ssh -o StrictHostKeyChecking=no alice@srv1 whoami')).toContain('alice');
  }, 30000);
});
