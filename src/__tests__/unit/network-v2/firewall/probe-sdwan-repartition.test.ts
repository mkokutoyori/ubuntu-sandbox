/**
 * `set mode load-balance` ne repartissait RIEN.
 *
 * Le mode existe dans le type `SdwanServiceMode`, il est declare dans le
 * schema avec la description « Spread across members. », il est accepte
 * et rendu par `show system sdwan` — et `ruleMember` prenait le PREMIER
 * membre eligible quel que soit le mode, exactement comme pour `auto`,
 * `manual`, `priority` et `sla`. Une regle qui promet de repartir
 * envoyait tout par un seul lien, en silence.
 *
 * **`load-balance-mode` etait le lecteur qui manquait**, et il etait
 * lui aussi accepte, rendu et lu par personne. Les deux defauts n'en
 * font qu'un : le mode de service dit QUAND repartir, le mode global dit
 * COMMENT, et aucun des deux ne servait a rien sans l'autre.
 *
 * **La repartition est de portee SESSION et non paquet**, ce qui n'est
 * pas une simplification mais la lecture de l'etage : `sdwanRuleStage`
 * sort par son garde `context.egressPort !== undefined` des que la
 * recherche de session a deja fixe la sortie, donc l'aiguillage ne
 * s'execute que sur le PREMIER paquet d'un flux. C'est ce qui rend un
 * choix par condense legitime : il n'y a pas d'etat mutable a tenir, et
 * « tout le trafic d'une meme adresse source part par la meme
 * interface » — la phrase exacte de la documentation — tombe alors tout
 * seul.
 *
 * **Les poids viennent de la reference 6.0.4** : `weight` (0-255,
 * « More traffic is directed to interfaces with higher weights ») et
 * `volume-ratio` (0-255) etaient tous deux ABSENTS du schema, donc la
 * moitie des modes n'avait aucune valeur a lire. `measured-volume-based`
 * manquait aussi dans la liste des modes.
 *
 * **Un defaut trouve par la MESURE et non par la relecture** : la
 * premiere version du condense (`digest * 31 + code`) donnait 199 flux
 * sur 200 au membre de poids 9 pour un rapport 9:1, parce que des
 * adresses sources sequentielles laissent les bits de poids faible
 * correles et que le choix se fait justement par un modulo. Un melange
 * final (celui de Murmur3) rend la proportion exacte — 180/20 mesures
 * sur 200 flux — sans rien perdre du determinisme, qui est ce qui rend
 * un simulateur pedagogique interpretable.
 *
 * **Ce que le simulateur ne sait pas evaluer est REFUSE en nommant la
 * brique qui manque** : `usage-based` et `spillover-threshold` decident
 * sur un DEBIT, et ce simulateur livre ses trames de facon synchrone
 * sous une horloge virtuelle — aucun debit n'y est mesurable, la meme
 * limite que le seuil haut de la CAR Cisco et que le RTT d'IP SLA.
 *
 * Discrimine par `git stash push -- src/network/` : 7 des 11 cas
 * tombent. Les 4 restants sont nommes ici plutot que laisses a
 * decouvrir :
 *
 *   - « le laboratoire aiguille vraiment » est le TEMOIN, et c'est son
 *     objet de passer des deux cotes : sans lui, une repartition
 *     absente et un aiguillage casse seraient indiscernables ;
 *   - « une meme adresse source sort toujours par le meme membre »
 *     passait par VACUITE, tous les flux sortant par le premier membre ;
 *     il vaut desormais pour l'affinite ;
 *   - « un autre mode de service prend le premier membre, sans
 *     repartir » et « un membre desactive sort de la repartition » sont
 *     les deux GARDES de non-regression, et leur role est justement de
 *     passer des deux cotes : ils exigent que la repartition n'ait pas
 *     debordé sur les quatre autres modes ni sur le filtre d'eligibilite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

interface LabOptions {
  readonly mode?: string;
  readonly serviceMode?: string;
  readonly premier?: readonly string[];
  readonly second?: readonly string[];
}

function laboratoire(options: LabOptions = {}) {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell() as FortiShell;

  run(sh, 'config system interface',
    'edit "port1"', 'set mode static', 'set ip 10.1.1.1 255.255.255.0', 'next',
    'edit "port2"', 'set mode static', 'set ip 10.2.2.1 255.255.255.0', 'next',
    'edit "port3"', 'set mode static', 'set ip 10.3.3.1 255.255.255.0', 'next', 'end',
    'config system sdwan', 'set status enable',
    `set load-balance-mode ${options.mode ?? 'source-ip-based'}`,
    'config members',
    'edit 1', 'set interface "port2"', 'set gateway 10.2.2.254',
    ...(options.premier ?? []), 'next',
    'edit 2', 'set interface "port3"', 'set gateway 10.3.3.254',
    ...(options.second ?? []), 'next',
    'end',
    'config service', 'edit 1', 'set name "LB"',
    `set mode ${options.serviceMode ?? 'load-balance'}`,
    'set dst "all"', 'set priority-members 1 2', 'next', 'end', 'end');

  return { fw, sh };
}

function sortie(fw: FortiGate, source: string, destination = '8.8.8.8'): string {
  return fw.simulate({
    ingressPort: 'port1', protocol: 'tcp',
    sourceIP: source, destinationIP: destination,
    sourcePort: 40000, destinationPort: 80,
  }).egressPort ?? 'aucune';
}

function repartition(
  fw: FortiGate, flux = 200, destination = '8.8.8.8',
): Record<string, number> {
  const vues: Record<string, number> = {};
  for (let index = 0; index < flux; index++) {
    const port = sortie(fw, `10.1.${Math.floor(index / 250)}.${index % 250}`, destination);
    vues[port] = (vues[port] ?? 0) + 1;
  }
  return vues;
}

describe('la repartition SD-WAN', () => {
  it('le laboratoire aiguille vraiment', () => {
    const { fw } = laboratoire();

    expect(['port2', 'port3']).toContain(sortie(fw, '10.1.1.10'));
  });

  it('la configuration est acceptee et rendue', () => {
    const { sh } = laboratoire({ mode: 'weight-based', premier: ['set weight 9'] });
    const rendu = sh.execute('show system sdwan');

    expect(rendu).toContain('set load-balance-mode weight-based');
    expect(rendu).toContain('set weight 9');
  });

  it('source-ip-based repartit les flux entre les deux membres', () => {
    const { fw } = laboratoire();
    const vues = repartition(fw);

    expect(vues.port2).toBeGreaterThan(0);
    expect(vues.port3).toBeGreaterThan(0);
  });

  it('une meme adresse source sort toujours par le meme membre', () => {
    const { fw } = laboratoire();
    const premier = sortie(fw, '10.1.1.10');

    expect(sortie(fw, '10.1.1.10')).toBe(premier);
    expect(sortie(fw, '10.1.1.10', '9.9.9.9')).toBe(premier);
  });

  it('source-dest-ip-based tient compte de la destination', () => {
    const { fw } = laboratoire({ mode: 'source-dest-ip-based' });
    const vues = new Set<string>();
    for (let index = 0; index < 20; index++) {
      vues.add(sortie(fw, '10.1.1.10', `8.8.8.${index}`));
    }

    expect(vues.size).toBe(2);
  });

  it('weight-based suit la proportion des poids', () => {
    const { fw } = laboratoire({
      mode: 'weight-based', premier: ['set weight 1'], second: ['set weight 9'],
    });
    const vues = repartition(fw);

    expect(vues.port3).toBeGreaterThan(vues.port2 * 3);
  });

  it('measured-volume-based lit volume-ratio et non weight', () => {
    const { fw } = laboratoire({
      mode: 'measured-volume-based',
      premier: ['set weight 9', 'set volume-ratio 1'],
      second: ['set weight 1', 'set volume-ratio 9'],
    });
    const vues = repartition(fw);

    expect(vues.port3).toBeGreaterThan(vues.port2 * 3);
  });

  it('un autre mode de service prend le premier membre, sans repartir', () => {
    const { fw } = laboratoire({ serviceMode: 'priority' });

    expect(repartition(fw)).toEqual({ port2: 200 });
  });

  it('un membre desactive sort de la repartition', () => {
    const { fw } = laboratoire({ second: ['set status disable'] });

    expect(repartition(fw)).toEqual({ port2: 200 });
  });

  it('usage-based est refuse en nommant la brique qui manque', () => {
    const { sh } = laboratoire();
    sh.execute('config system sdwan');

    expect(sh.execute('set load-balance-mode usage-based')).toContain('RATE');
  });

  it('spillover-threshold est refuse en nommant la brique qui manque', () => {
    const { sh } = laboratoire();
    run(sh, 'config system sdwan', 'config members', 'edit 1');

    expect(sh.execute('set spillover-threshold 100')).toContain('RATE');
  });
});
