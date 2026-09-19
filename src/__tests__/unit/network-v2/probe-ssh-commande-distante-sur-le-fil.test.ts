/**
 * `ssh user@host commande` : la commande distante COUTE ses propres trames.
 *
 * Ce qui a ete mesure. `runSshClient` retrouvait le peripherique pair et
 * appelait `machine.executor.execute(effectiveCmd)` en memoire. La
 * reponse etait plausible et l'echange n'existait pas : entre deux
 * hotes cables, le compteur du cable ne bougeait pas d'une trame entre
 * un `ssh` qui se connecte seulement et le meme `ssh` portant une
 * commande. Le `case 'ssh':` de `LinuxCommandExecutor` FABRIQUAIT
 * ensuite une entree de table de sockets, une capture `tcpdump` et un
 * evenement fil pour que les vues aient l'air d'accord.
 *
 * Ce que compte la sonde. Le total ne prouve rien : la connexion, elle,
 * traversait deja le cable, donc un total non nul etait vrai AVANT
 * aussi. Ce qui discrimine est la DIFFERENCE entre le meme `ssh` avec
 * et sans commande — cette difference est le trafic propre de la
 * commande, et elle valait exactement zero.
 *
 * Sources. Le comportement attendu est celui d'OpenSSH : en mode exec,
 * la commande s'execute sur la machine DISTANTE, sous l'identite
 * authentifiee — `whoami` rend l'utilisateur SSH et non le compte par
 * defaut du peripherique, et `pwd` rend le foyer de cet utilisateur.
 *
 * `sshpass -p … ssh …` compte aussi, et pour une raison mesuree : il gardait
 * son propre `case` dans le dispatch SYNCHRONE, donc 3 trames la ou `ssh`
 * nu en coutait 28. Les deux verbes passent desormais par la meme porte.
 *
 * Discrimine contre le commit precedent : 1 des 6 cas tombe, et c'est
 * exactement celui qui COMPTE LES TRAMES. Les cinq autres passent des deux
 * cotes et sont nommes ici plutot que laisses a decouvrir : le TEMOIN (un
 * ping coute des trames), qui prouve que le laboratoire est cable ; et les
 * quatre cas de contenu — `whoami` rend `alice`, `pwd` rend `/home/alice`,
 * un second compte repond pour lui, le code de retour remonte — qui
 * passaient DEJA, parce que l'execution en memoire lisait le bon systeme de
 * fichiers sous la bonne identite. Ce n'etait pas la justesse qui manquait,
 * c'est que rien ne traversait. Mesure : 28 trames avec la commande, 3 sans.
 *
 * LE TEMOIN DE COMPARAISON A CHANGE, et la raison est un progres. Le cas
 * « sans commande » ne coute plus 3 trames mais 31 : depuis que le client
 * Linux ouvre une vraie session interactive, un `ssh <hote>' nu ouvre un
 * canal shell et le pilote. Il n'est donc plus le plancher « connexion
 * seule » que cette mesure prenait pour reference. Ce qui isole encore le
 * trafic PROPRE de la commande est la meme ligne dont l'authentification
 * ECHOUE : elle traverse le cable, elle est refusee, et elle ne peut par
 * construction avoir execute quoi que ce soit. Mesure du jour : 22 trames
 * pour la commande, 20 pour le refus — les DEUX trames d'ecart sont la
 * requete du canal exec et sa reponse, et aucun raccourci en memoire ne
 * peut les produire. Le cas `sshpass', lui, compare desormais les deux
 * VERBES entre eux : meme ligne, meme cout, donc la meme porte.
 *
 * (Ces totaux ont baisse de TROIS depuis que `runSshClient' ne re-sonde
 * plus la joignabilite que l'appelant a deja mesuree — 25/23/31 sont
 * devenus 22/20/28. L'ECART, lui, n'a pas bouge : c'est lui que la
 * sonde defend, pas le total.)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const CLIENT_IP = '10.0.0.1';
const SERVER_IP = '10.0.0.2';

async function labo() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'SRV1');
  const cable = new Cable('c1');
  cable.connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  const masque = new SubnetMask('255.255.255.0');
  pc.getPort('eth0')!.configureIP(new IPAddress(CLIENT_IP), masque);
  srv.getPort('eth0')!.configureIP(new IPAddress(SERVER_IP), masque);
  await srv.executeCommand('sudo systemctl start ssh');
  await srv.executeCommand('sudo useradd -m alice');
  await srv.executeCommand('echo "alice:secret123" | sudo chpasswd');
  await pc.executeCommand(`ping -c 1 ${SERVER_IP}`);
  return { pc, srv, cable };
}

const ssh = (suffixe: string) =>
  `ssh -o StrictHostKeyChecking=no alice@${SERVER_IP}${suffixe}`;

describe('La commande distante traverse le cable', () => {
  it('TEMOIN : le laboratoire est sain, un ping coute des trames', async () => {
    const { pc, cable } = await labo();
    const avant = cable.getStats().framesTransmitted;
    await pc.executeCommand(`ping -c 1 ${SERVER_IP}`);
    expect(cable.getStats().framesTransmitted).toBeGreaterThan(avant);
  });

  it('la commande coute des trames de plus qu une session refusee', async () => {
    const trames = async (ligne: string): Promise<number> => {
      const { pc, cable } = await labo();
      const avant = cable.getStats().framesTransmitted;
      await pc.executeCommand(ligne);
      return cable.getStats().framesTransmitted - avant;
    };
    const avecCommande = await trames(
      `sshpass -p secret123 ssh -o StrictHostKeyChecking=no alice@${SERVER_IP} whoami`);
    const authRefusee = await trames(
      `sshpass -p FAUX ssh -o StrictHostKeyChecking=no alice@${SERVER_IP} whoami`);
    expect(avecCommande).toBeGreaterThan(authRefusee);
  });

  it('`whoami` rend l utilisateur SSH', async () => {
    const { pc } = await labo();
    expect((await pc.executeCommand(ssh(' whoami'))).trim()).toBe('alice');
  });

  it('`pwd` rend le foyer de cet utilisateur', async () => {
    const { pc } = await labo();
    expect((await pc.executeCommand(ssh(' pwd'))).trim()).toBe('/home/alice');
  });

  it('un second compte repond POUR LUI, et non une constante', async () => {
    const { pc, srv } = await labo();
    await srv.executeCommand('sudo useradd -m bob');
    await srv.executeCommand('echo "bob:motdepasse" | sudo chpasswd');
    const sortie = await pc.executeCommand(
      `ssh -o StrictHostKeyChecking=no bob@${SERVER_IP} whoami`);
    expect(sortie.trim()).toBe('bob');
  });

  it('`sshpass` emprunte le MEME chemin, et non un raccourci', async () => {
    const trames = async (ligne: string): Promise<number> => {
      const { pc, cable } = await labo();
      const avant = cable.getStats().framesTransmitted;
      await pc.executeCommand(ligne);
      return cable.getStats().framesTransmitted - avant;
    };
    const parSshpass = await trames(
      `sshpass -p secret123 ssh -o StrictHostKeyChecking=no alice@${SERVER_IP} whoami`);
    const parSshNu = await trames(ssh(' whoami'));
    expect(parSshpass).toBe(parSshNu);
  });

  it('`sshpass` rend la meme reponse que `ssh` nu', async () => {
    const { pc } = await labo();
    const sortie = await pc.executeCommand(
      `sshpass -p secret123 ssh -o StrictHostKeyChecking=no alice@${SERVER_IP} whoami`);
    expect(sortie.trim()).toBe('alice');
  });

  it('le code de retour de la commande distante remonte', async () => {
    const { pc } = await labo();
    expect((await pc.executeCommand(`${ssh(' false')}; echo rc=$?`)).trim()).toContain('rc=1');
  });
});
