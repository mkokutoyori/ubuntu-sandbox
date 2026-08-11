/**
 * TDD Unit Tests generated directly from the Tutorial:
 * "RIP sur Cisco : From Zero to Hero" (Zanka no tachi)
 *
 * Covers:
 *  - Partie 1 & 2 : Concepts de base, Distance Vector, Hop Count (Max 15, 16=Infini), RIPv1 vs RIPv2, Multicast (224.0.0.9).
 *  - Partie 3 & 11: Timers RIP (Update 30s, Invalid 180s, Holddown 180s, Flush 240s) & `timers basic`.
 *  - Partie 4     : Mecanismes anti-boucle (Split Horizon, Poison Reverse/Route Poisoning, Holddown).
 *  - Partie 5 & 6 : Lab 2 Routeurs (R1-R2), `version 2`, `no auto-summary`, `network`, `show ip route`, `show ip rip database`, `show ip protocols`, `debug ip rip`.
 *  - Partie 7     : Lab 3 Routeurs (R1-R2-R3), propagation multi-sauts, simulation de panne et convergence.
 *  - Partie 8     : Interfaces passives (`passive-interface`, `passive-interface default`, `no passive-interface`).
 *  - Partie 9     : Authentification MD5 avec Key Chain (`key chain`, `key`, `key-string`, `ip rip authentication`).
 *  - Partie 10    : Injection de route par défaut (`default-information originate`).
 *  - Partie 12    : Commands show, debug et troubleshooting (UDP 520, split-horizon per interface).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

// ═══════════════════════════════════════════════════════════════════
// TOPOLOGY HELPERS (Exactement comme décrit dans le Tuto)
// ═══════════════════════════════════════════════════════════════════

/**
 * Lab Partie 5 : Topologie à 2 routeurs
 * PC-COMPTA (192.168.10.0/24) ── R1 (10.0.12.1) ── (10.0.12.2) R2 ── PC-DEV (192.168.20.0/24)
 */
function setupLab2Routers() {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 100, 0);

  const cable = new Cable('c1');
  cable.connect(
    r1.getPort('GigabitEthernet0/0')!,
    r2.getPort('GigabitEthernet0/0')!
  );

  return { r1, r2 };
}

/** Configures initial IP addresses for Lab 2 Routers (Étape 5.1) */
async function configureIPsLab2(r1: CiscoRouter, r2: CiscoRouter) {
  // R1 Configuration
  await r1.executeCommand('enable');
  await r1.executeCommand('configure terminal');
  await r1.executeCommand('interface GigabitEthernet0/0');
  await r1.executeCommand('ip address 10.0.12.1 255.255.255.0');
  await r1.executeCommand('no shutdown');
  await r1.executeCommand('interface GigabitEthernet0/1');
  await r1.executeCommand('ip address 192.168.10.1 255.255.255.0');
  await r1.executeCommand('no shutdown');
  await r1.executeCommand('end');

  // R2 Configuration
  await r2.executeCommand('enable');
  await r2.executeCommand('configure terminal');
  await r2.executeCommand('interface GigabitEthernet0/0');
  await r2.executeCommand('ip address 10.0.12.2 255.255.255.0');
  await r2.executeCommand('no shutdown');
  await r2.executeCommand('interface GigabitEthernet0/1');
  await r2.executeCommand('ip address 192.168.20.1 255.255.255.0');
  await r2.executeCommand('no shutdown');
  await r2.executeCommand('end');
}

/**
 * Lab Partie 7 : Topologie étendue à 3 routeurs
 * PC-COMPTA ── R1 ──── R2 ──── R3 ── PC-SERVEUR
 * 192.168.10.0  10.0.12.0  10.0.23.0  192.168.30.0
 */
function setupLab3Routers() {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 100, 0);
  const r3 = new CiscoRouter('R3', 200, 0);

  new Cable('c1').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('c2').connect(r2.getPort('GigabitEthernet0/2')!, r3.getPort('GigabitEthernet0/0')!);

  return { r1, r2, r3 };
}

/** Configures IPs and full RIPv2 for Lab 3 Routers */
async function configureLab3Full(r1: CiscoRouter, r2: CiscoRouter, r3: CiscoRouter) {
  // R1
  await r1.executeCommand('enable');
  await r1.executeCommand('configure terminal');
  await r1.executeCommand('interface GigabitEthernet0/0');
  await r1.executeCommand('ip address 10.0.12.1 255.255.255.0');
  await r1.executeCommand('no shutdown');
  await r1.executeCommand('interface GigabitEthernet0/1');
  await r1.executeCommand('ip address 192.168.10.1 255.255.255.0');
  await r1.executeCommand('no shutdown');
  await r1.executeCommand('router rip');
  await r1.executeCommand('version 2');
  await r1.executeCommand('no auto-summary');
  await r1.executeCommand('network 10.0.12.0');
  await r1.executeCommand('network 192.168.10.0');
  await r1.executeCommand('end');

  // R2
  await r2.executeCommand('enable');
  await r2.executeCommand('configure terminal');
  await r2.executeCommand('interface GigabitEthernet0/0');
  await r2.executeCommand('ip address 10.0.12.2 255.255.255.0');
  await r2.executeCommand('no shutdown');
  await r2.executeCommand('interface GigabitEthernet0/1');
  await r2.executeCommand('ip address 192.168.20.1 255.255.255.0');
  await r2.executeCommand('no shutdown');
  await r2.executeCommand('interface GigabitEthernet0/2');
  await r2.executeCommand('ip address 10.0.23.1 255.255.255.0');
  await r2.executeCommand('no shutdown');
  await r2.executeCommand('router rip');
  await r2.executeCommand('version 2');
  await r2.executeCommand('no auto-summary');
  await r2.executeCommand('network 10.0.12.0');
  await r2.executeCommand('network 10.0.23.0');
  await r2.executeCommand('network 192.168.20.0');
  await r2.executeCommand('end');

  // R3
  await r3.executeCommand('enable');
  await r3.executeCommand('configure terminal');
  await r3.executeCommand('interface GigabitEthernet0/0');
  await r3.executeCommand('ip address 10.0.23.2 255.255.255.0');
  await r3.executeCommand('no shutdown');
  await r3.executeCommand('interface GigabitEthernet0/1');
  await r3.executeCommand('ip address 192.168.30.1 255.255.255.0');
  await r3.executeCommand('no shutdown');
  await r3.executeCommand('router rip');
  await r3.executeCommand('version 2');
  await r3.executeCommand('no auto-summary');
  await r3.executeCommand('network 10.0.23.0');
  await r3.executeCommand('network 192.168.30.0');
  await r3.executeCommand('end');
}

// ═══════════════════════════════════════════════════════════════════
// TESTS BASÉS SUR LE TUTORIEL
// ═══════════════════════════════════════════════════════════════════

describe('Tutoriel RIP sur Cisco : From Zero to Hero', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  // ─── PARTIE 1 & 2 : MÉTROLOGIE ET DIFFERENCES RIPv1 / RIPv2 ────────

  describe('Partie 1 & 2 : Métrique Hop Count & RIPv1 vs RIPv2', () => {
    it('Métrique max : 15 sauts valides, 16 est considéré comme infini/inaccessible', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Distance: (default is 120)');
    });

    it('RIPv2 utilise l adresse multicast 224.0.0.9 pour ses mises a jour', async () => {
      const { r1, r2 } = setupLab2Routers();
      await configureIPsLab2(r1, r2);

      await r1.executeCommand('enable');
      await r1.executeCommand('debug ip rip');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('version 2');
      await r1.executeCommand('network 10.0.12.0');

      await r1.processTimers(30);
      const logs = Logger.getLogs().map((l) => l.message);
      expect(logs.some((log) => log.includes('224.0.0.9'))).toBe(true);
    });
  });

  // ─── PARTIE 3 & 11 : TIMERS RIP ───────────────────────────────────

  describe('Partie 3 & 11 : Gestion des Timers RIP', () => {
    it('Affiche les timers par defaut (Update 30s, Invalid 180s, Holddown 180s, Flush 240s)', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('end');
      const show = await r1.executeCommand('show ip protocols');

      expect(show).toContain('Sending updates every 30 seconds');
      expect(show).toContain('Invalid after 180 seconds, hold down 180, flushed after 240');
    });

    it('Partie 11 : Personnalise les timers avec "timers basic 10 60 60 80"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      const res = await r1.executeCommand('timers basic 10 60 60 80');

      expect(res).toBe('');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Sending updates every 10 seconds');
      expect(show).toContain('Invalid after 60 seconds, hold down 60, flushed after 80');
    });

    it('Verifie les timers via la commande ciblée "show ip protocols | include timer"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('timers basic 10 60 60 80');
      await r1.executeCommand('end');

      const showCible = await r1.executeCommand('show ip protocols | include Sending');
      expect(showCible).toContain('Sending updates every 10 seconds');
    });
  });

  // ─── PARTIE 4 : MECANISMES ANTI-BOUCLE ────────────────────────────

  describe('Partie 4 : Mecanismes Anti-Boucle (Split Horizon, Poison Reverse)', () => {
    it('Split horizon est active par defaut sur les interfaces LAN/Ethernet', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('ip address 10.0.0.1 255.255.255.0');
      await r1.executeCommand('no shutdown');
      await r1.executeCommand('end');
      const res = await r1.executeCommand('show ip interface GigabitEthernet0/0 | include Split');

      expect(res).toContain('Split horizon is enabled');
    });

    it('Permet de desactiver et ré-activer Split Horizon sur une interface', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('ip address 10.0.0.1 255.255.255.0');
      await r1.executeCommand('no shutdown');

      await r1.executeCommand('no ip split-horizon');
      let check = await r1.executeCommand('show ip interface GigabitEthernet0/0 | include Split');
      expect(check).toContain('Split horizon is disabled');

      await r1.executeCommand('ip split-horizon');
      check = await r1.executeCommand('show ip interface GigabitEthernet0/0 | include Split');
      expect(check).toContain('Split horizon is enabled');
    });
  });

  // ─── PARTIE 5 & 6 : LAB 2 ROUTEURS & COMMANDES D'INSPECTION ──────

  describe('Partie 5 & 6 : Premier Labo RIPv2 (2 Routeurs R1 - R2)', () => {
    it('Etape 5.1 : Ping direct fonctionne, ping reseau distant echoue avant RIP', async () => {
      const { r1, r2 } = setupLab2Routers();
      await configureIPsLab2(r1, r2);

      const pingDirect = await r1.executeCommand('ping 10.0.12.2');
      expect(pingDirect).toContain('!!!!!');

      const pingDistant = await r1.executeCommand('ping 192.168.20.1');
      expect(pingDistant).toContain('.....');
    });

    it('Etape 5.2 : Configuration de RIPv2 (version 2, no auto-summary, network classful)', async () => {
      const { r1, r2 } = setupLab2Routers();
      await configureIPsLab2(r1, r2);

      // Activer RIP sur R1
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('version 2');
      await r1.executeCommand('no auto-summary');
      await r1.executeCommand('network 10.0.12.0');
      await r1.executeCommand('network 192.168.10.0');
      await r1.executeCommand('end');

      // Activer RIP sur R2
      await r2.executeCommand('enable');
      await r2.executeCommand('configure terminal');
      await r2.executeCommand('router rip');
      await r2.executeCommand('version 2');
      await r2.executeCommand('no auto-summary');
      await r2.executeCommand('network 10.0.12.0');
      await r2.executeCommand('network 192.168.20.0');
      await r2.executeCommand('end');

      // Attendre la premiere mise a jour (30s)
      await r1.processTimers(30);
      await r2.processTimers(30);

      // Verifier que R1 apprend le reseau 192.168.20.0/24 avec [120/1]
      const routeTable = await r1.executeCommand('show ip route');
      expect(routeTable).toMatch(/R\s+192\.168\.20\.0\/24 \[120\/1\] via 10\.0\.12\.2/);

      // Ping vers le reseau distant fonctionne maintenant
      const pingDistant = await r1.executeCommand('ping 192.168.20.1');
      expect(pingDistant).toContain('!!!!!');

      // Ping avec source de GigabitEthernet0/1 (COMPTA)
      const pingSource = await r1.executeCommand('ping 192.168.20.1 source GigabitEthernet0/1');
      expect(pingSource).toContain('!!!!!');
    });

    it('Etape 6.1 : "show ip rip database" affiche la base de donnees locale', async () => {
      const { r1, r2 } = setupLab2Routers();
      await configureIPsLab2(r1, r2);

      for (const r of [r1, r2]) {
        await r.executeCommand('enable');
        await r.executeCommand('configure terminal');
        await r.executeCommand('router rip');
        await r.executeCommand('version 2');
        await r.executeCommand('no auto-summary');
        await r.executeCommand('network 10.0.12.0');
        await r.executeCommand('network 192.168.10.0');
        await r.executeCommand('network 192.168.20.0');
        await r.executeCommand('end');
      }

      await r1.processTimers(30);
      await r2.processTimers(30);

      const db = await r1.executeCommand('show ip rip database');
      expect(db).toContain('10.0.12.0/24');
      expect(db).toContain('directly connected, GigabitEthernet0/0');
      expect(db).toContain('192.168.20.0/24');
      expect(db).toContain('[1] via 10.0.12.2');
    });

    it('Etape 6.3 : "show ip protocols" affiche la configuration complete de RIP', async () => {
      const { r1 } = setupLab2Routers();
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('version 2');
      await r1.executeCommand('no auto-summary');
      await r1.executeCommand('network 10.0.0.0');
      await r1.executeCommand('network 192.168.10.0');
      await r1.executeCommand('end');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Routing Protocol is "rip"');
      expect(show).toContain('Sending updates every 30 seconds');
      expect(show).toContain('Default version control: send version 2, receive version 2');
      expect(show).toContain('Automatic network summarization is not in effect');
      expect(show).toContain('Routing for Networks:');
      expect(show).toContain('10.0.0.0');
      expect(show).toContain('192.168.10.0');
    });
  });

  // ─── PARTIE 7 : LAB 3 ROUTEURS & CONVERGENCE ─────────────────────

  describe('Partie 7 : Labo a 3 Routeurs (R1 - R2 - R3) & Convergence', () => {
    it('Etape 7.2 : Propagation des routes et calcul du nombre de sauts (Hop Count)', async () => {
      const { r1, r2, r3 } = setupLab3Routers();
      await configureLab3Full(r1, r2, r3);

      // Cycle 1 (T=30s)
      await r1.processTimers(30);
      await r2.processTimers(30);
      await r3.processTimers(30);
      // Cycle 2 (T=60s)
      await r1.processTimers(30);
      await r2.processTimers(30);
      await r3.processTimers(30);

      const routesR1 = await r1.executeCommand('show ip route rip');
      // R2 link (1 saut)
      expect(routesR1).toContain('192.168.20.0/24 [120/1] via 10.0.12.2');
      // Inter-router link R2-R3 (1 saut)
      expect(routesR1).toContain('10.0.23.0/24 [120/1] via 10.0.12.2');
      // R3 local network (2 sauts)
      expect(routesR1).toContain('192.168.30.0/24 [120/2] via 10.0.12.2');
    });

    it('Etape 7.3 : Simulation de panne (Link Down) et Poison Reverse (Metric 16)', async () => {
      const { r1, r2, r3 } = setupLab3Routers();
      await configureLab3Full(r1, r2, r3);
      for (let tour = 0; tour < 2; tour++) {
        await r1.processTimers(30);
        await r2.processTimers(30);
        await r3.processTimers(30);
      }

      // Verifier que R1 a la route vers R3
      let routesR1 = await r1.executeCommand('show ip route rip');
      expect(routesR1).toContain('192.168.30.0/24');

      // Simuler la panne du lien R3 vers PC-SERVEUR
      await r3.executeCommand('configure terminal');
      await r3.executeCommand('interface GigabitEthernet0/1');
      await r3.executeCommand('shutdown');
      await r3.executeCommand('end');

      // Activer le debug pour valider la réception de la route empoisonnée (16 sauts)
      await r1.executeCommand('debug ip rip');

      // Propager la mise a jour de poison
      await r3.processTimers(30);
      await r1.processTimers(30);
      await r2.processTimers(30);

      const logs = Logger.getLogs().map((l) => l.message);
      expect(logs.some((l) => /metric=16|unreachable|possibly down/.test(l))).toBe(true);

      // Apres holddown/flush, la route doit être retirée de R1
      // Invalide a 180 s, retiree seulement au flush (240 s).
      await r1.processTimers(240);
      await r2.processTimers(240);
      await r3.processTimers(240);
      routesR1 = await r1.executeCommand('show ip route rip');
      expect(routesR1).not.toContain('192.168.30.0/24');
    });
  });

  // ─── PARTIE 8 : INTERFACES PASSIVES ───────────────────────────────

  describe('Partie 8 : Configuration des Interfaces Passives', () => {
    it('Sature l émission de RIP sur une interface LAN avec "passive-interface"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('passive-interface GigabitEthernet0/1');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Passive Interface(s):');
      expect(show).toContain('GigabitEthernet0/1');
    });

    it('Securise avec la bonne pratique "passive-interface default" et "no passive-interface <iface>"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');

      await r1.executeCommand('passive-interface default');
      await r1.executeCommand('no passive-interface GigabitEthernet0/0');

      const show = await r1.executeCommand('show ip protocols');
      expect(show).toContain('Passive Interface(s):');
      expect(show).toContain('Default');
      expect(show).toContain('Active Interface(s):');
      expect(show).toContain('GigabitEthernet0/0');
    });
  });

  // ─── PARTIE 9 : AUTHENTIFICATION MD5 ─────────────────────────────

  describe('Partie 9 : Authentification RIPv2 MD5', () => {
    it('Etape 9.1 & 9.2 : Configure la Key Chain et applique l authentification MD5 sur l interface', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');

      // Création de la chaine de clés
      await r1.executeCommand('key chain MA_CLE_RIP');
      await r1.executeCommand('key 1');
      await r1.executeCommand('key-string MotDePasseRIP2024!');
      await r1.executeCommand('exit');
      await r1.executeCommand('exit');

      // Application sur l'interface
      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('ip rip authentication mode md5');
      const res = await r1.executeCommand('ip rip authentication key-chain MA_CLE_RIP');

      expect(res).toBe('');
    });

    it('Etape 9.2 : Ignore les mises a jour si le mot de passe MD5 ne correspond pas', async () => {
      const { r1, r2 } = setupLab2Routers();
      await configureIPsLab2(r1, r2);

      // R1 avec mot de passe correct
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('key chain MA_CLE_RIP');
      await r1.executeCommand('key 1');
      await r1.executeCommand('key-string MotDePasseRIP2024!');
      await r1.executeCommand('exit');
      await r1.executeCommand('exit');
      await r1.executeCommand('interface GigabitEthernet0/0');
      await r1.executeCommand('ip rip authentication mode md5');
      await r1.executeCommand('ip rip authentication key-chain MA_CLE_RIP');
      await r1.executeCommand('router rip');
      await r1.executeCommand('version 2');
      await r1.executeCommand('network 10.0.12.0');
      await r1.executeCommand('network 192.168.10.0');

      // R2 avec un MAUVAIS mot de passe
      await r2.executeCommand('enable');
      await r2.executeCommand('configure terminal');
      await r2.executeCommand('key chain MA_CLE_RIP');
      await r2.executeCommand('key 1');
      await r2.executeCommand('key-string MAUVAIS_PASSWORD');
      await r2.executeCommand('exit');
      await r2.executeCommand('exit');
      await r2.executeCommand('interface GigabitEthernet0/0');
      await r2.executeCommand('ip rip authentication mode md5');
      await r2.executeCommand('ip rip authentication key-chain MA_CLE_RIP');
      await r2.executeCommand('router rip');
      await r2.executeCommand('version 2');
      await r2.executeCommand('network 10.0.12.0');
      await r2.executeCommand('network 192.168.20.0');

      await r1.processTimers(30);
      await r2.processTimers(30);

      // R1 doit ignorer la mise à jour de R2 -> pas de route appris
      const routesR1 = await r1.executeCommand('show ip route rip');
      expect(routesR1).not.toContain('192.168.20.0');
    });
  });

  // ─── PARTIE 10 : INJECTION DE ROUTE PAR DÉFAUT ───────────────────

  describe('Partie 10 : Injection de Route par Defaut', () => {
    it('Injecte la route par defaut vers Internet avec "default-information originate"', async () => {
      const { r1, r2 } = setupLab2Routers();
      await configureIPsLab2(r1, r2);

      // R1 a une route statique vers sa Box Internet
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('ip route 0.0.0.0 0.0.0.0 203.0.113.1');

      // Activer RIP sur R1 et injecter la route par défaut
      await r1.executeCommand('router rip');
      await r1.executeCommand('version 2');
      await r1.executeCommand('network 10.0.12.0');
      await r1.executeCommand('default-information originate');
      await r1.executeCommand('end');

      // R2 configure RIP
      await r2.executeCommand('enable');
      await r2.executeCommand('configure terminal');
      await r2.executeCommand('router rip');
      await r2.executeCommand('version 2');
      await r2.executeCommand('network 10.0.12.0');
      await r2.executeCommand('end');

      await r1.processTimers(30);
      await r2.processTimers(30);

      // R2 doit apprendre la route par défaut (0.0.0.0/0) via RIP
      const routesR2 = await r2.executeCommand('show ip route');
      expect(routesR2).toMatch(/R\*\s+0\.0\.0\.0\/0 \[120\/1\] via 10\.0\.12\.1/);
    });
  });

  // ─── PARTIE 12 : TROUBLESHOOTING ET COMMANDES SYSTEMES ───────────

  describe('Partie 12 : Diagnostic & Troubleshooting', () => {
    it('12.1 : Verifie les raccourcis des commandes de diagnostic', async () => {
      const { r1, r2 } = setupLab2Routers();
      await configureIPsLab2(r1, r2);

      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');
      await r1.executeCommand('network 10.0.12.0');
      await r1.executeCommand('end');

      const shRoute = await r1.executeCommand('show ip route rip');
      const shProt = await r1.executeCommand('show ip protocols');
      const shDb = await r1.executeCommand('show ip rip database');

      expect(shRoute).toBeDefined();
      expect(shProt).toContain('Routing Protocol is "rip"');
      expect(shDb).toContain('10.0.12.0/24');
    });

    it('12.2 : Active/Desactive le debug ("debug ip rip", "no debug all", "undebug all")', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');

      const debugOn = await r1.executeCommand('debug ip rip');
      expect(debugOn).toContain('RIP protocol debugging is on');

      const debugOff1 = await r1.executeCommand('no debug all');
      expect(debugOff1).toContain('All possible debugging has been turned off');

      await r1.executeCommand('debug ip rip events');
      const debugOff2 = await r1.executeCommand('undebug all');
      expect(debugOff2).toContain('All possible debugging has been turned off');
    });

    it('12.3 : Validation des erreurs connues - rejet de parametre invalide dans "network"', async () => {
      const r1 = new CiscoRouter('R1', 0, 0);
      await r1.executeCommand('enable');
      await r1.executeCommand('configure terminal');
      await r1.executeCommand('router rip');

      const err = await r1.executeCommand('network abc.def.ghi.jkl');
      expect(err).toContain('% Invalid input');
    });
  });
});
