/**
 * Le verdict de transit du client `ssh` vient du FIL, pas d'un rejeu.
 *
 * Ce qui a ete mesure. `LinuxSshClient` demandait a
 * `transitTcpAclVerdict` (`devices/linux/network/HostLookup.ts`) si un
 * SYN passerait : cette fonction parcourait la topologie depuis le port
 * source, suivait les cables et evaluait un SYN SYNTHETIQUE contre
 * `evaluateACLByName` de chaque routeur rencontre. C'etait une SECONDE
 * implantation de « ce paquet passerait-il ? », a cote de
 * `evaluateForDataPlane` que suit le vrai plan de donnees, et rien
 * n'empechait les deux de diverger. Consequence directe et visible : un
 * `ssh` bloque par une liste de transit ne coutait AUCUNE trame — le
 * verdict etait juste, et obtenu sans rien envoyer.
 *
 * La discrimination qui a decide du correctif. En neutralisant
 * `transitTcpAclVerdict` a `permit`, `connectOutcome` d'une pile TCP
 * reelle rend TOUJOURS `prohibited` a travers un routeur
 * `deny ip any any`, alors que `ssh` rend `alice` : le plan de donnees
 * savait deja refuser, et seul le client ne le lui demandait pas. La
 * note qui declarait ce rejeu « porteur » etait donc perimee. Le client
 * emet desormais un vrai SYN sans connexion (`TcpStack.scanProbe`,
 * celui des balayages `nmap`) et lit ce qui revient.
 *
 * Sources. Le comportement attendu est celui d'OpenSSH sur un reseau
 * reel : un SYN JETE en transit ne produit ni RST ni ICMP, donc le
 * client attend puis rend `Connection timed out` ; un port ferme sur
 * l'hote produit un RST, donc `Connection refused`. Les listes Cisco
 * etendues sont citees par leur comportement standard : une liste
 * appliquee `in` juge le paquet a l'entree de l'interface, et
 * `permit tcp any any eq 22` ne sauve que le port 22.
 *
 * Discrimine par `git stash` : 2 des 7 cas tombent avant correctif, et
 * LESQUELS est tout le resultat. Les QUATRE cas de verdict — temoin,
 * `deny ip any any`, `permit ... eq 22`, `permit ... eq 23` — passent des
 * deux cotes, parce que le rejeu rendait DEJA la bonne reponse : ce n'est
 * pas la justesse qui manquait. Le cinquieme, « la trame ne franchit PAS le
 * routeur », est STRUCTUREL : il passait avant pour une raison qui ne prouve
 * rien, aucune trame n'etant jamais emise. Ce qui tombe, ce sont les deux
 * cas qui COMPTENT les trames : le SYN refuse n'en coutait aucune, et sans
 * liste aucune ne franchissait le routeur non plus. Le verdict etait juste
 * et obtenu sans rien envoyer ; il est maintenant subi.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

const DENY_TOUT = 'access-list 100 deny ip any any';

async function labo(acl: readonly string[]) {
  const routeur = new CiscoRouter('R1');
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'SRV1');
  const c1 = new Cable('c1');
  const c2 = new Cable('c2');
  c1.connect(routeur.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
  c2.connect(routeur.getPort('GigabitEthernet0/1')!, srv.getPort('eth0')!);
  for (const commande of ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.2.1 255.255.255.0', 'no shutdown', 'exit',
    ...acl,
    ...(acl.length
      ? ['interface GigabitEthernet0/0', 'ip access-group 100 in', 'exit'] : []),
    'end']) {
    await routeur.executeCommand(commande);
  }
  pc.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  pc.setDefaultGateway(new IPAddress('10.0.1.1'));
  srv.configureInterface('eth0', new IPAddress('10.0.2.10'), new SubnetMask('255.255.255.0'));
  srv.setDefaultGateway(new IPAddress('10.0.2.1'));
  await srv.executeCommand('sudo systemctl start ssh');
  await srv.executeCommand('sudo useradd -m alice');
  await srv.executeCommand('echo "alice:secret123" | sudo chpasswd');
  return { routeur, pc, srv, c1, c2 };
}

const SSH = 'sshpass -p secret123 ssh -o StrictHostKeyChecking=no alice@10.0.2.10 whoami';

async function sshAuTravers(acl: readonly string[]): Promise<string> {
  const { pc } = await labo(acl);
  return (await pc.executeCommand(SSH)).trim();
}

describe('Une liste de transit se SUBIT, elle ne se rejoue pas', () => {
  it('TEMOIN : sans liste, la commande distante repond', async () => {
    expect(await sshAuTravers([])).toBe('alice');
  });

  it('`deny ip any any` fait expirer la connexion', async () => {
    expect(await sshAuTravers([DENY_TOUT]))
      .toContain('ssh: connect to host 10.0.2.10 port 22: Connection timed out');
  });

  it('`permit tcp any any eq 22` retablit', async () => {
    expect(await sshAuTravers(['access-list 100 permit tcp any any eq 22', DENY_TOUT]))
      .toBe('alice');
  });

  it('`permit tcp any any eq 23` ne sauve pas le port 22', async () => {
    expect(await sshAuTravers(['access-list 100 permit tcp any any eq 23', DENY_TOUT]))
      .toContain('Connection timed out');
  });

  it('le SYN refuse COUTE une trame : le verdict est subi, pas devine', async () => {
    const { pc, c1 } = await labo([DENY_TOUT]);
    await pc.executeCommand('ping -c 1 10.0.2.10');
    const avant = c1.getStats().framesTransmitted;
    await pc.executeCommand(SSH);
    expect(c1.getStats().framesTransmitted).toBeGreaterThan(avant);
  });

  it('STRUCTUREL : et la trame ne franchit PAS le routeur', async () => {
    const { pc, c2 } = await labo([DENY_TOUT]);
    await pc.executeCommand('ping -c 1 10.0.2.10');
    const avant = c2.getStats().framesTransmitted;
    await pc.executeCommand(SSH);
    expect(c2.getStats().framesTransmitted).toBe(avant);
  });

  it('sans liste, le SYN FRANCHIT le routeur', async () => {
    const { pc, c2 } = await labo([]);
    await pc.executeCommand('ping -c 1 10.0.2.10');
    const avant = c2.getStats().framesTransmitted;
    await pc.executeCommand(SSH);
    expect(c2.getStats().framesTransmitted).toBeGreaterThan(avant);
  });
});
