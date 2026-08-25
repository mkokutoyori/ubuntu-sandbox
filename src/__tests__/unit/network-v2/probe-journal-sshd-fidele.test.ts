/**
 * Le journal de sshd dit ce qu'un vrai sshd dit, et le dit UNE fois,
 * quel que soit le constructeur qui se connecte.
 *
 * MESURE DE DEPART, sur un serveur Linux joint par quatre clients de
 * constructeurs differents (Linux, Cisco IOS, Huawei VRP, Windows),
 * `journalctl -u ssh` rendait :
 *
 *   Accepted password for alice from 10.0.0.2 (linux-pc) port 50000 ssh2
 *   Accepted password for alice from 10.0.0.3 (R1) port 50000 ssh2
 *   Failed password for admin from 10.0.0.4 (HW1) port 50000 ssh2
 *   Connection refused for admin from 10.0.0.4: no such user
 *   Accepted password for alice from 10.0.0.5 (WIN) port 50000 ssh2
 *
 * SEPT ECARTS, tous confrontes au code d'OpenSSH plutot qu'a un
 * souvenir (`auth.c`, `auth2.c`, `packet.c` d'openssh-portable) :
 *
 * 1. LE `(nom d'hote)` N'EXISTE PAS. `auth.c:294` ecrit
 *    « %s %s for %s%.100s from %.200s port %d ssh2 » : l'adresse, le
 *    port, rien entre les deux.
 * 2. `invalid user ` MANQUAIT. Le meme format insere ce membre quand le
 *    compte n'existe pas (`authctxt->valid ? "" : "invalid user "`), et
 *    c'est ce qui distingue un mot de passe faux d'un compte inconnu.
 * 3. LA LIGNE `Invalid user <u> from <ip> port <p>` N'ETAIT PAS EMISE.
 *    `auth.c:498` l'ecrit AVANT l'echec, et c'est elle que lit fail2ban.
 * 4. `Connection refused for … : <raison>` N'EST PAS UN MESSAGE
 *    D'OPENSSH. Aucune chaine de ce genre n'existe dans ses sources ;
 *    elle doublait l'echec avec une phrase inventee.
 * 5. LE PORT SOURCE ETAIT LA CONSTANTE 50000 pour tout le monde, alors
 *    que la machine porte un vrai attributeur ephemere et que
 *    `/proc/sys/net/ipv4/ip_local_port_range` en donne les bornes. Une
 *    TROISIEME valeur, encore differente, etait fabriquee pour la table
 *    des sockets — donc `ss` et le journal se contredisaient.
 * 6. `pam_unix(sshd:session)` AVAIT DEUX PRODUCTEURS de formats
 *    differents : celui de `LinuxMachine` (le vrai) et un autre dans
 *    `SshSyslogger` qui ajoutait « (channel session) » et une duree.
 * UN SEPTIEME ECART EST MESURE ET N'EST PAS FERME ICI : aucune session
 * ne se ferme jamais cote serveur — ni `session closed`, ni
 * `Disconnected from` — si bien que trois sessions terminees restent
 * « still logged in » dans `who`, `w` et `last` alors que les quatre
 * clients ont tous ecrit « Connection to 10.0.0.1 closed. ». Le
 * correctif existe (`LinuxMachine.recordSshLogout`, ecrit et teste) mais
 * le BRANCHER fait tomber cinq laboratoires dont la fuite est la
 * premisse — ils observent `who`, `w`, `ss` et l'etat de logind APRES
 * un `ssh` deja termine, ce qu'une vraie machine n'offre pas. Voir
 * l'entree `[ssh]` du `TODO.md` : ce qui manque est un modele de DUREE
 * de session, pas une ligne de journal.
 *
 * DISCRIMINATION : 4 des 6 cas tombent avant correctif. Les 2 autres
 * sont nommes ici plutot que laisses a decouvrir :
 *  - « le service ecoute » est le TEMOIN qui prouve que le laboratoire
 *    est monte — sans lui, une sonde faite d'absences passerait sur un
 *    journal entierement vide.
 *  - « `pam_unix(sshd:session)` n'a qu'un seul format » passe des deux
 *    cotes parce que le second producteur n'ecrivait QUE des lignes
 *    d'ouverture de canal, jamais atteintes par ces quatre clients :
 *    il etait donc mort ici et vivant ailleurs. Le cas garde qu'aucun
 *    second format ne revienne.
 */

import { describe, it, expect } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';

interface Boitier { getPort(n: string): never; executeCommand(c: string): Promise<string> | string }

async function labo(): Promise<{ srv: LinuxPC; journal: () => Promise<string> }> {
  const srv = new LinuxPC('linux-pc', 'SRV');
  const cli = new LinuxPC('linux-pc', 'CLI');
  const r = new CiscoRouter('R1');
  const hw = new HuaweiRouter('HW1');
  const win = new WindowsPC('windows-pc', 'WIN');
  const sw = createDevice('switch-cisco', 0, 0) as unknown as Boitier & { powerOn(): void };
  for (const d of [srv, cli, win]) d.powerOn();
  sw.powerOn();

  const relier = (a: unknown, pa: string, pb: string, id: string) =>
    new Cable(id).connect((a as Boitier).getPort(pa), sw.getPort(pb));
  relier(srv, 'eth0', 'FastEthernet0/1', 'c1');
  relier(cli, 'eth0', 'FastEthernet0/2', 'c2');
  relier(r, 'GigabitEthernet0/0', 'FastEthernet0/3', 'c3');
  relier(hw, 'GE0/0/0', 'FastEthernet0/4', 'c4');
  relier(win, 'eth0', 'FastEthernet0/5', 'c5');

  const m = new SubnetMask('255.255.255.0');
  srv.configureInterface('eth0', new IPAddress('10.0.0.1'), m);
  cli.configureInterface('eth0', new IPAddress('10.0.0.2'), m);
  win.configureInterface('eth0', new IPAddress('10.0.0.5'), m);
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.3 255.255.255.0', 'no shutdown', 'end']) await r.executeCommand(c);
  for (const c of ['system-view', 'interface GE0/0/0',
    'ip address 10.0.0.4 255.255.255.0', 'quit', 'quit']) await hw.executeCommand(c);

  await srv.executeCommand('sudo useradd -m -s /bin/bash alice');
  await srv.executeCommand('echo "alice:secret" | sudo chpasswd');
  await srv.executeCommand('sudo systemctl start ssh');

  await cli.executeCommand('ssh alice@10.0.0.1 whoami');
  await r.executeCommand('ssh -l alice 10.0.0.1');
  await hw.executeCommand('stelnet 10.0.0.1');
  await win.executeCommand('ssh alice@10.0.0.1');

  return {
    srv,
    journal: async () => String(await srv.executeCommand('sudo journalctl -u ssh --no-pager')),
  };
}

const lignesSshd = (j: string): string[] =>
  j.split('\n').filter(l => / sshd\[\d+\]: /.test(l)).map(l => l.replace(/^.* sshd\[\d+\]: /, ''));

describe('le journal porte les messages d\'OpenSSH', () => {
  it('le service ecoute', async () => {
    expect(await (await labo()).journal()).toContain('Server listening on 0.0.0.0 port 22.');
  });

  it('aucun `Accepted` ne porte de nom d\'hote entre parentheses', async () => {
    const acceptes = lignesSshd(await (await labo()).journal()).filter(l => l.startsWith('Accepted'));
    expect(acceptes.length).toBe(3);
    for (const l of acceptes) {
      expect(l).toMatch(/^Accepted password for \w+ from [\d.]+ port \d+ ssh2$/);
    }
  });

  it('un compte inconnu donne les DEUX lignes d\'OpenSSH, dans l\'ordre', async () => {
    const l = lignesSshd(await (await labo()).journal());
    const invalide = l.findIndex(x => /^Invalid user admin from 10\.0\.0\.4 port \d+$/.test(x));
    const echec = l.findIndex(x => /^Failed password for invalid user admin from 10\.0\.0\.4 port \d+ ssh2$/.test(x));
    expect(invalide).toBeGreaterThanOrEqual(0);
    expect(echec).toBeGreaterThan(invalide);
  });

  it('la phrase inventee `Connection refused for` a disparu', async () => {
    expect(await (await labo()).journal()).not.toContain('Connection refused for');
  });

  it('chaque pair a son propre port source, pris dans la plage ephemere', async () => {
    const { srv, journal } = await labo();
    const ports = [...(await journal()).matchAll(/ port (\d+) ssh2/g)].map(m => Number(m[1]));
    const { min, max } = srv.getTcpStack().getEphemeralRange();
    expect(ports.length).toBe(4);
    expect(new Set(ports).size).toBe(4);
    for (const p of ports) { expect(p).toBeGreaterThanOrEqual(min); expect(p).toBeLessThanOrEqual(max); }
  });

  it('`pam_unix(sshd:session)` n\'a qu\'un seul format', async () => {
    const l = lignesSshd(await (await labo()).journal()).filter(x => x.startsWith('pam_unix(sshd:session)'));
    expect(l.length).toBe(3);
    for (const x of l) {
      expect(x).toMatch(/^pam_unix\(sshd:session\): session (opened for user \w+\(uid=\d+\) by \(uid=0\)|closed for user \w+)$/);
    }
  });
});
