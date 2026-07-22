/**
 * Scénario 6 — Parsing de show running-config par section : indentation
 * et hiérarchie.
 *
 * Cisco indente les enfants d'un bloc avec EXACTEMENT 1 espace (jamais
 * de tabulation ni de 2 espaces). Le parseur hiérarchique du scénario
 * (ConfigNode / parse_running_config_hierarchical / reconstruct) est
 * transcrit ici et appliqué à la sortie réelle du simulateur : un cycle
 * parse → arbre → reconstruction → re-parse doit produire le même arbre.
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

// ─── Parseur hiérarchique du scénario, transcrit ───────────────────

interface ConfigNode {
  line: string;
  level: number;
  children: ConfigNode[];
}

function parseRunningConfigHierarchical(rawConfig: string): ConfigNode[] {
  const lines = rawConfig.split('\n');
  const rootNodes: ConfigNode[] = [];
  let currentParent: ConfigNode | null = null;

  for (const line of lines) {
    if (!line.trim() || line.trim() === '!') {
      currentParent = null;
      continue;
    }
    if (line.startsWith('Building') || line.startsWith('Current configuration')) continue;
    if (line.trim() === 'end') break;

    const stripped = line.replace(/^ +/, '');
    const indent = line.length - stripped.length;
    const node: ConfigNode = { line: stripped, level: indent, children: [] };

    if (indent === 0) {
      rootNodes.push(node);
      currentParent = node;
    } else if (currentParent) {
      currentParent.children.push(node);
    }
  }
  return rootNodes;
}

function reconstructShowRun(nodes: ConfigNode[]): string {
  const out: string[] = ['Building configuration...', '', 'Current configuration : 0 bytes', '!'];
  for (const node of nodes) {
    out.push(' '.repeat(node.level) + node.line);
    for (const child of node.children) {
      out.push(' '.repeat(child.level) + child.line);
      for (const grandchild of child.children) {
        out.push(' '.repeat(grandchild.level) + grandchild.line);
      }
    }
    out.push('!');
  }
  out.push('end');
  return out.join('\n');
}

async function buildFullRouter(): Promise<CiscoRouter> {
  const r = new CiscoRouter('Router');
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('hostname SW-MANDENG-01');
  await r.executeCommand('ip domain-name mandeng.lan');
  await r.executeCommand('interface GigabitEthernet0/0');
  await r.executeCommand('description UPLINK-TO-ROUTER');
  await r.executeCommand('ip address 192.168.10.1 255.255.255.0');
  await r.executeCommand('exit');
  await r.executeCommand('router ospf 1');
  await r.executeCommand('router-id 1.1.1.1');
  await r.executeCommand('network 192.168.10.0 0.0.0.255 area 0');
  await r.executeCommand('exit');
  await r.executeCommand('ip access-list extended VTY-ACCESS');
  await r.executeCommand('10 permit tcp 192.168.99.0 0.0.0.255 any eq 22');
  await r.executeCommand('20 deny ip any any log');
  await r.executeCommand('exit');
  await r.executeCommand('line vty 0 4');
  await r.executeCommand('exec-timeout 5 0');
  await r.executeCommand('transport input ssh');
  await r.executeCommand('exit');
  await r.executeCommand('end');
  return r;
}

describe('Scénario 6 — Parsing hiérarchique de show running-config', () => {
  describe('structure d\'indentation', () => {
    it('toutes les lignes indentées utilisent exactement 1 espace — jamais de tabulation ni de 2 espaces', async () => {
      const r = await buildFullRouter();
      const run = await r.executeCommand('show running-config');
      for (const line of run.split('\n')) {
        expect(line).not.toMatch(/^\t/);
        if (/^\s/.test(line) && line.trim().length > 0) {
          // Indentation Cisco : exactement 1 espace de tête.
          expect(line).toMatch(/^ [^ ]/);
        }
      }
    });

    it('les commandes globales sont à indentation 0, les membres de bloc à 1', async () => {
      const r = await buildFullRouter();
      const run = await r.executeCommand('show running-config');
      const nodes = parseRunningConfigHierarchical(run);

      const hostname = nodes.find((n) => n.line.startsWith('hostname'));
      expect(hostname).toBeDefined();
      expect(hostname!.level).toBe(0);
      expect(hostname!.children).toEqual([]);

      const gi0 = nodes.find((n) => n.line === 'interface GigabitEthernet0/0');
      expect(gi0).toBeDefined();
      for (const child of gi0!.children) {
        expect(child.level).toBe(1);
      }
      expect(gi0!.children.map((c) => c.line)).toContain('description UPLINK-TO-ROUTER');
      expect(gi0!.children.map((c) => c.line)).toContain('ip address 192.168.10.1 255.255.255.0');
    });
  });

  describe('parseur hiérarchique', () => {
    it('router ospf 1 : router-id et network sont des enfants de niveau 1', async () => {
      const r = await buildFullRouter();
      const run = await r.executeCommand('show running-config');
      const nodes = parseRunningConfigHierarchical(run);

      const ospf = nodes.find((n) => n.line === 'router ospf 1');
      expect(ospf).toBeDefined();
      const childLines = ospf!.children.map((c) => c.line);
      expect(childLines).toContain('router-id 1.1.1.1');
      expect(childLines.some((l) => l.startsWith('network 192.168.10.0 0.0.0.255 area 0'))).toBe(true);
    });

    it('ip access-list extended : les entrées séquencées sont des enfants du bloc', async () => {
      const r = await buildFullRouter();
      const run = await r.executeCommand('show running-config');
      const nodes = parseRunningConfigHierarchical(run);

      const acl = nodes.find((n) => n.line.startsWith('ip access-list extended VTY-ACCESS'));
      expect(acl).toBeDefined();
      const childLines = acl!.children.map((c) => c.line);
      expect(childLines.some((l) => /^10 permit tcp 192\.168\.99\.0 0\.0\.0\.255 any eq 22/.test(l))).toBe(true);
      expect(childLines.some((l) => /^20 deny\s+ip any any log/.test(l))).toBe(true);
    });

    it('cas limite — description longue avec espaces préservée intégralement', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand('description LIEN PRINCIPAL VERS SWITCH COEUR - VLAN TRUNK');
      await r.executeCommand('end');

      const run = await r.executeCommand('show running-config');
      const nodes = parseRunningConfigHierarchical(run);
      const gi0 = nodes.find((n) => n.line === 'interface GigabitEthernet0/0');
      expect(gi0!.children.map((c) => c.line))
        .toContain('description LIEN PRINCIPAL VERS SWITCH COEUR - VLAN TRUNK');
    });
  });

  describe('reconstruction depuis l\'arbre', () => {
    it('cycle parse → arbre → reconstruction → re-parse : arbres identiques', async () => {
      const r = await buildFullRouter();
      const run = await r.executeCommand('show running-config');

      const tree1 = parseRunningConfigHierarchical(run);
      const rebuilt = reconstructShowRun(tree1);
      const tree2 = parseRunningConfigHierarchical(rebuilt);

      expect(tree2).toEqual(tree1);
    });

    it('la reconstruction sépare chaque bloc de niveau 0 par un !', async () => {
      const r = await buildFullRouter();
      const run = await r.executeCommand('show running-config');
      const tree = parseRunningConfigHierarchical(run);
      const rebuilt = reconstructShowRun(tree).split('\n');

      // Après chaque fin de bloc, la ligne suivante est ! ou end.
      const separators = rebuilt.filter((l) => l === '!');
      expect(separators.length).toBe(tree.length + 1); // 1 d'en-tête + 1 par bloc
      expect(rebuilt[rebuilt.length - 1]).toBe('end');
    });

    it('la configuration reconstruite se recolle sur un routeur vierge et produit la même hiérarchie', async () => {
      const r = await buildFullRouter();
      const run = await r.executeCommand('show running-config');
      const rebuilt = reconstructShowRun(parseRunningConfigHierarchical(run));

      const fresh = new CiscoRouter('Router');
      await fresh.executeCommand('enable');
      await fresh.executeCommand('configure terminal');
      for (const line of rebuilt.split('\n')) {
        await fresh.executeCommand(line);
      }

      const freshRun = await fresh.executeCommand('show running-config');
      const originalTree = parseRunningConfigHierarchical(run);
      const freshTree = parseRunningConfigHierarchical(freshRun);

      // Les blocs configurés se retrouvent à l'identique.
      for (const wanted of ['interface GigabitEthernet0/0', 'router ospf 1']) {
        const a = originalTree.find((n) => n.line === wanted)!;
        const b = freshTree.find((n) => n.line === wanted)!;
        expect(b).toBeDefined();
        for (const child of a.children) {
          expect(b.children.map((c) => c.line)).toContain(child.line);
        }
      }
      expect(freshTree.find((n) => n.line === 'hostname SW-MANDENG-01')).toBeDefined();
    });
  });

  describe('critère de réussite', () => {
    it('round-trip exact, blocs séparés par !, indentation 1 espace partout', async () => {
      const r = await buildFullRouter();
      const run = await r.executeCommand('show running-config');

      // Round-trip stable.
      const t1 = parseRunningConfigHierarchical(run);
      const t2 = parseRunningConfigHierarchical(reconstructShowRun(t1));
      expect(t2).toEqual(t1);

      // ! de séparation présents dans la sortie du simulateur.
      expect(run.split('\n').filter((l) => l === '!').length).toBeGreaterThanOrEqual(t1.length - 1);

      // Aucune tabulation, aucune indentation ≥ 2 espaces.
      expect(run).not.toMatch(/^\t/m);
      expect(run).not.toMatch(/^ {2,}\S/m);
    });
  });
});
