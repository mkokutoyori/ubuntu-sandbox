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
| **État de rédaction** | Complet — 44 chapitres, 230 exigences numérotées, 10 phases de livraison |

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

### 14.1 bis — Le partage des rôles avec le moteur de commandes

**Révision de ce chapitre, décidée après la livraison de la phase 1 et
appliquée en phase 1b.** La première rédaction faisait porter au schéma
la validation, l'aide et la complétion. C'était une écriture de trop :
`src/cli/` porte déjà un moteur de commandes, écrit pour Cisco et repris
par l'ASA, qui fait tout cela et davantage.

**La règle est donc :**

| Question | Qui répond |
|---|---|
| Qu'est-ce qui **existe** ? | Le schéma FortiOS |
| Qu'est-ce qui est **légal ici** ? | `src/cli/CommandParser` |
| Que **proposer** au curseur ? | `src/cli/CompletionEngine` |
| Quelle **forme** une valeur doit-elle avoir ? | `src/cli/ArgumentTypes` |
| Que **muter** ? | `FortiNavigator` |

**Ce que le moteur partagé apporte et que le schéma seul n'apportait
pas** : les abréviations non ambiguës, l'ambiguïté **nommée** plutôt que
le premier candidat, les bornes réelles dans l'aide (`<0-32>` et non le
nom de l'attribut), les formes alternatives pour une même place, `<cr>`
quand la commande est complète, et le filtrage par atteignabilité du
sous-arbre.

**La difficulté, et sa réponse.** Une `CommandTable` est statique ;
FortiOS ne l'est pas — les commandes légales dépendent de la position
dans l'arbre de configuration, et les attributs de l'objet ouvert.
`FortiSocle` **bâtit une table par contexte**, à partir du schéma, et la
met en cache sur (chemin, attributs disponibles, empreinte des
références). Chaque table fait quelques dizaines de nœuds.

**Le gain qui n'était pas prévu** : parce que la table est bâtie à la
demande, `set srcaddr ?` peut lister les objets adresse **qui existent
réellement**. Une table statique ne saurait pas le faire.

**Un défaut du moteur partagé fermé en passant** : un nœud intermédiaire
héritait de la description de son **premier descendant**, donc
`config ?` annonçait « Configure IPv4 addresses. » pour le mot `config`
— la description d'une branche pour le nom de toutes. Cisco a
exactement le même défaut sur `show ?`. `TreeNode.legend` et
`CommandTable.describePath()` le referment pour les deux, et l'héritage
reste le comportement par défaut, qui convient quand la branche est
unique.

### 14.2 Le modèle

Un attribut FortiOS porte **des `ArgumentSpec` partagés**, un par jeton
que la valeur occupe — deux pour `set subnet A.B.C.D A.B.C.D`, un pour
tout le reste — plus ce que `src/cli/` ne connaît pas : la valeur par
défaut, la disponibilité conditionnelle, la cible d'une référence, et le
motif d'un refus de famille 2.

```ts
export interface FortiAttributeSpec {
  readonly name: string;
  readonly help: string;
  readonly parts: readonly ArgumentSpec[];
  readonly multiValue?: boolean;
  readonly referenceTo?: readonly string[];
  readonly quoted?: boolean;
  readonly defaultValue?: readonly string[];
  readonly availableWhen?: (object: FortiObjectView) => boolean;
  readonly unimplemented?: string;
  readonly readOnly?: boolean;
}
```

Les fabriques `enable()`, `choice()`, `count()`, `text()`, `word()`,
`reference()`, `refList()`, `address()`, `addressMask()` et `clock()`
composent les cas courants, de sorte qu'une table se lit comme la
documentation Fortinet plutôt que comme du code.

<details>
<summary>La première rédaction, conservée pour mémoire</summary>

```ts
export type FortiValueType =
  | 'string' | 'integer' | 'ipv4-address' | 'ipv4-netmask'
  | 'ipv4-address-mask' | 'ipv4-range' | 'ipv6-prefix'
  | 'mac-address' | 'enum' | 'reference' | 'time' | 'password'
  | 'user-name' | 'boolean-enable';

export interface FortiAttributeSpecV1 {
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

</details>

La `FortiTableSpec` livrée est celle de la première rédaction, à ceci
près que `attributes` et `children` sont des **tableaux** plutôt que des
`Map` — l'ordre de déclaration est celui du rendu, et une `Map` obligeait
à le reconstituer — et que `renderOrder`, `scope` et `accessGroup` y sont
**obligatoires**, le garde-fou G8 le vérifiant.

### 14.3 Ce que le schéma donne gratuitement

| Fonction | Dérivation |
|---|---|
| Validation de `set` | Les `parts`, via `argumentAccepts` du moteur partagé |
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

---

# Partie IV — L'arbre de configuration, chemin par chemin

> Chaque chapitre de cette partie suit le même plan : la syntaxe réelle,
> le tableau des attributs retenus (avec type, défaut et destination dans
> le socle), ce qui est refusé et pourquoi, puis les exigences.
>
> Le tableau des attributs **est** le schéma : il se transcrit
> mécaniquement en `FortiTableSpec`, et c'est délibéré — un BRD dont les
> tableaux ne se transcrivent pas est un BRD qu'on réinterprète.
>
> Colonne **« → socle »** : où la valeur atterrit. `—` veut dire qu'elle
> est stockée et rendue sans autre consommateur, ce qui est légitime
> pour un attribut purement descriptif (`alias`, `comment`) et refusé
> pour tout le reste (principe F6).

---

## 18. `config system` — la machine

### 18.1 `config system global`

Objet unique, portée **globale** (hors VDOM).

```
config system global
    set hostname "FGT-PARIS"
    set timezone 27
    set admintimeout 30
    set admin-sport 443
    set admin-ssh-port 22
    set gui-theme jade
    set vdom-mode multi-vdom
    set firewall-session-dirty check-all
    set alias "Pare-feu du siege"
end
```

| Attribut | Type | Défaut | → socle |
|---|---|---|---|
| `hostname` | string(35) | `FortiGate` | `Equipment.hostname` |
| `alias` | string(35) | `''` | — |
| `timezone` | enum (indices Fortinet) | `04` | Horloge de l'équipement |
| `admintimeout` | integer 1-480 min | `5` | Expiration de session admin |
| `admin-sport` | integer 1-65535 | `443` | Port d'écoute HTTPS |
| `admin-ssh-port` | integer | `22` | Port d'écoute SSH |
| `admin-port` | integer | `80` | Port HTTP |
| `admin-telnet-port` | integer | `23` | Port telnet |
| `admin-scp` | enable/disable | `disable` | SCP sur le serveur SSH |
| `admin-https-redirect` | enable/disable | `enable` | Redirection 80→443 |
| `admin-lockout-threshold` | integer | `3` | Verrouillage de compte |
| `admin-lockout-duration` | integer (s) | `60` | Idem |
| `vdom-mode` | `no-vdom`/`multi-vdom`/`split-vdom` | `no-vdom` | `VdomRegistry` |
| `firewall-session-dirty` | `check-all`/`check-new`/`check-policy-option` | `check-all` | §8.3 |
| `gui-theme` | enum | `jade` | — |
| `language` | enum | `english` | — |
| `hostname`/`alias` rendus par `get system status` | | | |
| `simulator-hints` | enable/disable | `enable` | **§17.4 — propre au simulateur** |

**Refusés, famille 2** : `auto-asic-offload`, `np-acceleration`,
`hw-switch-*`, `cpu-use-threshold`, `memory-use-threshold-*`, tout ce qui
décrit un matériel absent.

**`set timezone`** : FortiOS utilise des **indices numériques**
(`27` = Bruxelles/Paris/Madrid). Un simulateur qui accepterait
`Europe/Paris` enseignerait une syntaxe qui n'existe pas. Le schéma porte
donc une énumération d'indices, avec l'aide qui nomme la zone —
`?` affiche `27  (GMT+1:00) Brussels,Copenhagen,Madrid,Paris`.

### 18.2 `config system interface`

Table, clé = nom, portée **globale** (l'interface porte son VDOM).

```
config system interface
    edit "port1"
        set vdom "root"
        set alias "LAN"
        set role lan
        set mode static
        set ip 192.168.1.1 255.255.255.0
        set allowaccess ping https ssh
        set description "Reseau des postes"
        set status up
        set mtu-override enable
        set mtu 1500
    next
    edit "vlan100"
        set vdom "root"
        set type vlan
        set interface "port1"
        set vlanid 100
        set mode static
        set ip 192.168.100.1 255.255.255.0
        set allowaccess ping
    next
end
```

| Attribut | Type | Défaut | → socle |
|---|---|---|---|
| `vdom` | reference `system.vdom` | `root` | `VdomRegistry` |
| `alias` | string(25) | `''` | — |
| `description` | string(255) | `''` | — |
| `role` | `lan`/`wan`/`dmz`/`undefined` | `undefined` | — (décoratif, mais rendu) |
| `type` | `physical`/`vlan`/`aggregate`/`loopback`/`tunnel`/`vdom-link`/`switch` | `physical` | Création de `Port` |
| `interface` | reference (parent) | — | VLAN/agrégat |
| `vlanid` | integer 1-4094 | — | `Port` taggé |
| `mode` | `static`/`dhcp`/`pppoe` | `static` | §18.3 |
| `ip` | ipv4-address-mask | `0.0.0.0 0.0.0.0` | `InterfaceTable.configure` |
| `allowaccess` | multi enum : `ping https ssh snmp http telnet fgfm radius-acct probe-response fabric ftm` | `''` | §18.4 — **vrai filtre** |
| `status` | `up`/`down` | `up` | `Firewall.setInterfaceUp` |
| `mtu-override` | enable/disable | `disable` | `Port.setMtu` |
| `mtu` | integer 68-9216 | `1500` | idem |
| `speed` | enum | `auto` | `Port` (mécanisme déjà réel) |
| `secondary-IP` | enable/disable | `disable` | Sous-table `secondaryip` |
| `dhcp-relay-service` | enable/disable | `disable` | `dhcp/` |
| `dhcp-relay-ip` | ipv4 | — | idem |
| `defaultgw` | enable/disable | `enable` | Mode DHCP |
| `dns-server-override` | enable/disable | `enable` | Mode DHCP |
| `device-identification` | enable/disable | `disable` | Famille 2 |
| `lldp-transmission` | `enable`/`disable`/`vdom` | `vdom` | `lldp/` existe |

Sous-table `secondaryip` :

```
config system interface
    edit "port1"
        set secondary-IP enable
        config secondaryip
            edit 1
                set ip 192.168.2.1 255.255.255.0
                set allowaccess ping
            next
        end
    next
end
```

**Point mesuré et réutilisable** : `PRD-Loopback.md` a déjà établi
qu'une adresse secondaire doit être **joignable** — le défaut y était que
`buildFullRoutingTable` ne posait de route que pour l'adresse primaire.
`InterfaceTable` du socle doit hériter de cette leçon : une adresse
secondaire pose sa route connectée, et `owningInterface()` la reconnaît.

### 18.3 Les trois modes d'adressage

| Mode | Ce que la machine fait |
|---|---|
| `static` | L'adresse est celle configurée |
| `dhcp` | Le FortiGate est **client** DHCP sur cette interface |
| `pppoe` | Session PPPoE |

**`dhcp` est simulable et vaut la peine** : `dhcp/` porte un client
complet, et le laboratoire « le WAN prend son adresse par DHCP » est
banal en entreprise. `set defaultgw enable` fait installer la route par
défaut apprise — donc un apprenant voit une route apparaître sans l'avoir
tapée, ce qui est instructif.

**`pppoe` est refusé, famille 2** : aucune pile PPP dans le dépôt, et
l'écrire dépasse largement ce module.

### 18.4 `allowaccess` — le premier durcissement

C'est un **vrai filtre**, et c'est ce qui le rend intéressant.

| Valeur | Service | Écoute |
|---|---|---|
| `ping` | ICMP echo | `Firewall.deliverLocally` |
| `https` | GUI | TCP 443 (`admin-sport`) |
| `http` | GUI non chiffrée | TCP 80 |
| `ssh` | CLI | TCP 22 |
| `telnet` | CLI | TCP 23 |
| `snmp` | SNMP | UDP 161 |
| `fgfm` | FortiManager | Famille 2 |
| `radius-acct` | Comptabilité RADIUS | UDP 1813 |
| `probe-response` | Sonde SD-WAN | §28 |
| `fabric` | Security Fabric | Famille 2 |
| `ftm` | FortiToken Mobile | Famille 2 |

**Le mécanisme** : chaque interface porte une liste de services admis.
Une connexion vers une adresse de la machine est acceptée **si et
seulement si** le service figure dans l'`allowaccess` de l'interface
d'arrivée — et cela s'évalue **avant** `local-in-policy` sur la vraie
machine.

Le laboratoire qui en découle est celui que tout formateur donne :
retirer `https` de l'interface WAN, constater que la GUI n'est plus
joignable de l'extérieur mais l'est toujours du LAN. Il est entièrement
mesurable ici : `TcpStack` refuse la connexion, et le client voit
`Connection refused`.

**Piège à ne pas reproduire** : `allowaccess` vide sur **toutes** les
interfaces rend la machine inadministrable — sauf par la console. Le
simulateur garde la console ouverte, comme la vraie machine, et c'est ce
qui rend le laboratoire jouable jusqu'au bout.

### 18.5 `config system zone`

Table, clé = nom, portée VDOM.

```
config system zone
    edit "trust"
        set intrazone deny
        set interface "port1" "port3"
        set description "Reseaux internes"
    next
end
```

| Attribut | Type | Défaut | → socle |
|---|---|---|---|
| `interface` | multi reference `system.interface` | `''` | `ZoneTable.assign` |
| `intrazone` | `allow`/`deny` | `deny` | `SecurityZone.intraZoneAction` |
| `description` | string | `''` | — |

`ZoneTable` du socle porte déjà tout : appartenance, refus d'une
interface déjà membre d'une autre zone, refus de suppression d'une zone
référencée par une politique (`zoneReferents()`).

**Nuance FortiOS qui compte** : une interface membre d'une zone
**n'est plus utilisable seule** dans une politique. `set srcintf "port1"`
est refusé si `port1` appartient à `trust` ; il faut écrire
`set srcintf "trust"`. C'est ce que `policyKeyedBy: 'interface'` et
`zoneModel: 'both'` expriment conjointement, et c'est une erreur
classique d'apprenant — donc un bon message :

```
Command fail. Return code -61
NOTE: `port1` appartient a la zone `trust`. Une politique reference la
      zone, pas ses membres.
```

### 18.6 `config system dns` / `config system ntp`

```
config system dns
    set primary 8.8.8.8
    set secondary 1.1.1.1
    set domain "labo.local"
end

config system ntp
    set ntpsync enable
    set type custom
    set syncinterval 60
    config ntpserver
        edit 1
            set server "192.168.1.200"
        next
    end
end
```

Les deux se branchent sur des agents **réels** du dépôt (`dns/`,
`ntp/NtpAgent`). Rien à écrire côté protocole ; seulement le schéma et
l'`onCommit`.

`get system ntp` doit rendre l'état réel (synchronisé ou non, strate),
pas une constante — c'est la leçon `snmp-traps-lien` : une vue qui
affiche un état que rien ne mesure est le défaut, pas la fonction.

### 18.7 `config system dhcp server`

Table, clé = entier, portée VDOM.

```
config system dhcp server
    edit 1
        set interface "port1"
        set default-gateway 192.168.1.1
        set netmask 255.255.255.0
        set dns-service default
        set lease-time 604800
        config ip-range
            edit 1
                set start-ip 192.168.1.100
                set end-ip 192.168.1.200
            next
        end
        config reserved-address
            edit 1
                set ip 192.168.1.50
                set mac 00:11:22:33:44:55
            next
        end
    next
end
```

| Attribut | Type | Défaut | → socle |
|---|---|---|---|
| `interface` | reference | — | `dhcp/DhcpServer` |
| `default-gateway` | ipv4 | — | Option 3 |
| `netmask` | ipv4-netmask | — | Option 1 |
| `dns-service` | `local`/`default`/`specify` | `specify` | Option 6 |
| `dns-server1..4` | ipv4 | — | idem |
| `domain` | string | — | Option 15 |
| `lease-time` | integer (s) | `604800` | Bail |
| `status` | enable/disable | `enable` | — |
| `ntp-service` | `local`/`default`/`specify` | `specify` | Option 42 |

Sous-tables `ip-range` et `reserved-address`. Le serveur DHCP du dépôt
est réel (`dhcp/`), y compris les réservations. `execute dhcp lease-list`
lit la vraie table de baux (§29.3).

### 18.8 `config system admin` et le contrôle d'accès

```
config system admin
    edit "admin"
        set accprofile "super_admin"
        set vdom "root"
        set password ENC xxxxx
        set trusthost1 192.168.1.0 255.255.255.0
        set two-factor disable
    next
    edit "auditeur"
        set accprofile "readonly"
        set vdom "root"
    next
end

config system accprofile
    edit "readonly"
        set secfabgrp read
        set ftviewgrp read
        set authgrp read
        set sysgrp read
        set netgrp read
        set loggrp read
        set fwgrp read
        set vpngrp read
        set utmgrp read
    next
end
```

| Attribut de `admin` | Type | Défaut | → socle |
|---|---|---|---|
| `accprofile` | reference `system.accprofile` | `no_access` | §18.9 |
| `vdom` | multi reference | `root` | Portée du compte |
| `password` | password | — | `NetworkOsCredentialStore` |
| `trusthost1..10` | ipv4-address-mask | `0.0.0.0 0.0.0.0` | Filtre d'origine |
| `two-factor` | `disable`/`fortitoken`/`email`/`sms` | `disable` | Famille 2 sauf `email` |
| `remote-auth` | enable/disable | `disable` | RADIUS/LDAP |
| `remote-group` | reference `user.group` | — | idem |
| `comments` | string | `''` | — |

**`trusthost` est un vrai filtre**, l'exact équivalent de
l'`access-class` d'IOS. Le dépôt a déjà `synthTcpPacket` et
`VtyIncomingPolicy` pour poser ce genre de question ; le mécanisme est
identique et doit être **réutilisé**, pas réécrit — deux synthèses de
paquet donneraient deux verdicts pour la même adresse.

### 18.9 Les profils d'accès

Neuf groupes de droits, chacun `none`/`read`/`read-write` :

| Groupe | Couvre |
|---|---|
| `sysgrp` | `config system …` |
| `netgrp` | Interfaces, routage |
| `fwgrp` | Politique, objets, NAT |
| `utmgrp` | Profils de sécurité |
| `vpngrp` | VPN |
| `loggrp` | Journalisation |
| `authgrp` | Utilisateurs, groupes |
| `secfabgrp` | Security Fabric |
| `ftviewgrp` | FortiView |

Deux profils prédéfinis : `super_admin` (tout en `read-write`) et
`prof_admin`.

**C'est un mécanisme d'autorisation par domaine**, et il ne ressemble ni
aux niveaux de privilège d'IOS (ordre total) ni aux vues d'analyseur
(remplacement de l'arbre). C'est une **matrice**, et c'est plus proche
d'un contrôle d'accès à base de rôles que tout ce que le dépôt porte
aujourd'hui.

Le rapprochement utile : `CliAuthorization` (`shells/cli/`) a été refondu
pour répondre à une seule question — « cette commande est-elle visible
pour ce mandataire ? » — avec un verdict `run`/`absent`. La question
FortiOS est la même, avec un mandataire différent (un profil d'accès au
lieu d'un niveau ou d'une vue) et une clé différente (le **groupe de
droits** du chemin de configuration). Le schéma porte donc
`accessGroup: 'fwgrp' | 'sysgrp' | …` sur chaque `FortiTableSpec`, et
l'autorisation devient une lecture de matrice.

**Décision** : `CliAuthorization` reste tel quel (il sert Cisco), et
FortiOS pose son propre mandataire dans le même cadre — une troisième
implémentation du mécanisme d'autorisation serait le défaut que ce dépôt
referme partout, mais un troisième **mandataire** dans un cadre existant
est exactement ce que le cadre est fait pour porter.

### 18.10 Exigences — système

| # | Exigence |
|---|---|
| **FGT-SYS-1** | `config system global` porte les attributs du tableau §18.1 avec leurs défauts |
| **FGT-SYS-2** | `set timezone` prend un indice numérique et `?` nomme la zone |
| **FGT-SYS-3** | `config system interface` crée un port pour `type vlan`, `loopback`, `aggregate`, `vdom-link` |
| **FGT-SYS-4** | Une adresse secondaire est joignable et pose sa route connectée |
| **FGT-SYS-5** | `mode dhcp` fait du FortiGate un client DHCP réel ; `defaultgw enable` installe la route apprise |
| **FGT-SYS-6** | `allowaccess` filtre réellement : un service absent refuse la connexion au niveau TCP |
| **FGT-SYS-7** | La console reste accessible quel que soit `allowaccess` |
| **FGT-SYS-8** | Une interface membre d'une zone est refusée comme `srcintf`/`dstintf`, en le disant |
| **FGT-SYS-9** | `config system dns`/`ntp`/`dhcp server` se branchent sur les agents réels du dépôt |
| **FGT-SYS-10** | `trusthost` filtre réellement, en réutilisant la synthèse de paquet existante |
| **FGT-SYS-11** | Les neuf groupes de droits gouvernent l'accès aux chemins de configuration |
| **FGT-SYS-12** | Un compte `readonly` peut lire toute la configuration et n'en modifier aucune |

---

## 19. `config firewall` — objets

### 19.1 `config firewall address`

Table, clé = nom, portée VDOM.

```
config firewall address
    edit "SRV_WEB"
        set subnet 192.168.50.10 255.255.255.255
        set comment "Serveur web DMZ"
        set color 6
    next
    edit "PLAGE_INVITES"
        set type iprange
        set start-ip 192.168.20.100
        set end-ip 192.168.20.200
    next
    edit "SITE_DISTANT"
        set type fqdn
        set fqdn "www.example.com"
    next
    edit "PAYS_FR"
        set type geography
        set country "FR"
    next
    edit "CARTE_JOKER"
        set type wildcard
        set wildcard 192.168.0.0 255.255.0.255
    next
end
```

| Attribut | Type | Défaut | → socle |
|---|---|---|---|
| `type` | `ipmask`/`iprange`/`fqdn`/`geography`/`wildcard`/`dynamic`/`interface-subnet`/`mac` | `ipmask` | `AddressObjectKind` |
| `subnet` | ipv4-address-mask | `0.0.0.0 0.0.0.0` | `subnetAddress()` |
| `start-ip` / `end-ip` | ipv4 | — | `rangeAddress()` |
| `fqdn` | string(255) | `''` | `fqdnAddress()` |
| `country` | string(2) | `''` | `geographyAddress()` |
| `wildcard` | ipv4-address-mask | — | `wildcardAddress()` |
| `associated-interface` | reference | `''` | Restriction d'interface |
| `comment` | string(255) | `''` | — |
| `color` | integer 0-32 | `0` | — (couleur GUI) |
| `visibility` | enable/disable | `enable` | — |

**Correspondance parfaite avec `AddressObject`** du socle : les huit
genres existent déjà, y compris `wildcard` avec sa `careMask` et
`geography` avec son `countryOf`. Aucun travail de modèle.

Deux points à traiter :

**(a) L'objet prédéfini `all`** existe toujours et n'est ni modifiable
ni supprimable. `ObjectStore` porte `predefined: boolean` — donc la
protection existe.

**(b) `type fqdn` demande une résolution.** `AddressMatchContext.resolveFqdn`
est le point d'extension prévu, et le dépôt a un vrai résolveur DNS.
La question intéressante — et elle doit être tranchée à
l'implémentation — est **quand** la résolution a lieu : à l'évaluation
de politique (coûteux, mais juste) ou périodiquement avec un cache
(ce que fait FortiOS). **Décision : cache rafraîchi par l'ordonnanceur**,
avec `diagnose firewall fqdn list` pour l'observer — sans quoi la
fonction est invisible.

### 19.2 `config firewall addrgrp`

```
config firewall addrgrp
    edit "SERVEURS"
        set member "SRV_WEB" "SRV_MAIL"
        set comment "Serveurs de la DMZ"
    next
end
```

| Attribut | Type | Défaut | → socle |
|---|---|---|---|
| `member` | multi reference `firewall.address` **ou** `firewall.addrgrp` | — | `ObjectStore` (Composite) |
| `comment` | string | `''` | — |
| `exclude` | enable/disable | `disable` | Exclusion |
| `exclude-member` | multi reference | — | idem |

`ObjectStore` implémente déjà le patron Composite avec
`maxGroupNesting: 10`. L'imbrication au-delà est refusée, ce qui est le
comportement réel.

**`exclude`** est une particularité FortiOS utile : un groupe « tout le
LAN sauf les imprimantes » se déclare sans énumérer le LAN. C'est une
extension du modèle de groupe, pas un moteur.

### 19.3 `config firewall service custom` et `group`

```
config firewall service custom
    edit "HTTP_ALT"
        set tcp-portrange 8080
    next
    edit "APP_METIER"
        set tcp-portrange 9000-9010 9100
        set udp-portrange 9200
        set comment "Application interne"
    next
    edit "PING_ECHO"
        set protocol ICMP
        set icmptype 8
        set icmpcode 0
    next
    edit "GRE"
        set protocol IP
        set protocol-number 47
    next
end

config firewall service group
    edit "WEB"
        set member "HTTP" "HTTPS"
    next
end
```

| Attribut | Type | Défaut | → socle |
|---|---|---|---|
| `protocol` | `TCP/UDP/SCTP`/`ICMP`/`ICMP6`/`IP` | `TCP/UDP/SCTP` | `ServiceProtocol` |
| `tcp-portrange` | multi, `d[-d][:s-s]` | `''` | `ServiceEntry.destinationPorts` |
| `udp-portrange` | multi | `''` | idem |
| `sctp-portrange` | multi | `''` | idem |
| `icmptype` | integer 0-255 | — | `ServiceEntry.icmpType` |
| `icmpcode` | integer 0-255 | — | `ServiceEntry.icmpCode` |
| `protocol-number` | integer 0-254 | `0` | `ipProtocolNumber` |
| `category` | reference | `''` | — |
| `comment` | string | `''` | — |
| `visibility` | enable/disable | `enable` | — |

**La syntaxe de plage de ports est plus riche qu'elle n'en a l'air** :
`80` (un port), `8000-8010` (une plage), `80:1024-65535` (port de
destination **et** plage de ports source). Ce dernier cas existe pour
des protocoles qui contraignent le port source, et `ServiceEntry` du
socle porte déjà `sourcePorts` — donc le modèle suit.

**Les services prédéfinis** : un FortiGate en livre une centaine (`ALL`,
`ALL_TCP`, `ALL_UDP`, `ALL_ICMP`, `HTTP`, `HTTPS`, `DNS`, `SSH`, `FTP`,
`SMTP`, `PING`, `TRACEROUTE`…). Ils sont **nécessaires** : le
laboratoire L1 écrit `set service "ALL"`, et sans catalogue prédéfini la
première commande échoue.

`FortiTableSpec.predefined` porte cette liste, et §44.2 la donne en
annexe.

### 19.4 `config firewall schedule`

Trois tables : `recurring`, `onetime`, `group`.

```
config firewall schedule recurring
    edit "HEURES_OUVREES"
        set day monday tuesday wednesday thursday friday
        set start 08:00
        set end 18:00
    next
end

config firewall schedule onetime
    edit "MAINTENANCE"
        set start 00:00 2026/09/01
        set end 06:00 2026/09/01
    next
end
```

| Attribut | Type | Défaut | → socle |
|---|---|---|---|
| `day` (recurring) | multi enum `sunday..saturday`/`none` | `none` | Objet horaire |
| `start` / `end` (recurring) | time `HH:MM` | `00:00` | idem |
| `start` / `end` (onetime) | `HH:MM YYYY/MM/DD` | — | idem |
| `expiration-days` (onetime) | integer | `3` | Alerte avant expiration |
| `color` | integer | `0` | — |

L'objet prédéfini `always` couvre tout, et il est référencé par défaut
par les politiques.

**Le socle a un objet horaire spécifié (BRD-Firewall §8.5) mais pas
implémenté** — l'inventaire §3.1 ne le liste pas. C'est donc une brique
**du socle** à livrer, et le `PolicyEvaluator` doit apprendre à
consulter `schedule` (il porte déjà `now` dans ses dépendances,
précisément pour cela).

Un horaire est **excellent pédagogiquement** parce qu'il rend le temps
observable : la même règle laisse passer à 10 h et refuse à 20 h, sous
horloge virtuelle avancée par le test.

### 19.5 Exigences — objets

| # | Exigence |
|---|---|
| **FGT-OBJ-1** | Les huit types d'adresse sont acceptés et évalués |
| **FGT-OBJ-2** | `all` est prédéfini, non modifiable, non supprimable |
| **FGT-OBJ-3** | Une adresse `fqdn` est résolue par le résolveur réel, avec cache, et `diagnose firewall fqdn list` le montre |
| **FGT-OBJ-4** | Les groupes s'imbriquent jusqu'à 10 niveaux ; au-delà, refus |
| **FGT-OBJ-5** | `exclude` retire des membres d'un groupe |
| **FGT-OBJ-6** | La syntaxe `dest[:source]` des plages de ports est acceptée |
| **FGT-OBJ-7** | Le catalogue de services prédéfinis de §44.2 existe |
| **FGT-OBJ-8** | Un objet référencé par une politique ne peut pas être supprimé, et le refus nomme les référents |
| **FGT-OBJ-9** | Les horaires `recurring` et `onetime` gouvernent réellement la correspondance de politique, sous horloge virtuelle |

---

## 20. `config firewall policy` — la politique

C'est le chapitre central.

### 20.1 La syntaxe

```
config firewall policy
    edit 1
        set name "LAN-vers-Internet"
        set srcintf "port1"
        set dstintf "port2"
        set srcaddr "LAN_SUBNET"
        set dstaddr "all"
        set action accept
        set schedule "always"
        set service "HTTP" "HTTPS" "DNS"
        set nat enable
        set logtraffic all
        set utm-status enable
        set av-profile "default"
        set webfilter-profile "default"
        set ssl-ssh-profile "certificate-inspection"
        set comments "Acces web des postes"
    next
end
```

### 20.2 Le tableau des attributs

Les attributs sont classés par famille, parce que c'est ainsi qu'un
apprenant les découvre.

**Identité**

| Attribut | Type | Défaut | → socle |
|---|---|---|---|
| `policyid` | integer (clé) | — | `SecurityRule.id` |
| `name` | string(35) | `''` | `SecurityRule.name` |
| `uuid` | uuid | généré | — (rendu par `show full-configuration`) |
| `status` | enable/disable | `enable` | `SecurityRule.enabled` |
| `comments` | string(1023) | `''` | `SecurityRule.comment` |

**Correspondance**

| Attribut | Type | Défaut | → socle |
|---|---|---|---|
| `srcintf` | multi reference interface **ou** zone | — | `SecurityRule.from` |
| `dstintf` | multi reference | — | `SecurityRule.to` |
| `srcaddr` | multi reference address/addrgrp | — | `SecurityRule.source` |
| `dstaddr` | multi reference address/addrgrp/vip | — | `SecurityRule.destination` |
| `srcaddr-negate` | enable/disable | `disable` | `sourceNegated` |
| `dstaddr-negate` | enable/disable | `disable` | `destinationNegated` |
| `service` | multi reference service/group | — | `SecurityRule.service` |
| `service-negate` | enable/disable | `disable` | `serviceNegated` |
| `schedule` | reference schedule | `always` | `SecurityRule.schedule` |
| `internet-service` | enable/disable | `disable` | Famille 2 (base FortiGuard) |
| `groups` | multi reference user.group | — | `SecurityRule.user` |
| `users` | multi reference user.local | — | idem |
| `application` | multi integer (ID FortiGuard) | — | Mode policy-based |

**Action**

| Attribut | Type | Défaut | → socle |
|---|---|---|---|
| `action` | `accept`/`deny`/`ipsec` | `deny` | `SecurityRule.action` |
| `inbound` / `outbound` | enable/disable | `disable` | Action `ipsec` |
| `vpntunnel` | reference | — | Action `ipsec` |

**NAT**

| Attribut | Type | Défaut | → socle |
|---|---|---|---|
| `nat` | enable/disable | `disable` | `SecurityRule.natEnabled` |
| `ippool` | enable/disable | `disable` | §21.3 |
| `poolname` | multi reference `firewall.ippool` | — | §21.3 |
| `fixedport` | enable/disable | `disable` | PAT sans changement de port |
| `natip` | ipv4-address-mask | `0.0.0.0 0.0.0.0` | NAT source vers une adresse fixe |

**Journalisation**

| Attribut | Type | Défaut | → socle |
|---|---|---|---|
| `logtraffic` | `all`/`utm`/`disable` | `utm` | §26 |
| `logtraffic-start` | enable/disable | `disable` | Journal à l'ouverture |
| `capture-packet` | enable/disable | `disable` | §30.5 |

**Inspection**

| Attribut | Type | Défaut | → socle |
|---|---|---|---|
| `utm-status` | enable/disable | `disable` | §25 |
| `inspection-mode` | `flow`/`proxy` | `flow` | §9 |
| `av-profile` | reference | — | §25 |
| `webfilter-profile` | reference | — | §25 |
| `dnsfilter-profile` | reference | — | §25 |
| `application-list` | reference | — | §25 |
| `ips-sensor` | reference | — | §25 |
| `file-filter-profile` | reference | — | §25 |
| `emailfilter-profile` | reference | — | §25 |
| `dlp-profile` | reference | — | §25 |
| `ssl-ssh-profile` | reference | `no-inspection` | §25 |
| `profile-protocol-options` | reference | `default` | §25 |
| `profile-group` | reference | — | §25 |

**Session et débit**

| Attribut | Type | Défaut | → socle |
|---|---|---|---|
| `session-ttl` | integer (s), `0` = défaut | `0` | `sessionTimeoutOverrideSec` |
| `tcp-session-without-syn` | `all`/`data-only`/`disable` | `disable` | `TcpStateMachine` |
| `anti-replay` | enable/disable | `enable` | Famille 2 |
| `traffic-shaper` | reference | — | §25.9 |
| `traffic-shaper-reverse` | reference | — | idem |
| `per-ip-shaper` | reference | — | idem |

**Matériel — famille 2 en bloc**

`auto-asic-offload`, `np-acceleration`, `wanopt`, `webcache`,
`disclaimer`, `replacemsg-override-group`.

### 20.3 `set action ipsec` — la politique de tunnel

`FORTIOS_PROFILE.supportedActions` déclare `['allow', 'deny']`. Il
manque `ipsec`, qui est l'action des VPN IPsec **en mode policy-based**
(par opposition au mode route-based, où le tunnel est une interface et
la politique est ordinaire).

```
config firewall policy
    edit 3
        set srcintf "port1"
        set dstintf "port2"
        set srcaddr "LAN_LOCAL"
        set dstaddr "LAN_DISTANT"
        set action ipsec
        set schedule "always"
        set service "ALL"
        set inbound enable
        set outbound enable
        set vpntunnel "vers_site_b"
    next
end
```

**Décision** : `supportedActions` gagne `'ipsec'`, et `RuleAction` du
socle aussi (il porte déjà `'tunnel'` et `'ipsec'` — vérification faite,
`SecurityRule.ts` les déclare tous les deux). Donc **rien à ajouter au
socle**, seulement au profil.

Le mode policy-based IPsec est **hérité** et déconseillé par Fortinet
depuis longtemps ; le mode route-based (interface de tunnel) est la
norme. Position retenue : **les deux sont acceptés**, parce qu'un
apprenant rencontre encore des configurations héritées, mais le
laboratoire L8 enseigne le mode route-based.

### 20.4 L'évaluation

`PolicyEvaluator` du socle fait déjà exactement ce qu'il faut :
parcours séquentiel, première correspondance, règle implicite terminale.
FortiOS y ajoute **trois nuances**.

**(a) La règle implicite porte l'identifiant 0.** Elle apparaît dans les
journaux sous `policyid=0`, et un apprenant qui voit ce numéro doit
comprendre « rien ne m'a correspondu ». `PolicyStore.implicitRule()`
existe avec `IMPLICIT_RULE_ID = '__implicit__'` ; le rendu FortiOS
l'affiche `0`.

**(b) Le trafic local est aussi rattaché à la politique 0.** Un journal
FortiAnalyzer montre `policyid=0` pour du trafic qui n'a pas été refusé
— c'est le trafic **vers** ou **depuis** la machine. C'est une source de
confusion documentée par Fortinet, et le simulateur doit la reproduire :
`local-in` et `local-out` portent `policyid=0`.

**(c) Une politique dont les interfaces sont `any`** est acceptée, mais
FortiOS avertit : une politique `any → any` est le contraire du
durcissement. Note de simulateur, famille F5.

### 20.5 L'ordre et `move`

```
config firewall policy
    move 5 before 2
end
```

Le laboratoire L4 est celui-ci : une règle large (`all → all, ALL,
accept`) placée en position 1 masque toutes les suivantes. L'apprenant
constate que sa règle fine ne compte aucun coup (`get firewall policy 7`
montre `hit count 0`), et `move` corrige.

**Les compteurs de coups sont donc indispensables** — sans eux, le
laboratoire n'est pas démontrable. `SecurityRule.hitCount` et
`byteCount` existent, et `PolicyEvaluator` les incrémente.

### 20.6 `config firewall security-policy`

En mode NGFW `policy-based` (§9.4), les règles applicatives migrent vers
cette table. Elle a les mêmes champs de correspondance, plus
`application` et `url-category`, et **moins** de champs UTM (ils sont
implicites).

**Décision de périmètre** : la table est déclarée au schéma et acceptée,
mais l'identification applicative réelle est hors périmètre (§25.4). Une
règle `security-policy` référençant une application se comporte donc
comme une règle qui ne correspond jamais — ce qui serait un piège.

**Donc** : en l'absence d'identification applicative, `set application`
est refusé **famille 2**, en nommant la brique manquante :

```
Command fail. Return code -61
NOTE: l'identification applicative n'est pas simulee (aucun moteur de
      signatures). `set application` est refuse plutot que d'installer une
      regle qui ne correspondrait jamais.
```

C'est P4 du socle appliqué sans complaisance : mieux vaut refuser que
d'accepter une règle inerte.

### 20.7 `config firewall local-in-policy`

Le trafic **vers** la machine.

```
config firewall local-in-policy
    edit 1
        set intf "port2"
        set srcaddr "all"
        set dstaddr "all"
        set action deny
        set service "HTTPS"
        set schedule "always"
        set status enable
    next
end
```

| Attribut | Type | Défaut |
|---|---|---|
| `intf` | reference interface | — |
| `srcaddr` | multi reference | — |
| `dstaddr` | multi reference | — |
| `service` | multi reference | — |
| `schedule` | reference | `always` |
| `action` | `accept`/`deny` | `deny` |
| `status` | enable/disable | `enable` |

**La différence avec `allowaccess`** mérite d'être enseignée :

| | `allowaccess` | `local-in-policy` |
|---|---|---|
| Granularité | Service, par interface | Source, destination, service, horaire |
| Ordre | Aucun | Séquence ordonnée |
| Défaut | Rien n'est ouvert | Tout ce qu'`allowaccess` a ouvert est permis |
| Position | Avant | Après |

Le laboratoire L12 est : `allowaccess ping https` sur le WAN, puis
`local-in-policy` qui refuse HTTPS sauf depuis une adresse
d'administration. On obtient un durcissement que `allowaccess` seul ne
sait pas exprimer.

**Implémentation** : une étape de pipeline `local-in-policy`, insérée
dans `Firewall.handleIpv4Frame()` au point où le paquet est reconnu
« pour nous ». C'est **une étape**, pas un moteur : le `PolicyEvaluator`
et un second `PolicyStore` suffisent.

### 20.8 `config firewall DoS-policy`

```
config firewall DoS-policy
    edit 1
        set interface "port2"
        set srcaddr "all"
        set dstaddr "all"
        set service "ALL"
        config anomaly
            edit "tcp_syn_flood"
                set status enable
                set action block
                set threshold 2000
            next
            edit "icmp_flood"
                set status enable
                set action block
                set threshold 250
            next
        end
    next
end
```

Le BRD générique §18 le spécifie. Ce qui est **réellement simulable** —
et c'est ce qui décide du périmètre :

| Anomalie | Simulable ? | Pourquoi |
|---|---|---|
| `tcp_syn_flood` | ✅ | Compter les SYN par seconde est exact |
| `udp_flood`, `icmp_flood` | ✅ | Idem |
| `tcp_port_scan`, `ip_dst_session` | ✅ | Compter des destinations distinctes |
| `tcp_src_session`, `udp_src_session` | ✅ | Compter des sessions par source |
| `ip_src_session` | ✅ | Idem |
| `tcp_land`, `ip_land` | ✅ | Source = destination, détectable |
| `winnuke` | 🟡 | Demande un drapeau URG sur port 139 |
| `ip_unknown_opt`, `ip_bad_option` | 🟡 | `PRD` §18.4 : les options IP ne sont pas modélisées |

Les seuils sont **des mesures par seconde**, donc ils demandent une
fenêtre glissante et une horloge — l'ordonnanceur virtuel du dépôt les
fournit, et un test peut générer 3000 SYN sous horloge accélérée.

### 20.9 Exigences — politique

| # | Exigence |
|---|---|
| **FGT-POL-1** | Tous les attributs de §20.2 non marqués « famille 2 » sont acceptés, validés et rendus |
| **FGT-POL-2** | `set action ipsec` existe, et `supportedActions` du profil le déclare |
| **FGT-POL-3** | La règle implicite est rendue avec l'identifiant `0` dans les vues et les journaux |
| **FGT-POL-4** | Le trafic local porte `policyid=0` dans les journaux |
| **FGT-POL-5** | `move` réordonne, et le laboratoire L4 le démontre par les compteurs de coups |
| **FGT-POL-6** | `srcaddr-negate` / `dstaddr-negate` / `service-negate` inversent la correspondance |
| **FGT-POL-7** | `session-ttl` remplace le délai par défaut de la session installée |
| **FGT-POL-8** | `tcp-session-without-syn` change le verdict de `TcpStateMachine` sur un flux sans SYN |
| **FGT-POL-9** | `local-in-policy` filtre le trafic vers la machine, après `allowaccess` |
| **FGT-POL-10** | `DoS-policy` compte réellement, sur les huit anomalies marquées ✅ |
| **FGT-POL-11** | `set application` est refusé en nommant la brique manquante |
| **FGT-POL-12** | Une politique `any → any` produit une note de simulateur |

---

## 21. `config firewall` — NAT

### 21.1 Les trois façons de traduire

FortiOS a **trois** mécanismes, et savoir lequel s'applique est la
moitié du sujet.

| Mécanisme | Direction | Où il se déclare | Mode |
|---|---|---|---|
| `set nat enable` sur la politique | Source | Dans la politique | NAT de politique (défaut) |
| `firewall vip` | Destination | Objet, référencé comme `dstaddr` | Les deux |
| `firewall central-snat-map` | Source | Table dédiée | NAT central |

### 21.2 Le NAT de politique — livré

`set nat enable` fait du PAT vers l'adresse de l'interface de sortie.
C'est **livré et vert** : `natIsPolicyField` → `applyPolicyNat()` dans
`coreStages.ts`, avec le témoin (« sans lui, la source n'est pas
traduite »).

### 21.3 Les pools d'adresses

```
config firewall ippool
    edit "POOL_SORTIE"
        set type overload
        set startip 203.0.113.20
        set endip 203.0.113.25
    next
    edit "POOL_1A1"
        set type one-to-one
        set startip 203.0.113.30
        set endip 203.0.113.39
    next
end

config firewall policy
    edit 1
        set nat enable
        set ippool enable
        set poolname "POOL_SORTIE"
    next
end
```

| Type | Sémantique |
|---|---|
| `overload` (défaut) | PAT sur la plage : plusieurs sources partagent une adresse, distinguées par le port |
| `one-to-one` | Une source ↔ une adresse, sans traduction de port ; le pool s'épuise |
| `fixed-port-range` | Plage de ports fixe par source interne |
| `port-block-allocation` | Blocs de ports attribués par source |

| Attribut | Type | Défaut | → socle |
|---|---|---|---|
| `type` | enum ci-dessus | `overload` | `SourceTranslation.kind` |
| `startip` / `endip` | ipv4 | — | Pool |
| `arp-reply` | enable/disable | `enable` | Réponse ARP proxy pour le pool |
| `associated-interface` | reference | `''` | — |
| `permit-any-host` | enable/disable | `disable` | — |

**`FirewallNatEngine` porte déjà** les pools et l'épuisement
(`nat-port-exhausted` est un verdict existant). `one-to-one` qui s'épuise
donne un refus visible, ce qui est le laboratoire à faire.

**`arp-reply` est un vrai mécanisme** : sans réponse ARP pour les
adresses du pool, le routeur amont ne sait pas où envoyer les réponses.
`ArpService` du socle sait répondre pour une adresse qu'il possède ; il
faut lui apprendre les adresses de pool. C'est la même question que
l'ARP proxy d'une VIP (§21.4).

### 21.4 La VIP — FGT-S5

```
config firewall vip
    edit "VIP_WEB"
        set extip 203.0.113.10
        set extintf "port2"
        set mappedip "192.168.50.10"
        set portforward enable
        set protocol tcp
        set extport 443
        set mappedport 8443
        set comment "Publication du serveur web"
    next
end
```

| Attribut | Type | Défaut | Disponible quand |
|---|---|---|---|
| `type` | `static-nat`/`load-balance`/`server-load-balance`/`dns-translation`/`fqdn` | `static-nat` | — |
| `extip` | ipv4-range | — | — |
| `extintf` | reference ou `any` | `any` | — |
| `mappedip` | ipv4-range (sous-table) | — | — |
| `portforward` | enable/disable | `disable` | — |
| `protocol` | `tcp`/`udp`/`sctp`/`icmp` | `tcp` | `portforward enable` |
| `extport` | port-range | — | `portforward enable` |
| `mappedport` | port-range | — | `portforward enable` |
| `arp-reply` | enable/disable | `enable` | — |
| `nat-source-vip` | enable/disable | `disable` | — |
| `srcintf-filter` | multi reference | — | — |

**Les deux natures de la VIP.** Une VIP est :

1. une **règle NAT de destination** (`extip:extport` → `mappedip:mappedport`), évaluée **avant** le routage ;
2. un **objet adresse** référençable comme `dstaddr` d'une politique.

Le socle absorbe cela par un `AddressObject` de genre `vip` portant une
référence vers sa `NatRule` — c'est ce que §28.6 du BRD générique
prévoit, et c'est une extension du modèle d'objets, pas un moteur.

**Le point de fidélité décisif** : la politique référence la **VIP**,
pas l'adresse interne. Donc `policySeesPreNatDestination` doit valoir
`true`, ce qui contredit la valeur livrée (§3.2). **Correction demandée :
`true`.**

Mécaniquement, `policyDestination()` de `coreStages.ts` rend déjà le
paquet original quand le drapeau est vrai — le code est prêt.

**L'ARP proxy** : `extip` n'est l'adresse d'aucune interface. Sans
réponse ARP, le routeur amont ne peut pas livrer le paquet. `arp-reply
enable` (le défaut) fait répondre le FortiGate à l'ARP pour `extip`.
C'est **indispensable** pour que le laboratoire L2 fonctionne sur le fil,
et c'est un ajout à `ArpService`.

**Le NAT en épingle** (hairpin) : un poste **interne** qui contacte
`203.0.113.10` doit atteindre le serveur interne. FortiOS demande alors
une politique de l'interne vers l'interne avec `set nat enable`, sans
quoi le serveur répond directement au client et la session casse. Le
BRD générique §12.8 le spécifie ; c'est un excellent laboratoire de
panne.

### 21.5 Le NAT central

```
config system settings
    set central-nat enable
end

config firewall central-snat-map
    edit 1
        set srcintf "port1"
        set dstintf "port2"
        set orig-addr "LAN_SUBNET"
        set dst-addr "all"
        set nat-ippool "POOL_SORTIE"
        set protocol 6
        set orig-port 0
        set nat-port 0
        set status enable
    next
end
```

| Attribut | Type | Défaut |
|---|---|---|
| `srcintf` / `dstintf` | multi reference | — |
| `orig-addr` / `dst-addr` | multi reference | — |
| `nat-ippool` | multi reference `firewall.ippool` | — |
| `protocol` | integer | `0` (tous) |
| `orig-port` / `nat-port` | port-range | `0` |
| `nat` | enable/disable | `enable` |
| `status` | enable/disable | `enable` |

**La bascule est structurante** : `set central-nat enable` fait
**disparaître** `set nat` de `config firewall policy`. Les deux modèles
ne coexistent pas. C'est le genre de fait qu'un simulateur doit
reproduire, parce qu'un apprenant qui bascule et ne trouve plus
`set nat` a besoin de comprendre pourquoi.

```
Command fail. Return code -61
NOTE: `central-nat` est actif ; le NAT source se declare dans
      `config firewall central-snat-map`, pas dans la politique.
```

`availableWhen` du schéma porte exactement cela.

**Côté socle** : `NatPolicyStore` porte déjà une table ordonnée de
règles NAT avec sections. Le NAT central s'y range directement, et
`natIsPolicyField` devient **dépendant du réglage du VDOM** — donc,
comme `applicationShift` (§9.5), une propriété calculée plutôt qu'une
constante du profil.

### 21.6 Exigences — NAT

| # | Exigence |
|---|---|
| **FGT-NAT-1** | `set nat enable` traduit vers l'adresse de sortie — **livré** |
| **FGT-NAT-2** | `ippool` + `poolname` traduisent vers le pool |
| **FGT-NAT-3** | Un pool `one-to-one` s'épuise, et l'épuisement est visible |
| **FGT-NAT-4** | Une VIP est un objet adresse **et** une règle NAT |
| **FGT-NAT-5** | La politique référence la VIP comme destination ; `policySeesPreNatDestination` vaut `true` |
| **FGT-NAT-6** | Le DNAT de VIP précède le routage, et un test le démontre |
| **FGT-NAT-7** | `arp-reply` fait répondre le FortiGate à l'ARP pour `extip` et pour les adresses de pool |
| **FGT-NAT-8** | Le NAT en épingle fonctionne avec la politique adéquate et échoue sans elle |
| **FGT-NAT-9** | `central-nat enable` fait disparaître `set nat` de la politique, en le disant |
| **FGT-NAT-10** | `central-snat-map` traduit réellement, sur le fil |
| **FGT-NAT-11** | `fixedport enable` conserve le port source |

---

## 22. `config router` — routage

### 22.1 `config router static`

```
config router static
    edit 1
        set dst 0.0.0.0 0.0.0.0
        set gateway 203.0.113.254
        set device "port2"
        set distance 10
        set priority 1
        set comment "Route par defaut"
    next
    edit 2
        set dst 10.0.0.0 255.0.0.0
        set blackhole enable
    next
end
```

| Attribut | Type | Défaut | → socle |
|---|---|---|---|
| `dst` | ipv4-address-mask | `0.0.0.0 0.0.0.0` | `RouteTable` |
| `gateway` | ipv4 | `0.0.0.0` | idem |
| `device` | reference interface | — | idem |
| `distance` | integer 1-255 | `10` | Distance administrative |
| `priority` | integer 1-65535 | `0` | Départage à distance égale |
| `weight` | integer 0-255 | `0` | ECMP pondéré |
| `blackhole` | enable/disable | `disable` | Route de trou noir |
| `status` | enable/disable | `enable` | — |
| `comment` | string | `''` | — |
| `link-monitor-exempt` | enable/disable | `disable` | §28 |
| `vrf` | integer | `0` | Famille 2 |
| `sdwan-zone` | multi reference | — | §28 |

**Deux points d'attention.**

**(a) La distance par défaut est 10**, pas 1. Une route statique
FortiOS est donc « moins crédible » qu'une route statique IOS
(distance 1). Détail, mais un apprenant qui compare le remarque.

**(b) `RouteTable` du socle a la brique**, mais deux comportements
demandés ici ne sont pas garantis par l'inventaire : `priority` et
`weight` (ECMP). `Router.ts` du dépôt a un vrai ECMP (`candidates`,
round-robin sur égalité) ; c'est la référence à suivre plutôt qu'une
seconde implémentation.

**(c) La route de trou noir** est un vrai mécanisme de sécurité (jeter
un préfixe plutôt que de le router par défaut), et il est facile à
démontrer.

### 22.2 `config router policy` — le routage par politique

```
config router policy
    edit 1
        set input-device "port1"
        set src "192.168.1.0/255.255.255.0"
        set dst "0.0.0.0/0.0.0.0"
        set protocol 6
        set start-port 80
        set end-port 80
        set gateway 203.0.113.253
        set output-device "port3"
    next
end
```

Le routage par politique est évalué **avant** la table de routage. Une
étape de pipeline le porte, insérée juste avant `route-lookup`.

C'est un excellent laboratoire — « le trafic web sort par le lien B, le
reste par le lien A » — et il est entièrement simulable **— corrigé en E36 : ce l'est pour les hôtes, qui ont un vrai TLS, PAS pour le pare-feu, qui n'a aucun point de terminaison TCP/TLS**.

### 22.3 Les protocoles dynamiques

`config router ospf`, `config router bgp`, `config router rip`.

**Le dépôt a des moteurs réels** (`ospf/`, `bgp/`, `rip/`) — mais ils
sont **couplés à `Router`**, pas à `Firewall`. C'est l'arbitrage le plus
lourd de ce chapitre.

Trois options, évaluées :

| Option | Coût | Risque |
|---|---|---|
| **A** — Découpler les moteurs de `Router` derrière un port étroit | Élevé | Touche du code très testé, hors module |
| **B** — Composer un `Router` interne dans `Firewall` | Moyen | Deux tables de routage à réconcilier — le défaut que ce dépôt referme partout |
| **C** — Refuser, famille 2, jusqu'à ce que A soit fait | Nul | Un FortiGate sans OSPF |

**Décision : C pour la livraison initiale, A comme travail suivant, B
jamais.** Motif : l'option B crée exactement la classe de défaut que le
dépôt passe son temps à rembourser (deux magasins pour un fait, qui
finissent par se contredire). L'option A est un travail propre mais
c'est un chantier de socle, pas de déclinaison — il est donc **nommé**
ici plutôt que caché, et §39 lui donne une phase.

Le refus nomme la brique :

```
Command fail. Return code -61
NOTE: OSPF existe dans ce simulateur mais son moteur est couple a la classe
      `Router` ; il n'est pas encore disponible sur un pare-feu. Utilisez
      `config router static`.
```

### 22.4 Les vues de routage

```
get router info routing-table all
get router info routing-table details 8.8.8.8
get router info kernel
```

```
Codes: K - kernel, C - connected, S - static, R - RIP, B - BGP
       O - OSPF, IA - OSPF inter area
       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2
       E1 - OSPF external type 1, E2 - OSPF external type 2
       i - IS-IS, L1 - IS-IS level-1, L2 - IS-IS level-2
       ia - IS-IS inter area, * - candidate default

S*      0.0.0.0/0 [10/0] via 203.0.113.254, port2
C       192.168.1.0/24 is directly connected, port1
C       203.0.113.0/24 is directly connected, port2
```

**Ce rendu passe obligatoirement par `TextTable.ts`.** L'alignement des
colonnes de routage est exactement le genre de mise en forme que le
module a été écrit pour porter, et la leçon `PRD-Tableaux-CLI.md` est
sans appel : un en-tête littéral et des lignes de données littérales
finissent par diverger.

### 22.5 Exigences — routage

| # | Exigence |
|---|---|
| **FGT-RTE-1** | `config router static` porte les attributs de §22.1 |
| **FGT-RTE-2** | La distance par défaut d'une statique est 10 |
| **FGT-RTE-3** | `blackhole enable` jette réellement le trafic |
| **FGT-RTE-4** | `priority` départage deux routes de même distance |
| **FGT-RTE-5** | L'ECMP répartit réellement, en réutilisant la logique éprouvée de `Router` |
| **FGT-RTE-6** | `config router policy` est évalué avant la table de routage |
| **FGT-RTE-7** | OSPF/BGP/RIP sont refusés famille 2 en nommant le couplage à `Router` |
| **FGT-RTE-8** | `get router info routing-table all` rend le tableau via `TextTable` |

---

## 23. `config user` et authentification

### 23.1 `config user local`

```
config user local
    edit "jdupont"
        set type password
        set passwd "Secret2026!"
        set status enable
    next
    edit "mmartin"
        set type radius
        set radius-server "RADIUS_AD"
    next
end
```

| Attribut | Type | Défaut |
|---|---|---|
| `type` | `password`/`radius`/`tacacs+`/`ldap` | `password` |
| `passwd` | password | — |
| `radius-server` / `ldap-server` / `tacacs+-server` | reference | — |
| `status` | enable/disable | `enable` |
| `two-factor` | `disable`/`fortitoken`/`email`/`sms` | `disable` |
| `email-to` | string | `''` |

`NetworkOsCredentialStore` du dépôt porte déjà les comptes, le
verrouillage après échecs et l'historique — et `NetworkOsAccount` a été
corrigé récemment pour refuser un compte verrouillé ou désactivé
(`authenticate()` commence par `if (this.locked || this.disabled)`).
**Réutilisation directe.**

### 23.2 `config user group`

```
config user group
    edit "COMMERCIAUX"
        set member "jdupont" "mmartin"
    next
    edit "AD_UTILISATEURS"
        set group-type firewall
        set member "RADIUS_AD"
        config match
            edit 1
                set server-name "RADIUS_AD"
                set group-name "CN=Ventes,OU=Groupes,DC=labo,DC=local"
            next
        end
    next
end
```

| Attribut | Type | Défaut |
|---|---|---|
| `group-type` | `firewall`/`fsso-service`/`rsso`/`guest` | `firewall` |
| `member` | multi reference user.* | — |
| `authtimeout` | integer (min) | `0` (hérite) |
| `auth-concurrent-override` | enable/disable | `disable` |

Sous-table `match` pour la correspondance de groupe distant.

### 23.3 L'authentification de politique

Une politique référençant `groups` ou `users` **exige une
authentification** avant de laisser passer. Le mécanisme FortiOS est :

1. le premier flux HTTP/HTTPS est intercepté ;
2. le FortiGate rend un portail d'authentification ;
3. l'utilisateur s'identifie ;
4. son adresse IP est **associée** à son identité pour une durée ;
5. le trafic passe.

**Ce qui est simulable** : la totalité, en réalité. Le dépôt a un serveur
HTTP réel, TLS réel, RADIUS réel, et un client HTTP réel
(`http/curl/`). Un laboratoire « je ne passe pas tant que je ne me suis
pas identifié, et `diagnose firewall auth list` me montre associé »
est **entièrement mesurable**.

**Décision** : c'est en périmètre, en phase tardive (§39, phase 7), et
c'est un des rares endroits où FortiOS demande un mécanisme neuf —
la **table d'association identité ↔ adresse**, qui est l'analogue du
`SessionTable` pour les utilisateurs.

### 23.4 RADIUS, TACACS+, LDAP

| Serveur | État du dépôt | Décision |
|---|---|---|
| `config user radius` | `radius/` complet (auth, acct, CoA, TCP) | ✅ Réutiliser |
| `config user tacacs+` | `tacacs/` complet, chiffrement réel | ✅ Réutiliser |
| `config user ldap` | ❌ Aucun client ni serveur LDAP | Refus famille 2 |
| `config user fsso` | ❌ | Refus famille 2 |
| `config user saml` | ❌ | Refus famille 2 |

**LDAP mérite une phrase** : c'est le connecteur d'annuaire le plus
courant en entreprise, et son absence est une vraie limite. Mais
l'écrire suppose un serveur LDAP simulé (schéma, DN, bind, recherche),
ce qui est un chantier à part entière — comparable à celui d'Oracle ou
d'Active Directory. Il est nommé en §43 comme travail futur identifié,
pas comme oubli.

### 23.5 Exigences — utilisateurs

| # | Exigence |
|---|---|
| **FGT-USR-1** | `config user local` s'appuie sur `NetworkOsCredentialStore` |
| **FGT-USR-2** | `config user group` compose des membres locaux et distants |
| **FGT-USR-3** | Une politique référençant un groupe exige l'authentification |
| **FGT-USR-4** | Le portail d'authentification est un vrai serveur HTTP/HTTPS |
| **FGT-USR-5** | L'association identité ↔ adresse expire, et `diagnose firewall auth list` la montre |
| **FGT-USR-6** | RADIUS et TACACS+ s'appuient sur les agents réels |
| **FGT-USR-7** | LDAP, FSSO et SAML sont refusés famille 2 |

---

## 24. `config vpn` — IPsec et SSL-VPN

### 24.1 Ce que le dépôt apporte

`ipsec/` porte un IKE réel (IKEv1 et IKEv2), avec échange de clés,
authentification par secret partagé, et ESP. `PRD-Serveur-HTTP-Cisco.md`
et les entrées `crypto/` de `CLAUDE.md` établissent en outre que la
cryptographie asymétrique et TLS sont **réels** — HKDF, AES-GCM, X25519,
RSA PKCS#1 v1.5, ECDSA P-256, tous confrontés à des vecteurs publiés.

Donc : **aucun moteur cryptographique à écrire.**

### 24.2 IPsec en mode interface (route-based)

C'est le mode normal, et celui du laboratoire L8.

```
config vpn ipsec phase1-interface
    edit "vers_site_b"
        set interface "port2"
        set ike-version 2
        set peertype any
        set net-device disable
        set proposal aes256-sha256
        set dhgrp 14
        set remote-gw 198.51.100.1
        set psksecret "SecretPartage2026"
    next
end

config vpn ipsec phase2-interface
    edit "vers_site_b_p2"
        set phase1name "vers_site_b"
        set proposal aes256-sha256
        set src-subnet 192.168.1.0 255.255.255.0
        set dst-subnet 192.168.2.0 255.255.255.0
        set pfs enable
        set dhgrp 14
        set keylifeseconds 43200
    next
end
```

**La création de `phase1-interface` crée une interface** portant le nom
du tunnel. Elle est ensuite utilisable comme n'importe quelle interface :

```
config router static
    edit 3
        set dst 192.168.2.0 255.255.255.0
        set device "vers_site_b"
    next
end

config firewall policy
    edit 4
        set srcintf "port1"
        set dstintf "vers_site_b"
        set srcaddr "LAN_LOCAL"
        set dstaddr "LAN_DISTANT"
        set action accept
        set schedule "always"
        set service "ALL"
    next
end
```

**C'est le point pédagogique du chapitre** : une fois le tunnel monté,
il n'y a plus de VPN — il y a une interface, une route et une politique.
Un apprenant qui a compris cela a compris le mode route-based.

Attributs principaux de `phase1-interface` :

| Attribut | Type | Défaut |
|---|---|---|
| `interface` | reference | — |
| `ike-version` | `1`/`2` | `1` |
| `type` | `static`/`dynamic`/`ddns` | `static` |
| `remote-gw` | ipv4 | `0.0.0.0` |
| `peertype` | `any`/`one`/`dialup`/`peer`/`peergrp` | `any` |
| `authmethod` | `psk`/`signature` | `psk` |
| `psksecret` | password | — |
| `certificate` | multi reference | — |
| `proposal` | multi enum | `aes128-sha256 aes256-sha256` |
| `dhgrp` | multi integer | `14 5` |
| `keylife` | integer (s) | `86400` |
| `dpd` | `disable`/`on-idle`/`on-demand` | `on-demand` |
| `net-device` | enable/disable | `disable` |
| `nattraversal` | `enable`/`disable`/`forced` | `enable` |

### 24.3 IPsec en mode tunnel (policy-based) — hérité

`config vpn ipsec phase1` / `phase2` (sans `-interface`), avec
`set action ipsec` sur la politique (§20.3). Accepté, non recommandé,
et l'aide le dit.

### 24.4 Les propositions et le refus honnête

`set proposal aes256-sha256` nomme un algorithme de chiffrement et un
algorithme d'intégrité. Ce que le dépôt sait vraiment faire décide de ce
qui est accepté :

| Proposition | État |
|---|---|
| `aes128-sha256`, `aes256-sha256` | ✅ AES-GCM/CBC et SHA-256 réels |
| `aes128-sha1`, `aes256-sha1` | ✅ SHA-1 réel |
| `3des-sha1` | ❌ **Refus** — `des.ts` exporte `desCbcEncrypt` et **pas** `desCbcDecrypt` ; un chiffrement qu'on ne sait pas déchiffrer perd les données |
| `des-md5` | ❌ Idem |
| `aes128gcm`, `aes256gcm` | ✅ |
| `chacha20poly1305` | ❌ Refus famille 2 |

**Le refus de 3DES est une décision déjà prise dans ce dépôt** et
documentée dans `CLAUDE.md` pour `openssl enc`. La même raison vaut ici,
et la cohérence entre les deux commandes est plus importante que la
couverture.

Groupes Diffie-Hellman : `IMPLEMENTED_GROUPS` de `keyExchange.ts` dit
lesquels sont réels. Les autres sont **refusés** — c'est exactement le
correctif décrit dans `CLAUDE.md` (« il ne reste plus rien de simulé »),
et le réintroduire ici serait une régression.

### 24.5 Les vues

```
get vpn ipsec tunnel name vers_site_b
diagnose vpn tunnel list
diagnose vpn ike gateway list
diagnose vpn tunnel reset vers_site_b
```

`diagnose vpn tunnel list` doit lire l'**état réel** de la session IKE,
pas une constante : c'est la même règle que partout ailleurs.

### 24.6 SSL-VPN

```
config vpn ssl settings
    set servercert "Fortinet_Factory"
    set tunnel-ip-pools "SSLVPN_TUNNEL_ADDR1"
    set source-interface "port2"
    set source-address "all"
    set default-portal "full-access"
    config authentication-rule
        edit 1
            set groups "COMMERCIAUX"
            set portal "full-access"
        next
    end
end
```

Trois modes : portail web, tunnel, et *bookmark*.

**Ce qui est simulable** : le portail web l'est entièrement (serveur
HTTPS réel, authentification réelle). Le mode tunnel demande une
interface virtuelle `ssl.root` et une attribution d'adresse — soit un
mécanisme neuf mais borné.

**Décision** : le portail web est en périmètre (phase 8) ; le mode
tunnel est nommé comme travail identifié en §43.

### 24.7 Exigences — VPN

| # | Exigence |
|---|---|
| **FGT-VPN-1** | `phase1-interface` crée une interface utilisable en routage et en politique |
| **FGT-VPN-2** | Le tunnel monte pour de vrai : IKE échangé sur le fil, ESP transporté |
| **FGT-VPN-3** | Le laboratoire L8 fait circuler un ping de bout en bout à travers le tunnel |
| **FGT-VPN-4** | Une proposition non implémentée est refusée en nommant l'algorithme |
| **FGT-VPN-5** | Un groupe DH hors `IMPLEMENTED_GROUPS` est refusé |
| **FGT-VPN-6** | Un secret partagé discordant fait échouer le tunnel, et le diagnostic le dit |
| **FGT-VPN-7** | `diagnose vpn tunnel list` lit l'état réel |
| **FGT-VPN-8** | Le mode policy-based est accepté et déconseillé par l'aide |

---

## 25. Les profils de sécurité (UTM)

### 25.1 La position honnête, d'abord

Un FortiGate détecte les virus, les intrusions et les catégories d'URL
grâce à des **bases de signatures** mises à jour par FortiGuard. Ce
simulateur n'en a aucune, et n'en aura pas.

Prétendre le contraire serait le pire défaut possible : un apprenant qui
croit avoir bloqué un virus alors que rien n'a été inspecté apprend une
fausse confiance.

**Ce que ce chapitre livre, donc :**

| Ce qui est réel | Ce qui est déclaré et refusé |
|---|---|
| L'**existence** des profils et leur application aux politiques | La détection par signature |
| Le **routage** du trafic vers l'inspection (`utm-status`) | Les bases FortiGuard |
| La détection **EICAR** | Les catégories d'URL en ligne |
| Un catalogue **local** de catégories d'URL | Le contrôle applicatif |
| Le blocage par **extension de fichier** | L'analyse heuristique |
| Le **journal UTM** | Le sandboxing |

### 25.2 `config antivirus profile`

```
config antivirus profile
    edit "strict"
        set comment "Analyse complete"
        config http
            set av-scan block
            set archive-block encrypted corrupted
        end
        config ftp
            set av-scan block
        end
    next
end
```

**La détection EICAR** est la seule honnête : le fichier de test EICAR
est une chaîne ASCII de 68 octets, définie publiquement précisément pour
tester une chaîne antivirus sans virus. Un simulateur qui la détecte ne
ment pas.

Le laboratoire : on télécharge le fichier EICAR par HTTP à travers une
politique portant `set av-profile "strict"`, et la transmission est
bloquée avec un message de remplacement. C'est **exact**, entièrement.

`ObjectStore` n'a rien à voir là-dedans : c'est une inspection de
contenu, donc une étape `utm-inspect` du pipeline qui examine la charge
utile HTTP. Le dépôt a un moteur HTTP réel des deux côtés, donc la
charge utile **existe**.

### 25.3 `config webfilter profile`

```
config webfilter profile
    edit "entreprise"
        config ftgd-wf
            unset options
            config filters
                edit 1
                    set category 26
                    set action block
                next
            end
        end
        config web
            config urlfilter
                …
            end
        end
        set log-all-url enable
    next
end
```

**Ce qui est simulable** : le filtrage par **URL explicite** (liste
locale de motifs) et par **catégorie locale**. Un catalogue de
catégories restreint (§44.3) suffit à enseigner le mécanisme :
« réseaux sociaux », « jeux », « contenu pour adultes », avec une table
locale de domaines de démonstration.

**Ce qui ne l'est pas** : la classification FortiGuard réelle. Un
domaine hors catalogue est **non classé**, et le profil décide quoi
faire des non classés — ce qui est exactement le comportement réel
quand la licence est expirée, donc une situation authentique.

### 25.4 `config application list` et `config ips sensor`

Les deux demandent un moteur de signatures. **Refusés, famille 2**, en
nommant la brique :

```
Command fail. Return code -61
NOTE: le controle applicatif demande une base de signatures FortiGuard ;
      ce simulateur n'en a aucune. `config application list` est refuse
      plutot que d'installer un profil qui n'inspecterait rien.
```

C'est cohérent avec §20.6, qui refuse `set application` pour la même
raison.

### 25.5 `config ssl-ssh-profile`

```
config firewall ssl-ssh-profile
    edit "inspection-profonde"
        set caname "Fortinet_CA_SSL"
        config https
            set ports 443
            set status deep-inspection
        end
    next
end
```

Trois modes :

| Mode | Ce que la machine fait |
|---|---|
| `disable` | Rien |
| `certificate-inspection` | Lit le SNI et le certificat, ne déchiffre pas |
| `deep-inspection` | **Intercepte** : présente son propre certificat au client, ouvre sa propre session TLS vers le serveur |

**`deep-inspection` est entièrement simulable, et c'est remarquable** :
le dépôt a un TLS réel des deux côtés, une PKI réelle, et un
`CertificateVerifier` qui vérifie vraiment (`curl --cacert` a été le
premier consommateur, et il a révélé trois défauts qui dormaient).

Le laboratoire est excellent : sans le certificat de l'autorité du
FortiGate dans le magasin du client, le navigateur **refuse** — c'est
l'erreur que tout le monde rencontre en déployant l'inspection
profonde. Le simulateur peut la produire, et la résoudre en installant
l'autorité.

`certificate-inspection` demande de lire le **SNI** du `ClientHello`,
ce qui est du ressort du moteur TLS existant.

### 25.6 `config dnsfilter profile`

Filtrage au niveau DNS : la requête est interceptée et la réponse
remplacée. Simulable — le résolveur du dépôt est réel — avec le même
catalogue local que §25.3.

### 25.7 `config file-filter profile`

Blocage par **type de fichier**, déterminé par extension et par nombre
magique. Simulable, sans signatures : détecter `MZ`, `PK`, `%PDF-`,
`\x7fELF` est de la lecture d'octets, pas de la détection de menace.

### 25.8 `config firewall profile-protocol-options`

Décide **quels ports** sont considérés comme portant quel protocole
pour l'inspection.

```
config firewall profile-protocol-options
    edit "default"
        config http
            set ports 80 8080
        end
        config https
            set ports 443
        end
    next
end
```

Utile et simulable : c'est ce qui explique qu'un serveur web sur le port
8888 échappe au filtrage web tant qu'on ne l'a pas déclaré.

### 25.9 Le contrôle de débit

```
config firewall shaper traffic-shaper
    edit "limite_10M"
        set maximum-bandwidth 10000
        set priority medium
    next
end

config firewall shaping-policy
    edit 1
        set service "ALL"
        set srcaddr "LAN_SUBNET"
        set dstaddr "all"
        set traffic-shaper "limite_10M"
    next
end
```

**Position honnête** : le simulateur livre les trames de façon
synchrone, sans horloge de fil. Un limiteur de débit ne peut donc pas
ralentir quoi que ce soit. Deux options :

- **A** — Refus famille 2, en nommant l'absence de latence de câble.
- **B** — Compter et rendre les compteurs, sans limiter.

**Décision : A.** L'option B est exactement le défaut « rangé et lu par
personne » sous une autre forme : des compteurs qui montent sans que
rien ne soit limité laissent croire que la limitation a lieu. Le
précédent du dépôt est net — `rate-limit` de Cisco a d'abord été livré
« stocké et affiché avec zéro compteur », ce qui a été jugé décoratif et
**remplacé** par un vrai seau à jetons. Ici, le seau ne peut pas exister
faute d'horloge de fil ; donc on refuse.

Si `Cable` gagne un jour une latence, la décision se rouvre — c'est le
même conditionnel que celui écrit pour IP SLA (« `overThreshold` devient
observable le jour où `Cable` porte une latence »).

### 25.10 Exigences — UTM

| # | Exigence |
|---|---|
| **FGT-UTM-1** | Les profils existent, s'attachent aux politiques et sont rendus |
| **FGT-UTM-2** | `utm-status disable` court-circuite l'étape `utm-inspect` |
| **FGT-UTM-3** | Le fichier EICAR est détecté et bloqué en HTTP et en FTP |
| **FGT-UTM-4** | Un fichier ordinaire passe — le témoin |
| **FGT-UTM-5** | Le filtrage d'URL bloque par motif explicite et par catégorie locale |
| **FGT-UTM-6** | Un domaine hors catalogue est « non classé », et le profil décide |
| **FGT-UTM-7** | ~~`deep-inspection` intercepte réellement~~ — **REFUSÉ famille 2** (E36) : l'interception exige de terminer la session du client et de la ré-émettre sous un certificat re-signé ; le pare-feu achemine des paquets et ne détient aucun point de terminaison TCP/TLS. L'accepter laisserait la session chiffrée pendant que la CLI annoncerait le déchiffrement |
| **FGT-UTM-8** | ~~Sans l'autorité dans son magasin, le client refuse~~ — sans objet, découle de FGT-UTM-7 |
| **FGT-UTM-9** | `certificate-inspection` lit le SNI sans déchiffrer |
| **FGT-UTM-10** | Le filtrage de fichiers reconnaît les nombres magiques |
| **FGT-UTM-11** | `profile-protocol-options` décide quels ports sont inspectés |
| **FGT-UTM-12** | Contrôle applicatif, IPS, DLP et limitation de débit sont refusés famille 2 |

---

## 26. `config log` — journalisation

### 26.1 Les cibles

| Cible | Chemin | État du dépôt |
|---|---|---|
| Mémoire | `config log memory setting` | `LoggingConfig` (tampon) |
| Disque | `config log disk setting` | Système de fichiers |
| Syslog (4 collecteurs) | `config log syslogd[2\|3\|4] setting` | `SyslogAgent` réel |
| FortiAnalyzer | `config log fortianalyzer setting` | Famille 2 |
| FortiCloud | `config log fortiguard setting` | Famille 2 |

```
config log syslogd setting
    set status enable
    set server "192.168.1.200"
    set port 514
    set mode udp
    set facility local7
    set source-ip 192.168.1.1
    set format default
end

config log syslogd filter
    set severity information
    set forward-traffic enable
    set local-traffic disable
    set sniffer-traffic disable
    set anomaly enable
end
```

### 26.2 Le format

§17.5 le donne : des couples `clé=valeur`, un par ligne, sans
hiérarchie. `set format {default | csv | cef | rfc5424}` change la mise
en forme.

**C'est une différence pédagogique réelle** avec le syslog Cisco que le
dépôt produit déjà. Un apprenant qui a vu `%SYS-5-CONFIG_I` découvre un
autre monde, et c'est instructif.

`SyslogCatalog` du socle porte `id` et `severity` ; il lui faut un
**formateur par vendeur**. Extension du socle, prévue par §26 du BRD
générique.

### 26.3 Les types de journaux

| Type | `type=` | Contenu |
|---|---|---|
| Trafic | `traffic` | Sessions, sous-types `forward`, `local`, `sniffer`, `multicast` |
| Événement | `event` | Système, administrateur, VPN, HA, routage |
| UTM | `utm` | Virus, webfilter, IPS, application |

`set logtraffic {all | utm | disable}` sur la politique décide :

| Valeur | Ce qui est journalisé |
|---|---|
| `all` | Toutes les sessions |
| `utm` (défaut) | Seulement celles ayant déclenché un profil |
| `disable` | Rien |

**Point à ne pas rater** : `logtraffic all` journalise à la **fermeture**
de la session (avec les octets et la durée), pas à l'ouverture.
`set logtraffic-start enable` ajoute un journal à l'ouverture. Deux
lignes pour une session, et c'est mesurable.

### 26.4 Les vues

```
execute log filter category traffic
execute log filter field srcip 192.168.1.10
execute log filter view-lines 100
execute log display
execute log delete-all
```

`ArchiveService` de Cisco (`archive/`) est un précédent utile : il a
appris à ce dépôt qu'un journal circulaire, borné, relu par une vue,
demande que la vue **lise** réellement le magasin — le défaut d'origine y
était que `show archive log config` n'existait pas alors que le journal
était rempli.

### 26.5 Exigences — journalisation

| # | Exigence |
|---|---|
| **FGT-LOG-1** | Les quatre collecteurs syslog existent et émettent réellement |
| **FGT-LOG-2** | Le format est en couples `clé=valeur`, conforme à §17.5 |
| **FGT-LOG-3** | `set format {csv\|cef\|rfc5424}` change la mise en forme |
| **FGT-LOG-4** | `logtraffic all` journalise à la fermeture, avec octets et durée |
| **FGT-LOG-5** | `logtraffic-start enable` ajoute une ligne à l'ouverture |
| **FGT-LOG-6** | `source-ip` choisit une **adresse**, pas une interface de sortie — leçon `management-source-interface` |
| **FGT-LOG-7** | `execute log filter` + `execute log display` lisent le vrai magasin |
| **FGT-LOG-8** | Le journal mémoire est circulaire et borné |

---

## 27. `config system ha` — haute disponibilité

### 27.1 Le modèle FGCP

```
config system ha
    set group-name "cluster-paris"
    set group-id 10
    set mode a-p
    set password "SecretHA"
    set hbdev "port7" 50 "port8" 100
    set session-pickup enable
    set priority 200
    set override enable
    set monitor "port1" "port2"
end
```

| Attribut | Type | Défaut |
|---|---|---|
| `mode` | `standalone`/`a-a`/`a-p` | `standalone` |
| `group-id` | integer 0-255 | `0` |
| `group-name` | string | `''` |
| `password` | password | `''` |
| `hbdev` | multi (interface + priorité) | — |
| `priority` | integer 0-255 | `128` |
| `override` | enable/disable | `disable` |
| `monitor` | multi reference interface | — |
| `session-pickup` | enable/disable | `disable` |
| `hb-interval` | integer (×100 ms) | `2` |
| `hb-lost-threshold` | integer | `6` |

### 27.2 L'élection

L'ordre de départage, dans l'ordre :

1. Le plus grand nombre d'interfaces surveillées **actives** ;
2. La plus grande **priorité** ;
3. La plus grande durée de fonctionnement (par tranches de 5 min) ;
4. Le plus grand numéro de série.

C'est **exactement** le genre de règle qu'un simulateur peut rendre
observable et qu'un cours peine à faire retenir : on débranche un câble
surveillé, et le rôle bascule bien qu'on n'ait touché à aucune priorité.

`override enable` change le comportement au retour : sans lui, le
membre revenu reste secondaire.

### 27.3 Ce que le dépôt apporte

`vrrp/` et `hsrp/` portent des machines à états de redondance réelles,
avec élection, priorité, préemption, surveillance d'interface et
messages sur le fil. **Le mécanisme d'élection est le même** ; ce sont
les messages et les critères qui diffèrent.

**Décision** : `HaAgent` est écrit dans le socle pare-feu (parce que
PAN-OS et Junos en auront besoin) en s'inspirant de `VrrpAgent`, pas en
le réutilisant tel quel — les critères de départage sont différents et
forcer la réutilisation produirait un agent paramétré au point d'être
illisible.

**Contrainte P6 du socle : la synchronisation traverse le fil.** Les
battements de cœur sont de vraies trames sur `hbdev`, et débrancher le
câble de synchronisation produit un **cerveau divisé** — les deux
membres se croient primaires. C'est le laboratoire le plus instructif de
tout le chapitre, et il n'existe que si l'on refuse le raccourci d'une
synchronisation en mémoire.

### 27.4 Ce qui est synchronisé

| Objet | Synchronisé ? |
|---|---|
| Configuration | ✅ Intégralement, sauf le nom d'hôte et la priorité |
| Sessions | ✅ Si `session-pickup enable` |
| Table de routage | ✅ |
| Baux DHCP | ✅ |
| Journaux | ❌ Locaux à chaque membre |

`session-pickup` est un excellent laboratoire : avec, un transfert de
fichier survit au basculement ; sans, il casse.

### 27.5 Les vues

```
get system ha status
diagnose sys ha status
diagnose sys ha checksum show
execute ha manage 1
execute ha failover set
```

`diagnose sys ha checksum show` compare les empreintes de configuration
des membres — c'est ainsi qu'on diagnostique une désynchronisation, et
c'est mesurable.

### 27.6 Exigences — HA

| # | Exigence |
|---|---|
| **FGT-HA-1** | Deux FortiGate câblés forment un cluster et élisent un primaire |
| **FGT-HA-2** | Les battements de cœur sont de vraies trames sur `hbdev` |
| **FGT-HA-3** | L'ordre de départage de §27.2 est respecté, et chaque critère a son test |
| **FGT-HA-4** | La perte d'une interface surveillée provoque un basculement |
| **FGT-HA-5** | Débrancher `hbdev` produit un cerveau divisé observable |
| **FGT-HA-6** | La configuration est synchronisée par le fil |
| **FGT-HA-7** | `session-pickup enable` fait survivre une session au basculement ; sans lui, elle casse |
| **FGT-HA-8** | `diagnose sys ha checksum show` détecte une désynchronisation réelle |

---

## 28. SD-WAN

### 28.1 Le modèle

```
config system sdwan
    set status enable
    config zone
        edit "virtual-wan-link"
        next
    end
    config members
        edit 1
            set interface "port2"
            set gateway 203.0.113.254
            set priority 1
        next
        edit 2
            set interface "port3"
            set gateway 198.51.100.254
            set priority 2
        next
    end
    config health-check
        edit "vers_internet"
            set server "8.8.8.8"
            set protocol ping
            set interval 500
            set failtime 5
            set recoverytime 5
            set members 1 2
            config sla
                edit 1
                    set latency-threshold 100
                    set packetloss-threshold 2
                next
            end
        next
    end
    config service
        edit 1
            set name "web_par_lien_A"
            set dst "all"
            set src "LAN_SUBNET"
            set priority-members 1 2
            set mode sla
            config sla
                edit "vers_internet"
                    set id 1
                next
            end
        next
    end
end
```

### 28.2 Ce qui est simulable, et ce qui ne l'est pas

| Aspect | Simulable ? |
|---|---|
| Sonde de santé (ping, HTTP, DNS) | ✅ Les trois protocoles sont réels |
| Détection de perte de lien | ✅ Un câble débranché est mesurable |
| Bascule sur perte | ✅ |
| Répartition par priorité | ✅ |
| Répartition par source/destination | ✅ |
| Seuil de **latence** | ❌ Livraison synchrone, latence toujours nulle |
| Seuil de **gigue** | ❌ Idem |
| Seuil de **perte** | 🟡 `Cable.packetLossRate` existe — donc **oui** |

**La perte de paquets est mesurable** parce que `Cable` porte déjà
`packetLossRate` et `corruptionRate` (voir `CLAUDE.md`). C'est une
bonne nouvelle : le seuil SLA le plus parlant — « bascule quand le lien
perd plus de 2 % » — est démontrable en réglant la perte du câble.

**La latence ne l'est pas**, et c'est la même limite qu'IP SLA a
mesurée et écrite : « le RTT est de 0 ms en temps virtuel ». La
cohérence entre les deux modules impose de dire la même chose ici.

### 28.3 Exigences — SD-WAN

| # | Exigence |
|---|---|
| **FGT-SDW-1** | Les membres, les zones et les sondes se déclarent |
| **FGT-SDW-2** | Une sonde ping/HTTP/DNS interroge réellement la cible |
| **FGT-SDW-3** | Un lien coupé sort de la sélection, et un test le mesure |
| **FGT-SDW-4** | Un seuil de perte fait basculer, en réglant `Cable.packetLossRate` |
| **FGT-SDW-5** | Les seuils de latence et de gigue sont acceptés, jamais franchis, et la limite est écrite dans l'aide |
| **FGT-SDW-6** | `diagnose sys sdwan health-check` rend une mesure |

---

## 29. Les commandes `execute`

### 29.1 Le catalogue retenu

| Commande | Effet | État |
|---|---|---|
| `execute ping <hôte>` | Écho ICMP | ✅ Socle |
| `execute ping-options …` | Taille, nombre, source, TTL | ✅ |
| `execute ping6 <hôte>` | ICMPv6 | 🟡 |
| `execute traceroute <hôte>` | Trace | ✅ |
| `execute telnet <hôte>` | Client telnet | ✅ `protocols/telnet/` |
| `execute ssh <hôte>` | Client SSH | ✅ |
| `execute date [<date>]` | Horloge | ✅ |
| `execute time [<heure>]` | Horloge | ✅ |
| `execute reboot` | Redémarrage | ✅ Cycle d'alimentation |
| `execute shutdown` | Arrêt | ✅ |
| `execute factoryreset` | Retour d'usine | ✅ |
| `execute backup config <cible>` | Sauvegarde | §29.4 |
| `execute restore config <cible>` | Restauration | §29.4 |
| `execute revision list config` | Révisions | §29.5 |
| `execute revision restore config <n>` | Retour arrière | §29.5 |
| `execute dhcp lease-list [<iface>]` | Baux | ✅ `dhcp/` |
| `execute dhcp lease-clear` | Purge | ✅ |
| `execute clear system arp table` | Purge ARP | ✅ `ArpService` |
| `execute log display` | Lecture des journaux | §26.4 |
| `execute log filter …` | Filtre | §26.4 |
| `execute log delete-all` | Purge | §26.4 |
| `execute ha manage <n>` | CLI du secondaire | §27.5 |
| `execute ha failover set` | Bascule forcée | §27.5 |
| `execute vpn ipsec tunnel up <nom>` | Monte un tunnel | §24.5 |
| `execute update-now` | Mise à jour FortiGuard | Famille 2 |
| `execute formatlogdisk` | Formatage | Famille 2 |
| `execute usb-disk list` | USB | Famille 2 |

### 29.2 `execute ping-options`

```
execute ping-options source 192.168.1.1
execute ping-options repeat-count 10
execute ping-options data-size 1400
execute ping-options df-bit yes
execute ping 8.8.8.8
```

Les options sont **rémanentes** : elles s'appliquent aux `ping`
suivants, jusqu'à `execute ping-options reset`. C'est déroutant la
première fois, et donc pédagogique.

`df-bit yes` avec une taille supérieure au MTU produit une
fragmentation nécessaire — et le dépôt sait le faire
(`Ipv4Fragmentation.ts`, RFC 791 §3.2, avec ICMP *Fragmentation Needed*
quand DF est posé).

### 29.3 `execute dhcp lease-list`

```
FGT1 # execute dhcp lease-list port1
IP              MAC-Address        Hostname     VCI       Expiry
192.168.1.100   00:0c:29:1a:2b:3c  poste-01     MSFT 5.0  Mon Aug 17 09:14:22 2026
```

Lit la **vraie** table de baux du serveur DHCP. Rendu via `TextTable`.

### 29.4 Sauvegarde et restauration

```
execute backup config tftp fgt-config.conf 192.168.1.200
execute restore config tftp fgt-config.conf 192.168.1.200
```

`tftp/` existe dans le dépôt. Le fichier produit est **exactement** la
sortie de `show full-configuration` — donc la restauration est un rejeu,
et FGT-SCH-9 (« la sortie de `show` est rejouable ») est ce qui la rend
possible.

**C'est un très bon laboratoire** : sauvegarder, casser la
configuration, restaurer, constater le retour. Il se joue entièrement
sur le fil, avec un vrai serveur TFTP sur un vrai poste.

### 29.5 Les révisions

FortiOS garde des révisions de configuration :

```
execute revision list config
execute revision restore config 3
execute revision delete config 2
```

`ArchiveService` de Cisco est le précédent direct : il écrit de vrais
fichiers dans le `flash:` de l'équipement, `dir flash:` les montre avec
leur taille, `more` les relit, et `maximum` supprime le plus ancien.
Toute cette mécanique est réutilisable ; seule la commande change.

### 29.6 Exigences — `execute`

| # | Exigence |
|---|---|
| **FGT-EXE-1** | Les commandes marquées ✅ agissent réellement |
| **FGT-EXE-2** | `ping-options` est rémanent, et `reset` le remet à zéro |
| **FGT-EXE-3** | `df-bit yes` avec une taille excessive produit le refus ICMP correct |
| **FGT-EXE-4** | `execute backup config tftp` écrit un fichier sur un vrai serveur TFTP |
| **FGT-EXE-5** | Le fichier sauvegardé est rejouable par `execute restore` |
| **FGT-EXE-6** | Les révisions écrivent de vrais fichiers, comme `ArchiveService` |
| **FGT-EXE-7** | `execute factoryreset` demande confirmation et remet vraiment à zéro |

---

## 30. Les commandes `diagnose` et `get`

### 30.1 La table de sessions

```
FGT1 # diagnose sys session filter dst 203.0.113.10
FGT1 # diagnose sys session list

session info: proto=6 proto_state=01 duration=19 expire=3597 timeout=3600
flags=00000000 sockflag=00000000 sockport=0 av_idx=0 use=3
origin-shaper=
reply-shaper=
per_ip_shaper=
class_id=0 ha_id=0 policy_dir=0 tunnel=/ vlan_cos=0/255
state=may_dirty
statistic(bytes/packets/allow_err): org=1420/14/1 reply=3812/16/1 tuples=2
tx speed(Bps/kbps): 74/0 rx speed(Bps/kbps): 200/1
orgin->sink: org pre->post, reply pre->post dev=5->6/6->5
gwy=203.0.113.254/192.168.1.10
hook=post dir=org act=snat 192.168.1.10:44001->203.0.113.10:443(203.0.113.1:44001)
hook=pre dir=reply act=dnat 203.0.113.10:443->203.0.113.1:44001(192.168.1.10:44001)
misc=0 policy_id=1 auth_info=0 chk_client_info=0 vd=0
serial=00001a2b tos=ff/ff app_list=0 app=0 url_cat=0
total session 1
```

**C'est la sortie la plus dense de FortiOS, et la plus utile.** Chaque
champ correspond à un fait que `FirewallSession` porte déjà :

| Champ | Source |
|---|---|
| `proto` | `FlowKey.protocol` |
| `proto_state` | `FirewallSession.tcpState` |
| `duration` | `now - createdAt` |
| `expire` / `timeout` | `expiresAt`, `timeoutSec` |
| `statistic(...)` | `SessionCounters` |
| `dev=a->b/b->a` | Indices d'interface |
| `gwy=` | Passerelles résolues |
| `hook=post dir=org act=snat` | `SessionTranslation` |
| `policy_id` | `FirewallSession.policyId` |
| `vd` | VDOM |
| `total session N` | `SessionTable.count()` |

Le `FortiShell` actuel rend une version très réduite de ces deux
dernières lignes. La cible est le rendu complet, **lu depuis la table
réelle** — ce qu'il fait déjà pour ce qu'il rend.

**Les filtres :**

```
diagnose sys session filter src 192.168.1.10
diagnose sys session filter dst 203.0.113.10
diagnose sys session filter dport 443
diagnose sys session filter proto 6
diagnose sys session filter policy 1
diagnose sys session filter vd 0
diagnose sys session filter clear
diagnose sys session clear      ← purge SELON LE FILTRE
```

**Piège réel et à reproduire** : `diagnose sys session clear` **sans
filtre purge toute la table**. C'est une erreur d'exploitation classique.
`SessionTable.clearMatching()` existe ; le filtre s'y branche
directement.

### 30.2 `diagnose debug flow`

L'équivalent FortiOS de `packet-tracer`. Même source (`ctx.trace`),
autre rendu — et c'est exactement ce que le socle a prévu.

```
diagnose debug reset
diagnose debug flow filter addr 192.168.1.10
diagnose debug flow show function-name enable
diagnose debug flow trace start 10
diagnose debug enable
```

```
id=20085 trace_id=1 func=print_pkt_detail line=5590 msg="vd-root:0 received a
 packet(proto=6, 192.168.1.10:44001->203.0.113.10:443) tun_id=0.0.0.0 from port1."
id=20085 trace_id=1 func=init_ip_session_common line=5760 msg="allocate a new
 session-00001a2b"
id=20085 trace_id=1 func=vf_ip_route_input_common line=2611 msg="find a route:
 flag=04000000 gw-203.0.113.254 via port2"
id=20085 trace_id=1 func=fw_forward_handler line=771 msg="Allowed by Policy-1: SNAT"
id=20085 trace_id=1 func=__ip_session_run_tuple line=3546 msg="SNAT
 192.168.1.10->203.0.113.1:44001"
```

**Le cas du refus est celui qui compte :**

```
id=20085 trace_id=2 func=print_pkt_detail line=5590 msg="vd-root:0 received a
 packet(proto=6, 192.168.1.10:44002->203.0.113.99:22) from port1."
id=20085 trace_id=2 func=init_ip_session_common line=5760 msg="allocate a new
 session-00001a2c"
id=20085 trace_id=2 func=vf_ip_route_input_common line=2611 msg="find a route:
 flag=04000000 gw-203.0.113.254 via port2"
id=20085 trace_id=2 func=fw_forward_handler line=749 msg="Denied by forward
 policy check (policy 0)"
```

`policy 0` est la règle implicite (§20.4). Un apprenant qui voit cette
ligne sait immédiatement qu'aucune politique ne correspond — et c'est
90 % des diagnostics.

**Position sur les numéros de ligne** (`line=5590`) : ce sont les lignes
du code source de FortiOS. Les reproduire à l'identique serait inventer
des constantes sans signification. **Décision** : les noms de fonction
sont reproduits (ils sont stables, documentés partout, et cherchables),
les numéros de ligne sont rendus **constants par type de message** et
la note du simulateur le dit une fois lors du premier usage.

### 30.3 `diagnose firewall iprope list`

Les politiques telles que compilées par le moteur, avec leurs
compteurs. C'est la vue qui prouve qu'une règle est ou non consultée.

```
diagnose firewall iprope list
diagnose firewall iprope show 100004 1
```

### 30.4 Les vues `get`

| Commande | Contenu |
|---|---|
| `get system status` | Version, série, mode, VDOM courant, temps de fonctionnement |
| `get system performance status` | CPU, mémoire, sessions, débit |
| `get system interface [physical]` | État des interfaces |
| `get system arp` | Table ARP |
| `get router info routing-table all` | Routage |
| `get firewall policy [<id>]` | Politique, avec compteurs |
| `get vpn ipsec tunnel summary` | Tunnels |
| `get system ha status` | Cluster |

`get system status` de la base actuelle rend quatre lignes en dur. La
cible :

```
FGT1 # get system status
Version: FortiGate-VM64 v7.4.4,build2662,240614 (GA.F)
Firmware Signature: certified
Virus-DB: 1.00000(2018-04-09 18:07)
IPS-DB: 6.00741(2015-12-01 02:30)
Serial-Number: FGVMEV0000000001
IPS Malicious URL Database: 1.00001(2015-01-01 01:01)
License Status: Valid
VM Resources: 1 CPU/2 allowed, 2048 MB RAM
Log hard disk: Not available
Hostname: FGT1
Operation Mode: NAT
Current virtual domain: root
Max number of virtual domains: 10
Virtual domains status: 1 in NAT mode, 0 in TP mode
Virtual domain configuration: disable
FIPS-CC mode: disable
Current HA mode: standalone
Branch point: 2662
Release Version Information: GA
System time: Mon Aug 17 09:14:22 2026
```

**Chaque ligne doit être LUE**, pas écrite en dur : le nom d'hôte vient
de l'équipement, le mode d'exploitation de `system settings`, le VDOM
courant du contexte, le nombre de VDOM du registre, le mode HA de la
configuration HA, l'heure de l'horloge. C'est la leçon
`show ip ssh` / `show file systems` du dépôt : une vue qui affiche une
constante là où la machine porte la valeur finit par se contredire.

Les lignes qui décriraient un mécanisme absent — bases antivirus, IPS,
licences — sont **omises**, comme cela a déjà été décidé pour
`show ip http server status` (« les lignes de cette capture qui
décriraient un mécanisme absent sont omises »).

### 30.5 `diagnose sniffer packet`

```
diagnose sniffer packet any 'host 203.0.113.10' 4 10 l
```

| Verbosité | Contenu |
|---|---|
| 1 | En-têtes IP |
| 2 | + charge utile |
| 3 | + en-têtes Ethernet |
| 4 | 1 + nom d'interface |
| 5 | 2 + nom d'interface |
| 6 | 3 + nom d'interface |

Le dépôt a un bus d'événements qui porte **toutes** les trames
(`port.frame.tx-requested`, `port.frame.received`), et le filtre
`tcpdump` a déjà été implémenté ailleurs (`tcpdump-byte-slice-vlan-filters`).
La sonde est donc une **vue** sur un mécanisme existant.

`set capture-packet enable` sur une politique fait la même chose, limité
à ce que la politique voit.

### 30.6 Exigences — diagnostic

| # | Exigence |
|---|---|
| **FGT-DIA-1** | `diagnose sys session list` rend le format complet de §30.1, lu depuis la table réelle |
| **FGT-DIA-2** | Les filtres de session s'appliquent à `list` **et** à `clear` |
| **FGT-DIA-3** | `diagnose sys session clear` sans filtre purge tout, comme la vraie machine |
| **FGT-DIA-4** | `diagnose debug flow` lit `ctx.trace` ; aucune trace parallèle n'est écrite |
| **FGT-DIA-5** | Un refus par politique implicite affiche `policy 0` |
| **FGT-DIA-6** | Les noms de fonction sont ceux de FortiOS ; les numéros de ligne sont constants et la limite est dite |
| **FGT-DIA-7** | `get system status` lit chaque ligne d'une source réelle |
| **FGT-DIA-8** | Les compteurs de coups d'une politique sont rendus par `diagnose firewall iprope list`. **Corrigé** : ce document demandait `get firewall policy`, qui sur un vrai FortiGate est un vidage de champs sans compteur |
| **FGT-DIA-9** | `diagnose sniffer packet` lit le bus de trames et honore le filtre |
| **FGT-DIA-10** | Toute sortie tabulaire passe par `TextTable` |

---

# Partie V — Réalisation

---

## 31. Architecture cible du répertoire

### 31.1 L'arborescence

```
src/network/devices/firewall/vendors/fortios/
├── FortiGate.ts                  ← équipement (existe, 59 l.)
├── FortiProfile.ts               ← profil (existe, 77 l.)
├── FortiShell.ts                 ← machine à états (existe, à refondre)
├── FortiPrompt.ts                ← construction de l'invite
├── FortiMessages.ts              ← catalogue de messages (§17)
├── FortiVocabulary.ts            ← aide et descriptions
│
├── schema/
│   ├── types.ts                  ← FortiTableSpec, FortiAttributeSpec
│   ├── index.ts                  ← assemblage de l'arbre
│   ├── system.ts
│   ├── firewallObjects.ts
│   ├── firewallPolicy.ts
│   ├── firewallNat.ts
│   ├── router.ts
│   ├── user.ts
│   ├── vpn.ts
│   ├── utm.ts
│   ├── log.ts
│   └── predefined.ts             ← objets et services livrés d'usine
│
├── runtime/
│   ├── FortiConfigTree.ts        ← l'état de configuration (objets, valeurs)
│   ├── FortiObject.ts            ← un objet édité, typé par son spec
│   ├── FortiNavigator.ts         ← la pile de contextes
│   ├── FortiValidator.ts         ← validation de type et de référence
│   └── FortiCommit.ts            ← orchestration des `onCommit`
│
├── render/
│   ├── showRenderer.ts           ← `show`
│   ├── fullConfigRenderer.ts     ← `show full-configuration`
│   ├── getRenderer.ts            ← `get`
│   └── fortiTableLayouts.ts      ← layouts TextTable (§30)
│
├── diag/
│   ├── sessionListRenderer.ts    ← `diagnose sys session list`
│   ├── debugFlowRenderer.ts      ← `diagnose debug flow`
│   ├── ipropeRenderer.ts         ← `diagnose firewall iprope`
│   ├── snifferRenderer.ts        ← `diagnose sniffer packet`
│   └── systemStatusRenderer.ts   ← `get system status`
│
└── exec/
    ├── executeCommands.ts        ← le catalogue `execute`
    ├── backupRestore.ts          ← §29.4
    └── revisions.ts              ← §29.5
```

### 31.2 Ce qui change dans le socle

Ces éléments **ne sont pas** dans `vendors/fortios/` — garde-fou G1.

| Brique | Emplacement | Motif |
|---|---|---|
| `VdomRegistry` + `VdomContext` | `firewall/vdom/` | PAN-OS (vsys) et Junos en auront besoin |
| Étape `vdom-bind` | `pipeline/stages/` | Catalogue commun |
| Étape `local-in-policy` | `pipeline/stages/` | ASA (`control-plane` ACL) l'utilisera |
| Étape `dos-policy` | `pipeline/stages/` | Commun |
| Étape `utm-inspect` | `pipeline/stages/` | Commun |
| Étape `policy-route` | `pipeline/stages/` | Commun |
| Étape `mac-lookup` (transparent) | `pipeline/stages/` | Commun |
| Objet horaire (`ScheduleObject`) | `model/` | BRD-Firewall §8.5 le spécifie déjà |
| `AddressObject` de genre `vip` | `model/` | §21.4 |
| `HaAgent` | `firewall/ha/` | Commun aux quatre constructeurs |
| `IdentityTable` (identité ↔ adresse) | `firewall/auth/` | Commun |
| `pipeline` par mode de déploiement | `FirewallProfile` | §11.3 |
| Formateur de journal par vendeur | `logging/` | §17.5 |
| `AttributeAccessGroup` (matrice de droits) | `firewall/admin/` | §18.9 |

**C'est une liste de treize modifications de socle**, et c'est le
résultat le plus utile de ce document : elles sont **nommées avant**
d'être découvertes une par une au fil de l'implémentation, ce qui est
la différence entre un plan et une dérive.

### 31.3 La refonte de `FortiShell`

`FortiShell` passe de 269 lignes « deux tables en dur » à un aiguilleur
d'une centaine de lignes :

```ts
export class FortiShell {
  private readonly nav: FortiNavigator;
  private readonly tree: FortiConfigTree;

  execute(rawLine: string): string {
    const line = rawLine.trim();
    if (line.length === 0) return '';
    if (line.endsWith('?')) return this.help(line.slice(0, -1));

    const [verb, ...rest] = tokenize(line);
    switch (verb) {
      case 'config':   return this.nav.descend(rest);
      case 'edit':     return this.nav.edit(rest[0]);
      case 'set':      return this.nav.set(rest[0], rest.slice(1));
      case 'unset':    return this.nav.unset(rest[0]);
      case 'append':   return this.nav.append(rest[0], rest.slice(1));
      case 'select':   return this.nav.select(rest[0], rest.slice(1));
      case 'unselect': return this.nav.unselect(rest[0], rest.slice(1));
      case 'next':     return this.nav.next();
      case 'end':      return this.nav.end();
      case 'abort':    return this.nav.abort();
      case 'delete':   return this.nav.delete(rest[0]);
      case 'purge':    return this.nav.purge();
      case 'clone':    return this.nav.clone(rest);
      case 'rename':   return this.nav.rename(rest);
      case 'move':     return this.nav.move(rest);
      case 'show':     return this.render.show(rest);
      case 'get':      return this.render.get(rest);
      case 'diagnose': return this.diag.run(rest);
      case 'execute':  return this.exec.run(rest);
      default:         return this.messages.unknownCommand(verb);
    }
  }
}
```

Dix-huit verbes, aucune connaissance de table. **C'est le but.**

### 31.4 Les garde-fous à ajouter

`architecture-guards.test.ts` porte déjà G1 à G5. Trois de plus, propres
à cette déclinaison :

| # | Garde-fou |
|---|---|
| **G6** | Aucun fichier de `vendors/fortios/` ne contient de liste blanche d'attributs — le schéma est le seul |
| **G7** | Tout `FortiAttributeSpec` porte une aide non vide (analogue de `cisco-help-every-keyword-described`) |
| **G8** | Tout `FortiTableSpec` déclare `scope` et `accessGroup` |

---

## 32. Ce qui se branche sur le socle, et comment

### 32.1 La table des sept spécificités

| # | Spécificité | Mécanisme d'absorption | Socle touché ? |
|---|---|---|---|
| **FGT-S1** | NAT champ de politique | `natIsPolicyField` + `SecurityRule.natEnabled` | ✅ livré |
| **FGT-S2** | Objets obligatoires | `objectsMandatoryInPolicy` | ✅ livré |
| **FGT-S3** | Grammaire `config/edit/set` | Schéma + navigateur, dans `vendors/` | Non |
| **FGT-S4** | `show` vs `get` | Trois rendus d'un schéma, dans `vendors/` | Non |
| **FGT-S5** | VIP objet + règle NAT | `AddressObject` de genre `vip` | **Oui** — modèle d'objets |
| **FGT-S6** | `firewall-session-dirty` | Champ de comportement + `SessionTable.clearMatching` | Léger |
| **FGT-S7** | VDOM | `VdomRegistry` | **Oui** — §31.2 |

Cinq sur sept ne touchent pas au socle. Les deux qui y touchent sont des
**extensions de modèle**, pas des moteurs — ce que le BRD générique
avait anticipé.

### 32.2 Les corrections demandées au profil

| Champ | Valeur livrée | Valeur cible | Motif |
|---|---|---|---|
| `policySeesPreNatDestination` | `false` | **`true`** | §21.4 — la politique vise la VIP |
| `supportedActions` | `['allow','deny']` | **`['allow','deny','ipsec']`** | §20.3 |
| `applicationShift` | `false` | **calculé** | §9.5 — dépend du mode NGFW |
| `natIsPolicyField` | `true` | **calculé** | §21.5 — dépend de `central-nat` |
| `pipeline` | liste | **dictionnaire par mode** | §11.3 |
| `unimplemented` | 3 entrées | Le catalogue de §43 | Exhaustivité |

**Les deux « calculé »** demandent un changement de forme du contrat :
`FirewallProfile` porte aujourd'hui des constantes. Deux options :

- **A** — Le champ devient une fonction `(vdom) => boolean`.
- **B** — Le profil reste constant, et le pipeline consulte le VDOM.

**Décision : B.** Un profil est une **description du constructeur** ; y
mettre des fonctions dépendant de l'état en fait un objet vivant, et le
garde-fou G2 (« le profil est gelé ») deviendrait faux. Le pipeline sait
déjà lire l'état ; c'est lui qui consulte.

Concrètement : `natSourceStage` teste `ctx.vdom.settings.centralNat`
plutôt que `services.natOrder.natIsPolicyField`, et le profil garde son
champ comme **valeur par défaut** quand le VDOM ne dit rien.

### 32.3 Le point d'attention sur `ObjectStore`

`ObjectStore` est aujourd'hui construit une fois dans `Firewall`. Avec
les VDOM, il en faut un par VDOM. Cela paraît trivial et cache un
piège : les objets **prédéfinis** (`all`, `ALL`, `HTTP`, …) doivent
exister dans chaque VDOM, et ils doivent être **les mêmes** — sinon un
`ObjectStore` par VDOM veut dire N copies d'un catalogue de cent
services.

**Décision** : le catalogue prédéfini est une **constante gelée
partagée**, et `ObjectStore` la consulte en repli quand un nom n'est pas
trouvé localement. Un objet prédéfini n'est ni modifiable ni
supprimable, donc le partage est sûr — c'est exactement le raisonnement
appliqué à `SYNTH_PASSWD`/`SYNTH_GROUP` de nss-systemd dans ce dépôt
(« exportés pour qu'il y ait une définition et non deux qui puissent
diverger »).

---

## 33. Le modèle de données

### 33.1 L'arbre de configuration à l'exécution

```ts
export interface FortiValue {
  readonly raw: readonly string[];
  readonly explicit: boolean;   // posé par l'opérateur, ou valeur par défaut ?
}

export class FortiObject {
  readonly spec: FortiTableSpec;
  readonly key: string;
  private readonly values = new Map<string, FortiValue>();
  private readonly children = new Map<string, FortiTable>();

  get(name: string): FortiValue | undefined;
  effective(name: string): readonly string[];   // valeur ou défaut
  isExplicit(name: string): boolean;            // ce que `show` interroge
  set(name: string, values: readonly string[]): void;
  unset(name: string): void;
  string(name: string): string;
  integer(name: string): number;
  bool(name: string): boolean;                  // enable/disable
  list(name: string): readonly string[];
  enum<T extends string>(name: string): T;
}

export class FortiTable {
  readonly spec: FortiTableSpec;
  private readonly objects = new Map<string, FortiObject>();
  private order: string[] = [];                 // si spec.ordered
}

export class FortiConfigTree {
  private readonly roots = new Map<string, FortiTable | FortiObject>();
  resolve(path: readonly string[]): FortiNode | undefined;
}
```

**`explicit` est le champ qui fait tout marcher** : `show` rend les
valeurs explicites, `get` rend `effective()` pour tout, `unset` remet
`explicit = false`. Une seule donnée, trois vues.

### 33.2 Le navigateur

```ts
export type FortiFrame =
  | { kind: 'table'; table: FortiTable }
  | { kind: 'object'; object: FortiObject };

export class FortiNavigator {
  private readonly stack: FortiFrame[] = [];
  private readonly pending = new Map<FortiObject, Map<string, FortiValue>>();

  descend(path: readonly string[]): string;
  edit(key: string): string;
  next(): string;      // valide le sommet, dépile
  end(): string;       // valide, dépile ; si vide, no-op
  abort(): string;     // jette `pending`, vide la pile
  prompt(): string;    // §10.6
}
```

**`pending`** porte les modifications non validées, ce qui est ce qui
rend `abort` possible. Sans lui, `abort` ne pourrait rien annuler.

### 33.3 La correspondance vers le socle

C'est le tableau qui dit où va chaque chose, et il est la spécification
des `onCommit`.

| Chemin FortiOS | Magasin du socle | Fonction |
|---|---|---|
| `system interface` | `InterfaceTable` + `Port` | `configureInterface`, création de port |
| `system zone` | `ZoneTable` | `assign` |
| `system dhcp server` | `dhcp/DhcpServer` | Configuration du serveur |
| `system admin` | `NetworkOsCredentialStore` | `upsert` |
| `firewall address` | `ObjectStore` | `addAddress` |
| `firewall addrgrp` | `ObjectStore` | `addAddressGroup` |
| `firewall service custom` | `ObjectStore` | `addService` |
| `firewall service group` | `ObjectStore` | `addServiceGroup` |
| `firewall schedule *` | `ObjectStore` (horaires) | À créer (§19.4) |
| `firewall policy` | `PolicyStore` | `append` / `insertAt` |
| `firewall local-in-policy` | `PolicyStore` dédié | idem |
| `firewall DoS-policy` | `DosPolicyStore` | À créer |
| `firewall vip` | `ObjectStore` + `NatPolicyStore` | Objet + règle |
| `firewall ippool` | `NatPolicyStore` (pools) | `addPool` |
| `firewall central-snat-map` | `NatPolicyStore` | `append` |
| `router static` | `RouteTable` | `addStatic` |
| `router policy` | `PolicyRouteStore` | À créer |
| `user local` / `group` | `NetworkOsCredentialStore` | `upsert` |
| `vpn ipsec phase1-interface` | `ipsec/` + création de port | Tunnel + interface |
| `log syslogd setting` | `LoggingConfig` + `SyslogAgent` | Projection |
| `system ha` | `HaAgent` | Configuration |
| `system sdwan` | `SdwanController` | À créer |

### 33.4 Ce que `onCommit` doit garantir

Trois invariants, vérifiés par test :

**(a) Idempotence.** Éditer un objet existant et faire `next` sans rien
changer ne doit pas dupliquer la règle dans le socle. `FortiShell`
actuel le fait déjà correctement (`remove` puis `append`), et c'est le
motif à conserver.

**(b) Transactionnalité par objet.** Un `onCommit` qui échoue à mi-course
ne doit pas laisser le socle dans un état partiel. En pratique : valider
**avant** d'écrire, écrire ensuite.

**(c) Ordre stable.** `edit 3` sur une table ordonnée conserve la
position ; il ne remonte pas la règle en fin de liste. C'est un piège
réel de l'implémentation naïve « supprimer puis ajouter ».

---

## 34. Persistance et sérialisation de topologie

### 34.1 Ce qui doit survivre

`topologySerializer.ts` capture une tranche large de l'état
configurable, et son en-tête énumère ce qu'il **ne** capture pas
(sessions de terminal, sockets vivants, état dynamique de protocole).
Le FortiGate s'y range exactement :

| Objet | Sérialisé ? |
|---|---|
| Toute la configuration (`show full-configuration`) | ✅ |
| Comptes administrateurs et secrets | ✅ |
| Certificats et clés (PEM) | ✅ |
| Table de sessions | ❌ — reconvergence |
| Table ARP | ❌ |
| Baux DHCP attribués | 🟡 à décider |
| Compteurs de politique | ❌ |
| État HA | ❌ — réélection |
| Journaux | ❌ |

### 34.2 Le mécanisme

**Le texte de `show full-configuration` est la sérialisation.** C'est le
choix le plus simple et le plus sûr :

- il n'y a pas de second format à maintenir ;
- il est lisible et diffable dans le fichier de topologie ;
- il est **testable** par un aller-retour ;
- c'est ce que fait déjà le dépôt pour Cisco et Huawei (le running-config
  est rejoué par la vraie CLI à l'import).

**La condition** est FGT-SCH-9 : la sortie doit être rejouable. C'est
pourquoi §15.3 refuse de rendre `config srcaddr / edit "…"` là où la
vraie machine le fait sur les versions récentes : une forme non
rejouable casserait l'import.

### 34.3 L'ordre de rendu

`renderOrder` du schéma. L'ordre canonique :

```
 1. system global
 2. system settings
 3. system vdom            (multi-VDOM)
 4. system interface
 5. system zone
 6. system dns / ntp
 7. system admin / accprofile
 8. system dhcp server
 9. firewall address
10. firewall addrgrp
11. firewall service custom
12. firewall service group
13. firewall schedule *
14. firewall ippool
15. firewall vip
16. firewall vipgrp
17. user local / group / radius / tacacs+
18. vpn certificate *
19. vpn ipsec phase1-interface
20. vpn ipsec phase2-interface
21. antivirus / webfilter / dnsfilter / ssl-ssh-profile / …
22. router static
23. router policy
24. firewall policy
25. firewall central-snat-map
26. firewall local-in-policy
27. firewall DoS-policy
28. system sdwan
29. system ha
30. log *
```

**La règle est simple** : un objet précède tous ses référents. Les
politiques sont donc en fin, comme sur une vraie machine.

C'est la leçon `orderCiscoConfigBlocks` de ce dépôt, et elle a été
apprise à ses dépens : une configuration rendue dans le mauvais ordre ne
se recharge pas.

### 34.4 Exigences — persistance

| # | Exigence |
|---|---|
| **FGT-PER-1** | Un aller-retour sauvegarde/chargement reproduit la configuration à l'identique |
| **FGT-PER-2** | La sérialisation est le texte de `show full-configuration` |
| **FGT-PER-3** | L'ordre de rendu permet le rejeu ; un test l'éprouve sur une configuration complète |
| **FGT-PER-4** | Les secrets sont sérialisés sous leur forme chiffrée et relus correctement |
| **FGT-PER-5** | Ce qui n'est pas sérialisé est nommé dans `TOPOLOGY_SAVE_CAVEATS` |

---

## 35. Interface graphique

### 35.1 Le canevas

| Élément | Exigence |
|---|---|
| Palette | `firewall-fortinet` est déposable, badge « Limited simulation » **retiré** une fois la phase 4 livrée |
| Icône | Distincte de celle du routeur et du commutateur |
| Ports | `port1` … `port8`, câblables |
| Panneau de propriétés | Adresse, état, zone, VDOM par interface |
| Rafraîchissement | Les événements de lien atteignent le canevas — le pont `revision` existe déjà |

### 35.2 Le terminal

`FortiTerminalSession` existe. Ce qu'il faut y ajouter :

| Point | État |
|---|---|
| Thème rouge FortiGate | ✅ |
| Invite hiérarchique | ✅ délègue à `getPrompt()` |
| `Ctrl-Z` → `end` | ✅ |
| Pager `--More--` | ✅ |
| `?` immédiat, sans validation | ❌ à câbler |
| Complétion `Tab` contextuelle | 🟡 câblée sur `cliTabCandidates` |
| Barre d'information montrant le VDOM | ❌ |

**`?` immédiat** est une vraie différence d'ergonomie : sur FortiOS, `?`
affiche l'aide **sans** valider la ligne, et la ligne reste en cours de
saisie. `CLITerminalSession` traite aujourd'hui `?` en fin de ligne
validée (motif Cisco). C'est un point à traiter dans la couche terminal,
et il est nommé ici parce qu'il ne relève pas du shell.

### 35.3 L'interface d'administration HTTPS

`allowaccess https` ouvre un vrai serveur HTTPS. Ce qu'il sert :

**Option A** — Une page minimale : identité, version, état des
interfaces, table de politique en lecture seule.

**Option B** — Rien : la connexion aboutit, l'authentification a lieu,
et le corps renvoie une page indiquant que la GUI n'est pas simulée.

**Décision : A, en phase tardive.** Le précédent est
`PRD-Serveur-HTTP-Cisco.md`, où le serveur HTTP d'IOS sert **l'EXEC**
via `/level/<n>/exec/<commande>` — c'est-à-dire que la voie HTTP lit le
même shell que la console. Le même motif s'applique : une page qui
expose `get system status` et `show firewall policy` en lecture,
authentifiée par les comptes réels, filtrée par `allowaccess` et
`trusthost`. Aucun moteur nouveau, et la démonstration « je durcis le
WAN et la GUI devient injoignable » devient complète.

### 35.4 Exigences — UI

| # | Exigence |
|---|---|
| **FGT-UI-1** | Le FortiGate est déposable, câblable, ouvrable |
| **FGT-UI-2** | Le badge « Limited simulation » est retiré quand les phases 1 à 4 sont livrées |
| **FGT-UI-3** | `?` affiche l'aide sans valider la ligne |
| **FGT-UI-4** | La barre d'information montre le VDOM courant |
| **FGT-UI-5** | Le panneau de propriétés montre zone et VDOM par interface |
| **FGT-UI-6** | La GUI HTTPS lit le même shell que la console |

---

# Partie VI — Exigences

---

## 36. Exigences fonctionnelles

### 36.1 Convention

`FGT-<famille>-<n>`. Chaque exigence est **vérifiable** : elle nomme
la commande et l'observation. Les familles :

| Code | Famille | Chapitre |
|---|---|---|
| `PIP` | Pipeline | §8 |
| `INS` | Inspection | §9 |
| `VDM` | VDOM | §10 |
| `DEP` | Déploiement | §11 |
| `ARB` | Arbre de configuration | §12 |
| `CMD` | Sous-commandes | §13 |
| `SCH` | Schéma | §14 |
| `VUE` | Rendus | §15 |
| `ERG` | Ergonomie | §16 |
| `MSG` | Messages | §17 |
| `SYS` | Système | §18 |
| `OBJ` | Objets | §19 |
| `POL` | Politique | §20 |
| `NAT` | NAT | §21 |
| `RTE` | Routage | §22 |
| `USR` | Utilisateurs | §23 |
| `VPN` | VPN | §24 |
| `UTM` | Profils de sécurité | §25 |
| `LOG` | Journalisation | §26 |
| `HA` | Haute disponibilité | §27 |
| `SDW` | SD-WAN | §28 |
| `EXE` | `execute` | §29 |
| `DIA` | Diagnostic | §30 |
| `PER` | Persistance | §34 |
| `UI` | Interface | §35 |

### 36.2 Récapitulatif

| Famille | Nombre | Phase de livraison |
|---|---|---|
| `ARB`, `CMD`, `SCH`, `VUE`, `ERG`, `MSG` | 6+8+9+8+7+6 = **44** | 1 |
| `SYS`, `OBJ` | 12+9 = **21** | 1-2 |
| `POL`, `PIP` | 12+7 = **19** | 2 |
| `RTE` | **8** | 2-3 |
| `NAT` | **11** | 3 |
| `DIA`, `LOG` | 10+8 = **18** | 4 |
| `VDM`, `DEP` | 8+6 = **14** | 5 |
| `INS`, `UTM` | 6+12 = **18** | 6 |
| `USR` | **7** | 7 |
| `VPN` | **8** | 8 |
| `HA`, `SDW` | 8+6 = **14** | 9 |
| `EXE`, `PER`, `UI` | 7+5+6 = **18** | Transverse |
| **Sous-total fonctionnel** | **200** | |
| `TRV` (transverses) | **10** | Toutes |
| `NFP`, `NFF`, `NFM`, `NFT`, `NFC` | 5+4+4+4+3 = **20** | Toutes |
| **Total** | **230** | |

### 36.3 Exigences transverses

Elles s'appliquent à tout le module et ne sont rattachées à aucun
chapitre.

| # | Exigence |
|---|---|
| **FGT-TRV-1** | Aucun moteur n'est défini dans `vendors/fortios/` (G1) |
| **FGT-TRV-2** | Aucun verdict de paquet n'est posé dans `vendors/fortios/` (G6) |
| **FGT-TRV-3** | Aucune liste blanche d'attributs hors du schéma (G6) |
| **FGT-TRV-4** | Tout attribut du schéma porte une aide non vide (G7) |
| **FGT-TRV-5** | Toute sortie tabulaire passe par `TextTable` |
| **FGT-TRV-6** | Toute commande refusée relève d'une des trois familles de §17.3 |
| **FGT-TRV-7** | Aucun commentaire dans le code livré, conformément à la convention du dépôt |
| **FGT-TRV-8** | Chaque livraison est discriminée par `git stash` : les cas doivent tomber avant correctif |
| **FGT-TRV-9** | Le typecheck ne dépasse pas la base ; le lint est identique fichier par fichier |
| **FGT-TRV-10** | Chaque phase livre au moins une spec Playwright |

---

## 37. Exigences non fonctionnelles

### 37.1 Performance

| # | Exigence | Seuil |
|---|---|---|
| **FGT-NFP-1** | Recherche de session | O(1) — `Map` indexée par `FlowKey` |
| **FGT-NFP-2** | Recherche de politique | O(n) sur le nombre de règles, acceptable jusqu'à 500 |
| **FGT-NFP-3** | Une suite de tests FortiOS complète | < 30 s |
| **FGT-NFP-4** | Rendu de `show full-configuration` sur 200 objets | < 100 ms |
| **FGT-NFP-5** | Aucune fuite : les minuteurs sont libérés à la destruction |

### 37.2 Fidélité

| # | Exigence |
|---|---|
| **FGT-NFF-1** | Toute sortie reproduite l'est d'après une source citée — documentation Fortinet ou transcription réelle |
| **FGT-NFF-2** | Une divergence assumée est écrite dans le chapitre concerné **et** dans §43 |
| **FGT-NFF-3** | Aucune valeur affichée n'est une constante quand la machine porte la donnée |
| **FGT-NFF-4** | Les messages d'erreur sont ceux de FortiOS, les notes de simulateur sont préfixées |

### 37.3 Maintenabilité

| # | Exigence |
|---|---|
| **FGT-NFM-1** | Ajouter une table de configuration = ajouter une déclaration au schéma, rien d'autre |
| **FGT-NFM-2** | Ajouter un attribut = une ligne au schéma |
| **FGT-NFM-3** | Aucun fichier de `vendors/fortios/` ne dépasse 500 lignes |
| **FGT-NFM-4** | Le schéma est réparti par branche, un fichier par branche de premier niveau |

### 37.4 Testabilité

| # | Exigence |
|---|---|
| **FGT-NFT-1** | Toute exigence fonctionnelle a au moins un cas de test |
| **FGT-NFT-2** | Tout laboratoire de §5.2 a une suite dédiée |
| **FGT-NFT-3** | Tout comportement observable sur le fil est testé **sur le fil**, pas par appel direct |
| **FGT-NFT-4** | Tout cas nominal a son témoin (le cas où ça ne marche pas) |

### 37.5 Compatibilité

| # | Exigence |
|---|---|
| **FGT-NFC-1** | Aucune régression sur l'ASA — la suite ASA reste verte |
| **FGT-NFC-2** | Aucune régression sur le socle — les 29 fichiers de `firewall/` restent verts |
| **FGT-NFC-3** | Les modifications de socle de §31.2 bénéficient à l'ASA quand elles s'y appliquent |

---

## 38. Matrice exigences → laboratoires

| Laboratoire | Exigences couvertes |
|---|---|
| **L1** LAN → Internet | SYS-1..7, OBJ-1..2, POL-1, NAT-1, RTE-1..2, VUE-1, PER-1 |
| **L2** VIP | NAT-4..8, POL-1, DIA-1 |
| **L3** DMZ trois zones | SYS-5..8, POL-1..3 |
| **L4** Ordre des règles | POL-5, CMD-7, DIA-8 |
| **L5** Diagnostic | DIA-1..6, POL-3 |
| **L6** Journalisation | LOG-1..8, POL-1 |
| **L7** Deux VDOM | VDM-1..8 |
| **L8** IPsec | VPN-1..8, RTE-1 |
| **L9** FortiGate vs ASA | NFC-1, POL-2, NAT-1 |
| **L10** Pannes | OBJ-8, POL-3, RTE-3, NAT-8 |
| **L11** NAT central | NAT-9..10, MSG-2 |
| **L12** `local-in-policy` | SYS-6, POL-9 |

---

# Partie VII — Livraison

---

## 39. Découpage en phases

Chaque phase est **livrable seule** : elle laisse le module dans un état
cohérent, testé, poussé. C'est la démarche du carnet
`JOURNAL-FIREWALL.md`, qui a produit les phases 1 à 5 du socle.

### Phase 1 — La grammaire (fondation)

| Livrable | Cas visés |
|---|---|
| `schema/types.ts` — le modèle de spécification | 15 |
| `runtime/FortiObject`, `FortiTable`, `FortiConfigTree` | 30 |
| `runtime/FortiNavigator` — la pile, les 18 verbes | 40 |
| `runtime/FortiValidator` — types, énumérations, références | 30 |
| `render/showRenderer`, `getRenderer`, `fullConfigRenderer` | 30 |
| `FortiMessages` — les trois familles | 15 |
| Aide et complétion depuis le schéma | 20 |
| Refonte de `FortiShell` sur le navigateur | — |
| **Non-régression** : les 32 cas actuels restent verts | 32 |

**Critère de sortie** : `config firewall policy` et
`config firewall address` fonctionnent **exactement comme avant**, mais
par le schéma, et `show`/`get` diffèrent.

### Phase 2 — Le système et les objets

| Livrable | Cas |
|---|---|
| `config system global`, `settings`, `console` | 20 |
| `config system interface` (physique, VLAN, bouclage) | 35 |
| `allowaccess` — le filtre réel | 20 |
| `config system zone` | 15 |
| `config firewall address` complet (8 types) | 25 |
| `config firewall addrgrp`, `service custom/group` | 25 |
| `config firewall schedule` + objet horaire du socle | 25 |
| Catalogue prédéfini (§44.2) | 10 |
| `config router static` | 20 |
| **Laboratoires L1, L3, L10** | 25 |

### Phase 3 — Le NAT complet — ✅ livrée

Livrée en **34 cas** (`fortios-nat.test.ts`) plus 5 specs Playwright,
27 des 34 discriminés par `git stash`. Le découpage prévu ci-dessous est
conservé pour mémoire ; la livraison couvre les sept lignes dans un seul
fichier de sonde, la matière étant indissociable — une VIP sans ARP
mandataire n'est joignable par personne, et le NAT en épingle n'est que
la même VIP vue depuis l'intérieur.

| Livrable | Cas prévus | État |
|---|---|---|
| `config firewall ippool` (4 types) | 20 | ✅ |
| `config firewall vip` + `AddressObject` de genre `vip` | 35 | ✅ `static-nat` ; `dns-translation` et `fqdn` déclarés, non commis |
| ARP proxy pour VIP et pools | 15 | ✅ |
| NAT en épingle | 10 | ✅ |
| `config firewall central-snat-map` + bascule de mode | 25 | ✅ IPv4 ; `nat46`/`nat64` hors périmètre |
| `config router policy` + étape de pipeline | 20 | ✅ |
| **Laboratoires L2, L11** | 20 | ✅ |

**Deux exigences corrigées par la mesure** :

- **§21.4 renversée.** Ce document demandait
  `policySeesPreNatDestination: true`. FortiOS traduit la destination
  **avant** de chercher la politique : celle-ci voit donc l'adresse
  traduite, et le profil reste à `false`. Ce qui lui fait quand même
  nommer la VIP dans `dstaddr`, c'est que l'objet adresse d'une VIP
  désigne l'adresse **interne**.
- **`match-vip` ajouté.** Absent de ce document, il décide pourtant si
  une règle `deny` placée au-dessus attrape le trafic d'une VIP. Son
  défaut est `enable` depuis la 7.2.3 et il n'existe que sur une règle
  `deny`.

### Phase 4 — Le diagnostic et les journaux — ✅ livrée

Livrée en **44 cas** (`fortios-diagnostic.test.ts`) plus 7 specs
Playwright, 40 des 44 discriminés par `git stash`.

| Livrable | Cas prévus | État |
|---|---|---|
| `diagnose sys session list` complet + filtres | 30 | ✅ |
| `diagnose debug flow` | 30 | ✅ |
| `diagnose firewall iprope list` | 15 | ✅ |
| `get system status` lu de sources réelles | 15 | ✅ |
| `get system performance`, `arp`, `interface` | 20 | ✅ sauf CPU/mémoire — aucun modèle de charge |
| `config log *` + formateur FortiOS | 30 | ✅ quatre collecteurs, quatre formats ; l'émission vers un vrai collecteur reste à brancher |
| `execute log filter/display` | 15 | ✅ |
| `diagnose sniffer packet` | 20 | ✅ |
| **Laboratoires L4, L5, L6** | 25 | ✅ |
| **Retrait du badge « Limited simulation »** | — | ✅ |

**Une exigence corrigée par la mesure.** §30.6 **FGT-DIA-8** demandait
que `get firewall policy` rende les compteurs de coups. Un vrai
FortiGate n'en met pas : cette vue est un vidage de champs
(`== [ 1 ]`, `srcintf : "port1"`), et les compteurs vivent dans
`diagnose firewall iprope list`. L'exigence est déplacée là.

**Deux points ajoutés que ce document ne nommait pas** :
`config log setting` / `set fwpolicy-implicit-log` — sans lui la règle
implicite ne journalise pas, et c'est le défaut de Fortinet ; et le
fait que les champs d'un journal sont **entre guillemets**, les
numériques exceptés.

### Phase 5 — VDOM et modes — ✅ livrée

Livrée en **27 cas** (`fortios-vdom.test.ts`) plus 6 specs Playwright.
Les **944 cas antérieurs sont restés verts sans qu'un seul ait été
touché** : c'est la preuve que le mono-VDOM est le cas particulier du
multi-VDOM et non une branche (FGT-VDM-2).

| Livrable | Cas prévus | État |
|---|---|---|
| `VdomRegistry` + `VdomContext` (socle) | 30 | ✅ |
| Étape `vdom-bind` | 15 | ✅ |
| `config vdom`, `config global`, portées | 30 | ✅ sauf `config system admin`, sans schéma |
| `vdom-link` | 15 | ✅ vrai `Cable` interne |
| Mode transparent + pipeline par mode | 30 | ✅ |
| `switch-interface` | 15 | ✅ étape `switch-bridge` |
| **Laboratoire L7** | 25 | ✅ étanchéité mesurée sur des noms identiques |
| **Laboratoire L9** | — | ⏳ comparaison documentaire, pas un mécanisme |

**Deux points que ce document ne nommait pas, et que la réalisation a
imposés** : un VDOM est une **portée** et non un conteneur — l'arbre de
configuration complet se rouvre sous `config vdom` / `edit <nom>` — et
cet arbre doit être **indexé par portée**, sans quoi deux VDOM éditent
la même table et `show` rend les deux mélangés.

`vdom-mode split-vdom` est accepté et se comporte comme `multi-vdom` :
la séparation gestion/trafic n'a pas de mécanisme derrière, et c'est
écrit plutôt que laissé à découvrir.

### Phase 6 — Inspection et UTM

| Livrable | Cas |
|---|---|
| Étape `utm-inspect` (socle) | 20 |
| `inspection-mode proxy` — deux sessions | 20 |
| `config antivirus profile` + EICAR | 25 |
| `config webfilter profile` + catalogue local | 25 |
| `config dnsfilter profile` | 15 |
| `config file-filter profile` | 15 |
| `ssl-ssh-profile` — `certificate-inspection` réelle (SNI du vrai ClientHello) ; `deep-inspection` refusée famille 2 | 35 |
| `profile-protocol-options` | 10 |
| Refus famille 2 : IPS, application, DLP | 10 |

### Phase 7 — Utilisateurs et authentification

| Livrable | Cas |
|---|---|
| `config user local`, `group` | 20 |
| `config user radius`, `tacacs+` | 20 |
| `IdentityTable` (socle) | 20 |
| Portail d'authentification HTTP/HTTPS | 30 |
| `config system admin`, `accprofile`, matrice de droits | 35 |
| `trusthost` | 15 |

### Phase 8 — VPN

| Livrable | Cas |
|---|---|
| `phase1-interface` / `phase2-interface` + interface de tunnel | 40 |
| Refus des propositions non implémentées | 15 |
| Mode policy-based (`action ipsec`) | 20 |
| `diagnose vpn tunnel list` | 15 |
| Portail SSL-VPN | 30 |
| **Laboratoire L8** | 15 |

### Phase 9 — HA et SD-WAN

| Livrable | Cas |
|---|---|
| `HaAgent` (socle) | 35 |
| `config system ha`, élection, surveillance | 30 |
| Cerveau divisé, `session-pickup` | 20 |
| `config system sdwan` | 30 |
| Sondes réelles, bascule sur perte | 25 |

### Phase 10 — Routage dynamique (socle)

| Livrable | Cas |
|---|---|
| Découplage des moteurs OSPF/BGP/RIP de `Router` | 40 |
| `config router ospf`, `bgp` sur FortiGate | 35 |

**Cette phase est un chantier de socle**, nommé ici parce que §22.3 la
refuse en attendant. Elle bénéficie aussi à l'ASA et à PAN-OS.

### 39.1 Total

| Phase | Cas estimés | Cumul |
|---|---|---|
| 1 | 212 | 212 |
| 2 | 220 | 432 |
| 3 | 145 | 577 |
| 4 | 200 | 777 |
| 5 | 160 | 937 |
| 6 | 175 | 1112 |
| 7 | 140 | 1252 |
| 8 | 135 | 1387 |
| 9 | 140 | 1527 |
| 10 | 75 | 1602 |

Ordre de grandeur, pas engagement. Il sert à dire une chose : **c'est un
module de la taille d'Oracle ou de PowerShell**, pas une commande à
ajouter.

---

## 40. Stratégie de test

### 40.1 Les cinq niveaux

| Niveau | Ce qu'il éprouve | Exemple |
|---|---|---|
| **Unitaire** | Une brique isolée | `FortiValidator` refuse `set vlanid 5000` |
| **Grammaire** | La CLI sans équipement | `abort` annule ; `show` ≠ `get` |
| **Intégration** | Le shell écrit dans le socle | `set nat enable` pose `natEnabled` |
| **Sur le fil** | Le trafic réel traverse | `ping` passe avec la règle, échoue sans |
| **Bout en bout** | L'interface graphique | Playwright : déposer, câbler, configurer, pinger |

### 40.2 La règle du témoin

**Tout cas nominal a son témoin.** C'est la règle la plus productive de
ce dépôt, et la suite FortiOS actuelle la respecte déjà :

```
it('avec lui, la source devient l'adresse de l'interface de SORTIE', …)
it('sans lui, la source n'est pas traduite — le temoin', …)
```

Sans témoin, on ne distingue pas « la fonction marche » de « le
laboratoire est mal monté ». Le dépôt l'a payé plusieurs fois — la sonde
`aaa-accounting-et-serveur-herite` a d'abord tout vu échouer et conclu à
tort à un défaut, alors que le laboratoire était faux.

### 40.3 La discrimination par `git stash`

Chaque livraison doit prouver que ses cas **tombent avant correctif** :

```bash
git stash push -- src/network/
npx vitest run src/__tests__/unit/network-v2/firewall/
git stash pop
```

Le nombre de cas qui tombent est écrit dans le carnet. Les cas qui
passent des deux côtés sont **nommés** dans l'en-tête du fichier de
test, avec leur raison — c'est ce que font déjà
`tuto-cli-views-cisco.test.ts` et `serveur-http-cisco.test.ts`.

### 40.4 Les garde-fous d'architecture

`architecture-guards.test.ts` gagne G6, G7, G8 (§31.4). Ils sont écrits
**avant** que le schéma ne grossisse, parce qu'un garde-fou ajouté après
coup constate les dégâts au lieu de les empêcher — c'est l'argument
inscrit dans l'en-tête du fichier existant.

### 40.5 L'organisation des fichiers

```
src/__tests__/unit/network-v2/firewall/
├── fortios-profile.test.ts          ← existe, 32 cas
├── fortios-grammar.test.ts          ← phase 1
├── fortios-schema.test.ts           ← phase 1
├── fortios-render.test.ts           ← phase 1
├── fortios-messages.test.ts         ← phase 1
├── fortios-system.test.ts           ← phase 2
├── fortios-objects.test.ts          ← phase 2
├── fortios-allowaccess.test.ts      ← phase 2
├── fortios-nat.test.ts              ← phase 3 (VIP, pools, central-snat, PBR)
├── fortios-session-view.test.ts     ← phase 4
├── fortios-debug-flow.test.ts       ← phase 4
├── fortios-logging.test.ts          ← phase 4
├── fortios-vdom.test.ts             ← phase 5
├── fortios-transparent.test.ts      ← phase 5
├── fortios-utm.test.ts              ← phase 6
├── fortios-deep-inspection.test.ts  ← phase 6
├── fortios-auth.test.ts             ← phase 7
├── fortios-ipsec.test.ts            ← phase 8
├── fortios-ha.test.ts               ← phase 9
├── fortios-sdwan.test.ts            ← phase 9
└── labs/
    ├── lab-01-lan-internet.test.ts
    ├── lab-02-vip.test.ts
    …
```

### 40.6 Playwright

Une spec par phase au minimum :

| Spec | Ce qu'elle éprouve |
|---|---|
| `fortigate-depose-et-cable.spec.ts` | Palette, câblage, terminal |
| `fortigate-lab-lan-internet.spec.ts` | L1 par le terminal graphique |
| `fortigate-show-vs-get.spec.ts` | Les deux rendus dans l'interface |
| `fortigate-vdom.spec.ts` | L'invite change, l'étanchéité tient |
| `fortigate-debug-flow.spec.ts` | La trace s'affiche |

---

## 41. Critères d'acceptation

### 41.1 Par phase

Une phase est acceptée quand :

1. tous ses cas passent ;
2. la discrimination `git stash` est faite et le nombre est écrit ;
3. le typecheck ne dépasse pas la base ;
4. le lint est identique fichier par fichier ;
5. les suites connexes sont vertes (au minimum tout `firewall/`) ;
6. au moins une spec Playwright est verte ;
7. le carnet `JOURNAL-FIREWALL.md` porte l'entrée ;
8. le BRD est corrigé si la mesure l'a contredit.

**Le point 8 n'est pas une formalité.** Le carnet l'écrit en tête :
« quand la mesure contredit le BRD, c'est la mesure qui est écrite, et le
BRD est corrigé ». Ce document contient déjà deux corrections de ce
genre (§3.2), faites avant même l'implémentation.

### 41.2 Le critère global

Le module FortiGate est **livré** quand un formateur peut monter les
douze laboratoires de §5.2 devant une classe, sans contournement, et que
chacun se comporte comme sur une vraie machine — y compris les pannes.

### 41.3 Le critère de non-régression permanent

À chaque livraison :

| Périmètre | Commande |
|---|---|
| Module pare-feu | `npx vitest run src/__tests__/unit/network-v2/firewall/` |
| Garde-fous | inclus ci-dessus |
| Typecheck | `npx tsc -p tsconfig.app.json --noEmit` |
| Lint des fichiers touchés | `npx eslint <fichiers>` |

**Pas de non-régression à l'échelle du dépôt** : la consigne permanente
est de s'en tenir aux fonctionnalités connexes, sous peine de rendre
chaque livraison impraticable.

---

## 42. Risques et arbitrages

### 42.1 Les risques

| # | Risque | Gravité | Parade |
|---|---|---|---|
| **R1** | Le schéma grossit sans fin (FortiOS a des milliers d'attributs) | Élevée | §43 borne le périmètre ; `unimplemented` refuse le reste explicitement |
| **R2** | Le multi-VDOM est introduit tard et impose une réécriture | Élevée | `VdomRegistry` existe **dès la phase 1** avec un seul VDOM |
| **R3** | Une divergence FortiOS impose un moteur dans `vendors/` | Moyenne | G1 et G6 le rendent mécaniquement impossible ; la divergence remonte au socle |
| **R4** | Le couplage OSPF/BGP à `Router` bloque le routage dynamique | Moyenne | Refus explicite (§22.3), phase 10 dédiée |
| **R5** | L'UTM donne l'illusion d'une inspection réelle | **Élevée** | §25.1 écrit la limite ; seuls EICAR et les catégories locales sont livrés |
| **R6** | Les rendus de diagnostic divergent de la mesure | Élevée | `debug flow` lit `ctx.trace` ; aucune trace parallèle (G6) |
| **R7** | La sérialisation casse au premier attribut non rejouable | Moyenne | FGT-SCH-9 testée par aller-retour à chaque phase |
| **R8** | Le travail dépasse la capacité disponible | Certaine | Dix phases livrables indépendamment |
| **R9** | Un autre agent travaille sur le même répertoire | Moyenne | Revendication dans `JOURNAL-FIREWALL.md` avant chaque phase |

### 42.2 Les arbitrages, et pourquoi

| # | Question | Décision | Motif |
|---|---|---|---|
| **A1** | Schéma déclaratif ou code par table ? | **Schéma** | Cent tables, sept fonctions chacune, sinon |
| **A2** | `VdomRegistry` tout de suite ou plus tard ? | **Tout de suite**, avec un VDOM | Sinon le mono-VDOM devient une branche conditionnelle partout |
| **A3** | Profil constant ou fonctions ? | **Constant**, le pipeline consulte l'état | Un profil vivant casse le garde-fou du gel |
| **A4** | OSPF : découpler, composer, ou refuser ? | **Refuser** puis découpler | Composer crée deux tables de routage |
| **A5** | Limitation de débit : refuser ou compter ? | **Refuser** | Des compteurs sans limitation font croire à la limitation |
| **A6** | 3DES : accepter ou refuser ? | **Refuser** | `desCbcDecrypt` n'existe pas ; chiffrer sans savoir déchiffrer perd les données |
| **A7** | Sérialisation : format dédié ou `show full-configuration` ? | **`show full-configuration`** | Un seul format à maintenir, testable par aller-retour |
| **A8** | Notes de simulateur : oui ou non ? | **Oui, préfixées, désactivables** | Précédent Apache ; un silence indiagnosticable n'enseigne rien |
| **A9** | Numéros de ligne de `debug flow` | **Constants par message** | Les inventer variables serait un faux détail |
| **A10** | Catalogue prédéfini par VDOM ou partagé ? | **Partagé, gelé** | Cent services × N VDOM sinon |
| **A11** | GUI HTTPS : page ou refus ? | **Page en lecture, lisant le shell** | Précédent `ip http server` de Cisco |
| **A12** | `set application` : accepter inerte ou refuser ? | **Refuser** | Une règle qui ne correspond jamais est un piège |

---

## 43. Hors périmètre — écrit une seconde fois

> Ce chapitre existe parce qu'une limite écrite à un seul endroit finit
> par être oubliée. Tout ce qui suit est **refusé** par la CLI, famille 2
> de §17.3, avec un message qui nomme la brique manquante.

### 43.1 Matériel

| Élément | Motif |
|---|---|
| `auto-asic-offload`, `np-acceleration` | Aucun modèle de processeur réseau |
| `hw-switch`, `switch-controller` | Aucun modèle de FortiSwitch |
| `wireless-controller` | Aucun modèle de FortiAP |
| `execute sensor list`, ventilateurs, alimentations | Aucun modèle de châssis |
| `diagnose sys top`, `fnsysctl` | Aucun système d'exploitation sous-jacent |
| Modules SFP, `get hardware nic` détaillé | Idem |

### 43.2 Sécurité par signatures

| Élément | Motif |
|---|---|
| `config ips sensor` | Aucune base de signatures |
| `config application list` | Idem |
| `config dlp *` | Idem |
| `config emailfilter profile` | Idem |
| Antivirus autre qu'EICAR | Idem |
| Catégories FortiGuard réelles | Aucun service externe ; catalogue local seulement |
| `config videofilter`, `config waf` | Idem |
| Sandbox (`FortiSandbox`) | Autre produit |

### 43.3 Services et produits externes

| Élément | Motif |
|---|---|
| FortiGuard (mises à jour, licences, classification) | Aucun service externe |
| FortiAnalyzer, FortiManager, FortiCloud | Autres produits |
| Security Fabric | Suppose la famille de produits |
| FortiToken, SMS, notification poussée | Aucun canal |
| `execute update-now`, `diagnose autoupdate` | Aucun service |

### 43.4 Protocoles et fonctions absents du dépôt

| Élément | Motif | Travail futur ? |
|---|---|---|
| LDAP | Aucun client ni serveur | **Oui — identifié** |
| FSSO, RSSO | Suppose un agent externe | Non |
| SAML | Aucun fournisseur d'identité | Non |
| PPPoE | Aucune pile PPP | Non |
| SSL-VPN mode tunnel | Interface virtuelle + attribution d'adresse | **Oui — identifié** |
| ZTNA | Repose sur FortiClient | Non |
| WAN optimization, cache web | Aucun modèle | Non |
| Explicit web proxy | Partiellement possible | **Oui — identifié** |
| IPv6 complet | Le socle est IPv4 ; `IPv6DataPlane` existe côté `Router` | **Oui — identifié** |
| VRF | Aucun plan de routage par instance | Non |
| BFD sur FortiGate | `bfd/` existe, couplé à `Router` | Lié à la phase 10 |

### 43.5 Fonctions temporelles

| Élément | Motif |
|---|---|
| Limitation de débit (`shaper`) | Livraison de trame synchrone, pas d'horloge de fil |
| Seuils de latence SD-WAN | Idem — même limite qu'IP SLA |
| Seuils de gigue | Idem |
| `diagnose sys top`, mesures de charge CPU | Aucun modèle d'exécution |

### 43.6 Rendus délibérément divergents

| Élément | Divergence | Motif |
|---|---|---|
| `show full-configuration` des listes | `set srcaddr "a" "b"` au lieu de `config srcaddr / edit …` | La seconde forme n'est pas rejouable par `set` ; FGT-SCH-9 prime |
| `debug flow` numéros de ligne | Constants par message | Les inventer variables serait un faux détail |
| Notes `NOTE:` | N'existent pas sur la vraie machine | Un silence indiagnosticable n'enseigne rien ; désactivables |
| `simulator-hints` | Commande inexistante sur FortiOS | Marquée `[simulateur]` dans l'aide |

---

## 44. Annexes

### 44.1 Correspondance ASA ↔ FortiGate ↔ PAN-OS

| Concept | Cisco ASA | Fortinet FortiOS | Palo Alto PAN-OS |
|---|---|---|---|
| Zone | `nameif` + `security-level` | `zone` (ou interface directe) | `zone` |
| Objet adresse | `object network` | `firewall address` | `address` |
| Groupe d'adresses | `object-group network` | `firewall addrgrp` | `address-group` |
| Objet service | `object service` | `firewall service custom` | `service` |
| Politique | `access-list` + `access-group` | `firewall policy` | `rulebase security` |
| Refus final | Implicite | Implicite (`policy 0`) | Implicite (`interzone-default`) |
| NAT source | `nat (in,out) dynamic` | `set nat enable` | `rulebase nat` |
| NAT destination | `nat (in,out) static` | `firewall vip` | `rulebase nat` |
| Table de sessions | `show conn` | `diagnose sys session list` | `show session all` |
| Traduction | `show xlate` | Inclus dans la session | `show session all` |
| Trace | `packet-tracer` | `diagnose debug flow` | `test security-policy-match` |
| Virtualisation | `context` | `vdom` | `vsys` |
| Configuration | Immédiate | Immédiate | **Candidate** (`commit`) |
| Trafic vers la machine | `control-plane` ACL | `local-in-policy` | Management profile |
| HA | Failover | FGCP | HA1/HA2 |

### 44.2 Les services prédéfinis

Catalogue minimal à livrer (phase 2). Chaque entrée est
`predefined: true`, non modifiable, non supprimable.

| Nom | Définition |
|---|---|
| `ALL` | Tous protocoles |
| `ALL_TCP` | TCP 1-65535 |
| `ALL_UDP` | UDP 1-65535 |
| `ALL_ICMP` | ICMP tous types |
| `ALL_ICMP6` | ICMPv6 |
| `PING` | ICMP type 8 |
| `TRACEROUTE` | UDP 33434-33534 + ICMP |
| `HTTP` | TCP 80 |
| `HTTPS` | TCP 443 |
| `SSH` | TCP 22 |
| `TELNET` | TCP 23 |
| `FTP` | TCP 21 |
| `FTP_GET` / `FTP_PUT` | TCP 21 |
| `TFTP` | UDP 69 |
| `DNS` | TCP 53, UDP 53 |
| `DHCP` | UDP 67-68 |
| `NTP` | UDP 123 |
| `SMTP` | TCP 25 |
| `SMTPS` | TCP 465 |
| `POP3` | TCP 110 |
| `POP3S` | TCP 995 |
| `IMAP` | TCP 143 |
| `IMAPS` | TCP 993 |
| `SNMP` | UDP 161-162 |
| `SYSLOG` | UDP 514 |
| `LDAP` | TCP 389 |
| `LDAPS` | TCP 636 |
| `RADIUS` | UDP 1812-1813 |
| `TACACS+` | TCP 49 |
| `KERBEROS` | TCP 88, UDP 88 |
| `SMB` | TCP 445 |
| `RDP` | TCP 3389 |
| `VNC` | TCP 5900 |
| `MYSQL` | TCP 3306 |
| `SQL` | TCP 1433 |
| `ORACLE` | TCP 1521 |
| `NFS` | TCP 111,2049 UDP 111,2049 |
| `IKE` | UDP 500, 4500 |
| `ESP` | IP 50 |
| `AH` | IP 51 |
| `GRE` | IP 47 |
| `L2TP` | UDP 1701 |
| `PPTP` | TCP 1723 |
| `SIP` | TCP 5060, UDP 5060 |
| `H323` | TCP 1720,1503 UDP 1719 |
| `NNTP` | TCP 119 |
| `IRC` | TCP 6660-6669 |
| `WINS` | TCP 1512, UDP 1512 |
| `SAMBA` | TCP 139 |
| `X-WINDOWS` | TCP 6000-6063 |

### 44.3 Les catégories d'URL locales

Catalogue restreint (phase 6), explicitement **local** et non FortiGuard.

| ID | Catégorie |
|---|---|
| 1 | Drug Abuse |
| 2 | Alternative Beliefs |
| 7 | Illegal or Unethical |
| 12 | Gambling |
| 14 | Malicious Websites |
| 20 | Phishing |
| 23 | Advertising |
| 26 | Social Networking |
| 33 | Games |
| 37 | Instant Messaging |
| 43 | Streaming Media |
| 52 | File Sharing and Storage |
| 61 | Information Technology |
| 90 | Non classé |

### 44.4 Les zones horaires principales

Indices FortiOS des zones utiles aux laboratoires.

| Indice | Zone |
|---|---|
| `00` | (GMT-12:00) Eniwetok, Kwajalein |
| `04` | (GMT-8:00) Pacific Time (US & Canada) |
| `12` | (GMT-5:00) Eastern Time (US & Canada) |
| `21` | (GMT) Greenwich Mean Time: Dublin, Edinburgh, Lisbon, London |
| `27` | (GMT+1:00) Brussels, Copenhagen, Madrid, Paris |
| `32` | (GMT+2:00) Athens, Bucharest |
| `47` | (GMT+8:00) Beijing, Chongqing, Hong Kong, Urumqi |
| `60` | (GMT+9:00) Osaka, Sapporo, Tokyo |

### 44.5 Glossaire

| Terme | Définition |
|---|---|
| **VDOM** | Domaine virtuel : pare-feu logique au sein d'un FortiGate |
| **VIP** | *Virtual IP* : objet portant une traduction de destination |
| **IP pool** | Plage d'adresses pour la traduction de source |
| **Central NAT** | Mode où le NAT se déclare hors de la politique |
| **Flow-based** | Inspection au fil de l'eau, une session |
| **Proxy-based** | Inspection avec terminaison, deux sessions |
| **NGFW profile-based** | La sécurité applicative est dans des profils |
| **NGFW policy-based** | La sécurité applicative est un critère de règle |
| **UTM** | *Unified Threat Management* : l'ensemble des profils de sécurité |
| **FGCP** | *FortiGate Clustering Protocol* : le protocole de HA |
| **local-in policy** | Politique gouvernant le trafic **vers** la machine |
| **allowaccess** | Liste des services d'administration ouverts par interface |
| **hbdev** | Interface de battement de cœur HA |
| **session-pickup** | Synchronisation des sessions entre membres HA |
| **`policy 0`** | La règle implicite de refus |
| **`Command fail. Return code -61`** | Le refus générique de la CLI FortiOS |

### 44.6 Sources

Toutes les syntaxes et sorties reproduites dans ce document proviennent
des sources suivantes, consultées à la rédaction.

| Sujet | Source |
|---|---|
| `config firewall policy` | *CLI Reference* FortiOS 7.4.4 et 7.6.4, `config-firewall-policy` |
| Cycle de vie du paquet | *Parallel Path Processing (Life of a Packet)*, Fortinet |
| Sous-commandes CLI | *Administration Guide* FortiOS 6.4/8.0, section *Subcommands* |
| `config firewall vip`, `ippool` | *CLI Reference*, `firewall vip` / `firewall ippool` |
| Central SNAT | *Administration Guide* 7.4.3, *Central SNAT* |
| `config system interface` | *CLI Reference*, `system interface` |
| `config firewall service custom` | *CLI Reference* 7.4.0 |
| `config firewall schedule recurring` | *CLI Reference* 7.4.2 |
| `config router static` | *CLI Reference* 7.2.13 |
| `config vpn ipsec phase1-interface` | *CLI Reference* 7.4.0 |
| `config system ha` | *CLI Reference* 7.4.1 |
| `config log syslogd setting` | *CLI Reference* 7.4.4 |
| `config system admin`, `accprofile` | *CLI Reference* 7.4.0 |
| Modes d'inspection et NGFW | *Inspection Mode Per Policy* ; *Profile-based vs policy-based NGFW* |
| `local-in-policy` | *Administration Guide* 7.6/8.0 |
| SD-WAN | *Configuring SD-WAN in the CLI*, 6.4 |
| `diagnose sys session list` | *Hardware Acceleration* 7.4/7.6 ; transcriptions publiques |
| `diagnose debug flow`, sniffer | Transcriptions publiques recoupées |
| `policy 0` / refus implicite | *Technical Tip: FortiGate Policy ID = 0*, Fortinet Community |

---

*Fin du document.*
