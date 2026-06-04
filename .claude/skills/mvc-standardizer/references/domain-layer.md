# Standardiser la couche métier — les équipements

> **C'est la couche prioritaire.** Le cœur du produit n'est pas « OSPF » : c'est un simulateur
> d'infrastructure composé d'**équipements** (PC, switch, routeur, câble, firewall, base de
> données, OS). OSPF n'est que la *référence de pattern* la plus mature. Ce document applique
> le même moule MVC à la couche métier elle-même.
>
> Deux implémentations de référence pour le domaine — à lire avant de toucher un équipement :
> - **`src/network/devices/host/observables.ts`** — read-model d'un hôte (ARP, routes, TCP, stats).
> - **`src/database/oracle/observables.ts`** — read-model d'une base de données.

---

## 1. La taxonomie des équipements (le Model métier)

Tous les équipements héritent de l'Actor de base `Equipment` (`src/network/equipment/Equipment.ts`).
La hiérarchie réelle :

```
Equipment (abstract, Actor de base)
├── EndHost (abstract)
│   ├── LinuxMachine (abstract) ── LinuxPC · LinuxServer
│   └── WindowsPC
├── Router (abstract) ──────────── CiscoRouter · HuaweiRouter
├── Switch (abstract) ──────────── CiscoSwitch · HuaweiSwitch · GenericSwitch
└── Hub
```

`DeviceType` (`src/network/core/types.ts`) déclare aussi des types **pas encore implémentés** :
`firewall-cisco|fortinet|paloalto`, `access-point`, `cloud`. Les ajouter = créer une classe
d'équipement **au standard** (voir §5).

`Equipment` est **déjà un Actor** : il détient l'état (`id`, `name`, `hostname`, `position`,
`isPoweredOn`, `ports`, `bootedAtMs`) et **publie** déjà `device.renamed`,
`device.position-changed`, `device.power-on`, `device.power-off` via un bus injectable
(`getBus()`). Ce qui lui manque, c'est **son read-model** (voir §3).

---

## 2. Ce que chaque famille doit projeter (Model → VM)

Pour standardiser un équipement, on identifie l'**état que l'UI doit voir** et on le projette en
VM via un `observables.ts` co-localisé. Carte cible :

| Famille (Model) | État de domaine | VM à projeter (read-model) | Topics publiés | Vue consommatrice |
|---|---|---|---|---|
| **Equipment (base)** | identité, power, uptime, ports | `DeviceDetailVM` + `PortVM[]` (nom, type, up/down, IP, MAC, débit) | `device.*` (déjà), `port.link.*` | `NetworkDevice`, `PropertiesPanel` |
| **Port / Cable** (`hardware/`) | état du lien, débit/duplex, IP/MAC, câble connecté | `PortVM`, `LinkVM` (endpoints, isActive, négociation) | `port.link.up/down`, `cable.connected/…` | `ConnectionLine`, `InterfaceSelectorPopover` |
| **EndHost / PC / Server** ✅ | ARP, NDP, routes, TCP, stats ICMP | `HostArpEntryVM`, `HostRouteVM`, `HostTcpConnectionVM`, `HostStatsVM` *(déjà fait)* | `host.arp.*`, `host.routing.*`, `host.icmp.*` | panneaux d'inspection device |
| **Switch** | table MAC, VLANs, états de port (STP), port-security | `MacEntryVM`, `VlanVM`, `SpanningTreePortVM` | `switch.mac.learned/aged`, `switch.stp.state-changed` | panneau switch |
| **Router** | routing table, NAT ✅, ACL/firewall, interfaces | `RouteVM`, `NatTranslationVM` *(déjà)*, `AclRuleVM` | `router.route.*`, `nat.*`, `acl.*` | panneau router |
| **Firewall** (à créer) | zones, règles, sessions, compteurs hit | `FirewallRuleVM`, `FirewallSessionVM`, `FirewallStatsVM` | `firewall.rule.matched`, `firewall.session.*` | panneau firewall |
| **OS** (`devices/linux`, `windows`, `os`) | services, process, users, filesystem | `ServiceVM`, `ProcessVM`, `UserSessionVM` | `os.service.*`, `os.process.*` | panneau OS / terminal |
| **Database (Oracle)** ✅ | instance, sessions, tablespaces, datafiles | read-model Oracle *(déjà fait)* | `oracle.*` | panneau DB / SQL\*Plus |

> Le `✅` = déjà standardisé (à imiter). Le reste = backlog (voir §4).

---

## 3. La dette n°1 : l'équipement de base n'a pas de read-model

`store/networkStore.ts` expose encore `NetworkDeviceUI.instance: Equipment` et `deviceToUI()`
lit l'instance mutable par getters. **C'est la fuite domaine→UI la plus large du projet**
(viole O5), parce qu'elle concerne *tous* les équipements, pas un protocole.

**Fondation — FAITE ✅** (la couche réactive de base existe, vérifiée par tests) :

1. ✅ `src/network/equipment/observables.ts` : `DeviceDetailVM` (`id`, `name`, `hostname`,
   `type`, `poweredOn`, `uptimeMs`, `portCount`), `PortVM` (`name`, `type`, `isUp`, `mac`,
   `ipAddress`, `mask`, `connected`), `DeviceSignalStore`, `makeReadonlyDeviceObservables`, et
   les projections pures `projectDeviceDetail(input)` / `projectPorts(ports)`.
2. ✅ `Equipment` expose `readonly deviceObservables` (nommé ainsi pour **ne pas** entrer en
   collision avec `EndHost.observables`), alimenté par un `EquipmentSignalRefreshActor` abonné
   à `device.*` / `port.*` + des `_refreshDetailSignal()` / `_refreshPortsSignal()` qui délèguent
   aux projections (rafraîchis aussi inline dans `setName`/`powerOn`/`powerOff`/`addPort`).
3. ✅ Hooks `useDeviceDetail(id)` / `usePorts(id)` (`src/react/hooks/useEquipment.ts`, au-dessus
   de `useEngineSignal`), exportés depuis `react/hooks/index.ts`.

**Reste à faire — la migration des consommateurs (recette B, incrémentale)** :

4. Migrer `NetworkDevice`, `PropertiesPanel`, `ConnectionLine` pour consommer ces VM via les
   hooks, **rerouter l'ouverture de terminal** (qui a encore besoin de l'instance) pour résoudre
   le device par `id` côté couche terminal, puis **retirer** `instance: Equipment` de
   `NetworkDeviceUI`. C'est ce qui résoudra les `[ERROR]` de l'audit CHECK 1.

---

## 4. Backlog de standardisation du domaine (ordre conseillé)

Du plus structurant au plus localisé :

1. **Equipment base + Port/Cable** → `DeviceDetailVM`/`PortVM`/`LinkVM`. Débloque le retrait de la fuite `instance` (impact maximal). 
2. **Switch** → `MacEntryVM`/`VlanVM`/`SpanningTreePortVM` (table MAC observable = grosse valeur pédagogique).
3. **Router** → `RouteVM`/`AclRuleVM` (NAT déjà fait ; compléter routing + ACL).
4. **Firewall** (nouveau device) → suivre §5 (les types `firewall-*` existent déjà dans `DeviceType`).
5. **OS** (services/process/users) → `ServiceVM`/`ProcessVM`.

Pour chaque item : appliquer la recette **B (migration)** de `feature-recipe.md`, un incrément
réversible à la fois, tests verts à chaque pas, et l'audit qui doit **baisser**.

---

## 5. Ajouter un nouvel équipement au standard (ex. Firewall)

C'est l'objectif O6 (« un device = une classe, sans toucher les classes de base »). Recette :

1. **Model** : `src/network/devices/Firewall.ts` — `class Firewall extends Equipment`. Implémente
   `handleFrame()` (logique de filtrage), détient l'état (zones, règles, sessions), **publie**
   `firewall.*`, planifie via le `Scheduler`. Détient un `signalStore` privé + `observables`.
   Pars du template `templates/device-actor.template.ts`.
2. **Projector** : `src/network/devices/firewall/observables.ts` — `FirewallRuleVM`,
   `FirewallSessionVM`, `FirewallStatsVM`, `FirewallSignalStore`, projections pures.
   Pars de `templates/observables.template.ts`.
3. **Factory** : enregistre le type dans `DeviceFactory.createDevice()` (les `DeviceType`
   `firewall-*` existent déjà).
4. **Controller** : `src/react/hooks/useFirewall.ts` (`useFirewallRules`, `useFirewallSessions`).
5. **View** : un panneau dans `components/network/` + son icône dans la palette. Ne consomme que
   des VM.
6. **Tests** : projections pures + engine de filtrage avec `VirtualTimeScheduler`.

> Règle d'or maintenue : on ne modifie **pas** `Equipment`/`Router`/`Switch` pour ajouter un
> firewall. On hérite, on s'abonne au bus, on projette. Si tu te retrouves à éditer la classe de
> base, c'est que la frontière est franchie.

---

## 6. Pourquoi le domaine d'abord ?

- C'est la **substance** du simulateur : un étudiant inspecte une table MAC, un câble, une règle
  de firewall, une session Oracle — pas un « Signal ».
- C'est là que vit la **dette O5 la plus large** (`instance: Equipment`).
- Une fois l'équipement projeté proprement, les protocoles (qui s'y rattachent) se branchent
  naturellement, et l'UI devient entièrement pilotée par des read-models.

Quand tu hésites sur la forme d'un read-model d'équipement, relis `host/observables.ts` :
il a déjà résolu le problème pour l'hôte. Reproduis-le pour le switch, le routeur, le firewall.
