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
| 1 | `SecurityRule` + `PolicyEvaluator` | 37 | ✅ |
| 1 | `PolicyStore` | 31 | ✅ |
| 1 | `PacketContext` + `FirewallPipeline` | 23 | ✅ |
| 1 | Étapes du pipeline (7 étapes) | 30 | ✅ |
| 1 | `InterfaceTable` + `RouteTable` (`l3/`) | 31 | ✅ |
| 1 | `ArpService` | 23 | ✅ |
| 1 | Façade `Firewall` + `L2Delivery` | — | ⏳ |
| 1 | Façade `Firewall` | — | ⏳ |
| 1 | Sonde de phase 1 (topologie réelle) | — | ⏳ |

**Total actuel : 390 cas, verts.**

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

### E8 — `SecurityRule` + `PolicyEvaluator`

`src/network/devices/firewall/policy/PolicyEvaluator.ts` — 37 cas.

**Audit préalable (A4)** — candidat : `ACLEngine.evaluateACL`, qui est bien
une itération première-correspondance rendant `permit`/`deny`. **Verdict :
distinct.** `ACLEntry` n'a ni zone, ni objet nommé, ni service nommé, ni
horaire, ni utilisateur, ni application, ni compteur d'octets ; c'est un
matcher de *littéraux* lié à une interface et une direction. Extraire une
primitive « itérer et rendre la première correspondance » coûterait plus
cher qu'elle ne rapporte : trois lignes, sur deux types de critères sans
recouvrement.

**Divergence délibérée, mesurée et écrite** : `evaluateACL` rend `null` pour
une ACL absente **ou vide** — « aucune ACL appliquée, pas deny-all », qui est
le vrai comportement d'IOS. Un pare-feu fait l'**inverse** : une politique
vide REFUSE (P8). Copier ici la sémantique de l'ACL ouvrirait le pare-feu en
grand le jour où la politique est vide. Un cas l'épingle.

**I-P3 vérifié par ses deux moitiés** : la règle qui correspond compte, la
règle traversée sans correspondre ne compte pas. Sans la seconde, le
compteur ne servirait à rien pour le diagnostic.

**Les niveaux de sécurité ASA** sont un mode du même évaluateur, avec un
**témoin** monté dans le même laboratoire : sous `deny-all`, haut→bas est
refusé ; sous `security-level`, il est autorisé sans aucune règle. Sans ce
témoin, les deux modes seraient indiscernables.

**Défaut trouvé dans mon propre test (B4)** : j'avais écrit « inverser
l'ordre du tableau inverse le verdict », ce qui contredisait le cas voisin
épinglant que c'est la **séquence** qui décide. L'évaluateur avait raison ;
le test exprimait mal I-P2. Corrigé en échangeant les séquences — ce que
« déplacer une règle » veut dire.

---

### E9 — `PolicyStore`

`src/network/devices/firewall/model/PolicyStore.ts` — 31 cas.

**I-P5 gouverne tout le fichier : `seq` n'est pas l'identifiant.** FortiOS
numérote ses politiques par un identifiant stable (`edit 3`) tout en les
ordonnant séparément — `move 3 after 7` change l'ordre, pas l'identifiant.
Confondre les deux rendrait `move` impossible à simuler, alors que c'est la
manipulation la plus courante d'une politique en production. Les séquences
sont donc **recalculées** après chaque mutation (pas de 10, comme une ACL
IOS), et un cas vérifie qu'elles restent croissantes et distinctes.

**Le bouclage des références est fermé ici.** `zoneReferents()` et
`objectReferents()` alimentent le `referenceChecker` de `ZoneTable` (I-Z5)
et les `externalReferences` d'`ObjectStore` (I-A1). Sans ce bouclage,
supprimer une zone citée par une règle serait accepté et la règle
pointerait dans le vide.

Deux décisions dans ce bouclage, chacune avec son cas : une règle
**désactivée** référence toujours (elle peut être réactivée), et `any` ne
compte **pas** comme une référence (il est prédéfini et indestructible, donc
le compter empêcherait toute suppression d'objet pour rien).

---

### E10 — `PacketContext` + `FirewallPipeline`

`src/network/devices/firewall/pipeline/` — 23 cas.

**Le pari d'architecture du module, vérifié plutôt que répété.** P2 affirme
que l'ordre d'opérations est une *donnée*. Un cas le prouve : deux profils
qui ne diffèrent **que** par leur liste d'étapes produisent deux traces
différentes, sans qu'aucune ligne de code ne les distingue.

**Audit préalable (A5)** — `core/FilterChain.ts` existait, complet et
**inutilisé** (BRD §4.1.5 l'avait mesuré). Rien n'est réécrit : verdicts,
propagation, conversion des exceptions en rejet, publication d'événements
viennent de là. Les deux seules nouveautés sont le **registre d'étapes**
(patron Registre, point d'extension E1) et la **composition depuis une
liste de noms**.

**G7 — une étape déclarée mais absente du registre est refusée à la
composition**, et l'erreur nomme l'étape. Trois cas : le refus, le nom, et
l'absence de composition partielle. Sans cela, une faute de frappe dans un
profil produirait un pare-feu qui saute une étape sans que rien ne le dise —
exactement le défaut « accepté et inerte » que ce dépôt referme partout.

**`originalPacket` ne suit pas les transformations du courant**, et un cas
l'épingle. C'est ce qui permettra à un profil ASA 8.2 (ACL sur les adresses
traduites) et à un profil 8.3+ (ACL sur les adresses réelles) de coexister
sans branchement dans le moteur.

---

### E11 — `InterfaceTable` + `RouteTable`

`src/network/devices/firewall/l3/` — 31 cas. Les deux premiers services de
couche 3, **par composition** (arbitrage A1).

**Audit préalable (A6)** — mesuré, pas supposé. `Router.lookupRoute` est
enchevêtré avec sept magasins `maximum-paths` par protocole, un curseur
ECMP, `isRouteUsable`, le rafraîchissement du plan de contrôle et
l'intégration IPsec, dans un fichier de 5615 lignes. Rien de cela n'est ce
dont un pare-feu a besoin. **Réutilisés en revanche** : `core/ip.ts`
(arithmétique d'adresses) et `core/RoutingTable.ts` (primitives de
correspondance). Le service du pare-feu fait 180 lignes.

**Les routes connectées sont dérivées, jamais saisies.** Trois cas le
vérifient par leurs conséquences : une interface qui tombe retire sa route,
une interface qui remonte la remet, et une interface ajoutée après coup
apparaît dans la table sans qu'on l'y écrive. Sans cela, un pare-feu
continuerait d'acheminer vers un lien mort.

**Un saut suivant hors de tout sous-réseau connecté ne résout pas.** Ce
dépôt connaît déjà ce défaut côté routeur — « aucune résolution récursive de
saut suivant », `CLAUDE.md` — et le reproduire ici serait le repayer. La
limite est donc la même, mais **assumée et testée** plutôt que subie.

**Reste ouvert et déclaré** : ECMP et les protocoles dynamiques (BRD §19).
Le jour où le pare-feu en aura besoin, la logique `maximum-paths` devra être
**extraite** de `Router` vers un module partagé, jamais recopiée — même règle
de sens que A2 pour les zones.

---

### E12 — Les étapes du pipeline

`src/network/devices/firewall/pipeline/stages/coreStages.ts` — 30 cas.

Le premier fichier à faire travailler ensemble `ZoneTable`,
`InterfaceTable`, `RouteTable`, `PolicyEvaluator`, `SessionTable` et
`TcpStateMachine`. C'est donc le premier à pouvoir démontrer les **cas
d'usage fondateurs** au lieu de briques isolées.

**UC-1 est démontré** : une seule règle, dans le sens aller ; le retour
passe parce que la session existe. Le contre-test l'accompagne — un ACK
forgé sans session est refusé avec `no-session-non-syn` — et purger la
session coupe le retour immédiatement.

**UC-4 est mesuré, pas affirmé** : le compteur de la règle vaut 1 après le
premier paquet et **ne bouge plus** pour les suivants. Un second cas vérifie
que la trace du chemin rapide ne contient pas `policy-lookup`. I-F1 devient
ainsi vérifiable plutôt que déclaratif.

**P9 a son cas** : une règle supprimée ne coupe pas la session en cours.

**P10 a ses cinq motifs distincts**, chacun avec son cas : `implicit-deny`,
`policy-deny`, `no-route`, `invalid-tcp-flags`, `zone-mismatch`.

#### Défaut trouvé et corrigé dans le même passage (B6)

Un avertissement de lint (`services` inutilisé) a mis sur la piste d'un vrai
défaut : `tcp-state-check` créait une machine à états **neuve à chaque
paquet**, et le chemin rapide ne la traversait jamais — la machine ne
servait donc qu'au premier paquet. Or le BRD §13.8 exige explicitement
qu'« un paquet invalide dans une session valide soit rejeté ».

Corrigé : la session **porte** sa machine (`FirewallSession.tcpMachine`), et
`session-lookup` la fait avancer sur chaque paquet du chemin rapide. Cinq
cas neufs l'épinglent — l'état avance au fil de la poignée de main, un Xmas
scan dans une session établie est rejeté (avec son témoin : un ACK ordinaire
passe), un RST ferme la session, et le délai d'expiration suit l'état
(30 s en poignée de main, 3600 s une fois établie).

**Ce que ce défaut enseigne** : un test qui ne couvre que le premier paquet
laisse passer une inspection à états qui n'inspecte qu'une fois. La suite
était verte avant le correctif — c'est le lint, puis la relecture du BRD,
qui ont trouvé le trou.

---

### E13 — `ArpService`

`src/network/devices/firewall/l3/ArpService.ts` — 23 cas.

**Audit préalable (A7)** — `src/network/arp/` existe mais porte
l'**inspection** ARP (DAI, une fonction de sécurité de commutateur) :
`ArpInspectionEngine`, `ArpRateLimiter`, `ArpStats`. Aucun cache de voisins
réutilisable. **En revanche** `core/interfaces.ts` *déclare* déjà
`INeighborResolver<TAddress>`, pensé pour unifier ARP et NDP. Ce service
**implémente ce contrat** au lieu d'inventer une interface voisine — c'est
la règle du carnet appliquée à la lettre : enrichir l'existant.

**Le fait qui compte** : un pare-feu ne répond à une demande ARP que pour
les adresses **qu'il porte**, et deux cas le vérifient — il ne répond ni
pour un tiers du sous-réseau, ni pour l'adresse d'une *autre* de ses
interfaces. Répondre pour autrui est du proxy ARP, une fonction distincte
qui se configure ; l'activer par défaut ferait du pare-feu un trou noir pour
tout le segment.

**Une demande ARP apprend son émetteur, même sans réponse.** C'est ce qui
évite l'aller-retour symétrique : quand A demande l'adresse de B, B connaît
déjà A. Un cas l'épingle sur une demande à laquelle le pare-feu ne répond
pas.

**Statique contre appris** : l'entrée apprise expire, la statique non, et
un réapprentissage repousse l'échéance. C'est ce qui distingue une table qui
*suit* le réseau d'une table qui le *décrète*.

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
| `PolicyEvaluator` | `ACLEngine.evaluateACL`, `Ipv6AclEngine`, `RoutePolicy` | **Distinct — voir A4** |
| `PolicyStore` | aucun magasin de politique ordonnée n'existe | **Aucun** |
| `FirewallPipeline` | `core/FilterChain.ts` | **RÉUTILISÉ tel quel — voir A5** |
| `InterfaceTable` / `RouteTable` | `Router.lookupRoute`, `core/RoutingTable.ts`, `core/ip.ts` | **Primitives réutilisées, moteur distinct — voir A6** |
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

### A4 — `PolicyEvaluator` n'est pas `ACLEngine`, et ne doit pas lui ressembler

`ACLEngine.evaluateACL` itère une liste et rend la première correspondance,
comme le fera l'évaluateur de politique. La ressemblance s'arrête là :
`ACLEntry` n'a ni zone, ni objet nommé, ni service nommé, ni horaire, ni
utilisateur, ni application, ni compteur d'octets.

**Le point à ne pas rater est une divergence, pas une ressemblance** :
`evaluateACL` rend `null` pour une ACL absente **ou vide**, avec le
commentaire « Undefined or empty ACL = no ACL applied (real IOS), not
deny-all ». C'est juste pour IOS. Un pare-feu fait l'inverse — politique
vide vaut refus (P8). Réutiliser ce moteur aurait importé sa sémantique
d'ouverture par défaut dans un équipement dont le premier principe est de
refuser.

Aucune primitive commune n'est extraite : « itérer et rendre la première
correspondance » fait trois lignes, et une abstraction partagée sur deux
types de critères sans recouvrement coûterait plus qu'elle ne rapporte.

### A5 — `FilterChain` est réutilisé, pas réécrit

`core/FilterChain.ts` (337 lignes) portait déjà tout ce dont le pipeline a
besoin : verdicts `continue`/`accept`/`transform`/`drop`/`reject`,
propagation du contexte transformé, trace des filtres traversés,
`decidedBy`, conversion des exceptions d'un filtre en rejet plutôt qu'en
remontée, et publication d'événements sur le bus.

Le BRD l'avait mesuré comme « écrit et inutilisé » (§4.1.5) — c'était une
opportunité, pas un signal négatif. `FirewallPipeline` n'ajoute que deux
choses : un **registre** d'étapes nommées et la **composition** d'une chaîne
à partir d'une liste de noms. Le moteur de chaîne lui-même n'est pas touché.

### A6 — `RouteTable` réutilise les primitives, pas le moteur

`Router.lookupRoute` porte sept magasins `maximum-paths` (un par protocole
et par constructeur), un curseur ECMP tournant, `isRouteUsable`, un appel à
`dynamicRouting.refresh()` — c'est-à-dire une recomputation de plan de
contrôle déclenchée par le plan de données — et l'intégration IPsec. Un
pare-feu n'a besoin d'aucun de ces cinq mécanismes aujourd'hui.

**Réutilisé** : `core/ip.ts` (14 fonctions d'arithmétique d'adresses) et
`core/RoutingTable.ts` (39 lignes de primitives de correspondance). Le
service du pare-feu fait 180 lignes contre les 5615 de `Router.ts`.

**Règle de convergence enregistrée** : le jour où le pare-feu aura besoin
d'ECMP ou de `maximum-paths` (BRD §19), cette logique devra être **extraite**
de `Router` vers un module partagé et consommée par les deux — jamais
recopiée. Même sens que A2.

### A7 — `ArpService` implémente un contrat qui existait déjà

`src/network/arp/` ne contient aucun résolveur : ses quatre fichiers portent
l'inspection ARP dynamique (DAI), une fonction de sécurité de commutateur.
Rien à réutiliser de ce côté.

Mais `core/interfaces.ts` déclare `INeighborResolver<TAddress>` avec
`resolve`/`learn`/`lookup`/`getCache`/`clear`, explicitement conçu pour
« unifier les motifs de résolution ARP et NDP ». `ArpService` l'implémente,
et `ArpEntry extends INeighborEntry`. Le jour où le pare-feu parlera NDP,
le même contrat servira.

`core/packetBuilders.ts` (`wrapIpv4InEthernet`, `buildIpv4Frame`) est réservé
pour `L2Delivery`, la brique suivante.

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
| B4 | Test I-P2 auto-contradictoire (ordre du tableau vs séquence) | E8 | Le test exprimait mal l'invariant ; l'évaluateur avait raison |
| B5 | Test « absence de route » visant une destination CONNECTÉE | E12 | Le moteur avait raison ; test corrigé + témoin ajouté |
| B6 | Machine à états TCP non traversée par le chemin rapide | E12 | La session porte sa machine ; 5 cas neufs |

## Prochaines étapes

1. `SessionTable` — le cœur du module.
2. `PolicyEvaluator` puis `PolicyStore`.
3. `PacketContext` + `FirewallPipeline` sur `FilterChain`.
4. Services L3 (`l3/`) — audit de non-duplication à faire contre `Router`.
5. Façade `Firewall` sur `Equipment`.
