/**
 * La bannière de démarrage et `show version` décrivent la MÊME machine.
 *
 * Deux lignes de la bannière d'un routeur neuf ne parlaient pas IOS :
 *
 *     Router1 uptime is 00:00:00
 *     Base ethernet MAC address: 02:00:00:00:00:01
 *
 * **L'uptime** était rendu par `formatUptime`, l'horloge des objets
 * `track` — un HH:MM:SS, ce qui est une autre unité et une autre
 * commande. IOS compte cette ligne-là en MINUTES et n'écrit jamais de
 * secondes ; `formatIosUptime` le fait depuis toujours, et c'est ce que
 * `show version` appelle. La même machine se contredisait donc sur son
 * propre âge selon l'endroit où on le lisait.
 *
 * **L'adresse MAC de base** sortait en deux-points, la notation d'un
 * hôte. IOS écrit trois groupes pointés. Le commutateur le faisait déjà
 * (`toCiscoString`) : le routeur était le seul à ne pas suivre.
 *
 * Aucune des deux n'est cosmétique. Les deux sont ce qu'un opérateur
 * copie dans un ticket ou compare à un inventaire, et une adresse notée
 * dans la mauvaise convention ne se retrouve pas par une recherche.
 *
 * Discrimination — restaurer `CiscoRouter.ts` : les trois premiers cas
 * tombent. Le dernier passe des deux côtés et garde le correctif.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
});

function bootedRouter(): CiscoRouter {
  const router = new CiscoRouter('Router1', 0, 0);
  router.powerOn();
  return router;
}

function banner(router: CiscoRouter): string[] {
  return String((router as unknown as { getBootSequence(): string }).getBootSequence())
    .split('\n')
    .map((l) => l.trim());
}

function lineMatching(lines: readonly string[], rx: RegExp): string {
  const found = lines.find((l) => rx.test(l));
  expect(found, `aucune ligne ne correspond à ${rx}`).toBeTruthy();
  return found as string;
}

describe('la bannière de démarrage parle IOS', () => {
  it("l'uptime est compté en minutes, jamais en HH:MM:SS", async () => {
    const router = bootedRouter();
    const ligne = lineMatching(banner(router), /uptime is/);

    expect(ligne).toBe('Router1 uptime is 0 minutes');
    expect(ligne).not.toMatch(/\d\d:\d\d:\d\d/);
  });

  it("l'adresse MAC de base est en trois groupes pointés, comme IOS l'écrit", async () => {
    const router = bootedRouter();
    const ligne = lineMatching(banner(router), /Base ethernet MAC address/);

    expect(ligne).toMatch(/^Base ethernet MAC address: [0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/);
    expect(ligne).not.toContain(':0');
  });

  it("la bannière et `show version` donnent le MÊME uptime", async () => {
    const router = bootedRouter();
    await router.executeCommand('enable');
    const vue = String(await router.executeCommand('show version'));

    const depuisBanniere = lineMatching(banner(router), /uptime is/);
    const depuisVue = lineMatching(vue.split('\n').map((l) => l.trim()), /uptime is/);
    expect(depuisVue).toBe(depuisBanniere);
  });

  /**
   * Le format pointé vient de `MACAddress`, pas d'une mise en forme
   * recopiée dans la bannière — sans quoi la prochaine adresse serait à
   * nouveau écrite à la main, et à nouveau dans la mauvaise convention.
   */
  it('le format vient du type qui porte l\'adresse', () => {
    expect(new MACAddress('02:00:00:00:00:01').toCiscoString()).toBe('0200.0000.0001');
  });
});
