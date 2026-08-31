/**
 * Ecrit A L'AVEUGLE depuis la reference IOS, avant toute lecture du
 * code.
 *
 * `ip cef` active la commutation express, `no ip cef` l'eteint, et le
 * DEFAUT sur une plateforme moderne est ACTIF — donc seule la coupure
 * merite d'etre ecrite dans la configuration, comme pour
 * `service dhcp`. `ip cef load-sharing algorithm <nom>` choisit la
 * repartition de charge, `ip cef accounting <quoi>` la comptabilite.
 * `show ip cef` rend la table de transmission.
 *
 * UNE premisse etait fausse et elle est corrigee ici plutot
 * qu'effacee : la sonde attendait qu'un prefixe connecte paraisse apres
 * `ip address` + `no shutdown`. Un port de routeur SANS CABLE reste
 * baisse, donc il n'y a pas de route connectee — `show ip route` n'en
 * montre pas davantage. Le cas verifie desormais l'invariant reel : les
 * deux vues s'accordent sur les prefixes.
 *
 * Ce que la sonde cherche avant tout : un reglage RANGE mais lu par
 * personne. Ce depot tient pour regle qu'une commande acceptee doit
 * agir ou etre refusee ; le minimum verifiable ici est qu'elle se relise
 * dans la configuration, faute de quoi elle est perdue a l'import d'une
 * topologie.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  executeCommand(command: string): Promise<string>;
}

const REFUS = /Invalid input|Incomplete command|Unknown command/;

function routeur(): Cli {
  const r = new CiscoRouter('R', 0, 0);
  r.powerOn();
  return r as unknown as Cli;
}

async function taper(d: Cli, lignes: readonly string[]): Promise<string[]> {
  const sorties: string[] = [];
  for (const ligne of lignes) sorties.push(await d.executeCommand(ligne));
  return sorties;
}

async function enConfig(d: Cli): Promise<Cli> {
  await taper(d, ['enable', 'configure terminal']);
  return d;
}

async function config(d: Cli): Promise<string> {
  await d.executeCommand('end');
  return d.executeCommand('show running-config');
}

describe('`ip cef` est actif par defaut, et seule la coupure s ecrit', () => {
  it('la configuration d origine ne porte pas `ip cef`', async () => {
    const r = await enConfig(routeur());

    expect(await config(r)).not.toMatch(/^ip cef$/m);
  });

  it('`no ip cef` s ecrit, LUI', async () => {
    const r = await enConfig(routeur());
    await r.executeCommand('no ip cef');

    expect(await config(r)).toMatch(/^no ip cef$/m);
  });

  it('et le rallumer efface la coupure', async () => {
    const r = await enConfig(routeur());
    await taper(r, ['no ip cef', 'ip cef']);

    expect(await config(r)).not.toMatch(/^no ip cef$/m);
  });
});

describe('les reglages de CEF se relisent', () => {
  const REGLAGES = [
    'ip cef load-sharing algorithm universal',
    'ip cef accounting per-prefix',
  ];

  for (const saisie of REGLAGES) {
    it(`\`${saisie}\` est accepte`, async () => {
      const r = await enConfig(routeur());

      expect(await r.executeCommand(saisie)).not.toMatch(REFUS);
    });

    it(`\`${saisie}\` se relit dans la configuration`, async () => {
      const r = await enConfig(routeur());
      await r.executeCommand(saisie);

      expect(await config(r)).toContain(saisie);
    });
  }
});

describe('une suite inconnue est REFUSEE', () => {
  const FAUTIVES = [
    'ip cef zorglub',
    'ip cef load-sharing algorithm zorglub',
    'ip cef accounting zorglub',
  ];

  for (const saisie of FAUTIVES) {
    it(`\`${saisie}\``, async () => {
      const r = await enConfig(routeur());

      expect(await r.executeCommand(saisie)).toMatch(REFUS);
    });

    it(`\`${saisie}\` n entre pas dans la configuration`, async () => {
      const r = await enConfig(routeur());
      await r.executeCommand(saisie);

      expect(await config(r)).not.toContain('zorglub');
    });
  }
});

describe('`show ip cef` rend la table de transmission', () => {
  it('la vue existe', async () => {
    const r = routeur();
    await r.executeCommand('enable');

    expect(await r.executeCommand('show ip cef')).not.toMatch(REFUS);
  });

  it('elle s accorde avec `show ip route` sur les prefixes', async () => {
    const r = await enConfig(routeur());
    const port = (r as unknown as { getPortNames(): string[] }).getPortNames()[0];
    await taper(r, [
      `interface ${port}`, 'ip address 10.0.0.1 255.255.255.0', 'no shutdown',
      'end',
    ]);
    const cef = await r.executeCommand('show ip cef');
    const table = await r.executeCommand('show ip route');

    expect(cef.includes('10.0.0.0')).toBe(table.includes('10.0.0.0'));
  });

  it('eteinte, elle le DIT au lieu de rendre une table vide', async () => {
    const r = await enConfig(routeur());
    await taper(r, ['no ip cef', 'end']);

    expect(await r.executeCommand('show ip cef')).toContain('not enabled');
  });
});

describe('`ip cef ?` decrit ses suites', () => {
  it('`load-sharing` et `accounting` y sont decrits', async () => {
    const r = await enConfig(routeur());
    const vue = await r.executeCommand('ip cef ?');

    expect(vue).toMatch(/^\s*load-sharing\s+\S/m);
    expect(vue).toMatch(/^\s*accounting\s+\S/m);
  });
});
