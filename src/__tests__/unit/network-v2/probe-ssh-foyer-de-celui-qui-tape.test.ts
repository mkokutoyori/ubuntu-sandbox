/*
 * Sonde : `ssh` lit le `~/.ssh` de CELUI QUI LE TAPE.
 *
 * Aucune reference exterieure n'est necessaire — c'est la definition
 * d'OpenSSH, et elle se verifie sur la machine seule : deux comptes du
 * MEME poste ont deux configurations clientes, deux jeux de cles et
 * deux `known_hosts`. Ce que l'un enregistre, l'autre ne le voit pas.
 *
 * CE QUI L'A FAIT ECRIRE : `LinuxCommandExecutor.sshHomeDir()` rendait
 * le foyer de `root` quel que soit l'utilisateur courant, et
 * `sshLauncher.checkKnownHosts` ecrivait `/root/.ssh/known_hosts` en
 * dur — alors que `PendingSshAuth.sourceUser` est declare « choisit
 * quel known_hosts la connexion lit et ecrit ». Un compte ordinaire
 * obeissait donc a la configuration cliente de root : sa cle
 * d'identite, son `ProxyJump`, son `StrictHostKeyChecking`. C'est le
 * raccourci que ce depot refuse — la privilegie s'y perdait sans un
 * mot, et personne ne pouvait le voir depuis la CLI.
 *
 * Discriminee contre l'etat d'avant : 5 des 8 cas tombent. Les 3 qui
 * passent des deux cotes sont nommes :
 *   - « `whoami` n'est pas root » est le TEMOIN DU BANC : sans lui, une
 *     sonde qui mesurerait une machine ou tout tourne en root passerait
 *     des deux cotes en ne prouvant rien ;
 *   - « root garde son propre foyer » est la NON-REGRESSION : c'etait
 *     la seule reponse juste avant, et elle devait le rester ;
 *   - « une cle nommee en absolu reste lue » garde ce que la correction
 *     ne prend pas : le developpement du tilde s'ajoute, il ne remplace
 *     pas le chemin absolu.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

interface Lab { client: LinuxPC; server: LinuxServer }

function laboratoire(): Lab {
  const client = new LinuxPC('linux-pc', 'poste', 0, 0);
  const server = new LinuxServer('linux-server', 'serveur', 0, 0);
  new Cable('c1').connect(client.getPorts()[0], server.getPorts()[0]);
  const masque = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), masque);
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), masque);
  return { client, server };
}

const texte = async (d: LinuxPC | LinuxServer, c: string): Promise<string> =>
  String(await d.executeCommand(c));

describe('le client `ssh` lit le foyer de l utilisateur courant', () => {
  it('`whoami` n est pas root — sans quoi la sonde ne mesure rien', async () => {
    const { client } = laboratoire();
    expect((await texte(client, 'whoami')).trim()).toBe('user');
    expect((await texte(client, 'echo $HOME')).trim()).toBe('/home/user');
  });

  it('`ssh-keygen` sans `-f` ecrit dans le foyer de l utilisateur', async () => {
    const { client } = laboratoire();
    await texte(client, "ssh-keygen -t ed25519 -N '' -q");
    expect(await texte(client, 'ls ~/.ssh')).toContain('id_ed25519');
    expect(await texte(client, 'sudo ls /root/.ssh')).not.toContain('id_ed25519');
  });

  it('`known_hosts` se pose dans le foyer de l utilisateur', async () => {
    const { client } = laboratoire();
    await texte(client, 'ssh -o StrictHostKeyChecking=accept-new alice@10.0.0.2 true');
    expect(await texte(client, 'cat ~/.ssh/known_hosts')).toContain('10.0.0.2');
  });

  it('`~/.ssh/config` de l utilisateur est LU', async () => {
    const { client } = laboratoire();
    await texte(client, 'mkdir -p ~/.ssh');
    await texte(client, 'printf "Host cible\\n  HostName 10.0.0.2\\n  User alice\\n" > ~/.ssh/config');
    expect(await texte(client, 'ssh cible whoami')).toContain('alice');
  });

  it('celui de root est IGNORE par un compte ordinaire', async () => {
    const { client } = laboratoire();
    await texte(client, 'sudo mkdir -p /root/.ssh');
    await texte(client,
      'printf "Host cible\\n  HostName 10.0.0.2\\n  User alice\\n" | sudo tee /root/.ssh/config');
    expect(await texte(client, 'ssh cible whoami')).toMatch(/Could not resolve|Name or service/);
  });

  it('`IdentityFile ~/...` developpe le tilde du meme foyer', async () => {
    const { client } = laboratoire();
    await texte(client, "ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_deux -q");
    await texte(client, 'ssh-copy-id -i ~/.ssh/id_deux.pub alice@10.0.0.2');
    await texte(client, 'printf "Host cible\\n  HostName 10.0.0.2\\n  User alice\\n'
      + '  IdentityFile ~/.ssh/id_deux\\n  IdentitiesOnly yes\\n" > ~/.ssh/config');
    expect(await texte(client, 'ssh -o PasswordAuthentication=no cible whoami'))
      .toContain('alice');
  });

  it('une cle nommee en ABSOLU reste lue — le TEMOIN', async () => {
    const { client } = laboratoire();
    await texte(client, "ssh-keygen -t ed25519 -N '' -f /home/user/.ssh/id_trois -q");
    await texte(client, 'ssh-copy-id -i /home/user/.ssh/id_trois.pub alice@10.0.0.2');
    expect(await texte(client,
      'ssh -o PasswordAuthentication=no -i /home/user/.ssh/id_trois alice@10.0.0.2 whoami'))
      .toContain('alice');
  });

  it('root garde son propre foyer — la NON-REGRESSION', async () => {
    const { client } = laboratoire();
    await texte(client, "sudo ssh-keygen -t ed25519 -N '' -q");
    expect(await texte(client, 'sudo ls /root/.ssh')).toContain('id_ed25519');
  });
});
