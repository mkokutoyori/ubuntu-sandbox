/**
 * La legende de `get router info routing-table' etait ECRITE DEUX FOIS, et
 * les deux copies s'etaient deja contredites ; il manquait en plus la
 * ligne qui nomme la table.
 *
 * MESURE DE DEPART sur `8b8eb23d' :
 *
 *   get router info routing-table all        get router info routing-table database
 *   Codes: K - kernel, C - connected, ...    Codes: K - kernel, C - connected, ...
 *          O - OSPF, IA - OSPF inter area           O - OSPF, IA - OSPF inter area
 *          * - candidate default                    > - selected route, * - FIB route
 *
 *   C   192.168.100.0/24 is directly ...     C    *> 192.168.100.0/24 is directly ...
 *
 * Deux fonctions, deux litteraux, la meme question : quels codes cette
 * machine sait-elle ecrire ? Les deux repondaient deja differemment — la
 * premiere annonce `* - candidate default', la seconde `* - FIB route' —
 * et rien n'empechait le reste de diverger a son tour. C'est la regle 2 :
 * deux ecritures d'un meme fait ne restent pas egales.
 *
 * AUTORITE : la sortie CAPTUREE que `ntc-templates' conserve pour
 * `fortinet_get_router_info_routing-table_all'. Sa legende compte SIX
 * lignes la ou nous en ecrivions trois, et une ligne nomme la table avant
 * les routes :
 *
 *   Codes: K - kernel, C - connected, S - static, R - RIP, B - BGP
 *          O - OSPF, IA - OSPF inter area
 *          N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2
 *          E1 - OSPF external type 1, E2 - OSPF external type 2
 *          i - IS-IS, L1 - IS-IS level-1, L2 - IS-IS level-2, ia - IS-IS inter area
 *          * - candidate default
 *
 *   Routing table for VRF=0
 *   O*E2    0.0.0.0/0 [110/10] via 10.149.127.253, Tu-Hub01-Main, 03w2d20h
 *
 * CE QUE LA LEGENDE PEUT ANNONCER ICI, et ce qu'elle ne doit pas. Une
 * legende dit quels codes la machine sait ecrire ; en annoncer un qu'elle
 * n'ecrit jamais est la meme tromperie qu'une colonne vide, dans l'autre
 * sens. `ospfRouteCode' rend `O', `O IA', `O E1' et `O E2' : la ligne des
 * externes de type 1 et 2 est donc VRAIE et manquait. En revanche
 * `normalizeOspfRouteType' ne connait aucun type NSSA — un type 7 traduit
 * ressort en externe ordinaire — et ce simulateur n'a pas d'IS-IS du tout.
 * Ces deux lignes-la restent absentes, et le disent ici.
 *
 * `Routing table for VRF=0' est rendu : le schema `router' de FortiOS n'a
 * pas de VRF dans ce simulateur, donc il y a exactement un contexte de
 * routage, celui que la vraie boite numerote zero.
 *
 * MESURE : 3 cas tombent sur 7.
 * Les 4 qui passent des deux cotes sont nommes, et trois d'entre eux sont
 * des gardes de DECISION plutot que des preuves :
 *   - TEMOIN : la table porte bien une connectee et une statique, donc le
 *     laboratoire route vraiment ;
 *   - « elle n'annonce pas les externes NSSA » etait deja vrai avant, et
 *     doit le rester : en ajoutant la ligne des externes ordinaires, il
 *     etait facile d'ajouter aussi celle des NSSA, que `ospfRouteCode'
 *     n'ecrit jamais ;
 *   - « les deux vues annoncent la MEME liste » etait deja vrai sur deux
 *     lignes ; l'extraction devait le garder vrai sur trois ;
 *   - NON-REGRESSION : la vue `database' marque toujours la route retenue.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: readonly string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function laboratoire(): Promise<FortiGate> {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const r1 = new CiscoRouter('R1-EDGE', 200, 0);
  new Cable('t').connect(fgt.getPort('port1')!, r1.getPort('GigabitEthernet0/1')!);
  await taper(r1, ['enable', 'configure terminal', 'interface GigabitEthernet0/1',
    'ip address 192.168.100.1 255.255.255.0', 'no shutdown', 'end']);
  await taper(fgt, [
    'config system interface', 'edit port1', 'set mode static',
    'set ip 192.168.100.99 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config router static', 'edit 1', 'set dst 8.8.8.8 255.255.255.255',
    'set gateway 192.168.100.1', 'set device "port1"', 'next', 'end',
  ]);
  return fgt;
}

const vue = (fgt: FortiGate, quoi: string): Promise<string> =>
  fgt.executeCommand(`get router info routing-table ${quoi}`).then(String);

const legende = (rendu: string): string[] =>
  rendu.split('\n').filter(l => l.startsWith('Codes:') || /^ {7}\S/.test(l));

describe('la table de routage annonce ses codes une seule fois, et justes', () => {
  it('TEMOIN : la table porte la connectee et la statique', async () => {
    const fgt = await laboratoire();
    const rendu = await vue(fgt, 'all');

    expect(rendu).toContain('C       192.168.100.0/24 is directly connected, port1');
    expect(rendu).toContain('S       8.8.8.8/32 [10/0] via 192.168.100.1, port1');
  }, 30000);

  it('la legende annonce les externes OSPF de type 1 et 2', async () => {
    const fgt = await laboratoire();
    expect(legende(await vue(fgt, 'all')))
      .toContain('       E1 - OSPF external type 1, E2 - OSPF external type 2');
  }, 30000);

  it('elle n annonce PAS IS-IS, que ce moteur n a pas', async () => {
    const fgt = await laboratoire();
    const lignes = legende(await vue(fgt, 'all'));

    expect(lignes.length).toBeGreaterThan(3);
    expect(lignes.some(l => l.includes('IS-IS'))).toBe(false);
  }, 30000);

  it('elle n annonce PAS les externes NSSA, que ce moteur ne code pas', async () => {
    const fgt = await laboratoire();
    expect(legende(await vue(fgt, 'all')).some(l => l.includes('NSSA'))).toBe(false);
  }, 30000);

  it('`Routing table for VRF=0` precede les routes', async () => {
    const fgt = await laboratoire();
    const lignes = (await vue(fgt, 'all')).split('\n');
    const nomme = lignes.indexOf('Routing table for VRF=0');
    const premiere = lignes.findIndex(l => l.startsWith('C  '));

    expect(nomme).toBeGreaterThan(0);
    expect(nomme).toBeLessThan(premiere);
  }, 30000);

  it('les deux vues annoncent la MEME liste de codes', async () => {
    const fgt = await laboratoire();
    const tout = legende(await vue(fgt, 'all'));
    const base = legende(await vue(fgt, 'database'));

    expect(base.slice(0, -1)).toEqual(tout.slice(0, -1));
    expect(tout[tout.length - 1]).toBe('       * - candidate default');
    expect(base[base.length - 1]).toBe('       > - selected route, * - FIB route');
  }, 30000);

  it('NON-REGRESSION : la vue `database` marque toujours la route retenue', async () => {
    const fgt = await laboratoire();
    expect(await vue(fgt, 'database')).toContain('S    *> 8.8.8.8/32');
  }, 30000);
});
