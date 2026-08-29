/**
 * Un routeur Cisco ne parle pas OpenSSH, et un Huawei non plus
 * (BRD-Modele-TCP-IP.md phase 8, lot 7).
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * `ssh: connect to host <h> port <p>: No route to host` etait ecrit EN
 * DUR dans la session CLI des constructeurs, si bien qu'un routeur Cisco
 * et un routeur Huawei rendaient la phrase du client d'OpenSSH sur leur
 * propre invite. C'est exactement le defaut que `telnetDialect.ts` avait
 * ferme pour telnet — « le client BSD sur un prompt IOS » — la moitie SSH
 * n'ayant jamais ete faite.
 *
 * ── Ce qui a debloque ce lot, et qui n'etait pas acquis ─────────────
 *
 * Ce travail a d'abord ete INSCRIT au `TODO.md` plutot qu'ecrit, parce
 * que la matiere manquait : rien n'attestait ce qu'un client SSH d'IOS
 * ecrit. La recherche a fourni les trois issues d'echec, chacune sur une
 * transcription reelle et non sur un raisonnement :
 *
 *   absence de route  `% Destination unreachable; gateway or host down`
 *   refus             `% Connection refused by remote host`
 *   delai             `% Connection timed out; remote host not responding`
 *
 * Les deux premieres sont MOT POUR MOT celles du client telnet d'IOS, ce
 * qui se comprend — les deux clients partagent le chemin de connexion TCP
 * de la plateforme — et la troisieme est rapportee sur un Catalyst 4900
 * avec la commande a l'appui (`ssh -v 2 -l mariano 192.168.4.17`). Cote
 * VRP, la documentation Huawei donne la sortie du client STelnet :
 * `Trying … / Press CTRL+K to abort / Error: Failed to connect to the
 * remote host`, UNE seule formule pour toutes les causes — donc la table
 * VRP est celle que `VRP_TELNET` portait deja.
 *
 * Le seul cas encore non atteste est le nom NON RESOLU cote SSH d'IOS ;
 * `% Bad IP address or host name` est ce qu'IOS rend pour une saisie
 * qu'il ne sait pas traduire, et c'est ecrit ici plutot que tu.
 *
 * ── Ce que ce lot ne touche PAS, et pourquoi ────────────────────────
 *
 * Linux et Windows gardent les phrases d'OpenSSH, parce qu'elles y sont
 * JUSTES : le `ssh.exe` de Windows EST le portage d'OpenSSH. Une premiere
 * lecture de ce defaut comptait Windows parmi les fautifs ; la
 * verification l'a corrigee, et « corriger » Windows aurait casse ce qui
 * marche.
 *
 * ── Ou etait le defaut, precisement ────────────────────────────────
 *
 * Le client SSH sortant d'IOS comme celui de VRP **delegue au client
 * Linux** (`runSshClient`) et rend sa sortie TELLE QUELLE : ils ne
 * parlaient donc pas OpenSSH par recopie d'une phrase, ils EXECUTAIENT
 * OpenSSH. Le correctif ne reecrit pas cette delegation — il fait
 * trancher la JOIGNABILITE par le routeur lui-meme, sur sa propre table
 * (`TcpStack.hasEgressTo`), avant de deleguer la session ; c'est la meme
 * forme que le correctif telnet du lot 5.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * DEUX cas sur six tombent, et ce sont les deux qui observent une VRAIE
 * machine — le routeur Cisco et le routeur Huawei. Les quatre autres sont
 * nommes plutot que laisses a decouvrir : les trois qui lisent les tables
 * ne peuvent pas discriminer, le module etant NOUVEAU (elles epinglent ce
 * qu'il contient et l'accord entre les deux clients d'une plateforme, ce
 * qu'aucune ne garantissait avant) ; et le TEMOIN Linux passe des deux
 * cotes comme il le doit, sans quoi une table qui rendrait du Cisco
 * partout passerait cette sonde.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IOS_SSH, VRP_SSH, OPENSSH_SSH } from '@/terminal/ssh/sshDialect';
import { IOS_TELNET, VRP_TELNET } from '@/terminal/subshells/telnetDialect';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('ssh parle la langue de sa plateforme', () => {
  it('IOS rend ses trois messages attestes, et aucune phrase d\'OpenSSH', () => {
    expect(IOS_SSH.unreachable('10.0.0.9', 22))
      .toBe('% Destination unreachable; gateway or host down');
    expect(IOS_SSH.refused('10.0.0.9', 22))
      .toBe('% Connection refused by remote host');
    expect(IOS_SSH.timedOut('10.0.0.9', 22))
      .toBe('% Connection timed out; remote host not responding');
    for (const rendu of [IOS_SSH.unreachable('10.0.0.9', 22), IOS_SSH.refused('10.0.0.9', 22),
      IOS_SSH.timedOut('10.0.0.9', 22), IOS_SSH.unresolved('nom', 22)]) {
      expect(rendu).not.toContain('ssh: connect to host');
      expect(rendu).not.toContain('Could not resolve hostname');
    }
  });

  it('VRP dit la MEME chose pour toutes les causes, comme sur la boite', () => {
    const rendus = new Set([
      VRP_SSH.unreachable('10.0.0.9', 22), VRP_SSH.refused('10.0.0.9', 22),
      VRP_SSH.timedOut('10.0.0.9', 22), VRP_SSH.unresolved('10.0.0.9', 22),
    ]);
    expect(rendus.size).toBe(1);
    expect([...rendus][0]).toBe('Error: Failed to connect to the remote host.');
  });

  it('les deux clients d\'une meme plateforme s\'accordent sur ce qu\'ils partagent', () => {
    expect(IOS_SSH.unreachable('h', 22)).toBe(IOS_TELNET.unreachable('h', 'h', 23)[1]);
    expect(IOS_SSH.timedOut('h', 22)).toBe(IOS_TELNET.timedOut('h', 'h', 23)[1]);
    expect(IOS_SSH.refused('h', 22)).toBe(IOS_TELNET.refused('h', 'h', 23)[1]);
    expect(VRP_SSH.unreachable('h', 22)).toBe(VRP_TELNET.unreachable('h', 'h', 23)[1]);
  });

  it('un vrai routeur Cisco rend la phrase d\'IOS, pas celle d\'OpenSSH', async () => {
    const routeur = new CiscoRouter('R');
    const poste = new LinuxPC('PC');
    new Cable('c1').connect(routeur.getPort('GigabitEthernet0/0')!, poste.getPort('eth0')!);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end']) {
      await routeur.executeCommand(c);
    }

    const texte = await routeur.executeCommand('ssh -l admin 203.0.113.9');
    expect(texte).toContain('% Destination unreachable; gateway or host down');
    expect(texte).not.toContain('ssh: connect to host');
  });

  it('un vrai routeur Huawei rend la phrase de VRP', async () => {
    const routeur = new HuaweiRouter('R2');
    const poste = new LinuxPC('PC2');
    new Cable('c2').connect(routeur.getPort('GE0/0/0')!, poste.getPort('eth0')!);
    for (const c of ['system-view', 'interface GigabitEthernet0/0/0',
      'ip address 10.0.0.1 255.255.255.0', 'undo shutdown', 'return']) {
      await routeur.executeCommand(c);
    }

    const texte = await routeur.executeCommand('ssh 203.0.113.9');
    expect(texte).toContain('Error: Failed to connect to the remote host.');
    expect(texte).not.toContain('ssh: connect to host');
  });

  it('TEMOIN : Linux et Windows gardent OpenSSH, qui y est JUSTE', () => {
    expect(OPENSSH_SSH.unreachable('10.0.0.9', 22))
      .toBe('ssh: connect to host 10.0.0.9 port 22: Network is unreachable');
    expect(OPENSSH_SSH.refused('10.0.0.9', 22))
      .toBe('ssh: connect to host 10.0.0.9 port 22: Connection refused');
  });
});
