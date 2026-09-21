/**
 * AUDIT SECURITE — SECOND PASSAGE, constats H-01 a H-05 : LA PILE HOTE.
 *
 * `docs/AUDIT-SECURITE-INFRA.md` §5 nommait la pile hote — `iptables`,
 * `sudo`, les permissions `oracle` — comme la derniere tranche jamais
 * attaquee. Relevé : `src/__tests__/debug/infra/second-passage-pile-hote.debug.test.ts`.
 *
 * H-01 — `ls` NE LISAIT PAS LE DROIT DE LECTURE DU REPERTOIRE.
 *   `/root` est `drwx------ root root`, et n'importe quel compte le
 *   listait. `cat` consultait `canRead()` (et refusait `/etc/shadow`),
 *   `ls` ne le consultait nulle part : deux lecteurs d'une meme regle
 *   DAC, dont un seul l'appliquait. Le mode 700 est LE durcissement
 *   canonique d'un repertoire — et `chmod 750` sur `oradata` ne
 *   protegeait donc rien non plus.
 *
 * H-02 — `sudo /bin/ls` REFUSE ALORS QUE LA LIGNE NOMME `/bin/ls`.
 *   `sudo -l` rendait bien `(ALL) NOPASSWD: /bin/ls`, `sudo ls` passait,
 *   et `sudo /bin/ls` — le chemin exact — etait refuse. Deux causes qui
 *   se rejoignaient : `resolveExePath` prefixait un chemin DEJA absolu
 *   (`/usr/bin//bin/ls`), et le comparateur de la politique opposait les
 *   chemins bruts alors que `/bin` est un lien vers `/usr/bin` — une
 *   equivalence dont ce depot portait deja le predicat
 *   (`canonicalBinPath`), utilise ailleurs et pas la.
 *
 * H-03 — `sudo su <user> -c "<cmd>"` LAISSAIT LA SESSION ROOT.
 *   Une elevation a USAGE UNIQUE ne revenait jamais : apres
 *   `sudo su tiers -c "id -u"`, `id -u` rendait 0 et toute commande
 *   suivante s'executait root. Le restaurateur etait garde par
 *   `actualCmd !== 'su'` — juste pour la forme INTERACTIVE, ou `su`
 *   laisse une session ouverte — et la forme a usage unique, dont `su`
 *   a deja depile son propre contexte, ne restaurait plus personne.
 *
 * H-04 — `-m conntrack --ctstate ESTABLISHED,RELATED` N'APPLIQUAIT RIEN
 *   AUX FLUX SORTANTS. Le suivi de connexion n'etait alimente que pour
 *   `in` et `forward` : rien de ce que la machine INITIE n'etait suivi,
 *   donc la reponse ne pouvait jamais correspondre. La paire
 *   `-P INPUT DROP` + `ESTABLISHED,RELATED ACCEPT` — le patron d'un
 *   pare-feu a etats, celui qu'on ecrit sur toutes les machines —
 *   coupait la machine au lieu de la proteger.
 *
 * H-05 — LE TUPLE DE SUIVI IGNORAIT LE TYPE ICMP.
 *   Avec ports a 0 des deux cotes, un echo-REQUEST entrant et un
 *   echo-REPLY entrant avaient la MEME clef : un ping accepte rendait
 *   ESTABLISHED tout ping ulterieur. Le defaut preexistait par le suivi
 *   entrant, et la correction H-04 l'aurait elargi aux flux sortants.
 *   Le tuple porte desormais le type, avec la correspondance
 *   requete → reponse (RFC 792 et RFC 4443), en reutilisant
 *   `icmpTypeNumber`/`icmpv6TypeNumber` deja presents.
 *
 * Discrimination : 10 cas sur 19 tombent sous `git stash push -- src/network`.
 * Les neuf autres, et pourquoi ils passent des deux cotes :
 *
 *   - << sudo -n ls /tmp >> (le nom nu) : c'etait la seule des trois
 *     ecritures qui passait deja, parce que l'appelant resolvait le nom
 *     nu vers `/bin/ls`. Non-regression : la correction ne doit pas
 *     casser la forme qui marchait.
 *   - << une commande hors de la liste reste refusee >> : la restriction
 *     par commande appliquait deja. C'est le garde-fou de H-02 — elargir
 *     la correspondance des chemins ne doit pas tout ouvrir.
 *   - << un compte absent de sudoers >>, << `sudo <cmd>` ordinaire rend
 *     la session >>, << `ls /etc/ssh` lisible de tous >>, << `ls -ld`
 *     decrit sans ouvrir >>, << sans durcissement tout passe >>,
 *     << un port autorise passe pendant DROP >> : six TEMOINS. Aucun ne
 *     mesure une correction ; chacun garde qu'une correction n'a pas
 *     deborde, et sans eux les cas qui refusent ne distingueraient pas
 *     << la regle applique >> de << plus rien ne passe >>.
 *   - << sans la regle d'etat, la reponse est jetee >> : sur la base,
 *     TOUT etait jete, donc ce cas avait raison par accident. Il garde
 *     desormais que H-04 n'a pas rendu la politique DROP inoperante.
 *
 * Piege du labo, paye comptant et donc ecrit ici : sur un `LinuxPC` la
 * session est `user` (uid 1000), donc `iptables` sans `sudo` rend
 * << Permission denied >> — une premiere version du banc mesurait ainsi
 * l'absence de pare-feu en croyant mesurer le pare-feu.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../support/fastPing';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function sh(
  d: { executeCommand(c: string): Promise<string> }, lignes: string[],
): Promise<string> {
  let out = '';
  for (const c of lignes) out = await d.executeCommand(c);
  return out;
}

const perte = async (d: LinuxPC, ip: string): Promise<number> => {
  const sortie = await pingOnSimulatedClock(d, `ping -c 2 ${ip}`);
  const m = sortie.match(/(\d+)% packet loss/);
  return m ? Number(m[1]) : -1;
};

describe('H-01 — `ls` et le droit de lecture du repertoire', () => {
  async function poste() {
    const pc = new LinuxPC('linux-pc', 'POSTE', 0, 0);
    pc.powerOn();
    await sh(pc, ['sudo useradd -m quidam']);
    return pc;
  }

  it('un repertoire en mode 700 ne se laisse pas lister par un autre compte', async () => {
    const pc = await poste();
    expect(await pc.executeCommand('sudo su quidam -c "ls /root"'))
      .toMatch(/ls: cannot open directory '\/root': Permission denied/);
  });

  it('`ls -l` ne contourne pas la regle que `ls` applique', async () => {
    const pc = await poste();
    expect(await pc.executeCommand('sudo su quidam -c "ls -la /root"'))
      .toMatch(/Permission denied/);
  });

  it('un repertoire Oracle en 750 protege ses fichiers de donnees', async () => {
    const srv = new LinuxServer('linux-server', 'DB', 0, 0);
    srv.powerOn();
    await sh(srv, [
      'groupadd oinstall', 'useradd -m -g oinstall oracle', 'useradd -m intrus',
      'mkdir -p /u01/app/oracle/oradata/ORCL',
      'echo DONNEES > /u01/app/oracle/oradata/ORCL/system01.dbf',
      'chown -R oracle:oinstall /u01/app/oracle',
      'chmod 750 /u01/app/oracle/oradata/ORCL',
      'chmod 640 /u01/app/oracle/oradata/ORCL/system01.dbf',
    ]);
    expect(await srv.executeCommand('su intrus -c "ls /u01/app/oracle/oradata/ORCL"'))
      .toMatch(/Permission denied/);
    expect(await srv.executeCommand(
      'su intrus -c "cat /u01/app/oracle/oradata/ORCL/system01.dbf"'))
      .toMatch(/Permission denied/);
    expect((await srv.executeCommand(
      'su oracle -c "cat /u01/app/oracle/oradata/ORCL/system01.dbf"')).trim())
      .toBe('DONNEES');
  });

  it('TEMOIN — un repertoire lisible de tous reste listable', async () => {
    const pc = await poste();
    expect(await pc.executeCommand('sudo su quidam -c "ls /etc/ssh"'))
      .toMatch(/sshd_config/);
  });

  it('TEMOIN — `ls -d` decrit le repertoire sans l ouvrir, donc reste permis', async () => {
    const pc = await poste();
    expect(await pc.executeCommand('sudo su quidam -c "ls -ld /root"'))
      .toMatch(/^drwx------/);
  });
});

describe('H-02 / H-03 — `sudo` : ce que la ligne nomme, et ce qu elle rend', () => {
  async function posteSudo() {
    const pc = new LinuxPC('linux-pc', 'POSTE', 0, 0);
    pc.powerOn();
    await sh(pc, [
      'sudo useradd -m operateur',
      'sudo useradd -m sanssudo',
      `sudo sh -c 'echo "operateur ALL=(ALL) NOPASSWD: /bin/ls" >> /etc/sudoers'`,
    ]);
    return pc;
  }

  it.each(['/bin/ls /tmp', '/usr/bin/ls /tmp', 'ls /tmp'])(
    'les trois ecritures d un meme fichier sont permises : sudo -n %s', async (forme) => {
      const pc = await posteSudo();
      expect(await pc.executeCommand(`sudo su operateur -c "sudo -n ${forme}"`))
        .not.toMatch(/not allowed to execute/);
    });

  it('une commande hors de la liste reste refusee', async () => {
    const pc = await posteSudo();
    expect(await pc.executeCommand('sudo su operateur -c "sudo -n cat /etc/shadow"'))
      .toMatch(/is not allowed to execute 'cat \/etc\/shadow' as root/);
  });

  it('TEMOIN — un compte absent de sudoers est refuse avant toute question de chemin', async () => {
    const pc = await posteSudo();
    expect(await pc.executeCommand('sudo su sanssudo -c "sudo -n ls /tmp"'))
      .toMatch(/is not in the sudoers file/);
  });

  it('un `su` a usage unique rend la session a son invocateur', async () => {
    const pc = await posteSudo();
    expect((await pc.executeCommand('id -u')).trim()).toBe('1000');
    expect((await pc.executeCommand('sudo su operateur -c "id -u"')).trim()).not.toBe('0');
    expect((await pc.executeCommand('id -u')).trim()).toBe('1000');
  });

  it('la session rendue est bien DESELEVEE, pas seulement renommee', async () => {
    const pc = await posteSudo();
    await pc.executeCommand('sudo su operateur -c "id -u"');
    expect(await pc.executeCommand('ls /root')).toMatch(/Permission denied/);
  });

  it('TEMOIN — `sudo <cmd>` ordinaire rendait deja la session, et la rend toujours', async () => {
    const pc = await posteSudo();
    await pc.executeCommand('sudo ls /tmp');
    expect((await pc.executeCommand('id -u')).trim()).toBe('1000');
  });
});

describe('H-04 / H-05 — le pare-feu a etats', () => {
  async function labDurci(avecRegleEtat: boolean) {
    const client = new LinuxPC('linux-pc', 'CLIENT', -150, 0);
    const serveur = new LinuxServer('linux-server', 'SERVEUR', 150, 0);
    client.powerOn(); serveur.powerOn();
    new Cable('lan').connect(client.getPort('eth0')!, serveur.getPort('eth0')!);
    await sh(client, ['ip addr add 10.0.0.10/24 dev eth0', 'ip link set eth0 up']);
    await sh(serveur, ['ip addr add 10.0.0.20/24 dev eth0', 'ip link set eth0 up']);
    if (avecRegleEtat) {
      await sh(client, ['sudo iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT']);
    }
    await sh(client, ['sudo iptables -P INPUT DROP']);
    return { client, serveur };
  }

  it('la reponse a un flux SORTANT revient quand la regle d etat est posee', async () => {
    const { client } = await labDurci(true);
    expect(await perte(client, '10.0.0.20')).toBe(0);
  }, 30000);

  it('sans la regle d etat, la meme reponse est jetee', async () => {
    const { client } = await labDurci(false);
    expect(await perte(client, '10.0.0.20')).toBe(100);
  }, 30000);

  it('la regle d etat n ouvre PAS la machine : un flux entrant neuf reste jete', async () => {
    const { client, serveur } = await labDurci(true);
    expect(await perte(client, '10.0.0.20')).toBe(0);
    expect(await perte(serveur as unknown as LinuxPC, '10.0.0.10')).toBe(100);
  }, 30000);

  it('un echo-request ENTRANT accepte ne rend pas les suivants ESTABLISHED', async () => {
    const client = new LinuxPC('linux-pc', 'CLIENT', -150, 0);
    const serveur = new LinuxServer('linux-server', 'SERVEUR', 150, 0);
    client.powerOn(); serveur.powerOn();
    new Cable('lan2').connect(client.getPort('eth0')!, serveur.getPort('eth0')!);
    await sh(client, ['ip addr add 10.0.0.10/24 dev eth0', 'ip link set eth0 up']);
    await sh(serveur, ['ip addr add 10.0.0.20/24 dev eth0', 'ip link set eth0 up']);
    await sh(client, ['sudo iptables -A INPUT -p icmp -j ACCEPT']);
    expect(await perte(serveur as unknown as LinuxPC, '10.0.0.10')).toBe(0);

    await sh(client, [
      'sudo iptables -F INPUT',
      'sudo iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
      'sudo iptables -P INPUT DROP',
    ]);
    expect(await perte(serveur as unknown as LinuxPC, '10.0.0.10')).toBe(100);
  }, 30000);

  it('TEMOIN — sans aucun durcissement, tout passe dans les deux sens', async () => {
    const client = new LinuxPC('linux-pc', 'CLIENT', -150, 0);
    const serveur = new LinuxServer('linux-server', 'SERVEUR', 150, 0);
    client.powerOn(); serveur.powerOn();
    new Cable('lan3').connect(client.getPort('eth0')!, serveur.getPort('eth0')!);
    await sh(client, ['ip addr add 10.0.0.10/24 dev eth0', 'ip link set eth0 up']);
    await sh(serveur, ['ip addr add 10.0.0.20/24 dev eth0', 'ip link set eth0 up']);
    expect(await perte(client, '10.0.0.20')).toBe(0);
    expect(await perte(serveur as unknown as LinuxPC, '10.0.0.10')).toBe(0);
  }, 30000);

  it('TEMOIN — un port explicitement autorise passe pendant que la politique est DROP', async () => {
    const client = new LinuxPC('linux-pc', 'CLIENT', -150, 0);
    const serveur = new LinuxServer('linux-server', 'SERVEUR', 150, 0);
    client.powerOn(); serveur.powerOn();
    new Cable('lan4').connect(client.getPort('eth0')!, serveur.getPort('eth0')!);
    await sh(client, ['ip addr add 10.0.0.10/24 dev eth0', 'ip link set eth0 up']);
    await sh(serveur, ['ip addr add 10.0.0.20/24 dev eth0', 'ip link set eth0 up',
      'systemctl start ssh', 'systemctl start nginx',
      'iptables -A INPUT -p tcp --dport 22 -j ACCEPT', 'iptables -P INPUT DROP']);
    expect(await client.executeCommand('nc -zv 10.0.0.20 22')).toMatch(/succeeded/);
    expect(await client.executeCommand('nc -zv 10.0.0.20 80')).toMatch(/failed/);
  }, 30000);
});
