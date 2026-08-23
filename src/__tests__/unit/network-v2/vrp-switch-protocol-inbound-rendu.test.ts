/**
 * VRP : `protocol inbound` d'un commutateur est RANGE et rendu nulle part.
 *
 * Mesure de depart : sur un commutateur Huawei,
 * `user-interface vty 0 4` puis `protocol inbound ssh` change bien
 * l'etat de la machine — `_getVtyTransportInput()` repond `ssh` —, et
 * `display current-configuration` ne porte AUCUNE ligne
 * `user-interface`. La configuration rendue etant rejouee a l'import
 * d'une topologie, le reglage disparaissait au rechargement.
 *
 * La cause n'etait pas une ligne oubliee mais DEUX magasins pour une
 * seule vue : le shell tient `userInterfaceExtraConfig`
 * (`authentication-mode`, `idle-timeout`, `acl`, …) et l'equipement tient
 * son `VtyLineConfigStore` (`protocol inbound`, que le routeur rend deja
 * par `renderAllHuawei`). Le rendu ne lisait que le premier. Il lit
 * desormais les deux et les FOND par vue : une plage configuree des deux
 * cotes donne un seul bloc `user-interface vty 0 4`, pas deux blocs
 * concurrents qu'un rejeu appliquerait l'un apres l'autre.
 *
 * Discrimine par `git stash` sur les deux fichiers touches : 3 des 5 cas
 * tombent. Les 2 qui passent des deux cotes sont nommes ici plutot que
 * laisses a decouvrir — « le reglage prend effet sur la machine », qui
 * etait deja vrai (c'est le rendu qui manquait, pas la commande), et
 * « sans commande de vue, aucun bloc », le cas de non-regression qui
 * verifie qu'on n'a pas mis a rendre un bloc vide.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { replayVendorConfig } from '@/store/topologySerializer';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const rendre = (sw: HuaweiSwitch) =>
  run(sw, 'return').then(() => run(sw, 'display current-configuration'));

const run = (d: unknown, c: string) =>
  (d as { executeCommand(c: string): Promise<string> }).executeCommand(c);

async function taper(d: unknown, lignes: readonly string[]): Promise<void> {
  for (const l of lignes) await run(d, l);
}

const transport = (sw: HuaweiSwitch) =>
  (sw as unknown as { _getVtyTransportInput(): string })._getVtyTransportInput();

async function commutateur(lignes: readonly string[]): Promise<HuaweiSwitch> {
  const sw = new HuaweiSwitch('switch-huawei', 'SW');
  await taper(sw, lignes);
  return sw;
}

const VTY_SSH = ['system-view', 'user-interface vty 0 4', 'protocol inbound ssh'];

describe('VRP commutateur : la vue vty est rendue par UN bloc', () => {
  it('le reglage prend effet sur la machine', async () => {
    const sw = await commutateur(VTY_SSH);

    expect(transport(sw)).toBe('ssh');
  });

  it('`protocol inbound ssh` figure dans la configuration rendue', async () => {
    const sw = await commutateur(VTY_SSH);

    const cfg = await rendre(sw);

    expect(cfg).toContain('user-interface vty 0 4');
    expect(cfg).toContain(' protocol inbound ssh');
  });

  it('la copie rechargee porte le meme transport', async () => {
    const sw = await commutateur(VTY_SSH);
    const cfg = await rendre(sw);

    const copie = new HuaweiSwitch('switch-huawei', 'SW2');
    await replayVendorConfig(copie as Parameters<typeof replayVendorConfig>[0], cfg);

    expect(transport(copie)).toBe('ssh');
  });

  it('les deux magasins d une meme plage donnent UN seul bloc', async () => {
    const sw = await commutateur([
      'system-view', 'user-interface vty 0 4',
      'authentication-mode aaa', 'protocol inbound ssh',
    ]);

    const cfg = await rendre(sw);
    const entetes = cfg.split('\n').filter(l => l.startsWith('user-interface vty 0 4'));

    expect(entetes.length).toBe(1);
    expect(cfg).toContain(' authentication-mode aaa');
    expect(cfg).toContain(' protocol inbound ssh');
  });

  it('sans commande de vue, aucun bloc user-interface n est rendu', async () => {
    const sw = await commutateur(['system-view', 'vlan 10']);

    const cfg = await rendre(sw);

    expect(cfg).not.toContain('user-interface');
  });
});
