/**
 * Ecrit A L'AVEUGLE depuis la reference IOS, avant toute lecture du
 * code.
 *
 * `crypto pki trustpoint <nom>` entre dans le sous-mode d'un point de
 * confiance et le CREE ; on y ecrit `enrollment {selfsigned|terminal|url
 * <url>}`, `subject-name <dn>`, `revocation-check {crl|none|ocsp}` et
 * `rsakeypair <label>`. `no crypto pki trustpoint <nom>` le supprime.
 * `show crypto pki trustpoints` les enumere, `show crypto pki
 * certificates` rend les certificats. La configuration relit le bloc.
 *
 * L'orthographe compte : IOS ecrit `enrollment selfsigned` EN UN MOT
 * dans sa configuration — le POINT DE CONFIANCE s'appelle bien
 * `TP-self-signed-<n>` avec des traits d'union, mais le mot-cle n'en
 * porte aucun — et l'inscription y vient EN PREMIER, avant
 * `subject-name`.
 *
 * Ce que la sonde cherche : un reglage RANGE et lu par personne. Ce
 * depot tient pour regle qu'une commande acceptee doit agir ou etre
 * refusee ; le minimum verifiable est qu'elle se relise, faute de quoi
 * elle est perdue a l'import d'une topologie.
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
  getPrompt(): string;
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

const POINT = [
  'crypto pki trustpoint MAISON',
  'enrollment selfsigned',
  'subject-name CN=routeur.lab.local',
  'revocation-check none',
  'rsakeypair CLE-MAISON',
  'exit',
];

describe('`crypto pki trustpoint` ouvre le sous-mode et cree le point', () => {
  it('l invite passe en (ca-trustpoint)', async () => {
    const r = await enConfig(routeur());
    await r.executeCommand('crypto pki trustpoint MAISON');

    expect(r.getPrompt()).toMatch(/\(ca-trustpoint\)#$/);
  });

  it('`exit` revient en configuration globale', async () => {
    const r = await enConfig(routeur());
    await taper(r, ['crypto pki trustpoint MAISON', 'exit']);

    expect(r.getPrompt()).toMatch(/\(config\)#$/);
  });

  it('sans nom, la commande est incomplete', async () => {
    const r = await enConfig(routeur());

    expect(await r.executeCommand('crypto pki trustpoint'))
      .toMatch(/Incomplete command/);
  });

  it('le nom garde sa CASSE', async () => {
    const r = await enConfig(routeur());
    await taper(r, ['crypto pki trustpoint Maison-RH', 'exit']);

    expect(await config(r)).toContain('Maison-RH');
  });
});

describe('ce que le point de confiance recoit se relit', () => {
  it('le bloc entier parait dans la configuration', async () => {
    const r = await enConfig(routeur());
    await taper(r, POINT);
    const vue = await config(r);

    expect(vue).toContain('crypto pki trustpoint MAISON');
    expect(vue).toContain('enrollment selfsigned');
    expect(vue).toContain('subject-name CN=routeur.lab.local');
    expect(vue).toContain('revocation-check none');
    expect(vue).toContain('rsakeypair CLE-MAISON');
  });

  it('`show crypto pki trustpoints` le nomme', async () => {
    const r = await enConfig(routeur());
    await taper(r, [...POINT, 'end']);

    expect(await r.executeCommand('show crypto pki trustpoints'))
      .toContain('MAISON');
  });

  it('`enrollment profile` garde le NOM du profil', async () => {
    const r = await enConfig(routeur());
    await taper(r, [
      'crypto pki trustpoint AC', 'enrollment profile PROFIL-SCEP', 'exit',
    ]);

    expect(await config(r)).toContain('enrollment profile PROFIL-SCEP');
  });

  it('l inscription vient EN PREMIER dans le bloc, comme sur IOS', async () => {
    const r = await enConfig(routeur());
    await taper(r, POINT);
    const lignes = (await config(r)).split('\n');
    const tete = lignes.findIndex(l => l.startsWith('crypto pki trustpoint MAISON'));

    expect(tete).toBeGreaterThanOrEqual(0);
    expect(lignes[tete + 1]).toBe(' enrollment selfsigned');
  });

  it('une seule ligne `enrollment`, jamais deux', async () => {
    const r = await enConfig(routeur());
    await taper(r, [
      'crypto pki trustpoint AC',
      'enrollment url http://ac.lab.local/scep',
      'enrollment selfsigned',
      'exit',
    ]);
    const lignes = (await config(r)).split('\n')
      .filter(l => l.trim().startsWith('enrollment'));

    expect(lignes).toEqual([' enrollment selfsigned']);
  });

  it('`enrollment url` garde son URL telle quelle', async () => {
    const r = await enConfig(routeur());
    await taper(r, [
      'crypto pki trustpoint AC',
      'enrollment url http://ac.lab.local:80/certsrv/mscep/mscep.dll',
      'exit',
    ]);

    expect(await config(r))
      .toContain('enrollment url http://ac.lab.local:80/certsrv/mscep/mscep.dll');
  });
});

describe('`no crypto pki trustpoint` supprime le point', () => {
  it('il disparait de la configuration', async () => {
    const r = await enConfig(routeur());
    await taper(r, [...POINT, 'no crypto pki trustpoint MAISON']);

    expect(await config(r)).not.toContain('crypto pki trustpoint MAISON');
  });

  it('et de `show crypto pki trustpoints`', async () => {
    const r = await enConfig(routeur());
    await taper(r, [...POINT, 'no crypto pki trustpoint MAISON', 'end']);

    expect(await r.executeCommand('show crypto pki trustpoints'))
      .not.toContain('MAISON');
  });
});

describe('une valeur qu on ne sait pas evaluer est REFUSEE', () => {
  const FAUTIVES: ReadonlyArray<[string, string]> = [
    ['un mode d inscription inconnu', 'enrollment zorglub'],
    ['un controle de revocation inconnu', 'revocation-check zorglub'],
  ];

  for (const [nom, saisie] of FAUTIVES) {
    it(`${nom} — \`${saisie}\``, async () => {
      const r = await enConfig(routeur());
      await r.executeCommand('crypto pki trustpoint MAISON');

      expect(await r.executeCommand(saisie)).toMatch(REFUS);
    });

    it(`${nom} — et elle n entre pas dans la configuration`, async () => {
      const r = await enConfig(routeur());
      await taper(r, ['crypto pki trustpoint MAISON', saisie, 'exit']);

      expect(await config(r)).not.toContain('zorglub');
    });
  }
});

describe('`show crypto pki certificates` rend les certificats', () => {
  it('la vue existe', async () => {
    const r = routeur();
    await r.executeCommand('enable');

    expect(await r.executeCommand('show crypto pki certificates'))
      .not.toMatch(REFUS);
  });
});

describe('`crypto pki ?` decrit ses suites', () => {
  it('`trustpoint`, `authenticate` et `enroll` y sont decrits', async () => {
    const r = await enConfig(routeur());
    const vue = await r.executeCommand('crypto pki ?');

    expect(vue).toMatch(/^\s*trustpoint\s+\S/m);
    expect(vue).toMatch(/^\s*authenticate\s+\S/m);
    expect(vue).toMatch(/^\s*enroll\s+\S/m);
  });
});
