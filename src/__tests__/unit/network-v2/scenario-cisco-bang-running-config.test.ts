/**
 * Scénario 1 — Le caractère ! dans show running-config : commentaire ou
 * séparateur de section ?
 *
 * Le ! seul en début de ligne est un séparateur de section purement
 * visuel ; un ! à l'intérieur d'une valeur (description, username) fait
 * partie intégrante de la valeur. Les règles de parsing du scénario
 * (is_section_separator / is_informational_comment /
 * parse_running_config) sont transcrites en TypeScript dans ce fichier
 * et appliquées à la sortie réelle du simulateur.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

// ─── Règles de parsing du scénario, transcrites du pseudocode ───────

function isSectionSeparator(line: string): boolean {
  return line.trim() === '!';
}

function isInformationalComment(line: string): boolean {
  return line.startsWith('!') && line.trim().length > 1;
}

interface ParsedSection { directive: string; children: string[] }

function parseRunningConfig(configLines: string[]): ParsedSection[] {
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;
  for (const line of configLines) {
    if (isSectionSeparator(line)) {
      if (current) sections.push(current);
      current = null;
    } else if (line.startsWith(' ') && current) {
      current.children.push(line.trim());
    } else if (!line.startsWith('!') && line.trim().length > 0) {
      if (current) sections.push(current);
      current = { directive: line.trim(), children: [] };
    }
  }
  if (current) sections.push(current);
  return sections;
}

async function buildMandengRouter(): Promise<CiscoRouter> {
  const r = new CiscoRouter('Router');
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('hostname SW-MANDENG-01');
  await r.executeCommand('ip domain-name mandeng.lan');
  await r.executeCommand('interface GigabitEthernet0/0');
  await r.executeCommand('description UPLINK-TO-ROUTER');
  await r.executeCommand('ip address 192.168.10.1 255.255.255.0');
  await r.executeCommand('exit');
  await r.executeCommand('line vty 0 4');
  await r.executeCommand('exec-timeout 5 0');
  await r.executeCommand('login local');
  await r.executeCommand('transport input ssh');
  await r.executeCommand('exit');
  await r.executeCommand('end');
  return r;
}

describe('Scénario 1 — Le caractère ! dans show running-config', () => {
  describe('structure réelle d\'un show running-config', () => {
    it('commence par Building configuration..., contient des ! séparateurs seuls, se termine par end', async () => {
      const r = await buildMandengRouter();
      const run = await r.executeCommand('show running-config');
      const lines = run.split('\n');

      expect(lines[0]).toBe('Building configuration...');
      expect(run).toMatch(/^Current configuration/m);
      expect(lines[lines.length - 1]).toBe('end');

      const separators = lines.filter((l) => /^!$/.test(l));
      expect(separators.length).toBeGreaterThan(0);

      // Chaque bloc AVEC enfants (interface, line …) est fermé par un !
      // de séparation — IOS groupe en revanche les directives d'une seule
      // ligne (ip route, service …) sans ! entre chacune.
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith(' ')) continue;
        // Dernière ligne enfant d'un bloc : la suivante non-enfant doit
        // être un séparateur ! ou end.
        if (i + 1 < lines.length && !lines[i + 1].startsWith(' ')) {
          expect(['!', 'end']).toContain(lines[i + 1]);
        }
      }
    });

    it('les blocs interface/line sont correctement délimités : leurs enfants sont indentés, le ! ferme le bloc', async () => {
      const r = await buildMandengRouter();
      const run = await r.executeCommand('show running-config');
      const sections = parseRunningConfig(run.split('\n'));

      const gi0 = sections.find((s) => s.directive === 'interface GigabitEthernet0/0');
      expect(gi0).toBeDefined();
      expect(gi0!.children).toContain('description UPLINK-TO-ROUTER');
      expect(gi0!.children).toContain('ip address 192.168.10.1 255.255.255.0');

      const vty = sections.find((s) => s.directive.startsWith('line vty'));
      expect(vty).toBeDefined();
      expect(vty!.children).toContain('exec-timeout 5 0');
      expect(vty!.children).toContain('transport input ssh');
    });
  });

  describe('règle 1 et 2 — ! séparateur vs commentaire informatif', () => {
    it('is_section_separator ne matche que le ! seul ; is_informational_comment le ! suivi de texte', () => {
      expect(isSectionSeparator('!')).toBe(true);
      expect(isSectionSeparator('!  ')).toBe(true);
      expect(isSectionSeparator('! Last configuration change at 08:42:15')).toBe(false);
      expect(isInformationalComment('! Last configuration change at 08:42:15')).toBe(true);
      expect(isInformationalComment('!')).toBe(false);
      expect(isInformationalComment('hostname SW-01')).toBe(false);
    });

    it('un ! seul tapé en mode configuration est ignoré silencieusement (pas d\'erreur, pas de changement de mode)', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      expect(await r.executeCommand('!')).toBe('');
      expect(r.getPrompt()).toBe('Router(config)#');
      expect(await r.executeCommand('! Last configuration change at 08:42:15 UTC')).toBe('');
      expect(r.getPrompt()).toBe('Router(config)#');
    });

    it('un ! est aussi accepté silencieusement au prompt EXEC (usage script)', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      expect(await r.executeCommand('!')).toBe('');
      expect(await r.executeCommand('! commentaire de script')).toBe('');
      expect(r.getPrompt()).toBe('Router#');
    });
  });

  describe('règle 3 / cas limite 1 — ! DANS une valeur de configuration', () => {
    it('description LIEN-PRINCIPAL!BACKUP-DISPONIBLE : le ! fait partie de la valeur et ne termine pas le bloc', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand('description LIEN-PRINCIPAL!BACKUP-DISPONIBLE');
      // La ligne suivante doit encore s'appliquer DANS le bloc interface :
      await r.executeCommand('ip address 192.168.10.1 255.255.255.0');
      await r.executeCommand('end');

      const run = await r.executeCommand('show running-config');
      expect(run).toContain('description LIEN-PRINCIPAL!BACKUP-DISPONIBLE');

      const sections = parseRunningConfig(run.split('\n'));
      const gi0 = sections.find((s) => s.directive === 'interface GigabitEthernet0/0');
      expect(gi0).toBeDefined();
      // Le ! dans la description n'a PAS coupé le bloc : description et
      // ip address sont enfants du même bloc interface.
      expect(gi0!.children).toContain('description LIEN-PRINCIPAL!BACKUP-DISPONIBLE');
      expect(gi0!.children).toContain('ip address 192.168.10.1 255.255.255.0');
    });

    it('vérification 2 — les descriptions contenant ! sont intactes dans show run', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand('description LIEN-PRINCIPAL!URGENT');
      await r.executeCommand('end');

      const run = await r.executeCommand('show running-config');
      const descLines = run.split('\n').filter((l) => l.includes('description') && l.includes('!'));
      expect(descLines).toEqual([' description LIEN-PRINCIPAL!URGENT']);
    });
  });

  describe('cas limite 3 — ! dans un username', () => {
    it('username admin!123 : le ! fait partie du nom d\'utilisateur', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('username admin!123 privilege 15 secret S3cret');
      await r.executeCommand('end');

      expect(r._getLocalUser('admin!123')).toBeDefined();
      expect(r._getLocalUser('admin!123')!.privilege).toBe(15);

      const run = await r.executeCommand('show running-config');
      expect(run).toMatch(/^username admin!123 privilege 15/m);
    });
  });

  describe('cas limite 4 — double !', () => {
    it('!! est traité comme un séparateur/commentaire : ignoré silencieusement', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      expect(await r.executeCommand('!!')).toBe('');
      // !! ne sort pas non plus du mode interface.
      expect(r.getPrompt()).toBe('Router(config-if)#');
      await r.executeCommand('end');
    });
  });

  describe('critère de réussite', () => {
    it('le simulateur ne confond jamais ! séparateur et ! de valeur ; show run reproduit la même structure', async () => {
      const r = await buildMandengRouter();
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/1');
      await r.executeCommand('description PC-LINUX-1!VLAN10');
      await r.executeCommand('end');

      const run = await r.executeCommand('show running-config');
      const lines = run.split('\n');

      // Vérification 3 du scénario (équivalent awk) : chaque bloc de
      // niveau 0 avec enfants garde ses CHILD indentés jusqu'au ! suivant.
      const sections = parseRunningConfig(lines);
      const gi1 = sections.find((s) => s.directive === 'interface GigabitEthernet0/1');
      expect(gi1!.children).toContain('description PC-LINUX-1!VLAN10');

      // Aucune directive parsée ne commence par ! (les séparateurs et
      // commentaires ont tous été filtrés par les règles 1 et 2).
      for (const s of sections) {
        expect(s.directive.startsWith('!')).toBe(false);
      }

      // Le ! dans la valeur est préservé, les ! séparateurs sont seuls
      // sur leur ligne, et chaque bloc à enfants est fermé par un !.
      expect(run).toContain('description PC-LINUX-1!VLAN10');
      expect(lines.filter((l) => /^!$/.test(l)).length).toBeGreaterThan(0);
      // Le bloc s'ouvre sur l'interface, porte la description avec son !
      // interne, et se ferme sur un ! seul — sans figer les autres lignes
      // que l'interface rend (` no ip address`, notamment).
      expect(run).toMatch(
        /^interface GigabitEthernet0\/1\n description PC-LINUX-1!VLAN10\n(?: .*\n)*!$/m,
      );
    });
  });
});
