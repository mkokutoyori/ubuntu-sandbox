/*
 * Sur VRP, « le serveur SSH est-il en service ? » etait ecrit TROIS fois.
 *
 * Mesure de depart, sur un AR1 configure comme le fait un operateur —
 * `rsa local-key-pair create`, `stelnet server enable`, une vty en
 * `protocol inbound ssh`, un compte local — et un poste Linux qui s'y
 * connecte pour de bon :
 *
 *   ssh admin@10.0.0.1 "display ssh server session"   -> la session S'OUVRE
 *   display stelnet server            STelnet server: Enabled
 *   display ssh server status         SSH server: Disabled     <- FAUX
 *   display ssh server session        SSH server is not enabled. <- FAUX
 *
 * La machine ACCEPTE la connexion et, dans le meme instant, deux de ses
 * propres vues affirment qu'elle n'ecoute pas. C'est le defaut que la
 * regle 3 de `CLAUDE.md` nomme : deux vues qui peuvent se contredire sur
 * le MEME fait, sur la meme machine, au meme instant.
 *
 * Les trois ecritures, trouvees en cherchant qui decide :
 *
 *   Router.sshServerEnabled                 -> l'ECOUTE (la verite du fil)
 *   RouterManagementService.stelnetServer   -> `display stelnet server`
 *   RouterManagementService.sshServer       -> `display ssh server ...`
 *
 * `stelnet server enable` ecrivait les deux premieres et laissait la
 * troisieme a `false`. La correction n'ajoute pas une synchronisation :
 * elle SUPPRIME la troisieme ecriture. `stelnetServer` ne porte plus que
 * ce qu'il est seul a porter (son ACL) ; l'etat d'ecoute et le port sont
 * ceux du serveur SSH, puisque sur VRP STelnet EST le service SSH.
 *
 * L'AUTORITE EST LA DOCUMENTATION DU CONSTRUCTEUR, pas un RFC : le nom
 * `STelnet` est celui de Huawei, et c'est `stelnet server enable` qui met
 * le serveur SSH en service sur VRP — il n'y a pas deux serveurs a
 * allumer separement. Le format des vues n'est pas touche ici : seul
 * l'etat qu'elles lisent change.
 *
 * Ecrite a l'aveugle contre cette reference, avant de lire les magasins.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 4 des 8 cas tombent. Les 4 autres sont nommes ici, et aucun ne prouve
 * le mecanisme :
 *
 *  - TEMOIN DU FIL : la connexion SSH aboutit et rend la sortie du
 *    routeur distant. Il passe des DEUX cotes, et c'est justement lui
 *    qui rend la contradiction visible — sans lui, « les vues disent
 *    non » et « la machine n'ecoute pas » seraient indiscernables.
 *  - TEMOIN DE LA VUE JUSTE : `display stelnet server` repondait deja
 *    « Enabled ». Il designe la cause comme etant le magasin lu par les
 *    vues `ssh`, et non la commande d'activation.
 *  - NON-REGRESSIONS : un routeur NEUF, sans `stelnet server enable`,
 *    doit garder ses vues a « Disabled » ; et `display
 *    current-configuration` doit continuer d'ecrire `stelnet server
 *    enable`, la ligne que VRP rend vraiment, sans se mettre a en
 *    ecrire deux.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const ROUTEUR_IP = '10.0.0.1';
const POSTE_IP = '10.0.0.2';
const SECRET = 'Admin@123';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function laboratoire(): Promise<{ ar1: HuaweiRouter; poste: LinuxPC }> {
  const ar1 = new HuaweiRouter('AR1');
  const poste = new LinuxPC('linux-pc', 'PC', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW1', 4, 0, 0);
  new Cable('c1').connect(ar1.getPort('GE0/0/0')!, sw.getPorts()[0]);
  new Cable('c2').connect(poste.getPort('eth0')!, sw.getPorts()[1]);

  for (const c of [
    'system-view',
    'interface GigabitEthernet 0/0/0',
    `ip address ${ROUTEUR_IP} 24`,
    'undo shutdown',
    'quit',
    'rsa local-key-pair create',
    'stelnet server enable',
    'aaa',
    `local-user admin password cipher ${SECRET}`,
    'local-user admin privilege level 15',
    'local-user admin service-type ssh',
    'quit',
    'user-interface vty 0 4',
    'authentication-mode aaa',
    'protocol inbound ssh',
    'quit',
    'return',
  ]) await ar1.executeCommand(c);

  await poste.executeCommand(`ifconfig eth0 ${POSTE_IP} netmask 255.255.255.0`);
  return { ar1, poste };
}

describe('la machine ecoute vraiment — le TEMOIN', () => {
  it('un poste Linux ouvre une session SSH sur le routeur', async () => {
    const { poste } = await laboratoire();

    const sortie = await poste.executeCommand(
      `ssh admin@${ROUTEUR_IP} "display version"`, `${SECRET}\n`);

    expect(sortie).toMatch(/VRP|Huawei|Version/i);
  });
});

describe('toutes les vues du serveur SSH disent la meme chose', () => {
  it('`display stelnet server` l\'annonce en service — le TEMOIN', async () => {
    const { ar1 } = await laboratoire();

    expect(await ar1.executeCommand('display stelnet server')).toMatch(/Enabled/);
  });

  it('`display ssh server status` ne le dit plus hors service', async () => {
    const { ar1 } = await laboratoire();

    expect(await ar1.executeCommand('display ssh server status')).not.toMatch(/Disabled/);
  });

  it('`display ssh server session` repond au lieu de nier le serveur', async () => {
    const { ar1 } = await laboratoire();

    expect(await ar1.executeCommand('display ssh server session'))
      .not.toMatch(/not enabled/i);
  });

  it('et elle nomme la session depuis laquelle on la tape', async () => {
    const { poste } = await laboratoire();

    const sortie = await poste.executeCommand(
      `ssh admin@${ROUTEUR_IP} "display ssh server session"`, `${SECRET}\n`);

    expect(sortie).toContain('admin');
    expect(sortie).toContain(POSTE_IP);
  });

  it('le socle des sockets annonce un serveur `ssh`, pas deux services', async () => {
    const { ar1 } = await laboratoire();

    const sortie = await ar1.executeCommand('display tcp status');
    expect(sortie).toMatch(/:22\b/);
    expect(sortie).not.toMatch(/stelnet/);
  });
});

describe('ce que le correctif ne doit pas casser', () => {
  it('un routeur NEUF garde ses vues hors service', async () => {
    const neuf = new HuaweiRouter('AR9');

    expect(await neuf.executeCommand('display ssh server status')).toMatch(/Disabled/);
    expect(await neuf.executeCommand('display stelnet server')).toMatch(/Disabled/);
  });

  it('la configuration courante ecrit `stelnet server enable` une seule fois', async () => {
    const { ar1 } = await laboratoire();

    const conf = await ar1.executeCommand('display current-configuration');
    const lignes = conf.split('\n').filter((l) => l.trim() === 'stelnet server enable');
    expect(lignes).toHaveLength(1);
    expect(conf).not.toMatch(/^ssh server enable$/m);
  });
});
