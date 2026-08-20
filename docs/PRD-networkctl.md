# PRD — networkctl : le client de systemd-networkd

**Version** : 1.0
**Date** : 2026-07-28
**Projet** : Ubuntu Sandbox — Plan de gestion réseau Linux
**Auteur** : Claude Code
**Références normatives** : `networkctl(1)`, `systemd.network(5)`, `systemd.netdev(5)`, `systemd.link(5)`, `systemd-networkd.service(8)`, `org.freedesktop.network1(5)`

---

## 0. Contexte et portée du document

`networkctl` est l'outil par lequel un administrateur Ubuntu **constate** l'état réseau
tel que `systemd-networkd` le voit : quels liens existent, lesquels sont opérationnels,
qui les configure, et pourquoi l'un d'eux ne monte pas. C'est un outil de diagnostic
avant d'être un outil de configuration.

La commande existe déjà dans le simulateur (`commands/net/Networkctl.ts`, 20 lignes) et
rend deux verbes. Le problème n'est pas qu'elle soit incomplète — c'est attendu à ce
stade — mais qu'elle **affirme des choses fausses avec aplomb** : elle déclare
« routable, configured » pour des interfaces que `ip link`, sur la même machine au même
instant, décrit comme `NO-CARRIER ... state DOWN`. Un outil de diagnostic qui contredit
le noyau n'est pas incomplet, il est trompeur : l'apprenant qui s'en sert pour
comprendre pourquoi son lien ne monte pas reçoit une réponse rassurante et fausse.

Le périmètre est donc, dans l'ordre : **rendre vrai ce qui est déjà affiché**, puis
enrichir `status` de l'état que l'équipement porte déjà, puis introduire le répertoire
`/etc/systemd/network` que la sortie actuelle nomme sans qu'il existe, puis les verbes
d'action, enfin `lldp`. Aucune ligne de code n'est écrite dans le cadre de ce document.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Lignes |
|---|---|---|
| `src/network/devices/linux/commands/net/Networkctl.ts` | Façade CLI : aiguille `status`/`list` | 20 |
| `src/network/devices/linux/LinuxNetworkConfigManager.ts` | `networkctlStatus()`, `nmcliDeviceStatus()`, netplan, ifup/ifdown, drift | 269 |
| `src/network/devices/linux/net/NetworkConfigFiles.ts` | Parseurs `/etc/network/interfaces` et netplan YAML | ~170 |
| `src/network/devices/linux/LinuxIpCommand.ts` | `ip link/addr/route` — la référence de fidélité | ~900 |
| `src/network/devices/LinuxMachine.ts` | `wireNetworkConfigLifecycle()` : le cycle de vie de l'unité rejoue netplan | — |
| `src/network/devices/linux/LinuxServiceManager.ts` | Unité `systemd-networkd.service` modélisée (l. 260) | 1070 |
| `src/network/hardware/Port.ts` | MAC, MTU, vitesse, duplex, compteurs, état admin et carrier | — |
| `src/network/dhcp/DHCPClient.ts` | Bail réel : `getState(iface)`, `requestLease`, `releaseLease` | — |

### 1.2 Ce qui existe déjà et est réutilisable

- **L'unité `systemd-networkd` est réelle**, pas décorative : elle tourne dans `ps`,
  `systemctl status` la rend, et `LinuxMachine.wireNetworkConfigLifecycle()` rejoue
  `applyNetplan()` à chaque `start`/`restart`/`reload`. C'est le point d'ancrage naturel
  de `networkctl reload` et `reconfigure` — il ne reste qu'à s'y brancher.
- **`Port` porte déjà tout ce que `status` devrait montrer** : MAC, MTU, vitesse,
  duplex, état administratif, présence de porteuse, compteurs d'erreurs. Rien à
  modéliser, seulement à lire.
- **`LinuxIpCommand` est la référence de fidélité** : c'est lui qui distingue
  correctement `UP`/`LOWER_UP`/`NO-CARRIER`, et lui qui synthétise `lo` en tête de liste
  (`['lo', ...names.filter(n => n !== 'lo')]`, l. 543). Toute notion d'état de lien doit
  se dériver de la même source pour que les deux commandes ne puissent plus se
  contredire.
- **Le client DHCP tient un vrai bail** (`DHCPClientIfaceState` : état FSM, bail,
  minuteurs de renouvellement/rebinding/expiration). `networkctl renew` a donc une
  cible réelle, et `Address Source: DHCPv4` peut devenir une constatation plutôt qu'une
  supposition.
- **Le socle de commande gère déjà les privilèges et l'aide** : `LinuxCommand` accepte
  un `PrivilegeRequirement` (`{ satisfiedBy: Satisfy.root }`, cf. `Iptables.ts`) et des
  `LinuxCommandOption` déclaratives qui génèrent `--help` et `man`. Les verbes d'action
  et les options globales n'ont pas de machinerie à inventer.

### 1.3 Ce qui manque ou court-circuite (analyse d'écart)

Les constats ci-dessous sont **mesurés**, sur un `LinuxPC` à 4 ports dont un seul est
câblé (`eth0` vers un switch), les trois autres libres.

| # | Écart constaté | Comportement réel attendu | Sévérité |
|---|---|---|---|
| 1 | `list` annonce `routable configured` pour **les quatre** ports, alors que `ip -br link` donne `NO-CARRIER … state DOWN` pour `eth1`/`eth2`/`eth3`. Les colonnes sont des littéraux (`Networkctl.ts` l. 16) | Chaque lien porte son état réel ; un lien sans porteuse est `no-carrier` | Bloquant |
| 2 | L'état est un booléen aplati : `routable (configured)` ou `off` | Deux axes distincts — OPERATIONAL (`missing`, `off`, `no-carrier`, `dormant`, `degraded-carrier`, `carrier`, `degraded`, `enslaved`, `routable`) et SETUP (`pending`, `configuring`, `configured`, `unmanaged`, `failed`, `linger`) | Bloquant |
| 3 | `Address Source: DHCPv4` affiché pour une interface portant une IP statique posée à la main : la valeur est lue dans le fichier *déclaré*, jamais dans l'état vivant | La source constatée sur le lien (statique, DHCPv4, DHCPv6, RA, lien-local) | Élevée |
| 4 | `lo` est inconnu de `networkctl` (`Unknown interface lo`) alors que `ip link` le rend | `lo` est le lien d'index 1, type `loopback`, `carrier`/`unmanaged` | Élevée |
| 5 | Sans verbe, `networkctl` rend `status` | Sans verbe, `list` est implicite | Élevée |
| 6 | `status` sans argument rend un bloc par lien | Sans argument, `status` rend l'**état global du gestionnaire** (état, état en ligne, adresses, passerelle, DNS) ; `-a` demande tous les liens | Élevée |
| 7 | `status` n'affiche ni MAC, ni MTU, ni adresses, ni routes, ni DNS — que `Port` porte pourtant déjà | Bloc complet : `Hardware Address`, `MTU`, `Address`, `Gateway`, `DNS`, `Path`/`Driver` | Élevée |
| 8 | `Link File: /usr/lib/systemd/network/99-default.link` est une constante ; `/etc/systemd/network` n'existe pas et aucun `.network`/`.netdev`/`.link` n'est analysé nulle part | Les fichiers sont réels, découverts par ordre lexicographique, et le nom affiché est celui qui s'applique | Élevée |
| 9 | Dix verbes absents : `lldp`, `up`, `down`, `renew`, `forcerenew`, `reconfigure`, `reload`, `cat`, `edit`, `label`, `delete` | Tous rendus ; les verbes d'action exigent les privilèges | Moyenne |
| 10 | Toute option est jetée (`args.filter(a => !a.startsWith('-'))`), d'où `--version` qui rend la liste des statuts et `--no-legend` sans effet | `--version`, `--no-legend`, `--no-pager`, `-a`, `-l`, `-s`, `-n` honorés | Moyenne |
| 11 | `--help` rend une ligne d'usage | Aide complète, dérivable des `LinuxCommandOption` déjà supportées | Faible |
| 12 | Verbe inconnu → message sur la sortie normale, code de retour 0 | Message d'erreur et code de retour non nul | Faible |
| 13 | Aucun agent LLDP sur un hôte Linux (LLDP n'existe que sur switches et routeurs) | Prérequis à `networkctl lldp` — voir §7 | Moyenne |

**Ce qui est déjà juste et ne doit pas régresser** : la détection de conflit
networkd / NetworkManager (`also managed by NetworkManager`) et la lecture du
`renderer` netplan sont correctes et couvertes par
`linux-network-config-drift.test.ts`. Ce PRD les conserve telles quelles.

---

## 2. Modèle de données

L'écart #2 est la racine des écarts #1 et #6 : tant que l'état d'un lien est un booléen,
aucune sortie ne peut être fidèle. On introduit donc un état de lien avant toute
commande.

### 2.1 `LinkState` — dérivé, jamais stocké

Une structure **calculée à la demande** depuis `Port` + configuration déclarée. Rien
n'est mémorisé : un état mémorisé peut diverger du lien, ce qui est précisément le
défaut qu'on corrige.

| Champ | Type | Dérivation |
|---|---|---|
| `index` | `number` | Rang, `lo` d'abord (même convention que `LinuxIpCommand` l. 543) |
| `name` | `string` | Nom du port |
| `type` | `'loopback' \| 'ether'` | `lo` ou port physique |
| `operational` | `OperationalState` | Voir 2.2 |
| `setup` | `SetupState` | Voir 2.3 |
| `online` | `'offline' \| 'partial' \| 'online'` | Agrégat des liens gérés |
| `addressSource` | `'static' \| 'DHCPv4' \| 'DHCPv6' \| 'RA' \| 'link-local' \| 'foreign'` | État **vivant** : bail DHCP actif → `DHCPv4` ; IP posée hors bail → `static` |
| `hardwareAddress`, `mtu` | — | Lus sur `Port` |
| `addresses`, `gateway`, `dns` | — | Lus sur la pile L3 de l'hôte |
| `networkFile`, `linkFile` | `string \| null` | Fichiers qui s'appliquent réellement (§5) ; `null` tant que la phase 3 n'est pas livrée |

### 2.2 `OperationalState`

Ordre croissant, tel que systemd le définit :

| Valeur | Condition |
|---|---|
| `missing` | Le lien a disparu du noyau |
| `off` | Administrativement bas (`ip link set X down`) |
| `no-carrier` | Admin haut, pas de porteuse — **le cas de `eth1` aujourd'hui annoncé `routable`** |
| `dormant` | Porteuse présente, en attente d'authentification (802.1X) |
| `degraded-carrier` | Porteuse, mais un lien esclave manque |
| `carrier` | Porteuse, aucune adresse configurée |
| `degraded` | Adresse lien-local seulement |
| `enslaved` | Membre d'un bond/bridge |
| `routable` | Adresse routable configurée |

`degraded-carrier`, `dormant` et `enslaved` n'ont **pas** de source de vérité dans le
simulateur aujourd'hui (ni bond/bridge Linux, ni 802.1X côté hôte). Ils sont définis
ici pour que le type soit complet, mais aucune dérivation ne les produira : les
produire supposerait un modèle qui n'existe pas. C'est une limite assumée, pas un
oubli.

### 2.3 `SetupState`

| Valeur | Condition |
|---|---|
| `pending` | Lien vu, pas encore traité |
| `configuring` | Configuration en cours |
| `configured` | networkd a appliqué une configuration |
| `unmanaged` | Aucun `.network` ne correspond, ou `renderer: NetworkManager`, ou `lo` |
| `failed` | La configuration a échoué |
| `linger` | Lien parti, configuration conservée |

`lo` est `unmanaged` : c'est ce que fait le vrai networkd, et cela résout #4 sans
inventer de configuration pour la boucle locale.

---

## 3. Phase 1 — Que `list` cesse de mentir

**C'est la seule phase qui corrige un mensonge ; elle passe avant tout le reste.**

1. `list` dérive OPERATIONAL et SETUP de `LinkState`, plus de littéraux.
2. `lo` apparaît en index 1, `loopback`, `carrier`, `unmanaged`.
3. Sans verbe, `list` est implicite.
4. Alignement des colonnes sur le vrai `networkctl` : `IDX LINK TYPE OPERATIONAL SETUP`,
   plus une ligne de légende `N links listed.` (supprimée par `--no-legend`).
5. `list PATTERN...` filtre par motif glob.

**Critère d'acceptation, formulé comme un test** : sur un hôte à N ports dont un seul
câblé, `networkctl list` et `ip -br link` doivent s'accorder sur quel lien a une
porteuse. C'est la contradiction mesurée en §1.3 #1, et c'est elle qu'on épingle.

---

## 4. Phase 2 — Un `status` qui montre l'équipement

1. `status` sans argument → **état global** : `State`, `Online state`, `Address`,
   `Gateway`, `DNS` agrégés sur les liens gérés.
2. `status <lien>` → bloc complet : `Link File`, `Network File`, `Type`, `State`
   (`<operational> (<setup>)`), `Online state`, `Hardware Address`, `MTU`,
   `Address Source`, `Address`, `Gateway`, `DNS`.
3. `status -a` → tous les liens, un bloc chacun (le comportement actuel sans argument).
4. `Address Source` constate l'état vivant : bail DHCP actif → `DHCPv4` ; adresse posée
   hors bail → `static`. C'est l'écart #3.
5. `status lo` répond au lieu de `Unknown interface lo`.
6. L'avertissement de conflit NetworkManager est conservé mot pour mot.

---

## 5. Phase 3 — Le répertoire que la sortie nomme déjà

Aujourd'hui `status` affiche `Link File: /usr/lib/systemd/network/99-default.link` alors
que ce fichier n'existe pas et qu'aucun analyseur ne lit ce format. Deux issues
honnêtes : rendre le fichier réel, ou cesser de le nommer. On choisit la première, parce
que `/etc/systemd/network/*.network` est le mode de configuration natif d'Ubuntu Server
et que netplan y délègue.

1. Analyseur de fichiers `.network` — sections `[Match]` (`Name=`, `Type=`) et
   `[Network]` (`DHCP=`, `Address=`, `Gateway=`, `DNS=`), plus `[Link]` (`MTUBytes=`,
   `MACAddress=`).
2. Découverte dans `/etc/systemd/network`, `/run/systemd/network`,
   `/usr/lib/systemd/network`, par ordre lexicographique, **première correspondance
   gagnante** — c'est la règle de systemd, et c'est ce qui permet à un `10-` de battre
   un `99-`.
3. Amorçage d'un `99-default.link` réel, pour que le nom déjà affiché corresponde à un
   fichier existant.
4. `networkctl cat [lien|fichier]` rend le contenu, en-tête `# /chemin/du/fichier`
   compris.
5. `networkctl edit` ouvre l'éditeur déjà simulé (`vim`/`nano`) sur un fragment
   `.d/override.conf`.

Netplan reste la source prioritaire quand `/etc/netplan` existe : c'est le
comportement d'Ubuntu, et la couverture de dérive existante en dépend.

---

## 6. Phase 4 — Les verbes d'action

Tous exigent `Satisfy.root` via le `PrivilegeRequirement` déjà supporté, et rendent un
code de retour non nul en cas d'échec (écart #12).

| Verbe | Effet attendu |
|---|---|
| `up DEVICES…` | Monte administrativement — même chemin que `ip link set X up` |
| `down DEVICES…` | Descend administrativement |
| `renew DEVICES…` | Renouvellement DHCP via `DHCPClient.requestLease()` |
| `forcerenew DEVICES…` | Force un cycle complet |
| `reconfigure DEVICES…` | Réapplique la configuration du seul lien visé |
| `reload` | Relit les fichiers et réapplique — se branche sur le `reload` de l'unité, qui rejoue déjà `applyNetplan()` |
| `delete DEVICES…` | Supprime un lien **virtuel** ; refus explicite sur un lien physique, comme le vrai networkd |
| `label` | Table des étiquettes d'adresses (RFC 3484) |

`up`/`down` doivent traverser le **même** chemin que `ip link set` plutôt que d'écrire
l'état en parallèle : deux chemins d'écriture pour un même bit, c'est la façon dont
naissent les contradictions que ce PRD corrige.

---

## 7. Phase 5 — `networkctl lldp`

**Prérequis non satisfait, et c'est la phase la plus lourde.** Il existe un moteur LLDP
réel (`src/network/lldp/`), mais il n'est instancié que sur les switches et les
routeurs : `grep` sur `devices/linux/` et `devices/host/` ne rend aucune occurrence.
Un hôte Linux n'émet ni ne reçoit de LLDP aujourd'hui.

Le travail se décompose en deux, et l'ordre n'est pas négociable :

1. **Agent LLDP côté hôte** — instancier `LldpAgent` sur `EndHost`, émettre une
   trame depuis les identités déjà portées par l'hôte (nom, description de port, MAC
   châssis), et traiter les trames reçues. C'est ce qui donne enfin à un PC de la
   maquette la capacité de découvrir le switch auquel il est câblé.
2. **Rendu `networkctl lldp`** — colonnes `LINK CHASSIS ID SYSTEM NAME CAPS PORT ID
   PORT DESCRIPTION`, alimentées par le voisinage réel.

Si seule l'étape 2 était livrée, la commande rendrait une table vide en permanence :
correct au sens strict, inutile en pratique. **L'étape 1 est donc dans le périmètre de
cette phase ou la phase entière est reportée** — livrer 2 sans 1 reproduirait
exactement le défaut que ce PRD corrige, un affichage sûr de lui sans rien derrière.

---

## 8. Phase 6 — Options globales

`--help`, `--version`, `--no-legend`, `--no-pager`, `-a`/`--all`, `-l`/`--full`,
`-s`/`--stats`, `-n`/`--lines=`. Les options sont déclarées en `LinuxCommandOption`,
ce qui produit `--help` et `man networkctl` sans rendu manuel. Cela clôt les écarts
#10 et #11, dont le plus visible est `networkctl --version` qui rend aujourd'hui la
liste complète des statuts.

---

## 9. Stratégie de test

Fichiers proposés, dans la convention du dépôt (`src/__tests__/unit/network-v2/`) :

| Fichier | Couvre |
|---|---|
| `networkctl-list-dit-la-verite.test.ts` | Phase 1 — dont **la corrélation avec `ip -br link` sur la même machine**, qui est le test central de ce PRD |
| `networkctl-status-fidelite.test.ts` | Phase 2 — global vs par lien, MAC/MTU/adresses, `Address Source` constatée |
| `networkctl-fichiers-network.test.ts` | Phase 3 — priorité lexicographique, `cat`, cohabitation netplan |
| `networkctl-verbes-action.test.ts` | Phase 4 — effet réel sur le lien, privilèges, codes de retour |
| `networkctl-lldp.test.ts` | Phase 5 — voisin réellement découvert à travers un vrai câble |
| `networkctl-options.test.ts` | Phase 6 |

Trois règles de méthode, tirées des campagnes précédentes :

1. **Mesurer avant d'affirmer.** Chaque assertion est écrite après avoir observé la
   sortie réelle, jamais depuis la lecture du code. Deux faux négatifs de ce PRD ont été
   trouvés ainsi (un port non câblé ne produit aucun évènement de lien ; `getDebugService`
   n'est pas le registre VRP).
2. **Ne jamais faire passer un test par la force.** Un test rouge décrit un écart ; on
   corrige le moteur ou on documente l'écart, on n'affaiblit pas l'assertion.
3. **Corréler deux commandes plutôt que figer une chaîne.** `networkctl list` contre
   `ip -br link` est un test qui survit à un changement de format ; `toContain('routable')`
   ne survit à rien et n'aurait pas attrapé le défaut d'origine.

---

## 10. Hors périmètre

- **Bond, bridge, VLAN et VXLAN côté hôte Linux** — d'où l'absence de dérivation pour
  `enslaved` et `degraded-carrier` (§2.2). `.netdev` n'est pas analysé.
- **802.1X côté hôte**, d'où `dormant` non dérivable.
- **D-Bus** : le vrai `networkctl` parle à `org.freedesktop.network1`. Ici l'accès est
  direct, en mémoire. La façade est fidèle, le transport ne l'est pas.
- **`networkctl mask` / `unmask` / `persistent-storage`** (systemd ≥ 254).
- **IPv6 par annonces de routeur (RA)** comme source d'adresse : la valeur est prévue
  dans le type, sa dérivation dépend d'un modèle RA hôte absent.
- **`nmcli`** : `nmcliDeviceStatus`/`nmcliDeviceShow` existent et restent tels quels. Ce
  PRD ne touche pas à NetworkManager, sinon pour conserver la détection de conflit.

---

## 11. Risques

| Risque | Portée | Atténuation |
|---|---|---|
| La dérive netplan existante casse | `linux-network-config-drift.test.ts` épingle `State: routable (configured)` et `Address Source: static` | La phase 2 change la sémantique de `Address Source`. Vérifier le test **avant** : sur une interface déclarée statique il doit continuer de rendre `static`, et si l'assertion tombe, c'est la prémisse du test qu'il faut corriger, jamais l'assertion |
| Deux chemins d'écriture pour l'état d'un lien | Phase 4 | `up`/`down` traversent le chemin de `ip link set`, pas un second |
| État de lien mémorisé qui diverge | Phase 1 | `LinkState` est dérivé à chaque appel, jamais stocké |
| Phase 5 livrée à moitié | LLDP | L'agent hôte est dans le périmètre de la phase, ou la phase est reportée entière (§7) |

---

## 12. Ordre de livraison recommandé

**Phase 1 d'abord, seule, et poussée seule.** C'est la seule qui corrige une sortie
fausse ; les cinq autres ajoutent des fonctions à un outil qui, une fois la phase 1
livrée, ne se contredit plus. Ensuite 2, 3, 6 (peu coûteuses, fortement visibles), puis
4, et 5 en dernier — ou pas, si l'agent LLDP hôte n'est pas voulu.
