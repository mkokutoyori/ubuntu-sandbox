/**
 * Ecrit A L'AVEUGLE depuis la reference IOS, avant toute lecture du
 * code.
 *
 * `ip access-list standard <nom>` et `ip access-list extended <nom>`
 * entrent dans le sous-mode d'une liste NOMMEE ; on y ecrit `permit`,
 * `deny` et `remark`, chacun pouvant etre precede d'un NUMERO DE
 * SEQUENCE. `no <numero>` retire l'entree de ce rang.
 * `ip access-list resequence <nom> <debut> <pas>` renumerote.
 * `show ip access-lists` rend les listes avec leurs numeros de
 * sequence, et la configuration les relit.
 *
 * Ce que ce depot tient pour regle et que la sonde verifie : une
 * saisie qu'on ne sait pas evaluer est REFUSEE plutot que rangee — une
 * liste qui contient une regle inerte est plus dangereuse qu'une liste
 * qui manque.
 *
 * UNE premisse etait fausse et elle est corrigee ici plutot
 * qu'effacee : la VUE n'a pas la syntaxe de la CONFIGURATION. IOS ecrit
 * `10 permit 192.168.10.0, wildcard bits 0.0.0.255` dans
 * `show ip access-lists` la ou l'on TAPE `permit 192.168.10.0
 * 0.0.0.255` ; le simulateur rendait deja la premiere forme.
 *
 * La sonde n'a trouve AUCUN autre defaut : cette famille est fidele, et
 * elle est donc un garde-fou de migration.
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

describe('`ip access-list` ouvre le sous-mode de la liste nommee', () => {
  it('la forme STANDARD entre en (config-std-nacl)', async () => {
    const r = await enConfig(routeur());
    await r.executeCommand('ip access-list standard BUREAUX');

    expect(r.getPrompt()).toMatch(/\(config-std-nacl\)#$/);
  });

  it('la forme ETENDUE entre en (config-ext-nacl)', async () => {
    const r = await enConfig(routeur());
    await r.executeCommand('ip access-list extended SERVEURS');

    expect(r.getPrompt()).toMatch(/\(config-ext-nacl\)#$/);
  });

  it('`exit` revient en configuration globale', async () => {
    const r = await enConfig(routeur());
    await taper(r, ['ip access-list standard BUREAUX', 'exit']);

    expect(r.getPrompt()).toMatch(/\(config\)#$/);
  });

  it('sans nom, la commande est incomplete', async () => {
    const r = await enConfig(routeur());

    expect(await r.executeCommand('ip access-list standard'))
      .toMatch(/Incomplete command/);
  });

  it('une SORTE inconnue est refusee', async () => {
    const r = await enConfig(routeur());

    expect(await r.executeCommand('ip access-list zorglub NOM'))
      .toMatch(/Invalid input/);
  });

  it('le nom garde sa CASSE', async () => {
    const r = await enConfig(routeur());
    await taper(r, ['ip access-list standard Bureaux-RH', 'permit any', 'exit']);

    expect(await config(r)).toContain('Bureaux-RH');
  });
});

describe('les entrees se posent, se relisent et se retirent', () => {
  async function avecListe(): Promise<Cli> {
    const r = await enConfig(routeur());
    await taper(r, [
      'ip access-list standard BUREAUX',
      'permit 192.168.10.0 0.0.0.255',
      'deny any',
      'exit',
    ]);
    return r;
  }

  it('`permit` et `deny` paraissent dans `show ip access-lists`', async () => {
    const r = await avecListe();
    await r.executeCommand('end');
    const vue = await r.executeCommand('show ip access-lists');

    expect(vue).toContain('BUREAUX');
    expect(vue).toContain('permit 192.168.10.0, wildcard bits 0.0.0.255');
    expect(vue).toContain('deny');
  });

  it('la vue porte des NUMEROS DE SEQUENCE', async () => {
    const r = await avecListe();
    await r.executeCommand('end');

    expect(await r.executeCommand('show ip access-lists')).toMatch(/^\s*10 /m);
  });

  it('la liste se relit dans la configuration', async () => {
    const r = await avecListe();
    const vue = await config(r);

    expect(vue).toContain('ip access-list standard BUREAUX');
    expect(vue).toContain('permit 192.168.10.0 0.0.0.255');
  });

  it('`remark` est accepte et rendu', async () => {
    const r = await enConfig(routeur());
    await taper(r, [
      'ip access-list standard BUREAUX',
      'remark Acces des postes du siege',
      'permit any',
      'exit',
    ]);

    expect(await config(r)).toContain('remark Acces des postes du siege');
  });

  it('un numero de sequence explicite est HONORE', async () => {
    const r = await enConfig(routeur());
    await taper(r, [
      'ip access-list standard BUREAUX',
      '30 permit 10.0.0.0 0.0.0.255',
      'exit', 'end',
    ]);

    expect(await r.executeCommand('show ip access-lists')).toMatch(/^\s*30 permit/m);
  });

  it('`no <numero>` retire l entree de ce rang', async () => {
    const r = await enConfig(routeur());
    await taper(r, [
      'ip access-list standard BUREAUX',
      '10 permit 10.0.0.0 0.0.0.255',
      '20 permit 10.0.1.0 0.0.0.255',
      'no 10',
      'exit', 'end',
    ]);
    const vue = await r.executeCommand('show ip access-lists');

    expect(vue).not.toContain('10.0.0.0');
    expect(vue).toContain('10.0.1.0');
  });
});

describe('une entree qu on ne sait pas evaluer est REFUSEE', () => {
  const FAUTIVES: ReadonlyArray<[string, string]> = [
    ['un protocole inexistant', 'permit zorglub any any'],
    ['un mot a la place de l action', 'permit deny any any'],
    ['une adresse malformee', 'permit 999.1.1.1 0.0.0.255'],
    ['un port hors plage', 'permit tcp any any eq 99999'],
    ['une plage de ports a l envers', 'permit tcp any any range 200 100'],
  ];

  for (const [nom, saisie] of FAUTIVES) {
    it(`${nom} — \`${saisie}\``, async () => {
      const r = await enConfig(routeur());
      await r.executeCommand('ip access-list extended SERVEURS');

      expect(await r.executeCommand(saisie)).toMatch(REFUS);
    });

    it(`${nom} — et elle n entre pas dans la liste`, async () => {
      const r = await enConfig(routeur());
      await taper(r, ['ip access-list extended SERVEURS', saisie, 'exit', 'end']);

      expect(await r.executeCommand('show ip access-lists'))
        .not.toContain(saisie.split(' ')[1]);
    });
  }
});

describe('`ip access-list resequence` renumerote', () => {
  it('les rangs suivent le debut et le pas demandes', async () => {
    const r = await enConfig(routeur());
    await taper(r, [
      'ip access-list standard BUREAUX',
      'permit 10.0.0.0 0.0.0.255',
      'permit 10.0.1.0 0.0.0.255',
      'exit',
      'ip access-list resequence BUREAUX 100 50',
      'end',
    ]);
    const vue = await r.executeCommand('show ip access-lists');

    expect(vue).toMatch(/^\s*100 permit/m);
    expect(vue).toMatch(/^\s*150 permit/m);
  });
});

describe('`no ip access-list` supprime la liste', () => {
  it('elle disparait de la configuration', async () => {
    const r = await enConfig(routeur());
    await taper(r, [
      'ip access-list standard BUREAUX', 'permit any', 'exit',
      'no ip access-list standard BUREAUX',
    ]);

    expect(await config(r)).not.toContain('ip access-list standard BUREAUX');
  });
});

describe('`ip access-list ?` decrit ses sortes', () => {
  it('`standard`, `extended` et `resequence` y sont decrits', async () => {
    const r = await enConfig(routeur());
    const vue = await r.executeCommand('ip access-list ?');

    expect(vue).toMatch(/^\s*standard\s+\S/m);
    expect(vue).toMatch(/^\s*extended\s+\S/m);
    expect(vue).toMatch(/^\s*resequence\s+\S/m);
  });
});
