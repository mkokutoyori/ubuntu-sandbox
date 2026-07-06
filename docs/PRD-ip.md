# PRD — Limites de la commande Linux `ip` (iproute2) actuellement implémentée

**Version** : 1.0
**Date** : 2026-07-06
**Projet** : Ubuntu Sandbox — simulateur réseau navigateur
**Auteur** : Claude (agent), à la demande de l'utilisateur
**Références normatives** :
- `ip(8)`, `ip-address(8)`, `ip-link(8)`, `ip-route(8)`, `ip-neighbour(8)`,
  `ip-rule(8)`, `ip-netns(8)`, `ip-tunnel(8)`, `ip-xfrm(8)`, `ip-maddress(8)`
  (manuels iproute2 réels)
- RFC 4861/4862 (NDP/SLAAC — pour `ip -6 neigh`/`ip -6 addr`)

---

## 0. Contexte et portée du document

Ce PRD documente, sans les corriger, **toutes les limites vérifiées** de la
commande `ip` réellement implémentée dans ce dépôt
(`src/network/devices/linux/LinuxIpCommand.ts` + son adaptateur
`src/network/devices/linux/commands/net/Ip.ts`), par comparaison avec le
comportement de la vraie commande `ip(8)` (suite iproute2). Recherche menée
par lecture intégrale des deux fichiers, de l'interface `LinuxNetKernel`
sous-jacente, et de la suite de tests existante.

### 0.1 Principe directeur

Comme pour les PRD précédents de ce dépôt (`PRD-TCP.md`,
`PRD-Nslookup-Dig-Rndc-Runas.md`) : ce document sépare strictement le
**constat** (§1) de la **proposition** (§2 à §8). Toute correction future
devra rester **additive et testée** — les ~20 700 tests déjà verts ne
doivent pas régresser.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Lignes |
|---|---|---|
| `src/network/devices/linux/LinuxIpCommand.ts` | Moteur complet : parsing d'arguments, tous les gestionnaires de sous-commandes (`addr`, `link`, `route`, `neigh`, `xfrm`, `monitor`), formatage de sortie, textes d'aide | 1272 |
| `src/network/devices/linux/commands/net/Ip.ts` | Adaptateur fin : implémente `IpNetworkContext` contre `LinuxNetKernel` (`buildIpCtx`), enregistre `ip` comme `LinuxCommand` — aucune logique de parsing/formatage propre | 264 |
| `src/network/devices/linux/LinuxNetKernel.ts` | Abstraction noyau sous-jacente : table de routage, table ARP, routage IPv6, DHCP, ping/traceroute, `ip_forward`, NAT masquerade, pile TCP. **Aucune notion de `netns`, `vrf`, ou tunnel/GRE** | 166 (interface) |
| `src/network/devices/linux/LinuxIptablesManager.ts` | iptables filter/nat/mangle — sous-système séparé, non relié à `ip rule`/au routage par stratégie | 1207 |

### 1.2 Ce qui est déjà réel et solide (à ne pas casser)

- **`ip addr {show,add,del,flush}`** : réel, branché sur `LinuxNetKernel`
  (IPv4 primaire + secondaires, IPv6, flag `dynamic` DHCP, calcul de
  broadcast, scope, cas spécial `lo`).
- **`ip link {show, set up/down}`** : réel, bascule l'état admin réel d'un
  port (`net.setInterfaceAdmin`), rendu des flags (`BROADCAST,UP,MULTICAST,
  LOWER_UP`) fidèle.
- **`ip route {show,add,del,get}`** : réel, table de routage avec vrai
  plus-long-préfixe (`pickBestRoute`), routes on-link vs gateway,
  départage par métrique, `proto static/dhcp/kernel`, `scope link`. `ip
  route get` fait une vraie résolution LPM avec inférence de `src`.
- **`ip -6 route show`** : implémenté contre une table de routage IPv6
  distincte, y compris `proto ra` pour les routes RA.
- **`ip neigh {show,add,del,flush}`** : réel, branché sur la vraie table
  ARP, états NUD réels (REACHABLE/STALE/FAILED/PERMANENT), distinction
  statique/dynamique respectée par `flush`.
- **`ip monitor`** : véritablement événementiel (pas du polling) — branché
  sur un pipeline pub/sub réel alimentant une session de terminal attachée ;
  filtrage par objet (`link`/`addr`/`route`/`neigh`/`all`), étiquetage
  `[LINK]` uniquement si plusieurs objets surveillés, préfixe `Deleted`,
  détachement par Ctrl+C. Une vraie ré-implémentation réactive, pas un stub.
- **`ip xfrm state/policy`** : CRUD SPD/SAD réel (add/update/list/delete/
  deleteall/flush/count) pour `state` et `policy`.
- **Fidélité des messages d'erreur** : plusieurs messages RTNETLINK réels
  sont reproduits mot pour mot (`RTNETLINK answers: Cannot assign requested
  address`, `... No such process`, `... File exists`, `... Network is
  unreachable`, `Not enough information: "dev" argument is required.`).

### 1.3 Gap analysis — limites vérifiées

| # | Limite | Comparé à | Sévérité |
|---|---|---|---|
| 1 | **`ip link add`/`delete` (veth, vlan, dummy, bridge, tunnel…) absent.** `IP_LINK_HELP` (ligne 187) annonce toute la grammaire `TYPE := {bareudp\|bond\|...\|veth\|vlan\|vrf\|vti\|vxlan...}`, mais `ipLink()` ne gère que `show`/`set` ; tout `add`/`delete` tombe sur `Command "add" is unknown, try "ip link help".` — aucune interface virtuelle n'est jamais créée. | `ip-link(8)` | Élevée |
| 2 | **`ip tunnel` (GRE/IPIP) absent.** Pas un `object` reconnu dans `executeIpCommand` (ligne 285-317) ; renvoie `Object "tunnel" is unknown`. Le moteur GRE existe pourtant ailleurs dans le dépôt (`network/protocols/gre/` selon l'architecture du projet) mais n'est jamais exposé via `ip`. | `ip-tunnel(8)` | Élevée |
| 3 | **`ip netns` (espaces de noms réseau) absent.** Objet inconnu ; `LinuxNetKernel` n'a aucune notion d'espace de noms — chaque `LinuxPC`/`LinuxServer` est un espace de noms plat unique. | `ip-netns(8)` | Élevée |
| 4 | **`ip vrf` absent.** Objet inconnu au niveau `ip`. (Piège identifié : les occurrences de `ip vrf` dans la suite de tests appartiennent au CLI Cisco IOS simulé — un chemin de code totalement différent — à ne pas confondre lors de l'implémentation.) | `ip-vrf(8)` | Élevée |
| 5 | **`ip rule` (routage par stratégie, tables multiples) absent.** Aucune notion de `table` dans `IpRouteEntry`/`LinuxNetKernel.getRoutingTable()` — une seule table plate existe. | `ip-rule(8)` | Élevée |
| 6 | **`ip maddr` (appartenance à des groupes multicast) absent.** Pas de case `object`. | `ip-maddress(8)` | Moyenne |
| 7 | **`-j[son]`/`-p[retty]` annoncés mais ignorés.** `IP_HELP` (ligne 137) les documente, mais la boucle de parsing d'options (lignes 258-278) ne reconnaît que `-br`, `-s`, `-4`, `-6`, `-f` ; tout le reste — y compris `-j`/`-p` — est **silencieusement ignoré** (`// Ignore other options silently`, ligne 277). Un script s'appuyant sur `ip -j addr show` casse silencieusement plutôt que d'échouer proprement. | `ip(8)` §OPTIONS | Moyenne |
| 8 | **`-s`/`--statistics` parsé mais jamais rendu.** `stats` est mis à `true` (ligne 254/263) mais jamais transmis à `formatAddrInterface`/`formatLinkInterface`/`ipLinkShow` — les compteurs RX/TX réels (`ip -s link show`) ne s'affichent jamais alors que la donnée existe déjà (`IpInterfaceInfo.counters`, peuplé dans `Ip.ts:41-57` avec `framesIn/Out`, `bytesIn/Out`). Un correctif "gratuit" si scopé : la donnée est là, seul le rendu manque. | `ip-link(8)`/`ip-address(8)` | Moyenne |
| 9 | **`ip addr change`/`replace`, `ip route change`/`append`/`replace` absents.** Les dispatchers `ipAddr`/`ipRoute` ne reconnaissent que `add`/`del`/`show`/`flush`(addr)/`get`(route) — `change`/`replace`/`append` tombent sur l'erreur de sous-commande inconnue, alors que la vraie sémantique diffère réellement d'`add` (remplacement vs échec si existant). | `ip-address(8)`, `ip-route(8)` | Moyenne |
| 10 | **`ip addr showdump/restore`, `ip route save/restore/showdump` absents.** Documentés dans les textes d'aide (`IP_ADDR_HELP`, `IP_ROUTE_HELP`) mais jamais implémentés. | `ip-address(8)`, `ip-route(8)` | Faible |
| 11 | **`-b[atch] [filename]` absent.** Documenté dans `IP_HELP` mais aucun chemin d'exécution de fichier batch n'existe. | `ip(8)` §OPTIONS | Faible |
| 12 | **Index d'interface (`ifindex`) instable.** Le vrai noyau assigne un ifindex une fois pour toutes à la création et il persiste. Le simulateur le recalcule positionnellement à chaque appel (`allNames.indexOf(filterDev) + 1`), donc les index peuvent glisser silencieusement — gap de fidélité pour tout script qui se fie à l'ifindex. | Comportement noyau réel | Moyenne |
| 13 | **Options d'affichage `-0`, `-iec`, `-human-readable`, `-color`, `-oneline`, `-t[imestamp]` absentes.** Toutes listées dans la grammaire `IP_HELP` mais non implémentées ; `-o[neline]` en particulier (très utilisé en scripting) est absent. | `ip(8)` §OPTIONS | Faible |
| 14 | **`ip xfrm monitor` est un stub explicite** (`case 'monitor': return ''; // no-op in simulator`, ligne 1066-1067) — contraste avec le vrai `ip monitor` (objets link/addr/route/neigh) qui, lui, est réellement événementiel : l'équipe sait construire ce mécanisme mais ne l'a pas étendu à xfrm. | `ip-xfrm(8)` | Faible |
| 15 | **Couverture IPv6 partielle.** `-6`/`inet6` ne spécialise que `route` (`ipRoute6`) et le filtre `family` dans `ipAddr`/`formatAddrInterface` ; `ipNeigh` n'a aucune branche de famille — pas d'`ip -6 neigh` (cache NDP) distinct du cache ARP IPv4. | RFC 4861 (NDP) | Moyenne |
| 16 | **Modificateurs `ip addr add` incomplets.** `IP_ADDR_HELP` documente toute la grammaire `IFADDR` (`peer`, `broadcast`, `anycast`, `label`, `scope`, durées de vie, `CONFFLAG-LIST` comme `nodad`/`home`), mais `ipAddrAdd` ne parse qu'un `<ip>/<cidr> dev <name>` nu — tout modificateur tombe dans `Error: garbage instead of arguments`. | `ip-address(8)` | Moyenne |
| 17 | **Détails de sortie manquants.** Pas d'`altname`, pas de `promiscuity`, pas de `numtxqueues`/`numrxqueues`, pas de décompte réel `valid_lft`/`preferred_lft` pour IPv4 (IPv6 affiche toujours "forever" en dur, ligne 421) alors qu'un vrai bail DHCP a une durée de vie réelle. | `ip-address(8)` | Faible/Moyenne |

### 1.4 Couverture de test actuelle

- `linux-ip-command.test.ts` (749 lignes) : couvre `addr {show,add,del,flush}`
  et alias, `-br`, `-s` (parsé, pas vérifié dans le rendu), `link {show,set
  up/down}`, `route {show,add,del,get}`, `neigh {show,flush}`, aides `-h`,
  erreurs objet/sous-commande inconnus.
- `linux-ip-monitor-stream-ui.test.ts` (139 lignes) : `ip monitor` en direct
  via la session de terminal.
- **Jamais testés** : `ip -6`/rendu adresse-route IPv6 dédié, `ip xfrm`,
  `ip addr change/replace`, `ip link add/delete`, `-j`/`-p` JSON, `ip rule`,
  `ip netns`, `ip tunnel`, `ip vrf`, `ip maddr`, mode batch.
- **Piège identifié** : les tests contenant `ip vrf`/`ip address .../ip
  route ...` dans `scenario-15-multi-tenant-vrf-isolation.test.ts` et
  `other-commands.test.ts`/`no-ip-address.test.ts` sont respectivement du
  VRF-Lite Cisco IOS et de la syntaxe Cisco (`ip address 10.0.0.1
  255.255.255.0`) — **pas** de la commande Linux `ip`. Un futur
  contributeur ne doit pas les confondre avec une couverture réelle de
  `ip vrf`/`ip netns`.

---

## 2. Objectifs

### 2.1 Objectifs de ce PRD (remédiation proposée, non encore engagée)

1. **`ip link add`/`delete` pour les types d'interface virtuelle les plus
   utiles pédagogiquement** : `veth` (paire pour la mise en réseau de
   conteneurs), `vlan` (sous-interfaces 802.1Q, déjà pertinent puisque VLAN
   existe ailleurs dans le simulateur), `dummy`, `bridge` (si un pont Linux
   logiciel n'existe pas déjà par un autre biais). Pas les 25 types
   annoncés dans `IP_LINK_HELP` — un sous-ensemble réellement exploitable.
2. **`ip tunnel`/GRE minimal**, exposant le moteur GRE déjà existant du
   projet (`protocols/gre/`) via l'objet `ip` — pas de réimplémentation du
   protocole, juste le raccordement command-surface.
3. **`ip rule` + tables de routage multiples**, la lacune la plus
   structurante : `LinuxNetKernel` gagne une notion de table de routage
   nommée/numérotée, `ip route` gagne `table <ID>`, `ip rule` gagne
   add/del/show avec sélection par `from`/`to`/`fwmark`/`priority`.
4. **`ip netns`**, isolant un espace de noms réseau logique par PC/serveur
   (au minimum : table de routage + table ARP + interfaces propres par
   namespace, bascule `ip netns exec <ns> <cmd>`).
5. **`-j[son]`/`-p[retty]` réels** sur `addr show`/`link show`/`route show`/
   `neigh show` — la plus grande victoire "rapport effort/valeur" du PRD
   puisque toutes les données existent déjà, seul le sérialiseur JSON
   manque.
6. **Rendu des compteurs `-s`/`--statistics`** sur `ip link show`/`ip addr
   show` — la donnée existe déjà (`IpInterfaceInfo.counters`), il ne manque
   que le branchement dans les formatteurs.
7. **`ip addr change`/`replace` et `ip route change`/`append`/`replace`**
   avec la vraie sémantique de remplacement (pas un simple alias d'`add`).
8. **Ifindex stable**, assigné une fois à la création de l'interface et
   jamais recalculé positionnellement.
9. **`-o[neline]`**, l'option d'affichage la plus utilisée en scripting
   parmi celles manquantes.

### 2.2 Non-objectifs (explicitement hors périmètre)

- **`ip vrf`** — recouvre en pratique les mêmes besoins que `ip netns` +
  `ip rule` (VRF Linux moderne est implémenté par-dessus `netns`/tables de
  routage) ; à revisiter seulement après P3/P4 (§5) s'il reste un besoin
  distinct.
- **`ip maddr`** — aucun protocole multicast applicatif simulé n'en dépend
  aujourd'hui (IGMP existe comme protocole séparé, pas branché sur `ip`).
- **Mode batch (`-b`)**, **`showdump`/`restore`/`save`** — utilité
  pédagogique faible, aucun scénario de lab ne script `ip` par fichier
  batch aujourd'hui.
- **Modificateurs complets de `ip addr add`** (`peer`, `anycast`,
  `CONFFLAG-LIST` complet) — seuls `label`/`scope`/`valid_lft`/
  `preferred_lft` seront ajoutés si un besoin de lab concret apparaît ;
  le reste (`nodad`, `home`, `mngtmpaddr`...) est un raffinement IPv6
  avancé hors périmètre.
- **Options d'affichage cosmétiques** (`-color`, `-iec`, `-human-readable`,
  `-0`, `-t[imestamp]`) — aucune valeur pédagogique, juste de la mise en
  forme.
- **`ip xfrm monitor`** — IPsec event streaming n'est demandé par aucun
  scénario de lab existant ; `ip xfrm state/policy` (déjà réel) suffit.

---

## 3. Architecture cible

### 3.1 Principe directeur

Confirmé par la recherche (§1.5) : `ip` est déjà une pure couche de
présentation au-dessus de `LinuxNetKernel` — `LinuxIpCommand.ts` ne fait
aucune mutation d'état directement, tout passe par l'interface injectée.
Les gaps #1/#2/#6 (link add/delete, tunnel, maddr) et #5 (JSON/stats/
change-replace/oneline) sont de la **pure surface de commande** — zéro
travail côté noyau nécessaire au-delà de brancher sur des capacités
existantes (GRE) ou des données déjà présentes (compteurs). Seuls **`ip
rule` (tables multiples) et `ip netns` (isolation)** exigent une extension
réelle de `LinuxNetKernel` : c'est la seule partie de ce PRD qui touche le
modèle sous-jacent plutôt que la seule commande.

### 3.2 Modules proposés (arborescence)

```
src/network/devices/linux/
  LinuxIpCommand.ts        (existant — gagne link add/delete, tunnel, rule,
                             netns dispatch, JSON/stats/oneline formatters,
                             change/replace)
  LinuxNetKernel.ts         (existant — interface étendue : tables de routage
                             nommées, notion de namespace)
  netns/
    LinuxNetNamespace.ts     (nouveau — table de routage + ARP + interfaces
                              isolées par espace de noms)
  commands/net/
    Ip.ts                    (existant — buildIpCtx étendu pour exposer les
                              nouvelles capacités du kernel sans changer sa
                              nature de pur adaptateur)
    IpJsonFormat.ts           (nouveau — sérialiseur JSON partagé par
                              addr/link/route/neigh show, miroir de
                              `formatAddrInterface`/`formatLinkInterface`
                              texte existants)
```

### 3.3 Design patterns retenus

- **Strategy** pour le formatage de sortie (texte vs JSON) — un même
  modèle de données interne (`IpInterfaceInfo`, `IpRouteEntry`) alimente
  soit le formateur texte existant, soit le nouveau `IpJsonFormat.ts`,
  sans dupliquer la logique de collecte de données.
- **Value Object** pour `LinuxNetNamespace` — un espace de noms est un
  conteneur immuable-par-référence des mêmes structures que
  `LinuxNetKernel` utilise aujourd'hui au niveau device.

---

## 4. Modèle de données

### 4.1 Table de routage nommée (pour `ip rule`/`table`)

```ts
interface NamedRoutingTable {
  id: number;           // 254 = main, 255 = local, 253 = default (conventions réelles)
  name: string;
  routes: IpRouteEntry[];
}

interface IpRoutingPolicyRule {
  priority: number;
  from?: string;   // CIDR
  to?: string;     // CIDR
  fwmark?: number;
  table: number;
}
```

### 4.2 Espace de noms réseau (pour `ip netns`)

```ts
interface LinuxNetNamespace {
  name: string;
  interfaces: Map<string, IpInterfaceInfo>;
  routingTables: NamedRoutingTable[];
  arpTable: ArpEntry[];
}
```

### 4.3 Sortie JSON (pour `-j`/`-p`)

Réutilise tel quel le modèle interne déjà collecté par les formateurs
texte existants (`IpInterfaceInfo`, `IpRouteEntry`, entrées ARP/NDP) —
`IpJsonFormat.ts` n'introduit aucun nouveau champ, seulement une sérialisation
alternative fidèle au schéma JSON réel de `ip -j`.

---

## 5. Plan de mise en œuvre (TDD, par phases)

| Phase | Contenu | Dépend de |
|---|---|---|
| **P1 — Sortie JSON (`-j`/`-p`) + compteurs `-s`** | `IpJsonFormat.ts` pour `addr/link/route/neigh show` ; branchement des compteurs déjà collectés dans les formateurs texte existants | Existant |
| **P2 — `change`/`replace`/`append` + `-o[neline]`** | Vraie sémantique de remplacement sur `ip addr`/`ip route` ; option d'affichage une-ligne-par-entrée | Existant |
| **P3 — Ifindex stable** | Assignation d'ifindex à la création d'interface, jamais recalculée positionnellement (checkpoint de régression complète) | Existant |
| **P4 — `ip tunnel`/GRE** | Raccordement de l'objet `ip tunnel` au moteur GRE déjà existant (`protocols/gre/`) | Existant |
| **P5 — `ip link add/delete` (veth, vlan, dummy)** | Un sous-ensemble réellement exploitable de types d'interface virtuelle | P4 (partage l'infra de "nouvelle interface virtuelle") |
| **P6 — Tables de routage multiples + `ip rule`** | `NamedRoutingTable`/`IpRoutingPolicyRule` dans `LinuxNetKernel` ; `ip route ... table <ID>` ; `ip rule {add,del,show}` | P3 |
| **P7 — `ip netns`** | `LinuxNetNamespace.ts` ; `ip netns {add,del,list,exec}` (checkpoint de régression complète, fin du PRD) | P6 (réutilise la notion de table nommée par namespace) |

Chaque phase suit le cycle rouge → vert → refactor, régression localisée à
chaque phase, régression complète (`npx vitest run`) après P3 et après P7.

---

## 6. Stratégie de test

1. **JSON** : `ip -j addr show`/`ip -j route show`/`ip -j link show`/`ip -j
   neigh show` produisent un JSON valide et structurellement fidèle au vrai
   `ip -j` (mêmes clés : `ifname`, `addr_info`, `dst`, `gateway`, `dev`...).
2. **Compteurs** : `ip -s link show eth0` affiche les mêmes RX/TX
   packets/bytes que ceux déjà exposés par ailleurs (`ifconfig`/`ip -s`
   cohérents entre eux).
3. **`change`/`replace`** : `ip addr replace` sur une adresse déjà présente
   ne produit pas d'erreur "File exists" (contrairement à `add`) ;
   `ip route replace` remplace bien la route existante plutôt que d'en
   ajouter une deuxième.
4. **Ifindex** : ajouter/supprimer une interface ne change pas l'ifindex
   des interfaces existantes.
5. **`ip tunnel`** : un tunnel GRE créé via `ip tunnel add` transporte
   réellement du trafic entre deux hôtes simulés (round-trip ping à
   travers le tunnel).
6. **`ip link add veth`** : crée une paire d'interfaces reliées l'une à
   l'autre, visibles via `ip link show`.
7. **`ip rule`/tables multiples** : deux règles de priorité différente
   dirigent le même trafic vers deux tables de routage distinctes ; `ip
   route show table <ID>` isole bien chaque table.
8. **`ip netns`** : deux namespaces sur le même device ont des tables de
   routage/ARP totalement indépendantes ; `ip netns exec ns1 ping ...`
   utilise la table de `ns1`, pas celle du namespace par défaut.
9. **Non-régression** : `linux-ip-command.test.ts`,
   `linux-ip-monitor-stream-ui.test.ts`, et toutes les suites ARP/routage
   (`linux-arp-*.test.ts`, `linux-route-command.test.ts`) restent vertes
   après chaque phase.

---

## 7. Risques et points d'attention

1. **Confusion `ip vrf` (Linux) vs VRF-Lite Cisco IOS** — les deux
   partagent le mot "vrf" mais sont des command-surfaces totalement
   différentes dans deux parties distinctes du dépôt ; à documenter
   explicitement dans le code si `ip vrf` est un jour ajouté, pour éviter
   qu'un futur contributeur ne les confonde ou ne tente de les unifier à
   tort.
2. **Espaces de noms (P7) et le reste du simulateur** — `LinuxNetKernel`
   est aujourd'hui un singleton logique par device ; introduire des
   namespaces multiples à l'intérieur d'un même device impacte
   potentiellement tout code qui suppose "une table de routage par PC" —
   auditer les call-sites de `getRoutingTable()`/`getArpTable()` avant P7.
3. **GRE déjà existant (P4)** — vérifier en préambule de P4 que le moteur
   `protocols/gre/` expose une API suffisante pour être piloté depuis `ip
   tunnel` sans réécriture ; sinon, réduire le périmètre de P4 à un
   raccordement partiel documenté.
4. **Fidélité JSON (P1)** — comme pour les précédents PRD, viser une
   fidélité "schéma JSON réel mais pas garanti bit-exact avec la sortie
   d'un noyau Linux précis" (les champs varient légèrement entre versions
   iproute2).

---

## 8. Critères d'acceptation

1. `ip -j`/`ip -p` produisent un JSON valide et structurellement fidèle
   pour `addr`/`link`/`route`/`neigh show`.
2. `ip -s link show`/`ip -s addr show` affichent les compteurs RX/TX réels.
3. `ip addr replace`/`ip route replace` ont la vraie sémantique de
   remplacement, distincte d'`add`.
4. L'ifindex d'une interface ne change jamais après sa création.
5. `ip tunnel add` crée un tunnel GRE fonctionnel (trafic réel).
6. `ip link add veth`/`vlan`/`dummy` créent de vraies interfaces virtuelles
   visibles et utilisables.
7. `ip rule` + tables de routage multiples dirigent réellement le trafic
   selon la règle qui matche.
8. `ip netns` isole réellement le routage/ARP par espace de noms.
9. Les ~20 700 tests existants restent verts après chaque phase (régression
   complète après P3 et après P7).
