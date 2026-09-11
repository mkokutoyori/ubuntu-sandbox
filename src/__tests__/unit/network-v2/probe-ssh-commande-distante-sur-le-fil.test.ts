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
 * Ce que la sonde ne couvre PAS, et il faut le dire : `sshpass -p … ssh …`
 * garde son propre `case` dans le dispatch SYNCHRONE et ne passe donc pas
 * par la porte asynchrone. Mesure : 28 trames pour `ssh … whoami`, 3 pour
 * la meme invocation sous `sshpass`. La famille `sshpass` reste a migrer.
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

  it('la commande coute des trames de plus que la seule connexion', async () => {
    const trames = async (suffixe: string): Promise<number> => {
      const { pc, cable } = await labo();
      const avant = cable.getStats().framesTransmitted;
      await pc.executeCommand(ssh(suffixe));
      return cable.getStats().framesTransmitted - avant;
    };
    const avecCommande = await trames(' whoami');
    const connexionSeule = await trames('');
    expect(avecCommande).toBeGreaterThan(connexionSeule);
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

  it('le code de retour de la commande distante remonte', async () => {
    const { pc } = await labo();
    expect((await pc.executeCommand(`${ssh(' false')}; echo rc=$?`)).trim()).toContain('rc=1');
  });
});
