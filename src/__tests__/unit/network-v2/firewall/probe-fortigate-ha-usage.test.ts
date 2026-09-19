/**
 * En grappe, `get system ha status` rendait DEUX EN-TETES VIDES.
 *
 * `System Usage stats:` et `HBDEV stats:` etaient ecrits puis suivis de
 * rien, et `MONDEV stats:` n'etait pas ecrit du tout. Le lot `cd9a4db7`
 * l'avait mesure et dit : « ce simulateur mesure bien les siens mais
 * n'echange aucune de ces valeurs avec ses pairs, donc il ne peut pas
 * remplir les lignes des autres ». C'est cette limite que ce lot ferme,
 * et il la ferme PAR LE FIL : le battement FGCP est deja une vraie trame
 * Ethernet (`ETHERTYPE_FGCP`, diffusee sur chaque interface de
 * battement), et il porte desormais ces valeurs comme il porte deja la
 * configuration et les sessions.
 *
 * FORME, prise sur les captures reelles de `ntc-templates`
 * (`get_system_ha_status`, 5.6 a 7.0) :
 *
 *   System Usage stats:
 *       FGT40XXXXXXXXXXX(updated 3 seconds ago):
 *           sessions=196, average-cpu-user/nice/system/idle=0%/0%/0%/100%, memory=34%
 *   HBDEV stats:
 *       FGT40XXXXXXXXXXX(updated 3 seconds ago):
 *           lan2: physical/00, down, rx-bytes/packets/dropped/errors=2289976940/6414484/0/0, tx=2334914934/6414604/0/0
 *           lan3: physical/1000auto, up, rx-bytes/packets/dropped/errors=2859911090/8634708/0/0, tx=4096246721/11393870/0/0
 *   MONDEV stats:
 *       FGT40XXXXXXXXXXX(updated 3 seconds ago):
 *           lan1: physical/100auto, up, rx-bytes/packets/dropped/errors=.../..., tx=...
 *
 * Quatre mesures que les captures tranchent et qu'on ne pouvait pas
 * deviner : le membre s'indente de QUATRE espaces et ses lignes de HUIT ;
 * `(updated N seconds ago)` est colle au numero de serie, sans blanc ;
 * `MONDEV stats:` n'est ecrit QUE si des interfaces sont surveillees (la
 * capture 6.0 ne le porte pas) ; et le champ de vitesse vaut `00` sur un
 * lien BAS, `<vitesse>auto` sur un lien haut.
 *
 * `(updated N seconds ago)` etait par ailleurs la CONSTANTE `1` sous
 * `Configuration Status:`. L'age est desormais calcule depuis
 * `HaPeer.lastSeenAt`, et les trois blocs le lisent au meme endroit.
 *
 * Discrimine par `git stash push -- src/network` : 5 cas sur 7 tombent.
 * Les 2 qui passent des deux cotes sont nommes :
 *  - le TEMOIN, qui prouve que la grappe monte vraiment et que les deux
 *    membres se voient -- sans lui, des blocs vides et une grappe qui ne
 *    se forme pas seraient indiscernables ;
 *  - le pare-feu AUTONOME, non-regression : ses deux en-tetes doivent
 *    RESTER vides, et c'est la moitie de ce lot -- remplir en grappe
 *    sans rien changer hors grappe.
 *
 * Limites assumees, nommees plutot que tues :
 *  - le champ de vitesse ne prend que les DEUX formes attestees. Aucune
 *    commande de ce simulateur ne force la vitesse d'un port de
 *    FortiGate, donc la negociation est toujours active et la troisieme
 *    forme (`1000full` et ses soeurs, le vocabulaire de `set speed`)
 *    n'est ni produite ni inventee.
 *  - sur un pare-feu AUTONOME les deux en-tetes restent VIDES, et c'est
 *    exactement ce que montre la capture `6.0_noha` : ce n'est pas une
 *    absence qu'on comble, c'est la forme de la machine.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function taper(fw: FortiGate, lignes: readonly string[]): Promise<void> {
  for (const l of lignes) await fw.executeCommand(l);
}

async function adhere(
  fw: FortiGate, priorite: number, surveillees: readonly string[],
): Promise<void> {
  await taper(fw, [
    'config system ha', 'set group-name "cluster-paris"', 'set group-id 10',
    'set mode a-p', 'set password "SecretHA"', 'set hbdev "port7" 50',
    ...(surveillees.length > 0
      ? [`set monitor ${surveillees.map(i => `"${i}"`).join(' ')}`] : []),
    `set priority ${priorite}`, 'end',
  ]);
}

async function grappe(surveillees: readonly string[] = []) {
  const a = new FortiGate('firewall-fortinet', 'FGT-A', 0, 0);
  const b = new FortiGate('firewall-fortinet', 'FGT-B', 200, 0);
  a.powerOn();
  b.powerOn();
  new Cable('hb').connect(a.getPort('port7')!, b.getPort('port7')!);
  new Cable('lan').connect(a.getPort('port1')!, b.getPort('port1')!);
  await adhere(a, 200, surveillees);
  await adhere(b, 128, surveillees);
  for (let tour = 0; tour < 3; tour += 1) {
    a.getHa().tick();
    b.getHa().tick();
  }
  return { a, b };
}

const etat = (fw: FortiGate): Promise<string> =>
  fw.executeCommand('get system ha status').then(String);

function bloc(vue: string, entete: string): string[] {
  const lignes = vue.split('\n');
  const debut = lignes.indexOf(entete);
  if (debut < 0) return [];
  const out: string[] = [];
  for (const ligne of lignes.slice(debut + 1)) {
    if (/^\S/.test(ligne)) break;
    out.push(ligne);
  }
  return out;
}

const MEMBRE = /^ {4}(FGVM\w+)\(updated (\d+) seconds ago\):$/;
const USAGE = /^ {8}sessions=\d+, average-cpu-user\/nice\/system\/idle=\d+%\/\d+%\/\d+%\/\d+%, memory=\d+%$/;
const INTERFACE =
  /^ {8}(\S+): physical\/(\d+auto|00), (up|down), rx-bytes\/packets\/dropped\/errors=\d+\/\d+\/\d+\/\d+, tx=\d+\/\d+\/\d+\/\d+$/;

describe('get system ha status : les statistiques des membres', () => {
  it('TEMOIN : la grappe monte vraiment et les deux membres se voient', async () => {
    const { a } = await grappe();
    const vue = await etat(a);
    expect(vue).toContain('Mode: HA A-P');
    expect(bloc(vue, 'Configuration Status:')).toHaveLength(2);
  }, 30000);

  it('System Usage stats porte UN bloc par membre', async () => {
    const { a } = await grappe();
    const lignes = bloc(await etat(a), 'System Usage stats:');
    expect(lignes).toHaveLength(4);
    expect(lignes[0]).toMatch(MEMBRE);
    expect(lignes[1]).toMatch(USAGE);
    expect(lignes[2]).toMatch(MEMBRE);
    expect(lignes[3]).toMatch(USAGE);
  }, 30000);

  it('les DEUX numeros de serie y figurent, donc la mesure du pair a traverse', async () => {
    const { a, b } = await grappe();
    const lignes = bloc(await etat(a), 'System Usage stats:').join('\n');
    expect(lignes).toContain(a.serialNumber());
    expect(lignes).toContain(b.serialNumber());
  }, 30000);

  it('HBDEV stats detaille l interface de battement de chaque membre', async () => {
    const { a } = await grappe();
    const lignes = bloc(await etat(a), 'HBDEV stats:');
    expect(lignes).toHaveLength(4);
    for (const ligne of lignes) {
      expect(ligne, ligne).toMatch(MEMBRE.test(ligne) ? MEMBRE : INTERFACE);
    }
    expect(lignes.filter(l => INTERFACE.test(l)).every(l => l.includes('port7'))).toBe(true);
  }, 30000);

  it('MONDEV stats parait quand des interfaces sont surveillees, et pas sinon', async () => {
    const sans = await grappe();
    expect(await etat(sans.a)).not.toContain('MONDEV stats:');
    const avec = await grappe(['port1']);
    const lignes = bloc(await etat(avec.a), 'MONDEV stats:');
    expect(lignes).toHaveLength(4);
    expect(lignes.filter(l => INTERFACE.test(l)).every(l => l.includes('port1'))).toBe(true);
  }, 30000);

  it('l age du pair est CALCULE, il n est plus ecrit `1`', async () => {
    const { a } = await grappe();
    const ages = (vue: string) => bloc(vue, 'Configuration Status:')
      .map(l => Number(/\(updated (\d+) seconds ago\)/.exec(l)?.[1]));
    const avant = ages(await etat(a));
    expect(avant).toHaveLength(2);
    expect(Math.min(...avant)).toBe(0);
  }, 30000);

  it('un pare-feu AUTONOME garde ses deux en-tetes vides', async () => {
    const seul = new FortiGate('firewall-fortinet', 'FGT-SEUL', 0, 0);
    const vue = await etat(seul);
    expect(vue).toContain('System Usage stats:');
    expect(bloc(vue, 'System Usage stats:')).toEqual([]);
    expect(bloc(vue, 'HBDEV stats:')).toEqual([]);
    expect(vue).not.toContain('MONDEV stats:');
  }, 30000);
});
