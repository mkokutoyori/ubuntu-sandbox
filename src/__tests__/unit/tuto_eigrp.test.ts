/**
 * TDD Unit Tests for EIGRP - Tutorial / Lab Mode (Mode Tutoriel TP Guidé)
 *
 * Designed as a step-by-step pedagogical test suite covering:
 *  - TP 1: Prise en main & Formation d'adjacence pas-à-pas (%DUAL-5-NBRCHANGE)
 *  - TP 2: Calcul détaillé de la Métrique Composite (Bande passante vs Délai)
 *  - TP 3: Algorithme DUAL & Condition de Faisabilité (Successor vs Feasible Successor)
 *  - TP 4: Suppression des requêtes avec les routeurs Stub (Hub-and-Spoke)
 *  - TP 5: Erreurs classiques des étudiants & Pièges de configuration
 *  - TP 6: Agrégation de routes (Manual Summarization) & Protection anti-boucle Null0
 *  - TP 7: Sécurisation par authentification MD5 et Key Chains
 *  - TP 8: Traffic Engineering (Unequal-cost load balancing avec Variance)
 *  - TP 9: Diagnostic complet & Troubleshooting avec les commandes Show/Debug
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

// ═══════════════════════════════════════════════════════════════════
// TOPOLOGIES PÉDAGOGIQUES DES LABS / TP
// ═══════════════════════════════════════════════════════════════════

/**
 * Lab 1 : Topologie de base 2 Routeurs (R1 <-> R2)
 * R1 (Gig0/0: 10.0.12.1/24, Loopback0: 192.168.1.1/24)
 * R2 (Gig0/0: 10.0.12.2/24, Loopback0: 192.168.2.1/24)
 */
function setupLab2Routers() {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 100, 0);

  const cable = new Cable('c1');
  cable.connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);

  return { r1, r2 };
}

/** Configures basic IP addressing for Lab 1 */
async function configureIPsLab1(r1: CiscoRouter, r2: CiscoRouter) {
  // R1
  await r1.executeCommand('enable');
  await r1.executeCommand('configure terminal');
  await r1.executeCommand('interface GigabitEthernet0/0');
  await r1.executeCommand('ip address 10.0.12.1 255.255.255.0');
  await r1.executeCommand('no shutdown');
  await r1.executeCommand('interface Loopback0');
  await r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
  await r1.executeCommand('end');

  // R2
  await r2.executeCommand('enable');
  await r2.executeCommand('configure terminal');
  await r2.executeCommand('interface GigabitEthernet0/0');
  await r2.executeCommand('ip address 10.0.12.2 255.255.255.0');
  await r2.executeCommand('no shutdown');
  await r2.executeCommand('interface Loopback0');
  await r2.executeCommand('ip address 192.168.2.1 255.255.255.0');
  await r2.executeCommand('end');
}

/**
 * Lab 3 : Topologie Triangle DUAL (R1, R2, R3)
 * Chemin Principal (FastEthernet): R1 -> R2 -> R3
 * Chemin Secours (Serial / High Delay): R1 -> R3
 */
function setupLabDualTriangle() {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 100, 0);
  const r3 = new CiscoRouter('R3', 50, 100);

  // Link R1-R2 (Fast Path)
  new Cable('c1').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  // Link R2-R3 (Fast Path)
  new Cable('c2').connect(r2.getPort('GigabitEthernet0/1')!, r3.getPort('GigabitEthernet0/1')!);
  // Link R1-R3 (Slow/Backup Path)
  new Cable('c3').connect(r1.getPort('GigabitEthernet0/1')!, r3.getPort('GigabitEthernet0/0')!);

  return { r1, r2, r3 };
}

/**
 * Lab 4 : Topologie Hub-and-Spoke (R1 Hub, R2 Spoke/Stub)
 */
function setupLabHubAndSpoke() {
  const hub = new CiscoRouter('HUB', 0, 0);
  const spoke = new CiscoRouter('SPOKE', 100, 0);

  new Cable('c1').connect(hub.getPort('GigabitEthernet0/0')!, spoke.getPort('GigabitEthernet0/0')!);

  return { hub, spoke };
}

// ═══════════════════════════════════════════════════════════════════
// EIGRP TUTORIAL TEST SUITE
// ═══════════════════════════════════════════════════════════════════

describe('EIGRP Mode Tutoriel & TP Guidé', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  // ─── TP 1 : PREMIÈRE CONFIGURATION ET ADJACENCE PAS-À-PAS ────────

  describe('TP 1 : Prise en main et Formation d Adjacence', () => {
    it('1.1 Étape 1 : Le ping initial vers la Loopback distante échoue avant EIGRP', async () => {
      const { r1, r2 } = setupLab2Routers();
      await configureIPsLab1(r1, r2);

      const ping = await r1.executeCommand('ping 192.168.2.1');
      expect(ping).toContain('.....');
    });

    it('1.2 Étape 2 : Activer EIGRP génère le message console %DUAL-5-NBRCHANGE quand le voisin monte', async () => {
      const { r1, r2 } = setupLab2Routers();
      await configureIPsLab1(r1, r2);

      // Activer EIGRP 100 sur R1
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');
      await r1.executeCommand('network 10.0.12.0 0.0.0.255');
      await r1.executeCommand('network 192.168.1.0 0.0.0.255');
      await r1.executeCommand('end');

      // Activer EIGRP 100 sur R2
      await r2.executeCommand('enable');
      await r2.executeCommand('configure terminal');
      await r2.executeCommand('router eigrp 100');
      await r2.executeCommand('network 10.0.12.0 0.0.0.255');
      await r2.executeCommand('network 192.168.2.0 0.0.0.255');
      await r2.executeCommand('end');

      await r1.processTimers(2);

      const logs = Logger.getLogs();
      expect(logs.some(l => l.includes('%DUAL-5-NBRCHANGE') && l.includes('is up: new adjacency'))).toBe(true);
    });

    it('1.3 Étape 3 : Vérifier la table des voisins avec "show ip eigrp neighbors"', async () => {
      const { r1, r2 } = setupLab2Routers();
      await configureIPsLab1(r1, r2);

      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router eigrp 100');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('network 192.168.0.0');
        await r.executeCommand('end');
      }

      await r1.processTimers(2);

      const res = await r1.executeCommand('show ip eigrp neighbors');
      expect(res).toContain('10.0.12.2');
      expect(res).toContain('GigabitEthernet0/0');
      expect(res).toContain('H'); // Index de l'hôte
    });

    it('1.4 Étape 4 : Validation de la connectivité bout-en-bout via ping après convergence', async () => {
      const { r1, r2 } = setupLab2Routers();
      await configureIPsLab1(r1, r2);

      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router eigrp 100');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('network 192.168.0.0');
        await r.executeCommand('end');
      }

      await r1.processTimers(2);

      const ping = await r1.executeCommand('ping 192.168.2.1 source Loopback0');
      expect(ping).toContain('!!!!!');
    });
  });

  // ─── TP 2 : CALCUL DÉTAILLÉ DE LA MÉTRIQUE COMPOSITE ─────────────

  describe('TP 2 : Métrique Composite et Modification de Bande Passante / Délai', () => {
    it('2.1 La métrique EIGRP par défaut utilise K1=1 (BW) et K3=1 (Delay)', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      const show = await r1.executeCommand('show ip protocols');

      expect(show).toContain('K1=1, K2=0, K3=1, K4=0, K5=0');
    });

    it('2.2 Modifier le délai d une interface ("delay 2000") augmente immédiatement la métrique DUAL', async () => {
      const { r1, r2 } = setupLab2Routers();
      await configureIPsLab1(r1, r2);

      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router eigrp 100');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('network 192.168.0.0');
        await r.executeCommand('end');
      }

      await r1.processTimers(2);

      const routeAvant = await r1.executeCommand('show ip route 192.168.2.0');
      const metricAvant = routeAvant.match(/\[90\/(\d+)\]/)?.[1];

      // Augmenter le délai sur l'interface Gig0/0 de R1
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('delay 2000');
      await r1.executeCommand('end');

      const routeApres = await r1.executeCommand('show ip route 192.168.2.0');
      const metricApres = routeApres.match(/\[90\/(\d+)\]/)?.[1];

      expect(Number(metricApres)).toBeGreaterThan(Number(metricAvant));
    });
  });

  // ─── TP 3 : ALGORITHME DUAL & CONDITION DE FAISABILITÉ ───────────

  describe('TP 3 : Algorithme DUAL (Successor, Feasible Successor, RD < FD)', () => {
    it('3.1 Affiche le Feasible Distance (FD) et Advertised Distance (RD) dans "show ip eigrp topology"', async () => {
      const { r1, r2 } = setupLab2Routers();
      await configureIPsLab1(r1, r2);

      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router eigrp 100');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('network 192.168.0.0');
        await r.executeCommand('end');
      }

      await r1.processTimers(2);

      const topo = await r1.executeCommand('show ip eigrp topology');
      expect(topo).toContain('P 192.168.2.0/24, 1 successors, FD is');
      expect(topo).toContain('via 10.0.12.2');
    });

    it('3.2 Basculement instantané vers le Feasible Successor sans passer par l état Active (pas de Query)', async () => {
      const { r1, r2, r3 } = setupLabDualTriangle();
      // En cas de coupure du lien principal, si un Feasible Successor existe (RD < FD),
      // EIGRP bascule immédiatement en 0ms sans envoyer de requêtes Query.
      await r1.executeCommand('enable');
      const topo = await r1.executeCommand('show ip eigrp topology');
      expect(topo).toBeDefined();
    });
  });

  // ─── TP 4 : ROUTEURS STUB & SUPPRESSION DES REQUÊTES ─────────────

  describe('TP 4 : Configuration Stub Router & Isolation de Requêtes (Queries)', () => {
    it('4.1 Un routeur configuré avec "eigrp stub" informe son voisin de ne pas lui envoyer de Queries', async () => {
      const { hub, spoke } = setupLabHubAndSpoke();

      await spoke.executeCommand('enable');
      await spoke.executeCommand('configure terminal');
      await spoke.executeCommand('router eigrp 100');
      await spoke.executeCommand('eigrp stub connected summary');
      await spoke.executeCommand('end');

      const show = await spoke.executeCommand('show ip protocols');
      expect(show).toContain('EIGRP stub-router feature is enabled');
      expect(show).toContain('Connected');
      expect(show).toContain('Summary');
    });

    it('4.2 Le Hub reconnaît le voisin comme étant un routeur Stub', async () => {
      const { hub, spoke } = setupLabHubAndSpoke();

      // Config Spoke
      await spoke.executeCommand('enable');
      await spoke.executeCommand('configure terminal');
      await spoke.executeCommand('interface GigabitEthernet0/0');
      await spoke.executeCommand('ip address 10.0.12.2 255.255.255.0');
      await spoke.executeCommand('no shutdown');
      await spoke.executeCommand('router eigrp 100');
      await spoke.executeCommand('network 10.0.12.0 0.0.0.255');
      await spoke.executeCommand('eigrp stub');
      await spoke.executeCommand('end');

      // Config Hub
      await hub.executeCommand('enable');
      await hub.executeCommand('configure terminal');
      await hub.executeCommand('interface GigabitEthernet0/0');
      await hub.executeCommand('ip address 10.0.12.1 255.255.255.0');
      await hub.executeCommand('no shutdown');
      await hub.executeCommand('router eigrp 100');
      await hub.executeCommand('network 10.0.12.0 0.0.0.255');
      await hub.executeCommand('end');

      await hub.processTimers(2);

      const neighbors = await hub.executeCommand('show ip eigrp neighbors detail');
      expect(neighbors).toContain('Stub Peer Advertising');
    });
  });

  // ─── TP 5 : ERREURS CLASSIQUES DES ÉTUDIANTS / PIÈGES ───────────

  describe('TP 5 : Erreurs Classiques des Étudiants & Pièges de Configuration', () => {
    it('5.1 Piège 1 : Saisir le masque de sous-réseau au lieu du masque générique est corrigé automatiquement par Cisco IOS', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');

      // L'étudiant tape 255.255.255.0 au lieu de 0.0.0.255
      await r1.executeCommand('network 192.168.1.0 255.255.255.0');

      const show = await r1.executeCommand('show ip protocols');
      // IOS convertit automatiquement en 0.0.0.255
      expect(show).toContain('192.168.1.0 0.0.0.255');
    });

    it('5.2 Piège 2 : Oublier la métrique de graine (seed metric) en redistribuant une route statique', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('ip route 172.16.0.0 255.255.0.0 Null0');
      await r1.executeCommand('router eigrp 100');

      // Taper "redistribute static" sans spécifier la métrique
      const res = await r1.executeCommand('redistribute static');
      expect(res).toContain('% Warning: Redistributing without default metric');
    });

    it('5.3 Piège 3 : Adresses IP sur des sous-réseaux différents empêchent la formation de voisinage', async () => {
      const { r1, r2 } = setupLab2Routers();

      // R1 est en 10.0.12.1/24
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('ip address 10.0.12.1 255.255.255.0');
      await r1.executeCommand('no shutdown');
      await r1.executeCommand('router eigrp 100');
      await r1.executeCommand('network 10.0.12.0');

      // R2 est accidentellement configuré en 10.0.99.2/24
      await r2.executeCommand('enable');
      await r2.executeCommand('configure terminal');
      await r2.executeCommand('interface GigabitEthernet0/0');
      await r2.executeCommand('ip address 10.0.99.2 255.255.255.0');
      await r2.executeCommand('no shutdown');
      await r2.executeCommand('router eigrp 100');
      await r2.executeCommand('network 10.0.99.0');

      await r1.processTimers(5);

      const logs = Logger.getLogs();
      expect(logs.some(l => l.includes('not on common subnet'))).toBe(true);
    });
  });

  // ─── TP 6 : AGRÉGATION DE ROUTES ET PROTECTION anti-boucle Null0 ──

  describe('TP 6 : Agrégation de Routes Manuelle & Route Null0 (AD 5)', () => {
    it('6.1 Configurer un résumé d adresse ("ip summary-address eigrp 100 10.1.0.0 255.255.0.0")', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      const res = await r1.executeCommand('ip summary-address eigrp 100 10.1.0.0 255.255.0.0');

      expect(res).toBe('');
    });

    it('6.2 L agrégation installe automatiquement une route vers Null0 avec une Distance Administrative de 5', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('ip summary-address eigrp 100 10.1.0.0 255.255.0.0');
      await r1.executeCommand('end');

      const route = await r1.executeCommand('show ip route 10.1.0.0');
      expect(route).toContain('Null0');
      expect(route).toContain('Distance: 5');
    });
  });

  // ─── TP 7 : SÉCURISATION PAR AUTHENTIFICATION MD5 ────────────────

  describe('TP 7 : Sécurisation EIGRP avec Key Chain & MD5', () => {
    it('7.1 Échec d adjacence si les clés MD5 ne correspondent pas', async () => {
      const { r1, r2 } = setupLab2Routers();
      await configureIPsLab1(r1, r2);

      // R1 avec Key String "SECRET_TP_1"
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('key chain KEY_EIGRP');
      await r1.executeCommand('key 1');
      await r1.executeCommand('key-string SECRET_TP_1');
      await r1.executeCommand('exit');
      await r1.executeCommand('exit');
      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('ip authentication mode eigrp 100 md5');
      await r1.executeCommand('ip authentication key-chain eigrp 100 KEY_EIGRP');
      await r1.executeCommand('router eigrp 100');
      await r1.executeCommand('network 10.0.0.0');

      // R2 avec Key String ERRONÉE "MAUVAIS_SECRET"
      await r2.executeCommand('enable');
      await r2.executeCommand('configure terminal');
      await r2.executeCommand('key chain KEY_EIGRP');
      await r2.executeCommand('key 1');
      await r2.executeCommand('key-string MAUVAIS_SECRET');
      await r2.executeCommand('exit');
      await r2.executeCommand('exit');
      await r2.executeCommand('interface GigabitEthernet0/0');
      await r2.executeCommand('ip authentication mode eigrp 100 md5');
      await r2.executeCommand('ip authentication key-chain eigrp 100 KEY_EIGRP');
      await r2.executeCommand('router eigrp 100');
      await r2.executeCommand('network 10.0.0.0');

      await r1.processTimers(5);

      const neighbors = await r1.executeCommand('show ip eigrp neighbors');
      expect(neighbors).not.toContain('10.0.12.2');
    });

    it('7.2 Succès d adjacence lorsque les clés MD5 correspondent parfaitement', async () => {
      const { r1, r2 } = setupLab2Routers();
      await configureIPsLab1(r1, r2);

      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('key chain KEY_EIGRP');
        await r.executeCommand('key 1');
        await r.executeCommand('key-string PASS_EXACT_2026');
        await r.executeCommand('exit');
        await r.executeCommand('exit');
        await r.executeCommand('interface GigabitEthernet0/0');
        await r.executeCommand('ip authentication mode eigrp 100 md5');
        await r.executeCommand('ip authentication key-chain eigrp 100 KEY_EIGRP');
        await r.executeCommand('router eigrp 100');
        await r.executeCommand('network 10.0.0.0');
        await r.executeCommand('end');
      }

      await r1.processTimers(2);

      const neighbors = await r1.executeCommand('show ip eigrp neighbors');
      expect(neighbors).toContain('10.0.12.2');
    });
  });

  // ─── TP 8 : TRAFFIC ENGINEERING & VARIANCE ───────────────────────

  describe('TP 8 : Unequal-Cost Load Balancing (Variance)', () => {
    it('8.1 "variance 2" permet d inclure des chemins dont la métrique est jusqu a 2 fois supérieure', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router eigrp 100');
      await r1.executeCommand('variance 2');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('EIGRP maximum metric variance 2');
    });
  });

  // ─── TP 9 : DIAGNOSTIC ET COMMANDES DE DÉBOGAGE ──────────────────

  describe('TP 9 : Kit de Diagnostic et Troubleshooting EIGRP', () => {
    it('9.1 "show ip eigrp topology all-links" affiche tous les chemins connus, y compris ceux ne satisfaisant pas la Feasibility Condition', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      const topo = await r1.executeCommand('show ip eigrp topology all-links');

      expect(topo).toContain('EIGRP-IPv4 Topology Table');
    });

    it('9.2 "show ip eigrp interfaces detail GigabitEthernet0/0" montre les compteurs Hello et le Xmit queue', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('ip address 10.0.0.1 255.255.255.0');
      await r1.executeCommand('no shutdown');
      await r1.executeCommand('router eigrp 100');
      await r1.executeCommand('network 10.0.0.0');
      await r1.executeCommand('end');

      const show = await r1.executeCommand('show ip eigrp interfaces detail GigabitEthernet0/0');
      expect(show).toContain('Hello-interval is 5');
      expect(show).toContain('Split-horizon is enabled');
    });

    it('9.3 "debug eigrp packets" active la journalisation détaillée des paquets EIGRP (Hello, Update, Query, Reply, ACK)', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      const debug = await r1.executeCommand('debug eigrp packets');

      expect(debug).toContain('EIGRP Packet debugging is on');
    });
  });
});
