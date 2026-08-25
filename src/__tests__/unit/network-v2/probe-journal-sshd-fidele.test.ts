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
 * 7. AUCUNE SESSION NE SE FERMAIT. Ni `session closed`, ni
 *    `Disconnected from` — et la consequence depassait le journal :
 *    trois sessions terminees restaient « still logged in » dans `who`,
 *    `w` et `last` alors que les quatre clients avaient tous ecrit
 *    « Connection to 10.0.0.1 closed. ». `emitSessionClosedLog` n'avait
 *    qu'UN appelant, `loginctl terminate-session` : une deconnexion
 *    ORDINAIRE n'avait aucun chemin de fermeture.
 *
 * CE QUE FERMER A EXIGE, et c'est la raison pour laquelle ce n'etait pas
 * qu'une ligne de journal : une session DURE. Fermer des le retour de
 * l'appel aurait casse les laboratoires qui tiennent une session par
 * `ssh hote 'sleep 60' &` pour l'observer — et ils ont RAISON, une
 * vraie machine la montre pendant sa duree. `runSleep` rendait deja le
 * nombre de secondes et personne ne le lisait ; l'executeur le publie,
 * et la fermeture est planifiee a `maintenant + duree` sur l'horloge
 * virtuelle. Une commande qui rend la main tout de suite ferme tout de
 * suite ; `sleep 60` tient la session soixante secondes.
 *
 * DISCRIMINATION, mesuree en DEUX temps parce que la sonde couvre deux
 * lots : contre l'etat d'avant le lot des FORMATS, 9 des 11 cas
 * tombent ; contre l'etat d'avant le lot de la FERMETURE, 5 tombent —
 * les quatre de « toute session ouverte se referme » plus l'unicite du
 * format `pam_unix`. Les deux qui ne tombent dans aucun des deux sont
 * nommes ici : « le service ecoute » est le TEMOIN qui prouve que le
 * laboratoire est monte — sans lui, une sonde faite d'absences
 * passerait sur un journal entierement vide — et « la session de
 * console survit » garde que la fermeture ne ferme QUE les sessions
 * SSH.
 *
 * UN DEFAUT INTRODUIT PAR CE LOT, TROUVE ET REFERME AVANT COMMIT : la
 * duree est publiee sur l'EXECUTEUR de la machine, donc un `sleep`
 * LOCAL laissait sa valeur en attente et la premiere fermeture SSH
 * venue en heritait — une session fermait 300 secondes trop tard pour
 * un `sleep 300` tape a la console. Le compteur est remis a zero a
 * l'ENTREE de la commande distante et non a sa lecture ; le cas
 * « un `sleep` LOCAL ne tient aucune session SSH » le garde.
 */

import { describe, it, expect, vi } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';

interface Boitier { getPort(n: string): never; executeCommand(c: string): Promise<string> | string }

async function labo(): Promise<{ srv: LinuxPC; cli: LinuxPC; journal: () => Promise<string> }> {
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
    srv, cli,
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
    expect(l.length).toBeGreaterThan(0);
    for (const x of l) {
      expect(x).toMatch(/^pam_unix\(sshd:session\): session (opened for user \w+\(uid=\d+\) by \(uid=0\)|closed for user \w+)$/);
    }
    const ouvertes = l.filter(x => x.includes('opened')).length;
    expect(l.filter(x => x.includes('closed')).length).toBe(ouvertes);
  });
});

describe('/var/log/auth.log n\'a qu\'un seul format de date', () => {
  it('les lignes de sudo portent l\'horodatage syslog, comme celles de sshd', async () => {
    const { srv } = await labo();
    const log = String(await srv.executeCommand('sudo cat /var/log/auth.log'));
    const lignes = log.split('\n').filter(l => l.includes(' sudo: '));
    expect(lignes.length).toBeGreaterThan(0);
    for (const l of lignes) {
      expect(l).toMatch(/^[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} /);
    }
    expect(log).not.toContain(', 25 Aug 202');
  });
});

describe('toute session ouverte se referme', () => {
  it('chaque connexion acceptee porte sa fermeture', async () => {
    const j = await (await labo()).journal();
    expect(j.split('\n').filter(l => l.includes('session opened')).length).toBe(3);
    expect(j.split('\n').filter(l => l.includes('session closed')).length).toBe(3);
  });

  it('et son `Disconnected from user`, avec le port de son ouverture', async () => {
    const j = await (await labo()).journal();
    for (const ip of ['10.0.0.2', '10.0.0.3', '10.0.0.5']) {
      const ouverture = new RegExp(`Accepted password for alice from ${ip.replace(/\./g, '\\.')} port (\\d+) ssh2`).exec(j);
      expect(ouverture).not.toBeNull();
      expect(j).toContain(`Disconnected from user alice ${ip} port ${ouverture![1]}`);
    }
  });

  it('plus aucune session SSH ne traine dans `who`', async () => {
    const { srv } = await labo();
    expect(String(await srv.executeCommand('who'))).not.toContain('alice');
  });

  it('mais une commande qui DURE tient sa session, et la rend a son terme', async () => {
    vi.useFakeTimers();
    try {
      const { srv, cli } = await labo();
      await cli.executeCommand('ssh alice@10.0.0.1 sleep 60');
      expect(String(await srv.executeCommand('who'))).toContain('alice');

      vi.advanceTimersByTime(61_000);
      expect(String(await srv.executeCommand('who'))).not.toContain('alice');
      expect(String(await srv.executeCommand('sudo journalctl -u ssh --no-pager')))
        .toContain('session closed for user alice');
    } finally {
      vi.useRealTimers();
    }
  });

  it('un `sleep` LOCAL ne tient aucune session SSH', async () => {
    const { srv, cli } = await labo();
    await srv.executeCommand('sleep 300');
    await cli.executeCommand('ssh alice@10.0.0.1 whoami');
    expect(String(await srv.executeCommand('who'))).not.toContain('alice');
  });

  it('la session de console survit', async () => {
    const { srv } = await labo();
    expect(String(await srv.executeCommand('who'))).toContain('tty1');
  });
});
