# PRD — Pannes, défaillances et dégradations

> Simulation fidèle des pannes d'infrastructure : couche physique, système,
> fichiers, processus, services, protocoles, applicatif — et le
> comportement UI/UX qui doit les rendre lisibles.

---

## Table des matières

1. [Contexte et motivation](#1-contexte-et-motivation)
2. [Objectifs et non-objectifs](#2-objectifs-et-non-objectifs)
3. [Terminologie](#3-terminologie)
4. [Inventaire de l'existant](#4-inventaire-de-lexistant)
5. [Principes directeurs](#5-principes-directeurs)
6. [Architecture transverse](#6-architecture-transverse)
7. [Catalogue F1 — Pannes physiques (L1)](#7-catalogue-f1--pannes-physiques-l1)
8. [Catalogue F2 — Pannes d'alimentation et de démarrage](#8-catalogue-f2--pannes-dalimentation-et-de-démarrage)
9. [Catalogue F3 — Pannes de commutation (L2)](#9-catalogue-f3--pannes-de-commutation-l2)
10. [Catalogue F4 — Pannes de routage (L3)](#10-catalogue-f4--pannes-de-routage-l3)
11. [Catalogue F5 — Pannes de processus](#11-catalogue-f5--pannes-de-processus)
12. [Catalogue F6 — Pannes de services (systemd / SCM)](#12-catalogue-f6--pannes-de-services-systemd--scm)
13. [Catalogue F7 — Suppression et corruption de fichiers sensibles](#13-catalogue-f7--suppression-et-corruption-de-fichiers-sensibles)
14. [Catalogue F8 — Pannes de permissions et d'identité](#14-catalogue-f8--pannes-de-permissions-et-didentité)
15. [Catalogue F9 — Pannes de ressources (disque, mémoire, PID, FD)](#15-catalogue-f9--pannes-de-ressources-disque-mémoire-pid-fd)
16. [Catalogue F10 — Pannes applicatives](#16-catalogue-f10--pannes-applicatives)
17. [Catalogue F11 — Pannes en cascade et scénarios composés](#17-catalogue-f11--pannes-en-cascade-et-scénarios-composés)
18. [UI/UX — Modèle général](#18-uiux--modèle-général)
19. [UI/UX — Canvas et topologie](#19-uiux--canvas-et-topologie)
20. [UI/UX — Panneau de propriétés](#20-uiux--panneau-de-propriétés)
21. [UI/UX — Terminal](#21-uiux--terminal)
22. [UI/UX — Journal réseau et centre d'incidents](#22-uiux--journal-réseau-et-centre-dincidents)
23. [UI/UX — Injection de panne (mode instructeur)](#23-uiux--injection-de-panne-mode-instructeur)
24. [UI/UX — Accessibilité et internationalisation](#24-uiux--accessibilité-et-internationalisation)
25. [Découpage en phases](#25-découpage-en-phases)
26. [Stratégie de test](#26-stratégie-de-test)
27. [Hors périmètre](#27-hors-périmètre)
28. [Annexes](#28-annexes)

---

## 1. Contexte et motivation

### 1.1 Le problème pédagogique

Un simulateur réseau ne sert pas seulement à monter une infrastructure qui
marche : il sert surtout à comprendre ce qui se passe **quand elle ne marche
plus**. Or aujourd'hui le simulateur est très complet sur le chemin nominal
(protocoles, shells, base de données) et très inégal sur le chemin dégradé.

Le déséquilibre est structurel, pas accidentel. Chaque sous-système a été
écrit pour produire le bon résultat quand tout va bien ; le cas d'erreur est
souvent traité par un `?? ''`, un `?? true`, un `catch {}` silencieux, ou
une valeur par défaut « raisonnable ». Individuellement chacun de ces choix
est défendable. Cumulés, ils produisent un simulateur qui **pardonne** :
l'apprenant supprime `/etc/ssh/sshd_config`, relance `sshd`, et tout
continue de fonctionner. Il apprend l'inverse de ce qu'il faut apprendre.

### 1.2 Trois symptômes représentatifs

**Symptôme A — la panne silencieuse.**
`rm /etc/ssh/sshd_config` puis `systemctl restart ssh` : le service
redémarre sans broncher et accepte les connexions. Cause racine : tous les
lecteurs de ce fichier font `vfs.readFile('/etc/ssh/sshd_config') ?? ''`
(`LinuxSshServerContext.ts:247`, `LinuxMachine.ts:1083`, `:1296`, `:1352`,
`:1958`, `LinuxCommandExecutor.ts:1282`, `LinuxSshClient.ts:173`, `:218`,
`:247`, `:254`) et `SshdServerConfig.parse('')` renvoie les valeurs par
défaut. Fichier absent et fichier vide sont indiscernables, et aucun des
deux n'est une erreur.

**Symptôme B — la panne invisible.**
Un port passe en `errdisable`, une route disparaît, un service passe en
`failed` : l'information existe dans le modèle, elle est même parfois
journalisée, mais rien sur le canvas ne change. L'apprenant doit deviner
quel équipement inspecter avant de pouvoir diagnostiquer. Dans une vraie
salle machine, une LED orange lui aurait sauté aux yeux.

**Symptôme C — la panne sans conséquence.**
Un équipement est éteint : il ne traite plus les trames
(`Equipment.ts:246-252`), c'est correct. Mais les sessions terminal déjà
ouvertes dessus, les baux DHCP qu'il avait distribués, les adjacences OSPF
de ses voisins, les connexions TCP établies à travers lui — tout cela ne
réagit que partiellement, chaque sous-système ayant sa propre politique
implicite.

### 1.3 Ce que ce PRD n'est pas

Ce n'est **pas** un document de refonte des protocoles. Aucun moteur
protocolaire n'est réécrit ici. C'est un document sur la **propagation
correcte d'un événement de défaillance** à travers des sous-systèmes qui,
pour la plupart, savent déjà faire leur travail — mais ne sont pas prévenus,
ou ne réagissent pas de façon cohérente entre eux.

C'est aussi, pour une part importante, un document **UI/UX** : une panne
correctement modélisée mais invisible dans l'interface a une valeur
pédagogique nulle.

---

## 2. Objectifs et non-objectifs

### 2.1 Objectifs

| # | Objectif | Critère de succès |
|---|---|---|
| O1 | Toute panne modélisée est **observable** par au moins deux voies indépendantes | CLI (commande vendeur idoine) **et** UI (canvas / panneau / journal) |
| O2 | Toute panne modélisée a un **effet fonctionnel** réel | Une commande qui dépendait de la ressource échoue, avec le message et le code de sortie réels |
| O3 | Les pannes **se propagent** aux dépendants | Un service dont la dépendance tombe change d'état ; une route dont l'interface tombe disparaît |
| O4 | Les pannes sont **réversibles** et le retour à la normale est complet | Rebrancher / rallumer / restaurer ramène exactement à l'état antérieur, sans état résiduel |
| O5 | L'UI **hiérarchise** : incident bloquant ≠ dégradation ≠ information | Trois niveaux visuels distincts, cohérents partout |
| O6 | Aucune panne n'est **inventée** : chaque comportement correspond à un comportement réel documenté | Chaque entrée du catalogue cite la source réelle (man page, doc vendeur, RFC) |
| O7 | L'apprenant peut **provoquer** une panne délibérément | Mode instructeur / injection depuis l'UI, en plus des voies naturelles (CLI, câble) |

### 2.2 Non-objectifs explicites

- **Pas de simulation matérielle fine** : pas de température, pas d'usure de
  ventilateur, pas de MTBF, pas de corruption mémoire aléatoire.
- **Pas de pannes non déterministes par défaut.** Le hasard existe déjà de
  façon opt-in (`Cable.packetLossRate`, `corruptionRate`) et reste opt-in.
  Un lab doit être reproductible : une panne se déclenche parce que
  l'utilisateur ou le scénario l'a décidée, jamais spontanément.
- **Pas de modélisation du temps de réparation.** Une réparation est
  instantanée dès que l'action correctrice est faite.
- **Pas de « chaos monkey »** automatique. Voir §23 pour l'injection
  explicite, qui est un outil pédagogique, pas un générateur aléatoire.

---

## 3. Terminologie

| Terme | Définition dans ce document |
|---|---|
| **Panne** (*fault*) | Cause première : câble arraché, fichier supprimé, processus tué, équipement éteint. Un fait, pas une conséquence. |
| **Défaillance** (*failure*) | Manifestation observable : ping qui échoue, service `failed`, `ORA-12541`. |
| **Dégradation** | Le service rend encore un résultat, mais hors spécification : latence, perte, chemin de secours, mode restreint. |
| **Propagation** | Chaîne panne → défaillances secondaires. Une panne, N défaillances. |
| **Réparation** | Action qui supprime la cause. Distincte de la *reprise*, qui est le retour effectif au nominal. |
| **Observabilité** | Ensemble des voies par lesquelles l'état dégradé est constatable : commandes CLI, fichiers de log, vues d'inspection, UI. |
| **Ressource sensible** | Objet dont la disparition ou l'altération casse une fonction : fichier de configuration, exécutable, socket, interface, clé, certificat. |
| **Dépendance dure** | La fonction est impossible sans la ressource (sshd sans clé d'hôte). |
| **Dépendance molle** | La fonction est dégradée mais possible (résolveur DNS secondaire indisponible). |

### 3.1 Niveaux de sévérité

Trois niveaux, utilisés de façon strictement cohérente dans le modèle, les
logs et l'UI. Ils ne sont **pas** les niveaux du `Logger`
(`debug|info|warn|error`, `Logger.ts:25`) : ils s'y projettent.

| Niveau | Sens | Projection `Logger` | Couleur UI |
|---|---|---|---|
| `critical` | La fonction principale de l'équipement est perdue | `error` | Rouge `#ef4444` |
| `degraded` | La fonction rend un service partiel ou hors spec | `warn` | Ambre `#f59e0b` |
| `notice` | Changement d'état notable, sans perte de service | `info` | Bleu `#3b82f6` |

Règle de non-inflation : une panne ne monte en `critical` que si un
**utilisateur du service** en subit l'effet. Un port inutilisé qui perd sa
porteuse est `notice`, pas `critical`.

---

## 4. Inventaire de l'existant

Cette section documente ce qui est **déjà** en place. Elle sert de contrat :
rien de ce qui suit ne doit être réécrit, tout doit être réutilisé.

### 4.1 Couche physique — solide

| Capacité | Emplacement | État |
|---|---|---|
| `Cable.disconnect()` notifie les deux ports et publie `cable.disconnected` | `hardware/Cable.ts:215-225` | ✅ Réel |
| Notion de porteuse : `Port.hasCarrier()` | `hardware/Port.ts:639-643` | ✅ Réel |
| `Port.isTransmitting()` (non récursif, évite la boucle) | `hardware/Port.ts:650-652` | ✅ Réel |
| `Port.isOperationallyUp()` = ligne ∧ admin ∧ porteuse | `hardware/Port.ts:690-692` | ✅ Réel |
| `Port.setDevicePowered()` propage la coupure au voisin | `hardware/Port.ts:667-671` | ✅ Réel |
| `Port.wasEverCabled()` distingue « débranché » de « jamais câblé » | `hardware/Port.ts:680-682` | ✅ Réel |
| Perte de paquets injectable : `Cable.packetLossRate` | `hardware/Cable.ts:95, 269-276` | ✅ Réel |
| Corruption de trame injectable : `Cable.corruptionRate` | `hardware/Cable.ts:96, 279` | ✅ Réel |
| Latence injectable : `Cable.artificialDelayMs` | `hardware/Cable.ts:103, 152-153` | ✅ Réel (métadonnée RTT) |
| Événements `port.link.up` / `port.link.down` sur l'EventBus | `events/types.ts` | ✅ Réel |

**Conclusion L1 : la fondation est là.** `docs/PRD-Link-State.md` a fait ce
travail. Le présent PRD s'appuie dessus et ne le refait pas.

### 4.2 Alimentation — partiellement câblée

| Capacité | Emplacement | État |
|---|---|---|
| `Equipment.powerOn()` / `powerOff()` | `equipment/Equipment.ts:195-225` | ✅ Réel |
| Publication `device.power-on` / `device.power-off` | `equipment/Equipment.ts:205-224` | ✅ Réel |
| Coupure de porteuse sur tous les ports à l'extinction | `equipment/Equipment.ts:210, 219` | ✅ Réel |
| Rejet des trames quand éteint | `equipment/Equipment.ts:246-252` | ✅ Réel |
| Replay de la séquence de boot au rallumage (`_bootShown`) | `equipment/Equipment.ts:182-193` | ✅ Réel |
| Gel des terminaux ouverts à l'extinction | `terminal/sessions/TerminalManager.ts:57-61` | ✅ Réel |
| Réaction NSS au power-off | `linux/nss/NameServiceSwitch.ts:430-431` | ✅ Réel |
| Réaction du gestionnaire de services Windows | `windows/WindowsServiceManager.ts:166` | ⚠️ `power-on` seul |
| Purge de l'état applicatif volatile (baux DHCP, LSDB, RIB, sockets) | — | ❌ **Absent** |

### 4.3 Processus et services — bonne base, couverture partielle

| Capacité | Emplacement | État |
|---|---|---|
| Événements de cycle de vie processus (`spawned`, `exited`, `signalled`, `reaped`, `state-changed`) | `linux/events.ts:198-202` | ✅ Réel |
| Superviseur de service réagissant à la mort du PID principal | `linux/supervisor/LinuxServiceSupervisor.ts:44-48` | ✅ Réel |
| Politiques `Restart=` (`always`, `on-failure`, `on-abnormal`, `on-success`) | `LinuxServiceSupervisor.ts:18-26` | ✅ Réel |
| `StartLimitBurst` / `StartLimitIntervalSec` / `RestartSec` | `LinuxServiceSupervisor.ts:5-7, 71-79` | ✅ Réel |
| États `failed` / `start-limit-hit` | `LinuxServiceManager.ts:924, 958` | ✅ Réel |
| Événements de service (`failed`, `restart-scheduled`, `start-limited`, …) | `linux/events.ts:204-215` | ✅ Réel |
| Corrélation « service actif ⇒ processus vivant » | `LinuxMachine.ts:1152-1162` | ⚠️ **4 daemons seulement** (`ssh`, `cron`, `rsyslog`, `systemd-journald`) |
| Dépendances Windows + arrêt en cascade | `windows/WindowsServiceManager.ts:375, 452-459` | ✅ Réel |
| `After=` / `Requires=` / `BindsTo=` Linux avec propagation d'échec | — | ❌ **À vérifier / compléter** |

**Le point dur :** `isServiceActive()` n'exige un processus vivant que pour
quatre daemons connus. Tuer le processus `nginx`, `named`, `postgres` ou
`tnslsnr` laisse le service « actif ». La table `knownDaemons` doit devenir
une propriété de l'unité, pas une liste en dur dans une méthode.

### 4.4 Système de fichiers — le gros manque

| Capacité | Emplacement | État |
|---|---|---|
| VFS avec inodes, uid/gid, permissions | `linux/VirtualFileSystem.ts` | ✅ Réel |
| `rm --preserve-root` sur `/` | `linux/LinuxFileCommands.ts:493-516` | ✅ Réel |
| Événement `linux.fs.accessed` | `linux/events.ts:219` | ✅ Réel |
| Vérification d'intégrité au démarrage d'un service | — | ❌ **Absent** |
| Fichier de configuration absent ⇒ échec | — | ❌ **Absent** (`?? ''` partout) |
| Exécutable absent ⇒ `command not found` | — | ❌ **Absent** (dispatch par `switch`, pas par PATH) |
| Notion de fichier « critique » | — | ❌ **Absent** |
| Détection de corruption syntaxique au chargement | Partiel (`visudo -c`, `sshd -t`) | ⚠️ Non appliqué au démarrage réel |

**Le point dur n°2 :** le dispatch de commandes est un `switch` sur ~269
`case` (`LinuxCommandExecutor.ts`). Il ne consulte jamais le VFS. Supprimer
`/bin/ls` n'a aucun effet sur la commande `ls`. C'est le gap le plus visible
pour un apprenant qui teste « et si je casse tout ? ».

### 4.5 Observabilité — riche mais non centralisée

| Capacité | Emplacement | État |
|---|---|---|
| `Logger` pub/sub avec niveaux | `core/Logger.ts:25-120` | ✅ Réel |
| Panneau de journal filtrable + export CSV/JSON | `components/network/NetworkLogsPanel.tsx` | ✅ Réel |
| EventBus typé avec ~42 topics réseau | `events/types.ts` | ✅ Réel |
| ~26 topics Linux | `linux/events.ts` | ✅ Réel |
| Vues d'inspection d'état | `devices/inspection/DeviceStateView.ts` | ✅ Réel |
| **Vue unifiée « incidents en cours »** | — | ❌ **Absent** |

### 4.6 UI — les bases visuelles existent

| Capacité | Emplacement | État |
|---|---|---|
| Lien mort en rouge pointillé | `connection-line-logic.ts:64-66, 74` | ✅ Réel |
| Équipement éteint en opacité réduite | `NetworkDevice.tsx:245` | ✅ Réel |
| Bouton d'alimentation avec `aria-label` | `NetworkDevice.tsx:283-286` | ✅ Réel |
| Statut d'interface `Connected` / `Admin down` | `PropertiesPanel.tsx:303-333` | ✅ Réel |
| Rafraîchissement sur événements autonomes (allowlist) | `store/networkStore.ts` (item #56) | ✅ Réel |
| **Badge d'incident sur l'équipement** | — | ❌ **Absent** |
| **Centre d'incidents** | — | ❌ **Absent** |
| **Injection de panne depuis l'UI** | — | ❌ **Absent** |

### 4.7 Synthèse honnête

Le simulateur sait déjà très bien modéliser **une** panne : le câble
débranché. C'est la seule qui ait reçu un traitement transverse complet
(PRD dédié, sept phases, propagation jusqu'à SSH).

Toutes les autres familles de pannes sont dans un des trois états suivants :
1. **Modélisées mais non propagées** (extinction d'équipement) ;
2. **Modélisées partiellement** (mort de processus : 4 daemons sur N) ;
3. **Non modélisées** (suppression de fichier, corruption de configuration).

Ce PRD généralise le traitement réussi du câble à toutes les autres.

---

## 5. Principes directeurs

### P1 — Une panne est un fait, pas un message

Le modèle porte l'état. L'UI et les commandes le **lisent**. On n'écrit
jamais « affiche que le service est mort » : on écrit « le service est
mort », et l'affichage en découle. Corollaire : aucune commande ne doit
avoir de branche `if (simulationDeVitrine)`.

### P2 — Réutiliser l'EventBus, ne pas inventer un second mécanisme

`docs/PRD-Link-State.md §1.3` a déjà tranché : `port.link.up`/`down` est le
point d'accroche. Toute nouvelle famille de panne publie sur le **même** bus,
avec un topic typé dans `events/types.ts` ou `linux/events.ts`.

Anti-pattern interdit : un `FaultManager` singleton avec ses propres
callbacks, doublant le bus existant.

### P3 — Échouer de façon réaliste, pas de façon générique

Une panne ne produit jamais un message inventé. Elle produit **le** message
que produit l'outil réel :

| Situation | Message correct | Message interdit |
|---|---|---|
| Config sshd absente | `sshd: no hostkeys available -- exiting.` | `Erreur : configuration manquante` |
| Binaire absent | `bash: /usr/bin/foo: No such file or directory` (code 127) | `Commande introuvable` |
| Service dépendant tombé | `Job for x.service failed because a dependency failed.` | `Impossible de démarrer` |
| Disque plein | `write error: No space left on device` (ENOSPC) | `Espace insuffisant` |

Et le **code de sortie** réel avec.

### P4 — La réparation est aussi importante que la panne

Chaque scénario du catalogue spécifie sa réparation et l'état attendu
**après**. Une panne qui laisse un résidu après réparation est un bug :
c'est ce qui rend un lab non rejouable et fait perdre confiance.

### P5 — Pas de panne spontanée

Aucun `Math.random()` dans un chemin de panne, sauf sur les trois molettes
existantes explicitement réglées par l'utilisateur (`packetLossRate`,
`corruptionRate`, `artificialDelayMs`). Un lab lancé deux fois avec les
mêmes actions donne le même résultat.

### P6 — Deux voies d'observation minimum

Toute panne doit être constatable :
- par la **commande vendeur** qu'un administrateur réel taperait
  (`systemctl status`, `show interfaces`, `Get-Service`, `lsnrctl status`) ;
- par l'**UI** (canvas, panneau, journal).

Une panne visible seulement dans l'UI est un gadget. Une panne visible
seulement en CLI est invisible pour l'apprenant qui ne sait pas encore où
regarder.

### P7 — La sévérité est portée par la conséquence, pas par la cause

Un câble débranché sur un port libre : `notice`. Le même câble sur le
seul uplink : `critical`. C'est la perte de fonction qui décide.

### P8 — Honnêteté sur les limites

Quand une panne n'est modélisée que partiellement, l'UI le dit. Le
simulateur affiche déjà un badge ambre « Limited simulation » sur les types
d'équipement stubés (`DevicePalette.tsx`, `isFullyImplemented()`). On
généralise ce principe aux pannes.

---

## 6. Architecture transverse

### 6.1 Le registre d'incidents

Un unique objet observable, alimenté **uniquement** par abonnement à
l'EventBus. Il ne décide de rien : il agrège.

```
src/network/faults/
├── FaultRegistry.ts        — agrégation, requête, cycle de vie
├── FaultTypes.ts           — types d'incident, sévérité, catégories
├── FaultProjection.ts      — abonnements bus → incidents
├── faultCatalog.ts         — table statique : code → libellé, remède, doc
└── index.ts
```

Modèle d'un incident :

```ts
interface Fault {
  /** Identifiant stable : `${deviceId}:${code}:${scope}` */
  readonly id: string;
  /** Code catalogue, ex. 'LINK_DOWN', 'SERVICE_FAILED', 'CONFIG_MISSING' */
  readonly code: FaultCode;
  readonly severity: 'critical' | 'degraded' | 'notice';
  readonly deviceId: string;
  /** Ressource concernée : nom de port, d'unité, chemin de fichier, … */
  readonly scope: string;
  readonly since: number;
  /** Une phrase, style message d'outil réel. */
  readonly summary: string;
  /** Commande à taper pour en savoir plus. */
  readonly investigate?: string;
  /** Commande / geste qui répare. */
  readonly remedy?: string;
  /** Incidents dont celui-ci découle (propagation). */
  readonly causedBy?: readonly string[];
}
```

Points de conception :

- **Idempotent par `id`.** Un `port.link.down` répété ne crée pas un second
  incident : il rafraîchit celui qui existe.
- **Auto-résolution.** L'incident est retiré quand l'événement inverse
  arrive (`port.link.up`, `linux.service.started`). Pas de TTL, pas de
  balayage périodique : la résolution est événementielle, comme la
  création.
- **Chaînage causal.** `causedBy` permet à l'UI de regrouper : « 1 panne,
  7 conséquences » plutôt que huit alertes de même poids.
- **Aucun accès depuis `src/network/` vers le store.** Le registre vit dans
  la couche réseau, le store s'y abonne — même sens de dépendance que
  l'existant (`networkStore.ts` s'abonne au bus, jamais l'inverse).

### 6.2 Le contrat de dépendance de ressource

Pour que « fichier supprimé ⇒ service cassé » fonctionne sans câbler N×M
cas particuliers, on déclare les dépendances.

```ts
interface ResourceDependency {
  /** Chemin VFS, nom d'unité, nom d'interface. */
  readonly resource: string;
  readonly kind: 'config' | 'executable' | 'key' | 'socket' | 'device' | 'unit';
  /** Dure : absence = échec. Molle : absence = dégradation. */
  readonly strength: 'hard' | 'soft';
  /** Vérification syntaxique optionnelle (réutilise `sshd -t`, `visudo -c`…). */
  readonly validate?: (content: string) => { ok: true } | { ok: false; error: string };
  /** Message exact de l'outil réel quand la ressource manque. */
  readonly onMissing: string;
}
```

Chaque unité de service déclare ses dépendances **une fois**. Le démarrage
les vérifie ; la suppression d'une ressource déclarée notifie les unités qui
en dépendent.

**Justification du choix :** l'alternative — vérifier au cas par cas dans
chaque `readFile` — demande de toucher les 10 sites d'appel de
`sshd_config` déjà recensés, puis autant pour chaque autre service. La
déclaration centralise la connaissance là où elle est déjà : dans la
définition de l'unité.

### 6.3 Politique du `?? ''`

Règle générale à appliquer progressivement : **lire un fichier de
configuration critique doit distinguer trois cas**, pas deux.

```ts
type ConfigRead =
  | { kind: 'present'; content: string }
  | { kind: 'empty' }        // fichier là, vide : souvent légal
  | { kind: 'missing' };     // fichier absent : rarement légal
```

Migration réaliste : on ne convertit pas les ~40 sites d'un coup. On
convertit **par service**, en même temps qu'on lui écrit ses tests de
panne. `sshd` en premier (10 sites recensés, tests existants nombreux),
puis `cron`, `named`, `rsyslog`.

### 6.4 Nouveaux topics d'événements

À ajouter dans `events/types.ts` (réseau) et `linux/events.ts` (système).
Nommage aligné sur l'existant (`domaine.objet.action`).

| Topic | Charge utile | Publié par |
|---|---|---|
| `fs.file.deleted` | `{ deviceId, path, wasCritical }` | VFS |
| `fs.file.modified` | `{ deviceId, path }` | VFS |
| `fs.file.permissions-changed` | `{ deviceId, path, mode }` | VFS |
| `fs.filesystem.full` | `{ deviceId, mount, requested, available }` | VFS |
| `resource.dependency.broken` | `{ deviceId, unit, resource, kind }` | Contrat §6.2 |
| `resource.dependency.restored` | `{ deviceId, unit, resource }` | Contrat §6.2 |
| `fault.raised` | `Fault` | FaultRegistry |
| `fault.resolved` | `{ id, resolvedAt }` | FaultRegistry |

Volume : ces topics sont à basse fréquence (une action utilisateur = un
événement), contrairement à `port.frame.*`. Ils peuvent donc être ajoutés à
l'allowlist du store (`networkStore.ts`, item #56) sans réintroduire le
problème de re-rendu que cet item a résolu.

---

## 7. Catalogue F1 — Pannes physiques (L1)

Format de chaque entrée :
**Déclencheur** → **Attendu réel** → **État actuel** → **Cible** →
**Observabilité** → **Réparation**.

### F1.1 — Câble débranché

- **Déclencheur.** UI : clic sur la croix au milieu du lien
  (`ConnectionLine.tsx:201`). API : `cable.disconnect()`.
- **Attendu réel.** Perte de porteuse des deux côtés, `NO-CARRIER` sous
  Linux, `line protocol is down` sous IOS, sessions TCP traversant le lien
  coupées.
- **État actuel.** ✅ Complet — c'est le scénario de référence traité par
  `PRD-Link-State.md` (P1→P7).
- **Cible.** Inchangé. Ajouter uniquement la remontée dans le registre
  d'incidents (§6.1) pour l'unification UI.
- **Observabilité.** `ip link` (flag `NO-CARRIER`), `ethtool`,
  `/sys/class/net/*/carrier`, `show interfaces`, lien rouge pointillé.
- **Réparation.** Recâbler. La porteuse revient, les protocoles
  reconvergent.
- **Sévérité.** `critical` si du trafic empruntait le lien, sinon `notice`.

### F1.2 — Port administrativement désactivé

- **Déclencheur.** `ip link set eth0 down` / `shutdown` (IOS) /
  `shutdown` (VRP).
- **Attendu réel.** Interface `DOWN`, routes connectées retirées, voisinages
  protocolaires perdus, mais **la porteuse du voisin tombe aussi** (le port
  cesse d'émettre).
- **État actuel.** ✅ `Port.setAdminDown()` existe et
  `isTransmitting()` en tient compte, donc le voisin perd bien la porteuse.
- **Cible.** Vérifier la symétrie complète : la route connectée doit
  disparaître de la RIB, et l'adjacence OSPF/EIGRP tomber.
- **Observabilité.** `ip link` (absence de `UP`), `ip route`,
  `show ip interface brief` (`administratively down`).
- **Réparation.** `ip link set eth0 up` / `no shutdown`.
- **Sévérité.** `critical` si l'interface portait une route utilisée.

### F1.3 — Port en errdisable (violation port-security)

- **Déclencheur.** Violation de sécurité de port sur un switch Cisco.
- **Attendu réel.** Port `err-disabled`, aucune trame ne passe, LED orange,
  message syslog `%PM-4-ERR_DISABLE`.
- **État actuel.** ✅ Modélisé —
  `port.security.errdisable.set` / `.cleared` existent (`events/types.ts`),
  `hardware/PortSecurity.ts` implémente la logique.
- **Cible.** Remonter dans le registre d'incidents ; afficher sur le canvas
  (le lien doit apparaître mort, ce qui est déjà le cas si
  `isOperationallyUp()` est correctement dérivé).
- **Observabilité.** `show interfaces status err-disabled`,
  `show port-security`, journal réseau.
- **Réparation.** `shutdown` puis `no shutdown`, ou
  `errdisable recovery cause psecure-violation`.
- **Sévérité.** `critical`.

### F1.4 — Désadaptation de duplex

- **Déclencheur.** Configuration asymétrique full/half sur les deux
  extrémités.
- **Attendu réel.** Lien qui « marche » mais avec collisions tardives, débit
  effondré, compteurs d'erreurs qui montent.
- **État actuel.** ⚠️ Partiel — l'événement `cable.duplex-mismatch` existe
  (`events/types.ts`) et `Cable.negotiateLink()` détecte le cas, mais il n'y
  a pas de dégradation fonctionnelle mesurable.
- **Cible.** Câbler la désadaptation sur le mécanisme de perte déjà présent :
  un mismatch impose un `packetLossRate` plancher (par ex. 0,1) tant qu'il
  dure, et incrémente `Port.errorsIn`. Réutilise strictement l'existant, pas
  de nouveau chemin.
- **Observabilité.** `show interfaces` (late collisions),
  `ip -s link` (compteur d'erreurs), incident `degraded`.
- **Réparation.** Aligner les deux côtés ou repasser en autonégociation.
- **Sévérité.** `degraded`.

### F1.5 — Désadaptation de vitesse

- **Déclencheur.** 100 Mb/s forcé d'un côté, 1 Gb/s de l'autre.
- **Attendu réel.** Le lien ne monte pas du tout (contrairement au duplex).
- **État actuel.** ⚠️ `Cable.negotiateLink()` existe. À vérifier : le lien
  doit rester **down**, pas monter à la vitesse basse.
- **Cible.** `cable.getIsUp() === false` en cas d'incompatibilité stricte.
- **Observabilité.** Lien rouge, `show interfaces` → `down/down`.
- **Réparation.** Aligner.
- **Sévérité.** `critical`.

### F1.6 — MTU incohérent sur un segment

- **Déclencheur.** `ip link set eth0 mtu 1400` d'un seul côté.
- **Attendu réel.** Les petits paquets passent, les gros sont fragmentés ou
  rejetés (`ICMP Fragmentation Needed` si DF).
- **État actuel.** ✅ Bien modélisé — `core/Ipv4Fragmentation.ts` implémente
  RFC 791 §3.2, et `Router.forwardPacket` envoie l'ICMP quand DF=1.
- **Cible.** Aucune correction fonctionnelle. Ajouter la remontée en
  incident `degraded` quand un ICMP « Fragmentation Needed » est émis, car
  c'est typiquement le symptôme que l'apprenant ne sait pas relier à sa
  cause (le fameux « ping marche, SSH ne marche pas »).
- **Observabilité.** `ping -s 1500` échoue, `tracepath`, `ip link` (MTU).
- **Réparation.** Aligner les MTU.
- **Sévérité.** `degraded`.

### F1.7 — Lien saturé / perte de paquets

- **Déclencheur.** `tc qdisc add dev eth0 root netem loss 30%`.
- **Attendu réel.** Perte visible en ping, retransmissions TCP, sessions
  interactives hachées.
- **État actuel.** ✅ `Cable.packetLossRate` + `Tc.ts` (perte et latence).
- **Cible.** Remonter en incident `degraded` dès que le taux configuré
  dépasse 0 — l'apprenant qui a oublié un `tc` doit pouvoir le retrouver.
- **Observabilité.** `tc qdisc show`, statistiques de ping, incident.
- **Réparation.** `tc qdisc del dev eth0 root`.
- **Sévérité.** `degraded`.

### F1.8 — Latence injectée

- **Déclencheur.** `tc qdisc add dev eth0 root netem delay 200ms`.
- **Attendu réel.** RTT augmenté, timeouts applicatifs sur les protocoles
  sensibles.
- **État actuel.** ✅ Implémenté (`Cable.artificialDelayMs`, reporté dans le
  RTT de `sendPing`/`sendPing6`).
- **Limite assumée et à documenter dans l'UI.** La latence est une
  **métadonnée** ajoutée au RTT rapporté, pas un délai réel injecté dans
  `Cable.transmit()`. Conséquence : elle est visible en ping mais ne provoque
  pas de vrai timeout applicatif. Injecter un délai réel dans le chemin
  synchrone le plus chaud du simulateur a été écarté délibérément.
- **Observabilité.** `ping` (RTT), `tc qdisc show`.
- **Réparation.** `tc qdisc del`.
- **Sévérité.** `degraded`.

### F1.9 — Corruption de trames

- **Déclencheur.** `Cable.setCorruptionRate(0.2)`.
- **Attendu réel.** Trames rejetées silencieusement par la NIC réceptrice
  (mauvais FCS), compteur `errorsIn` qui monte.
- **État actuel.** ✅ Implémenté, distinct de la perte générique.
- **Cible.** Exposer le réglage dans l'UI d'injection (§23) — il n'est
  aujourd'hui accessible que par API.
- **Observabilité.** `ip -s link` (`RX errors`), `show interfaces` (CRC).
- **Réparation.** Remettre le taux à 0.
- **Sévérité.** `degraded`.

### F1.10 — Boucle physique

- **Déclencheur.** Câbler deux ports du même switch entre eux, ou créer un
  cycle entre trois switches.
- **Attendu réel.** Sans STP : tempête de broadcast, CPU à 100 %, réseau
  inutilisable. Avec STP : un port passe en `blocking`, le réseau tient.
- **État actuel.** ✅ STP est réel (`stp/StpAgent.ts`). Le cas **sans** STP
  (STP désactivé explicitement) doit être vérifié : la tempête doit être
  observable, pas seulement théorique.
- **Cible.** Détecter la tempête (compteur de broadcasts par seconde
  au-dessus d'un seuil) et lever un incident `critical` explicite plutôt que
  de laisser le simulateur ramer. **Ne pas** simuler la saturation CPU
  réelle : lever l'incident et documenter.
- **Observabilité.** `show spanning-tree` (ports `BLK`), compteurs de
  broadcast, incident.
- **Réparation.** Retirer le câble redondant ou activer STP.
- **Sévérité.** `critical`.

### F1.11 — Câble croisé / droit inadapté

- **Déclencheur.** Type de câble incompatible avec la paire d'équipements.
- **Attendu réel.** Sur du matériel moderne : rien (auto-MDI/MDIX). Sur du
  matériel ancien : lien down.
- **État actuel.** `ConnectionType` existe dans le store.
- **Cible.** **Ne rien faire.** Tout le matériel simulé est moderne. Le
  documenter explicitement pour éviter qu'un futur contributeur ne
  « corrige » ce non-comportement.
- **Sévérité.** —

### F1.12 — Suppression d'une interface logique

- **Déclencheur.** `ip link delete eth0.10` (sous-interface VLAN),
  suppression d'une loopback, d'un tunnel.
- **Attendu réel.** Toutes les routes et adresses portées disparaissent, les
  services liés à cette adresse cessent d'écouter.
- **État actuel.** ⚠️ À vérifier sous-système par sous-système.
- **Cible.** La suppression d'interface doit produire exactement les mêmes
  conséquences qu'un `link down` définitif, plus le retrait de la
  configuration.
- **Observabilité.** `ip addr`, `ip route`, `ss -tlnp`.
- **Réparation.** Recréer l'interface **et** sa configuration (qui, elle,
  ne revient pas seule — c'est le piège pédagogique intéressant).
- **Sévérité.** `critical`.

---

## 8. Catalogue F2 — Pannes d'alimentation et de démarrage

### F2.1 — Extinction propre d'un équipement

- **Déclencheur.** UI : bouton d'alimentation (`NetworkDevice.tsx:145`).
  CLI : `shutdown -h now`, `poweroff`, `reload` (IOS).
- **Attendu réel.** Arrêt des services dans l'ordre inverse des
  dépendances, fermeture des sessions, extinction des ports, plus aucune
  trame.
- **État actuel.** ⚠️ Le noyau est là (`Equipment.powerOff()`), les
  conséquences sont incomplètes :
  - ✅ Ports sans porteuse, trames rejetées, terminaux gelés
  - ❌ Baux DHCP distribués non révoqués
  - ❌ LSDB OSPF / RIB BGP / table EIGRP non purgées
  - ❌ Sockets TCP établis non réinitialisés
  - ❌ Sessions SSH entrantes non fermées côté client distant
- **Cible.** Un abonné unique `device.power-off` par sous-système à état
  volatile, qui purge cet état. Le sous-système sait déjà le faire (il a du
  code de reset pour les tests) ; il n'est simplement pas branché.
- **Observabilité.** Équipement grisé, tous ses liens rouges, voisins qui
  perdent leur adjacence, incident `critical`.
- **Réparation.** Rallumer. Boot rejoué, services `enabled` relancés, ports
  qui remontent, protocoles qui reconvergent.
- **Point de vigilance.** Ce qui doit revenir : la configuration
  persistante. Ce qui ne doit **pas** revenir : les baux, la LSDB, les
  sessions, `/tmp`, l'historique shell. C'est précisément ce qui distingue
  un état persistant d'un état volatile, et c'est pédagogiquement central.
- **Sévérité.** `critical`.

### F2.2 — Coupure brutale (perte d'alimentation)

- **Déclencheur.** À distinguer de F2.1 : pas d'arrêt propre.
- **Attendu réel.** Aucun arrêt de service, aucun flush : les fichiers non
  synchronisés sont perdus, la configuration non sauvegardée disparaît.
- **État actuel.** ❌ Non distingué de l'extinction propre.
- **Cible.** Distinguer les deux dans l'UI et le modèle :
  - Extinction propre : la configuration non sauvegardée est **perdue** aussi
    (c'est déjà le comportement réel des équipements Cisco : `reload` sans
    `write memory` perd la config), mais les services s'arrêtent proprement
    et le journal contient les lignes d'arrêt.
  - Coupure brutale : en plus, le journal se termine net, et au redémarrage
    un message de type `System returned to ROM by power-on` (IOS) ou
    l'absence de ligne `systemd-shutdown` (Linux) témoigne du crash.
- **Observabilité.** `show version` (`Last reload reason`), `journalctl -b -1`,
  `last -x | grep crash`.
- **Réparation.** Rallumer.
- **Sévérité.** `critical`.

### F2.3 — Redémarrage

- **Déclencheur.** `reboot`, `reload`, `systemctl reboot`.
- **Attendu réel.** Cycle complet arrêt→démarrage, PID réattribués depuis 1,
  uptime remis à zéro, `/tmp` purgé, services `enabled` relancés.
- **État actuel.** ⚠️ `powerOff()` + `powerOn()` enchaînés couvrent une
  partie, mais rien ne garantit la purge de `/tmp`, la remise à zéro de
  l'uptime, ni la réattribution des PID.
- **Cible.** Un chemin `reboot()` explicite qui compose les deux et purge
  l'état volatile listé en F2.1.
- **Observabilité.** `uptime`, `who -b`, `last reboot`, `show version`.
- **Réparation.** —
- **Sévérité.** `notice` (action volontaire).

### F2.4 — Échec de démarrage sur configuration invalide

- **Déclencheur.** Configuration de démarrage corrompue puis redémarrage.
- **Attendu réel.** L'équipement démarre en mode dégradé : Cisco tombe en
  `setup mode` ou ignore les lignes invalides en les journalisant ; Linux
  laisse le service en `failed` mais le système démarre.
- **État actuel.** ❌ Non modélisé.
- **Cible.** Au rejeu de la configuration à l'import/boot, une ligne
  invalide est **journalisée et ignorée**, pas silencieusement avalée. Le
  compte des lignes rejetées est affiché.
- **Observabilité.** Journal de boot, `show startup-config`, incident
  `degraded` listant les lignes rejetées.
- **Réparation.** Corriger la configuration.
- **Sévérité.** `degraded`.

### F2.5 — Équipement éteint pendant une session terminal ouverte

- **Déclencheur.** Éteindre depuis l'UI alors qu'un terminal est ouvert.
- **Attendu réel.** La session est gelée puis close ; toute frappe donne
  une erreur explicite.
- **État actuel.** ✅ `TerminalManager` s'abonne à `device.power-off` et gèle
  les terminaux (lecture seule) — comportement correct et déjà testé.
- **Cible.** Inchangé. Vérifier seulement que le message affiché est
  explicite et non un simple gel muet.
- **Sévérité.** `critical`.

### F2.6 — Équipement éteint alors qu'on y est connecté en SSH depuis un autre poste

- **Déclencheur.** Éteindre B alors que A est en SSH sur B.
- **Attendu réel.** Côté A : `client_loop: send disconnect: Broken pipe`,
  retour au shell local.
- **État actuel.** ⚠️ La sonde de liveness existe
  (`PRD-Link-State.md` P6, `sessionLiveness.ts`) et couvre le câble. Il faut
  vérifier qu'elle couvre aussi l'extinction — `Port.setDevicePowered(false)`
  coupant la porteuse, `isPathReachable` devrait déjà répondre faux, donc ce
  cas est probablement **déjà couvert par construction**. À confirmer par
  test avant d'écrire du code.
- **Observabilité.** Message dans le terminal de A.
- **Réparation.** Rallumer B, se reconnecter (la session n'est **pas**
  restaurée automatiquement — c'est le comportement réel).
- **Sévérité.** `critical`.

### F2.7 — Extinction d'un équipement de transit

- **Déclencheur.** Éteindre le switch entre deux hôtes.
- **Attendu réel.** Les deux hôtes perdent la porteuse (le switch cesse
  d'émettre), pas seulement la connectivité.
- **État actuel.** ✅ Couvert par `setDevicePowered` → `propagateCarrierToPeer`.
- **Cible.** Inchangé. C'est un bon exemple à mettre en avant dans l'UI :
  éteindre un équipement fait rougir les liens des **voisins**, ce qui est
  contre-intuitif pour un débutant et exactement juste.
- **Sévérité.** `critical`.

### F2.8 — Suppression d'un équipement depuis le canvas

- **Déclencheur.** UI : suppression de l'équipement.
- **Attendu réel.** Ce n'est pas une panne mais une modification de
  topologie. Tous les câbles sont retirés, les voisins perdent leur
  porteuse.
- **État actuel.** ✅ `networkStore.removeDevice` éteint d'abord l'appareil
  (`networkStore.ts:328-329`) puis retire les liens, et l'annulation
  (undo) restaure **la même instance** — donc la configuration survit
  (item #54).
- **Cible.** Inchangé. Vérifier que les incidents rattachés à l'équipement
  supprimé sont retirés du registre (sinon le centre d'incidents accumule
  des références mortes).
- **Sévérité.** —

---

## 9. Catalogue F3 — Pannes de commutation (L2)

### F3.1 — VLAN manquant sur un trunk

- **Déclencheur.** VLAN non déclaré ou retiré de la liste autorisée.
- **Attendu réel.** Le trafic de ce VLAN ne traverse plus, les autres VLAN
  ne sont pas affectés. Piège classique : le ping de management passe, le
  ping des utilisateurs non.
- **État actuel.** ✅ Modélisé (`Switch.ts`, 802.1Q).
- **Cible.** Remonter en incident `degraded` quand une trame est rejetée
  pour VLAN non autorisé sur un trunk — le rejet silencieux est correct au
  niveau du plan de données, mais l'apprenant doit pouvoir le retrouver.
  Le compteur, pas un événement par trame (volumétrie).
- **Observabilité.** `show interfaces trunk`, `show vlan brief`.
- **Réparation.** `switchport trunk allowed vlan add N`.
- **Sévérité.** `degraded`.

### F3.2 — Désadaptation de VLAN natif

- **Déclencheur.** VLAN natif différent aux deux bouts d'un trunk.
- **Attendu réel.** Fuite de trafic entre VLAN, message CDP
  `%CDP-4-NATIVE_VLAN_MISMATCH`.
- **État actuel.** ⚠️ CDP existe. La détection du mismatch est à vérifier.
- **Cible.** Détecter via CDP (qui annonce déjà le VLAN natif) et lever un
  incident `degraded` avec le message Cisco exact.
- **Observabilité.** Journal, `show cdp neighbors detail`.
- **Réparation.** Aligner.
- **Sévérité.** `degraded`.

### F3.3 — Désadaptation de mode d'accès (access vs trunk)

- **Déclencheur.** Un côté `switchport mode access`, l'autre `trunk`.
- **Attendu réel.** Selon DTP : négociation qui échoue, ou trafic taggé
  arrivant sur un port access (rejeté).
- **État actuel.** ✅ DTP modélisé (`dtp/`).
- **Cible.** Incident `degraded` sur échec de négociation.
- **Observabilité.** `show interfaces switchport`, `show dtp interface`.
- **Réparation.** Fixer le mode des deux côtés.
- **Sévérité.** `degraded`.

### F3.4 — Table MAC saturée

- **Déclencheur.** Attaque de type MAC flooding, ou simple dépassement.
- **Attendu réel.** Le switch se comporte en hub : inondation de tout le
  trafic, perte de confidentialité, dégradation des performances.
- **État actuel.** ❌ Pas de limite de taille sur la table MAC.
- **Cible.** Ajouter une capacité maximale configurable et le basculement en
  inondation au-delà, avec incident `critical` (c'est une faille de
  sécurité, pas juste une lenteur).
- **Observabilité.** `show mac address-table count`, incident.
- **Réparation.** `clear mac address-table`, port-security.
- **Sévérité.** `critical`.

### F3.5 — STP : perte du root bridge

- **Déclencheur.** Extinction du switch racine.
- **Attendu réel.** Réélection, reconvergence, interruption de trafic de
  quelques dizaines de secondes.
- **État actuel.** ✅ STP réel. La réélection doit se produire.
- **Cible.** Vérifier par test ; lever un incident `notice` pendant la
  reconvergence, `critical` si elle échoue.
- **Observabilité.** `show spanning-tree`, changement de root ID.
- **Réparation.** —
- **Sévérité.** `notice` → `critical` si non convergent.

### F3.6 — STP : port bloquant qui prive une branche

- **Déclencheur.** Topologie où le blocage STP coupe le seul chemin restant
  après une autre panne.
- **Attendu réel.** Isolation d'un segment, réouverture après reconvergence.
- **État actuel.** ✅ STP réel.
- **Cible.** Bon scénario composé (voir §17). Aucune correction.
- **Sévérité.** `critical` transitoire.

### F3.7 — Violation de port-security

- **Déclencheur.** MAC non autorisée sur un port protégé.
- **Attendu réel.** Selon le mode : `protect` (rejet silencieux),
  `restrict` (rejet + compteur + SNMP), `shutdown` (errdisable).
- **État actuel.** ✅ Les trois modes existent (`PortSecurity.ts`).
- **Cible.** Distinguer les trois dans l'incident : `protect`/`restrict` →
  `degraded`, `shutdown` → `critical` (car le port est mort).
- **Observabilité.** `show port-security interface`.
- **Réparation.** Selon le mode.
- **Sévérité.** Variable.

### F3.8 — Boucle de commutation sans STP

Voir F1.10.

### F3.9 — VTP : révision plus élevée qui écrase la base VLAN

- **Déclencheur.** Introduction d'un switch avec un numéro de révision VTP
  supérieur.
- **Attendu réel.** **La base VLAN de tout le domaine est écrasée.** C'est
  le grand classique destructeur des réseaux Cisco.
- **État actuel.** ✅ VTP réel, avec fragmentation Subset et gestion de
  révision (`vtp/VtpAgent.ts`).
- **Cible.** Aucune correction fonctionnelle. En revanche, c'est le
  scénario de panne le plus spectaculaire du catalogue : il mérite un
  incident `critical` très explicite (« base VLAN écrasée par le switch X,
  N VLAN supprimés ») et une entrée dédiée dans les scénarios pédagogiques.
- **Observabilité.** `show vtp status`, `show vlan brief` (VLAN disparus).
- **Réparation.** Restaurer les VLAN à la main, ou mode transparent.
- **Sévérité.** `critical`.

### F3.10 — Tempête de broadcast

- **Déclencheur.** Boucle, ou hôte défectueux.
- **Attendu réel.** Effondrement du réseau.
- **État actuel.** ❌ Pas de détection.
- **Cible.** Compteur de broadcasts par port et par seconde, seuil,
  incident. **Ne pas** implémenter le storm-control réel (suppression au
  seuil) dans un premier temps : détecter et signaler suffit.
- **Observabilité.** Compteurs, incident.
- **Réparation.** Casser la boucle.
- **Sévérité.** `critical`.

---

## 10. Catalogue F4 — Pannes de routage (L3)

### F4.1 — Route par défaut manquante

- **Déclencheur.** Suppression de la route par défaut.
- **Attendu réel.** Le trafic local fonctionne, tout le reste échoue avec
  `Network is unreachable` — pas `Destination Host Unreachable`.
- **État actuel.** ✅ Modélisé.
- **Cible.** Vérifier la distinction des deux messages, qui est
  pédagogiquement importante (échec local de routage vs échec ARP distant).
- **Observabilité.** `ip route`, `show ip route`.
- **Réparation.** Réajouter la route.
- **Sévérité.** `critical`.

### F4.2 — Route statique vers un next-hop injoignable

- **Déclencheur.** Route pointant vers une IP hors sous-réseau connecté.
- **Attendu réel.** Sur un vrai routeur : résolution récursive, puis échec.
- **État actuel.** ⚠️ **Limite architecturale connue et documentée** :
  `Router.ts` n'a pas de résolution récursive de next-hop. Une route
  récursive classique est acceptée par le CLI mais ne résout jamais.
- **Cible.** **Ne pas** implémenter la récursion (chantier séparé, déjà
  tracé comme item d'audit #40). En revanche, **le dire** : le CLI doit
  refuser ou avertir explicitement au lieu d'accepter silencieusement une
  route qui ne fonctionnera jamais. Une commande acceptée sans effet est le
  pire des deux mondes pour un apprenant.
- **Observabilité.** Avertissement CLI + incident `degraded` « route
  récursive non supportée ».
- **Sévérité.** `degraded`.

### F4.3 — Perte d'adjacence OSPF

- **Déclencheur.** Câble coupé, `shutdown`, mismatch d'aire, de timers,
  d'authentification, de MTU.
- **Attendu réel.** Voisin qui passe en `DOWN` après le dead interval,
  recalcul SPF, routes retirées.
- **État actuel.** ✅ Très bien modélisé — vrais timers `Scheduler`, vraie
  FSM de voisinage, vraie temporisation SPF (RFC 2328 §16.5).
- **Cible.** Aucune correction. Attention documentée : `autoConverge()` fait
  converger le domaine avant retour de commande, donc les états transitoires
  (`ExStart`, `Exchange`) ne sont pas observables en usage CLI normal. À
  redire dans l'UI si on affiche l'état de voisinage.
- **Observabilité.** `show ip ospf neighbor`, `show ip route ospf`.
- **Réparation.** Corriger la cause.
- **Sévérité.** `critical`.

### F4.4 — Mismatch d'authentification protocolaire

- **Déclencheur.** Clé différente entre deux voisins OSPF/EIGRP/BGP.
- **Attendu réel.** Adjacence qui ne monte jamais, message explicite.
- **État actuel.** ⚠️ À vérifier par protocole.
- **Cible.** Message explicite (`%OSPF-4-BADMSG`), incident `critical` — car
  le symptôme sans le message est très difficile à diagnostiquer.
- **Observabilité.** Journal, `debug ip ospf adj`.
- **Sévérité.** `critical`.

### F4.5 — ACL qui bloque un protocole de routage

- **Déclencheur.** ACL trop restrictive sur une interface.
- **Attendu réel.** Adjacence perdue, alors que le ping fonctionne encore
  (ou l'inverse).
- **État actuel.** ✅ ACL réelles (`ACLEngine`).
- **Cible.** Bon scénario composé. Incident `critical` sur la perte
  d'adjacence, avec `causedBy` pointant l'ACL si détectable.
- **Observabilité.** `show access-lists` (compteurs de correspondance).
- **Sévérité.** `critical`.

### F4.6 — Boucle de routage

- **Déclencheur.** Routes statiques mutuellement pointées.
- **Attendu réel.** TTL qui s'épuise, `Time to live exceeded`, traceroute
  qui montre le va-et-vient.
- **État actuel.** ✅ Le TTL est décrémenté et l'ICMP émis.
- **Cible.** Détecter le motif dans traceroute (même paire de sauts répétée)
  et lever un incident `critical` explicite.
- **Observabilité.** `traceroute`, `ping` (TTL exceeded).
- **Réparation.** Corriger les routes.
- **Sévérité.** `critical`.

### F4.7 — Chevauchement / conflit d'adressage

- **Déclencheur.** Deux interfaces avec la même IP, ou sous-réseaux qui se
  chevauchent.
- **Attendu réel.** Détection de conflit par ARP gratuit, message noyau
  `IPv4 address conflict detected`.
- **État actuel.** ❌ Non détecté.
- **Cible.** Vérification à la configuration d'IP : si une autre interface
  du même domaine de diffusion porte déjà l'adresse, avertir et lever un
  incident `critical`.
- **Observabilité.** Journal, `arping`.
- **Réparation.** Changer l'adresse.
- **Sévérité.** `critical`.

### F4.8 — Redistribution en boucle

- **Déclencheur.** Redistribution mutuelle entre deux protocoles sans
  filtre.
- **Attendu réel.** Routes qui oscillent, instabilité.
- **État actuel.** ⚠️ Redistribution partiellement modélisée.
- **Cible.** Hors périmètre immédiat — noter comme scénario avancé.
- **Sévérité.** `degraded`.

### F4.9 — NAT saturé (épuisement de ports PAT)

- **Déclencheur.** Plus de ports disponibles dans la plage PAT.
- **Attendu réel.** Nouvelles connexions refusées, connexions existantes
  préservées.
- **État actuel.** ⚠️ `NATEngine` alloue les ports ; la saturation est à
  vérifier.
- **Cible.** Refus explicite à saturation + incident `critical`.
- **Observabilité.** `show ip nat statistics`, `show ip nat translations`.
- **Réparation.** Élargir le pool, réduire le timeout.
- **Sévérité.** `critical`.

### F4.10 — Asymétrie de routage à travers un pare-feu à état

- **Déclencheur.** Aller et retour par des chemins différents.
- **Attendu réel.** Le pare-feu à état rejette le retour (pas de connexion
  connue).
- **État actuel.** ✅ Le conntrack existe (`LinuxIptablesManager`).
- **Cible.** Bon scénario composé. Aucune correction.
- **Sévérité.** `critical`.

---

## 11. Catalogue F5 — Pannes de processus

### F5.1 — Processus tué par SIGTERM

- **Déclencheur.** `kill <pid>`.
- **Attendu réel.** Terminaison propre, code de sortie reflétant le signal,
  `linux.process.exited` avec `signal: 'SIGTERM'`.
- **État actuel.** ✅ Modélisé, avec superviseur branché dessus.
- **Cible.** Vérifier la couverture pour tous les services, pas seulement
  les quatre de `knownDaemons`.
- **Observabilité.** `ps`, `systemctl status`, `journalctl`.
- **Réparation.** Relancer.
- **Sévérité.** Dépend du service.

### F5.2 — Processus tué par SIGKILL

- **Déclencheur.** `kill -9 <pid>`.
- **Attendu réel.** Mort immédiate, pas de nettoyage, fichiers de
  verrouillage et sockets laissés en place — ce qui empêche souvent le
  redémarrage.
- **État actuel.** ✅ Implémenté — mais **pas comme cette fiche
  l'annonçait**, parce que la cible d'origine décrivait un mythe.
  `service/RuntimeArtifacts.ts` déclare, par service, les fichiers que le
  démon crée en tournant (le pendant de `CriticalFiles.ts`, qui déclare
  ceux dont il ne peut pas se passer) : `activate()` les écrit,
  `deactivate()` — l'arrêt propre, où le démon range — les efface, et un
  `kill -9`, qui ne passe jamais par là, les laisse. Le fichier PID
  survivant nomme alors un processus mort.
- **Correction apportée à la cible.** « La relance doit échouer tant qu'on
  ne nettoie pas » est faux sur une machine systemd moderne, et le simuler
  aurait appris l'inverse du réel. Trois raisons, chacune vérifiée sur la
  plateforme :
  - le **port** est libéré par le noyau à la mort du processus (le 22
    disparaît de `ss -ltn` puis revient), donc jamais d'`address already
    in use` ;
  - un **verrou `flock()`** — cron, atd — meurt avec son détenteur, donc un
    fichier PID périmé n'empêche rien ;
  - une **`RuntimeDirectory=`** est effacée par systemd dès que l'unité
    quitte l'état actif, échec compris (`RuntimeDirectoryPreserve=no`, le
    défaut), donc ce qu'un démon range là ne survit pas non plus.
  La directive est désormais modélisée, ce qui donne le contraste qui fait
  la leçon : au même `kill -9`, sshd laisse `/run/sshd.pid` derrière lui
  et fail2ban ne laisse rien, parce que systemd possède `/run/fail2ban`.
  **Le résidu est réel, visible et trompeur — mais il ne bloque rien**, et
  l'opérateur qui accuse le fichier PID périmé se trompe de coupable.
- **Observabilité.** `ls /run/*.pid`, `cat /run/sshd.pid` comparé à `ps`,
  `ls /run/fail2ban`, `cat` de l'unité (`PIDFile=`, `RuntimeDirectory=`).
  `ss -lx` n'est pas couvert : le `ss` de cette plateforme ne connaît pas
  les sockets Unix.
- **Réparation.** Aucune n'est nécessaire — c'est le résultat, et il est
  volontairement enseigné comme tel.
- **Sévérité.** `notice` (et non `critical` : rien n'est cassé).

### F5.3 — Processus zombie

- **Déclencheur.** Parent qui ne fait pas `wait()`.
- **Attendu réel.** État `Z` dans `ps`, PID non libéré, disparition à la
  mort du parent.
- **État actuel.** ✅ Modélisé (`linux.process.reaped`, état dans
  `LinuxProcessManager`).
- **Cible.** Aucune correction.
- **Observabilité.** `ps -el` (`Z`), `ps aux | grep defunct`.
- **Sévérité.** `notice`.

### F5.4 — Processus orphelin réadopté par PID 1

- **Déclencheur.** Mort du parent avant l'enfant.
- **Attendu réel.** `PPID` devient 1.
- **État actuel.** ✅ Modélisé et testé.
- **Sévérité.** `notice`.

### F5.5 — Boucle de redémarrage (crash loop)

- **Déclencheur.** Service dont le processus meurt immédiatement à chaque
  démarrage, avec `Restart=always`.
- **Attendu réel.** N redémarrages dans la fenêtre, puis
  `start-limit-hit` et arrêt définitif.
- **État actuel.** ✅ **Bien modélisé** — `StartLimitBurst`,
  `StartLimitIntervalSec`, `RestartSec`, `hitStartLimit()`.
- **Cible.** Aucune correction fonctionnelle. Incident `critical` très
  visible : c'est un état où l'apprenant doit comprendre que le service
  a **abandonné** et qu'un simple `restart` ne suffira pas
  (`systemctl reset-failed` requis).
- **Observabilité.** `systemctl status` (`start request repeated too
  quickly`), `journalctl -u`.
- **Réparation.** Corriger la cause, `systemctl reset-failed`, relancer.
- **Sévérité.** `critical`.

### F5.6 — Processus qui consomme tout le CPU

- **Déclencheur.** Boucle infinie.
- **Attendu réel.** Charge à 100 %, autres processus ralentis.
- **État actuel.** ❌ Pas de modèle de temps CPU.
- **Cible.** **Hors périmètre.** Modéliser une contention CPU réelle dans un
  simulateur à exécution synchrone n'a pas de sens et n'apporterait rien.
  À documenter comme limite assumée.
- **Sévérité.** —

### F5.7 — Processus bloqué en attente d'E/S ininterruptible

- **Déclencheur.** Accès à un montage réseau mort.
- **Attendu réel.** État `D`, insensible à `kill -9`.
- **État actuel.** ✅ Implémenté. L'état `D` existait dans le type
  `ProcessState` et servait aux threads noyau, mais `kill()` ne le
  consultait jamais. `process/UninterruptibleSleep.ts` tient la table
  « qui dort sur quoi » et la file des signaux acceptés-mais-pas-encore-
  délivrables.
- **Le détail qui compte.** Le signal n'est pas perdu, il est MIS EN
  ATTENTE : Linux l'empile et le délivre à l'instant où la tâche quitte
  `D`. C'est ce qui rend la réparation spectaculaire — le processus meurt
  d'un `kill -9` envoyé bien plus tôt, dès que la ressource revient. Le
  jeter donnerait un processus qui survit à sa libération, ce qui n'arrive
  jamais. Et `kill` REND UN SUCCÈS : le noyau accepte le signal, la
  commande sort avec 0, l'opérateur n'a aucun message d'erreur — c'est
  précisément ce qui rend la panne déroutante.
- **Cause modélisée.** Un montage réseau dont le serveur a disparu, comme
  annoncé. **Aucun protocole NFS n'est implémenté** : ce qui décide, c'est
  que le serveur soit encore atteignable à travers les vrais câbles depuis
  cette machine (`findHostByAddress`), le fait physique que le simulateur
  connaît vraiment. `MountEntry.serverHost` porte l'hôte de `host:/export`.
- **Limite assumée.** Un accès au PREMIER PLAN ne fige pas le shell : la
  chaîne d'exécution est synchrone de bout en bout (même mur que
  `SELECT … FOR UPDATE` côté Oracle). La forme observable est l'accès lancé
  en arrière-plan — ce qu'un opérateur fait de toute façon dès qu'il
  soupçonne un montage mort. Corollaire hérité : `df` ne se fige pas non
  plus (§F9.6 reste ouvert sur ce point). Écrire le spec e2e a révélé au
  passage que le terminal interactif ne lançait pas `cmd &` du tout — un
  `&` seul y était lu comme `&&`, donc comme un connecteur en attente ;
  corrigé dans `src/bash/incompleteInput.ts`.
- **Observabilité.** `ps` (`D`), `kill -9` sans effet et sans message,
  `mount`, la mort différée à la libération.
- **Réparation.** Restaurer la ressource, ou `umount -l`.
- **Sévérité.** `degraded`.

### F5.8 — Épuisement de la table des processus

- **Déclencheur.** Fork bomb, ou limite `ulimit -u` atteinte.
- **Attendu réel.** `fork: Cannot allocate memory` / `Resource temporarily
  unavailable`.
- **État actuel.** ✅ Implémenté. `ulimit` était une table de dix-huit
  lignes codées en dur : `max user processes (-u) 15730` était AFFICHÉE et
  jamais consultée, et `ulimit -u 5` ne faisait rien. La limite vit
  désormais dans `LinuxProcessManager` (soft/hard), `ulimit -u` la lit et
  l'écrit, `ulimit -a` affiche la même, et `fork()` la fait respecter.
- **Cible.** Atteinte, sans simuler la moindre fork bomb : on abaisse le
  plafond et on refuse, le navigateur n'a rien à ramer.
- **Deux règles qui décident si la panne est réparable.** Le comptage est
  par **UID réel sur toute la machine** (`RLIMIT_NPROC`), pas par shell —
  compter par shell donnerait une machine qu'on ne peut plus sauver ; et
  **root en est exempt**, parce que le noyau saute le contrôle pour qui
  détient `CAP_SYS_RESOURCE`/`CAP_SYS_ADMIN` (`kernel/fork.c`). La règle
  soft/hard est celle de POSIX : un utilisateur remonte sa limite souple
  jusqu'à la dure, jamais au-delà.
- **Message.** Celui de bash, avec ses quatre tentatives
  (`bash: fork: retry: Resource temporarily unavailable` ×4 puis
  `bash: fork: Resource temporarily unavailable`) — c'est cette répétition
  qui fait reconnaître la panne.
- **Hors périmètre, et distinct.** `fork: Cannot allocate memory` est
  `ENOMEM`, un épuisement mémoire, pas une limite `ulimit` : c'est une
  autre panne et elle n'est pas modélisée. `ulimit -u` rend `EAGAIN`.
- **Observabilité.** Message d'erreur, `ulimit -u`, `ps | wc -l`.
- **Réparation.** Tuer les processus, relever la limite.
- **Sévérité.** `critical`.

### F5.9 — Processus tué par le OOM killer

- **Déclencheur.** Dépassement mémoire.
- **Attendu réel.** `Out of memory: Killed process <pid>` dans `dmesg`,
  processus mort par `SIGKILL`.
- **État actuel.** ❌ Pas de modèle mémoire.
- **Cible.** Modélisable au niveau déclaratif : une limite mémoire par
  service (`MemoryMax=`), et un dépassement **provoqué explicitement**
  (commande de test, injection UI) tue le processus avec le bon message.
  Pas de comptabilité mémoire réelle.
- **Observabilité.** `dmesg`, `journalctl -k`, `systemctl status` (`oom-kill`).
- **Réparation.** Relever la limite ou réduire la charge.
- **Sévérité.** `critical`.

### F5.10 — Processus dont l'exécutable a été supprimé

- **Déclencheur.** `rm /usr/sbin/sshd` alors que sshd tourne.
- **Attendu réel.** Le processus **continue de tourner** (l'inode est
  maintenu ouvert), mais tout redémarrage échoue. `ls -l /proc/<pid>/exe`
  montre `(deleted)`.
- **État actuel.** ✅ Implémenté. Deux fondations manquaient et ont été
  posées : les binaires nommés par `ExecStart=` existent désormais sur le
  disque (seedés depuis les unités elles-mêmes, donc le fichier présent est
  exactement celui que l'unité exécutera — avant, `rm /usr/sbin/sshd`
  répondait « No such file or directory » et la panne ne pouvait pas être
  provoquée), et `/proc/<pid>/exe` existe, en lien dont la cible est
  **recalculée à chaque lecture** — remettre le binaire fait disparaître le
  suffixe, ce qu'une chaîne figée à la création ne saurait pas faire.
  `ls -l` et `readlink` lisent la même cible.
- **Cible.** Atteinte. Le processus survit au `rm` et continue de servir sur
  le fil ; le redémarrage suivant échoue en 203/EXEC (`Job for ssh.service
  failed because the control process exited with error code.`), le port se
  ferme et un client distant reçoit `Connection refused` ; le journal nomme
  le fichier manquant (`Failed to locate executable … : No such file or
  directory`) avant la ligne d'exit.
- **Observabilité.** `ls -l /proc/<pid>/exe`, `readlink /proc/<pid>/exe`,
  `systemctl status` (`status=203/EXEC`), `journalctl -u`. `lsof | grep
  deleted` n'est pas couvert.
- **Réparation.** Restaurer le binaire (réinstallation), puis relancer.
- **Sévérité.** `degraded` (tourne encore) → `critical` (au redémarrage).

---

## 12. Catalogue F6 — Pannes de services (systemd / SCM)

### F6.1 — Service arrêté volontairement

- **Déclencheur.** `systemctl stop ssh`, `net stop`, `Stop-Service`.
- **Attendu réel.** État `inactive (dead)`, port libéré, connexions
  refusées (RST, pas timeout).
- **État actuel.** ✅ Modélisé pour les services principaux.
- **Cible.** Vérifier partout que le refus est bien un **refus** (RST →
  `Connection refused`) et non un timeout : la distinction est le premier
  outil de diagnostic réseau.
- **Observabilité.** `systemctl status`, `ss -tlnp`, `nc -zv`.
- **Réparation.** `systemctl start`.
- **Sévérité.** `critical`.

### F6.2 — Service masqué

- **Déclencheur.** `systemctl mask ssh`.
- **Attendu réel.** Toute tentative de démarrage échoue :
  `Unit ssh.service is masked.`
- **État actuel.** ✅ `linux.service.masked` / `.unmasked` existent.
- **Cible.** Vérifier le message exact.
- **Observabilité.** `systemctl status` (`masked`), lien vers `/dev/null`.
- **Réparation.** `systemctl unmask`.
- **Sévérité.** `critical`.

### F6.3 — Service désactivé au démarrage

- **Déclencheur.** `systemctl disable ssh` puis reboot.
- **Attendu réel.** Le service ne démarre pas au boot ; il n'est pas
  « en panne », il est absent.
- **État actuel.** ✅ `enabled`/`disabled` modélisés.
- **Cible.** Vérifier que le reboot respecte l'état `enabled`.
- **Observabilité.** `systemctl is-enabled`, `systemctl list-unit-files`.
- **Sévérité.** `notice` (état voulu) — mais `critical` si le service est une
  dépendance d'un autre service.

### F6.4 — Échec de dépendance

- **Déclencheur.** Service B avec `Requires=A`, A en échec.
- **Attendu réel.** B ne démarre pas :
  `Job for B.service failed because a dependency failed.`
- **État actuel.** ⚠️ À vérifier — la propagation `Requires=`/`BindsTo=`
  n'est pas confirmée côté Linux (elle l'est côté Windows, avec cascade).
- **Cible.** Implémenter la propagation, en réutilisant le même modèle que
  Windows (`getDependents`, `stopServiceCascade`) plutôt qu'en inventer un
  second.
- **Observabilité.** `systemctl status`, `systemctl list-dependencies`.
- **Réparation.** Réparer A d'abord.
- **Sévérité.** `critical`, avec `causedBy` pointant l'incident de A.

### F6.5 — Service en échec sur configuration invalide

- **Déclencheur.** Éditer `sshd_config` avec une directive invalide puis
  redémarrer.
- **Attendu réel.** `sshd: /etc/ssh/sshd_config line 12: Bad configuration
  option: Foo` et refus de démarrer. **Le service précédent continue de
  tourner** si c'est un `reload` et non un `restart`.
- **État actuel.** ⚠️ La validation existe (`sshd -t`) mais n'est pas
  appliquée au démarrage réel.
- **Cible.** Brancher la validation existante sur le démarrage via le
  contrat §6.2 (`validate`). Distinguer `reload` (l'ancien tourne toujours)
  de `restart` (rien ne tourne).
- **Observabilité.** `systemctl status`, `journalctl -u ssh`, `sshd -t`.
- **Réparation.** Corriger le fichier.
- **Sévérité.** `critical`.

### F6.6 — Conflit de port

- **Déclencheur.** Deux services configurés sur le même port.
- **Attendu réel.** Le second échoue : `bind: Address already in use`.
- **État actuel.** ⚠️ `linux.port.bound` / `.released` existent ; le refus
  de double liaison est à vérifier.
- **Cible.** Refus explicite avec le message réel.
- **Observabilité.** `ss -tlnp`, `journalctl`.
- **Réparation.** Changer le port ou arrêter l'autre service.
- **Sévérité.** `critical`.

### F6.7 — Service dont l'utilisateur dédié a été supprimé

- **Déclencheur.** `userdel` d'un compte de service (`User=` dans l'unité).
- **Attendu réel.** `Failed to determine user credentials: No such process`,
  service en `failed`.
- **État actuel.** ❌ Non modélisé.
- **Cible.** Le contrat §6.2 couvre ce cas si l'unité déclare l'utilisateur
  comme ressource.
- **Observabilité.** `systemctl status`.
- **Réparation.** Recréer l'utilisateur.
- **Sévérité.** `critical`.

### F6.8 — Timer / tâche cron qui ne se déclenche plus

- **Déclencheur.** `cron` arrêté, crontab supprimé, permissions de crontab
  incorrectes.
- **Attendu réel.** Silence total — c'est la panne la plus insidieuse :
  rien n'échoue, rien ne se passe.
- **État actuel.** ✅ Cron réel avec journalisation.
- **Cible.** Comme c'est une panne **silencieuse**, elle mérite un
  traitement UI spécifique : si `cron` est inactif alors qu'au moins un
  crontab non vide existe, lever un incident `degraded` proactif. C'est
  exactement le type d'aide qu'un apprenant ne peut pas se donner seul.
- **Observabilité.** `systemctl status cron`, `crontab -l`, `journalctl -u cron`.
- **Réparation.** Redémarrer cron, corriger les permissions.
- **Sévérité.** `degraded`.

### F6.9 — Service Windows arrêté avec dépendants

- **Déclencheur.** `Stop-Service RpcSs`.
- **Attendu réel.** Windows refuse ou arrête en cascade, selon le contexte.
- **État actuel.** ✅ Modélisé (`stopServiceCascade`, `getDependents`).
- **Cible.** Aucune correction. Vérifier les messages exacts.
- **Observabilité.** `Get-Service`, `sc query`, journal d'événements.
- **Réparation.** Redémarrer dans l'ordre des dépendances.
- **Sévérité.** `critical`.

### F6.10 — Service en état `activating` bloqué

- **Déclencheur.** Service dont le démarrage n'aboutit jamais.
- **Attendu réel.** `TimeoutStartSec` atteint → `failed (timeout)`.
- **État actuel.** ❌ Pas de timeout de démarrage.
- **Cible.** Ajouter `TimeoutStartSec` avec le message réel. Faible coût,
  réutilise les timers existants.
- **Observabilité.** `systemctl status` (`start operation timed out`).
- **Sévérité.** `critical`.

---

## 13. Catalogue F7 — Suppression et corruption de fichiers sensibles

C'est la famille la plus demandée et la moins couverte. Elle mérite un
traitement systématique.

### 13.1 Classification des fichiers

| Classe | Exemples | Effet de la suppression |
|---|---|---|
| **C1 — Config critique de service** | `/etc/ssh/sshd_config`, `/etc/named.conf`, `/etc/nginx/nginx.conf` | Le service refuse de démarrer |
| **C2 — Identité système** | `/etc/passwd`, `/etc/shadow`, `/etc/group` | Connexions impossibles, système inutilisable |
| **C3 — Clés et certificats** | `/etc/ssh/ssh_host_*_key`, certificats TLS | Service démarre ou non selon le cas, connexions refusées |
| **C4 — Exécutables** | `/bin/ls`, `/usr/sbin/sshd` | Commande introuvable, service non relançable |
| **C5 — Bibliothèques** | `/lib/x86_64-linux-gnu/libc.so.6` | Catastrophe totale |
| **C6 — Résolution / réseau** | `/etc/resolv.conf`, `/etc/hosts`, `/etc/network/interfaces` | Résolution ou configuration réseau perdue |
| **C7 — Données applicatives** | fichiers de données Oracle, journaux de redo | Base non montable |
| **C8 — Runtime volatile** | `/run/*.pid`, sockets Unix | Généralement bénin, sauf verrous |
| **C9 — Journaux** | `/var/log/*` | Perte de traçabilité, pas de perte de service |

### F7.1 — Suppression de `/etc/ssh/sshd_config` (C1)

- **Déclencheur.** `rm /etc/ssh/sshd_config`.
- **Attendu réel.** sshd **continue** de tourner (config déjà chargée en
  mémoire). Au `restart` : `sshd: no such file or directory` et échec.
  Au `reload` : échec, l'ancien reste actif.
- **État actuel.** ❌ **Aucun effet.** Dix sites d'appel font `?? ''` et
  `SshdServerConfig.parse('')` renvoie les valeurs par défaut. Le service
  redémarre et fonctionne.
- **Cible.**
  1. Le VFS publie `fs.file.deleted`.
  2. L'unité `ssh.service` déclare `/etc/ssh/sshd_config` en dépendance
     dure (§6.2).
  3. Le démarrage échoue avec le message réel.
  4. La distinction absent / vide est introduite (§6.3) pour ce fichier
     d'abord.
- **Observabilité.** `systemctl status ssh`, `journalctl -u ssh`,
  `sshd -t`, incident `critical`.
- **Réparation.** Recréer le fichier (le simulateur peut proposer un
  gabarit par défaut, comme le ferait une réinstallation de paquet).
- **Sévérité.** `degraded` tant que le processus vit, `critical` au
  redémarrage.

### F7.2 — Suppression des clés d'hôte SSH (C3)

- **Déclencheur.** `rm /etc/ssh/ssh_host_ed25519_key*`.
- **Attendu réel.** `sshd: no hostkeys available -- exiting.`
- **État actuel.** ❌ Non modélisé.
- **Cible.** Dépendance dure. Message exact.
- **Effet client intéressant.** Si les clés sont **régénérées** au lieu
  d'être restaurées, tous les clients voient l'avertissement
  `REMOTE HOST IDENTIFICATION HAS CHANGED!` — comportement déjà modélisé
  côté client (`SshKnownHostsFile.hostKeyChanged`). Le chaînage des deux est
  un excellent scénario.
- **Observabilité.** `systemctl status`, `ssh-keygen -A` pour régénérer.
- **Réparation.** `ssh-keygen -A`.
- **Sévérité.** `critical`.

### F7.3 — Suppression de `/etc/passwd` (C2)

- **Déclencheur.** `rm /etc/passwd`.
- **Attendu réel.** Catastrophe : plus aucune connexion, `id` échoue, `ls -l`
  affiche des UID numériques au lieu des noms. Les sessions **déjà ouvertes**
  survivent.
- **État actuel.** ❌ `LinuxUserManager` tient les comptes en mémoire ; le
  fichier est une projection. Sa suppression n'a aucun effet.
- **Cible.** Nuance importante et honnête : le simulateur ne relit pas
  `/etc/passwd` (il n'existe aucun analyseur inverse — c'est déjà documenté
  comme limite dans `topologySerializer`). Deux options :
  - **(a)** Modéliser l'effet sans relire le fichier : marquer la base de
    comptes comme « source absente » et faire échouer les résolutions de nom
    (affichage d'UID numériques, `getent passwd` vide, connexions refusées).
  - **(b)** Implémenter la relecture réelle.

  **Choix : (a).** L'option (b) est un chantier séparé (reconstruire
  `LinuxUserAccount` avec ses ~15 champs, dont des champs absents du
  fichier), tandis que (a) produit exactement les symptômes observables pour
  un coût faible et sans mentir sur le modèle.
- **Observabilité.** `id` (échec), `ls -l` (UID numériques), `getent passwd`
  (vide), `su` (échec).
- **Réparation.** Restaurer depuis `/etc/passwd-` (la sauvegarde que les
  outils shadow maintiennent réellement — bonne occasion de la modéliser).
- **Sévérité.** `critical`.

### F7.4 — Suppression de `/etc/shadow` (C2)

- **Déclencheur.** `rm /etc/shadow`.
- **Attendu réel.** Aucune authentification par mot de passe ne fonctionne ;
  les clés SSH continuent de marcher.
- **État actuel.** ❌ Non modélisé.
- **Cible.** Même approche que F7.3 : les vérifications de mot de passe
  échouent, l'authentification par clé publique continue. La dissociation
  des deux voies est pédagogiquement excellente.
- **Observabilité.** `su` échoue, `ssh` par clé réussit.
- **Réparation.** Restaurer depuis `/etc/shadow-`.
- **Sévérité.** `critical`.

### F7.5 — Suppression de `/etc/sudoers` (C2)

- **Déclencheur.** `rm /etc/sudoers`.
- **Attendu réel.** `sudo: /etc/sudoers is required` — plus aucune
  élévation possible, y compris pour réparer.
- **État actuel.** ⚠️ Le moteur sudoers est réel et lit le fichier. À
  vérifier : l'absence doit être un refus explicite, pas un « aucune règle
  donc refus » silencieux (le message diffère).
- **Cible.** Message exact. C'est aussi le meilleur exemple de **panne
  irrécupérable sans accès root** : à mettre en avant comme leçon.
- **Observabilité.** `sudo` échoue avec le message dédié.
- **Réparation.** Root direct, ou mode mono-utilisateur.
- **Sévérité.** `critical`.

### F7.6 — Corruption syntaxique de `/etc/sudoers` (C2)

- **Déclencheur.** Écrire une ligne invalide sans passer par `visudo`.
- **Attendu réel.** `sudo: parse error in /etc/sudoers near line N` et refus
  total.
- **État actuel.** ✅ **Bien modélisé** — `visudo -c` existe et un fichier
  invalide dans `sudoers.d` bloque déjà tout (testé).
- **Cible.** Aucune correction. À mettre en avant comme exemple de ce qui
  est déjà bien fait.
- **Sévérité.** `critical`.

### F7.7 — Suppression d'un exécutable système (C4)

- **Déclencheur.** `rm /bin/ls`.
- **Attendu réel.** `bash: /bin/ls: No such file or directory`, code 127.
  Les shells qui ont mis le chemin en cache (`hash`) donnent un message
  différent jusqu'au `hash -r`.
- **État actuel.** ❌ **Aucun effet.** Le dispatch est un `switch` sur ~269
  `case` qui ne consulte jamais le VFS.
- **Cible.** C'est le gap le plus visible et il faut être réaliste sur son
  coût. Trois options :
  - **(a)** Vérifier l'existence du binaire dans le VFS avant le `switch`.
  - **(b)** Reconstruire un vrai résolveur PATH.
  - **(c)** Ne rien faire.

  **Choix : (a).** Une seule vérification en tête de dispatch, contre une
  table de correspondance commande → chemin canonique
  (`ls` → `/bin/ls`, `ssh` → `/usr/bin/ssh`, …). Si le chemin est absent du
  VFS **et** que le VFS a été modifié par l'utilisateur pour ce chemin, on
  échoue. Le garde-fou « modifié par l'utilisateur » évite de casser les
  centaines de tests existants dont le VFS ne contient pas tous les
  binaires : on ne fait échouer que ce que l'utilisateur a **explicitement
  supprimé**, ce qui est exactement le comportement voulu et rien de plus.
  L'option (b) est un chantier disproportionné pour le gain.
- **Observabilité.** Message et code 127, `which ls` (rien), `type ls`.
- **Réparation.** Restaurer le fichier.
- **Sévérité.** `critical`.

### F7.8 — Suppression du binaire d'un service en cours (C4)

Voir F5.10 — le processus survit, la relance échoue.

### F7.9 — Suppression de `/etc/resolv.conf` (C6)

- **Déclencheur.** `rm /etc/resolv.conf`.
- **Attendu réel.** Plus de résolution DNS. Les IP littérales continuent de
  fonctionner — distinction essentielle en diagnostic.
- **État actuel.** ⚠️ La pile de résolution est riche
  (`ResolvedService`, NSS, mDNS, LLMNR). À vérifier : l'absence du fichier
  doit couper la voie DNS unicast sans casser `/etc/hosts`, mDNS ni LLMNR.
- **Cible.** Comportement fidèle à systemd-resolved : sans serveur
  configuré, la voie unicast échoue, les voies lien-local subsistent.
- **Observabilité.** `ping nom` échoue / `ping IP` réussit, `resolvectl status`,
  `getent hosts`.
- **Réparation.** Recréer le fichier.
- **Sévérité.** `degraded` (le réseau marche, la résolution non).

### F7.10 — Suppression de `/etc/hosts` (C6)

- **Déclencheur.** `rm /etc/hosts`.
- **Attendu réel.** `localhost` ne résout plus, sauf repli.
- **État actuel.** ⚠️ `HostsFile` existe.
- **Cible.** Échec de résolution des noms statiques, DNS toujours
  fonctionnel.
- **Sévérité.** `degraded`.

### F7.11 — Suppression d'un fichier de journal en cours d'écriture (C9)

- **Déclencheur.** `rm /var/log/auth.log` alors que rsyslog écrit dedans.
- **Attendu réel.** **Piège classique** : l'espace disque n'est pas libéré et
  les nouvelles lignes vont dans un inode fantôme, jusqu'au
  `systemctl restart rsyslog` ou `logrotate`.
- **État actuel.** ❌ Non modélisé ; le fichier serait simplement recréé.
- **Cible.** Modéliser le comportement réel : après suppression, les
  écritures partent dans le vide, `ls` ne montre rien, et seul un
  redémarrage du service rétablit le fichier. Faible coût, très forte valeur
  pédagogique.
- **Observabilité.** `ls -l /var/log/auth.log` (absent), écritures perdues,
  `lsof | grep deleted`.
- **Réparation.** `systemctl restart rsyslog`.
- **Sévérité.** `degraded`.

### F7.12 — Suppression d'un fichier de données Oracle (C7)

- **Déclencheur.** `rm /u01/.../system01.dbf`.
- **Attendu réel.** `ORA-01110: data file 1: '...'` au montage, base non
  ouvrable.
- **État actuel.** ❌ `OracleStorage` est en mémoire ; la synchronisation
  VFS (`OracleFilesystemSync`) est une projection.
- **Cible.** Faire réagir la synchronisation : la disparition d'un fichier
  projeté marque le datafile correspondant comme manquant, et
  `ALTER DATABASE OPEN` échoue avec `ORA-01110`. Réutilise l'adaptateur
  existant plutôt que d'inventer un couplage.
- **Observabilité.** `startup`, `V$DATAFILE`, `RMAN> report schema`.
- **Réparation.** Restauration RMAN (déjà modélisée) — bel enchaînement
  panne → sauvegarde → restauration.
- **Sévérité.** `critical`.

### F7.13 — Suppression de `/etc/fstab` (C6)

- **Déclencheur.** `rm /etc/fstab`.
- **Attendu réel.** Aucun effet immédiat ; au redémarrage, les montages
  n'ont plus lieu.
- **État actuel.** ⚠️ `MountTable` existe.
- **Cible.** Effet différé au redémarrage — bon exemple de panne à
  déclenchement retardé.
- **Sévérité.** `notice` puis `critical` au reboot.

### F7.14 — Suppression d'un fichier d'unité systemd (C1)

- **Déclencheur.** `rm /etc/systemd/system/x.service`.
- **Attendu réel.** L'unité reste chargée jusqu'au `daemon-reload`, puis
  disparaît : `Unit x.service not found.`
- **État actuel.** ❌ Non modélisé.
- **Cible.** Effet au `daemon-reload`, pas avant. La latence est le point
  intéressant.
- **Observabilité.** `systemctl status` avant/après `daemon-reload`.
- **Sévérité.** `critical`.

### F7.15 — Permissions incorrectes sur `~/.ssh/authorized_keys` (C3)

- **Déclencheur.** `chmod 644 ~/.ssh/authorized_keys`.
- **Attendu réel.** StrictModes refuse la clé, repli sur mot de passe.
- **État actuel.** ✅ **Modélisé des deux côtés** (client et serveur), avec
  le message `Authentication refused: bad ownership or modes for file …`.
- **Cible.** Aucune correction. Exemple de ce qui est déjà bien fait.
- **Sévérité.** `degraded`.

### F7.16 — Permissions incorrectes sur `/etc/shadow`

- **Déclencheur.** `chmod 644 /etc/shadow`.
- **Attendu réel.** Faille de sécurité, signalée par `pwck` et les outils
  d'audit ; pas de perte de service.
- **État actuel.** ✅ `pwck` existe et vérifie les permissions.
- **Cible.** Lever un incident `degraded` de nature **sécurité** — nouvelle
  catégorie utile : la panne n'est pas fonctionnelle, elle est une
  vulnérabilité.
- **Sévérité.** `degraded` (sécurité).

### F7.17 — Fichier de configuration vide vs absent

- **Déclencheur.** `> /etc/ssh/sshd_config` (vide) vs `rm` (absent).
- **Attendu réel.** Vide : sshd démarre avec les valeurs par défaut (légal !).
  Absent : sshd refuse.
- **État actuel.** ❌ Indistinguable (`?? ''`).
- **Cible.** C'est précisément ce que résout §6.3. À traiter comme test de
  référence de cette section.
- **Sévérité.** `notice` (vide) / `critical` (absent).

### F7.18 — Fichier remplacé par un répertoire

- **Déclencheur.** `rm /etc/hosts && mkdir /etc/hosts`.
- **Attendu réel.** `EISDIR: Is a directory` à la lecture.
- **État actuel.** ⚠️ Le VFS distingue les types ; le message est à
  vérifier.
- **Cible.** Message errno correct.
- **Sévérité.** `critical`.

### F7.19 — Lien symbolique cassé

- **Déclencheur.** Supprimer la cible d'un lien symbolique.
- **Attendu réel.** `ENOENT` à l'ouverture, `ls -l` montre le lien en rouge,
  `ls -L` échoue.
- **État actuel.** ⚠️ Les liens existent dans le VFS
  (`resolveInode(p, followSymlinks)`).
- **Cible.** Vérifier le comportement et l'affichage.
- **Sévérité.** Dépend de la cible.

### F7.20 — Système de fichiers monté en lecture seule

- **Déclencheur.** `mount -o remount,ro /`.
- **Attendu réel.** Toute écriture échoue : `Read-only file system` (EROFS).
  C'est le mode de repli d'un noyau qui détecte une corruption disque.
- **État actuel.** ❌ Non modélisé.
- **Cible.** Ajouter le drapeau `ro` sur le montage et le faire respecter
  par le VFS. Couvre en une fois : échec d'écriture, échec de journalisation,
  services qui tombent, et le scénario « disque en défaut ».
- **Observabilité.** `mount`, `touch` qui échoue, `dmesg`.
- **Réparation.** `mount -o remount,rw /`.
- **Sévérité.** `critical`.

---

## 14. Catalogue F8 — Pannes de permissions et d'identité

### F8.1 — Compte verrouillé après échecs répétés

- **Déclencheur.** Trois mots de passe faux.
- **Attendu réel.** Verrouillage `pam_faillock`, déverrouillage automatique
  après `unlock_time`.
- **État actuel.** ✅ **Modélisé, y compris le déverrouillage temporel** —
  c'était un bug corrigé (verrouillage définitif auparavant).
- **Cible.** Aucune correction.
- **Observabilité.** `faillock`, `/var/log/auth.log`.
- **Sévérité.** `degraded`.

### F8.2 — Compte expiré

- **Déclencheur.** `chage -E` dans le passé.
- **Attendu réel.** `Your account has expired; please contact your system
  administrator`.
- **État actuel.** ✅ Modélisé, y compris la cascade vers SSH.
- **Sévérité.** `critical` pour l'utilisateur.

### F8.3 — Mot de passe expiré

- **Déclencheur.** `chage -d 0`.
- **Attendu réel.** Changement forcé à la connexion.
- **État actuel.** ✅ Modélisé.
- **Sévérité.** `degraded`.

### F8.4 — Utilisateur retiré d'un groupe privilégié

- **Déclencheur.** `gpasswd -d user sudo`.
- **Attendu réel.** `user is not in the sudoers file. This incident will be
  reported.` — et la ligne dans `auth.log`.
- **État actuel.** ✅ Modélisé (moteur sudoers réel).
- **Cible.** Piège à vérifier : l'appartenance à un groupe n'est prise en
  compte qu'à la **prochaine ouverture de session**. Une session déjà
  ouverte garde ses groupes. C'est un point de confusion classique qui vaut
  la peine d'être fidèle.
- **Sévérité.** `degraded`.

### F8.5 — Répertoire personnel supprimé

- **Déclencheur.** `rm -rf /home/user`.
- **Attendu réel.** La connexion réussit mais atterrit sur `/`, avec
  `Could not chdir to home directory`.
- **État actuel.** ❌ Non modélisé.
- **Cible.** Message exact et repli sur `/`. Faible coût.
- **Sévérité.** `degraded`.

### F8.6 — Shell de connexion invalide

- **Déclencheur.** `usermod -s /bin/nologin user` ou shell supprimé.
- **Attendu réel.** `This account is currently not available.`
- **État actuel.** ⚠️ À vérifier.
- **Cible.** Message exact, et **cohérence avec F7.7** : un shell supprimé
  doit produire le même effet qu'un shell invalide.
- **Sévérité.** `critical` pour l'utilisateur.

### F8.7 — Propriétaire de fichier devenu orphelin

- **Déclencheur.** `userdel` d'un utilisateur qui possédait des fichiers.
- **Attendu réel.** `ls -l` affiche l'UID numérique.
- **État actuel.** ❌ Non modélisé.
- **Cible.** Affichage numérique en repli — cohérent avec F7.3.
- **Sévérité.** `notice`.

### F8.8 — Permissions retirées sur un répertoire de service

- **Déclencheur.** `chmod 000 /var/lib/x`.
- **Attendu réel.** Le service échoue au démarrage : `Permission denied`.
- **État actuel.** ⚠️ Le VFS gère les permissions ; la vérification côté
  service est à confirmer.
- **Cible.** Le contrat §6.2 couvre ce cas (`kind: 'device'` ou ressource
  chemin, avec vérification de lisibilité).
- **Sévérité.** `critical`.

### F8.9 — Suppression du compte root

- **Déclencheur.** Tentative de `userdel root`.
- **Attendu réel.** Les outils shadow refusent :
  `userdel: user root is currently used by process 1`.
- **État actuel.** ⚠️ À vérifier.
- **Cible.** Refus explicite. Une panne qu'on **empêche** est aussi
  pédagogique qu'une panne qu'on subit.
- **Sévérité.** —

---

## 15. Catalogue F9 — Pannes de ressources (disque, mémoire, PID, FD)

### F9.1 — Système de fichiers plein

- **Déclencheur.** Écriture au-delà du quota configuré.
- **Attendu réel.** `No space left on device` (ENOSPC). Effets en cascade :
  journalisation arrêtée, bases en erreur, sessions qui échouent.
- **État actuel.** ✅ Implémenté. La capacité appartient au système de
  fichiers (`VirtualFileSystem.setCapacityBytes`), et `df` la LIT au lieu
  d'afficher une constante à lui : le rapport et l'écriture suivante ne
  peuvent plus se contredire. La vérification porte sur le **delta**, donc
  remplacer un gros fichier par un autre de même taille passe, comme sur un
  vrai volume. Corrigé au passage : `truncate -s` extrayait la taille de la
  ligne de commande puis l'ignorait — il n'existait aucun moyen d'occuper
  de la place, c'est-à-dire aucun moyen de provoquer la panne.
- **Cible.** Atteinte (défaut 50 Gio, donc invisible tant qu'un TP ne
  rétrécit pas le volume). Message ENOSPC réel, et le refus ne détruit
  rien.
- **Observabilité.** `df -h`, `du -sh`, message d'erreur.
- **Réparation.** Supprimer des fichiers, agrandir.
- **Sévérité.** `critical`.

### F9.2 — Inodes épuisés

- **Déclencheur.** Trop de petits fichiers.
- **Attendu réel.** `No space left on device` **alors que `df -h` montre de
  la place** — le grand classique déroutant. Seul `df -i` révèle la cause.
- **État actuel.** ✅ Implémenté. Compteur d'inodes séparé du volume
  (défaut 655 360) : `touch` et `mkdir` échouent en ENOSPC **alors que
  `df -h` montre de la place**, et seul `df -i` explique. Supprimer un
  fichier rend l'inode et l'écriture repasse.
- **Cible.** Atteinte.
- **Observabilité.** `df -i`.
- **Sévérité.** `critical`.

### F9.3 — Descripteurs de fichiers épuisés

- **Déclencheur.** Dépassement de `ulimit -n`.
- **Attendu réel.** `Too many open files` (EMFILE).
- **État actuel.** ❌ Non modélisé.
- **Cible.** Limite par processus, message réel. Cohérent avec F5.8.
- **Observabilité.** `ulimit -n`, `lsof | wc -l`, `/proc/<pid>/fd`.
- **Sévérité.** `critical`.

### F9.4 — Ports éphémères épuisés

- **Déclencheur.** Trop de connexions sortantes simultanées.
- **Attendu réel.** `Cannot assign requested address` (EADDRNOTAVAIL).
- **État actuel.** ⚠️ `SocketTable` alloue les ports ; l'épuisement est à
  vérifier.
- **Cible.** Refus explicite à saturation.
- **Observabilité.** `ss -s`, `sysctl net.ipv4.ip_local_port_range`.
- **Sévérité.** `critical`.

### F9.5 — Mémoire épuisée

Voir F5.9. Modélisation déclarative uniquement.

### F9.6 — Montage réseau perdu

- **Déclencheur.** Serveur NFS éteint alors qu'un montage est actif.
- **Attendu réel.** Accès bloqués en état `D` (montage dur) ou erreurs
  (montage souple). `df` se fige.
- **État actuel.** ❌ Non modélisé.
- **Cible.** Combiné avec F5.7 (état `D`), c'est un scénario riche et
  cohérent : le montage perdu **est** la cause de l'état `D`.
- **Observabilité.** `mount`, `df` qui se fige, `ps` (`D`).
- **Réparation.** Rallumer le serveur, ou `umount -l`.
- **Sévérité.** `critical`.

### F9.7 — Table ARP saturée / cache empoisonné

- **Déclencheur.** Trop d'entrées, ou entrée statique erronée.
- **Attendu réel.** Trafic mal dirigé.
- **État actuel.** ✅ ARP réel, entrées statiques supportées.
- **Cible.** Aucune correction ; bon scénario de sécurité.
- **Sévérité.** `degraded`.

### F9.8 — Pool DHCP épuisé

- **Déclencheur.** Plus d'adresses disponibles.
- **Attendu réel.** Le client n'obtient rien, reste en `169.254.x.x`
  (APIPA / lien-local).
- **État actuel.** ⚠️ Le serveur DHCP est réel avec baux persistants. Le
  comportement à l'épuisement est à vérifier.
- **Cible.** Absence de réponse (pas de NAK), repli lien-local côté client.
- **Observabilité.** `journalctl -u dhcpd`, `ip addr` (169.254), incident.
- **Réparation.** Élargir le pool, réduire la durée de bail.
- **Sévérité.** `critical`.

---

## 16. Catalogue F10 — Pannes applicatives

### F10.1 — Listener Oracle arrêté

- **Déclencheur.** `lsnrctl stop`.
- **Attendu réel.** `ORA-12541: TNS:no listener`. Les sessions **déjà
  établies** continuent (le listener ne sert qu'à établir).
- **État actuel.** ✅ Modélisé (`ListenerControl.ts`).
- **Cible.** Vérifier explicitement la survie des sessions établies : c'est
  précisément le point que les administrateurs débutants comprennent mal.
- **Observabilité.** `lsnrctl status`, `tnsping`, `sqlplus`.
- **Réparation.** `lsnrctl start`.
- **Sévérité.** `critical`.

### F10.2 — Instance Oracle arrêtée

- **Déclencheur.** `shutdown immediate`.
- **Attendu réel.** `ORA-01034: ORACLE not available`. Le listener répond
  encore mais n'a plus de service : `ORA-12514`.
- **État actuel.** ✅ Les deux codes existent (`OracleConfig.ts:85`,
  `ListenerControl.ts:149`).
- **Cible.** Vérifier l'enchaînement correct des deux messages selon l'état.
- **Sévérité.** `critical`.

### F10.3 — Base en `MOUNT` au lieu de `OPEN`

- **Déclencheur.** `startup mount`.
- **Attendu réel.** `ORA-01219: database not open`.
- **État actuel.** ✅ Les états sont modélisés.
- **Sévérité.** `degraded`.

### F10.4 — Tablespace hors ligne

- **Déclencheur.** `ALTER TABLESPACE x OFFLINE`.
- **Attendu réel.** `ORA-00376` sur les objets concernés, le reste marche.
- **État actuel.** ⚠️ À vérifier.
- **Sévérité.** `degraded`.

### F10.5 — Éviction de nœud RAC

- **Déclencheur.** Perte de l'interconnexion privée.
- **Attendu réel.** CSS détecte, évince, les journaux CRS l'attestent, les
  clients TAF basculent.
- **État actuel.** ✅ **Implémenté récemment** — `RacCssAgent`, journaux
  horodatés, bascule TAF, `V$ACTIVE_INSTANCES`.
- **Cible.** Aucune correction. Remonter dans le registre d'incidents.
- **Sévérité.** `critical`.

### F10.6 — Serveur DNS arrêté

- **Déclencheur.** `systemctl stop named`.
- **Attendu réel.** Résolution en échec, repli sur le serveur secondaire s'il
  existe, `/etc/hosts` toujours actif.
- **État actuel.** ✅ DNS réel (bind9).
- **Cible.** Vérifier le repli sur secondaire et le délai.
- **Observabilité.** `dig`, `nslookup`, `resolvectl status`.
- **Sévérité.** `critical` si serveur unique, `degraded` sinon.

### F10.7 — Zone DNS corrompue

- **Déclencheur.** Erreur de syntaxe dans un fichier de zone.
- **Attendu réel.** `named-checkzone` échoue, la zone n'est pas chargée,
  **les autres zones continuent**.
- **État actuel.** ⚠️ `named-checkzone` à vérifier.
- **Cible.** Isolation par zone — une zone cassée ne casse pas le serveur.
- **Sévérité.** `degraded`.

### F10.8 — Serveur DHCP arrêté

- **Déclencheur.** Arrêt du service.
- **Attendu réel.** Les baux **existants** restent valides jusqu'à
  expiration ; les nouveaux clients échouent. Le renouvellement échoue à
  T1/T2 mais le client garde l'adresse jusqu'à la fin du bail.
- **État actuel.** ✅ Baux persistants modélisés.
- **Cible.** Vérifier la temporisation T1/T2 — c'est le point subtil et
  intéressant.
- **Sévérité.** `degraded` puis `critical` à expiration.

### F10.9 — Certificat TLS expiré

- **Déclencheur.** Date de validité dépassée.
- **Attendu réel.** Refus client avec le message d'erreur idoine.
- **État actuel.** ⚠️ TLS modélisé (`PRD-TLS.md`).
- **Cible.** Vérifier la vérification de dates.
- **Sévérité.** `critical`.

### F10.10 — Contrôleur de domaine injoignable

- **Déclencheur.** Extinction du DC.
- **Attendu réel.** Les connexions avec identifiants **mis en cache**
  fonctionnent ; les nouvelles échouent ; la GPO ne s'applique plus.
- **État actuel.** ⚠️ AD largement modélisé.
- **Cible.** Modéliser le cache d'identifiants — c'est la distinction que
  tout administrateur Windows doit connaître.
- **Sévérité.** `critical`.

### F10.11 — Réplication AD en échec

- **Déclencheur.** Lien coupé entre DC.
- **Attendu réel.** `repadmin /showrepl` montre l'échec, divergence des
  bases.
- **État actuel.** ✅ Repadmin très complet.
- **Cible.** Aucune correction.
- **Sévérité.** `degraded`.

### F10.12 — Serveur web arrêté / port fermé

- **Déclencheur.** Arrêt du service ou pare-feu.
- **Attendu réel.** `Connection refused` (service arrêté) vs
  **timeout** (pare-feu DROP) vs `Connection refused` (pare-feu REJECT).
- **État actuel.** ✅ La distinction DROP/REJECT est modélisée.
- **Cible.** Aucune correction. **Excellent** exercice de diagnostic : trois
  causes, deux symptômes.
- **Sévérité.** `critical`.

---

## 17. Catalogue F11 — Pannes en cascade et scénarios composés

Ces scénarios ne créent aucun mécanisme nouveau : ils **composent** les
précédents. Leur valeur est pédagogique, et ils servent de tests
d'intégration pour la propagation.

### S1 — « Le serveur ne répond plus » (diagnostic en entonnoir)

1. Le serveur applicatif ne répond plus.
2. `ping IP` → échec. `ping` de la passerelle → OK.
3. Le lien du serveur est rouge sur le canvas.
4. Cause : câble débranché (F1.1).

**Objectif pédagogique.** Descendre les couches méthodiquement.
**Incidents attendus.** 1 `critical` (lien), plusieurs `causedBy`.

### S2 — « SSH marchait ce matin »

1. `ssh` échoue en `Connection refused`.
2. `systemctl status ssh` → `failed`.
3. `journalctl -u ssh` → `Bad configuration option: Prot`.
4. Cause : faute de frappe dans `sshd_config` (F6.5).

**Objectif.** Le refus (RST) désigne un service mort, pas un réseau coupé.

### S3 — « Plus personne ne peut se connecter »

1. Toutes les connexions échouent, y compris locales.
2. Les sessions déjà ouvertes fonctionnent.
3. `id` échoue même dans les sessions ouvertes.
4. Cause : `/etc/passwd` supprimé (F7.3).

**Objectif.** Distinguer état chargé en mémoire et état sur disque.

### S4 — « Le service redémarre en boucle »

1. `systemctl status` → `activating (auto-restart)`, puis `failed`.
2. `start request repeated too quickly`.
3. Cause : dépendance manquante (F6.4) ou binaire supprimé (F5.10).

**Objectif.** Comprendre `StartLimit` et `reset-failed`.

### S5 — « La moitié du réseau est tombée »

1. Un VLAN entier perd la connectivité, les autres non.
2. Cause : `switchport trunk allowed vlan` modifié (F3.1), ou écrasement VTP
   (F3.9).

**Objectif.** Panne partielle ≠ panne totale ; savoir délimiter.

### S6 — « Ça marche par IP mais pas par nom »

1. `ping 10.0.0.5` OK, `ping serveur` échoue.
2. Cause : `/etc/resolv.conf` supprimé (F7.9) ou DNS arrêté (F10.6).

**Objectif.** Isoler la résolution de la connectivité.

### S7 — « Le disque est plein mais `df` dit le contraire »

1. Écritures en `No space left on device`.
2. `df -h` : 40 % utilisé.
3. `df -i` : 100 % d'inodes.
4. Cause : F9.2.

**Objectif.** Deux ressources distinctes derrière un même message.

### S8 — « J'ai supprimé le log et il ne se remplit plus »

1. `rm /var/log/auth.log`, le fichier ne réapparaît pas.
2. L'espace n'est pas libéré.
3. Cause : F7.11.

**Objectif.** Inode ouvert vs entrée de répertoire.

### S9 — « Après le redémarrage du switch, tout est cassé »

1. Un switch redémarre.
2. Les VLAN ont disparu du domaine.
3. Cause : révision VTP supérieure (F3.9).

**Objectif.** La panne la plus destructrice du catalogue, et la moins
intuitive.

### S10 — « Le cluster a évincé un nœud »

1. Nœud RAC évincé.
2. Les clients TAF basculent, les autres reçoivent une erreur.
3. Cause : interconnexion perdue (F10.5).

**Objectif.** Haute disponibilité : ce qui bascule et ce qui ne bascule pas.

### S11 — « Le pare-feu ou le service ? »

Trois labs identiques en apparence :
- (a) service arrêté → `Connection refused` immédiat ;
- (b) `iptables DROP` → timeout ;
- (c) `iptables REJECT` → `Connection refused` immédiat.

**Objectif.** (a) et (c) sont indiscernables du client — il faut l'accès au
serveur pour trancher. Leçon majeure.

### S12 — « Panne en cascade complète »

1. Extinction du serveur NFS.
2. Les processus des clients passent en `D` (F5.7, F9.6).
3. `df` se fige.
4. La journalisation est bloquée.
5. Les services dépendants tombent en timeout (F6.10).

**Objectif.** Une panne, cinq symptômes apparemment sans rapport.

---

## 18. UI/UX — Modèle général

### 18.1 Les trois questions de l'utilisateur

Face à un incident, l'utilisateur se pose trois questions, dans cet ordre :

1. **Est-ce que quelque chose ne va pas ?** → Signal périphérique, visible
   sans chercher.
2. **Où exactement ?** → Localisation sur le canvas, sur l'équipement, sur
   l'interface.
3. **Pourquoi, et comment je répare ?** → Détail, cause, remède.

L'interface doit répondre aux trois **à trois niveaux de profondeur
différents**. Tout mettre au premier niveau produit du bruit ; tout mettre au
troisième produit de l'invisibilité.

### 18.2 Principes UI

**U1 — Le canvas est le tableau de bord.**
L'état de santé doit être lisible sans ouvrir aucun panneau. Un utilisateur
qui revient après cinq minutes voit immédiatement s'il s'est passé quelque
chose.

**U2 — La couleur n'est jamais le seul signal.**
Rouge + pointillé + icône, jamais rouge seul (§24, daltonisme).

**U3 — Pas de fenêtre modale pour une panne.**
Une panne n'interrompt pas : elle informe. Les modales sont réservées aux
actions destructrices que l'utilisateur déclenche (déjà en place :
`ConfirmDialog` pour Clear All / Import).

**U4 — Une panne, une entrée.**
Une cause avec sept conséquences s'affiche comme **un** incident dépliable,
pas huit alertes. C'est le rôle de `causedBy` (§6.1).

**U5 — Toujours proposer l'action suivante.**
Chaque incident expose la commande d'investigation et la commande de
réparation. L'apprenant qui ne sait pas quoi taper apprend en lisant.

**U6 — Ne jamais réparer à la place de l'utilisateur.**
Un bouton « Réparer » qui exécute la commande est acceptable **s'il montre
la commande exécutée** dans le terminal, comme si l'utilisateur l'avait
tapée. Réparation magique et silencieuse : interdit.

**U7 — Cohérence de vocabulaire.**
Les mêmes termes partout : `Connected` / `Admin down` / `No carrier` /
`Failed` — ceux des outils réels, pas des synonymes maison. L'existant
(`PropertiesPanel.tsx:303-333`) est déjà sur cette ligne.

**U8 — L'absence de panne est aussi une information.**
Un état sain doit être affirmé (« Aucun incident »), pas seulement être
l'absence de rouge.

### 18.3 Palette et iconographie

| Sévérité | Couleur | Icône | Bordure | Animation |
|---|---|---|---|---|
| `critical` | `#ef4444` | ⛔ / triangle plein | 2 px pleine | Pulsation lente 2 s, uniquement à l'apparition (3 cycles puis arrêt) |
| `degraded` | `#f59e0b` | ⚠ / triangle creux | 2 px pointillée | Aucune |
| `notice` | `#3b82f6` | ⓘ | 1 px | Aucune |
| Sain | Couleur du type de lien | — | — | — |

`#ef4444` est déjà `DEAD_LINK_COLOR` (`connection-line-logic.ts:64`) : la
palette **réutilise l'existant**, elle ne le remplace pas.

**Sur l'animation.** Une pulsation permanente devient du bruit visuel en
quelques minutes et nuit à l'accessibilité (§24). Elle sert uniquement à
attirer le regard sur un changement, puis s'arrête. Elle est totalement
supprimée sous `prefers-reduced-motion`.

---

## 19. UI/UX — Canvas et topologie

### 19.1 Équipement

État actuel : opacité réduite quand éteint (`NetworkDevice.tsx:245`), bouton
d'alimentation avec `aria-label` (`:283-286`).

À ajouter :

| Élément | Rendu | Condition |
|---|---|---|
| **Pastille d'incident** | Cercle de 14 px en haut à droite de l'icône, couleur de la sévérité maximale, portant le **nombre** d'incidents | ≥ 1 incident |
| **Halo** | Anneau de 2 px de la couleur de sévérité | Incident `critical` |
| **Icône de veille** | L'existant (opacité 50 %) | Éteint |
| **Bandeau de nom** | Le nom passe en couleur de sévérité | `critical` |

**Comportement de la pastille.**
- Survol → infobulle avec les trois premiers incidents et « +N autres ».
- Clic → ouvre le panneau de propriétés sur l'onglet Incidents.
- Elle ne remplace jamais l'icône de l'équipement : elle se superpose.

**Règle anti-bruit.** Un équipement éteint **volontairement** n'affiche pas
de pastille `critical` : l'extinction est un état voulu, signalé par
l'opacité. En revanche ses **voisins**, qui subissent la perte de porteuse,
en affichent une. C'est la sémantique correcte : la panne est subie par
celui qui la subit.

### 19.2 Liens

État actuel : rouge pointillé quand non opérationnel
(`ConnectionLine.tsx:41-47`, `getLinkAppearance`).

À ajouter :

| État | Couleur | Trait | Motif |
|---|---|---|---|
| Opérationnel | Couleur du type | Plein | — |
| Sans porteuse / admin down | `#ef4444` | `6,6` | Existant |
| **Dégradé** (perte, latence, mismatch duplex) | `#f59e0b` | `2,3` | **Nouveau** |
| **Bloqué par STP** | Gris `#6b7280` | `4,4` | **Nouveau** |

Le lien bloqué par STP mérite son propre rendu : il n'est ni en panne ni
opérationnel, il est **volontairement inactif**. Le confondre avec une
panne serait un contresens pédagogique majeur, puisque c'est exactement ce
que STP est censé faire.

**Étiquette de dégradation.** Sur un lien dégradé, une petite étiquette au
milieu : `loss 30%`, `delay 200ms`, `duplex mismatch`. Rendue uniquement
au-dessus d'un certain niveau de zoom, pour ne pas surcharger.

### 19.3 Vue d'ensemble

**Barre de santé** en haut du canvas, discrète, toujours visible :

```
● 12 équipements   ⛔ 2   ⚠ 3   ⓘ 1        [ Incidents ▾ ]
```

- Chaque compteur est cliquable et filtre le canvas (les équipements sans
  incident de ce niveau passent à 30 % d'opacité).
- Quand tout va bien : `✓ Aucun incident` en vert discret (principe U8).
- Le bouton « Incidents » ouvre le centre d'incidents (§22).

**Mode « mise en évidence des incidents ».**
Un basculement qui atténue tout ce qui va bien et met en avant les chemins
touchés. Utile sur les grandes topologies. Purement visuel, sans effet sur
le modèle.

### 19.4 Chaîne de causalité

Quand un incident possède des `causedBy`, survoler la pastille trace une
ligne fine animée depuis la **cause** vers les **conséquences**. Cela répond
visuellement à la question centrale : « lequel de ces sept problèmes dois-je
régler ? ». Réponse : celui d'où partent les flèches.

---

## 20. UI/UX — Panneau de propriétés

Le panneau existe (`PropertiesPanel.tsx`) et affiche déjà le statut des
interfaces (`Connected` / `Admin down`, `:303-333`).

### 20.1 Nouvel onglet « Santé »

Positionné en **premier** dès qu'il y a au moins un incident, sinon en
dernier.

```
┌─ Santé ──────────────────────────────────────────────┐
│                                                       │
│  ⛔ CRITIQUE — ssh.service en échec                    │
│     Depuis 00:02:14                                   │
│     sshd: no hostkeys available -- exiting.           │
│                                                       │
│     Cause      Fichier supprimé :                     │
│                /etc/ssh/ssh_host_ed25519_key          │
│     Diagnostic  systemctl status ssh        [copier]  │
│     Réparation  ssh-keygen -A && systemctl restart ssh│
│                                             [copier]  │
│                                                       │
│  ⚠ DÉGRADÉ — eth1 : perte de 30 %                     │
│     Depuis 00:05:41                                   │
│     Diagnostic  tc qdisc show dev eth1      [copier]  │
│     Réparation  tc qdisc del dev eth1 root  [copier]  │
│                                                       │
└───────────────────────────────────────────────────────┘
```

**Le bouton « copier »**, pas « exécuter » : il place la commande dans le
terminal **sans la lancer**, curseur en fin de ligne. L'utilisateur voit ce
qu'il va exécuter et valide lui-même. C'est le compromis entre l'aide et
l'apprentissage (principe U6).

### 20.2 Onglet Interfaces enrichi

| Colonne | Contenu | État |
|---|---|---|
| Nom | `eth0` | ✅ Existant |
| Adresse | IP/masque | ✅ Existant |
| Statut | `Connected` / `Admin down` | ✅ Existant |
| **Porteuse** | `Yes` / `No` | À ajouter |
| **Dégradation** | `loss 30%`, `delay 200ms`, `—` | À ajouter |
| **Erreurs** | Compteur `errorsIn`/`errorsOut` | À ajouter |

Les compteurs d'erreurs existent déjà sur `Port` : ils ne sont simplement
jamais affichés. Le coût est nul et le gain de diagnostic important.

### 20.3 Onglet Services

Pour les équipements qui en ont :

```
Service          État                    Depuis
ssh              ⛔ failed               00:02:14
cron             ● active (running)      01:12:03
rsyslog          ● active (running)      01:12:03
named            ○ inactive (dead)       —
```

Cliquer sur un service en échec ouvre l'incident correspondant.

### 20.4 Onglet Fichiers critiques

Uniquement quand au moins un fichier critique est absent ou altéré — sinon
l'onglet est masqué (pas d'onglet vide) :

```
Fichier                          État
/etc/ssh/sshd_config             ⛔ Absent
/etc/ssh/ssh_host_ed25519_key    ⛔ Absent
/etc/sudoers                     ⚠ Permissions 0644 (attendu 0440)
```

---

## 21. UI/UX — Terminal

Le terminal est le lieu où la panne doit se manifester **le plus fidèlement
possible**, avec le moins d'enjolivement possible.

### 21.1 Règle d'or : fidélité absolue

Le terminal n'affiche **rien** qu'un vrai terminal n'afficherait pas. Pas
d'icône, pas de couleur ajoutée, pas de suggestion en ligne. Un
`Connection refused` reste un `Connection refused`.

**Justification.** L'apprenant doit reconnaître ces messages sur un vrai
système. Toute aide ajoutée dans le flux de sortie crée une dépendance qui
ne survivra pas hors du simulateur.

### 21.2 Coupures de session

Comportements déjà en place et à préserver :
- Extinction de l'équipement → terminal gelé (`TerminalManager`).
- Lien coupé pendant une session SSH → `client_loop: send disconnect:
  Broken pipe`, retour au shell local.

À ajouter : une **bannière hors flux** (au-dessus de la zone de sortie, pas
dedans) quand la session est morte :

```
┌───────────────────────────────────────────────────────┐
│ ⛔ Session terminée — équipement éteint                │
│    [Rallumer]  [Fermer]                               │
└───────────────────────────────────────────────────────┘
```

Hors flux : elle ne pollue ni la sortie, ni le défilement, ni le
copier-coller, ni la capture de transcript.

### 21.3 Indicateur de santé de l'équipement

Dans la barre d'information du terminal, une pastille discrète reflétant
l'état de l'équipement courant. Cliquable → centre d'incidents.

C'est le seul ajout UI dans le terminal, et il est **hors de la zone de
sortie**.

### 21.4 Ce qu'on ne fait pas

- ❌ Souligner les erreurs dans la sortie.
- ❌ Proposer « vouliez-vous dire… ? » après une commande échouée.
- ❌ Colorer `Connection refused` différemment du reste.
- ❌ Ajouter un lien « en savoir plus » dans la sortie.

Toute cette aide existe — dans le panneau de propriétés et le centre
d'incidents, à un clic de distance.

---

## 22. UI/UX — Journal réseau et centre d'incidents

### 22.1 Le journal existant

`NetworkLogsPanel.tsx` fournit déjà : filtres par niveau, recherche
textuelle, export CSV/JSON, suivi en continu correct (défilement collant
uniquement si l'utilisateur est en bas). **Rien à refaire.**

Deux ajouts :
1. Un filtre supplémentaire « Incidents seulement ».
2. Une colonne de catégorie de panne quand l'entrée provient du registre.

### 22.2 Le centre d'incidents (nouveau)

Un panneau distinct du journal. La différence est fondamentale :

| | Journal | Centre d'incidents |
|---|---|---|
| Contenu | Historique de **tout** | État **courant** des problèmes |
| Nature | Flux chronologique | Inventaire, groupé par cause |
| Volume | Des milliers de lignes | Quelques entrées |
| Question posée | « Que s'est-il passé ? » | « Qu'est-ce qui ne va pas ? » |

```
┌─ Incidents (5) ────────────────────── [Tout] [⛔2] [⚠3] ─┐
│                                                          │
│ ▼ ⛔ Lien coupé — SW1 Gi0/1 ↔ SRV1 eth0      00:03:12    │
│   │  Aucune porteuse des deux côtés.                     │
│   │  Réparer : rebrancher le câble.                      │
│   │                                                      │
│   ├─ ⛔ SRV1 : route par défaut inactive                 │
│   ├─ ⛔ R1 : voisin OSPF 10.0.0.5 perdu                  │
│   └─ ⚠ SRV1 : ntp non synchronisé                        │
│                                                          │
│ ▶ ⛔ SRV2 : ssh.service en échec            00:07:45     │
│                                                          │
│ ▶ ⚠ SW2 Gi0/3 : duplex mismatch             00:12:01     │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**Points de conception.**
- **Groupement par cause.** Quatre problèmes, une seule ligne de premier
  niveau. C'est le principe U4, et c'est ce qui distingue un outil utile
  d'une liste anxiogène.
- **Tri.** Par sévérité, puis par ancienneté (le plus ancien en haut : c'est
  probablement la cause première).
- **Clic** → sélectionne l'équipement sur le canvas et ouvre son panneau.
- **Résolution automatique.** Un incident réparé disparaît, avec une
  transition brève (fondu vert 400 ms) pour que l'utilisateur voie que son
  action a eu un effet. C'est le seul retour positif de l'interface, et il
  est important : sans lui, réparer donne l'impression que rien ne s'est
  passé.
- **Historique.** Un onglet « Résolus » garde les 50 derniers avec leur
  durée. Utile pour un débriefing de lab.

### 22.3 Notifications transitoires

Un `toast` (l'infrastructure existe : `components/ui/toast.tsx`, `sonner`)
uniquement pour les incidents `critical` **nouveaux**, et uniquement si le
centre d'incidents est fermé.

Règles strictes :
- Jamais plus d'un toast à la fois ; les suivants s'agrègent
  (« +3 autres incidents »).
- Disparition automatique en 6 s, sauf survol.
- Jamais de toast pour `degraded` ou `notice`.
- Jamais de toast pour une action que l'utilisateur vient de faire
  lui-même : éteindre un équipement volontairement ne produit pas de
  notification. Le critère : l'incident est-il la conséquence **directe et
  immédiate** de la dernière action utilisateur ? Si oui, silence.

Ce dernier point est ce qui sépare une interface qui aide d'une interface
qui harcèle.

---

## 23. UI/UX — Injection de panne (mode instructeur)

### 23.1 Motivation

Certaines pannes n'ont pas de déclencheur naturel dans l'UI. Débrancher un
câble, oui. Provoquer une désadaptation de duplex, saturer une table MAC ou
remplir un disque : non, sauf à taper des commandes que l'apprenant ne
connaît pas encore.

Un panneau d'injection permet :
- à un formateur de préparer un lab avec une panne déjà en place ;
- à un apprenant d'explorer « et si… » sans savoir provoquer la panne ;
- aux tests d'utiliser exactement le même chemin que l'UI.

### 23.2 Emplacement et accès

Panneau replié, accessible depuis la barre d'outils, explicitement libellé
**« Injection de panne »**. Jamais ouvert par défaut : ce n'est pas un outil
de construction de topologie.

### 23.3 Contenu

Organisé par les mêmes familles que le catalogue :

```
┌─ Injection de panne ─────────────────────────────────┐
│ Cible : [SRV1 ▾]                                      │
│                                                       │
│ ▸ Physique                                            │
│    ○ Débrancher un câble          [eth0 ▾]  [Injecter]│
│    ○ Désactiver l'interface       [eth0 ▾]  [Injecter]│
│    ○ Perte de paquets      [30 %]  [eth0 ▾]  [Injecter]│
│    ○ Latence               [200 ms][eth0 ▾]  [Injecter]│
│    ○ Corruption de trames  [10 %] [eth0 ▾]  [Injecter]│
│                                                       │
│ ▸ Alimentation                                        │
│    ○ Extinction propre                       [Injecter]│
│    ○ Coupure brutale                         [Injecter]│
│                                                       │
│ ▸ Services                                            │
│    ○ Arrêter un service          [ssh ▾]    [Injecter]│
│    ○ Tuer le processus (SIGKILL) [sshd ▾]   [Injecter]│
│    ○ Corrompre la configuration  [ssh ▾]    [Injecter]│
│                                                       │
│ ▸ Fichiers                                            │
│    ○ Supprimer un fichier critique [… ▾]    [Injecter]│
│    ○ Permissions incorrectes       [… ▾]    [Injecter]│
│                                                       │
│ ▸ Ressources                                          │
│    ○ Remplir le disque      [95 %]          [Injecter]│
│    ○ Épuiser les inodes                     [Injecter]│
│                                                       │
│ ─────────────────────────────────────────────────────│
│ Pannes actives : 2          [Tout réparer]            │
└───────────────────────────────────────────────────────┘
```

### 23.4 Règles de conception

**R1 — L'injection passe par le modèle, jamais par un mode spécial.**
« Supprimer un fichier critique » appelle exactement la même fonction VFS
que `rm`. Il n'existe aucun chemin de code réservé à l'injection : sinon on
teste un simulateur que personne n'utilise.

**R2 — Toute injection est journalisée.**
Une entrée `notice` : « Panne injectée : suppression de
`/etc/ssh/sshd_config` sur SRV1 ». Un apprenant qui reprend un lab préparé
doit pouvoir découvrir ce qui a été fait — après avoir cherché.

**R3 — « Tout réparer » est un filet, pas un raccourci.**
Le bouton restaure toutes les pannes **injectées** (pas celles créées à la
main), et journalise chaque réparation.

**R4 — Aucune injection destructrice de topologie.**
Supprimer un équipement n'est pas une panne : c'est une modification de
topologie, qui reste dans le canvas.

**R5 — Persistance dans la topologie sauvegardée.**
Une panne injectée fait partie du lab et doit survivre à une
sauvegarde/restauration. Cela impose d'ajouter les pannes actives au
sérialiseur — et de le **déclarer** dans les avertissements de sauvegarde
existants (`TOPOLOGY_SAVE_CAVEATS`, déjà affichés dans les dialogues Save et
Export).

### 23.5 Mode « lab scénarisé » (extension future)

Un fichier de scénario décrivant une séquence de pannes déclenchées par
progression (au bout de N secondes, ou quand l'apprenant a tapé telle
commande). **Hors périmètre de ce PRD** : noté ici pour que l'architecture
du §6 n'empêche pas de l'ajouter — d'où le choix d'un registre événementiel
plutôt qu'un état ad hoc.

---

## 24. UI/UX — Accessibilité et internationalisation

### 24.1 Ne jamais coder l'information par la seule couleur

Chaque niveau porte trois signaux redondants :

| Sévérité | Couleur | Icône | Texte |
|---|---|---|---|
| `critical` | Rouge | ⛔ | « Critique » |
| `degraded` | Ambre | ⚠ | « Dégradé » |
| `notice` | Bleu | ⓘ | « Info » |

Vérification : en niveaux de gris, les trois niveaux restent distinguables
par l'icône et le texte. Un lien mort reste distinguable par son
**pointillé**, pas seulement par sa couleur — ce qui est déjà le cas dans
l'existant (`DEAD_LINK_DASH`, `connection-line-logic.ts:66`).

### 24.2 Lecteurs d'écran

- Pastille d'incident : `aria-label="2 incidents critiques sur SRV1"`.
- Centre d'incidents : `role="log"` + `aria-live="polite"` — `polite`, pas
  `assertive` : une panne n'interrompt pas la lecture en cours.
- Chaque incident : `role="article"` avec un titre de niveau approprié.
- Bouton d'alimentation : déjà correct (`NetworkDevice.tsx:286`).
- État de lien : `aria-label` explicite sur le chemin SVG.

### 24.3 Navigation au clavier

- La pastille d'incident est atteignable au `Tab`, activable à
  `Entrée`/`Espace`.
- Le centre d'incidents se parcourt aux flèches, se déplie à `Entrée`.
- `Échap` referme.
- Raccourci proposé : `Ctrl+Shift+I` pour ouvrir/fermer le centre.

### 24.4 Mouvement réduit

Sous `prefers-reduced-motion: reduce` :
- Aucune pulsation.
- Aucun tracé animé de causalité (le tracé reste, statique).
- La transition de résolution devient instantanée.

### 24.5 Langue

L'interface existante est en anglais pour les termes techniques
(`Connected`, `Admin down`) — cohérent avec les outils réels.

Règle : **les messages d'outils restent dans leur langue d'origine**
(`Connection refused` n'est jamais traduit — c'est ce que l'apprenant verra
en production). Les libellés de l'interface propre au simulateur (titres de
panneaux, boutons, catégories) suivent la langue de l'application.

Cette séparation doit être structurelle : le champ `summary` d'un incident
contient le message de l'outil réel et n'est **jamais** traduit ; les
libellés de catégorie et de sévérité le sont.

### 24.6 Densité et zoom

- Les pastilles ont une taille minimale de 14 px, cible tactile de 24 px.
- Sous un zoom de canvas inférieur à 50 %, les étiquettes de dégradation
  disparaissent mais les pastilles restent — l'information de premier
  niveau ne doit jamais devenir illisible.

---

## 25. Découpage en phases

Chaque phase est livrable indépendamment, avec ses tests, sans casser les
précédentes.

### Phase 1 — Fondation : registre d'incidents (risque faible)

- `FaultRegistry`, `FaultTypes`, `FaultProjection` (§6.1).
- Abonnement aux topics **existants** uniquement : `port.link.up/down`,
  `device.power-on/off`, `linux.service.failed`, `port.security.errdisable.*`.
- Aucun changement de comportement fonctionnel : on **agrège** ce qui est
  déjà publié.
- Tests : un incident par événement, idempotence, auto-résolution,
  chaînage causal.

**Pourquoi en premier.** Tout le reste s'y branche, et cette phase seule
rend déjà visible dans l'UI ce qui existe déjà dans le modèle — c'est le
meilleur rapport valeur/risque du plan.

### Phase 2 — UI de premier niveau (risque faible)

- Pastille d'incident sur l'équipement (§19.1).
- Barre de santé (§19.3).
- Centre d'incidents (§22.2).
- Onglet Santé du panneau de propriétés (§20.1).
- Toasts avec les règles strictes du §22.3.

Aucun changement dans `src/network/`. Tests React + e2e Playwright.

### Phase 3 — Extinction : purge de l'état volatile (risque moyen)

- Abonnés `device.power-off` pour : baux DHCP, LSDB OSPF, RIB BGP, table
  EIGRP, sockets TCP, sessions SSH entrantes (§F2.1).
- Distinction arrêt propre / coupure brutale (§F2.2).
- Chemin `reboot()` explicite avec purge de `/tmp` et remise à zéro de
  l'uptime (§F2.3).

Risque moyen : touche plusieurs sous-systèmes. Mitigé par le fait que chacun
possède déjà sa fonction de reset (utilisée par les tests) — il s'agit de
la brancher, pas de l'écrire.

### Phase 4 — Processus et services (risque moyen)

- Généraliser la corrélation service ↔ processus : sortir `knownDaemons` de
  `LinuxMachine.ts:1155` vers une propriété d'unité (§4.3).
- Résidus après `SIGKILL` : fichier PID, socket (§F5.2).
- Propagation `Requires=` / `BindsTo=` sur le modèle Windows existant
  (§F6.4).
- `TimeoutStartSec` (§F6.10).
- État `D` ininterruptible (§F5.7).

### Phase 5 — Fichiers sensibles, partie 1 : configurations (risque moyen)

- Contrat `ResourceDependency` (§6.2).
- `ConfigRead` à trois états, appliqué **d'abord à sshd** (§6.3).
- Topics `fs.file.*` publiés par le VFS.
- Validation au démarrage branchée sur les vérificateurs existants
  (`sshd -t`, `visudo -c`, `named-checkzone`).
- Scénarios F7.1, F7.2, F7.5, F7.6, F7.14, F7.17.

**Point d'attention.** La migration `?? ''` → `ConfigRead` se fait service
par service, avec les tests du service, jamais en une passe globale.

### Phase 6 — Fichiers sensibles, partie 2 : exécutables et identité (risque élevé)

- Vérification d'existence du binaire en tête de dispatch, avec le garde-fou
  « seulement si l'utilisateur l'a explicitement supprimé » (§F7.7).
- Exécutable supprimé sous un processus vivant (§F5.10).
- Effets de `/etc/passwd` / `/etc/shadow` absents, option (a) (§F7.3, F7.4).
- Sauvegardes `/etc/passwd-`, `/etc/shadow-`.

**Risque élevé** : le dispatch est le chemin le plus fréquenté du
simulateur. D'où le garde-fou, et d'où le fait que cette phase vienne
tard.

### Phase 7 — Ressources (risque moyen)

- Capacité et occupation par point de montage, ENOSPC (§F9.1).
- Compteur d'inodes, `df -i` (§F9.2).
- Montage lecture seule, EROFS (§F7.20).
- Limites `ulimit -n` / `-u` (§F9.3, F5.8).
- Montage réseau perdu combiné à l'état `D` (§F9.6).

### Phase 8 — Injection depuis l'UI (risque faible)

- Panneau du §23, câblé exclusivement sur les chemins réels (règle R1).
- Persistance des pannes injectées dans le sérialiseur + mention dans
  `TOPOLOGY_SAVE_CAVEATS`.

### Phase 9 — Réseau : compléments L2/L3 (risque moyen)

- Table MAC bornée + inondation (§F3.4).
- Détection de tempête de broadcast (§F3.10, F1.10).
- Conflit d'adressage IP (§F4.7).
- Avertissement sur route récursive non supportée (§F4.2).
- Dégradation fonctionnelle du duplex mismatch (§F1.4).
- Saturation PAT (§F4.9).

### Phase 10 — Applicatif et scénarios composés (risque faible)

- Datafile Oracle manquant via la synchronisation VFS (§F7.12).
- Cache d'identifiants AD (§F10.10).
- Isolation de zone DNS (§F10.7).
- Les douze scénarios composés du §17 comme tests d'intégration.

### Récapitulatif

| Phase | Contenu | Risque | Dépend de |
|---|---|---|---|
| 1 | Registre d'incidents | Faible | — |
| 2 | UI de premier niveau | Faible | 1 |
| 3 | Purge à l'extinction | Moyen | 1 |
| 4 | Processus et services | Moyen | 1 |
| 5 | Fichiers : configurations | Moyen | 1, 4 |
| 6 | Fichiers : exécutables, identité | **Élevé** | 5 |
| 7 | Ressources | Moyen | 5 |
| 8 | Injection UI | Faible | 2, 3, 4, 5 |
| 9 | Compléments réseau | Moyen | 1 |
| 10 | Applicatif et scénarios | Faible | toutes |

---

## 26. Stratégie de test

### 26.1 Structure

Cible (les familles non encore traitées n'ont pas de fichier) :

```
src/__tests__/unit/network-v2/faults/
├── fault-registry.test.ts              — agrégation, idempotence, causalité
├── fault-projection.test.ts            — projection vers les journaux
├── fault-physical.test.ts              — F1.*
├── fault-power.test.ts                 — F2.*
├── fault-switching.test.ts             — F3.*
├── fault-routing.test.ts               — F4.*
├── fault-service-state-is-one-answer.test.ts — F5.*/F6.* : un service a UN état
├── fault-deleted-executable.test.ts    — F5.10
├── fault-sigkill-residues.test.ts      — F5.2
├── fault-uninterruptible-sleep.test.ts — F5.7
├── fault-process-table-full.test.ts    — F5.8
├── fault-files-sshd.test.ts            — F7.1, F7.2
├── fault-files-binaries.test.ts        — F7.7, F7.8
├── fault-files-logs.test.ts            — F7.9–F7.11
├── fault-files-resolver.test.ts        — F7.12, F7.13
├── fault-files-identity.test.ts        — F7.3, F7.4, F8.*
├── fault-disk-full-and-inodes.test.ts  — F9.1, F9.2
├── fault-ssh-session-*.test.ts         — pannes sous session établie
└── scenario-fault-cascade-*.test.ts    — S1–S12
```

### 26.2 Forme canonique d'un test de panne

Quatre temps obligatoires. Un test qui saute le quatrième ne prouve rien
sur la réversibilité :

```ts
it('la suppression de la config sshd empêche le redémarrage du service', async () => {
  const { srv } = lab();

  // 1. Nominal — la fonction marche
  expect(await srv.executeCommand('systemctl is-active ssh')).toContain('active');

  // 2. Panne
  await srv.executeCommand('rm /etc/ssh/sshd_config');
  await srv.executeCommand('systemctl restart ssh');

  // 3. Constat : effet fonctionnel ET observabilité
  expect(await srv.executeCommand('systemctl is-active ssh')).toContain('failed');
  expect(await srv.executeCommand('journalctl -u ssh'))
    .toMatch(/sshd: .*sshd_config.*No such file/);
  expect(faultRegistry.forDevice(srv.getId()))
    .toContainEqual(expect.objectContaining({ code: 'CONFIG_MISSING', severity: 'critical' }));

  // 4. Réparation — retour complet au nominal
  await srv.executeCommand('cp /usr/share/openssh/sshd_config /etc/ssh/sshd_config');
  await srv.executeCommand('systemctl restart ssh');
  expect(await srv.executeCommand('systemctl is-active ssh')).toContain('active');
  expect(faultRegistry.forDevice(srv.getId())).toHaveLength(0);
});
```

### 26.3 Ce qui doit être asserté

Pour chaque scénario, au minimum :

| Assertion | Pourquoi |
|---|---|
| **Effet fonctionnel** — une commande qui dépendait de la ressource échoue | Sinon la panne est cosmétique |
| **Message exact** de l'outil réel | Principe P3 |
| **Code de sortie** correct | Les scripts en dépendent |
| **Observabilité CLI** — la commande de diagnostic montre l'état | Principe P6 |
| **Incident au registre** avec le bon code et la bonne sévérité | Alimente l'UI |
| **Réparation complète** — aucun état résiduel | Principe P4 |

### 26.4 Tests d'interface

- **Unitaires React** : rendu de la pastille selon la sévérité, groupement
  par cause, filtres, absence de toast pour `degraded`.
- **e2e Playwright** : injecter une panne depuis l'UI, vérifier la pastille,
  ouvrir le centre, copier la commande de réparation dans le terminal,
  l'exécuter, voir l'incident disparaître.
- **Accessibilité** : niveaux distinguables sans couleur, `aria-label`
  présents, parcours clavier complet.

### 26.5 Non-régression

Le risque principal du chantier est de **casser le chemin nominal** : rendre
plus stricte une lecture de fichier peut faire échouer des centaines de
tests dont les fixtures ne provisionnent pas ce fichier.

Mitigations, dans l'ordre :
1. **Le garde-fou de la phase 6** : n'échouer que si l'utilisateur a
   explicitement supprimé le chemin, jamais si le VFS ne l'a jamais eu.
2. **Migration service par service**, jamais globale.
3. **Régression complète** (`npx vitest run src/__tests__/unit/network-v2/`,
   ~25 min) avant chaque livraison de phase — méthode déjà établie.
4. **Comparaison A/B** sur un worktree du commit de base en cas de doute sur
   l'origine d'un échec.

---

## 27. Hors périmètre

Explicitement exclu, avec la raison. Ces points ne sont pas des oublis.

| Exclusion | Raison |
|---|---|
| Contention CPU réelle | Le simulateur est synchrone ; modéliser une charge CPU n'aurait aucun effet observable cohérent |
| Comptabilité mémoire réelle | Idem — seul l'OOM **déclenché explicitement** est modélisé (F5.9) |
| Pannes matérielles aléatoires (MTBF, usure) | Contredit le principe P5 de reproductibilité |
| Corruption de données au niveau octet | Aucune sérialisation binaire n'existe pour la plupart des structures |
| Simulation de la durée de réparation | Sans valeur pédagogique, coût d'attente réel |
| Résolution récursive de next-hop | Gap architectural connu et tracé séparément (item d'audit #40) ; ce PRD se limite à **avertir** au lieu d'accepter silencieusement |
| Relecture réelle de `/etc/passwd` | Chantier séparé (aucun analyseur inverse n'existe) ; l'option (a) de F7.3 produit les symptômes sans mentir sur le modèle |
| `storm-control` Cisco complet | La détection de tempête suffit dans un premier temps (F3.10) |
| Mode « lab scénarisé » | Extension future ; l'architecture du §6 la rend possible sans la livrer |
| Pannes de virtualisation / conteneurs | Aucune couche d'hyperviseur n'existe |
| Pannes d'alimentation partielles (redondance) | Aucun modèle d'alimentation multiple |

---

## 28. Annexes

### 28.1 Tableau récapitulatif du catalogue

| ID | Panne | Existant | Sévérité | Phase |
|---|---|---|---|---|
| F1.1 | Câble débranché | ✅ Complet | critical | 1 |
| F1.2 | Port admin down | ✅ | critical | 1 |
| F1.3 | Errdisable | ✅ | critical | 1 |
| F1.4 | Duplex mismatch | ⚠️ Détecté, sans effet | degraded | 9 |
| F1.5 | Speed mismatch | ⚠️ À vérifier | critical | 9 |
| F1.6 | MTU incohérent | ✅ | degraded | 1 |
| F1.7 | Perte de paquets | ✅ | degraded | 1 |
| F1.8 | Latence | ✅ (métadonnée) | degraded | 1 |
| F1.9 | Corruption de trames | ✅ | degraded | 8 |
| F1.10 | Boucle physique | ⚠️ STP oui, tempête non | critical | 9 |
| F1.11 | Type de câble | — Sans objet | — | — |
| F1.12 | Interface logique supprimée | ⚠️ | critical | 3 |
| F2.1 | Extinction propre | ⚠️ Partielle | critical | 3 |
| F2.2 | Coupure brutale | ❌ | critical | 3 |
| F2.3 | Redémarrage | ⚠️ | notice | 3 |
| F2.4 | Config de boot invalide | ❌ | degraded | 5 |
| F2.5 | Terminal pendant extinction | ✅ | critical | 1 |
| F2.6 | SSH pendant extinction | ⚠️ À confirmer | critical | 3 |
| F2.7 | Équipement de transit éteint | ✅ | critical | 1 |
| F2.8 | Suppression d'équipement | ✅ | — | 1 |
| F3.1 | VLAN absent du trunk | ✅ | degraded | 9 |
| F3.2 | Native VLAN mismatch | ⚠️ | degraded | 9 |
| F3.3 | Access/trunk mismatch | ✅ | degraded | 9 |
| F3.4 | Table MAC saturée | ❌ | critical | 9 |
| F3.5 | Perte du root bridge | ✅ | notice | 1 |
| F3.6 | Port STP bloquant | ✅ | critical | 1 |
| F3.7 | Violation port-security | ✅ | variable | 1 |
| F3.9 | Écrasement VTP | ✅ | critical | 1 |
| F3.10 | Tempête de broadcast | ❌ | critical | 9 |
| F4.1 | Route par défaut manquante | ✅ | critical | 1 |
| F4.2 | Next-hop injoignable | ⚠️ Gap connu | degraded | 9 |
| F4.3 | Adjacence OSPF perdue | ✅ | critical | 1 |
| F4.4 | Auth protocolaire | ⚠️ | critical | 9 |
| F4.5 | ACL bloquant le routage | ✅ | critical | 1 |
| F4.6 | Boucle de routage | ✅ | critical | 9 |
| F4.7 | Conflit d'adressage | ❌ | critical | 9 |
| F4.9 | PAT saturé | ⚠️ | critical | 9 |
| F4.10 | Routage asymétrique | ✅ | critical | 10 |
| F5.1 | SIGTERM | ✅ | variable | 4 |
| F5.2 | SIGKILL + résidus | ✅ | notice | 4 |
| F5.3 | Zombie | ✅ | notice | 1 |
| F5.4 | Orphelin | ✅ | notice | 1 |
| F5.5 | Crash loop | ✅ | critical | 4 |
| F5.6 | CPU à 100 % | ❌ Hors périmètre | — | — |
| F5.7 | État D | ✅ | degraded | 4 |
| F5.8 | Table de processus pleine | ✅ | critical | 7 |
| F5.9 | OOM kill | ❌ Déclaratif | critical | 7 |
| F5.10 | Binaire supprimé sous le processus | ✅ | degraded/critical | 6 |
| F6.1 | Service arrêté | ✅ | critical | 4 |
| F6.2 | Service masqué | ✅ | critical | 4 |
| F6.3 | Service désactivé | ✅ | notice | 4 |
| F6.4 | Échec de dépendance | ⚠️ | critical | 4 |
| F6.5 | Config invalide | ⚠️ Non appliquée | critical | 5 |
| F6.6 | Conflit de port | ⚠️ | critical | 4 |
| F6.7 | Utilisateur de service supprimé | ❌ | critical | 5 |
| F6.8 | Cron muet | ✅ | degraded | 4 |
| F6.9 | Service Windows en cascade | ✅ | critical | 4 |
| F6.10 | Timeout de démarrage | ❌ | critical | 4 |
| F7.1 | `sshd_config` supprimé | ❌ | critical | 5 |
| F7.2 | Clés d'hôte supprimées | ❌ | critical | 5 |
| F7.3 | `/etc/passwd` supprimé | ❌ | critical | 6 |
| F7.4 | `/etc/shadow` supprimé | ❌ | critical | 6 |
| F7.5 | `/etc/sudoers` supprimé | ⚠️ | critical | 5 |
| F7.6 | `sudoers` corrompu | ✅ | critical | 1 |
| F7.7 | Exécutable supprimé | ❌ | critical | 6 |
| F7.9 | `resolv.conf` supprimé | ⚠️ | degraded | 5 |
| F7.10 | `/etc/hosts` supprimé | ⚠️ | degraded | 5 |
| F7.11 | Log supprimé en cours d'écriture | ❌ | degraded | 5 |
| F7.12 | Datafile Oracle supprimé | ❌ | critical | 10 |
| F7.13 | `/etc/fstab` supprimé | ⚠️ | notice/critical | 7 |
| F7.14 | Unité systemd supprimée | ❌ | critical | 5 |
| F7.15 | Permissions `authorized_keys` | ✅ | degraded | 1 |
| F7.16 | Permissions `/etc/shadow` | ✅ | degraded (sécurité) | 5 |
| F7.17 | Config vide vs absente | ❌ | notice/critical | 5 |
| F7.18 | Fichier remplacé par répertoire | ⚠️ | critical | 5 |
| F7.19 | Lien symbolique cassé | ⚠️ | variable | 5 |
| F7.20 | Montage en lecture seule | ❌ | critical | 7 |
| F8.1 | Compte verrouillé | ✅ | degraded | 1 |
| F8.2 | Compte expiré | ✅ | critical | 1 |
| F8.3 | Mot de passe expiré | ✅ | degraded | 1 |
| F8.4 | Retrait de groupe | ✅ | degraded | 1 |
| F8.5 | Home supprimé | ❌ | degraded | 6 |
| F8.6 | Shell invalide | ⚠️ | critical | 6 |
| F8.7 | Propriétaire orphelin | ❌ | notice | 6 |
| F8.8 | Permissions de répertoire de service | ⚠️ | critical | 5 |
| F8.9 | Suppression de root | ⚠️ | — | 6 |
| F9.1 | Disque plein | ✅ | critical | 7 |
| F9.2 | Inodes épuisés | ✅ | critical | 7 |
| F9.3 | FD épuisés | ❌ | critical | 7 |
| F9.4 | Ports éphémères épuisés | ⚠️ | critical | 7 |
| F9.6 | Montage réseau perdu | ❌ | critical | 7 |
| F9.7 | ARP saturé / empoisonné | ✅ | degraded | 9 |
| F9.8 | Pool DHCP épuisé | ⚠️ | critical | 9 |
| F10.1 | Listener Oracle arrêté | ✅ | critical | 10 |
| F10.2 | Instance Oracle arrêtée | ✅ | critical | 10 |
| F10.3 | Base en MOUNT | ✅ | degraded | 10 |
| F10.4 | Tablespace offline | ⚠️ | degraded | 10 |
| F10.5 | Éviction RAC | ✅ | critical | 10 |
| F10.6 | DNS arrêté | ✅ | critical | 10 |
| F10.7 | Zone DNS corrompue | ⚠️ | degraded | 10 |
| F10.8 | DHCP arrêté | ✅ | degraded | 10 |
| F10.9 | Certificat expiré | ⚠️ | critical | 10 |
| F10.10 | DC injoignable | ⚠️ | critical | 10 |
| F10.11 | Réplication AD en échec | ✅ | degraded | 10 |
| F10.12 | Service web / port fermé | ✅ | critical | 10 |

**Répartition.** Sur 96 entrées : 38 ✅ déjà réelles, 27 ⚠️ partielles,
29 ❌ absentes, 2 hors périmètre.

### 28.2 Codes d'incident

```ts
type FaultCode =
  // Physique
  | 'LINK_DOWN' | 'LINK_ADMIN_DOWN' | 'LINK_ERRDISABLE'
  | 'LINK_DEGRADED_LOSS' | 'LINK_DEGRADED_DELAY' | 'LINK_DEGRADED_CORRUPTION'
  | 'DUPLEX_MISMATCH' | 'SPEED_MISMATCH' | 'MTU_MISMATCH' | 'BROADCAST_STORM'
  // Alimentation
  | 'DEVICE_POWERED_OFF' | 'DEVICE_CRASHED' | 'BOOT_CONFIG_INVALID'
  // L2
  | 'VLAN_NOT_ALLOWED' | 'NATIVE_VLAN_MISMATCH' | 'MODE_MISMATCH'
  | 'MAC_TABLE_FULL' | 'STP_ROOT_CHANGED' | 'PORT_SECURITY_VIOLATION'
  | 'VTP_DATABASE_OVERWRITTEN'
  // L3
  | 'NO_DEFAULT_ROUTE' | 'NEXTHOP_UNREACHABLE' | 'NEIGHBOR_LOST'
  | 'AUTH_MISMATCH' | 'ROUTING_LOOP' | 'IP_CONFLICT' | 'NAT_POOL_EXHAUSTED'
  // Processus
  | 'PROCESS_KILLED' | 'PROCESS_CRASH_LOOP' | 'PROCESS_UNINTERRUPTIBLE'
  | 'PROCESS_TABLE_FULL' | 'PROCESS_OOM_KILLED' | 'EXECUTABLE_DELETED'
  // Services
  | 'SERVICE_STOPPED' | 'SERVICE_FAILED' | 'SERVICE_MASKED'
  | 'SERVICE_DEPENDENCY_FAILED' | 'SERVICE_CONFIG_INVALID'
  | 'SERVICE_PORT_CONFLICT' | 'SERVICE_START_TIMEOUT' | 'SERVICE_USER_MISSING'
  // Fichiers
  | 'CONFIG_MISSING' | 'CONFIG_CORRUPT' | 'KEY_MISSING'
  | 'EXECUTABLE_MISSING' | 'IDENTITY_FILE_MISSING' | 'LOG_FILE_DELETED'
  | 'PERMISSIONS_INSECURE' | 'PERMISSIONS_TOO_STRICT'
  | 'FILESYSTEM_READONLY' | 'SYMLINK_BROKEN' | 'DATAFILE_MISSING'
  // Identité
  | 'ACCOUNT_LOCKED' | 'ACCOUNT_EXPIRED' | 'PASSWORD_EXPIRED'
  | 'HOME_MISSING' | 'SHELL_INVALID'
  // Ressources
  | 'DISK_FULL' | 'INODES_EXHAUSTED' | 'FD_EXHAUSTED'
  | 'EPHEMERAL_PORTS_EXHAUSTED' | 'MOUNT_LOST' | 'DHCP_POOL_EXHAUSTED'
  // Applicatif
  | 'LISTENER_DOWN' | 'INSTANCE_DOWN' | 'TABLESPACE_OFFLINE'
  | 'RAC_NODE_EVICTED' | 'DNS_ZONE_INVALID' | 'CERT_EXPIRED'
  | 'DC_UNREACHABLE' | 'REPLICATION_FAILED';
```

### 28.3 Correspondance sévérité → présentation

| Sévérité | `Logger` | Couleur | Icône | Toast | Pastille | Halo |
|---|---|---|---|---|---|---|
| `critical` | `error` | `#ef4444` | ⛔ | Oui (si centre fermé) | Oui | Oui |
| `degraded` | `warn` | `#f59e0b` | ⚠ | Non | Oui | Non |
| `notice` | `info` | `#3b82f6` | ⓘ | Non | Non | Non |

### 28.4 Documents liés

| Document | Lien avec ce PRD |
|---|---|
| `docs/PRD-Link-State.md` | Fondation L1. Traite F1.1 de bout en bout. **À ne pas refaire.** |
| `docs/PRD-Systemd.md` | Modèle de service, superviseur, politiques `Restart=` |
| `docs/PRD-STP.md` | F3.5, F3.6 |
| `docs/PRD-VTP.md` | F3.9 |
| `docs/PRD-Iptables-UFW.md` | F10.12, distinction DROP/REJECT |
| `docs/PRD-DNS.md` | F10.6, F10.7 |
| `docs/PRD-Oracle-DBMS.md` | F10.1–F10.5 |
| `docs/audit/` | Gaps déjà tracés, notamment RIB/FIB (#40) |
| `CLAUDE.md` | Limites assumées à ne pas contredire |

### 28.5 Glossaire des messages d'erreur réels

Référence pour l'implémentation. Chaque message doit être reproduit
**exactement**, y compris la ponctuation.

| Situation | Message |
|---|---|
| Commande absente | `bash: <cmd>: command not found` (code 127) |
| Fichier absent | `<outil>: <chemin>: No such file or directory` |
| Permission refusée | `<outil>: <chemin>: Permission denied` |
| Est un répertoire | `<outil>: <chemin>: Is a directory` |
| Disque plein | `<outil>: write error: No space left on device` |
| Lecture seule | `<outil>: cannot create <chemin>: Read-only file system` |
| Trop de fichiers ouverts | `<outil>: <chemin>: Too many open files` |
| sshd sans clé | `sshd: no hostkeys available -- exiting.` |
| sshd config invalide | `/etc/ssh/sshd_config line N: Bad configuration option: X` |
| sudoers absent | `sudo: /etc/sudoers is required` |
| sudoers invalide | `sudo: parse error in /etc/sudoers near line N` |
| Non sudoer | `<user> is not in the sudoers file.  This incident will be reported.` |
| Service masqué | `Failed to start x.service: Unit x.service is masked.` |
| Dépendance en échec | `Job for x.service failed because a dependency failed.` |
| Limite de démarrage | `start request repeated too quickly` |
| Port occupé | `bind: Address already in use` |
| Connexion refusée | `Connection refused` |
| Route absente | `Network is unreachable` |
| Hôte injoignable | `Destination Host Unreachable` |
| SSH lien mort | `client_loop: send disconnect: Broken pipe` |
| SSH clé changée | `@@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@@` |
| SSH StrictModes | `Authentication refused: bad ownership or modes for file <chemin>` |
| Compte expiré | `Your account has expired; please contact your system administrator` |
| Compte désactivé | `This account is currently not available.` |
| Home absent | `Could not chdir to home directory <chemin>: No such file or directory` |
| Oracle absent | `ORA-01034: ORACLE not available` |
| Pas de listener | `ORA-12541: TNS:no listener` |
| Service inconnu | `ORA-12514: TNS:listener does not currently know of service requested in connect descriptor` |
| Datafile absent | `ORA-01110: data file N: '<chemin>'` |
| Base non ouverte | `ORA-01219: database not open` |
| Cisco errdisable | `%PM-4-ERR_DISABLE: <cause> error detected on <port>, putting <port> in err-disable state` |
| Cisco native VLAN | `%CDP-4-NATIVE_VLAN_MISMATCH: Native VLAN mismatch discovered on <port>` |
| Cisco duplex | `%CDP-4-DUPLEX_MISMATCH: duplex mismatch discovered on <port>` |
| Cisco reload | `System returned to ROM by power-on` |

### 28.6 Vérification finale

Le chantier est terminé quand toutes ces affirmations sont vraies :

1. Chaque entrée du catalogue est ✅ ou explicitement documentée en
   « hors périmètre » avec sa raison.
2. Chaque panne modélisée a un test des quatre temps (§26.2).
3. Le canvas rend visible toute panne `critical` sans ouvrir de panneau.
4. Le centre d'incidents groupe par cause, jamais une ligne par conséquence.
5. Aucun message inventé : chaque texte figure au §28.5 ou dans une source
   citée.
6. Toute panne injectable depuis l'UI passe par le chemin réel du modèle.
7. Toute panne réparée ne laisse aucun état résiduel.
8. La régression complète est verte.
9. Les niveaux de sévérité restent distinguables sans couleur.
10. Aucun `Math.random()` n'a été ajouté dans un chemin de panne.
