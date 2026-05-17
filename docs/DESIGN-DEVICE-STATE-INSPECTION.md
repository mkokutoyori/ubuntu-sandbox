# DESIGN — Couche d'inspection d'état des équipements (show / display)

**Version** : 1.0
**Date** : 2026-05-17
**Projet** : Ubuntu Sandbox — Couche `show`/`display` routeurs & switches
**Auteur** : Claude Code
**Références** : CiscoShellBase.ts, HuaweiVRPShell.ts, Equipment.ts, Port.ts,
Cable.ts, OSPFEngine.ts, Router.ts, CiscoCommonShow.ts

---

## Table des matières

1. [Problème & principe directeur](#1-problème--principe-directeur)
2. [Politique « Hybride » (no-stub)](#2-politique-hybride-no-stub)
3. [Architecture en 3 couches](#3-architecture-en-3-couches)
4. [Contrats : DeviceStateView & DTO](#4-contrats--devicestateview--dto)
5. [Couche rendu : Strategy par vendeur](#5-couche-rendu--strategy-par-vendeur)
6. [Sous-systèmes config-driven : Repository d'état](#6-sous-systèmes-config-driven--repository-détat)
7. [Patterns & SOLID](#7-patterns--solid)
8. [Disposition des fichiers](#8-disposition-des-fichiers)
9. [Stratégie de test (TDD)](#9-stratégie-de-test-tdd)
10. [Plan de migration incrémental](#10-plan-de-migration-incrémental)

---

## 1. Problème & principe directeur

Les commandes `show` (Cisco) / `display` (Huawei) doivent **refléter
l'état interne réel** de l'équipement simulé. Aucune valeur ne doit
être inventée (« stub » / hardcodé) : ni voisin fictif, ni route
fantôme, ni compteur CPU fabriqué.

**Principe** : *toute sortie d'une commande d'inspection est une
projection pure d'un état réellement détenu par le modèle.* Si l'état
n'existe pas, la sortie est l'état honnête « non configuré / non
instrumenté » — jamais une fabrication plausible.

---

## 2. Politique « Hybride » (no-stub)

Décision validée : **Hybride**.

| Catégorie | Exemples | Traitement |
|---|---|---|
| **Topologie réelle** | CDP/LLDP voisins, `show interfaces`, ARP, routes | Dérivé du graphe `Equipment`/`Port`/`Cable` et des moteurs (OSPF/RIP/DHCP/NAT). **Toujours réel.** |
| **Config-driven** | NTP servers, SNMP communities, AAA, logging/syslog hosts, clock/timezone, hostname, bannières | **État léger réel** : un *Repository* par sous-système stocke ce qui est réellement configuré via la CLI ; le `show` le rejoue fidèlement. |
| **Télémétrie matérielle** | `show environment`, `show buffers`, `show stacks`, `show processes cpu/memory` | Pas de capteur dans un simulateur → sortie honnête « not instrumented on this platform ». **Aucun chiffre fabriqué.** |

Règle d'or : *config-driven ⇒ on modélise l'état ; télémétrie pure ⇒
on déclare honnêtement l'absence d'instrumentation.*

---

## 3. Architecture en 3 couches

```
┌────────────────────────────────────────────────────────────┐
│  STATE (modèle, source de vérité unique)                     │
│  Equipment · Port · Cable · OSPFEngine · RIP · DHCP · NAT    │
│  + Repositories config-driven (NTP/SNMP/AAA/Logging/Clock)   │
└───────────────▲────────────────────────────────────────────┘
                │ lectures typées, zéro fabrication
┌───────────────┴────────────────────────────────────────────┐
│  INSPECTION (Facade : DeviceStateView)                       │
│  neighbors() · interfaces() · routingTable() · ntp() · snmp()│
│  → renvoie des DTO immuables (ou un DTO « unconfigured »)     │
└───────────────▲────────────────────────────────────────────┘
                │ DTO partagés (DRY, vendor-neutres)
┌───────────────┴────────────────────────────────────────────┐
│  RENDERING (Strategy par vendeur)                            │
│  CiscoShowRenderer  ·  HuaweiDisplayRenderer                 │
│  DTO → texte IOS              DTO → texte VRP                │
└────────────────────────────────────────────────────────────┘
```

**Séparation des responsabilités** :
- *State* ne connaît pas la CLI.
- *Inspection* ne connaît pas le formatage vendeur.
- *Rendering* ne lit jamais le modèle directement — uniquement les DTO.

Conséquences :
- Ajouter un vendeur = un nouveau *renderer* (zéro touche au modèle).
- Ajouter un sous-système réel = un moteur/Repository + une méthode de
  façade + une méthode de rendu (les autres renderers intacts).
- Testabilité : la façade se teste sans CLI ; les renderers se testent
  avec des DTO synthétiques.

---

## 4. Contrats : DeviceStateView & DTO

```ts
// Inspection — lecture seule, vendor-neutre
export interface DeviceStateView {
  identity(): DeviceIdentityDTO;          // hostname, type, plateforme
  interfaces(): InterfaceStateDTO[];      // état réel des Port
  neighbors(): NeighborDTO[];             // graphe Cable réel (CDP/LLDP)
  routingTable(): RouteDTO[];             // moteur de routage réel
  arp(): ArpEntryDTO[];
  ntp(): NtpStateDTO;                     // Repository config-driven
  snmp(): SnmpStateDTO;
  logging(): LoggingStateDTO;
  aaa(): AaaStateDTO;
  clock(): ClockDTO;
  // Télémétrie non instrumentée : pas de méthode → renderer émet
  // la ligne honnête « not instrumented ».
}
```

Règles DTO :
- **Immuables** (`readonly`), sans logique de formatage.
- Un DTO config-driven porte un drapeau explicite
  `configured: boolean` ; `false` ⇒ le renderer produit la sortie
  « non configuré » canonique du vendeur (pas un vide ambigu).
- Aucune chaîne pré-formatée vendeur dans un DTO.

---

## 5. Couche rendu : Strategy par vendeur

```ts
export interface ShowRenderer {
  cdpNeighbors(ns: NeighborDTO[], detail: boolean): string;
  interfaces(ifs: InterfaceStateDTO[], filter?: string): string;
  ntpStatus(s: NtpStateDTO): string;
  // …une méthode par famille de commande
}
```

- `CiscoShowRenderer implements ShowRenderer` → texte IOS.
- `HuaweiDisplayRenderer implements ShowRenderer` → texte VRP.
- Le *shell* (CiscoShellBase / HuaweiVRPShell) câble : `trie →
  view.xxx() → renderer.xxx(dto)`. Le shell ne formate plus rien.

DRY : la logique de **collecte** (voisins, interfaces…) vit une seule
fois dans la façade ; seuls les **gabarits texte** divergent par
vendeur.

---

## 6. Sous-systèmes config-driven : Repository d'état

Pour NTP / SNMP / AAA / Logging / Clock, on introduit un petit
**Repository** rattaché au device (composition, pas d'héritage) :

```ts
class NtpConfig {                 // état réel, alimenté par la CLI
  private servers: NtpServer[] = [];
  addServer(ip: string, opts: NtpServerOpts): void { … }
  removeServer(ip: string): void { … }
  snapshot(): NtpStateDTO { … }   // projection pure pour la façade
}
```

- La CLI (`ntp server …`, `snmp-server community …`) **mute** le
  Repository (effet réel), au lieu d'être un no-op silencieux.
- `show ntp associations` lit `NtpConfig.snapshot()` → reflète
  exactement ce qui a été configuré. **Aucun hardcode.**
- Pas de synchronisation NTP réelle simulée : l'état « stratum 16,
  unsynchronized » est l'état *vrai* (aucune source de temps), pas un
  stub — et devient « synchronized to <peer> » seulement si un pair
  réel est modélisé ultérieurement.

---

## 7. Patterns & SOLID

| Pattern | Emploi |
|---|---|
| **Facade** | `DeviceStateView` masque modèle + moteurs derrière une API de lecture stable. |
| **Strategy** | `ShowRenderer` : un algorithme de rendu par vendeur, interchangeable. |
| **DTO / Value Object** | Transport immuable State→Render, découple les couches. |
| **Repository** | `NtpConfig`, `SnmpConfig`… : encapsulent l'état config-driven. |
| **Composition over inheritance** | Les Repositories sont *composés* dans le device. |

SOLID :
- **SRP** : collecte ≠ formatage ≠ stockage (3 couches).
- **OCP** : nouveau vendeur/renderer sans modifier l'existant.
- **LSP** : tout `ShowRenderer` est substituable.
- **ISP** : `DeviceStateView` segmentable si trop large.
- **DIP** : le shell dépend des interfaces (`DeviceStateView`,
  `ShowRenderer`), pas des implémentations concrètes.

---

## 8. Disposition des fichiers

```
src/network/devices/inspection/
  DeviceStateView.ts        // interface + DTO partagés
  EquipmentStateView.ts     // impl. : lit Equipment/Port/Cable/moteurs
  config/
    NtpConfig.ts  SnmpConfig.ts  LoggingConfig.ts  AaaConfig.ts
src/network/devices/shells/render/
  ShowRenderer.ts           // interface Strategy
  CiscoShowRenderer.ts
  HuaweiDisplayRenderer.ts
```

`CiscoCommonShow.ts` est progressivement vidé au profit de
`CiscoShowRenderer` (les helpers déjà « réels » — CDP/LLDP/interfaces
— y migrent tels quels, sans régression).

---

## 9. Stratégie de test (TDD)

1. **Tests façade** (sans CLI) : monter une topologie réelle, asserter
   que `view.neighbors()` contient le vrai pair câblé, etc.
2. **Tests renderer** : DTO synthétique → format vendeur attendu.
3. **Tests d'intégration shell** : `executeCommand('show …')` bout en
   bout, asserte l'état réel (IP configurée, voisin réel).
4. **Anti-stub** : pour chaque famille, un test vérifie qu'un port non
   câblé / sous-système non configuré ne **fabrique pas** d'entrée.
5. Régénération des transcripts `debug-output/router/` à chaque lot.

---

## 10. Plan de migration incrémental

Refactor **par lots** (TDD rouge→vert, régression, push) :

1. **Lot A** — Interface d'inspection + DTO + `EquipmentStateView`
   pour topologie réelle (neighbors/interfaces/arp). Migrer
   CDP/LLDP/`show interfaces` (déjà réels) derrière la façade.
2. **Lot B** — `ShowRenderer` Cisco extrait de CiscoCommonShow ;
   shell câblé sur `view + renderer`. Zéro changement de sortie.
3. **Lot C** — Repositories config-driven (Clock, NTP, SNMP, Logging,
   AAA) : la CLI mute l'état réel ; `show` le rejoue.
4. **Lot D** — Renderer Huawei sur les mêmes DTO (DRY inter-vendeur).
5. **Lots suivants** — Familles restantes (routing protocols, IPsec…)
   au fil des anomalies des transcripts.

Invariant à chaque lot : suites vendeur/routing **vertes**,
transcripts régénérés, commit + push.

---

*Fin du document.*
