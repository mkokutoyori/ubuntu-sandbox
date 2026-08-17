# BRD — FortiGate / FortiOS

> Déclinaison **Fortinet** du module pare-feu. Ce document dit ce qu'est
> un FortiGate, ce que le simulateur en porte déjà, ce qu'il faut y
> ajouter, dans quel ordre, et à quoi l'on reconnaîtra que c'est fait.
>
> Il ne redéfinit pas le pare-feu générique : `docs/BRD-Firewall.md`
> porte le socle (sessions, politique, NAT, pipeline, objets, zones) et
> le **contrat de déclinaison vendeur** (§26). Ici, on n'écrit que ce qui
> est **fortinet**, et à chaque fois qu'un besoin FortiOS se ramène à un
> mécanisme du socle, on le dit explicitement plutôt que de le réécrire.

| | |
|---|---|
| **Document** | BRD — Business Requirements Document |
| **Sujet** | Pare-feu Fortinet FortiGate, système FortiOS 7.4 |
| **Module** | `src/network/devices/firewall/vendors/fortios/` |
| **Statut** | Base livrée (32 cas verts) — extension spécifiée ici |
| **Branche** | `mandeng` |
| **Socle** | `docs/BRD-Firewall.md` (6473 lignes) — **prérequis de lecture** |
| **Carnet** | `docs/JOURNAL-FIREWALL.md` |
| **Documents liés** | `PRD-Port-Forwarding.md`, `PRD-Iptables-UFW.md`, `PRD-NAT-Port-Forwarding.md`, `PRD-Routage-Fidelite.md`, `PRD-Pannes.md`, `PRD-CLI-Fidelite-IOS.md`, `PRD-Tableaux-CLI.md` |
| **Version FortiOS de référence** | 7.4.x (branche LTS au moment de la rédaction) |
| **État de rédaction** | Parties I à III rédigées (§1 à §17). Parties IV à VII (§18 à §44) en cours. |

---

## Comment lire ce document

Trois conventions, tenues de bout en bout.

**Les exigences sont numérotées `FGT-<famille>-<n>`** et chacune est
**vérifiable** : elle nomme la commande qu'on tape et la sortie qu'on
observe. Une exigence qu'on ne sait pas mesurer n'est pas une exigence,
c'est un vœu, et elle est refusée à l'écriture.

**Ce qui est déjà là est écrit comme tel**, avec le fichier et la ligne.
L'inventaire de §3 n'est pas décoratif : il est ce qui empêche de
réécrire un moteur qui existe. Le dépôt a déjà payé ce prix ailleurs
(deux registres Windows, deux piles SSH, deux rendus de `flash:`), et le
module pare-feu s'est doté de garde-fous mécaniques pour ça
(`architecture-guards.test.ts`, G1 à G5).

**Ce qui ne sera pas simulé est écrit deux fois** : une fois dans le
chapitre concerné, une fois dans §43 (hors périmètre). Une limite qui
n'apparaît qu'à un endroit finit par être oubliée, et un simulateur qui
accepte une commande sans rien faire est pire qu'un simulateur qui la
refuse — c'est le défaut que ce dépôt referme partout, sous le nom de
« rangé et lu par personne ».

---

## Table des matières

### Partie I — Cadrage

1. [Pourquoi un BRD dédié à FortiGate](#1-pourquoi-un-brd-dédié-à-fortigate)
2. [Objectifs, non-objectifs, critère d'arbitrage](#2-objectifs-non-objectifs-critère-darbitrage)
3. [Inventaire de l'existant — mesuré](#3-inventaire-de-lexistant--mesuré)
4. [Ce que FortiOS a d'irréductible](#4-ce-que-fortios-a-dirréductible)
5. [Personas, laboratoires, cas d'usage](#5-personas-laboratoires-cas-dusage)
6. [Principes directeurs propres à la déclinaison](#6-principes-directeurs-propres-à-la-déclinaison)

### Partie II — Le produit FortiOS

7. [Anatomie d'un FortiGate](#7-anatomie-dun-fortigate)
8. [Le cycle de vie d'un paquet](#8-le-cycle-de-vie-dun-paquet)
9. [Modes d'inspection et modes NGFW](#9-modes-dinspection-et-modes-ngfw)
10. [Les VDOM](#10-les-vdom)
11. [Modes de déploiement](#11-modes-de-déploiement)

### Partie III — La grammaire CLI

12. [L'arbre de configuration](#12-larbre-de-configuration)
13. [Les sous-commandes](#13-les-sous-commandes)
14. [Le schéma déclaratif](#14-le-schéma-déclaratif)
15. [`show`, `get`, `show full-configuration`](#15-show-get-show-full-configuration)
16. [Complétion, aide, abréviations](#16-complétion-aide-abréviations)
17. [Le catalogue de messages](#17-le-catalogue-de-messages)

### Partie IV — L'arbre de configuration, chemin par chemin

18. [`config system` — la machine](#18-config-system--la-machine)
19. [`config firewall` — objets](#19-config-firewall--objets)
20. [`config firewall policy` — la politique](#20-config-firewall-policy--la-politique)
21. [`config firewall` — NAT](#21-config-firewall--nat)
22. [`config router` — routage](#22-config-router--routage)
23. [`config user` et authentification](#23-config-user-et-authentification)
24. [`config vpn` — IPsec et SSL-VPN](#24-config-vpn--ipsec-et-ssl-vpn)
25. [Les profils de sécurité (UTM)](#25-les-profils-de-sécurité-utm)
26. [`config log` — journalisation](#26-config-log--journalisation)
27. [`config system ha` — haute disponibilité](#27-config-system-ha--haute-disponibilité)
28. [SD-WAN](#28-sd-wan)
29. [Les commandes `execute`](#29-les-commandes-execute)
30. [Les commandes `diagnose` et `get`](#30-les-commandes-diagnose-et-get)

### Partie V — Réalisation

31. [Architecture cible du répertoire](#31-architecture-cible-du-répertoire)
32. [Ce qui se branche sur le socle, et comment](#32-ce-qui-se-branche-sur-le-socle-et-comment)
33. [Le modèle de données](#33-le-modèle-de-données)
34. [Persistance et sérialisation de topologie](#34-persistance-et-sérialisation-de-topologie)
35. [Interface graphique](#35-interface-graphique)

### Partie VI — Exigences

36. [Exigences fonctionnelles](#36-exigences-fonctionnelles)
37. [Exigences non fonctionnelles](#37-exigences-non-fonctionnelles)
38. [Matrice exigences → laboratoires](#38-matrice-exigences--laboratoires)

### Partie VII — Livraison

39. [Découpage en phases](#39-découpage-en-phases)
40. [Stratégie de test](#40-stratégie-de-test)
41. [Critères d'acceptation](#41-critères-dacceptation)
42. [Risques et arbitrages](#42-risques-et-arbitrages)
43. [Hors périmètre — écrit une seconde fois](#43-hors-périmètre--écrit-une-seconde-fois)
44. [Annexes](#44-annexes)

---

# Partie I — Cadrage

---

## 1. Pourquoi un BRD dédié à FortiGate

### 1.1 Le constat de départ, mesuré

`docs/BRD-Firewall.md` §28 consacre 290 lignes à FortiOS. C'était la
bonne granularité pour un document dont le sujet est le **socle** : il
fallait y montrer que le contrat de déclinaison tenait face à un
constructeur qui diverge, pas décrire Fortinet.

La mesure faite au moment d'écrire le présent document dit ceci :

| Objet | État | Fichier |
|---|---|---|
| `FortiGate extends Firewall` | ✅ livré, 59 lignes | `vendors/fortios/FortiGate.ts` |
| `FORTIOS_PROFILE` | ✅ livré, 77 lignes | `vendors/fortios/FortiProfile.ts` |
| `FortiShell` | ✅ livré, 269 lignes | `vendors/fortios/FortiShell.ts` |
| `FortiTerminalSession` | ✅ livré, 54 lignes | `terminal/sessions/FortiTerminalSession.ts` |
| Suite de tests | ✅ 32 cas verts | `firewall/fortios-profile.test.ts` |
| `firewall-fortinet` → `FortiGate` | ✅ recâblé | `DeviceFactory.ts` |

Et ceci, qui est le sujet du présent document :

| Chemin de configuration FortiOS | Reconnu par `FortiShell` |
|---|---|
| `config firewall policy` | ✅ |
| `config firewall address` | ✅ |
| `config system interface` | ❌ |
| `config system zone` | ❌ |
| `config firewall addrgrp` | ❌ |
| `config firewall service custom` | ❌ |
| `config firewall schedule recurring` | ❌ |
| `config firewall vip` | ❌ |
| `config firewall ippool` | ❌ |
| `config firewall central-snat-map` | ❌ |
| `config firewall local-in-policy` | ❌ |
| `config router static` | ❌ |
| `config system dhcp server` | ❌ |
| `config system admin` | ❌ |
| `config system global` | ❌ |
| `config vdom` / `config global` | ❌ |
| `config log …` | ❌ |
| `config vpn ipsec phase1-interface` | ❌ |
| Les 13 profils UTM | ❌ |

Deux tables sur une centaine. **La base est une preuve de contrat, pas
un FortiGate.** Elle a été écrite pour démontrer que le socle absorbait
un second constructeur — ce qu'elle démontre, et le carnet
`JOURNAL-FIREWALL.md` l'enregistre comme « phase 5, deuxième
déclinaison ». Elle n'a jamais prétendu être davantage.

### 1.2 Ce qui manque n'est pas « des commandes en plus »

Il serait faux de lire le tableau ci-dessus comme une liste de courses.
Trois manques sont **structurels**, et ils décident de l'architecture :

**(a) `FortiShell` code ses deux tables en dur.** `POLICY_ATTRIBUTES` et
`ADDRESS_ATTRIBUTES` sont deux `Set<string>` littéraux ; `commitPolicy`
et `commitAddress` sont deux fonctions écrites à la main. À ce rythme,
cent tables font cent `Set` et cent fonctions de validation, et le
premier attribut oublié devient un `Command fail` inexplicable. La
grammaire FortiOS est **régulière** — c'est sa grande qualité — donc
elle doit être portée par un **schéma déclaratif**, pas par du code par
table. C'est déjà l'orientation retenue par le socle (§28.3 du
BRD-Firewall) ; ce document la spécifie.

**(b) `show` n'existe qu'en apparence.** `showPolicies()` réimprime la
carte d'attributs saisis. Cela ressemble à FortiOS parce que FortiOS
rend effectivement ce qui a été modifié — mais c'est une coïncidence de
surface : sans notion de **valeur par défaut**, `show` et
`show full-configuration` ne peuvent pas différer, et `get` non plus.
Or la distinction `show` (ce qui diffère du défaut) / `get` (tout) est
la première chose qu'un opérateur FortiGate utilise, tous les jours.

**(c) Il n'y a pas de VDOM.** `get system status` répond
`Current virtual domain: root` — une chaîne littérale. Le profil
déclare `virtualizationName: 'vdom'`, et personne ne lit ce champ.
C'est exactement la forme de défaut que ce dépôt referme partout :
**une valeur affichée que rien ne mesure**.

### 1.3 Pourquoi FortiGate mérite le document le plus détaillé

Trois raisons, dans l'ordre de leur poids.

**Part de marché et pédagogie.** FortiGate est le pare-feu que la
majorité des apprenants rencontrent en entreprise et en centre de
formation. Un simulateur réseau qui ne sait pas le faire manque sa
cible principale.

**FortiOS est le plus *simulable* des quatre.** Sa grammaire est
régulière, donc mécanisable ; son modèle de politique est une séquence
pure terminée par un refus implicite, donc démontrable ; son NAT est un
champ de la règle, donc lisible d'un coup d'œil. Là où PAN-OS exige un
modèle de configuration candidate (commit/validate/rollback) et Junos
une grammaire hiérarchique à part, FortiOS demande **un schéma et une
machine à états**.

**C'est le meilleur banc d'essai du socle.** Le BRD générique a été
écrit en isolant des axes de variation ; FortiOS diverge de l'ASA sur
presque tous. Si le socle tient pour FortiGate à l'échelle complète —
pas seulement sur deux tables — alors PAN-OS et Junos sont des
déclinaisons, pas des réécritures.

### 1.4 Ce que ce document n'est pas

- **Ce n'est pas une réécriture du socle.** Sessions, politique, NAT,
  pipeline, objets, zones, ARP, routage, journalisation : tout cela est
  spécifié par `BRD-Firewall.md` et **implémenté**. Ici on branche.
- **Ce n'est pas un manuel FortiOS.** Les extraits de configuration
  servent à fixer la syntaxe attendue, pas à enseigner Fortinet.
- **Ce n'est pas un engagement d'exhaustivité fonctionnelle.** FortiOS
  7.4 expose plusieurs milliers d'attributs. §43 dit lesquels sont hors
  périmètre, et §17 dit comment un attribut hors périmètre est refusé
  — **en nommant ce qui manque**, jamais en silence.

---

## 2. Objectifs, non-objectifs, critère d'arbitrage

### 2.1 Objectifs métier

| # | Objectif | Mesure |
|---|---|---|
| **OM-1** | Un apprenant monte un FortiGate de bout en bout : interfaces, objets, politique, NAT, route par défaut, et le trafic passe | Laboratoire L1 vert |
| **OM-2** | Il constate qu'**aucun** trafic ne passe sans politique, y compris de l'interne vers l'externe | Cas « sans règle » de la suite actuelle, déjà vert |
| **OM-3** | Il publie un serveur par VIP et vérifie que la politique vise la VIP, pas l'adresse interne | Laboratoire L2 |
| **OM-4** | Il diagnostique un blocage avec `diagnose debug flow` et lit **la même trace** que celle que le paquet a réellement suivie | Laboratoire L5 |
| **OM-5** | Il segmente en VDOM et vérifie l'étanchéité | Laboratoire L7 |
| **OM-6** | Il compare FortiGate et ASA sur le **même** laboratoire et nomme les trois différences structurantes | Laboratoire L9 |
| **OM-7** | Il sauvegarde, recharge la topologie, et retrouve sa configuration à l'identique | Exigence FGT-PER-1 |

### 2.2 Objectifs techniques

| # | Objectif |
|---|---|
| **OT-1** | Zéro moteur dans `vendors/fortios/` — garde-fou G1 mécanique |
| **OT-2** | La grammaire est portée par un schéma déclaratif, pas par du code par table |
| **OT-3** | `show` / `get` / `show full-configuration` sont **trois rendus d'un seul schéma** |
| **OT-4** | La complétion, l'aide `?` et la validation dérivent du même schéma |
| **OT-5** | Toute divergence FortiOS se ramène soit à un champ de `FortiProfile`, soit à un point d'extension déclaré du socle |
| **OT-6** | `diagnose debug flow` lit `ctx.trace`, comme `packet-tracer` (ASA) — une mesure, deux rendus |
| **OT-7** | La configuration rendue est **rejouable** : `show` produit un texte que la CLI ré-accepte tel quel |

### 2.3 Non-objectifs explicites

| # | Non-objectif | Motif |
|---|---|---|
| **NO-1** | Reproduire l'interface graphique FortiGate | Le simulateur a sa propre UI ; la CLI est le sujet |
| **NO-2** | Simuler l'accélération matérielle (NP6/NP7, `auto-asic-offload`) | Aucune notion de matériel réseau ; l'accepter et l'ignorer serait un décor |
| **NO-3** | Détection antivirus/IPS réelle | Impossible sans moteur de signatures ; seul EICAR est honnête (§25) |
| **NO-4** | FortiGuard (catégories d'URL en ligne, licences) | Aucun service externe ; catalogue local restreint (§25) |
| **NO-5** | FortiManager / FortiAnalyzer | Autres produits |
| **NO-6** | Mise à jour de firmware | Aucun modèle d'image |

### 2.4 Le critère d'arbitrage permanent

Repris du socle, et il tranche tous les cas de ce document :

> **Est-ce qu'un apprenant peut le VOIR ?**
>
> Si un comportement est observable par une commande, une trace, un
> journal ou un paquet sur le fil, il est dans le périmètre. Si sa seule
> manifestation est une ligne de configuration qui ne change rien, il
> est **refusé** — pas « accepté sans effet ».

---

## 3. Inventaire de l'existant — mesuré

Cet inventaire a été fait en lisant les fichiers, pas de mémoire. Il est
la partie de ce document qui périme le plus vite : le carnet
`JOURNAL-FIREWALL.md` fait foi en cas d'écart.

### 3.1 Le socle pare-feu — livré et réutilisable tel quel

| Brique | Fichier | Lignes | Ce qu'elle donne à FortiOS |
|---|---|---|---|
| `Firewall` (façade équipement) | `firewall/Firewall.ts` | 380 | Ports, ARP, L3, pipeline, journalisation, `simulate()` |
| `FirewallProfile` | `firewall/FirewallProfile.ts` | 122 | Le contrat de déclinaison |
| `FirewallPipeline` | `pipeline/FirewallPipeline.ts` | 83 | Chaîne d'étapes nommées, ordre **donné par le profil** |
| `PacketContext` | `pipeline/PacketContext.ts` | 105 | Le contexte + `trace[]` |
| `coreStages` | `pipeline/stages/coreStages.ts` | 425 | Les 9 étapes du pipeline |
| `SimulatedPacket` / `Simulation` | `pipeline/` | 206 | Le socle de `debug flow` |
| `SessionTable` | `session/SessionTable.ts` | 284 | Sessions, index bidirectionnel, pinholes, expiration |
| `TcpStateMachine` | `session/TcpStateMachine.ts` | 163 | États TCP observés, `syn-check` |
| `FlowKey` | `session/FlowKey.ts` | 93 | Clé de flux + inversion |
| `PolicyStore` | `model/PolicyStore.ts` | 219 | Règles ordonnées, `move`, `clone`, compteurs |
| `PolicyEvaluator` | `policy/PolicyEvaluator.ts` | 164 | Évaluation séquentielle + règle implicite |
| `SecurityRule` | `model/SecurityRule.ts` | 124 | Le modèle de règle, **`natEnabled` compris** |
| `ObjectStore` | `model/ObjectStore.ts` | 342 | Adresses, services, groupes (Composite) |
| `AddressObject` | `model/AddressObject.ts` | 174 | host/subnet/range/fqdn/wildcard/geo/dynamic |
| `ServiceObject` | `model/ServiceObject.ts` | 133 | tcp/udp/sctp/icmp/icmp6/ip, plages de ports |
| `ZoneTable` | `model/ZoneTable.ts` | 152 | Zones, appartenance d'interface, intra-zone |
| `NatPolicyStore` | `nat/NatPolicyStore.ts` | 126 | Règles NAT ordonnées, sections |
| `FirewallNatEngine` | `nat/FirewallNatEngine.ts` | 305 | SNAT/DNAT, pools, réapplication sur session |
| `InterfaceTable` | `l3/InterfaceTable.ts` | 125 | Adresses, état, routes connectées |
| `RouteTable` | `l3/RouteTable.ts` | 175 | Statiques + connectées, plus long préfixe |
| `ArpService` | `l3/ArpService.ts` | 198 | Cache ARP, requête/réponse réelles |
| `SyslogCatalog` | `logging/SyslogCatalog.ts` | 48 | Correspondance événement → identifiant/sévérité |

**Ce que cela veut dire concrètement** : les chapitres 8, 10, 11, 12, 13,
19 et 23 du BRD générique sont **faits**. Le présent document n'en
réécrit rien ; il dit quels champs du profil FortiOS les paramètrent et
quels points d'extension il faut ouvrir.

### 3.2 La déclinaison FortiOS — ce qui est livré

#### `FORTIOS_PROFILE` (77 lignes)

Le profil est complet au sens du contrat. Ses valeurs, telles que
mesurées dans le fichier :

```
vendor:               'fortios'
displayName:          'Fortinet FortiGate'
osName:               'fortios'
defaultVersion:       '7.4.4'

pipeline: [ingress-zone, session-lookup, tcp-state-check, nat-destination,
           route-lookup, egress-zone, policy-lookup, nat-source, session-install]

natOrder:
  destinationNatBeforePolicy:   true
  sourceNatBeforePolicy:        false
  policySeesPreNatSource:       true
  policySeesPreNatDestination:  false      ← À CORRIGER, voir §21.4
  policySeesPostNatZone:        true

applicationShift:     false                ← À CORRIGER en mode policy-based
selfTrafficHandling:  'local-in-policy'

policyKeyedBy:        'interface'
implicitPolicy:       'deny-all'
implicitRuleEditable: false
supportedActions:     ['allow', 'deny']    ← 'ipsec' manque
supportsNegation:     true
natIsPolicyField:     true

zoneModel:            'both'
defaultIntraZoneAction: 'deny'
zoneTypes:            ['layer3', 'layer2']

objectsMandatoryInPolicy: true
maxGroupNesting:      10

timeouts: tcpEstablished 3600, tcpHandshake 30, tcpTimeWait 120,
          udp 180, icmp 60, other 180
tcpSynCheckDefault:   true

deploymentScope:      'device'
configurationModel:   'immediate'
virtualizationName:   'vdom'

portPrefix:           'port'   portCount: 8   portFirstIndex: 1

syslogCatalog: session-built 0000000013, session-torn-down 0000000014,
               policy-deny 0000000015

unimplemented: ['config vpn ipsec', 'diagnose debug flow', 'execute backup']
```

**Deux écarts relevés à la lecture, et traités dans ce document.**

1. `policySeesPreNatDestination: false` contredit §28.2 du BRD générique,
   qui écrit `true` et fonde là-dessus le laboratoire L2 (« la politique
   vise la VIP »). La valeur du code est correcte tant qu'il n'y a pas de
   VIP — rien ne la lit — mais elle deviendra fausse à la minute où
   `config firewall vip` existera. **Traité en §21.4 : c'est `true`.**
2. `supportedActions` omet `ipsec`, qui est une action réelle de
   `config firewall policy` (politique de tunnel en mode « policy-based
   VPN »). **Traité en §20.3.**

Ces deux points sont écrits ici plutôt que corrigés en silence, parce
qu'un BRD qui diverge du code sans le dire est un piège pour le
lecteur suivant.

#### `FortiGate` (59 lignes)

Étend `Firewall`, injecte `FORTIOS_PROFILE`, expose `getShell()`,
`executeCommand()`, `getPrompt()`, `getBootSequence()`, `cliHelp()`,
`cliTabCandidates()`, `cliTabComplete()`, `getOSType() === 'fortios'`.

Rien à redire : c'est exactement la surface qu'attend
`sessionFactory` / `CLITerminalSession`.

#### `FortiShell` (269 lignes)

Machine à états à trois niveaux (racine → table → objet), déjà correcte
dans sa forme :

| Commande | État |
|---|---|
| `config firewall {policy,address}` | ✅ |
| `edit <clé>`, `edit 0` (identifiant libre) | ✅ |
| `set <attr> <valeurs…>` | ✅ (deux listes blanches en dur) |
| `unset <attr>` | ✅ |
| `next`, `end` | ✅ |
| `delete <clé>` | ✅ |
| `show firewall {policy,address}` | ✅ (rend ce qui a été saisi) |
| `get system status` | ✅ (4 lignes en dur) |
| `diagnose sys session list` | ✅ (lit la vraie table) |
| `diagnose sys session stat` | ✅ |
| `?` → vocabulaire contextuel | ✅ |
| `abort`, `purge`, `clone`, `rename`, `move`, `append`, `select` | ❌ |
| Sous-tables (`config` imbriqué) | ❌ |
| Valeurs par défaut | ❌ |

L'invite est exacte : `FGT1 # `, `FGT1 (policy) # `, `FGT1 (1) # `.

Le message d'échec unique est `Command fail. Return code -61`, qui est
bien un message FortiOS réel — mais **un seul message pour toutes les
erreurs**, ce que §17 corrige.

#### `FortiTerminalSession` (54 lignes)

Thème rouge/sombre, invite `<hostname> # `, `Ctrl-Z` → `end`, pager
`--More--`, dialecte telnet BSD, barre d'information. Correct.

### 3.3 Ce que le reste du simulateur apporte

C'est le point qui décide de plusieurs arbitrages : un FortiGate n'a
presque aucun protocole à écrire, parce que le dépôt les a déjà.

| Besoin FortiOS | Ce qui existe | Verdict |
|---|---|---|
| DHCP serveur | `dhcp/` complet, serveur réel | Réutiliser |
| DNS (client et serveur) | `dns/`, `RouterDnsService` | Réutiliser |
| NTP | `ntp/NtpAgent`, associations réelles | Réutiliser |
| SNMP v1/v2c/v3, traps | `snmp/SnmpAgent` | Réutiliser |
| Syslog UDP/TCP, deux collecteurs | `syslog/SyslogAgent`, `LoggingConfig` | Réutiliser |
| RADIUS (auth, acct, CoA) | `radius/` complet | Réutiliser |
| TACACS+ | `tacacs/`, chiffrement réel | Réutiliser |
| LDAP | ❌ absent | À écrire ou refuser (§23.4) |
| IPsec IKEv1/IKEv2, ESP | `ipsec/`, tunnels réels | Réutiliser |
| TLS 1.2/1.3 réel (AES-GCM, X25519, P-256, RSA) | `tls/`, `crypto/` | Réutiliser (SSL-VPN, HTTPS admin) |
| SSH serveur | `protocols/ssh/` | Réutiliser (accès admin) |
| HTTP/1.1 client et serveur | `http/`, `Http1ServerSession` | Réutiliser (admin GUI, webfilter) |
| PKI, certificats auto-signés, vérification | `pki/`, `CertificateVerifier` | Réutiliser |
| Routage statique | `RouteTable` (socle pare-feu) | Réutiliser |
| OSPF / BGP / RIP | `ospf/`, `bgp/`, `rip/` — moteurs réels, **couplés à `Router`** | Voir §22.5 |
| VRRP / HSRP | `vrrp/`, `hsrp/` | Piste pour HA (§27) |
| TCP réel (handshake, états, fenêtre) | `tcp/TcpStack` | Réutiliser |
| Capture de paquets | Bus d'événements + `Logger` | Réutiliser (`diagnose sniffer`) |
| Ordonnanceur virtuel | `events/Scheduler` | Réutiliser (expiration, HA, SD-WAN) |
| Tableaux CLI alignés | `shells/cli/TextTable.ts` | **Obligatoire** pour toute sortie tabulaire |

### 3.4 Synthèse honnête

Sur les 44 chapitres du BRD générique, **le socle en couvre 21 à
l'état livré**. Ce que FortiGate demande en propre se réduit à :

1. une **grammaire** (schéma + machine à états + rendus) ;
2. un **catalogue de chemins de configuration** avec leurs attributs ;
3. quatre **mécanismes** que le socle n'a pas encore : VDOM, VIP comme
   objet, `local-in-policy`, et le mode d'inspection ;
4. un **catalogue de messages** ;
5. des **rendus de diagnostic** (`debug flow`, `session list`, `iprope`).

C'est un travail important mais borné, et surtout **il ne demande aucun
moteur nouveau**. C'est le résultat que le socle avait pour but de
produire.

---

## 4. Ce que FortiOS a d'irréductible

Sept spécificités. Chacune est nommée `FGT-S<n>`, et le tableau final de
§32 dit par quel mécanisme elle est absorbée.

### FGT-S1 — Le NAT est un champ de la politique

```
config firewall policy
    edit 1
        set nat enable
    next
end
```

Sur un ASA, le NAT est une politique séparée avec ses propres sections
et son propre ordre d'évaluation. Sur FortiOS, `set nat enable` sur la
règle fait du PAT vers l'adresse de l'interface de sortie. C'est **la**
chose qui surprend en passant de l'un à l'autre, et c'est déjà porté par
`natIsPolicyField` (profil) + `SecurityRule.natEnabled` (socle) +
`applyPolicyNat()` (`coreStages.ts`). **Livré et vert.**

Le pool alternatif se déclare par `set ippool enable` + `set poolname`,
ce qui reste un champ de la règle — donc la même mécanique, avec une
référence à un objet pool. **À ajouter (§21.3).**

### FGT-S2 — Les objets sont obligatoires

On n'écrit pas une adresse littérale dans une politique FortiOS. Il faut
un objet `firewall address`, même pour une adresse unique. `all` est
l'objet prédéfini qui couvre tout.

C'est porté par `objectsMandatoryInPolicy` et par `ObjectStore`. La
conséquence pédagogique est réelle : **le premier laboratoire FortiGate
commence par créer des objets**, ce qui n'est pas le cas sur ASA ni sur
un routeur. Un apprenant qui l'ignore obtient un `Command fail` sur
`set srcaddr 192.168.1.0`, et le message doit le dire (§17).

### FGT-S3 — La grammaire `config` / `edit` / `set` / `next` / `end`

Ce n'est pas un arbre de commandes à mots-clés comme IOS ou VRP. C'est
un **arbre de configuration navigable**, avec un langage uniforme de
mutation. Conséquences directes :

- l'invite **indique où l'on est** (`FGT1 (policy) #`, `FGT1 (1) #`) ;
- `?` liste les attributs du **nœud courant** ;
- il n'y a pas de « mode de configuration » global à la IOS : on est
  toujours quelque part dans l'arbre ;
- `end` valide, `abort` annule — donc il existe une notion de
  **transaction par objet**, même si le modèle de configuration est
  immédiat au sens du profil.

### FGT-S4 — `show` montre le modifié, `get` montre tout

C'est la spécificité la plus visible à l'usage et la plus facile à rater
à l'implémentation. Elle **exige** que le schéma porte les valeurs par
défaut, sans quoi les deux commandes ne peuvent pas différer.

### FGT-S5 — La VIP est à la fois un objet et une règle NAT

```
config firewall vip
    edit "VIP_WEB"
        set extip 203.0.113.10
        set mappedip 192.168.50.10
    next
end

config firewall policy
    edit 2
        set dstaddr "VIP_WEB"      ← la VIP est la DESTINATION
    next
end
```

C'est la seule spécificité qui touche un mécanisme du socle. Elle est
traitée en §21.4 par une extension du **modèle d'objets** (un
`AddressObject` de type `vip` portant une référence de règle NAT), pas
par un moteur.

### FGT-S6 — `firewall-session-dirty`

Quand la politique change, que deviennent les sessions déjà installées ?
FortiOS le règle explicitement :

```
config system global
    set firewall-session-dirty {check-all | check-new | check-policy-option}
end
```

- `check-all` (défaut) : toutes les sessions sont réévaluées ;
- `check-new` : seules les nouvelles sessions voient la nouvelle
  politique — les anciennes continuent ;
- `check-policy-option` : par politique.

Le socle porte le principe P9 (« une modification de politique n'affecte
pas les sessions installées »), qui correspond à `check-new`. FortiOS
demande donc un **champ de comportement**, pas un moteur.

### FGT-S7 — Les VDOM

Un FortiGate multi-VDOM est plusieurs pare-feux logiques. §10 y est
consacré. Le point à ne pas rater — le BRD générique §22.2 le nomme
« le piège à éviter absolument » — est de ne **pas** instancier N
`Firewall` : c'est une seule machine, des tables séparées et un plan de
gestion commun.

---

## 5. Personas, laboratoires, cas d'usage

### 5.1 Personas

| Persona | Ce qu'il vient chercher |
|---|---|
| **Étudiant NSE 4** | La séquence canonique : interface → objet → politique → NAT → route, et la certitude que rien ne passe sans règle |
| **Administrateur en reconversion** | La correspondance ASA ↔ FortiGate : « où est passé mon `access-list` ? » |
| **Formateur** | Des laboratoires reproductibles, dont **des pannes** : règle trop haute, objet manquant, route absente, VIP sans politique |
| **Auditeur** | `show full-configuration`, `diagnose sys session list`, journaux — la preuve de ce que la machine fait |

### 5.2 Les laboratoires cibles

Chacun est une **livraison** : il n'est vert que quand la chaîne complète
fonctionne sur le fil, et il sert de critère d'acceptation à §41.

| # | Laboratoire | Ce qu'il démontre | Phase |
|---|---|---|---|
| **L1** | LAN → Internet | Interfaces, objets, politique, `set nat enable`, route par défaut | 1 |
| **L2** | Publication par VIP | DNAT avant routage, politique visant la VIP | 3 |
| **L3** | DMZ à trois zones | Zones, politique inter-zones, refus implicite | 2 |
| **L4** | Ordre des règles | Une règle large placée trop haut masque une règle fine ; `move` corrige | 2 |
| **L5** | Diagnostic d'un blocage | `diagnose debug flow` désigne la règle fautive | 4 |
| **L6** | Journalisation | `set logtraffic all`, syslog vers un collecteur réel | 4 |
| **L7** | Deux VDOM étanches | Segmentation, `config vdom`, pas de fuite | 5 |
| **L8** | Tunnel IPsec site à site | `phase1-interface`/`phase2-interface`, politique sur l'interface tunnel | 6 |
| **L9** | FortiGate vs ASA | La même topologie, deux constructeurs, trois différences nommées | 5 |
| **L10** | Panne pédagogique | Objet absent, route absente, VIP sans politique, `status disable` | 2 |
| **L11** | Central NAT | `central-snat-map` + `ippool`, et la bascule de mode | 3 |
| **L12** | `local-in-policy` | Fermer l'accès administratif depuis le WAN | 3 |

### 5.3 Le cas d'usage fondateur, en détail

C'est L1, écrit ici en entier parce qu'il fixe le vocabulaire du reste
du document.

**Topologie.** `LAN (192.168.1.0/24)` — `port1` FGT `port2` —
`WAN (203.0.113.0/24)` — `Internet`.

**Séquence de l'apprenant.**

```
config system interface
    edit "port1"
        set alias "LAN"
        set role lan
        set mode static
        set ip 192.168.1.1 255.255.255.0
        set allowaccess ping https ssh
    next
    edit "port2"
        set alias "WAN"
        set role wan
        set mode static
        set ip 203.0.113.1 255.255.255.0
        set allowaccess ping
    next
end

config router static
    edit 1
        set dst 0.0.0.0 0.0.0.0
        set gateway 203.0.113.254
        set device "port2"
    next
end

config firewall address
    edit "LAN_SUBNET"
        set subnet 192.168.1.0 255.255.255.0
    next
end

config firewall policy
    edit 1
        set name "LAN-vers-Internet"
        set srcintf "port1"
        set dstintf "port2"
        set srcaddr "LAN_SUBNET"
        set dstaddr "all"
        set action accept
        set schedule "always"
        set service "ALL"
        set nat enable
        set logtraffic all
    next
end
```

**Ce que l'apprenant doit pouvoir observer ensuite.**

| Observation | Commande |
|---|---|
| Le poste LAN atteint Internet | `ping` depuis le poste |
| Sa source est traduite | `diagnose sys session list` montre `hook=post dir=org act=snat` |
| La règle 1 compte les coups | `get firewall policy` / `diagnose firewall iprope list` |
| Le journal enregistre la session | `execute log display` |
| Sans `set nat enable`, plus rien | Le témoin — indispensable |
| Sans la route, plus rien | Le second témoin |

**Le témoin est aussi important que le cas nominal.** Un laboratoire qui
ne montre que le succès n'enseigne pas : c'est la règle P10 du socle
(« l'échec est aussi enseignable que le succès »), et la suite de tests
actuelle la respecte déjà (`sans lui, la source n'est pas traduite — le
temoin`).

---

## 6. Principes directeurs propres à la déclinaison

Les douze principes du socle (P1 à P12) s'appliquent. Cinq de plus, qui
ne valent que pour FortiOS.

### F1 — Le schéma est la spécification

Aucun attribut n'existe en dehors du schéma. Un attribut ajouté au
schéma est automatiquement : accepté par `set`, validé en type, proposé
par `?` et par la complétion, rendu par `get`, rendu par `show` s'il
diffère du défaut, et sérialisé. Un attribut absent du schéma est refusé.

**Corollaire** : il est interdit d'écrire un `if (attribut === '…')`
dans un gestionnaire de table. Si un attribut demande un comportement,
c'est le schéma qui porte ce comportement, sous forme de champ.

### F2 — Le défaut est une donnée, pas une absence

`show` ne peut distinguer le modifié du non-modifié que si le défaut est
**écrit**. Le schéma porte donc `defaultValue` pour tout attribut qui en
a un sur une vraie machine. Un attribut sans défaut connu est déclaré
sans défaut, et il est alors rendu par `show` dès qu'il est posé.

### F3 — La table est ordonnée ou elle ne l'est pas, et ça se voit

`config firewall policy` est une table **ordonnée** : `move 5 before 2` y
a un sens, l'ordre décide du résultat, et `edit 3` désigne un objet
stable qui n'est pas le troisième. `config firewall address` est une
table **non ordonnée** : `move` y est refusé. Le schéma porte
`ordered: boolean`, et `move` consulte ce champ plutôt qu'une liste
codée en dur.

### F4 — Une référence est vérifiée à la validation, pas à la saisie

```
config firewall policy
    edit 1
        set srcaddr "OBJET_INEXISTANT"
```

FortiOS refuse ici, immédiatement, parce que `srcaddr` est une référence
vers `firewall.address`. Le schéma porte `referenceTo`, et la validation
consulte le magasin correspondant. **Mais** le refus intervient au `set`,
pas au `end` : c'est ce que fait la vraie machine, et c'est plus
pédagogique — l'erreur est à côté de la faute.

Exception mesurée et assumée : les références **avant** dans un fichier
de configuration rejoué (`config firewall policy` peut précéder
`config firewall address` dans un `show full-configuration` ?). Non :
FortiOS ordonne son propre rendu de sorte que les objets précèdent leurs
référents. Le sérialiseur doit donc respecter un **ordre de rendu**
(§34.3), et il n'y a pas de référence avant à autoriser.

### F5 — Le refus nomme ce qui manque

FortiOS répond `Command fail. Return code -61` à peu près à tout, ce qui
est fidèle mais inexploitable pédagogiquement. Le simulateur fait les
deux : **la ligne FortiOS d'abord**, puis une ligne de diagnostic
préfixée qui ne peut pas être confondue avec une sortie du produit.

```
Command fail. Return code -61
NOTE: attribut « zorglub » inconnu pour la table « firewall policy ».
```

C'est exactement le compromis déjà retenu pour Apache (`apacheWarnings()`
et son préfixe `NOTE:`), dont `CLAUDE.md` dit qu'il remplace un silence
que le vrai produit laisse et qu'un apprenant n'a aucun moyen de
diagnostiquer seul. La ligne `NOTE:` est **supprimable** par
`config system global / set simulator-hints disable` pour un laboratoire
d'examen.

### F6 — Un attribut non simulé est refusé, et il dit pourquoi

C'est P4 du socle, appliqué à un produit qui a des milliers d'attributs.
Trois familles, comme pour `curl` et `openssl` :

| Famille | Réponse |
|---|---|
| Implémenté | La commande agit |
| Connu de FortiOS, non simulé ici | `Command fail. Return code -61` + `NOTE: « auto-asic-offload » est une commande FortiOS réelle, non simulée ici (aucun modèle d'accélération matérielle).` |
| Inexistant | `Command fail. Return code -61` + `NOTE: attribut « zorglub » inconnu…` |

Le message intermédiaire n'est **pas** un message FortiOS, et c'est
délibéré : aucun vrai FortiGate n'est dans cette situation.

---

# Partie II — Le produit FortiOS

---

## 7. Anatomie d'un FortiGate

### 7.1 Ce qu'est la machine

Un FortiGate est un pare-feu à états à inspection unifiée. Ce qui le
distingue architecturalement, du point de vue de la simulation :

| Trait | Conséquence pour nous |
|---|---|
| Le pare-feu **est** la machine — pas un rôle ajouté à un routeur | `Firewall` est une classe d'équipement à part, pas un `Router` avec des ACL. C'est déjà le cas. |
| Une seule table de politique, ordonnée, par VDOM | `PolicyStore` par VDOM (§10) |
| Le NAT vit dans la politique (mode par défaut) ou dans une table centrale (mode `central-nat`) | Deux modes, un champ (§21.5) |
| Les interfaces portent un **rôle** (`lan`/`wan`/`dmz`/`undefined`) qui ne change rien au traitement | Décoratif mais rendu — un apprenant le voit dans la GUI et dans `show` |
| Le plan de gestion est filtré par `allowaccess` **par interface** | Mécanisme réel à écrire (§18.2) |
| Le trafic **vers** la machine est filtré par `local-in-policy` | Mécanisme réel à écrire (§20.7) |

### 7.2 Les ports

`FORTIOS_PROFILE` déclare `portPrefix: 'port'`, `portCount: 8`,
`portFirstIndex: 1` — donc `port1` … `port8`. C'est la convention des
modèles FortiGate d'entrée et milieu de gamme (60F, 100F, 200F).

**Ce qui manque et qui compte** : un FortiGate réel a aussi des
interfaces logiques qui ne sont pas des ports physiques.

| Type | Exemple | Simulable ? |
|---|---|---|
| Physique | `port1` | ✅ existe |
| VLAN | `vlan100` sur `port1` | ✅ à écrire, `Port` sait taguer |
| Agrégat (LACP) | `agg1` | 🟡 `lacp/` existe, câblage à faire |
| Interface logicielle (switch) | `internal` | 🟡 §11.4 |
| Zone | `trust` | ✅ `ZoneTable` |
| Tunnel IPsec | `to_site_b` | ✅ à écrire (§24) |
| Bouclage | `loopback1` | ✅ `Port` sait faire une boucle (`PRD-Loopback.md`) |
| VDOM-link | `npu0_vlink0`/`npu0_vlink1` | ✅ à écrire (§10.5) |
| SSL-VPN | `ssl.root` | 🟡 §24.6 |

Note utile : `PRD-Loopback.md` a déjà résolu, pour Linux et Cisco, la
question « une interface de bouclage est un vrai port ». Le FortiGate en
hérite : `config system interface / edit "loopback1" / set type loopback`
crée un port avec les mêmes propriétés (`carrierless`, MTU non borné par
Ethernet). **Aucun travail neuf.**

### 7.3 Le plan de gestion

Quatre voies d'accès, dans l'ordre de leur valeur pédagogique :

| Voie | Port | État dans le dépôt |
|---|---|---|
| Console | — | ✅ `FortiTerminalSession` |
| SSH | 22 | `protocols/ssh/` réel — à câbler |
| HTTPS (GUI) | 443 | `tls/` + `http/` réels — à câbler (§35) |
| HTTP | 80 | idem, désactivé par défaut |
| Telnet | 23 | `protocols/telnet/` réel — à câbler, désactivé par défaut |
| SNMP | 161 | `snmp/` réel — à câbler |

`allowaccess` par interface décide lesquelles écoutent **sur cette
interface**. C'est un vrai filtre, pas un affichage : une interface WAN
sans `https` dans `allowaccess` refuse la connexion, et c'est le premier
durcissement qu'on enseigne.

### 7.4 Le stockage et la configuration

| Objet | Réalité FortiOS | Position retenue |
|---|---|---|
| Configuration courante | En mémoire, appliquée immédiatement | ✅ `configurationModel: 'immediate'` |
| Configuration sauvegardée | Écrite automatiquement à chaque `end` | ✅ pas de `write memory` à faire — et c'est une différence notable avec IOS, à souligner |
| `execute backup config` | Fichier vers TFTP/USB/FTP | §29.4 — `tftp/` existe |
| `execute restore config` | Idem + redémarrage | §29.4 |
| Révisions de configuration | `execute revision list config` | §29.5 — l'`ArchiveService` Cisco est un précédent réutilisable |

**Le fait que FortiOS sauvegarde tout seul est pédagogiquement
important** : un apprenant venant d'IOS cherche `write memory` et ne le
trouve pas. Le simulateur doit refuser `write memory` **en nommant** le
comportement réel :

```
Command fail. Return code -61
NOTE: FortiOS enregistre la configuration automatiquement à chaque `end`.
      Il n'y a pas de commande d'enregistrement à taper.
```

---

## 8. Le cycle de vie d'un paquet

### 8.1 L'ordre réel, et pourquoi il est le sujet

L'ordre des opérations est **la** donnée que ce module existe pour
enseigner. Le socle l'a modélisé comme une donnée du profil
(`pipeline: string[]`) plutôt que comme du code — principe P2 — ce qui
veut dire qu'énoncer l'ordre FortiOS correctement, ici, suffit à le
faire exister.

Voici l'ordre FortiOS pour un paquet **transitant** (ni vers ni depuis
la machine), en mode flow-based, sans accélération matérielle.

```
 1. Réception physique sur l'interface d'entrée
 2. Rattachement au VDOM d'entrée
 3. DoS policy (anomalies, seuils)                       ← §20.8
 4. Recherche de session existante
       ├─ TROUVÉE  → chemin rapide : ré-application NAT, compteurs, sortie
       └─ ABSENTE  → suite
 5. Vérification d'état TCP (SYN attendu si `syn-check`)
 6. DNAT : VIP / central DNAT                             ← AVANT le routage
 7. Recherche de route sur la destination POST-DNAT
 8. Détermination de l'interface et de la zone de sortie
 9. Recherche de politique (srcintf, dstintf, srcaddr, dstaddr,
    service, schedule, user, application)
       ├─ AUCUNE  → politique implicite 0 : refus
       └─ TROUVÉE → suite
10. Traitement UTM si `utm-status enable`                 ← §25
11. SNAT si `set nat enable` (ou central-snat-map)
12. Installation de la session
13. Émission sur l'interface de sortie
```

**Trois points sont contre-intuitifs et doivent être démontrables :**

**(a) Le DNAT précède le routage.** C'est obligatoire : sans cela, la
machine routerait vers l'adresse publique et non vers le serveur
interne. La conséquence directe est que la **route** est choisie sur
l'adresse traduite. Un apprenant qui publie un serveur et qui n'a pas de
route vers le réseau interne voit sa VIP échouer, et `debug flow`
affiche `no route` — ce qui est le vrai diagnostic.

**(b) La politique voit la destination PRÉ-NAT quand c'est une VIP.**
Ceci est la subtilité FortiOS par excellence, et l'inverse exact de
l'ASA post-8.3. Sur FortiOS, on écrit `set dstaddr "VIP_WEB"`, pas
`set dstaddr "SERVEUR_INTERNE"`. Le profil le porte par
`policySeesPreNatDestination: true` (§21.4).

**(c) Le SNAT est APRÈS la politique.** Donc la politique voit la source
d'origine (`policySeesPreNatSource: true`), et un journal de politique
montre l'adresse privée alors que le paquet sort avec l'adresse
publique. C'est une source classique de confusion, et une bonne
démonstration.

### 8.2 Le pipeline déclaré vs le pipeline réel

Le profil livré déclare neuf étapes :

```
ingress-zone, session-lookup, tcp-state-check, nat-destination,
route-lookup, egress-zone, policy-lookup, nat-source, session-install
```

Comparé à §8.1, il manque : le rattachement VDOM (2), la DoS policy (3),
et l'UTM (10). Les trois sont des **étapes à ajouter au catalogue du
socle**, pas des modifications du socle : `PipelineStageRegistry` accepte
l'enregistrement d'étapes, et `FirewallPipeline.fromStageNames()` compose
d'après le profil. C'est précisément le point d'extension prévu.

Le pipeline FortiOS cible est donc :

```
vdom-bind, dos-policy, session-lookup, tcp-state-check, nat-destination,
route-lookup, egress-zone, policy-lookup, utm-inspect, nat-source,
session-install
```

`ingress-zone` disparaît au profit de `vdom-bind`, qui fait les deux
(rattacher au VDOM **et** résoudre la zone d'entrée) — ou bien
`vdom-bind` précède `ingress-zone`. **Arbitrage retenu : deux étapes
distinctes**, `vdom-bind` puis `ingress-zone`, parce qu'une étape qui
fait deux choses est une étape qu'on ne peut pas retirer à moitié, et
qu'un FortiGate mono-VDOM doit pouvoir omettre `vdom-bind` sans perdre
la zone.

### 8.3 Le chemin rapide

Un paquet appartenant à une session existante saute les étapes 5 à 12.
C'est ce que fait déjà `sessionLookupStage` : il rend
`{ kind: 'accept' }` immédiatement, ré-applique la traduction et met à
jour les compteurs.

**Ce qu'il faut y ajouter pour FortiOS** : le comportement
`firewall-session-dirty` (FGT-S6). Trois valeurs, trois comportements :

| Valeur | Comportement | Implémentation |
|---|---|---|
| `check-all` (défaut) | À chaque changement de politique, toutes les sessions sont réévaluées ; celles qui ne correspondent plus sont **fermées** | `PolicyStore` émet un événement ; `SessionTable.clearMatching()` existe déjà |
| `check-new` | Les sessions existantes continuent | Comportement actuel — ne rien faire |
| `check-policy-option` | Par politique | Champ sur la règle |

C'est un excellent laboratoire : on ouvre une session longue, on retire
la règle, et on observe deux comportements opposés selon un seul réglage.

### 8.4 Le trafic vers la machine et depuis la machine

Trois cas, trois traitements :

| Cas | Traitement FortiOS | État |
|---|---|---|
| Vers une adresse de la machine (ping, HTTPS admin, IPsec) | `local-in-policy` puis `allowaccess` | §20.7, §18.2 — à écrire |
| Depuis la machine (requête DNS, syslog, mise à jour) | `local-out`, pas de politique par défaut | Route + interface source |
| Traversant | §8.1 | ✅ livré |

`Firewall.handleIpv4Frame()` traite déjà le cas « pour nous » : il
répond à l'écho ICMP. C'est le point où `local-in-policy` s'insère, et
c'est **exactement une étape de pipeline** — donc rien de neuf.

### 8.5 Exigences — cycle de vie

| # | Exigence |
|---|---|
| **FGT-PIP-1** | Le pipeline FortiOS comporte `vdom-bind`, `ingress-zone`, `dos-policy`, `session-lookup`, `tcp-state-check`, `nat-destination`, `route-lookup`, `egress-zone`, `policy-lookup`, `utm-inspect`, `nat-source`, `session-install`, dans cet ordre |
| **FGT-PIP-2** | Un FortiGate mono-VDOM saute `vdom-bind` sans perte de fonction |
| **FGT-PIP-3** | Le DNAT précède la recherche de route, et un test le démontre par un changement d'interface de sortie |
| **FGT-PIP-4** | La politique voit la source pré-NAT et la destination pré-NAT (VIP) |
| **FGT-PIP-5** | `firewall-session-dirty` a trois valeurs et trois comportements observables |
| **FGT-PIP-6** | Un paquet de session existante ne repasse pas par `policy-lookup`, et `ctx.trace` le montre |
| **FGT-PIP-7** | Toute étape ajoutée l'est via `PipelineStageRegistry` ; aucune modification de `FirewallPipeline` |

---

## 9. Modes d'inspection et modes NGFW

### 9.1 Les deux axes, souvent confondus

Ce sont **deux réglages orthogonaux**, et les confondre est l'erreur la
plus fréquente sur ce sujet.

| Axe | Valeurs | Ce qu'il décide |
|---|---|---|
| **Mode d'inspection** | `flow` / `proxy` | *Comment* le contenu est inspecté |
| **Mode NGFW** | `profile-based` / `policy-based` | *Où* se déclare la sécurité applicative |

### 9.2 Mode d'inspection

**Flow-based** (défaut) : les paquets sont examinés au fil de l'eau,
sans mise en tampon. Une seule session traverse la machine. Rapide,
moins de fonctions.

**Proxy-based** : la machine **termine** la connexion cliente, inspecte,
puis ouvre une seconde connexion vers le serveur. **Deux sessions
distinctes.** Plus lent, plus de fonctions (réécriture, blocage de page
avec message).

```
config firewall policy
    edit 1
        set inspection-mode proxy
    next
end
```

ou, à l'échelle du VDOM :

```
config system settings
    set inspection-mode {flow | proxy}
end
```

### 9.3 Ce qui est simulable, et ce qui ne l'est pas

C'est ici qu'il faut être franc.

| Aspect | Simulable ? | Pourquoi |
|---|---|---|
| Le **nombre de sessions** (1 en flow, 2 en proxy) | ✅ **oui, et c'est le point** | `SessionTable` est réelle ; `TcpStack` sait ouvrir une connexion. Une politique en mode proxy installe deux sessions, et `diagnose sys session list` **les montre toutes les deux**. |
| Le **retard** introduit par le proxy | ❌ | La livraison de trame est synchrone ; aucune latence n'est modélisée |
| La différence de **fonctions** disponibles | ✅ partiellement | Le schéma peut refuser un profil incompatible avec le mode |
| L'**inspection de contenu** elle-même | 🟡 | §25 : EICAR et catégories locales seulement |

**Le mode d'inspection est donc simulable là où il compte le plus** :
l'apprenant bascule un réglage, relance son trafic, et voit **deux
sessions au lieu d'une** dans la table. C'est une démonstration exacte,
mesurable, et qui explique le coût en performance du mode proxy mieux
qu'un discours.

### 9.4 Mode NGFW

**Profile-based** (défaut) : on crée des profils de sécurité
(antivirus, filtrage web, contrôle applicatif…) et on les **applique**
aux politiques.

```
config firewall policy
    edit 1
        set utm-status enable
        set av-profile "default"
        set webfilter-profile "default"
        set application-list "default"
        set ssl-ssh-profile "certificate-inspection"
    next
end
```

**Policy-based** : les applications et les catégories d'URL sont des
**critères de correspondance** de la politique elle-même.

```
config system settings
    set ngfw-mode policy-based
end

config firewall security-policy
    edit 1
        set srcintf "port1"
        set dstintf "port2"
        set srcaddr "all"
        set dstaddr "all"
        set application 15832 16072
        set action accept
    next
end
```

Notez le changement de table : `firewall security-policy` remplace
`firewall policy` pour les règles applicatives. C'est un vrai changement
de modèle, pas une option.

### 9.5 Le glissement applicatif — `applicationShift`

Le socle porte un champ `applicationShift: boolean`. Il décrit un fait
précis : **une session peut changer de règle en cours de route** quand
l'application est identifiée après coup.

Un flux TCP/443 est d'abord « HTTPS ». Après quelques paquets,
l'inspection reconnaît « Dropbox ». Si une règle plus spécifique
existait pour Dropbox, la session doit être **réévaluée**.

`FORTIOS_PROFILE` déclare `applicationShift: false`. C'est correct en
mode profile-based (le profil applicatif s'applique à la session déjà
établie, sans re-recherche de politique) et **faux en mode
policy-based** (où l'application est un critère de correspondance, donc
une re-recherche a lieu).

**Arbitrage** : `applicationShift` devient dépendant du mode NGFW du
VDOM, donc il n'est plus une constante du profil mais une propriété
calculée. Le profil déclare `applicationShiftInPolicyBasedNgfw: true`,
et l'étape `policy-lookup` interroge le VDOM.

### 9.6 Exigences — inspection

| # | Exigence |
|---|---|
| **FGT-INS-1** | `set inspection-mode {flow\|proxy}` existe sur la politique et sur `system settings` |
| **FGT-INS-2** | Une politique en mode proxy installe **deux** sessions pour un flux TCP, visibles dans `diagnose sys session list` |
| **FGT-INS-3** | `set ngfw-mode {profile-based\|policy-based}` existe sur `system settings` |
| **FGT-INS-4** | En mode `policy-based`, `config firewall policy` est refusée au profit de `config firewall security-policy`, et le refus le dit |
| **FGT-INS-5** | En mode `policy-based`, une application identifiée en cours de session provoque une re-recherche de politique, et `ctx.trace` la montre |
| **FGT-INS-6** | Le passage d'un mode à l'autre est refusé s'il existe des politiques incompatibles, comme sur la vraie machine |

---

## 10. Les VDOM

### 10.1 Ce qu'est un VDOM

Un *virtual domain* est un pare-feu logique : ses interfaces, ses
politiques, ses objets, sa table de routage, ses sessions, ses journaux.
Deux VDOM d'un même FortiGate ne se voient pas, sauf par un lien
explicite (`vdom-link`) ou par une interface partagée.

Deux VDOM existent toujours au minimum quand le multi-VDOM est actif :

| VDOM | Rôle |
|---|---|
| `root` | VDOM par défaut, existe toujours |
| `global` | **N'est pas un VDOM** : c'est la portée des réglages communs à la machine |

### 10.2 Le piège à éviter

Le BRD générique §22.2 le nomme « le piège à éviter absolument », et il
mérite d'être répété ici parce que c'est le seul endroit du module où
une erreur d'architecture coûterait une réécriture :

> **Ne pas instancier N objets `Firewall`.**

Un FortiGate multi-VDOM est **une machine** : un châssis, des ports
physiques, une pile TCP, un plan de gestion, une horloge, un ordonnanceur.
Instancier deux `Firewall` créerait deux jeux de ports, deux caches ARP,
deux piles — et il faudrait ensuite inventer un mécanisme pour les
recoller. C'est l'inverse du travail à faire.

**Le modèle retenu** : `Firewall` porte un **registre de VDOM**, chaque
VDOM portant les magasins qui lui sont propres.

| Objet | Portée |
|---|---|
| Ports physiques, MAC, câbles | Machine |
| Pile TCP, ordonnanceur, horloge | Machine |
| Cache ARP | Machine (indexé par interface, donc naturellement séparé) |
| `InterfaceTable` | **Machine**, chaque interface portant `vdom` |
| `ZoneTable` | **VDOM** |
| `ObjectStore` | **VDOM** |
| `PolicyStore` | **VDOM** |
| `NatPolicyStore` | **VDOM** |
| `RouteTable` | **VDOM** |
| `SessionTable` | **VDOM** |
| `LoggingConfig` | **VDOM** (avec des réglages globaux hérités) |
| Comptes administrateurs | Machine (`config global`) |
| Nom d'hôte, fuseau, NTP, DNS | Machine (`config global`) |

### 10.3 La conséquence architecturale

`Firewall.ts` construit aujourd'hui un exemplaire de chaque magasin dans
son constructeur, et les passe à `FirewallServices`. Le passage au
multi-VDOM demande **une indirection** :

```ts
export interface VdomContext {
  readonly name: string;
  readonly zones: ZoneTable;
  readonly objects: ObjectStore;
  readonly policy: PolicyStore;
  readonly natPolicy: NatPolicyStore;
  readonly routes: RouteTable;
  readonly sessions: SessionTable;
  readonly logging: LoggingConfig;
  readonly settings: VdomSettings;
}

export class VdomRegistry {
  get(name: string): VdomContext | undefined;
  create(name: string): VdomContext;
  remove(name: string): boolean;
  names(): readonly string[];
  vdomOfInterface(iface: string): string | undefined;
}
```

et `FirewallServices` devient **résolu par VDOM** au lieu d'être
constant. L'étape `vdom-bind` du pipeline pose `ctx.vdom`, et toutes les
étapes suivantes lisent les magasins de ce VDOM.

**C'est une modification du socle, pas de la déclinaison.** Elle doit
donc être spécifiée dans `BRD-Firewall.md` §22 et implémentée là — le
garde-fou G1 l'exige, et PAN-OS (vsys) et Junos (logical-systems) en
bénéficieront à l'identique. Le présent document la demande ; il ne la
loge pas dans `vendors/fortios/`.

**Chemin de moindre risque** : tant que le multi-VDOM n'est pas livré,
`VdomRegistry` existe avec **un seul** VDOM nommé `root`, et
`FirewallServices` le résout systématiquement. Le code mono-VDOM est
alors le cas particulier du code multi-VDOM, sans branche
conditionnelle — ce qui évite exactement le genre de dette que ce dépôt
passe son temps à rembourser.

### 10.4 Les commandes

**Activer le multi-VDOM :**

```
config system global
    set vdom-mode multi-vdom
end
```

La machine se réorganise : `config global` et `config vdom` apparaissent,
et toutes les commandes existantes migrent sous `root`.

**Créer un VDOM :**

```
config vdom
    edit "VENTES"
    next
end
```

**Basculer dans un VDOM :**

```
config vdom
    edit "VENTES"
        config firewall policy
            edit 1
                …
            next
        end
    next
end
```

**Revenir à la portée globale :**

```
config global
    config system interface
        edit "port3"
            set vdom "VENTES"
        next
    end
end
```

**Affecter une interface :** une interface appartient à **un** VDOM
(`set vdom`). Une interface affectée à un VDOM disparaît des autres —
c'est le mécanisme d'étanchéité, et il est simple à démontrer.

### 10.5 Le lien inter-VDOM

Deux VDOM communiquent par une paire d'interfaces virtuelles reliées
dos à dos :

```
config global
    config system vdom-link
        edit "lien1"
        next
    end
end

config system interface
    edit "lien10"
        set vdom "root"
        set ip 10.255.255.1 255.255.255.252
    next
    edit "lien11"
        set vdom "VENTES"
        set ip 10.255.255.2 255.255.255.252
    next
end
```

La création de `vdom-link "lien1"` crée automatiquement `lien10` et
`lien11`. Le trafic entre les deux traverse **les deux politiques** —
celle du VDOM d'origine, puis celle du VDOM de destination. C'est
excellent pédagogiquement : un paquet est refusé deux fois, à deux
endroits différents.

**Implémentation** : deux `Port` reliés par un `Cable` interne. Le
dépôt a déjà tout ce qu'il faut ; rien de neuf.

### 10.6 L'invite

L'invite change avec le contexte :

| Contexte | Invite |
|---|---|
| Racine, mono-VDOM | `FGT1 # ` |
| Racine, multi-VDOM | `FGT1 # ` |
| Dans `config global` | `FGT1 (global) # ` |
| Dans un VDOM | `FGT1 (VENTES) # ` |
| Dans une table du VDOM | `FGT1 (policy) # ` |
| Sur un objet | `FGT1 (1) # ` |

### 10.7 Exigences — VDOM

| # | Exigence |
|---|---|
| **FGT-VDM-1** | `VdomRegistry` existe au socle et contient toujours au moins `root` |
| **FGT-VDM-2** | Un FortiGate mono-VDOM se comporte exactement comme aujourd'hui, sans branche conditionnelle dans le pipeline |
| **FGT-VDM-3** | `set vdom-mode multi-vdom` fait apparaître `config global` et `config vdom` |
| **FGT-VDM-4** | Une interface appartient à un seul VDOM ; l'affecter la retire du précédent |
| **FGT-VDM-5** | Deux VDOM ne partagent ni objets, ni politique, ni routes, ni sessions — un test le mesure sur des noms identiques |
| **FGT-VDM-6** | `vdom-link` crée deux interfaces reliées, et le trafic traverse les deux politiques |
| **FGT-VDM-7** | L'invite indique le VDOM courant |
| **FGT-VDM-8** | Supprimer un VDOM portant des interfaces est refusé, en nommant les interfaces |

---

## 11. Modes de déploiement

### 11.1 Les modes FortiOS

| Mode | Commande | Ce que c'est |
|---|---|---|
| **NAT/Route** (défaut) | `set opmode nat` | Le pare-feu est un routeur : interfaces adressées, routage, NAT |
| **Transparent** | `set opmode transparent` | Le pare-feu est un pont : pas d'adresses d'interface, une seule adresse de gestion |

```
config system settings
    set opmode transparent
    set manageip 192.168.1.99 255.255.255.0
    set gateway 192.168.1.1
end
```

### 11.2 Le mode transparent, ce qu'il change

| Aspect | NAT/Route | Transparent |
|---|---|---|
| Adresses d'interface | Oui | Non |
| Routage | Oui | Non (apprentissage MAC) |
| NAT | Oui | Non |
| Politique | Oui | Oui — c'est le point |
| Adresse de gestion | Par interface | Une seule, globale |
| Visible du réseau | Oui (saut de routage) | Non |

Le mode transparent est **le plus pédagogique des deux** pour montrer
qu'un pare-feu filtre sans être un routeur : on l'insère au milieu d'un
segment existant sans rien renuméroter, et les politiques s'appliquent
quand même.

### 11.3 Ce qu'il demande au socle

Le BRD générique §14.3 le spécifie déjà. Il demande :

- une table d'apprentissage MAC (le dépôt en a une : `Switch`) ;
- des étapes de pipeline qui **sautent** `route-lookup` et `nat-*` ;
- une adresse de gestion unique.

Le pipeline transparent FortiOS est donc :

```
vdom-bind, ingress-zone, session-lookup, tcp-state-check,
mac-lookup, egress-zone, policy-lookup, session-install
```

C'est-à-dire : **le même catalogue d'étapes, un ordre différent, deux
étapes en moins et une en plus**. Exactement ce que le profil sait
exprimer. Le champ `pipeline` devient donc un **dictionnaire par mode**
plutôt qu'une liste :

```ts
pipeline: {
  'nat': [...],
  'transparent': [...],
}
```

C'est une extension du contrat `FirewallProfile`, donc du socle.

### 11.4 Les interfaces logicielles de commutation

Un FortiGate d'entrée de gamme regroupe plusieurs ports physiques en une
interface logique commutée (`internal`, `lan`) :

```
config system switch-interface
    edit "lan"
        set vdom "root"
        set member "port3" "port4" "port5"
    next
end
```

Les membres se comportent comme les ports d'un commutateur : le trafic
entre eux ne traverse pas la politique. C'est une source de confusion
classique (« pourquoi ma règle ne s'applique pas ? »), donc un bon
laboratoire.

**Implémentation** : `Switch` existe et sait faire exactement cela. Le
FortiGate délègue à une instance interne, ou bien — arbitrage retenu —
une étape `switch-bridge` en tête de pipeline qui court-circuite le
traitement pour les paires de membres d'un même `switch-interface`.

### 11.5 Exigences — déploiement

| # | Exigence |
|---|---|
| **FGT-DEP-1** | `set opmode {nat\|transparent}` existe et change le pipeline effectif |
| **FGT-DEP-2** | En mode transparent, une interface ne peut pas recevoir d'adresse, et le refus le dit |
| **FGT-DEP-3** | En mode transparent, la politique s'applique et le NAT est refusé |
| **FGT-DEP-4** | `manageip` est joignable en mode transparent |
| **FGT-DEP-5** | `switch-interface` regroupe des ports ; le trafic entre membres ne traverse pas la politique, et un test le mesure |
| **FGT-DEP-6** | Le profil déclare un pipeline **par mode de déploiement** |

---

# Partie III — La grammaire CLI

---

## 12. L'arbre de configuration

### 12.1 Le principe

FortiOS n'a pas de modes de configuration au sens IOS. Il a un **arbre**,
dont on parcourt les branches, et un langage de mutation uniforme.

```
racine
├── system
│   ├── global            (objet unique)
│   ├── settings          (objet unique, par VDOM)
│   ├── interface         (table, clé = nom)
│   ├── zone              (table, clé = nom)
│   ├── admin             (table, clé = nom)
│   ├── dns               (objet unique)
│   ├── ntp               (objet unique)
│   ├── dhcp
│   │   └── server        (table, clé = id)
│   ├── ha                (objet unique)
│   ├── sdwan             (objet unique + sous-tables)
│   ├── vdom-link         (table)
│   └── switch-interface  (table)
├── firewall
│   ├── address           (table, clé = nom)
│   ├── addrgrp           (table, clé = nom)
│   ├── service
│   │   ├── custom        (table, clé = nom)
│   │   └── group         (table, clé = nom)
│   ├── schedule
│   │   ├── recurring     (table, clé = nom)
│   │   ├── onetime       (table, clé = nom)
│   │   └── group         (table, clé = nom)
│   ├── policy            (table ORDONNÉE, clé = id numérique)
│   ├── security-policy   (table ordonnée — mode policy-based)
│   ├── local-in-policy   (table ordonnée)
│   ├── DoS-policy        (table ordonnée)
│   ├── vip               (table, clé = nom)
│   ├── vipgrp            (table, clé = nom)
│   ├── ippool            (table, clé = nom)
│   ├── central-snat-map  (table ORDONNÉE, clé = id)
│   ├── shaper
│   │   ├── traffic-shaper
│   │   └── per-ip-shaper
│   └── shaping-policy    (table ordonnée)
├── router
│   ├── static            (table, clé = id)
│   ├── policy            (table ordonnée, clé = id)
│   ├── ospf              (objet unique + sous-tables)
│   ├── bgp               (objet unique + sous-tables)
│   ├── rip               (objet unique)
│   └── access-list / prefix-list / route-map (tables)
├── user
│   ├── local             (table)
│   ├── group             (table)
│   ├── radius            (table)
│   ├── ldap              (table)
│   └── tacacs+           (table)
├── vpn
│   ├── ipsec
│   │   ├── phase1-interface  (table)
│   │   ├── phase2-interface  (table)
│   │   ├── phase1            (table — mode tunnel hérité)
│   │   └── phase2            (table)
│   ├── ssl
│   │   ├── settings          (objet unique)
│   │   └── web portal        (table)
│   └── certificate
│       ├── local             (table)
│       ├── ca                (table)
│       └── remote            (table)
├── antivirus  / webfilter / dnsfilter / application /
│   ips        / emailfilter / dlp / file-filter / ssl-ssh-profile /
│   waf        / videofilter / voip                       (profils UTM)
└── log
    ├── memory       { setting, filter }
    ├── disk         { setting, filter }
    ├── syslogd      { setting, filter, override-setting }
    ├── syslogd2/3/4 { … }
    ├── fortianalyzer{ setting, filter }
    └── setting      (objet unique)
```

### 12.2 Objet unique vs table

C'est la distinction structurante de la grammaire.

| | Objet unique | Table |
|---|---|---|
| Exemple | `config system global` | `config firewall address` |
| `edit` | ❌ interdit | ✅ obligatoire |
| `set` | Directement après `config` | Après `edit` |
| `next` | ❌ | ✅ |
| `end` | Valide et remonte | Valide et remonte |
| `delete` | ❌ | ✅ |
| `purge` | ❌ | ✅ (vide la table) |
| `get` | Liste les champs | Liste les clés |

```
config system global          ← objet unique
    set hostname "FGT-PARIS"
    set timezone 27
end

config firewall address       ← table
    edit "SRV_WEB"            ← il FAUT éditer
        set subnet 10.0.0.5 255.255.255.255
    next
end
```

Taper `set hostname` directement après `config firewall address` est une
erreur, et le message doit distinguer les deux cas.

### 12.3 Les sous-tables

Une table peut contenir une table. C'est fréquent, et c'est ce que
`FortiShell` ne sait pas encore faire.

```
config firewall vip
    edit "VIP_WEB"
        set extip 203.0.113.10
        set mappedip 192.168.50.10
        set portforward enable
        config realservers          ← sous-table
            edit 1
                set ip 192.168.50.10
                set port 8080
            next
            edit 2
                set ip 192.168.50.11
                set port 8080
            next
        end                          ← remonte à la VIP
    next                             ← remonte à la table vip
end
```

L'invite suit :

```
FGT1 # config firewall vip
FGT1 (vip) # edit "VIP_WEB"
FGT1 (VIP_WEB) # config realservers
FGT1 (realservers) # edit 1
FGT1 (1) # set ip 192.168.50.10
FGT1 (1) # next
FGT1 (realservers) # end
FGT1 (VIP_WEB) # next
FGT1 (vip) # end
FGT1 #
```

**C'est une pile**, pas trois états. `FortiShell` doit remplacer ses deux
champs `table`/`edited` par une pile de contextes.

### 12.4 Autres exemples de sous-tables courantes

| Table | Sous-table |
|---|---|
| `system interface` | `secondaryip`, `ipv6` |
| `system ha` | `secondary-vcluster` |
| `system sdwan` | `zone`, `members`, `health-check`, `service`, `neighbor` |
| `firewall policy` | (aucune) |
| `router ospf` | `area`, `network`, `neighbor`, `ospf-interface`, `redistribute` |
| `router bgp` | `neighbor`, `network`, `redistribute`, `aggregate-address` |
| `webfilter profile` | `ftgd-wf`, `web`, `override` |
| `antivirus profile` | `http`, `ftp`, `imap`, `pop3`, `smtp`, `nntp` |
| `vpn ssl settings` | `authentication-rule` |
| `user group` | `match` |

### 12.5 Exigences — arbre

| # | Exigence |
|---|---|
| **FGT-ARB-1** | Le contexte de navigation est une **pile**, de profondeur non bornée par construction |
| **FGT-ARB-2** | L'invite reflète le sommet de la pile |
| **FGT-ARB-3** | `edit` est refusé sur un objet unique, en le disant |
| **FGT-ARB-4** | `set` hors d'un objet éditable est refusé, en le disant |
| **FGT-ARB-5** | Une sous-table se déclare par `config <nom>` depuis l'objet parent et se ferme par `end` |
| **FGT-ARB-6** | `end` depuis une sous-table remonte au parent, pas à la racine |

---

## 13. Les sous-commandes

### 13.1 Le catalogue complet

Source : documentation Fortinet, section *Subcommands* du guide
d'administration.

| Sous-commande | Où | Effet |
|---|---|---|
| `config <chemin>` | Partout | Descend dans une branche |
| `edit <clé>` | Dans une table | Descend sur un objet ; le crée s'il n'existe pas |
| `set <attribut> <valeur…>` | Sur un objet | Pose une valeur |
| `unset <attribut>` | Sur un objet | Rétablit le **défaut** |
| `append <attribut> <valeur>` | Sur un objet | **Ajoute** à une liste sans remplacer |
| `select <attribut> <valeur>` | Sur un objet | Réduit une liste à ces valeurs |
| `unselect <attribut> <valeur>` | Sur un objet | Retire une valeur d'une liste |
| `next` | Sur un objet | Valide l'objet et remonte à la table |
| `end` | Partout | Valide et remonte d'un niveau (ou termine) |
| `abort` | Partout | Remonte **sans** valider |
| `delete <clé>` | Dans une table | Supprime un objet |
| `purge` | Dans une table | Supprime **tous** les objets |
| `clone <clé> to <nouvelle>` | Dans une table | Duplique |
| `rename <clé> to <nouvelle>` | Dans une table | Renomme |
| `move <clé> {before\|after} <clé>` | Table ordonnée | Déplace |
| `get` | Partout | Affiche l'état courant |
| `show` | Partout | Affiche ce qui diffère du défaut |
| `?` | Partout | Aide contextuelle |

### 13.2 `set` vs `append` vs `select` vs `unselect`

C'est la nuance la plus souvent ratée, et elle est réellement utile.

Situation de départ :

```
set member "SRV_A" "SRV_B" "SRV_C"
```

| Commande | Résultat |
|---|---|
| `set member "SRV_D"` | `SRV_D` — **tout le reste est perdu** |
| `append member "SRV_D"` | `SRV_A SRV_B SRV_C SRV_D` |
| `select member "SRV_A"` | `SRV_A` |
| `unselect member "SRV_B"` | `SRV_A SRV_C` |

**Pourquoi ça compte** : sur une machine de production, `set member` sur
un groupe existant est la faute classique qui coupe le service. Un
simulateur qui ne reproduit pas la différence n'enseigne pas le réflexe.

Le schéma porte donc `multiValue: boolean`, et `append`/`select`/
`unselect` sont refusés sur un attribut mono-valué — en le disant.

### 13.3 `unset` rétablit le défaut

`unset` **n'est pas** « supprimer ». C'est « rétablir la valeur par
défaut ». La différence est visible :

```
config firewall policy
    edit 1
        set logtraffic all       → show affiche `set logtraffic all`
        unset logtraffic         → show n'affiche plus rien (défaut = utm)
        get                      → get affiche `logtraffic       : utm`
    next
end
```

Sans valeur par défaut au schéma, `unset` ne peut pas être distingué de
`delete` sur un champ. C'est la seconde raison — après `show`/`get` — qui
rend F2 obligatoire.

### 13.4 `next` vs `end` vs `abort`

| | Valide ? | Remonte de |
|---|---|---|
| `next` | ✅ | Un niveau (objet → table), et **reste dans la table** |
| `end` | ✅ | Un niveau, jusqu'à la racine si répété |
| `abort` | ❌ | **Tout**, directement à la racine |

`abort` est le filet de sécurité : on a commencé à modifier une règle, on
se rend compte qu'on s'est trompé d'objet, on annule.

**Point de fidélité** : sur FortiOS, `end` depuis un objet vaut
`next` + `end`. `FortiShell.leaveTable()` le fait déjà correctement.

### 13.5 `purge`, et pourquoi il mérite un avertissement

`purge` vide une table entière. Sur `system interface` ou
`system admin`, il rend la machine inaccessible — la documentation
Fortinet l'écrit noir sur blanc.

Le simulateur doit :

1. le supporter (c'est une vraie commande) ;
2. demander confirmation, comme la vraie machine :
   `Do you want to continue? (y/n)` ;
3. **et** appliquer la conséquence : purger `system admin` rend
   effectivement l'accès impossible.

C'est un excellent laboratoire de panne, et le dépôt a déjà tout le
mécanisme de plans interactifs (`InteractiveFlow`, `IntentRunner`) pour
la confirmation.

### 13.6 `clone` et `rename`

```
config firewall policy
    clone 1 to 5
end

config firewall address
    rename "SRV_WEB" to "SRV_WEB_PARIS"
end
```

`PolicyStore.clone()` existe déjà au socle. `rename` demande une
**mise à jour des référents** : renommer un objet adresse référencé par
une politique doit mettre à jour la politique, sinon la référence casse.

**Arbitrage** : FortiOS met à jour les référents. Le simulateur fait
pareil, et `ObjectStore` expose déjà `objectReferents()` du côté
`PolicyStore` — la brique existe.

### 13.7 `move`

```
config firewall policy
    move 5 before 2
end
```

Refusé sur une table non ordonnée :

```
Command fail. Return code -61
NOTE: la table « firewall address » n'est pas ordonnée ; `move` n'y a pas de sens.
```

`PolicyStore.move()` existe au socle, avec `before`/`after`, `moveTop`,
`moveBottom`.

### 13.8 Exigences — sous-commandes

| # | Exigence |
|---|---|
| **FGT-CMD-1** | Les dix-huit sous-commandes de §13.1 existent |
| **FGT-CMD-2** | `set` remplace, `append` ajoute, `select` réduit, `unselect` retire — quatre comportements distincts, quatre tests |
| **FGT-CMD-3** | `unset` rétablit le défaut du schéma, et `get` le montre |
| **FGT-CMD-4** | `abort` remonte à la racine sans valider ; les modifications sont perdues |
| **FGT-CMD-5** | `purge` demande confirmation et applique la conséquence |
| **FGT-CMD-6** | `rename` met à jour les référents |
| **FGT-CMD-7** | `move` est refusé sur une table non ordonnée |
| **FGT-CMD-8** | `append`/`select`/`unselect` sont refusés sur un attribut mono-valué |

---

## 14. Le schéma déclaratif

### 14.1 Pourquoi un schéma

Sans schéma, chaque table demande : une liste blanche d'attributs, une
fonction de validation, une fonction de rendu `show`, une fonction de
rendu `get`, une fonction de complétion, une entrée d'aide, une fonction
de sérialisation. Sept écritures par table, une centaine de tables.

Avec schéma : **une déclaration par table**, et les sept fonctions sont
génériques.

C'est le même raisonnement qui a produit `TextTable.ts` dans ce dépôt
(« un tableau se déclare, il ne se dessine plus à la main »), et le
défaut qu'il ferme est identique : deux écritures d'un même fait finissent
par se contredire.

### 14.2 Le modèle

```ts
export type FortiValueType =
  | 'string' | 'integer' | 'ipv4-address' | 'ipv4-netmask'
  | 'ipv4-address-mask' | 'ipv4-range' | 'ipv6-prefix'
  | 'mac-address' | 'enum' | 'reference' | 'time' | 'password'
  | 'user-name' | 'boolean-enable';

export interface FortiAttributeSpec {
  readonly name: string;
  readonly type: FortiValueType;
  readonly help: string;

  readonly enumValues?: readonly string[];
  readonly referenceTo?: string;
  readonly multiValue?: boolean;

  readonly defaultValue?: string | number | readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly maxLength?: number;

  readonly requiredWhen?: (obj: FortiObject) => boolean;
  readonly availableWhen?: (obj: FortiObject) => boolean;

  readonly unimplemented?: string;
}

export interface FortiTableSpec {
  readonly path: string;
  readonly kind: 'table' | 'object';
  readonly keyType?: 'name' | 'integer';
  readonly ordered?: boolean;
  readonly scope: 'global' | 'vdom' | 'both';
  readonly help: string;

  readonly attributes: ReadonlyMap<string, FortiAttributeSpec>;
  readonly children: ReadonlyMap<string, FortiTableSpec>;

  readonly predefined?: readonly string[];
  readonly onCommit?: (obj: FortiObject, ctx: FortiCommitContext) => FortiCommitResult;
  readonly renderOrder?: number;
}
```

### 14.3 Ce que le schéma donne gratuitement

| Fonction | Dérivation |
|---|---|
| Validation de `set` | `type`, `enumValues`, `min`/`max`, `maxLength` |
| Validation de référence | `referenceTo` + le magasin correspondant |
| `unset` | `defaultValue` |
| `append`/`select`/`unselect` | `multiValue` |
| `move` | `ordered` |
| `?` | `help` de chaque attribut du nœud |
| Complétion `Tab` | Les clés de `attributes` et `children` |
| `show` | Les attributs ≠ `defaultValue` |
| `get` | Tous les attributs avec valeur courante |
| `show full-configuration` | Tous les attributs, format `show` |
| Sérialisation de topologie | Le même parcours que `show full-configuration` |
| Refus « connu mais non simulé » | `unimplemented` |
| Portée VDOM/global | `scope` |
| Ordre de rendu | `renderOrder` |

### 14.4 `availableWhen` — les attributs conditionnels

FortiOS masque certains attributs selon la valeur d'un autre. Exemple
canonique, la VIP :

```
set portforward enable      → extport et mappedport apparaissent
set portforward disable     → ils disparaissent
```

et l'interface :

```
set mode static             → ip, allowaccess apparaissent
set mode dhcp               → ip disparaît, defaultgw/dns-server-override apparaissent
```

`availableWhen` porte ce fait. Il gouverne `?`, la complétion, `set` et
`get` — donc `?` ne propose jamais un attribut inapplicable, ce qui est
le comportement de la vraie machine et une aide réelle.

### 14.5 `onCommit` — le pont vers les moteurs

C'est **la seule** fonction du schéma qui écrit dans les magasins du
socle. Elle est appelée au `next`/`end` de l'objet.

```ts
onCommit(obj, ctx) {
  ctx.vdom.policy.append({
    id: obj.key,
    from: obj.list('srcintf'),
    to: obj.list('dstintf'),
    source: obj.list('srcaddr'),
    destination: obj.list('dstaddr'),
    service: obj.list('service'),
    action: obj.enum('action') === 'deny' ? 'deny' : 'allow',
    natEnabled: obj.bool('nat'),
    …
  });
  return { ok: true };
}
```

**Garde-fou G1** : `onCommit` **appelle** les moteurs, elle n'en
implémente aucun. Le test d'architecture vérifie déjà mécaniquement
qu'aucun fichier de `vendors/` ne définit de classe moteur ; il faut y
ajouter (§40.4) qu'aucun fichier de `vendors/fortios/` ne pose de
verdict de paquet.

### 14.6 L'organisation des fichiers de schéma

Un fichier par branche de premier niveau, sinon le schéma devient un
fichier de 10 000 lignes :

```
vendors/fortios/schema/
├── index.ts               ← assemble et expose l'arbre
├── types.ts               ← FortiTableSpec, FortiAttributeSpec
├── system.ts              ← config system …
├── firewallObjects.ts     ← address, addrgrp, service, schedule
├── firewallPolicy.ts      ← policy, security-policy, local-in-policy, DoS
├── firewallNat.ts         ← vip, vipgrp, ippool, central-snat-map
├── router.ts              ← static, policy, ospf, bgp
├── user.ts                ← local, group, radius, ldap, tacacs+
├── vpn.ts                 ← ipsec, ssl, certificate
├── utm.ts                 ← les profils
└── log.ts                 ← les cibles de journalisation
```

### 14.7 Exigences — schéma

| # | Exigence |
|---|---|
| **FGT-SCH-1** | Tout chemin de configuration reconnu est déclaré au schéma ; aucun n'est codé en dur dans le shell |
| **FGT-SCH-2** | Tout attribut porte un type, une aide, et un défaut quand il en a un sur la vraie machine |
| **FGT-SCH-3** | La validation de `set` dérive du schéma seul |
| **FGT-SCH-4** | `?` et la complétion dérivent du schéma seul |
| **FGT-SCH-5** | `show`, `get`, `show full-configuration` sont trois parcours d'un même schéma |
| **FGT-SCH-6** | `availableWhen` masque les attributs inapplicables dans les quatre voies (set, ?, complétion, get) |
| **FGT-SCH-7** | `onCommit` est le seul point d'écriture vers les magasins du socle |
| **FGT-SCH-8** | Un attribut portant `unimplemented` est refusé avec le message de la famille 2 (§17) |

---

## 15. `show`, `get`, `show full-configuration`

### 15.1 Les trois rendus

| Commande | Contenu | Format |
|---|---|---|
| `show` | Ce qui **diffère** du défaut | Commandes de configuration |
| `show full-configuration` | **Tout** | Commandes de configuration |
| `get` | Tout, valeurs **courantes** | `champ : valeur`, aligné |

### 15.2 `show`

```
FGT1 # show firewall policy
config firewall policy
    edit 1
        set name "LAN-vers-Internet"
        set srcintf "port1"
        set dstintf "port2"
        set srcaddr "LAN_SUBNET"
        set dstaddr "all"
        set action accept
        set schedule "always"
        set service "ALL"
        set logtraffic all
        set nat enable
    next
end
```

Deux propriétés à tenir :

1. **Indentation de 4 espaces par niveau.** `edit` est indenté de 4,
   `set` de 8. C'est ce que fait `FortiShell.showPolicies()` aujourd'hui.
2. **Le résultat est rejouable.** Coller cette sortie dans une CLI vierge
   doit reproduire la configuration. C'est FGT-SCH-9, et c'est ce qui
   fait de `show` la base de la sérialisation de topologie.

### 15.3 `show full-configuration`

Le même objet, tous ses attributs :

```
FGT1 # show full-configuration firewall policy
config firewall policy
    edit 1
        set name "LAN-vers-Internet"
        set uuid 5f4a1c2e-8b3d-51ef-a1b2-c3d4e5f60718
        set srcintf "port1"
        set dstintf "port2"
        set action accept
        set nat enable
        set status enable
        set schedule "always"
        set service "ALL"
        set logtraffic all
        set logtraffic-start disable
        set utm-status disable
        set inspection-mode flow
        set capture-packet disable
        set auto-asic-offload enable
        set np-acceleration enable
        set permit-any-host disable
        set permit-stun-host disable
        set fixedport disable
        set ippool disable
        set session-ttl 0
        set tcp-session-without-syn disable
        set anti-replay enable
        set dynamic-shaping disable
        set passive-wan-health-measurement disable
        set comments ''
        config srcaddr
            edit "LAN_SUBNET"
            next
        end
        config dstaddr
            edit "all"
            next
        end
    next
end
```

**Détail de fidélité intéressant** : sur les versions récentes,
`show full-configuration` rend certaines listes comme des **sous-tables**
(`config srcaddr / edit "…" / next / end`) plutôt que comme
`set srcaddr "…"`. C'est cosmétique mais visible ; retenu comme
**divergence assumée** (§43) : le simulateur rend `set srcaddr` dans les
deux vues, parce que rendre une forme non rejouable par `set` casserait
FGT-SCH-9.

### 15.4 `get`

```
FGT1 # get firewall policy 1
policyid            : 1
name                : LAN-vers-Internet
uuid                : 5f4a1c2e-8b3d-51ef-a1b2-c3d4e5f60718
srcintf             : "port1"
dstintf             : "port2"
srcaddr             : "LAN_SUBNET"
dstaddr             : "all"
action              : accept
status              : enable
schedule            : always
service             : "ALL"
utm-status          : disable
logtraffic          : all
nat                 : enable
```

L'alignement est à colonne fixe (20 caractères pour le nom du champ).
**Il doit passer par `TextTable.ts`** — c'est la règle du dépôt, et
`FIXED_TABLE` existe précisément pour les mises en forme dont la largeur
porte son propre blanc.

Sans clé, `get` sur une table liste les clés :

```
FGT1 # get firewall address
== [ all ]
name: all
== [ LAN_SUBNET ]
name: LAN_SUBNET
== [ SRV_WEB ]
name: SRV_WEB
```

### 15.5 Le piège de `show` sur la configuration entière

`show` sans argument rend **toute** la configuration du VDOM courant.
C'est ce qu'un apprenant tape pour se relire, et c'est ce qu'un
auditeur exporte. L'ordre de rendu est donc important, et il n'est pas
alphabétique : FortiOS rend d'abord `system global`, puis les
interfaces, puis les objets, puis les politiques — c'est-à-dire dans
l'ordre où la configuration peut être **rejouée**.

`renderOrder` du schéma porte cet ordre. C'est la même leçon que
`ciscoConfigSerializer.ts` avait apprise pour IOS (`orderCiscoConfigBlocks`
et son classement par rang) : une configuration rendue dans le mauvais
ordre ne se recharge pas.

### 15.6 `show | grep`

FortiOS accepte un filtre de sortie :

```
show | grep hostname
show firewall policy | grep -f "port1"
```

`-f` affiche le **contexte complet** (la table et l'objet), pas seulement
la ligne. C'est très utilisé. Le dépôt a déjà `parsePipeFilter` et
`applyPipeFilter` (`shells/cli-utils.ts`), partagés par les shells
Cisco et Huawei — donc à réutiliser, avec l'ajout de `-f`.

### 15.7 Exigences — rendus

| # | Exigence |
|---|---|
| **FGT-VUE-1** | `show` ne rend que ce qui diffère du défaut |
| **FGT-VUE-2** | `show full-configuration` rend tous les attributs |
| **FGT-VUE-3** | `get` rend `champ : valeur` aligné, via `TextTable` |
| **FGT-VUE-4** | `get` sur une table sans clé liste les clés au format `== [ nom ]` |
| **FGT-VUE-5** | La sortie de `show` est rejouable telle quelle |
| **FGT-VUE-6** | L'ordre de rendu de `show` sans argument permet le rejeu |
| **FGT-VUE-7** | `| grep` et `| grep -f` fonctionnent, en réutilisant `applyPipeFilter` |
| **FGT-VUE-8** | Un test compare `show` et `get` sur le même objet et vérifie qu'ils diffèrent |

---

## 16. Complétion, aide, abréviations

### 16.1 L'aide `?`

Sur FortiOS, `?` est **immédiat** : il n'attend pas la validation, et il
affiche ce qui est disponible à la position courante.

À la racine :

```
FGT1 # config ?
antivirus         Configure AntiVirus.
application       Configure application control.
authentication    Configure authentication.
dlp               Configure DLP.
dnsfilter         Configure DNS domain filter.
emailfilter       Configure email filter.
endpoint-control  Configure endpoint control.
extender-controller Configure FortiExtender.
file-filter       Configure file filter.
firewall          Configure firewall.
ftp-proxy         Configure FTP proxy.
icap              Configure ICAP.
ips               Configure IPS.
log               Configure logging.
report            Configure reports.
router            Configure routers.
switch-controller Configure FortiSwitch.
system            Configure system settings.
user              Configure user authentication.
vpn               Configure VPN.
waf               Configure Web application firewall.
wanopt            Configure WAN optimization.
web-proxy         Configure web proxy.
webfilter         Configure web filter.
wireless-controller Configure wireless controller.
```

Sur un objet :

```
FGT1 (1) # set ?
action              Policy action (accept/deny/ipsec).
application-list    Name of an existing Application list.
auth-cert           HTTPS server certificate for policy authentication.
…
```

Sur une valeur énumérée :

```
FGT1 (1) # set action ?
accept              Allow session that match this policy.
deny                Deny or block sessions that match this policy.
ipsec               Allow and encrypt IPsec sessions (policy-based IPsec VPN).
```

**Tout cela dérive du schéma** — c'est l'argument central de §14.

### 16.2 La complétion

`Tab` complète le mot courant. Si plusieurs candidats, il complète le
préfixe commun et liste au second `Tab`.

`FortiShell.completions()` existe et filtre un vocabulaire plat. Avec le
schéma, il devient contextuel et complet.

### 16.3 Les abréviations

FortiOS accepte les abréviations non ambiguës :

```
config sys int      ≡ config system interface
edit port1
set ip 1.1.1.1 255.255.255.0
```

C'est très utilisé, et l'omettre rendrait la CLI pénible. `CommandTrie`
du dépôt sait faire exactement cela (préfixes non ambigus, refus
`% Ambiguous command` d'IOS) — la mécanique de résolution est
réutilisable, avec le message FortiOS à la place.

**Nuance mesurée** : FortiOS abrège les **chemins** et les **noms
d'attributs**, mais **pas** les valeurs énumérées. `set act acc` échoue
là où `set action accept` réussit. À vérifier au moment de
l'implémentation, et à écrire dans le PRD de livraison.

### 16.4 L'historique et l'édition de ligne

| Touche | Effet |
|---|---|
| ↑ / ↓ | Historique |
| Ctrl-A / Ctrl-E | Début / fin de ligne |
| Ctrl-U | Efface la ligne |
| Ctrl-C | Annule la ligne |
| Ctrl-Z | Remonte à la racine (≡ `end` répété) |

`FortiTerminalSession.getCtrlZCommand()` rend déjà `end`. Le reste est
porté par `CLITerminalSession`.

### 16.5 Le pager

Une sortie longue est paginée par `--More--`.

```
config system console
    set output {standard | more}
end
```

`standard` désactive la pagination — c'est le premier réglage que fait
un administrateur qui copie des configurations.

`FortiTerminalSession.getPagerIndicator()` rend déjà `--More--`.

### 16.6 Exigences — ergonomie

| # | Exigence |
|---|---|
| **FGT-ERG-1** | `?` est contextuel et dérive du schéma |
| **FGT-ERG-2** | `?` sur une valeur énumérée liste les valeurs avec leur aide |
| **FGT-ERG-3** | La complétion `Tab` dérive du schéma |
| **FGT-ERG-4** | Les abréviations non ambiguës de chemin et d'attribut sont acceptées |
| **FGT-ERG-5** | Une abréviation ambiguë est refusée en listant les candidats |
| **FGT-ERG-6** | `config system console / set output standard` supprime la pagination |
| **FGT-ERG-7** | Aucun mot-clé exposé par `?` n'est dépourvu de description — garde-fou mécanique, comme `cisco-help-every-keyword-described` |

---

## 17. Le catalogue de messages

### 17.1 Pourquoi un catalogue

Un shell qui répond la même chose à toutes les erreurs n'enseigne rien.
`FortiShell` a aujourd'hui **un** message : `Command fail. Return code -61`.

C'est un vrai message FortiOS, et FortiOS l'utilise effectivement
souvent. Mais il en a d'autres, et surtout : le simulateur peut ajouter
une ligne de diagnostic sans mentir, à condition qu'elle ne puisse pas
être confondue avec une sortie du produit (principe F5).

### 17.2 Les messages FortiOS réels

| Situation | Message |
|---|---|
| Commande refusée (générique) | `Command fail. Return code -61` |
| Commande inconnue | `Unknown action 0` |
| Attribut inconnu | `command parse error before '<mot>'` puis `Command fail. Return code -61` |
| Valeur invalide | `value parse error before '<valeur>'` |
| Objet référencé inexistant | `entry not found in datasource` |
| Objet référencé par un autre | `Cannot delete entry: it is used by other entries` |
| Objet déjà existant (`rename`, `clone`) | `duplicate name` |
| Table pleine | `table is full` |
| Permission insuffisante | `Permission denied` |
| Confirmation | `Do you want to continue? (y/n)` |

### 17.3 Les trois familles de refus

Reprises de `PRD-Curl.md` et `PRD-OpenSSL.md`, qui les ont validées :

**Famille 1 — implémenté** : la commande agit.

**Famille 2 — connu de FortiOS, non simulé ici** :

```
Command fail. Return code -61
NOTE: `set auto-asic-offload` existe sur un vrai FortiGate ; ce simulateur
      n'a aucun modèle d'accélération matérielle, donc ce réglage n'aurait
      aucun effet mesurable.
```

**Famille 3 — inexistant** :

```
command parse error before 'zorglub'
Command fail. Return code -61
NOTE: attribut « zorglub » inconnu pour `config firewall policy`.
      Tapez `set ?` pour la liste.
```

Le message intermédiaire de la famille 2 n'est **pas** un message
FortiOS, délibérément : aucun vrai FortiGate n'est jamais dans cette
situation, et lui en attribuer un serait un second mensonge.

### 17.4 La suppression des notes

```
config system global
    set simulator-hints {enable | disable}
end
```

`simulator-hints` n'est **pas** une commande FortiOS. Elle est donc
préfixée dans l'aide par `[simulateur]` et documentée comme telle. Un
formateur qui veut un examen fidèle la désactive.

C'est le même arbitrage que la note `NOTE:` d'Apache : on ajoute une
aide que le vrai produit ne donne pas, et on la rend supprimable plutôt
que de la retirer.

### 17.5 Les messages de journalisation

Le profil déclare trois entrées de catalogue syslog. Un FortiGate en a
beaucoup plus, et surtout : **le format de journal FortiOS n'est pas du
syslog Cisco**. C'est une suite de couples `clé=valeur` :

```
date=2026-08-17 time=07:12:44 devname="FGT1" devid="FGVM0000000000"
logid="0000000013" type="traffic" subtype="forward" level="notice"
vd="root" eventtime=1755414764 srcip=192.168.1.10 srcport=44001
srcintf="port1" srcintfrole="lan" dstip=203.0.113.10 dstport=443
dstintf="port2" dstintfrole="wan" sessionid=4231 proto=6
action="accept" policyid=1 policytype="policy" service="HTTPS"
dstcountry="Reserved" srccountry="Reserved" trandisp="snat"
transip=203.0.113.1 transport=44001 duration=12 sentbyte=1420
rcvdbyte=3812 sentpkt=14 rcvdpkt=16
```

C'est un format **très** différent de tout ce que le dépôt produit
aujourd'hui, et c'est une bonne nouvelle pédagogique : un apprenant qui a
vu du syslog Cisco découvre qu'il n'y a pas un format mais des formats.

`SyslogCatalog` du socle porte `id` et `severity`. Il faut y ajouter un
**formateur par vendeur**, ce qui est une extension du socle (§26 du
BRD générique le prévoit : « les formats vendeur »).

### 17.6 Exigences — messages

| # | Exigence |
|---|---|
| **FGT-MSG-1** | Les dix messages de §17.2 existent et sont émis dans leur situation |
| **FGT-MSG-2** | Les trois familles de refus sont distinguées |
| **FGT-MSG-3** | Une note de simulateur est toujours préfixée `NOTE:` et n'est jamais un message FortiOS |
| **FGT-MSG-4** | `set simulator-hints disable` supprime les notes, et l'aide dit que la commande est propre au simulateur |
| **FGT-MSG-5** | Le format de journal FortiOS est en couples `clé=valeur` |
| **FGT-MSG-6** | Un test compare une ligne de journal produite au format documenté, champ par champ |
