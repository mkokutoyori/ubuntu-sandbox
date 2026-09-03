/**
 * `execute ha disconnect` sort une unite de la grappe pour de vrai, et
 * `execute ha set-priority` change la priorite de la bonne unite.
 *
 * `executeHa` ne servait que `failover set`, `manage` et `synchronize` ;
 * les deux autres formes de la reference repondaient « unknown path ».
 * Toute la matiere etait la : l'agent FGCP echange deja des requetes
 * authentifiees par identifiant, nom et condense du mot de passe du
 * groupe, et il sait les servir a distance.
 *
 * La demande voyage par un NOUVEAU genre de requete FGCP plutot que par
 * le genre `cli` qui existait, et c'est mesure et non stylistique : `cli`
 * exige un jeton obtenu par `execute ha manage`, c'est-a-dire un mot de
 * passe d'administrateur, alors qu'un vrai `execute ha disconnect` ne
 * demande rien — les membres d'une grappe se font deja confiance sur le
 * lien de battement, que `serveCommand` authentifie avant toute chose.
 *
 * Ce que fait la commande est celui que la reference decrit, et chaque
 * moitie est observee : le mode HA de l'unite nommee passe a
 * `standalone`, TOUTES ses adresses d'interface tombent a `0.0.0.0`,
 * l'interface nommee prend l'adresse et le masque donnes, et tout acces
 * de gestion y est ouvert. La grappe reagit ensuite comme a une panne.
 *
 * `set-priority` designe l'unite par son NUMERO DE SERIE, pas par un
 * index de grappe : deux commandes voisines et deux facons de nommer,
 * c'est la reference qui le dit, et se tromper viserait une autre unite.
 *
 * Discrimine par `git stash push` : 8 des 10 cas tombent. Les 2 autres
 * sont nommes ici — « les deux unites forment bien une grappe » est le
 * TEMOIN du laboratoire, dont c'est l'objet de passer des deux cotes, et
 * « une unite hors grappe refuse les deux commandes » passait avant parce
 * que `executeHa` refusait deja tout sur une machine autonome ; il ne
 * garde que le message.
 *
 * Trouve en l'ecrivant : `allowaccess` pose par la commande n'apparait
 * PAS dans `show system interface`, la configuration rendue venant du
 * magasin d'objets FortiOS que le schema tient, et non de l'equipement.
 * L'observable est donc l'acces reellement ouvert, `allowedAccessOn`, et
 * c'est ce que la sonde regarde. La limite est ecrite plutot que
 * contournee : une commande `execute` qui change l'etat ne reecrit pas la
 * configuration, sur ce simulateur comme sur un vrai FortiGate ou
 * `set-priority` est explicitement TEMPORAIRE.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

interface Membre { fw: FortiGate; sh: FortiShell }

function membre(nom: string, lan: string): Membre {
  const fw = new FortiGate('firewall-fortinet', nom, 0, 0);
  const sh = new FortiShell(fw);
  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    `set ip ${lan} 255.255.255.0`, 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 203.0.113.1 255.255.255.0', 'next', 'end');
  return { fw, sh };
}

function grappe(m: Membre, priorite: number): void {
  run(m.sh,
    'config system ha',
    'set group-name "cluster-paris"',
    'set group-id 10',
    'set mode a-p',
    'set password "SecretHA"',
    'set hbdev "port7" 50',
    `set priority ${priorite}`,
    'set monitor "port1" "port2"',
    'end');
}

function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const a = membre('FGT-A', '192.168.1.1');
  const b = membre('FGT-B', '192.168.1.2');
  new Cable('hb').connect(a.fw.getPort('port7')!, b.fw.getPort('port7')!);
  grappe(a, 200);
  grappe(b, 128);
  for (let tour = 0; tour < 3; tour++) { a.fw.getHa().tick(); b.fw.getHa().tick(); }
  return { a, b };
}

function adresse(m: Membre, iface: string): string {
  return m.fw.getInterfaceTable().get(iface)?.ip ?? '';
}

beforeEach(() => { Logger.reset(); });

describe('execute ha disconnect', () => {
  it('TEMOIN : les deux unites forment bien une grappe', () => {
    const { a, b } = laboratoire();

    expect(a.fw.getHa().role()).toBe('master');
    expect(b.fw.getHa().role()).toBe('slave');
  });

  it('l\'unite nommee repasse en standalone', () => {
    const { a, b } = laboratoire();

    expect(a.sh.execute(
      `execute ha disconnect ${b.fw.serialNumber()} port1 10.9.9.9 255.255.255.0`))
      .not.toMatch(/unknown path|Command fail/i);
    expect(b.fw.getHa().getConfiguration().mode).toBe('standalone');
  });

  it('l\'interface nommee prend l\'adresse donnee, les autres tombent a zero', () => {
    const { a, b } = laboratoire();

    a.sh.execute(
      `execute ha disconnect ${b.fw.serialNumber()} port1 10.9.9.9 255.255.255.0`);

    expect(adresse(b, 'port1')).toBe('10.9.9.9');
    expect(adresse(b, 'port2')).toBe('0.0.0.0');
  });

  it('tout acces de gestion est ouvert sur l\'interface nommee', () => {
    const { a, b } = laboratoire();

    a.sh.execute(
      `execute ha disconnect ${b.fw.serialNumber()} port1 10.9.9.9 255.255.255.0`);

    const ouverts = b.fw.allowedAccessOn('port1');
    for (const service of ['ping', 'https', 'http', 'ssh', 'telnet', 'snmp']) {
      expect(ouverts).toContain(service);
    }
    expect(b.fw.allowedAccessOn('port2')).toEqual([]);
  });

  it('l\'unite qui tape la commande peut se deconnecter elle-meme', () => {
    const { a } = laboratoire();

    a.sh.execute(
      `execute ha disconnect ${a.fw.serialNumber()} port1 10.8.8.8 255.255.255.0`);

    expect(a.fw.getHa().getConfiguration().mode).toBe('standalone');
    expect(adresse(a, 'port1')).toBe('10.8.8.8');
  });

  it('un numero de serie inconnu est refuse', () => {
    const { a, b } = laboratoire();

    expect(a.sh.execute('execute ha disconnect FGVMEV0000000000 port1 10.9.9.9 255.255.255.0'))
      .toContain('no cluster member FGVMEV0000000000.');
    expect(b.fw.getHa().getConfiguration().mode).toBe('a-p');
  });

  it('une commande incomplete est refusee', () => {
    const { a, b } = laboratoire();

    expect(a.sh.execute(`execute ha disconnect ${b.fw.serialNumber()} port1`))
      .toMatch(/netmask/i);
    expect(b.fw.getHa().getConfiguration().mode).toBe('a-p');
  });
});

describe('execute ha set-priority', () => {
  it('change la priorite de l\'unite nommee', () => {
    const { a, b } = laboratoire();

    expect(a.sh.execute(`execute ha set-priority ${b.fw.serialNumber()} 250`))
      .not.toMatch(/unknown path|Command fail/i);
    expect(b.fw.getHa().getConfiguration().priority).toBe(250);
    expect(a.fw.getHa().getConfiguration().priority).toBe(200);
  });

  it('une priorite hors plage est refusee', () => {
    const { a, b } = laboratoire();

    expect(a.sh.execute(`execute ha set-priority ${b.fw.serialNumber()} 300`))
      .toMatch(/between 0 and 255/);
    expect(b.fw.getHa().getConfiguration().priority).toBe(128);
  });

  it('une unite hors grappe refuse les deux commandes', () => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    const seul = membre('FGT-SEUL', '192.168.5.1');

    expect(seul.sh.execute('execute ha set-priority FGVMEV0000000000 10'))
      .toContain('this unit is not part of a cluster.');
  });
});
