# Carnet de bord — FortiGate / FortiOS

> Ce carnet existe pour qu'un autre agent puisse **reprendre le travail
> sans me poser de question**. Il dit où en est le module, ce qui a été
> décidé et pourquoi, ce qui est en cours, et quoi faire ensuite.
>
> Il enregistre **ce qui a été mesuré**, pas ce qui était prévu. Quand la
> mesure contredit le BRD, c'est la mesure qui est écrite ici et le BRD
> qui est corrigé.

| | |
|---|---|
| **BRD** | `docs/BRD-FortiGate.md` — 6019 lignes, 44 chapitres, 230 exigences |
| **BRD du socle** | `docs/BRD-Firewall.md` — prérequis de lecture |
| **Carnet du module** | `docs/JOURNAL-FIREWALL.md` — entrées E0…E32, défauts B1…B43 |
| **Code** | `src/network/devices/firewall/vendors/fortios/` |
| **Tests** | `src/__tests__/unit/network-v2/firewall/fortios-*.test.ts` |
| **E2E** | `e2e/fortigate-*.spec.ts` |
| **Branche** | `mandeng` |

---

## 1. Où en est le module — état au dernier commit

| Phase (BRD §39) | Contenu | État |
|---|---|---|
| — | Déclinaison initiale : profil, shell à deux tables, 32 cas | ✅ livrée (E31) |
| **1** | **La grammaire : schéma déclaratif, navigateur, trois rendus** | ✅ livrée (E32) |
| **1b** | **Migration sur le moteur de commandes partagé `src/cli/`** | ✅ livrée |
| **2** | Système et objets : `system *`, `addrgrp`, `service`, `schedule`, `router static` | ✅ livrée |
| **3** | NAT complet : `ippool`, `vip`, `central-snat-map`, `router policy` | ✅ livrée (E33) |
| **4** | Diagnostic et journaux | ✅ livrée (E34) |
| **5** | VDOM et modes de déploiement | ✅ livrée (E35) |
| **6** | Inspection et UTM | ✅ livrée (E36) |
| **7** | Utilisateurs et authentification | ✅ livrée (E37) |
| **8** | VPN | ✅ livrée (E38) |
| 9 | HA et SD-WAN | ⏳ |
| 10 | Routage dynamique (chantier de socle) | ⏳ |

**Mesures au dernier commit** : 1094 cas verts sur 38 fichiers du module
pare-feu ; 361 cas FortiOS (32 d'origine + 60 de grammaire + 29 de
système + 34 de NAT + 13 d'aide/langue + 44 de diagnostic + 27 de
VDOM + 36 d'UTM + 43 d'utilisateurs + 42 de VPN) ; 45 specs Playwright ;
aucune erreur de typecheck dans le module ; lint propre. **Le badge
« Limited simulation » est retiré.** S'y ajoutent 40 cas de socle
cryptographique (`ike-real-diffie-hellman.test.ts`).

---

## 2. Ce qui est décidé, et qu'il ne faut pas re-décider

Ces décisions sont prises, argumentées, et coûteuses à défaire. Un agent
qui reprend doit les connaître avant de toucher au code.

| # | Décision | Où c'est argumenté |
|---|---|---|
| **D1** | La grammaire est portée par un **schéma déclaratif**, jamais par du code par table | BRD §14, principe F1 |
| **D2** | Le schéma porte les **valeurs par défaut** — sans elles `show` et `get` ne peuvent pas différer, et `unset` ne peut pas se distinguer de `delete` | BRD §15, principe F2 |
| **D3** | `onCommit` est le **seul** point d'écriture vers les magasins du socle | BRD §14.5 |
| **D4** | Aucun moteur, aucune liste blanche, aucun verdict de paquet dans `vendors/fortios/` — garde-fous G1, G6 mécaniques | `architecture-guards.test.ts` |
| **D5** | `always` n'est pas un horaire mais **l'absence de restriction** : il se traduit `undefined` vers le socle | Défaut B41 |
| **D6** | La position d'une règle dans sa table est portée par le **contexte de commit**, jamais reconstituée | Défaut B40 |
| **D7** | Un attribut non simulé est **refusé** en nommant la brique manquante, jamais accepté inerte | BRD principe F6 |
| **D8** | Les notes de simulateur sont préfixées `NOTE:` et **supprimables** | BRD §17.4 |
| **D9** | La sérialisation de topologie **est** le texte de `show full-configuration` ; d'où l'exigence que cette sortie soit rejouable | BRD §34.2 |
| **D10** | **Le moteur de commandes est celui de `src/cli/`** — pas un second | §3 ci-dessous |
| **D11** | **La politique voit la destination APRÈS traduction** (`policySeesPreNatDestination: false`) ; ce qui lui fait quand même nommer la VIP, c'est que l'**objet adresse d'une VIP désigne l'adresse interne** | E33, renversement mesuré |
| **D12** | **`match-vip` vaut `enable` par défaut** (Fortinet l'a inversé en 7.2.3, et ce simulateur annonce 7.4.4) et n'existe que sur une règle `deny` | E33 |
| **D13** | `availableWhen` peut consulter un **autre objet** via `FortiObjectView.setting(chemin, attribut)`, servi par `FortiConfigTree` lui-même — jamais par un second magasin | E33, `central-nat` |
| **D14** | L'**ARP mandataire** est une propriété du socle (`Firewall.setProxyArpEntries`), consultée par `ArpService.answersFor` ; une VIP ou un pool le déclare, il ne le réimplémente pas | E33 |
| **D15** | **L'interface est en ANGLAIS** — messages de refus, notes du simulateur, motifs `unimplemented`. Un FortiGate ne parle pas français | Demande explicite, E33b |
| **D16** | `cliHelp(input)` **passe le texte tel quel**, espace de fin compris : c'est lui qui distingue « liste les enfants » de « filtre par préfixe » | E33b |
| **D17** | **`diagnose debug flow` lit `ctx.trace`** — la trace que le paquet a suivie, jamais une seconde écrite pour l'affichage | E34, OT-6 |
| **D18** | Un journal est **structuré** (`FirewallLogStore`), pas une ligne de texte : sans champs, `execute log filter field` ne peut filtrer sur rien | E34 |
| **D19** | Les champs d'un journal FortiOS sont **entre guillemets**, les numériques exceptés | E34, mesuré |
| **D20** | **La règle implicite ne journalise pas par défaut** ; `config log setting` / `set fwpolicy-implicit-log enable` la fait parler | E34, mesuré |
| **D21** | Une vue ne publie **que ce qui est mesuré** : pas de CPU ni de mémoire dans `get system performance status`, faute de modèle de charge | E34 |
| **D22** | **Un FortiGate multi-VDOM est UNE machine.** Jamais N objets `Firewall` : un registre de `VdomContext` sur un seul châssis | BRD §10.2, E35 |
| **D23** | Le **mono-VDOM est le cas particulier** du multi-VDOM, pas une branche : `FirewallServices` résout toujours par VDOM | FGT-VDM-2, E35 |
| **D24** | Un VDOM est une **PORTÉE** (`FortiTableSpec.scopeOnly`), pas un conteneur : l'arbre complet se rouvre dessous | Défaut B50 |
| **D25** | L'arbre de configuration est **indexé par portée** pour un spec `scope: 'vdom'` — sinon deux VDOM éditent la même table | Défaut B51 |
| **D26** | Le mode transparent est un **PIPELINE**, pas un drapeau : `FirewallProfile.pipeline` est un dictionnaire par mode | FGT-DEP-6, E35 |
| **D27** | `vdom-link` est un **vrai `Cable`** entre deux `Port` : c'est ce qui fait traverser les deux politiques pour de bon | BRD §10.5, E35 |

---

## 3. D10 — pourquoi le moteur de commandes partagé

**Le constat.** La phase 1 a livré une aide et une complétion écrites
dans `FortiShell` : une liste de verbes par contexte, un filtre par
préfixe, un rendu en deux colonnes. Cela fonctionne et c'est un **second
moteur** — alors que `src/cli/` en porte un, écrit pour Cisco et l'ASA,
qui fait davantage et mieux :

| Ce que `src/cli/` donne | Ce que la phase 1 faisait |
|---|---|
| Arguments **typés** (`INT` borné, `IP_ADDR`, `ENUM`…) | Types maison, validés à part |
| `?` rendant la **plage réelle** (`<0-32>`) | Le nom de l'attribut |
| Valeurs énumérées **décrites** une par une | Décrites, mais par un second chemin |
| Plusieurs **formes** pour une même place (`alternatives`) | Absent |
| **Abréviations** non ambiguës | Absent |
| **Ambiguïté** nommée plutôt que premier arrivé | Absent |
| `<cr>` quand la commande est complète | Absent |
| Filtrage par **atteignabilité** du sous-arbre | Absent |
| Complétion `TAB` distincte de `?` | Un seul comportement |

**La difficulté, et sa réponse.** FortiOS n'est pas une CLI à
mots-clés : les commandes légales dépendent de l'endroit où l'on est dans
l'arbre de configuration, et les attributs dépendent de l'objet ouvert.
Une `CommandTable` statique ne peut pas l'exprimer.

**La réponse retenue** : une `CommandTable` est **construite par
contexte**, à partir du schéma, et mise en cache. Un contexte est
(chemin de schéma, signature de disponibilité de l'objet). Chaque table
est petite — quelques dizaines de nœuds — et il n'y a **qu'un seul
moteur** : `parseCommand` décide de ce qui est légal, `complete` rend les
suggestions, et les gestionnaires appellent le navigateur qui mute.

**Le gain qui n'était pas prévu** : les références se complètent pour de
bon. Comme la table est bâtie à la demande, `set srcaddr ?` peut lister
les objets adresse **qui existent réellement**, ce qu'une table statique
ne saurait pas faire.

**Conséquence sur le BRD** : §14 est réécrit — le schéma décrit *ce qui
existe*, le moteur partagé décide *ce qui est légal et ce qui se
propose*. Les deux ne se recouvrent plus.

---

## 4. Carte du code

```
src/cli/                                  ← LE moteur, partagé (ne pas dupliquer)
├── ArgumentTypes.ts        ArgumentSpec, ARGUMENT_TYPES, argumentAccepts,
│                           argumentSuggestions, argumentPlaceholder
├── CommandTable.ts         CommandSpec, l'arbre, l'atteignabilité
├── CommandParser.ts        parseCommand, abréviations, ambiguïté
├── CompletionEngine.ts     complete(TAB | QUESTION_MARK), <cr>
├── CliSession.ts           mode, privilège, champs de contexte, invite
└── CliEngine.ts            exécution + messages IOS

src/network/devices/firewall/vendors/fortios/
├── FortiGate.ts            l'équipement
├── FortiProfile.ts         le profil (contrat de déclinaison)
├── FortiShell.ts           l'aiguilleur — ne connaît aucune table
├── FortiMessages.ts        le catalogue de messages, trois familles
├── FortiSocle.ts           ← construit la CommandTable par contexte
├── schema/
│   ├── types.ts            FortiTableSpec, FortiAttributeSpec
│   ├── index.ts            assemblage + schemaIndex()
│   ├── firewallPolicy.ts   config firewall policy
│   ├── firewallObjects.ts  config firewall address (+ phase 2)
│   ├── system.ts           ← phase 2
│   └── router.ts           ← phase 2
├── runtime/
│   ├── FortiObject.ts      un objet : valeurs explicites + défauts
│   ├── FortiTable.ts       une table : ordre, clés, clone/rename/move
│   ├── FortiConfigTree.ts  l'arbre des tables
│   ├── FortiNavigator.ts   la pile et les 18 verbes
│   └── FortiValidator.ts   validation (délègue à argumentAccepts)
└── render/
    ├── showRenderer.ts     show et show full-configuration
    └── getRenderer.ts      get
```

---

## 5. Les pièges déjà rencontrés

Un agent qui reprend gagnera du temps à les connaître.

| # | Piège | Comment il se manifeste |
|---|---|---|
| **P1** | `remove` puis `append` dans `onCommit` | Rééditer une règle la **remonte en fin de table**, donc change l'ordre d'évaluation. Utiliser `insertAt` avec `context.position`. |
| **P2** | Passer `schedule: 'always'` au socle | `PolicyEvaluator` refuse une règle dont l'horaire n'est pas évaluable → **aucune correspondance**, donc `ping` à 100 % de perte et NAT sans effet. Deux symptômes, une cause. |
| **P3** | `session as LinuxTerminalSession` dans `TerminalView` | Toute session déclarant `getSessionType() === 'linux'` traverse le chemin de rendu Linux. **Le terminal ne s'ouvre pas du tout** — l'arbre React tombe. Corrigé par des défauts sur `TerminalSession`. |
| **P4** | `strict: false` dans `tsconfig.app.json` | Les unions discriminées **ne se rétrécissent pas**. Un `{ok:true}\|{ok:false}` ne compile pas ; utiliser une forme plate. |
| **P5** | Les tests unitaires ne voient pas l'interface | `createSessionForDevice` rendait une session pendant que le terminal plantait. **Toute phase doit livrer une spec Playwright.** |
| **P6** | `FortiTerminalSession.getSessionType()` rend `'linux'` | Choix assumé pour le thème ; c'est ce qui expose P3. Ne pas le changer sans mesurer le thème et le collage. |
| **P7** | `ObjectStore.matchesAnyAddress` cherche un objet **par nom** | Une règle NAT portant une adresse **en clair** (l'`extip` d'une VIP) ne correspond à rien. Le moteur porte `addressMatches` (nom ou littéral) : c'est lui qu'il faut appeler. |
| **P8** | `ObjectStore.addAddress` refuse un doublon | Le motif `removeAddress` + `addAddress` laisse **silencieusement l'ancienne valeur** dès que l'objet est membre d'un groupe (le `remove` échoue alors). Utiliser `upsertAddress`. |
| **P9** | Une traduction posée écrase la précédente | Une session qui subit DNAT **puis** SNAT perd la moitié destination si `applyPolicyNat` ne **fusionne** pas : la réponse repart avec l'adresse interne et le client la refuse. Toujours `mergeTranslations`. |
| **P10** | La livraison locale précède le NAT | Une VIP posée sur l'adresse **de l'interface** — le renvoi de port le plus courant — est servie par la pile locale et jamais traduite. `Firewall.handleIpv4Frame` consulte `hasInboundRule` d'abord. |
| **P11** | Un laboratoire de sortie sans route par défaut | `route-lookup` refuse, la politique n'est jamais atteinte, et le symptôme lu est « le NAT ne traduit pas ». Quatre cas de la sonde de phase 3 sont tombés là-dessus. |
| **P12** | `session.c2s` porte le tuple **traduit** | La session est installée APRÈS le NAT. Filtrer ou afficher `c2s` montre l'adresse publique là où l'opérateur cherche la privée. Utiliser `originalFlow(session)`. |
| **P13** | Un argument `REST` est découpé aux espaces | `diagnose sniffer packet any 'host 1.2.3.4' 4 10` arrive en cinq mots : l'expression entre apostrophes doit être recollée avant lecture (`splitSnifferArguments`). |
| **P14** | Le garde-fou G1 borne un fichier vendeur à 800 lignes | Absorber un dispatch dans `FortiShell` le fait tomber. La réponse est d'extraire le calcul (`diag/FortiDiagCommands.ts`), jamais de desserrer le seuil. |
| **P15** | G6 interdit un `new Set(['…'])` littéral hors du schéma | Même pour une liste qui n'est pas des attributs de configuration. Nommer une constante `readonly string[]` et construire le `Set` à partir d'elle. |

---

## 6. Ce qu'il faut faire ensuite — dans l'ordre

### 6.1 Phase 1b — migration sur le moteur partagé — ✅ livrée

`FortiAttributeSpec` porte des `ArgumentSpec` de `src/cli/` ;
`FortiSocle` bâtit une `CommandTable` par contexte, mise en cache sur
(chemin, attributs disponibles, empreinte des références) ; `FortiShell`
délègue l'analyse et la complétion ; `FortiValidator` délègue à
`argumentAccepts`.

**Ce qui a été ajouté au moteur partagé**, purement additif :
`TreeNode.legend` et `CommandTable.describePath()`. Un nœud
intermédiaire héritait de la description de son **premier descendant**,
donc `config ?` annonçait « Configure IPv4 addresses. » pour le mot
`config` — la description d'une branche pour le nom de toutes. Cisco a
le même défaut sur `show ?` ; la légende le referme pour les deux, et
l'héritage reste le comportement par défaut.

**Acquis mesurés** : abréviations, ambiguïté nommée, plages réelles dans
l'aide (`<0-32>`), `<cr>`, et — le gain non prévu — les **références se
complètent sur ce qui existe** (`set srcaddr ?` liste les objets
adresse réellement déclarés), parce que la table est bâtie à la demande.

74 cas de grammaire, 1054 cas verts sur `firewall/` + `cli/`, typecheck
**348** contre une base à **351**.

### 6.2 Phase 2 — système et objets — ✅ livrée

**Onze chemins de configuration** : `system global`, `system settings`,
`system interface` (+ VLAN, `allowaccess`), `system zone`, `system dns`,
`system dhcp server` (+ `ip-range`), `firewall addrgrp`,
`firewall service custom`, `firewall service group`,
`firewall schedule recurring`, `router static`. Plus le catalogue de
36 services d'usine (`schema/predefined.ts`).

**Deux prélèvements sur le socle**, les premiers des treize (BRD §31.2) :

- **`model/ScheduleObject.ts`** — l'objet horaire que `BRD-Firewall` §8.5
  spécifiait et que personne n'avait écrit, avec `ScheduleStore` et la
  règle de franchissement de minuit ;
- le branchement de **`PolicyEvaluator.scheduleActive`**, qui existait
  comme dépendance et **n'était câblé par personne** — une règle horaire
  était donc soit inévaluable, soit ignorée ;
- **`Firewall.setAllowedAccess` / `allowsAccess`**, et le filtre appliqué
  dans `deliverLocally`. Une interface qui n'admet pas `ping` ne répond
  pas à l'écho. Une interface **jamais configurée** répond, sans quoi
  chaque autre constructeur aurait perdu son ping.

**Défaut trouvé par la suite à l'aveugle, dans le moteur partagé** :
un horaire déclaré `WORD` avec un `literal: 'hh:mm'` annonçait `hh:mm` à
l'opérateur et **acceptait n'importe quoi** — `set start 25:99` passait.
Le `literal` décrit, il ne vérifie pas. `src/cli/ArgumentTypes.ts` gagne
le type **`TIME`**, qui sert aussi à IOS (`clock set`, `time-range`).

**Mesures** : 29 cas, **24 tombent** avant correctif. 1102 verts sur
`firewall/` + `cli/`. Typecheck **347** contre une base à **351**.

### 6.2 bis — Phase 2, ce qui reste

`config system ntp`, `config firewall schedule onetime`,
`config firewall schedule group`, `config system dhcp server` côté
data-plane (le schéma existe, le serveur DHCP réel n'est pas encore
branché), et `config system interface` avec `mode dhcp` (client DHCP).

### 6.3 Phase 2 — le plan d'origine, pour mémoire

| Chemin | Fichier |
|---|---|
| `config system global` | `schema/system.ts` |
| `config system settings` | idem |
| `config system interface` (+ `secondaryip`) | idem |
| `config system zone` | idem |
| `config system dns`, `config system ntp` | idem |
| `config system dhcp server` (+ `ip-range`, `reserved-address`) | idem |
| `config firewall addrgrp` | `schema/firewallObjects.ts` |
| `config firewall service custom` / `group` | idem |
| `config firewall schedule recurring` / `onetime` | idem |
| `config router static` | `schema/router.ts` |
| Catalogue prédéfini (BRD §44.2) | `schema/predefined.ts` |

**Prélèvement sur le socle**, le premier des treize (BRD §31.2) :

- l'**objet horaire** (`model/ScheduleObject.ts`), spécifié par
  `BRD-Firewall` §8.5 et jamais implémenté ;
- le branchement de `PolicyEvaluator.scheduleActive`, qui existe comme
  dépendance et **n'est câblé par personne**.

**Critère de sortie** : le laboratoire L1 du BRD se joue de bout en bout
dans un terminal graphique, et `allowaccess` refuse vraiment une
connexion.

### 6.4 Phase 3 — NAT complet — ✅ livrée

Livrée : `config firewall ippool` (les quatre types, `nat/IpPool.ts`),
`config firewall vip` (statique et renvoi de port), l'ARP mandataire, le
trafic *hairpin*, `config firewall central-snat-map` avec `set
central-nat`, `config router policy` avec l'étape `policy-route` du
pipeline, et `match-vip`.

**Ce qui reste de la phase 3, nommé plutôt que tu** :

- `firewall vip` de type `server-load-balance` (grappe de serveurs réels,
  moniteurs de santé) — le type `static-nat` est livré, `dns-translation`
  et `fqdn` sont déclarés et non commis ;
- `firewall vip6` / `ippool6` (IPv6) — le socle NAT est IPv4 seul ;
- `central-snat-map` en `type ipv6`, `nat46`/`nat64` ;
- `pba-timeout` est stocké et ne périme rien : l'allocateur de blocs n'a
  pas d'horloge (`nat/IpPool.ts`).

### 6.5 Phase 4 — diagnostic et journaux — ✅ livrée

Livrée : `diagnose sys session list|filter|clear|stat`,
`diagnose debug flow` (filtres, `trace start`, `show function-name`),
`diagnose firewall iprope list|show`, `diagnose sniffer packet`, les
vues `get` (`system status`, `system performance status`, `system arp`,
`system interface`, `router info routing-table all`), `config log
syslogd[2-4]` + `filter`, `config log memory setting|global-setting`,
`config log setting`, les quatre formats (`default`, `csv`, `cef`,
`rfc5424`) et `execute log filter|display|delete-all`. **Le badge
« Limited simulation » est retiré du FortiGate.**

**Ce qui reste de la phase 4, nommé plutôt que tu** :

- `get system performance status` ne rend **ni CPU ni mémoire** : aucun
  modèle de charge n'existe, et une constante affichée là où la vue
  promet une mesure est précisément le défaut que ce dépôt referme ;
- les collecteurs syslog sont **configurables et n'émettent pas encore**
  vers un vrai collecteur — `SyslogAgent` existe sur le socle, le
  branchement du formateur FortiOS vers lui reste à faire ;
- `diagnose sniffer packet` lit le tampon de capture du pare-feu, pas le
  bus de trames global : il voit ce qui traverse CE pare-feu, ce qui est
  le périmètre de la commande, mais un `any` n'inclut pas les trames
  qu'un autre équipement échange ;
- `execute backup|restore|revision` (BRD §29.4-29.5) appartient au
  chapitre `execute` et n'a pas été pris.

### 6.6 Phase 5 — VDOM et modes de déploiement — ✅ livrée

Livrée : `VdomRegistry`/`VdomContext` au socle, étape `vdom-bind`,
`config vdom`, `config global`, `set vdom-mode multi-vdom`, `set vdom`
sur une interface, `config system vdom-link` (vrai câble interne),
`config system switch-interface` (étape `switch-bridge`),
`set opmode transparent` + `manageip`/`gateway` (étape `mac-lookup` et
pipeline par mode), et l'invite qui indique le VDOM courant.

**Ce qui reste de la phase 5, nommé plutôt que tu** :

- les **comptes administrateurs** ne sont pas encore une portée globale
  (`config global` existe, `config system admin` n'a pas de schéma) ;
- `vdom-mode split-vdom` est accepté et se comporte comme `multi-vdom` :
  la séparation gestion/trafic n'a pas de mécanisme derrière ;
- le **laboratoire L9** (FortiGate vs ASA) est une comparaison
  documentaire, pas un mécanisme ; il n'a pas été écrit en code ;
- l'apprentissage MAC du mode transparent est une table simple sur le
  châssis, sans vieillissement ni STP — `Switch` en a une plus complète,
  et la partager serait le prochain pas.

### 6.7 Phase 6 — inspection et UTM — ✅ livrée

Livrée : `inspection/UtmProfiles.ts` + `inspection/ContentInspector.ts`
au socle, étage `utm-inspect`, `config antivirus profile`,
`config webfilter profile` + `config webfilter urlfilter`,
`config dnsfilter profile` + `config dnsfilter domain-filter`,
`config file-filter profile`, `config firewall ssl-ssh-profile`,
`config firewall profile-protocol-options`, et les six références UTM
d'une politique derrière `set utm-status enable`.

**Trois défauts de socle trouvés ici et corrigés** (E36) : la session
était indexée sur le paquet APRÈS traduction (aucune connexion TCP ne
pouvait traverser avec NAT) ; l'inspection n'était appelée que sur le
premier paquet (la charge utile ne voyage jamais dans le SYN) ; un
enfant de type objet était injoignable depuis la CLI et absent du
`show`.

**Ce qui est REFUSÉ dans le produit, en nommant la brique absente** —
et qu'il ne faut donc pas « implémenter » sans fournir la brique :

- `deep-inspection` : pas de point de terminaison TCP/TLS sur le
  pare-feu, donc aucun certificat re-signé possible ;
- `application list`, `ips sensor`, `dlp sensor` : pas de base de
  signatures FortiGuard, et il n'y en aura pas ;
- `firewall shaper traffic-shaper` : pas d'horloge de fil.

**Ce qui reste de la phase 6, nommé plutôt que tu** :

- le catalogue de catégories est LOCAL (quatre catégories,
  `LOCAL_URL_CATEGORIES`) : il n'y a pas de FortiGuard ;
- l'antivirus reconnaît EICAR et rien d'autre — c'est une signature de
  test, pas un moteur ;
- `scan-archive-contents` est accepté et ne descend dans aucune archive
  (il n'y a pas de décompresseur) ;
- le filtrage de fichiers lit le nombre magique en tête de corps, donc
  ne voit pas un fichier réparti sur plusieurs segments.

**Si vous câblez le serveur DHCP du FortiGate** (`config system dhcp
server` est aujourd'hui grammaire seule) : le socle DHCP du dépôt est
`src/network/dhcp/DHCPServer.ts`. N'en écrivez pas un second.

### 6.8 Phase 7 — utilisateurs et authentification — ✅ livrée

Livrée : `IdentityTable` (le pendant de `SessionTable` pour les
identités), `UserDirectory`, `AccessMatrix`, `AuthPortal`, une **pile
TCP sur le pare-feu**, l'étage `auth-check`, `config user
{local,group,radius,tacacs+,ldap,setting}`, `config system
{admin,accprofile}` avec `trusthost`, et `diagnose firewall auth
{list,clear,filter}`.

**La pile TCP du pare-feu est neuve et vaut au-delà de cette phase** :
c'est la brique dont l'absence avait fait refuser `deep-inspection` en
phase 6. Elle ne suffit pas à elle seule pour la rouvrir (il faudrait
aussi terminer ET ré-émettre une session TLS sous un certificat
re-signé), mais elle en est le premier morceau.

**Réutilisations — ne réécrivez rien de tout cela** :
`NetworkOsCredentialStore` (comptes, verrouillage), `RadiusClientAgent`,
`TacacsClientAgent`, **`LdapClient`/`dialLdap`** (chantier AD),
`Http1ServerSession` (portail), `TcpStack` (adaptateur de `Router`),
`addressObjectMatches` (comparaison `trusthost`).

**Ce qui est REFUSÉ dans le produit**, en nommant la brique absente :
FSSO (pas de contrôleur de domaine ni d'agent collecteur), SAML (pas de
fournisseur d'identité), et la double authentification `fortitoken` /
`email` / `sms` (pas de graine de jeton ni d'horloge partagée — un
second facteur toujours accepté serait pire que pas de second facteur).

**Ce qui reste de la phase 7, nommé plutôt que tu** :

- le portail sert le formulaire et traite le POST, mais **rien
  n'INTERCEPTE encore le premier flux HTTP pour y rediriger** : le
  laboratoire s'authentifie en appelant le portail, pas en étant
  détourné vers lui ;
- `security-mode captive-portal` sur une interface (l'autre forme du
  portail, par interface au lieu de par politique) n'a pas de schéma ;
- l'authentification d'un compte administrateur à l'ouverture de session
  n'est pas branchée sur une vraie connexion SSH au pare-feu — le
  pare-feu n'a pas encore de serveur SSH ;
- `two-factor` est refusé, donc `email-to` est stocké sans emploi.

### 6.9 Phase 8 — VPN — ✅ livrée

Livrée : `config vpn ipsec phase1-interface` / `phase2-interface` (et la
forme héritée `phase1`), l'interface de tunnel — routable et nommable en
`srcintf`/`dstintf` —, `diagnose vpn tunnel {list,summary,up}`, et la
programmation du moteur IKE partagé depuis les déclarations FortiOS.

**Deux chantiers de SOCLE en font partie, et ils dépassent FortiOS** :

- **IKE calcule un vrai Diffie-Hellman** (`crypto/dh/modp.ts`,
  `ipsec/IkeKeyExchange.ts`). Avant, aucun groupe n'était calculé ; le
  matériel de clé venait de la seule PSK. Les nombres premiers viennent
  des RFC 2409 et 3526, extraits du texte et vérifiés. **Cela profite
  aussi à Cisco et Huawei**, qui partagent ce moteur.
- **3DES se déchiffre** (`crypto/cipher/des.ts`), et ESP l'applique
  vraiment.

**`IpsecHost` est le port étroit** qui permet à `Router` ET à `Firewall`
d'héberger le MÊME moteur IKE. N'en écrivez pas un second.

**Ce qui reste de la phase 8, nommé plutôt que tu** :

- le tunnel se déclare, se programme et se diagnostique, mais **aucun
  test ne fait encore circuler un ping de bout en bout à travers lui**
  (FGT-VPN-3) : cela demande un laboratoire à deux FortiGate reliés, et
  l'étage de chiffrement du pipeline n'est pas branché sur l'interface
  de tunnel ;
- `authmethod signature` (certificats) est accepté et ne change rien —
  le moteur a `IkeCertAuthConfig`, il reste à le brancher ;
- SSL-VPN (`config vpn ssl settings`, portail web) n'a pas de schéma ;
- `dpd` et `nattraversal` sont déclarés et transmis au moteur, mais
  aucun test ne les mesure ici.

### 6.10 Après

Suivre §39 du BRD. Chaque phase : revendiquer dans
`JOURNAL-FIREWALL.md`, livrer, discriminer par `git stash`, mettre à jour
ce carnet.

---

## 7. La procédure de livraison

Elle n'est pas négociable — c'est ce qui rend le travail reprenable.

1. **Revendiquer** le périmètre dans `docs/JOURNAL-FIREWALL.md` avant
   d'écrire (un autre agent travaille sur le même module).
2. Écrire les cas **à l'aveugle** : décrire ce qu'une vraie machine fait,
   sans lire l'implémentation d'abord. C'est ce qui a trouvé B40.
3. Tout cas nominal a son **témoin** — le cas où ça ne marche pas.
4. **Discriminer** : `git stash push -- src/network/devices/firewall/`,
   rejouer, compter les cas qui tombent, écrire le nombre.
5. Non-régression **du module seul** :
   `npx vitest run src/__tests__/unit/network-v2/firewall/`.
6. Au moins une spec **Playwright** par phase (voir P5).
7. Typecheck ≤ base, lint identique fichier par fichier.
8. Journal + carnet + BRD si la mesure l'a contredit.
9. Commit, push.

**Base de référence au dernier commit** : typecheck **347** erreurs
(le chiffre monte quand la branche intègre d'autres travaux — le
comparer, jamais le supposer).

---

## 8. Historique des mises à jour de ce carnet

| Date | Auteur | Ce qui change |
|---|---|---|
| 2026-08-17 | agent `mandeng` | Création. État après phase 1, décision D10, plan de phase 1b et 2. |
| 2026-08-17 | agent `mandeng` | Phase 3 livrée (E33). Décisions D11 à D14, pièges P7 à P11, §6.4 (ce qui reste de la phase 3). |
| 2026-08-17 | agent `mandeng` | Phase 4 livrée (E34), badge retiré. Décisions D15 à D21, pièges P12 à P15, §6.5 (ce qui reste de la phase 4). |
| 2026-08-17 | agent `mandeng` | Phase 5 livrée (E35). Décisions D22 à D27, §6.6 (ce qui reste de la phase 5). |
| 2026-08-18 | agent `mandeng` | Phase 8 livrée (E38). §6.9. **Socle : IKE calcule un vrai DH ; 3DES se déchiffre.** Deux affirmations du BRD corrigées après vérification. |
| 2026-08-18 | agent `mandeng` | Phase 7 livrée (E37). §6.8. Pile TCP sur le pare-feu. **LDAP était déjà écrit (chantier AD) — le BRD se trompait, corrigé.** |
| 2026-08-18 | agent `mandeng` | Phase 6 livrée (E36). §6.7 (refus assumés, ce qui reste). Trois défauts de socle corrigés (clé de session post-NAT, inspection hors du premier paquet, enfants de type objet). |
