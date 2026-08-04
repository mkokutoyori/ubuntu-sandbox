/**
 * Sondes — une route statique face à un `shutdown` de son interface.
 *
 * La règle, et c'est celle des deux constructeurs : **une route statique
 * quitte la table quand son interface de sortie ou son prochain saut
 * n'est plus joignable.** L'exception, et la seule, est `permanent`.
 *
 * Ce que la mesure a montré AVANT correction, et qui n'était pas ce
 * qu'on aurait deviné :
 *
 *  - **Cisco : trois cas sur quatre étaient déjà justes.** La forme par
 *    interface, la forme par prochain saut et la flottante quittaient
 *    bien la table — parce que `addStaticRoute` résout l'interface de
 *    sortie du prochain saut dès la configuration, et que
 *    `isRouteInterfaceUsable` est consulté par le rendu ET par
 *    `lookupRoute`. Le mécanisme était réel, pas cosmétique.
 *  - **`permanent` était accepté puis jeté.** Le mot-clé ne ressemble ni
 *    à une distance ni à `track`, donc l'analyseur le laissait tomber
 *    sans rien dire ; le champ `RouteEntry.permanent` existait et
 *    n'était lu par personne. La route disparaissait au `shutdown`,
 *    c'est-à-dire exactement ce que ce mot-clé sert à empêcher.
 *  - **Huawei ne filtrait RIEN**, et c'est le piège de cette
 *    vérification : la forme `permanent` semblait correcte puisque la
 *    route restait — sauf que la forme ORDINAIRE restait aussi. La
 *    conformité apparente était un hasard. Les trois vues VRP lisaient
 *    la table brute ; deux plateformes donnaient deux réponses
 *    différentes à la même panne sur la même topologie.
 *  - **La configuration rendue ne refaisait pas la route saisie** :
 *    `ip route … GigabitEthernet0/0` revenait en `ip route … 0.0.0.0`
 *    (une autre route), une flottante en distance 200 revenait en
 *    distance 1 (elle cessait d'être un secours), `permanent`
 *    disparaissait. Une configuration relue à l'import d'une topologie
 *    n'est pas un affichage : c'est ce qui REFAIT la route.
 *
 * Le dernier scénario est celui qui compte le plus, parce qu'il dit ce
 * que `permanent` ne fait PAS : la route reste dans la table et le
 * trafic ne passe toujours pas. C'est le trou noir que ce mot-clé
 * provoque sur un vrai routeur, et la raison pour laquelle on s'en
 * méfie. Une implémentation qui ferait « marcher » le ping serait plus
 * fausse que celle qui retirait la route.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Cable } from '@/network/hardware/Cable';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

async function labCisco(): Promise<CiscoRouter> {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  new Cable('c1').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  for (const [r, ip] of [[r1, '10.1.1.1'], [r2, '10.1.1.2']] as [CiscoRouter, string][]) {
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand(`ip address ${ip} 255.255.255.0`);
    await r.executeCommand('no shutdown');
    await r.executeCommand('exit');
  }
  return r1;
}

async function eteindre(r: CiscoRouter): Promise<void> {
  await r.executeCommand('configure terminal');
  await r.executeCommand('interface GigabitEthernet0/0');
  await r.executeCommand('shutdown');
  await r.executeCommand('end');
}

/** La route est-elle dans la table après extinction de l'interface ? */
async function surviCisco(routeCmd: string): Promise<boolean> {
  const r = await labCisco();
  expect(await r.executeCommand(routeCmd)).toBe('');
  await r.executeCommand('end');
  expect(await r.executeCommand('show ip route')).toContain('192.168.10.0');
  await eteindre(r);
  return (await r.executeCommand('show ip route')).includes('192.168.10.0');
}

describe('Cisco — les quatre cas de la règle', () => {
  it('cas 1 : par interface de sortie, la route s\'en va', async () => {
    expect(await surviCisco('ip route 192.168.10.0 255.255.255.0 GigabitEthernet0/0')).toBe(false);
  });

  it('cas 2 : par prochain saut, la route s\'en va', async () => {
    expect(await surviCisco('ip route 192.168.10.0 255.255.255.0 10.1.1.2')).toBe(false);
  });

  it('cas 3 : `permanent`, la route RESTE', async () => {
    expect(await surviCisco('ip route 192.168.10.0 255.255.255.0 10.1.1.2 permanent')).toBe(true);
  });

  it('cas 4 : flottante, la distance ne la protège pas', async () => {
    expect(await surviCisco('ip route 192.168.10.0 255.255.255.0 10.1.1.2 200')).toBe(false);
  });

  it('l\'interface redevient utilisable et la route revient', async () => {
    const r = await labCisco();
    await r.executeCommand('ip route 192.168.10.0 255.255.255.0 10.1.1.2');
    await eteindre(r);
    expect(await r.executeCommand('show ip route')).not.toContain('192.168.10.0');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('no shutdown');
    await r.executeCommand('end');
    // Le retrait n'est pas une suppression : la route n'a jamais quitté
    // la RIB, elle cessait d'être installable. Sinon elle ne reviendrait
    // pas sans que l'opérateur la ressaisisse.
    expect(await r.executeCommand('show ip route')).toContain('192.168.10.0');
  });
});

describe('Cisco — ce que `permanent` ne fait pas', () => {
  it('la route reste, et le trafic ne passe toujours pas', async () => {
    const r = await labCisco();
    await r.executeCommand('ip route 192.168.99.0 255.255.255.0 10.1.1.2 permanent');
    await eteindre(r);
    expect(await r.executeCommand('show ip route')).toContain('192.168.99.0');
    // Le trou noir : c'est le danger réel de ce mot-clé, pas un défaut
    // du simulateur. Faire « marcher » le ping ici serait plus faux que
    // de retirer la route.
    expect(await r.executeCommand('ping 192.168.99.5')).toContain('Success rate is 0 percent');
  });
});

describe('Cisco — la configuration rendue refait la route saisie', () => {
  async function ligne(cmd: string): Promise<string> {
    const r = await labCisco();
    await r.executeCommand(cmd);
    await r.executeCommand('end');
    const rc = await r.executeCommand('show running-config');
    return rc.split('\n').map((x) => x.trim()).filter((x) => x.startsWith('ip route')).join('|');
  }

  it('la forme par interface n\'est pas réécrite en 0.0.0.0', async () => {
    expect(await ligne('ip route 192.168.10.0 255.255.255.0 GigabitEthernet0/0'))
      .toBe('ip route 192.168.10.0 255.255.255.0 GigabitEthernet0/0');
  });

  it('la forme par prochain saut ne gagne pas une interface', async () => {
    // L'interface EST connue (résolue du prochain saut), mais l'opérateur
    // ne l'a pas écrite : la rendre changerait la commande.
    expect(await ligne('ip route 192.168.10.0 255.255.255.0 10.1.1.2'))
      .toBe('ip route 192.168.10.0 255.255.255.0 10.1.1.2');
  });

  it('une flottante reste flottante', async () => {
    expect(await ligne('ip route 192.168.10.0 255.255.255.0 10.1.1.2 200'))
      .toBe('ip route 192.168.10.0 255.255.255.0 10.1.1.2 200');
  });

  it('`permanent` survit au rendu', async () => {
    expect(await ligne('ip route 192.168.10.0 255.255.255.0 10.1.1.2 permanent'))
      .toBe('ip route 192.168.10.0 255.255.255.0 10.1.1.2 permanent');
  });

  it('la forme complète revient entière', async () => {
    expect(await ligne('ip route 192.168.10.0 255.255.255.0 GigabitEthernet0/0 10.1.1.2 200 permanent'))
      .toBe('ip route 192.168.10.0 255.255.255.0 GigabitEthernet0/0 10.1.1.2 200 permanent');
  });
});

describe('Huawei — la même règle, sur la même RIB', () => {
  async function labH(): Promise<HuaweiRouter> {
    const h1 = new HuaweiRouter('HR1');
    const h2 = new HuaweiRouter('HR2');
    new Cable('c2').connect(h1.getPort('GE0/0/0')!, h2.getPort('GE0/0/0')!);
    for (const [r, ip] of [[h1, '10.2.2.1'], [h2, '10.2.2.2']] as [HuaweiRouter, string][]) {
      await r.executeCommand('system-view');
      await r.executeCommand('interface GE0/0/0');
      await r.executeCommand(`ip address ${ip} 255.255.255.0`);
      await r.executeCommand('undo shutdown');
      await r.executeCommand('quit');
    }
    return h1;
  }

  async function surviH(routeCmd: string): Promise<boolean> {
    const h = await labH();
    expect(await h.executeCommand(routeCmd)).toBe('');
    await h.executeCommand('quit');
    expect(await h.executeCommand('display ip routing-table')).toContain('192.168.20.0');
    await h.executeCommand('system-view');
    await h.executeCommand('interface GE0/0/0');
    await h.executeCommand('shutdown');
    await h.executeCommand('quit');
    await h.executeCommand('quit');
    return (await h.executeCommand('display ip routing-table')).includes('192.168.20.0');
  }

  it('par prochain saut, la route s\'en va', async () => {
    expect(await surviH('ip route-static 192.168.20.0 255.255.255.0 10.2.2.2')).toBe(false);
  });

  it('par interface de sortie, la route s\'en va', async () => {
    expect(await surviH('ip route-static 192.168.20.0 255.255.255.0 GE0/0/0')).toBe(false);
  });

  it('une préférence élevée ne la protège pas', async () => {
    expect(await surviH('ip route-static 192.168.20.0 255.255.255.0 10.2.2.2 preference 200')).toBe(false);
  });

  it('`permanent`, la route RESTE', async () => {
    expect(await surviH('ip route-static 192.168.20.0 255.255.255.0 10.2.2.2 permanent')).toBe(true);
  });

  it('la vue par protocole filtre comme la vue générale', async () => {
    const h = await labH();
    await h.executeCommand('ip route-static 192.168.20.0 255.255.255.0 10.2.2.2');
    await h.executeCommand('interface GE0/0/0');
    await h.executeCommand('shutdown');
    await h.executeCommand('quit');
    await h.executeCommand('quit');
    // Deux vues de la même table ne peuvent pas se contredire : une
    // route absente de l'une doit l'être de l'autre.
    expect(await h.executeCommand('display ip routing-table protocol static'))
      .not.toContain('192.168.20.0');
  });

  it('la configuration rendue refait la route saisie', async () => {
    const h = await labH();
    await h.executeCommand('ip route-static 192.168.20.0 255.255.255.0 GE0/0/0');
    await h.executeCommand('ip route-static 192.168.21.0 255.255.255.0 10.2.2.2 permanent');
    await h.executeCommand('ip route-static 192.168.22.0 255.255.255.0 10.2.2.2 preference 200');
    const rc = await h.executeCommand('display current-configuration');
    const lignes = rc.split('\n').map((x) => x.trim()).filter((x) => x.startsWith('ip route-static'));
    expect(lignes).toContain('ip route-static 192.168.20.0 255.255.255.0 GE0/0/0');
    expect(lignes).toContain('ip route-static 192.168.21.0 255.255.255.0 10.2.2.2 permanent');
    expect(lignes).toContain('ip route-static 192.168.22.0 255.255.255.0 10.2.2.2 preference 200');
  });
});
