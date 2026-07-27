# PRD — Chaîne de debug Cisco IOS (`debug …` / `show debugging` / `undebug all`)

## 0. Contexte et portée

Le simulateur expose une large surface de commandes `debug` Cisco IOS. Ces
commandes sont l'outil de diagnostic n°1 d'un technicien réseau : un lab
pédagogique qui prétend enseigner le troubleshooting Cisco doit pouvoir
montrer une trace `debug` réelle, corrélée au trafic réellement échangé.

Ce PRD couvre **la chaîne de debug elle-même** — activation, inventaire,
routage des lignes vers le terminal, désactivation — et non les protocoles
qu'elle observe. Il ne demande pas d'implémenter OSPF, NAT ou IPsec : il
demande que ce qui est **déjà simulé** devienne **observable** par les
commandes que l'utilisateur tape.

La portée est délimitée par les 10 scénarios de debug transcrits en tests
unitaires (`src/__tests__/unit/network-v2/scenario-debug-0*.test.ts` et
`scenario-debug-10-show-avances.test.ts`, commit `0333e107`) : 172 tests,
dont 72 rouges préfixés `gap confirmé :`. Ce PRD est l'analyse de ces 72
rouges, plus les causes racines identifiées par lecture du code.

**Nature du problème.** Ce n'est pas un problème de moteur protocolaire.
Dans la majorité des cas, la donnée existe déjà et est correcte — elle
n'arrive simplement pas sur le canal que l'utilisateur regarde. Le cas
`debug ip nat` est emblématique : la ligne produite est
`NAT*: s=192.168.10.101->203.0.113.1, d=203.0.113.50 [10240]`, soit
exactement le format IOS attendu par le scénario, mais elle part dans le
buffer syslog préfixée `%NAT-4-WARNINGS:` au lieu du canal debug du
terminal. **C'est un problème de plomberie, pas de simulation.**

### 0.1 Chaîne de dépendances

| Couche | Composant | État |
|---|---|---|
| Activation CLI | `CommandTrie` (Cisco/Huawei) | ✅ réel, mais registrations concurrentes (§1.3-G2) |
| Registre de flags | `RouterDebugService.flags` | ✅ réel, mais 3 registres concurrents (§1.3-G1) |
| Diffusion | `DebugBroadcast` + `RouterDebugService.subscribe()` | ✅ réel |
| Sources d'événements | `EventBus` (`port.frame.*`, `ospf.*`) | ✅ réel |
| Rendu terminal | `CiscoTerminalSession` / `TerminalView` | ✅ réel |
| Inventaire | `show debugging` | ⚠️ ne lit qu'un registre sur trois |
| Désactivation | `undebug all` | ⚠️ ne vide que deux registres sur trois |

La chaîne est **complète et fonctionnelle de bout en bout** — elle est
démontrée par `debug arp`, `debug ip packet`, `debug ip ospf adj`, qui
produisent de vraies lignes issues de vraies trames. Les gaps sont des
branchements manquants **sur** cette chaîne, pas son absence.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle |
|---|---|
| `src/network/devices/router/diag/RouterDebugService.ts` | Registre canonique. 40 catégories (`:1-40`), `flags: Map` (`:52`), `enable/disable` (`:55-63`), `disableAll()` (`:73`), `subscribe()` (`:79`), `emit()` filtré par flag (`:83-86`), `attachToBus()` (`:88-169`), `label()` (`:175`), `format()` (`:219`) |
| `src/network/devices/diag/DebugBroadcast.ts` | Fan-out des lignes vers les abonnés terminal |
| `src/network/devices/router/diag/HuaweiDebugService.ts` | Équivalent VRP |
| `src/network/devices/switch/SwitchDebugService.ts` | Registre switch (`enable` `:41-43`, `enableAll` `:55`, `list` `:69`) |
| `src/network/devices/shells/CiscoShellBase.ts` | `debug arp` (`:1532-1539`), greedy `debug ip` (`:1541-1563`), `debug standby/eigrp/lldp/cdp` (`:1587-1596`) |
| `src/network/devices/shells/cisco/CiscoIPSecShowCommands.ts` | `show debugging` (`:190`) |
| `src/network/devices/shells/cisco/CiscoIPSecIKEv1Commands.ts` | `debug crypto isakmp/ipsec/ikev2` (`:716-741`), `undebug all` (`:745-754`), `no debug all` (`:756-765`) |
| `src/network/devices/shells/cisco/CiscoNATCommands.ts` | `debug ip nat` (`:506-514`) |
| `src/network/devices/shells/cisco/CiscoDhcpCommands.ts` | `debug ip dhcp server[ packet\| events]` (`:314-334`), `show debug` (`:251-252`) |
| `src/network/devices/router/NATEngine.ts` | `debugEnabled` (`:712`), `debugLog()` → `Logger.warn` (`:717-722`) |
| `src/network/ipsec/IPSecEngine.ts` | `debugIsakmp/Ipsec/Ikev2` (`:536-538`), `setDebug()` (`:1099`), `isDebugEnabled()` (`:1105`) |
| `src/network/dhcp/DHCPServer.ts` | `debug.serverPacket/serverEvents` (`:957-961`), `formatDebugShow()` (`:1151`) |
| `src/network/devices/shells/huawei/HuaweiDisplayCommands.ts` | `display debugging` agrégé (`:828-851`) |

### 1.2 Ce qui est déjà réel et solide (à ne pas casser)

- **`RouterDebugService` est une vraie machinerie**, pas une façade.
  `emit()` (`:83-86`) filtre réellement sur le flag actif, `attachToBus()`
  (`:88-169`) s'abonne à de vrais topics (`ospf.neighbor.state-changed`,
  `ospf.spf.run`, `port.frame.received`, `port.frame.tx-requested`) et
  décode de vraies trames (`decodeIp` `:121`, `decodeArp` `:132`).
- **`debug arp` fonctionne de bout en bout.** Vérifié sur les deux
  topologies (câble direct et via `CiscoSwitch`) :
  `IP ARP: rcvd req src 192.168.10.101 …` puis `IP ARP: sent rep src
  192.168.10.254 …`, avec le nom d'interface correct.
- **`debug ip packet`, `debug ip ospf events/adj`, `debug spanning-tree
  events/bpdu`** s'activent, se listent et se désactivent correctement.
- **L'ARP gratuit est réel.** À la configuration de `ip address`, le
  routeur émet une vraie trame ARP (`etherType 0x0806`, `op=request`) que
  l'hôte apprend — comportement IOS fidèle, vérifié sur le bus. *Ce point
  a été initialement pris pour un gap : il n'en est pas un, et la
  conséquence (le premier ping n'a besoin d'aucune résolution ARP) doit
  être respectée par les labs.*
- **`show processes cpu sorted`, `show logging`, `show tech-support`,
  `show crypto isakmp policy`** produisent des sorties au format IOS
  exact, en-têtes compris.
- **Huawei fait déjà mieux que Cisco** : `display debugging`
  (`HuaweiDisplayCommands.ts:828-851`) agrège HuaweiDebugService **et**
  l'état DHCP. Le correctif Cisco a donc un précédent interne.

### 1.3 Gap analysis — limites vérifiées

| # | Gap | Preuve | Gravité |
|---|---|---|---|
| **G1** | **Trois registres de flags concurrents.** `RouterDebugService.flags` (`:52`), `NATEngine.debugEnabled` (`NATEngine.ts:712`), `IPSecEngine.debugIsakmp/Ipsec/Ikev2` (`IPSecEngine.ts:536-538`), `DHCPServer.debug` (`DHCPServer.ts:957-961`). `show debugging` (`CiscoIPSecShowCommands.ts:190`) ne lit que le premier. | `debug ip nat` puis `show debugging` → `No debug flags are enabled` | **MAJEUR** |
| **G2** | **Shadowing de trie.** Le greedy `debug ip` (`CiscoShellBase.ts:1541`) a des branches `nat` (`:1548`) et `dhcp server events` (`:1552`) qui enregistreraient correctement le flag — mais les registrations exactes de `CiscoNATCommands.ts:506` et `CiscoDhcpCommands.ts:314-334` ont priorité et court-circuitent le registre canonique. | Le code correct existe et est inatteignable | **MAJEUR** |
| **G3** | **Les lignes NAT partent sur le mauvais canal.** `NATEngine.debugLog()` (`:717-722`) émet via `Logger.warn(…, 'nat:debug', …)` au lieu de `RouterDebugService`. | `show logging` contient `%NAT-4-WARNINGS: NAT*: s=192.168.10.101->203.0.113.1, d=203.0.113.50 [10240]` ; le canal debug ne reçoit rien | **MAJEUR** (contenu déjà correct) |
| **G4** | **Les flags de debug crypto sont morts.** `IPSecEngine.setDebug()` (`:1099`) écrit trois booléens ; `isDebugEnabled()` (`:1105`) **n'a aucun appelant dans tout le projet** (grep). Aucun émetteur ne produit de ligne ISAKMP/IPsec. | 13/22 rouges du scénario 7 ; zéro ligne sur le canal debug | **MAJEUR** |
| **G5** | **`undebug all` ne vide pas le registre canonique.** `CiscoIPSecIKEv1Commands.ts:745-754` ne coupe que IPSec et NAT, puis annonce `All possible debugging has been turned off`. `RouterDebugService.disableAll()` (`:73`) n'est jamais appelé. | Après `undebug all` : `show debugging` reste peuplé **et** les lignes continuent d'être émises | **MAJEUR** |
| **G6** | **Deux commandes `show debug*` divergentes.** `show debugging` → `RouterDebugService.format()` ; `show debug` (`CiscoDhcpCommands.ts:251-252`) → **uniquement** l'état DHCP. Sur IOS réel c'est la même commande. | `debug ip dhcp server events` n'est visible que via `show debug` | MOYEN |
| **G7** | **Branche IPSec morte dans `display debugging` Huawei.** `HuaweiDisplayCommands.ts:845` lit `(ipsecEng as any).debugFlags`, propriété **inexistante** sur `IPSecEngine` (qui expose `debugIsakmp`/`debugIpsec`/`debugIkev2`). L'objet est toujours `{}`, les trois `if` sont morts. | Bug symétrique de G1 côté Huawei | MOYEN |
| **G8** | **Libellés divergents de IOS.** `RouterDebugService.label()` (`:175-217`) : `IP ARP` au lieu de `ARP packet`, `Crypto IPSec` vs `Crypto IPSEC` retourné par la CLI (`CiscoIPSecIKEv1Commands.ts:727`). | `debug arp` → `IP ARP debugging is on` ; IOS dit `ARP packet debugging is on` | MINEUR |
| **G9** | **Format d'adresse MAC non-Cisco.** `attachToBus` (`:148`) interpole `MACAddress.toString()` → `02:00:00:00:00:09`. IOS utilise le format pointé `0200.0000.0009`. Une requête ARP affiche `dst … ff:ff:ff:ff:ff:ff` là où IOS affiche `0000.0000.0000`. | Scénario 8 | MINEUR |
| **G10** | **Ligne `debug ip packet` tronquée.** `RouterDebugService.ts:153` émet littéralement `len,` — le mot-clé sans valeur — et n'inclut ni l'interface, ni le verdict (`forward`/`access denied`/`unroutable`), ni le next hop `g=`. | Scénario 1 | MOYEN |
| **G11** | **Aucun filtre ACL sur les debugs.** `DebugFlag.scope` (`:48`) existe et est stocké, mais n'est jamais consulté par `emit()` (`:83-86`). `debug ip packet <ACL>`, `debug ip nat <ACL>` sont refusés ou ignorés. | Scénarios 1 et 3 | MOYEN |
| **G12** | **Commandes absentes.** `debug interface <if>`, `debug crypto isakmp detail`, `debug ip nat detailed`, `show interfaces counters errors`, `show processes memory sorted`, `show logging count` ne sont enregistrées nulle part (grep). | Scénarios 9 et 10 | MOYEN |
| **G13** | **Messages syslog non-IOS.** L'événement de lien émet `%LINK-3-ERRORS: Interface …, changed state to up` au lieu de `%LINK-3-UPDOWN`. `%LINEPROTO-5-UPDOWN`, `%IP-4-DUPADDR`, `%CRYPTO-5-SESSION_STATUS`, `%SPANTREE-2-BLOCK_BPDUGUARD` ne sont jamais générés. | Scénarios 5, 7, 8, 9 | MOYEN |
| **G14** | **`logging buffered <taille> <niveau>` et `service timestamps debug datetime msec` sont acceptés sans effet.** `show logging` annonce toujours `4096 bytes` et `Timestamp logging: disabled` ; les lignes du buffer n'ont aucun horodatage. | Scénario 10 | MOYEN |
| **G15** | **Collecte SSH non interactive partielle.** `ssh user@rtr "show …"` retourne du contenu pour `show version`, `show logging`, `show interfaces status`, `show ip interface brief`, et un fichier **vide** pour ~20 autres (`show ip route`, `show interfaces`, `show arp`, `show processes cpu sorted`…). | Scénario 10, script de collecte | MOYEN |

**Ce que ce tableau ne dit pas être un gap** (vérifié, comportement correct) :
l'ARP gratuit à la configuration d'IP ; le fait qu'un premier ping ne
déclenche pas d'ARP ; `show crypto isakmp policy` ; `show tech-support`.

---

## 2. Objectifs

Rendre observable, par les commandes que l'utilisateur tape, ce que le
simulateur simule déjà — en unifiant la chaîne de debug plutôt qu'en
ajoutant un quatrième registre.

### 2.1 Objectifs (priorité décroissante)

**P1 — Registre unique (G1, G2, G6, G7).**
`RouterDebugService` devient l'unique source de vérité. `debug ip nat`,
`debug crypto *` et `debug ip dhcp server *` appellent `svc.enable(…)` en
plus de configurer leur moteur. `show debugging` **et** `show debug`
pointent sur `format()`. Suppression des registrations exactes qui
masquent le greedy `debug ip` (G2), ou ajout explicite de l'appel au
registre dans chacune. Correction de `HuaweiDisplayCommands.ts:845` pour
lire les vraies propriétés.
*Critère : `debug ip nat` puis `show debugging` liste NAT.*

**P2 — `undebug all` réellement global (G5).**
Le handler (`CiscoIPSecIKEv1Commands.ts:745`) appelle
`RouterDebugService.disableAll()`, `NATEngine.setDebugEnabled(false)`,
`IPSecEngine.setDebug(…, false)` et les setters DHCP. Idem `no debug all`.
*Critère : après `undebug all`, `show debugging` renvoie `No debug flags
are enabled` et plus aucune ligne n'est émise.*

**P3 — Router les lignes NAT sur le canal debug (G3).**
`NATEngine.debugLog()` émet vers `RouterDebugService` (catégorie
`ip.nat`). Le double envoi vers `Logger.warn` est conservé si l'on tient à
garder la trace dans `show logging` — mais le canal debug devient
prioritaire. **Aucun changement de format n'est nécessaire : la ligne est
déjà correcte.**
*Critère : `debug ip nat` + flux traduit → `NAT*: s=…->…` sur le canal.*

**P4 — Émetteurs de debug crypto (G4).**
Brancher `IPSecEngine` sur `RouterDebugService` et émettre les lignes des
points de décision **déjà existants** de la négociation : comparaison de
transformes (`Checking ISAKMP transform 1 against priority 10 policy`,
attributs proposés, `atts are NOT acceptable`, `no offers accepted!`), et
Phase 2 (`IPSEC(sa_request)`, `IPSEC(create_sa): sa created`, `sa_spi=`,
`sa_proto= 50`). *Note : ceci suppose que la négociation IKE ait lieu ;
si `crypto map` n'établit jamais de SA, c'est un gap de moteur IPsec
distinct de ce PRD (voir §2.2).*

**P5 — Messages syslog conformes IOS (G13, G14).**
`%LINK-3-UPDOWN` (au lieu de `%LINK-3-ERRORS`), `%LINEPROTO-5-UPDOWN`,
`%IP-4-DUPADDR`, `%CRYPTO-5-SESSION_STATUS`. Prise en compte réelle de
`logging buffered <n> <niveau>` et `service timestamps debug datetime
msec`.

**P6 — Enrichir la ligne `debug ip packet` (G10).**
Longueur réelle, interface, verdict (`forward` / `access denied` /
`unroutable`), next hop `g=`. Les trois verdicts sont déjà connus du plan
de données (`Router.forwardPacket`, `ACLEngine`, `lookupRoute`).

**P7 — Filtre ACL sur les debugs (G11).**
Consulter `DebugFlag.scope` (`:48`, déjà stocké) dans `emit()` et
l'évaluer contre l'ACL nommée.

**P8 — Commandes manquantes (G12).**
`debug interface <if>`, `debug crypto isakmp detail`, `debug ip nat
detailed`, `show interfaces counters errors`, `show processes memory
sorted`, `show logging count`.

**P9 — Format d'affichage IOS (G8, G9).**
Libellés `label()` alignés sur IOS ; MAC au format pointé dans les lignes
de debug ; `0000.0000.0000` pour une cible ARP inconnue.

### 2.2 Non-objectifs (explicitement exclus)

- **Faire monter le tunnel IPsec.** Aucune SA ne s'établit aujourd'hui
  malgré une CLI complète (`crypto isakmp policy`, `transform-set`,
  `crypto map`, `set peer`). C'est un gap du **moteur IPsec**, pas de la
  chaîne de debug : il mérite son propre PRD. P4 se limite à instrumenter
  ce qui existe.
- **Implémenter la détection de conflit d'adresse DHCP** (ping avant
  attribution) et le err-disable BPDU Guard : gaps de moteur, pas
  d'observabilité.
- **Corriger la collecte SSH non interactive (G15).** Le sous-ensemble de
  commandes qui répondent en mode `ssh host "cmd"` relève de la couche SSH
  (`CrossVendorRemoteShell` / `sshLauncher`), pas de la chaîne de debug.
  Documenté ici parce qu'un scénario le traverse ; à traiter séparément.
- **`show tech-support | redirect`** vers TFTP : nécessite un client TFTP,
  hors sujet.
- **Refonte du `Logger` en canal unique.** `Logger` (buffer syslog) et
  `DebugBroadcast` (canal terminal) sont deux choses distinctes sur IOS
  aussi (`logging buffered` vs `terminal monitor`) ; on les branche, on ne
  les fusionne pas.
- **Le tri du dossier #53** (« debug/terminal monitor ne produisent aucune
  sortie via SSH ») reste ouvert et distinct : ce PRD traite la console.

---

## 3. Architecture cible

```
     debug <cmd>  ──────┐
                        ▼
              ┌──────────────────────┐
              │ RouterDebugService   │  ← registre UNIQUE (flags + scope)
              │  flags: Map<Cat,Flag>│
              └──────────┬───────────┘
                         │ enable/disable/disableAll
   ┌─────────────────────┼──────────────────────┐
   │                     │                      │
   ▼                     ▼                      ▼
NATEngine          IPSecEngine            DHCPServer
setDebugEnabled    setDebug(...)          setDebugServer*()
   │                     │                      │
   └──────── emit(cat, line) ───────────────────┘
                         │  (filtré par flag + scope ACL)
                         ▼
                 ┌───────────────┐
                 │ DebugBroadcast│ ──► CiscoTerminalSession ──► TerminalView
                 └───────────────┘
                         ▲
                         │ attachToBus()
                 ┌───────────────┐
                 │   EventBus    │  port.frame.* / ospf.* / nat.* / ipsec.*
                 └───────────────┘

show debugging ─┐
show debug     ─┴──► RouterDebugService.format()   (une seule implémentation)
undebug all ───────► RouterDebugService.disableAll() + propagation moteurs
```

**Principe directeur.** Les moteurs (`NATEngine`, `IPSecEngine`,
`DHCPServer`) gardent leur booléen local — utile pour éviter de construire
une chaîne coûteuse quand le debug est off — mais ce booléen devient un
**miroir** du registre, jamais une source de vérité concurrente. Le point
d'entrée d'écriture est toujours `RouterDebugService`.

**Deux options pour P1**, à trancher à l'implémentation :

- **(a) Retirer les registrations exactes** de `CiscoNATCommands.ts:506` et
  `CiscoDhcpCommands.ts:314-334` et laisser le greedy `debug ip`
  (`CiscoShellBase.ts:1541`) gérer, en lui ajoutant l'appel au moteur.
  *Plus propre, plus risqué* (le greedy doit couvrir toutes les variantes).
- **(b) Ajouter l'appel `svc.enable(…)` dans chaque handler exact.**
  *Moins élégant, minimal en diff, sans régression possible sur le
  parsing.* **Recommandé pour un premier lot.**

---

## 4. Modèle de données

`DebugFlag` (`RouterDebugService.ts:45-49`) est déjà suffisant :

```ts
interface DebugFlag {
  category: DebugCategory;   // 40 catégories, :1-40
  enabledAtMs: number;
  scope?: string;            // ← déjà là, jamais lu → P7
}
```

Extension minimale pour P7 :

```ts
interface DebugFlag {
  // …
  scope?: string;                       // nom d'ACL ou d'interface
  scopeKind?: 'acl' | 'interface';      // désambiguïse le scope
}
```

Extension pour P6 (contexte de forwarding, fourni par l'appelant) :

```ts
interface PacketDebugContext {
  lengthBytes: number;
  ifaceIn?: string;
  ifaceOut?: string;
  verdict: 'forward' | 'access denied' | 'unroutable' | 'rcvd' | 'sent';
  nextHop?: string;   // rendu `g=<ip>`
}
```

Aucun nouveau registre, aucune nouvelle classe de service.

---

## 5. Plan de mise en œuvre

| Lot | Contenu | Objectifs | Risque |
|---|---|---|---|
| **1** | Registre unique + `undebug all` + `show debug`/`show debugging` unifiés + fix `HuaweiDisplayCommands.ts:845` | P1, P2 | Faible — option (b), diff local |
| **2** | Routage des lignes NAT vers le canal debug | P3 | Très faible — format déjà correct |
| **3** | Libellés IOS + MAC pointées + `0000.0000.0000` | P9 | Faible — cosmétique, mais casse les tests qui asseyent les libellés actuels |
| **4** | Ligne `debug ip packet` enrichie (len/iface/verdict/`g=`) | P6 | Moyen — touche le plan de données |
| **5** | Messages syslog IOS + `logging buffered` + `service timestamps` | P5 | Moyen — `%LINK-3-ERRORS` peut être asserté ailleurs |
| **6** | Commandes manquantes (`debug interface`, `show interfaces counters errors`, …) | P8 | Faible — additif |
| **7** | Filtre ACL (`scope`) dans `emit()` | P7 | Moyen |
| **8** | Émetteurs de debug crypto | P4 | Élevé — dépend du moteur IPsec (§2.2) |

Les lots 1 à 3 traitent **G1, G2, G3, G5, G6, G7, G8, G9** — soit la
majorité des rouges — pour un diff faible et sans toucher aux moteurs.
C'est le lot à privilégier.

---

## 6. Stratégie de test

**La suite de non-régression existe déjà** : les 10 fichiers
`scenario-debug-*.test.ts` (172 tests). Ils sont écrits pour **échouer**
sur chaque gap et passer au vert dès que le gap est comblé — aucune
assertion à écrire pour valider ce PRD, il suffit de compter les rouges.

| Lot | Rouges attendus au vert |
|---|---|
| 1 | `show debugging` × NAT/DHCP/crypto/interface ; `undebug all` ne vide pas ; lignes après `undebug all` (scénarios 1, 3, 6, 7) |
| 2 | `NAT*: s=…->…` ; « au moins une ligne lors d'un flux traduit » (scénario 3) |
| 3 | `ARP packet debugging is on` ; MAC pointées ; `0000.0000.0000` (scénario 8) |
| 4 | `len 84` + interface ; `forward` + `g=` ; `access denied` ; `unroutable` (scénario 1) |
| 5 | `%LINK-3-UPDOWN` ; `%LINEPROTO-5-UPDOWN` ; `%IP-4-DUPADDR` ; horodatage msec ; `Buffer logging: … 1000000 bytes` (scénarios 8, 9, 10) |
| 6 | `debug interface` × 3 ; `show interfaces counters errors` ; `show processes memory sorted` ; `show logging count` (scénarios 9, 10) |
| 7 | `debug ip packet <ACL>` ; `debug ip nat <acl>` (scénarios 1, 3) |
| 8 | 13 rouges du scénario 7 — **sous réserve** que le moteur IPsec établisse une SA |

**Tests à ajouter** (non couverts par la transcription) :

- Un test d'unicité du registre : `debug ip nat` + `debug arp` +
  `debug crypto isakmp` → `show debugging` liste les trois, et
  `show debug` renvoie exactement la même chose.
- Un test de propagation d'`undebug all` sur les trois moteurs
  (assertion sur `NATEngine.isDebugEnabled()` / `IPSecEngine.isDebugEnabled()`,
  qui n'ont aujourd'hui **aucun appelant** — les rendre testés les rend
  vivants).
- Un test Huawei symétrique sur `display debugging` (G7).

**Piège de test connu.** Un lab qui veut observer un cycle ARP doit vider
le cache (`ip -s -s neigh flush all`) : l'ARP gratuit émis à la
configuration d'IP est réel et rend le premier ping muet côté ARP. Ce
n'est pas un bug (voir §1.2) ; `scenario-debug-08-arp.test.ts` documente
le point dans un commentaire au-dessus de `resolutionFraiche()`.

---

## 7. Risques et points d'attention

- **Régression sur les libellés (lot 3).** `RouterDebugService.label()` est
  consommé par `format()`, donc par toute assertion existante sur
  `show debugging`. Passer `IP ARP` → `ARP packet` peut casser des tests
  hors des 10 scénarios. À vérifier par un grep avant.
- **`%LINK-3-ERRORS` (lot 5)** est probablement asserté ailleurs
  (suites `debug/` de `cisco-router-interfaces`). Le renommage en
  `%LINK-3-UPDOWN` doit être accompagné d'un passage sur ces suites.
- **Option (a) de P1** peut modifier le parsing d'abréviations
  (`deb ip nat`) : le greedy et l'exact ne se comportent pas pareil face à
  une saisie partielle. C'est la raison de recommander l'option (b).
- **Double émission NAT (lot 2).** Si l'on garde `Logger.warn` **et**
  l'émission debug, une ligne apparaîtra dans `show logging` et sur le
  terminal. C'est en fait conforme à IOS (`logging buffered` capture les
  debugs quand `logging buffered debugging` est actif) — mais il faut le
  décider explicitement, pas le subir.
- **P4 est bloqué par un gap externe.** Instrumenter une négociation qui
  n'a pas lieu ne produira rien. Ne pas planifier le lot 8 avant d'avoir
  statué sur le moteur IPsec.
- **Ne pas ajouter un quatrième registre.** Le réflexe naturel face à G4
  serait de créer un `CryptoDebugService`. C'est exactement ce qui a
  produit le problème.

---

## 8. Critères d'acceptation

1. `show debugging` et `show debug` renvoient **la même chose**, et
   listent tout debug activé quel que soit le sous-système (NAT, DHCP,
   crypto, ARP, OSPF, interface).
2. Après `undebug all` : `show debugging` → `No debug flags are enabled`,
   et **aucune ligne** n'est plus émise sur le canal debug, tous
   sous-systèmes confondus.
3. `debug ip nat` + flux traduit → au moins une ligne
   `NAT*: s=<in>-><out>, d=<dst>` sur le canal debug (et non seulement
   dans `show logging`).
4. `debug arp` → `ARP packet debugging is on`, lignes avec MAC au format
   pointé et `0000.0000.0000` pour une cible inconnue.
5. `debug ip packet` → ligne portant la longueur réelle, l'interface et un
   verdict parmi `rcvd` / `sent` / `forward` / `access denied` /
   `unroutable`.
6. Un changement d'état de lien journalise `%LINK-3-UPDOWN` puis
   `%LINEPROTO-5-UPDOWN`.
7. `logging buffered 1000000 debug` est reflété par `show logging`, et
   `service timestamps debug datetime msec` horodate le buffer.
8. Les 10 fichiers `scenario-debug-*.test.ts` passent au vert **sans
   modification d'assertion**, à l'exception documentée des tests couverts
   par les non-objectifs §2.2 (tunnel IPsec, conflit DHCP, BPDU Guard
   err-disable, collecte SSH).
9. `npm run lint` et `npx tsc --noEmit` restent propres.
