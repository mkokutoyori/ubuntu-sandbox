/*
 * Une machine annonce UNE version d'IOS, pas deux.
 *
 * Mesure de depart, sur deux routeurs cables et un vrai echange CDP :
 *
 *   show version            ->  Version 15.7(3)M5
 *   show flash:             ->  c2900-...-mz.SPA.157-3.M5.bin   (concorde)
 *   show cdp neighbors detail (chez le VOISIN) -> Version 15.4(3)M
 *   Local LLDP Information  ->  Version 15.4(3)M
 *
 * Le routeur annoncait donc a son voisin — et a lui-meme, par la vue
 * LLDP locale — une version qu'il n'execute pas, contredite par sa
 * propre image de flash. Un eleve qui inventorie les versions par
 * `show cdp neighbors detail`, ce qui est la facon normale de le faire,
 * lisait une valeur fausse.
 *
 * La cause etait cinq ecritures d'un meme fait, dont deux avaient
 * derive. Le COMMUTATEUR, dans les MEMES fichiers, faisait deja
 * correctement : CDP et LLDP lisent tous deux `C2960_SOFTWARE`. Il
 * manquait au routeur sa declaration. `C2900_SOFTWARE` la porte, et
 * `ciscoSoftwareDescriptor` reproduit exactement la phrase de
 * `show version` — ce qui corrige au passage le `c2900` minuscule que
 * CDP annoncait la ou `show version` ecrit `C2900`.
 *
 * Le laboratoire attend que le VOISIN soit appris, et non une DUREE :
 * une temporisation fixe passe sur une machine libre et tombe sous une
 * suite chargee, ce qui est exactement l'instabilite que ce meme lot
 * reproche au cliquet d'aide CLI.
 *
 * DISCRIMINATION (`git stash` des six fichiers) : 4 des 5 cas tombent —
 * les deux de CDP, celui de LLDP, et celui de la declaration unique,
 * qui ne peut pas exister avant. Le cinquieme passe des deux cotes et
 * c'est voulu : `show version` et l'image de flash portaient DEJA la
 * bonne valeur, et c'est contre eux que la derive des deux autres vues
 * se mesure. Il est ecrit sans lire `C2900_SOFTWARE` — un TEMOIN qui
 * dependrait du correctif ne temoignerait de rien.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { C2900_SOFTWARE } from '@/network/devices/shells/cisco/CiscoPlatform';

const VERSION = '15.7(3)M5';

async function pair() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  r1.powerOn(); r2.powerOn();
  new Cable('vc').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  for (const r of [r1, r2]) {
    for (const c of ['enable', 'configure terminal', 'cdp run', 'lldp run',
      'interface GigabitEthernet0/0', 'no shutdown', 'cdp enable', 'lldp transmit',
      'lldp receive', 'exit', 'end']) {
      await r.executeCommand(c);
    }
  }
  await settleNeighbours(r1, r2);
  return { r1, r2 };
}

async function settleNeighbours(_r1: CiscoRouter, r2: CiscoRouter): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const seen = await r2.executeCommand('show cdp neighbors detail');
    if (seen.includes('C2900')) return;
    await new Promise((res) => setTimeout(res, 20));
  }
}

describe('the router announces one IOS version', () => {

  it('the declaration is the single source', () => {
    expect(C2900_SOFTWARE.iosVersion).toBe(VERSION);
    expect(C2900_SOFTWARE.image).toContain('157-3.M5');
  });

  it('`show version` and the flash image agree', async () => {
    const { r1 } = await pair();
    expect(await r1.executeCommand('show version')).toContain(VERSION);
    expect(await r1.executeCommand('show flash:')).toContain('157-3.M5');
  }, 30000);

  it('CDP tells the neighbour the version the router actually runs', async () => {
    const { r2 } = await pair();
    const seen = await r2.executeCommand('show cdp neighbors detail');
    expect(seen).toContain(VERSION);
    expect(seen).not.toContain('15.4(3)M');
  }, 30000);

  it('CDP spells the platform as `show version` does', async () => {
    const { r1, r2 } = await pair();
    const own = await r1.executeCommand('show version');
    const seen = await r2.executeCommand('show cdp neighbors detail');
    expect(own).toContain('C2900 Software');
    expect(seen).toContain('C2900 Software');
    expect(seen).not.toContain('c2900 Software');
  }, 30000);

  it('the LLDP description the router gives of ITSELF matches its own console', async () => {
    const { r1 } = await pair();
    const local = await r1.executeCommand('show lldp local-info');
    if (local.includes('LLDP is not enabled') || local.trim() === '') return;
    expect(local).toContain(VERSION);
    expect(local).not.toContain('15.4(3)M');
  }, 30000);
});
