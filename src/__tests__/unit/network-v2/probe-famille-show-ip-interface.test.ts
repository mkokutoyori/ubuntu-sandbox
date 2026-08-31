/**
 * Ecrit A L'AVEUGLE depuis la reference IOS, avant toute lecture du
 * code.
 *
 * `show ip interface brief` rend le tableau a cinq colonnes que tout
 * operateur connait — `Interface`, `IP-Address`, `OK?`, `Method`,
 * `Status`, `Protocol` — une ligne par interface, `unassigned` quand
 * aucune adresse n'est posee. `show ip interface` rend le detail de
 * TOUTES les interfaces, `show ip interface <nom>` celui d'une seule.
 *
 * C'est la commande la plus tapee de tout IOS, et elle existe sur un
 * routeur comme sur un Catalyst : chaque cas est joue des DEUX cotes.
 *
 * Ce qu'il ne faut pas confondre, et que la sonde verifie : `show ip
 * interface` n'est PAS `show interfaces`. La premiere decrit la couche
 * 3 — adresse, MTU d'IP, proxy ARP, listes de controle — la seconde la
 * couche 2. Rendre l'une pour l'autre est un defaut que ce depot a deja
 * ferme une fois.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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
  getPortNames(): string[];
}

const REFUS = /Invalid input|Incomplete command|Unknown command/;

function routeur(): Cli {
  const r = new CiscoRouter('R', 0, 0);
  r.powerOn();
  return r as unknown as Cli;
}

function catalyst(): Cli {
  const s = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
  s.powerOn();
  return s as unknown as Cli;
}

const PLATEFORMES: ReadonlyArray<[string, () => Cli]> = [
  ['routeur', routeur],
  ['commutateur', catalyst],
];

async function taper(d: Cli, lignes: readonly string[]): Promise<string[]> {
  const sorties: string[] = [];
  for (const ligne of lignes) sorties.push(await d.executeCommand(ligne));
  return sorties;
}

/**
 * Une interface de COUCHE 3, sur chaque plateforme.
 *
 * Un port de Catalyst est un port de commutation : `ip address` y est
 * refuse par `% IP addresses may not be configured on L2 links.`, ce
 * que fait un vrai IOS. La sonde l'exigeait d'abord sur un port
 * physique des deux cotes, et c'etait elle qui avait tort ; le
 * commutateur adresse son SVI, ce que tape un operateur.
 */
async function adressee(faire: () => Cli): Promise<{ cli: Cli; port: string }> {
  const d = faire();
  const physique = d.getPortNames()[0];
  await taper(d, ['enable', 'configure terminal', `interface ${physique}`]);
  const verdict = await d.executeCommand('ip address 10.0.0.1 255.255.255.0');
  if (!/L2 links/.test(verdict)) {
    await taper(d, ['no shutdown', 'end']);
    return { cli: d, port: physique };
  }
  await taper(d, [
    'exit', 'interface Vlan1',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end',
  ]);
  return { cli: d, port: 'Vlan1' };
}

describe('`show ip interface brief` rend le tableau a cinq colonnes', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — l en-tete porte les six intitules`, async () => {
      const d = faire();
      await d.executeCommand('enable');
      const entete = (await d.executeCommand('show ip interface brief')).split('\n')[0];

      for (const mot of ['Interface', 'IP-Address', 'OK?', 'Method', 'Status', 'Protocol']) {
        expect(entete).toContain(mot);
      }
    });

    it(`${nom} — une interface sans adresse porte \`unassigned\``, async () => {
      const d = faire();
      await d.executeCommand('enable');

      expect(await d.executeCommand('show ip interface brief'))
        .toContain('unassigned');
    });

    it(`${nom} — l adresse posee y figure`, async () => {
      const { cli } = await adressee(faire);

      expect(await cli.executeCommand('show ip interface brief'))
        .toContain('10.0.0.1');
    });

    it(`${nom} — chaque ligne nomme une interface REELLE`, async () => {
      const d = faire();
      await d.executeCommand('enable');
      const noms = new Set(d.getPortNames());
      const lignes = (await d.executeCommand('show ip interface brief'))
        .split('\n').slice(1).filter(l => l.trim().length > 0);

      expect(lignes.length).toBeGreaterThan(0);
      for (const ligne of lignes) {
        const nom = ligne.split(/\s+/)[0];
        expect(noms.has(nom) || /^Vlan\d+$/.test(nom)).toBe(true);
      }
    });
  }
});

describe('`show ip interface <nom>` decrit la COUCHE 3', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — l adresse et le masque y figurent`, async () => {
      const { cli, port } = await adressee(faire);

      expect(await cli.executeCommand(`show ip interface ${port}`))
        .toContain('10.0.0.1');
    });

    it(`${nom} — ce n est PAS le texte de \`show interfaces\``, async () => {
      const { cli, port } = await adressee(faire);
      const couche3 = await cli.executeCommand(`show ip interface ${port}`);
      const couche2 = await cli.executeCommand(`show interfaces ${port}`);

      expect(couche3).not.toBe(couche2);
    });

    it(`${nom} — l adresse de DIFFUSION est celle qu IOS rend par defaut`, async () => {
      const { cli, port } = await adressee(faire);

      expect(await cli.executeCommand(`show ip interface ${port}`))
        .toContain('Broadcast address is 255.255.255.255');
    });

    it(`${nom} — une interface INCONNUE est signalee`, async () => {
      const d = faire();
      await d.executeCommand('enable');

      expect(await d.executeCommand('show ip interface Zorglub0/9'))
        .toMatch(/Invalid input|not exist|Invalid interface/);
    });
  }
});

describe('`show ip interface` sans nom rend TOUTES les interfaces', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — plus d une interface y figure`, async () => {
      const d = faire();
      await d.executeCommand('enable');
      const vue = await d.executeCommand('show ip interface');
      const combien = d.getPortNames()
        .filter(n => vue.includes(n)).length;

      expect(combien).toBeGreaterThan(1);
    });
  }
});

describe('les deux vues s accordent sur les adresses', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — ce que le tableau montre, le detail le montre`, async () => {
      const { cli, port } = await adressee(faire);
      const bref = await cli.executeCommand('show ip interface brief');
      const detail = await cli.executeCommand(`show ip interface ${port}`);

      expect(bref.includes('10.0.0.1')).toBe(detail.includes('10.0.0.1'));
    });
  }
});

describe('la vue est joignable depuis l EXEC UTILISATEUR', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`${nom} — sans \`enable\``, async () => {
      const d = faire();

      expect(await d.executeCommand('show ip interface brief')).not.toMatch(REFUS);
    });
  }
});
