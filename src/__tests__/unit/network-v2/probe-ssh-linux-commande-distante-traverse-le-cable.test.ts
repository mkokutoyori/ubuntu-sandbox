/**
 * Mesure de depart (etape 4 de « supprimer le chemin memoire ») : `ssh alice@hote cmd` lance
 * depuis un poste Linux authentifiait sur le fil, puis EXECUTAIT la commande dans l'objet du pair :
 * `execRelay` ouvrait le canal et lisait `run()` aussitot, avant que le resultat ne soit arrive, recevait
 * `null` et retombait sur `execMod.execute`. Soixante kilo-octets de sortie ne coutaient donc pas
 * une trame de plus qu'un `true`. Le client attend desormais le resultat du canal exec ; l'environnement
 * (`SendEnv`), le pty (`-t`) et la tenue de session sont envoyes en requetes de canal et DECIDES par
 * le serveur (`AcceptEnv`, `PermitUserEnvironment`, options de cle, `SSH_NO_TTY`).
 *
 * Laboratoire : un poste et un serveur sur un commutateur, compte alice, fichier de 60 Ko. Sur les six
 * cas, un seul tombe avant la correction : le cout en trames de la sortie. Cinq passent des deux
 * cotes, et sont nommes : le temoin « la commande s'execute en tant que l'utilisateur authentifie »,
 * « sans `-t` il n'y a pas de terminal », « `-t` en donne un » et « AcceptEnv laisse arriver la
 * variable » prouvent que le laboratoire est sain ; « une variable non acceptee n'arrive pas » est
 * une non-regression (le client rendait deja ce verdict en lisant la configuration du serveur ;
 * c'est maintenant le serveur qui le rend, sur la requete `env` du canal).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let client: LinuxPC;
let server: LinuxServer;
let cable: Cable;

const ssh = (options: string, command: string): string =>
  `sshpass -p pw ssh -o StrictHostKeyChecking=no ${options} alice@10.0.0.2 ${command}`;
const framesDuring = async (command: string): Promise<number> => {
  const before = cable.getStats().framesTransmitted;
  await client.executeCommand(command);
  return cable.getStats().framesTransmitted - before;
};

beforeEach(async () => {
  EquipmentRegistry.getInstance().clear();
  client = new LinuxPC('linux-pc', 'A', 0, 0);
  server = new LinuxServer('linux-server', 'B', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  cable = new Cable('c0');
  cable.connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  await server.executeCommand('sudo useradd -m alice');
  await server.executeCommand('echo "alice:pw" | sudo chpasswd');
  await server.executeCommand('sudo sh -c "head -c 60000 /dev/zero | tr \\\\0 x > /home/alice/big.txt"');
});

describe('une commande distante lancee depuis Linux traverse le cable', () => {
  it('temoin : la commande s\'execute en tant que l\'utilisateur authentifie', async () => {
    expect((await client.executeCommand(ssh('', 'whoami'))).trim()).toBe('alice');
  });

  it('60 Ko de sortie coutent plus de trames qu\'une commande muette', async () => {
    const quiet = await framesDuring(ssh('', 'true'));
    const loud = await framesDuring(ssh('', 'cat /home/alice/big.txt'));
    expect(loud).toBeGreaterThan(quiet);
  });

  it('une variable offerte mais non acceptee par le serveur n\'arrive pas', async () => {
    expect((await client.executeCommand(`MYVAR=zzz ${ssh('-o "SendEnv MYVAR"', `'echo "[$MYVAR]"'`)}`)).trim()).toBe('[]');
  });

  it('temoin : AcceptEnv sur le serveur la laisse arriver', async () => {
    await server.executeCommand('echo "AcceptEnv MYVAR" | sudo tee -a /etc/ssh/sshd_config');
    await server.executeCommand('sudo systemctl reload ssh');
    expect((await client.executeCommand(`MYVAR=zzz ${ssh('-o "SendEnv MYVAR"', `'echo "[$MYVAR]"'`)}`)).trim()).toBe('[zzz]');
  });

  it('temoin : sans -t il n\'y a pas de terminal', async () => {
    expect(await client.executeCommand(ssh('', 'tty'))).toContain('not a tty');
  });

  it('temoin : -t en donne un', async () => {
    expect(await client.executeCommand(ssh('-t', 'tty'))).toMatch(/\/dev\/pts\/\d+/);
  });
});
