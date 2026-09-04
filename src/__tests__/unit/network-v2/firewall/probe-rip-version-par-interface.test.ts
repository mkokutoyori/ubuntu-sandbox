/**
 * `send-version` et `receive-version` etaient acceptes par interface et
 * lus par personne.
 *
 * `config router rip / config interface / edit <port>` declare les deux,
 * la reference 6.0.4 les atteste (« Send version. », « Receive
 * version. », avec l'exemple `set receive-version 2 set send-version
 * 2`), ils sont rendus par `show router rip` — donc rejoues a l'import
 * d'une topologie — et le moteur ne les consultait NULLE PART. Mesure :
 * une interface reglee en `send-version 1` emettait quand meme un
 * paquet RIPv2 vers 224.0.0.9.
 *
 * Ce n'est pas une difference d'affichage. La version decide de l'ADRESSE
 * DE DESTINATION — RIPv2 va au groupe 224.0.0.9, RIPv1 diffuse en
 * 255.255.255.255 (RFC 2453 §4.3) — et elle decide de ce qu'une
 * interface ACCEPTE. Un segment mixte v1/v2, qui est la seule raison
 * d'etre de ces deux commandes, ne pouvait donc pas etre monte.
 *
 * **Ce qui n'etait PAS un defaut, et qui a ete verifie plutot que
 * suppose** : la version d'EQUIPEMENT (`config router rip / set version
 * 1`) etait deja lue — `FirewallRouting.ripCallbacks` fournit
 * `getRipVersion` depuis toujours. Une premiere lecture l'avait comptee
 * comme un troisieme reglage inerte ; la mesure dit le contraire, et un
 * cas l'epingle. Le reglage par interface SURCHARGE celui d'equipement,
 * qui reste le defaut quand aucune interface n'est declaree.
 *
 * **La version est stampee au point d'EMISSION et non par chaque
 * constructeur** : `sendPacket` est le seul endroit ou un paquet quitte
 * le moteur, il connait deja l'interface, et les trois constructeurs
 * ecrivaient chacun `version: this.ripVersion()` — quatre ecritures d'un
 * meme fait, dont trois ne pouvaient pas connaitre le reglage par
 * interface. Il n'en reste qu'une.
 *
 * **Le laboratoire est asymetrique par construction**, et c'est ce qui
 * le rend lisible : A emet en v1 tandis que sa reception reste en v2,
 * donc A apprend de B pendant que B ignore A. Un laboratoire ou les deux
 * cotes sont coupes ne distinguerait pas « la version d'emission est
 * appliquee » de « le laboratoire ne converge pas ».
 *
 * Discrimine par `git stash push -- src/network/` : 4 des 9 cas
 * tombent. Les 5 restants sont nommes ici plutot que laisses a
 * decouvrir :
 *
 *   - « sans reglage, les deux cotes convergent » et « sans reglage,
 *     tout part en RIPv2 vers le groupe » sont les TEMOINS, et c'est
 *     leur objet de passer des deux cotes : sans eux, un laboratoire
 *     qui ne converge pas et une version ignoree seraient
 *     indiscernables — c'est exactement l'erreur que la mesure a
 *     d'abord faite, en coupant les DEUX sens a la fois ;
 *   - « la configuration est acceptee et rendue » passait deja, et
 *     c'est l'enonce meme du defaut ;
 *   - « la reception de A reste en v2 et continue d'apprendre » est la
 *     GARDE d'asymetrie : elle exige que regler l'emission n'ait pas
 *     coupe la reception au passage ;
 *   - « la version d'equipement gouverne les interfaces non declarees »
 *     passait deja, et c'est le point verifie plutot que suppose :
 *     `getRipVersion` etait deja fourni, donc cette moitie-la n'etait
 *     PAS un defaut, et le cas garde qu'on ne l'a pas cassee.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
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

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

interface RipEngineView {
  advanceTime(ms: number): void;
  getRoutes(): Map<string, unknown>;
}

function moteur(fw: FortiGate): RipEngineView {
  return (fw as unknown as { routing: { getRip(): RipEngineView } }).routing.getRip();
}

function pareFeu(nom: string, adresse: string, prive: string, position: number) {
  const fw = new FortiGate('firewall-fortinet', nom, position, 0);
  const sh = fw.getShell() as FortiShell;
  run(sh, 'config system interface',
    'edit "port1"', 'set mode static', `set ip ${adresse} 255.255.255.0`, 'next',
    'edit "port2"', 'set mode static', `set ip ${prive} 255.255.255.0`, 'next', 'end');
  return { fw, sh };
}

function demarreRip(sh: FortiShell, prefixe: string, extra: readonly string[] = []): void {
  run(sh, 'config router rip', 'config network',
    'edit 1', 'set prefix 10.0.0.0 255.255.255.0', 'next',
    'edit 2', `set prefix ${prefixe} 255.255.255.0`, 'next', 'end',
    ...extra, 'end');
}

interface TrameRip { readonly emetteur: string; readonly destination: string; readonly version: number }

function laboratoire(reglagesA: readonly string[] = [], reglagesB: readonly string[] = []) {
  const a = pareFeu('A', '10.0.0.1', '192.168.1.1', 0);
  const b = pareFeu('B', '10.0.0.2', '192.168.2.1', 300);
  new Cable('c1').connect(a.fw.getPort('port1')!, b.fw.getPort('port1')!);

  const trames: TrameRip[] = [];
  for (const [emetteur, fw] of [['A', a.fw], ['B', b.fw]] as const) {
    fw.getBus().subscribe('port.frame.tx-requested', (event) => {
      const payload = (event as { payload: { frame?: unknown } }).payload;
      const paquet = (payload.frame as { payload?: {
        protocol?: number;
        destinationIP?: { toString(): string };
        payload?: { payload?: { type?: string; version?: number } };
      } })?.payload;
      if (paquet?.protocol !== 17) return;
      const rip = paquet.payload?.payload;
      if (rip?.type !== 'rip') return;
      trames.push({
        emetteur,
        destination: paquet.destinationIP?.toString() ?? '',
        version: rip.version ?? 0,
      });
    });
  }

  demarreRip(a.sh, '192.168.1.0', reglagesA);
  demarreRip(b.sh, '192.168.2.0', reglagesB);
  moteur(a.fw).advanceTime(31000);
  moteur(b.fw).advanceTime(31000);

  return { a, b, trames };
}

function apprises(fw: FortiGate): readonly string[] {
  return [...moteur(fw).getRoutes().keys()];
}

const V1_PAR_INTERFACE = Object.freeze([
  'config interface', 'edit "port1"', 'set send-version 1', 'next', 'end',
]);

describe('la version RIP par interface', () => {
  it('sans reglage, les deux cotes convergent', () => {
    const { a, b } = laboratoire();

    expect(apprises(a.fw)).toEqual(['192.168.2.0/24']);
    expect(apprises(b.fw)).toEqual(['192.168.1.0/24']);
  });

  it('sans reglage, tout part en RIPv2 vers le groupe', () => {
    const { trames } = laboratoire();

    expect(trames.length).toBeGreaterThan(0);
    expect(trames.every(trame => trame.version === 2)).toBe(true);
    expect(trames.some(trame => trame.destination === '224.0.0.9')).toBe(true);
  });

  it('la configuration est acceptee et rendue', () => {
    const { a } = laboratoire(V1_PAR_INTERFACE);

    expect(a.sh.execute('show router rip')).toContain('set send-version 1');
  });

  it('send-version 1 fait DIFFUSER un paquet RIPv1', () => {
    const { trames } = laboratoire(V1_PAR_INTERFACE);
    const emisParA = trames.filter(trame => trame.emetteur === 'A'
      && trame.destination !== '10.0.0.2');

    expect(emisParA.length).toBeGreaterThan(0);
    expect(emisParA.every(trame => trame.version === 1)).toBe(true);
    expect(emisParA.every(trame => trame.destination === '255.255.255.255')).toBe(true);
  });

  it('le voisin en receive-version 2 ignore ce RIPv1', () => {
    const { b } = laboratoire(V1_PAR_INTERFACE);

    expect(apprises(b.fw)).toEqual([]);
  });

  it('la reception de A reste en v2 et continue d_apprendre', () => {
    const { a } = laboratoire(V1_PAR_INTERFACE);

    expect(apprises(a.fw)).toEqual(['192.168.2.0/24']);
  });

  it('receive-version 1 refuse le RIPv2 du voisin', () => {
    const { a } = laboratoire([
      'config interface', 'edit "port1"', 'set receive-version 1', 'next', 'end',
    ]);

    expect(apprises(a.fw)).toEqual([]);
  });

  it('la version d_equipement gouverne les interfaces non declarees', () => {
    const { trames } = laboratoire(['set version 1']);
    const emisParA = trames.filter(trame => trame.emetteur === 'A'
      && trame.destination !== '10.0.0.2');

    expect(emisParA.every(trame => trame.version === 1)).toBe(true);
  });

  it('le reglage par interface surcharge celui d_equipement', () => {
    const { trames } = laboratoire([
      'set version 1',
      'config interface', 'edit "port1"', 'set send-version 2', 'next', 'end',
    ]);
    const emisParA = trames.filter(trame => trame.emetteur === 'A'
      && trame.destination !== '10.0.0.2');

    expect(emisParA.length).toBeGreaterThan(0);
    expect(emisParA.every(trame => trame.version === 2)).toBe(true);
  });
});
