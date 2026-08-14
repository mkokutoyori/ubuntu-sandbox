# Carnet de bord — Module Pare-feu

> Suivi d'avancement de l'implémentation de `docs/BRD-Firewall.md`.
> Une entrée par mini-livraison. Ce carnet enregistre **ce qui a été
> mesuré**, pas ce qui était prévu — quand la mesure contredit le BRD,
> c'est la mesure qui est écrite, et le BRD est corrigé.

| | |
|---|---|
| **Branche** | `mandeng` |
| **BRD** | `docs/BRD-Firewall.md` |
| **Répertoire** | `src/network/devices/firewall/` |
| **Tests** | `src/__tests__/unit/network-v2/firewall/` |
| **Démarche** | TDD — rouge, vert, propre, push |
| **Portée de non-régression** | Le répertoire `firewall/` seul, sauf mention contraire |

---

## Tableau de bord

| Phase | Mini-livraison | Cas | État |
|---|---|---|---|
| — | Révision BRD : composition plutôt qu'héritage | — | ✅ |
| 1 | `FlowKey` | 30 | ✅ |
| 1 | `ZoneTable` | 32 | ✅ |
| 1 | `AddressObject` | 25 | ✅ |
| 1 | `ServiceObject` | 24 | ✅ |
| 1 | `ObjectStore` (groupes, Composite) | 37 | ✅ |
| 1 | `TcpStateMachine` | 34 | ✅ |
| 1 | Audit de non-duplication (procédure permanente) | — | ✅ |
| 1 | `SessionTable` | 33 | ✅ |
| 1 | `SecurityRule` + `PolicyEvaluator` | — | ⏳ |
| 1 | `PolicyStore` | — | ⏳ |
| 1 | `PacketContext` + `FirewallPipeline` | — | ⏳ |
| 1 | Étapes de pipeline | — | ⏳ |
| 1 | Services L3 (`l3/`) | — | ⏳ |
| 1 | Façade `Firewall` | — | ⏳ |
| 1 | Sonde de phase 1 (topologie réelle) | — | ⏳ |

**Total actuel : 215 cas, verts.**

---

## Entrées

### E0 — Révision du BRD : `Firewall extends Equipment`

**Décision renversée.** Le BRD retenait `Firewall extends Router` « pipeline
substitué » (option C). Il retient désormais l'option B : `extends Equipment`,
capacités L3 par composition.

**Ce qui a emporté la décision**, au-delà de « un pare-feu n'est pas un
routeur » : la dette héritée n'est pas neutre, elle est **active**. Un
développeur ultérieur trouverait CDP, EIGRP, HSRP et les ACL liées aux
interfaces sur le pare-feu, les croirait disponibles, et les câblerait. Le
dépôt a le précédent exact de `GenericSwitch` — ~53 sites d'appel et une
erreur nommée pour refermer ce que l'héritage avait ouvert.

**Ce que la mesure a corrigé dans mon propre raisonnement** : le
contre-argument de l'option B (« réimplémenter des milliers de lignes ») ne
tient pas. `core/ip.ts` (14 fonctions), `core/interfaces.ts`
(`IIPv4Route`, `INeighborResolver`), `core/IcmpErrors.ts`,
`core/packetBuilders.ts`, `core/Ipv4Fragmentation.ts` et `core/FilterChain.ts`
sont **déjà autonomes**. Ce qui est coûteux dans `Router.ts` — protocoles de
routage, shells vendeur, redondances FHRP — est précisément ce dont un
pare-feu n'a pas besoin. Estimation : ~700 lignes contre 5615 héritées dont
~90 % inutiles.

Ajouté §7.3.4 : les dix patrons employés, chacun rattaché à **une contrainte
nommée du document**. Un patron qui ne sert aucune contrainte n'a pas sa
place.

Risque R5 (« la dette inerte ») supprimé — il n'y a plus d'héritage.
Remplacé par R5b : la divergence éventuelle des services L3 avec ceux de
`Router`, mitigée par une règle de sens de convergence (§36.3.1).

---

### E1 — `FlowKey`

`src/network/devices/firewall/session/FlowKey.ts` — 30 cas.

**Ce que ce module décide** : la table de sessions est indexée par flux
directionnel (BRD §10.2), et un flux **n'est pas toujours symétrique par
échange des ports**.

TCP et UDP le sont. **ICMP ne l'est pas** : une réponse d'écho porte le
*même* identifiant que la demande, et ce qui s'inverse est le **type**
(8 → 0). Traiter ICMP comme TCP produirait une clé de retour que la réponse
ne porte jamais — donc un `ping` qui ne se referme pas, et l'inspection à
états qui s'effondre sur le protocole le plus utilisé en diagnostic.

L'identifiant est rangé dans l'emplacement de port source et le type
numérique dans celui de destination : c'est le choix de netfilter, et il
garde la clé en quintuplet purement numérique.

`reverse(reverse(k)) === k` est vérifié sur cinq familles (TCP, UDP, ICMP
écho, ICMP erreur, GRE) — c'est l'invariant qui garantit qu'aucun sens ne
se perd.

**Correction à consigner** : mon premier « rouge TDD » n'en était pas un.
`npm install` n'avait jamais tourné dans ce conteneur, donc le test ne
s'exécutait pas du tout — c'est `vite` qui manquait, pas le module. Après
installation, j'ai retiré l'implémentation pour vérifier l'échec **pour la
bonne raison**. Depuis, chaque brique suit le cycle rouge → vert réel.

**Second défaut, dans le TEST et non le produit** : j'avais écrit `'a'` et
`'b'` comme adresses, qu'`IPAddress` rejette à juste titre. Deux cas
corrigés côté test.

---

### E2 — `ZoneTable`

`src/network/devices/firewall/model/ZoneTable.ts` + `SecurityZone.ts` — 32 cas.

Les six invariants I-Z1 à I-Z6 sont chacun un cas. Deux sont des **pièges
pédagogiques** et non des détails :

- **I-Z4** — une zone vide est **légale** et ne correspond à **rien**. Un
  apprenant qui crée une zone, l'utilise dans une règle et oublie d'y mettre
  une interface doit voir sa règle ne jamais correspondre, jamais
  correspondre à tout. L'inverse serait une faille enseignée.
- **I-Z2** — une interface appartient à zéro ou une zone, jamais deux, et le
  refus **nomme la zone actuelle**, sans quoi le diagnostic est impossible.
  Réaffecter une interface à sa propre zone reste accepté : ce n'est pas un
  conflit.

**Injection de dépendance, première application.** `referenceChecker`
(I-Z5) et `interfaceModeOf` (I-Z6) sont injectés ; le magasin ne connaît ni
la politique ni la table d'interfaces. Absentes, elles n'imposent aucune
contrainte — position honnête tant que l'`InterfaceTable` n'existe pas,
plutôt qu'une validation qui ferait semblant.

**Erreurs typées, première application de P3.** `ZoneTable` rend
`{ kind: 'interface-already-in-zone', zone: 'trust' }`. Le socle porte le
**fait**, la couche vendeur portera le **mot**.

---

### E3 — `AddressObject`

`src/network/devices/firewall/model/AddressObject.ts` — 25 cas.

**Décision de conception** : `subnet` et `wildcard` ne sont **pas** deux
mécanismes. Les deux répondent « ce bit doit-il correspondre ? », et la
seule différence est la contiguïté du masque. L'implémentation les ramène à
un unique **masque de bits significatifs** normalisé à la construction —
sans quoi deux chemins de correspondance coexisteraient, et ce dépôt sait
ce que coûtent deux chemins qui peuvent se contredire.

**Conséquence** : la convention d'écriture devient une affaire de
*constructeur* et non de moteur. Cisco écrit un masque générique où le bit à
1 signifie « peu importe » ; `addressFromCiscoWildcard` inverse à l'entrée.
Un cas vérifie que les deux formes décrivent le **même ensemble** sur quatre
candidats — seule façon de prouver que la conversion est juste plutôt que
plausible.

**`fqdn` sans résolveur ne correspond à rien**, délibérément : un objet FQDN
figé à la création serait un littéral déguisé. Un cas vérifie qu'il **suit**
un changement de résolution, ce qui est tout l'intérêt de ce type d'objet.

---

### E4 — `ServiceObject`

`src/network/devices/firewall/model/ServiceObject.ts` — 24 cas.

**`entries` est un tableau** (BRD §8.4.1). `DNS` couvre TCP/53 **et** UDP/53,
`service-http` de PAN-OS couvre 80 et 8080. Un service mono-protocole
obligerait à créer des *groupes* là où le constructeur crée un *service* —
donc à ne pas reproduire sa configuration.

**Le port source existe** (§8.4.2). Presque tous les cours l'ignorent,
presque tous les constructeurs le proposent. Une entrée qui n'en déclare pas
ne le contraint pas.

**ICMP** se compare par type et code, mais le code n'est vérifié que si
l'entrée en déclare un : `ALL_ICMP` ne doit pas cesser de correspondre parce
qu'un message porte un code inhabituel.

---

### E5 — `ObjectStore`

`src/network/devices/firewall/model/ObjectStore.ts` — 37 cas.

Patron Composite : une règle référence un nom, et ce nom peut être un objet
ou un groupe sans qu'elle ait à le savoir.

**I-G2 — la récursion est refusée à l'écriture, dans ses deux formes** : un
groupe qui se contient lui-même à la création, et un cycle créé par ajout de
membre a posteriori (G1 → G2 → G1). Détecter à l'évaluation ne ferait que
produire un résultat faux plus tard.

**I-A5 — `referenceCount` est calculé, jamais stocké.** Transposition
directe de la colonne « Used by » de `lsmod`, calculée comme l'inverse des
dépendances déclarées : deux colonnes qui peuvent se contredire sont pires
qu'une colonne fausse.

**I-R1 — l'aplatissement est calculé à l'évaluation**, vérifié par trois
conséquences observables : membre ajouté après coup, membre retiré,
résolution FQDN qui change.

---

### E6 — `TcpStateMachine`

`src/network/devices/firewall/session/TcpStateMachine.ts` — 34 cas.

Le contre-test central du module (UC-1) : `ACLEngine`'s `tcpEstablished`
regarde les *drapeaux* du paquet courant, si bien qu'un ACK forgé passe. La
machine à états refuse cet ACK parce qu'il n'y a **pas de session**, pas
parce que ses drapeaux déplaisent.

Les motifs de rejet sont distincts et un cas vérifie qu'ils ne se
confondent pas. Les scans nmap (NULL, Xmas, FIN, SYN+FIN, SYN+RST) ont
chacun leur cas. Un paquet refusé ne rafraîchit pas la session — sinon un
attaquant la maintiendrait ouverte avec des paquets invalides.

**Doublon introduit puis corrigé — voir A1 ci-dessous.**

---

### E7 — `SessionTable`

`src/network/devices/firewall/session/SessionTable.ts` — 33 cas.

Le cœur du module. Tout le reste en dépend : c'est l'existence de la session
qui autorise le retour (UC-1), c'est elle qui portera la traduction NAT
(I-N1), c'est elle que le chemin rapide consultera (UC-4), et c'est elle que
`show conn` **lira** (P1 — une session est une mesure, pas un affichage).

**§10.2 — deux entrées d'index, un seul objet session.** Un cas vérifie
l'identité de référence (`toBe`, pas `toEqual`) entre ce que rendent la clé
aller et la clé retour : sans cela, deux objets pourraient diverger.

**§10.6.1 — l'expiration est un balayage, pas un minuteur par session.**
Conséquence assumée et vérifiée par un cas dédié : une session expire *à ou
après* son échéance, jamais avant. Un minuteur par session produirait
quelques milliers de minuteurs virtuels pour aucune fidélité gagnée.

**§10.3 — `discard` n'est pas un raffinement.** Un flux refusé installe quand
même une session, précisément pour ne pas réévaluer la politique à chaque
paquet d'un scan. Un cas vérifie qu'une session en `discard` est bien
*trouvée* — c'est tout son intérêt.

**I-S7 — fermer le parent ferme les pinholes non consommés**, et un pinhole
*consommé* survit. Sans la seconde moitié, un transfert FTP légitime serait
coupé par la fermeture de son canal de contrôle ; sans la première, une
session FTP fermée laisserait des ouvertures béantes.

L'horloge est **injectée** (`now`), ce qui rend l'expiration testable sans
horloge virtuelle globale et sans attente réelle.

---

## Audit de non-duplication

> **Procédure obligatoire, appliquée à chaque élément du module.** Avant
> d'écrire une brique, mesurer le dépôt : la chose existe-t-elle déjà ?
> Si oui, l'enrichir plutôt que la dupliquer. Si elle existe sous une forme
> voisine mais répond à une **autre question**, l'écrire et dire pourquoi.

### Résultats

| Brique | Candidat existant | Verdict |
|---|---|---|
| `FlowKey` | `LinuxIptablesManager.conntrack` (clés `string` construites en ligne), `NatSession`, `SocketTable` | **Distinct.** Le conntrack Linux indexe des tuples pour *un hôte* ; `FlowKey` indexe des flux *en transit*. Décision déjà argumentée en BRD §10.9 |
| `ZoneTable` | `CiscoSecurityConfig.zones` / `zonePairs` (ZBFW IOS) | **Voir A2 — découverte majeure** |
| `AddressObject` | `IpPrefixList.evaluate(network, prefixLength)` | **Distinct.** Une liste de préfixes rend `permit`/`deny` sur un *préfixe annoncé* (politique de routage) ; un objet adresse teste l'appartenance d'*une* adresse à un ensemble |
| `AddressObject` | `ACLEngine`'s `srcIP`/`srcWildcard` | **Distinct**, mais la sémantique du masque générique Cisco est reprise telle quelle via `core/ip.ts` plutôt que réécrite |
| `ServiceObject` | `core/WellKnownPorts.ts` — `getServiceName(port, proto)` + table `IANA` | **Contrainte enregistrée — voir A3** |
| `ObjectStore` | `object-group` n'apparaît que dans `ciscoArgumentHelp.ts` (texte d'aide) | **Aucun magasin existant** |
| `TcpStateMachine` | `tcp/types.ts` → `TcpState` ; `TcpStack.ts` (1711 l.) | **Doublon partiel — voir A1** |
| `SessionTable` | `LinuxIptablesManager.conntrack`, `SocketTable` | **Distinct.** `SocketTable` décrit ce qui *écoute sur cet hôte* ; la table de sessions décrit ce que le pare-feu *achemine* |

### A1 — `TcpSessionState` était un doublon de `TcpState`

**Défaut introduit par moi.** J'avais défini `TcpSessionState` alors que
`src/network/tcp/types.ts` porte déjà `TcpState`, qui couvre les dix états
dont j'avais besoin **plus** `listen` et `closing`.

**Correction** : le vocabulaire est désormais celui du dépôt.
`ObservedTcpState = Exclude<TcpState, 'listen'>` — un pare-feu qui observe
un flux en transit ne voit jamais `listen`, qui appartient à une extrémité
et non à un flux. Deux cas épinglent la règle et l'agrément.

**Bénéfice inattendu** : `TcpState` portait `closing`, que je n'avais pas
modélisé. La fermeture **simultanée** (les deux côtés émettent FIN) a donc
maintenant son état et son cas, au lieu d'être fondue dans `last-ack`. Le
vocabulaire partagé a rendu le modèle plus juste, pas seulement moins
redondant.

**Ce qui n'est PAS un doublon, et pourquoi** : `TcpStack.ts` est une machine
à états d'**extrémité** — elle possède ses numéros de séquence, retransmet,
contrôle la congestion. La machine du pare-feu est un **observateur** : elle
regarde passer la connexion d'autrui et juge chaque segment plausible, sans
jamais émettre. Le noyau Linux fait exactement cette séparation
(`nf_conntrack_proto_tcp.c` est distinct de sa pile TCP). Les fondre
donnerait à un équipement de transit des responsabilités d'extrémité.

**Les drapeaux** : le dépôt porte *déjà* deux types de drapeaux TCP —
`TCPFlags` (`core/types.ts`, 6 champs, ce que transporte un `TCPPacket`) et
`TcpFlags` (`tcp/types.ts`, 8 champs avec ECE/CWR, ce que transporte un
`TcpSegment`). Plutôt que de choisir un camp, la machine accepte
`ObservedTcpFlags`, le minimum structurel que **les deux** satisfont.

### A2 — Le ZBFW Cisco existe, et c'est de la configuration inerte

**Mesuré**, contre l'affirmation de `CLAUDE.md` selon laquelle « aucun
concept de pare-feu à zones n'existe dans le dépôt ». Les deux ont
partiellement tort :

- `CiscoSecurityConfig.ts` porte `zones: Map<string, Zone>` et
  `zonePairs: Map<string, ZonePair>`, et `CiscoSecurityCommands.ts`
  enregistre `zone security`, `zone-pair security` et `zone-member security`.
  Le concept **existe** donc en configuration.
- Mais `Zone` est `{ name: string }` — rien de plus. Pas d'interfaces, pas
  de type, pas d'action intra-zone. `ZonePair.servicePolicy` est une
  **chaîne**.
- **Tous** les lecteurs sont la CLI et le rendu de configuration
  (`show zone security`, `show zone-pair security`, `runningConfigLines`).
  `Router.processIPv4` ne consulte **jamais** les zones.
- `show policy-map type inspect zone-pair` rend `policy exists on zp <nom>`,
  une phrase et non une mesure.

**Conclusion** : `zone security` sur un routeur IOS est accepté, rendu, et
ne fait rien — exactement le défaut que ce dépôt passe son temps à
refermer. Il n'y a donc **aucun moteur de zones à réutiliser**, et
`ZoneTable` est le moteur que cette configuration n'a jamais eu.

**Règle de convergence, à honorer quand le ZBFW d'IOS sera câblé** (chantier
distinct de l'ASA, puisque ZBFW est un pare-feu *sur routeur*) : ce sont les
commandes Cisco qui devront alimenter `ZoneTable`, et `CiscoSecurityConfig.zones`
devra disparaître — jamais l'inverse, et jamais deux magasins de zones en
parallèle. `SecurityZone` étant strictement plus riche que `Zone`, la
convergence ne perd aucune information.

À corriger dans `CLAUDE.md` le jour où ce module atteindra la couche
vendeur : l'affirmation « aucun concept de zone » est inexacte.

### A3 — Le catalogue de services prédéfinis devra lire `WellKnownPorts`

`core/WellKnownPorts.ts` porte une table `IANA` et `getServiceName(port, proto)`.
Aucune duplication **aujourd'hui** — `ObjectStore` ne fournit que `any`.

**Contrainte enregistrée pour le §8.4.3** (catalogues prédéfinis par
vendeur) : les noms et numéros de port doivent venir de cette table, et non
d'une seconde table écrite à côté. Un simulateur où `HTTP` vaudrait 80 dans
un fichier et 8080 dans un autre serait exactement le défaut de départ.

---

## Décisions prises en cours de route

| # | Décision | Motif |
|---|---|---|
| D1 | `Firewall extends Equipment` | E0 |
| D2 | ICMP indexé par (id, type) et non par ports | E1 |
| D3 | `subnet` et `wildcard` unifiés sur un masque de bits significatifs | E3 |
| D4 | Erreurs typées discriminées, jamais des chaînes | E2 |
| D5 | Dépendances externes injectées, défauts permissifs et déclarés | E2 |
| D6 | Vues gelées en profondeur | E2, E3, E4 |
| D7 | Vocabulaire TCP repris de `tcp/types.ts`, jamais redéfini | A1 |
| D8 | Machine à états observatrice distincte de la pile d'extrémité | A1 |
| D9 | Audit de non-duplication obligatoire avant chaque brique | A1, A2 |

## Défauts trouvés dans mon propre travail

| # | Défaut | Où | Correction |
|---|---|---|---|
| B1 | « Rouge TDD » qui n'en était pas un (`vite` absent) | E1 | Installation puis remesure |
| B2 | Adresses `'a'`/`'b'` invalides dans un test | E1 | Adresses réelles |
| B3 | `TcpSessionState` redéfinissait `TcpState` du dépôt | E6 | `ObservedTcpState = Exclude<TcpState, 'listen'>` ; a fait gagner l'état `closing` |

## Prochaines étapes

1. `SessionTable` — le cœur du module.
2. `PolicyEvaluator` puis `PolicyStore`.
3. `PacketContext` + `FirewallPipeline` sur `FilterChain`.
4. Services L3 (`l3/`) — audit de non-duplication à faire contre `Router`.
5. Façade `Firewall` sur `Equipment`.
