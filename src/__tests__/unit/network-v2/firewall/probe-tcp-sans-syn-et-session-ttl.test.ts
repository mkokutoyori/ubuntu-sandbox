/**
 * Le delai d'une session se decide a TROIS endroits, et la creation
 * d'une session sans SYN a DEUX.
 *
 * **`tcp-session-without-syn` etait accepte, rendu, et evalue par
 * personne.** L'attribut est declare sur `firewall policy`, range sur la
 * regle et rendu par `show firewall policy 1` — donc rejoue a l'import
 * d'une topologie — et rien ne le lisait. Il ne POUVAIT pas etre lu :
 * l'etage qui refuse un paquet hors etat est `tcp-state-check`, septieme
 * de la chaine, tandis que la politique n'est connue qu'au dix-septieme,
 * `policy-lookup`.
 *
 * **Le verdict n'est differe que lorsque le reglage GLOBAL l'autorise**,
 * et c'est la mesure qui l'a impose : differer inconditionnellement fait
 * traverser au paquet hors etat la recherche de route puis la politique
 * avant d'etre jete, ce qui change le trace de `diagnose debug flow` —
 * deux cas preexistants sont tombes, dont un tutoriel qui compare la
 * sortie a celle d'une vraie machine, ou le rejet precede toute ligne de
 * route. Le reglage global ne depend pas de la politique, donc il se lit
 * a `tcp-state-check` : par defaut le refus reste exactement ou il
 * etait, et ce n'est qu'une fois le commutateur global ouvert que la
 * politique a son mot a dire, au dix-septieme etage, ou le refus NOMME
 * desormais la politique.
 *
 * **La regle est une CONJONCTION, pas une surcharge**, et c'est le point
 * qu'il ne fallait pas rater : la documentation de Fortinet dit que le
 * reglage global seul ne suffit pas — la politique qui correspond doit
 * elle aussi porter `all` ou `data-only` —, et reciproquement la
 * politique seule ne suffit pas. Modeliser une surcharge aurait fait
 * accepter un paquet hors etat sur un pare-feu ou l'administrateur n'a
 * touche qu'a la politique, c'est-a-dire ouvrir ce que le reglage global
 * existe pour tenir ferme.
 *
 * **`config system settings tcp-session-without-syn` n'existait pas**,
 * alors que c'est la moitie globale de cette conjonction. Il est de
 * portee VDOM, comme la reference le declare et comme le reste de cet
 * objet, et sa valeur d'usine vient de `FirewallProfile.tcpSynCheckDefault`
 * — declare sur DEUX profils et lu par personne jusqu'ici.
 *
 * **`all` et `data-only` ne different PAS a l'acheminement**, et c'est
 * ecrit ici plutot qu'invente : la documentation de Fortinet decrit les
 * deux comme creant une session pour tout paquet TCP quel que soit son
 * drapeau. Une premiere version distinguait les deux en regardant si le
 * segment portait des donnees — plausible, et contredit par la machine
 * reelle. Les deux valeurs restent distinctes dans la CLI parce que la
 * reference les declare, et le simulateur ne leur prete pas un
 * comportement que le materiel n'a pas.
 *
 * **`session-ttl` par politique** (`sessionTimeoutOverrideSec`) etait
 * declare sur `SecurityRule`, rempli par la validation de la politique,
 * et lu par personne : une session heritait toujours du delai par
 * protocole. Il est desormais lu a l'installation.
 *
 * **`session-ttl` sur un service personnalise n'existait pas**, et la
 * reference 6.0.4 en donne la precedence mot pour mot : « Enter 0 to use
 * either the per-policy session-ttl or per-VDOM session-ttl, as
 * applicable » — donc le service PRIME sur la politique, qui prime sur le
 * VDOM. Sa borne est celle de la reference (0, ou 300 a 604800) ; une
 * valeur entre 1 et 299 est refusee au lieu d'etre rangee sans etre lue.
 * La faire remonter a demande que le moteur de politique dise QUEL
 * service a correspondu : `ObjectStore.matchesAnyService` rendait un
 * booleen, il rend maintenant l'objet, et le predicat booleen est ecrit
 * PAR-DESSUS lui plutot qu'a cote — deux parcours du meme arbre de
 * groupes finiraient par diverger.
 *
 * Discrimine par `git stash push -- src/network/` : 8 des 15 cas
 * tombent. Les 7 restants sont nommes ici plutot que laisses a
 * decouvrir :
 *
 *   - « le laboratoire relaie vraiment » est le TEMOIN, et c'est son
 *     objet de passer des deux cotes ;
 *   - « sans reglage, le delai reste celui du protocole » est le garde
 *     du chemin qui etait deja juste ;
 *   - « session-ttl sur la politique est rendu par la configuration »
 *     passait deja, et c'est precisement l'enonce du defaut : la
 *     commande etait acceptee et rendue, donc rejouee a l'import, et
 *     n'etait lue par personne — le cas garde la moitie qui marchait,
 *     son jumeau « gouverne la session installee » porte la mesure ;
 *   - « le reglage global seul ne suffit pas », « la politique seule ne
 *     suffit pas » et « sans le reglage global, le refus reste a
 *     tcp-state-check » passaient avant pour une raison qui ne prouve
 *     rien du mecanisme : le paquet hors etat etait refuse de toute
 *     facon, six etages plus tot, par un controle que rien ne pouvait
 *     lever — le dernier des trois est justement la garde qui exige que
 *     ce chemin-la n'ait pas bouge ;
 *   - « un SYN passe toujours » garde que differer le verdict n'a pas
 *     ouvert le cas nominal.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function runOn(device: Cmd, ...commands: string[]): Promise<string> {
  let last = '';
  for (const command of commands) last = await device.executeCommand(command);
  return last;
}

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

async function laboratoire() {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell() as FortiShell;
  const a = new LinuxPC('linux-pc', 'A', 200, 0);
  const b = new LinuxPC('linux-pc', 'B', -200, 0);
  a.powerOn();
  b.powerOn();
  new Cable('c1').connect(fw.getPort('port1')!, a.getPorts()[0]);
  new Cable('c2').connect(fw.getPort('port2')!, b.getPorts()[0]);

  run(sh, 'config system interface',
    'edit "port1"', 'set mode static', 'set ip 10.1.1.1 255.255.255.0',
    'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static', 'set ip 10.2.2.1 255.255.255.0',
    'set allowaccess ping', 'next', 'end',
    'config firewall policy', 'edit 1',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'next', 'end');

  await runOn(a, 'ip link set eth0 up', 'ip addr add 10.1.1.10/24 dev eth0',
    'ip route add default via 10.1.1.1');
  await runOn(b, 'ip link set eth0 up', 'ip addr add 10.2.2.10/24 dev eth0',
    'ip route add default via 10.2.2.1');

  return { fw, sh, a, b };
}

function udp(a: LinuxPC, port = 5353): void {
  a.sendUdpDatagram(new IPAddress('10.2.2.10'), port, 40000, { kind: 'probe' });
}

function delais(fw: FortiGate): number[] {
  return fw.getSessionTable().view().all()
    .filter(session => session.state !== 'discard')
    .map(session => session.timeoutSec);
}

const FLUX = {
  ingressPort: 'port1', protocol: 'tcp' as const,
  sourceIP: '10.1.1.10', destinationIP: '10.2.2.10',
  sourcePort: 40100, destinationPort: 80,
};

describe('le delai de session et la creation sans SYN', () => {
  it('le laboratoire relaie vraiment', async () => {
    const { fw, a } = await laboratoire();
    udp(a);

    expect(delais(fw)).toHaveLength(1);
  });

  it('sans reglage, le delai reste celui du protocole', async () => {
    const { fw, a } = await laboratoire();
    udp(a);

    expect(delais(fw)).toEqual([180]);
  });

  it('session-ttl sur la politique gouverne la session installee', async () => {
    const { fw, sh, a } = await laboratoire();
    run(sh, 'config firewall policy', 'edit 1', 'set session-ttl 7200',
      'next', 'end');
    udp(a);

    expect(delais(fw)).toEqual([7200]);
  });

  it('session-ttl sur la politique est rendu par la configuration', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config firewall policy', 'edit 1', 'set session-ttl 7200',
      'next', 'end');

    expect(sh.execute('show firewall policy 1')).toContain('set session-ttl 7200');
  });

  it('session-ttl sur le service prime sur celui de la politique', async () => {
    const { fw, sh, a } = await laboratoire();
    run(sh, 'config firewall service custom', 'edit "MONSERVICE"',
      'set udp-portrange 5353', 'set session-ttl 900', 'next', 'end',
      'config firewall policy', 'edit 1', 'set service "MONSERVICE"',
      'set session-ttl 7200', 'next', 'end');
    udp(a);

    expect(delais(fw)).toEqual([900]);
  });

  it('session-ttl sur le service est rendu par la configuration', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config firewall service custom', 'edit "MONSERVICE"',
      'set udp-portrange 5353', 'set session-ttl 900', 'next', 'end');

    expect(sh.execute('show firewall service custom MONSERVICE'))
      .toContain('set session-ttl 900');
  });

  it('un session-ttl de service sous la borne attestee est refuse', async () => {
    const { sh } = await laboratoire();
    const refus = run(sh, 'config firewall service custom', 'edit "MONSERVICE"',
      'set udp-portrange 5353', 'set session-ttl 100', 'next', 'end');

    expect(refus).toContain('300');
    expect(refus).toMatch(/Command fail/);
  });

  it('config system settings accepte et rend tcp-session-without-syn', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config system settings', 'set tcp-session-without-syn enable', 'end');

    expect(sh.execute('show system settings'))
      .toContain('set tcp-session-without-syn enable');
  });

  it('le reglage global seul ne suffit pas', async () => {
    const { fw, sh } = await laboratoire();
    run(sh, 'config system settings', 'set tcp-session-without-syn enable', 'end');

    expect(fw.simulate({ ...FLUX, ackOnly: true }).allowed).toBe(false);
  });

  it('la politique seule ne suffit pas', async () => {
    const { fw, sh } = await laboratoire();
    run(sh, 'config firewall policy', 'edit 1',
      'set tcp-session-without-syn all', 'next', 'end');

    expect(fw.simulate({ ...FLUX, ackOnly: true }).allowed).toBe(false);
  });

  it('le reglage global et la politique ensemble acceptent le hors etat', async () => {
    const { fw, sh } = await laboratoire();
    run(sh, 'config system settings', 'set tcp-session-without-syn enable', 'end',
      'config firewall policy', 'edit 1',
      'set tcp-session-without-syn all', 'next', 'end');

    expect(fw.simulate({ ...FLUX, ackOnly: true }).allowed).toBe(true);
  });

  it('data-only accepte comme all, la machine reelle ne les distinguant pas', async () => {
    const { fw, sh } = await laboratoire();
    run(sh, 'config system settings', 'set tcp-session-without-syn enable', 'end',
      'config firewall policy', 'edit 1',
      'set tcp-session-without-syn data-only', 'next', 'end');

    expect(fw.simulate({ ...FLUX, ackOnly: true }).allowed).toBe(true);
  });

  it('sans le reglage global, le refus reste a tcp-state-check', async () => {
    const { fw } = await laboratoire();
    const verdict = fw.simulate({ ...FLUX, ackOnly: true }).verdict;

    expect(verdict?.reason).toBe('no-session-non-syn');
    expect(verdict?.stage).toBe('tcp-state-check');
  });

  it('sous le reglage global, le refus vient de policy-lookup et nomme la politique',
    async () => {
      const { fw, sh } = await laboratoire();
      run(sh, 'config system settings',
        'set tcp-session-without-syn enable', 'end');
      const verdict = fw.simulate({ ...FLUX, ackOnly: true }).verdict;

      expect(verdict?.reason).toBe('no-session-non-syn');
      expect(verdict?.stage).toBe('policy-lookup');
      expect(verdict?.ruleId).toBe('1');
    });

  it('un SYN passe toujours', async () => {
    const { fw } = await laboratoire();

    expect(fw.simulate(FLUX).allowed).toBe(true);
  });
});
