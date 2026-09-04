/**
 * `crypto key generate rsa` et `crypto key zeroize rsa` passent au socle.
 *
 * Sonde ecrite contre la reference IOS, avant lecture des gestionnaires :
 *
 *   crypto key generate rsa [ general-keys | usage-keys ]
 *                           [ label <nom> ] [ exportable ]
 *                           [ modulus <360-4096> ]
 *   crypto key zeroize rsa [ <nom> ]
 *
 * POURQUOI CETTE FAMILLE. Elle est portee IDENTIQUEMENT par les deux
 * plateformes — le releve des chemins encore au trie la donne mot pour
 * mot des deux cotes — et elle est PORTEUSE : ce depot documente que
 * `crypto key zeroize rsa` coupe reellement le serveur SSH et que
 * `crypto key generate rsa` le remonte, `Router.hasSshHostKeys()` etant
 * le joint. Une commande qui decide si la machine est joignable ne doit
 * pas accepter ce qu'elle ne lit pas.
 *
 * CE QUE CETTE SONDE DEMANDE, sans rien lire du code : que le module
 * annonce et applique la plage 360-4096, qu'un mot-cle inconnu soit
 * refuse, que les options declarees soient toutes acceptees, et que la
 * consequence reelle — SSH tombe, SSH revient — reste vraie apres la
 * migration.
 *
 * CE QU'ELLE NE DEMANDE DELIBEREMENT PAS : que la taille du module
 * change quoi que ce soit a la cle. Ce simulateur ne fabrique pas une
 * cle RSA de la taille demandee par cette commande — c'est `openssl
 * genrsa` qui en fabrique une vraie — et pretendre le contraire serait
 * le decor que ce depot refuse. La sonde demande que la valeur soit
 * BORNEE et RETENUE, pas qu'elle soit calculee.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

type Dev = {
  executeCommand(c: string): Promise<string>;
  cliHelp(s: string): string;
};

async function enConfig(d: Dev): Promise<Dev> {
  for (const c of ['enable', 'configure terminal']) await d.executeCommand(c);
  return d;
}

const routeur = (n: string) => enConfig(new CiscoRouter(n) as unknown as Dev);
const commutateur = (n: string) =>
  enConfig(new CiscoSwitch('switch-cisco', n) as unknown as Dev);

const PLATEFORMES: ReadonlyArray<readonly [string, (n: string) => Promise<Dev>]> = [
  ['routeur', routeur], ['commutateur', commutateur],
];

const cle = (s: string) => s.replace(/\W/g, '');

const PRET = ['ip domain-name lab.local'];

describe('la plage du module est annoncee ET appliquee', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it.each(['359', '4097', 'zorglub'])(
      `\`crypto key generate rsa modulus %s\` est refuse sur un ${nom}`, async (v) => {
        const d = await faire(`A${nom[0]}${cle(v)}`);
        for (const c of PRET) await d.executeCommand(c);
        expect(String(await d.executeCommand(`crypto key generate rsa modulus ${v}`)))
          .toContain('% Invalid');
      });

    it.each(['360', '1024', '4096'])(
      `\`crypto key generate rsa modulus %s\` est accepte sur un ${nom}`, async (v) => {
        const d = await faire(`B${nom[0]}${cle(v)}`);
        for (const c of PRET) await d.executeCommand(c);
        expect(String(await d.executeCommand(`crypto key generate rsa modulus ${v}`)))
          .not.toContain('% Invalid');
      });
  }

  it('`crypto key generate rsa modulus ?` annonce la plage', async () => {
    const d = await routeur('A1');
    expect(d.cliHelp('crypto key generate rsa modulus ')).toContain('<360-4096>');
  });

  it('`crypto key generate rsa modulus` sans valeur dit INCOMPLET', async () => {
    const d = await routeur('A2');
    for (const c of PRET) await d.executeCommand(c);
    expect(String(await d.executeCommand('crypto key generate rsa modulus')))
      .toContain('% Incomplete command.');
  });
});

describe('les options declarees par IOS sont acceptees', () => {
  it.each(['crypto key generate rsa',
    'crypto key generate rsa general-keys',
    'crypto key generate rsa usage-keys',
    'crypto key generate rsa general-keys modulus 1024',
    'crypto key generate rsa label MACLE modulus 1024',
    'crypto key generate rsa general-keys label MACLE exportable modulus 2048',
    'crypto key generate rsa exportable'])(
    '`%s` est accepte', async (ligne) => {
      const d = await routeur(`C${cle(ligne)}`);
      for (const c of PRET) await d.executeCommand(c);
      expect(String(await d.executeCommand(ligne))).not.toContain('% Invalid');
    });

  it.each(['crypto key generate rsa zorglub',
    'crypto key generate rsa modulus 1024 zorglub',
    'crypto key generate zorglub',
    'crypto key zorglub'])(
    '`%s` est refuse', async (ligne) => {
      const d = await routeur(`D${cle(ligne)}`);
      for (const c of PRET) await d.executeCommand(c);
      expect(String(await d.executeCommand(ligne))).toContain('% Invalid');
    });
});

describe('la consequence reelle : SSH tombe et SSH revient', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`sur un ${nom}, la cle se cree puis se detruit`, async () => {
      const d = await faire(`E${nom[0]}`);
      for (const c of PRET) await d.executeCommand(c);
      await d.executeCommand('crypto key generate rsa modulus 1024');
      await d.executeCommand('end');
      expect(String(await d.executeCommand('show crypto key mypubkey rsa')))
        .not.toContain('% No RSA key');
      await d.executeCommand('configure terminal');
      await d.executeCommand('crypto key zeroize rsa');
      await d.executeCommand('end');
      expect(String(await d.executeCommand('show crypto key mypubkey rsa')))
        .toContain('% No RSA key');
    });
  }

  it('sans `ip domain-name`, IOS refuse de generer', async () => {
    const d = await routeur('E1');
    const out = String(await d.executeCommand('crypto key generate rsa modulus 1024'));
    expect(out).toContain('%');
    await d.executeCommand('end');
    expect(String(await d.executeCommand('show crypto key mypubkey rsa')))
      .toContain('% No RSA key');
  });
});

describe('la meme frappe recoit la meme reponse sur les deux plateformes', () => {
  it.each(['crypto key generate rsa modulus 4097',
    'crypto key generate rsa zorglub',
    'crypto key zeroize rsa',
    'crypto key zorglub'])(
    '`%s`', async (ligne) => {
      const r = await routeur(`F${cle(ligne)}`);
      const s = await commutateur(`G${cle(ligne)}`);
      for (const c of PRET) { await r.executeCommand(c); await s.executeCommand(c); }
      const surR = String(await r.executeCommand(ligne)).trim();
      const surS = String(await s.executeCommand(ligne)).trim();
      expect(surS, `routeur=${JSON.stringify(surR)}`).toBe(surR);
    });
});

describe('non-regression — les voisines de la famille `crypto`', () => {
  it('`crypto key zeroize rsa MACLE` reste accepte', async () => {
    const d = await routeur('H1');
    for (const c of PRET) await d.executeCommand(c);
    await d.executeCommand('crypto key generate rsa label MACLE modulus 1024');
    expect(String(await d.executeCommand('crypto key zeroize rsa MACLE')))
      .not.toContain('% Invalid');
  });

  it.each(['crypto isakmp policy 10', 'crypto ipsec transform-set TS esp-aes'])(
    '`%s` reste accepte sur un routeur', async (ligne) => {
      const d = await routeur(`H${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).not.toContain('% Invalid');
    });

  it('`crypto ?` annonce toujours la famille', async () => {
    const d = await routeur('H2');
    expect(d.cliHelp('crypto ')).toContain('key');
  });
});
