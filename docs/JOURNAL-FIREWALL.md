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
| 1 | `ArpService` | 33 | ✅ |
| 1 | Façade `Firewall` (équipement) | 15 | ✅ |
| 1 | Sonde de phase 1 (topologie réelle) | ✅ incluse | ✅ |
| **2** | **Extraction des primitives NAT (DRY)** | 571 réf. | ✅ |
| 2 | `NatPolicyStore` + `FirewallNatEngine` | 24 | ✅ |
| 2 | Conformité RFC 4787 (REQ-1, REQ-3) | 6 | ✅ |
| 2 | Câblage NAT dans le pipeline (§12.4) | 15 | ✅ |
| 2 | Sonde de phase 2 (publication sur le fil) | 10 | ✅ |
| **3** | Règle ASA « une ACL annule le permit implicite » | 6 | ✅ |
| 3 | `FirewallProfile` + `AsaProfile` + `AsaFirewall` | 21 | ✅ |
| 3 | Garde-fous d'architecture (G1, G2, G3, G5) | 12 | ✅ |
| 3 | `AsaShell` (grammaire CLI) | 45 | ✅ |
| 3 | Simulation d'un paquet (socle de `packet-tracer`) | 19 | ✅ |
| 3 | `packet-tracer` (rendu ASA) | 19 | ✅ |
| 3 | NAT objet ASA (`nat (dmz,outside) static`) | — | ⏳ |
| 3 | `ShellFactory` + `DeviceFactory` | — | ⏳ |

**Total actuel : 603 cas verts sur 22 fichiers** (729 avec les suites
connexes). **Phases 1 et 2 fonctionnelles ; phase 3 en cours.**

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

#### Correction majeure — mon audit initial était incomplet (B7)

**J'avais audité `src/network/arp/` et rien d'autre.** L'utilisateur a
insisté pour que l'exploration soit systématique, et il avait raison : la
mesure complète a montré que j'avais créé un **doublon partiel**.

| Ce qui existait déjà | Ce que j'avais fait |
|---|---|
| `ARPEntry` défini dans `EndHost.ts:108`, avec `type: 'dynamic' \| 'static' \| 'failed'`, importé par **9 fichiers / 29 sites** | Inventé un `ArpEntry` avec `isStatic: boolean` |
| L'état `'failed'` (NUD FAILED) déjà modélisé | Omis |
| `Router.handleARP` détecte les adresses dupliquées | Omis |
| `LinuxArp.ts` lit une `Map<string, ARPEntry>` | Ma table n'aurait pas été lisible par la commande `arp` |

**Corrigé, et l'occasion a servi à améliorer le dépôt** : `ARPEntry` était un
type *partagé* (Router, EndHost, Cisco, Linux, Windows) rangé dans
`EndHost.ts`. Il est déplacé vers `core/types.ts`, à côté d'`ARPPacket`, et
**ré-exporté depuis `EndHost.ts`** pour qu'aucun des 29 sites ne casse.
`ArpService` l'utilise désormais, avec les trois états et la détection
d'adresse dupliquée. Dix cas neufs.

**Régression connexe exécutée** : les quatre suites ARP du dépôt
(`arp-aware-control-plane`, `arp-command`, `arp-icmp-redirect`,
`arp-persistence-on-switch`) — 89 cas, verts.

**Ce que cette correction enseigne, et pourquoi elle est ici** : un audit
qui ne regarde que le répertoire portant le nom du sujet passe à côté. Les
implémentations réelles de ce dépôt vivent dans les équipements, pas dans
les répertoires de protocole. La procédure d'audit est corrigée en
conséquence (voir la note de méthode ci-dessous).

---

### E14 — La façade `Firewall`, et la sonde de phase 1

`src/network/devices/firewall/Firewall.ts` — 15 cas, sur une **topologie
réelle**.

Tout ce qui précédait était testé en isolation. Ici le pare-feu est déposé
entre deux postes Linux, câblé pour de bon, et le trafic est un **vrai
`ping`** : des trames traversent `Port` et `Cable`, l'ARP est résolu par un
échange réel, et le verdict vient du pipeline. C'est le principe P6 appliqué
au module entier.

**UC-1 est démontré sur le fil** : une seule règle `trust → untrust`, et le
ping répond. Avec **son témoin** — la même topologie sans règle ne répond
pas — et **son inverse** — une règle qui n'autorise que le retour ne suffit
pas, puisque c'est l'aller qui ouvre la session.

`Firewall extends Equipment` : l'arbitrage A1 tient. Aucune ligne héritée de
`Router`. La classe fait 210 lignes et ne contient **aucune décision** —
elle assemble et délègue, conformément au patron Façade.

#### Trois défauts trouvés en montant la sonde (B8, B9, B10)

Aucun n'aurait été vu par les tests unitaires : il a fallu de vraies trames.

**B8 — la requête ARP partait vers l'adresse MAC nulle** au lieu de la
diffusion. `buildRequest` remplit correctement `targetMAC` à zéro *dans la
charge utile ARP* — c'est la RFC — mais la destination **Ethernet** doit
être la diffusion. Deux notions différentes que le même champ pouvait faire
confondre.

**B9 — le paquet était jeté pendant la résolution ARP.** Corrigé en tirant
parti d'une propriété réelle de ce simulateur : la livraison est
**synchrone**, donc l'aller-retour ARP se termine à l'intérieur de l'appel
qui a émis la requête. Le pare-feu réinterroge donc son cache juste après
avoir émis, et trouve. Un vrai routeur perdrait le premier paquet ; ici il
ne le perd pas, et c'est une conséquence assumée du modèle synchrone plutôt
qu'un oubli.

**B10 — le plus intéressant : le chemin rapide n'avait pas d'interface de
sortie.** `route-lookup` ne s'exécute pas sur le chemin rapide (c'est tout
son intérêt, I-F1), donc `egressPort` restait indéfini et **le paquet de
retour était jeté**. Le BRD le disait pourtant en toutes lettres (§13.8,
« Recherche de route → non → **mémorisée sur la session** ») : l'interface de
sortie doit venir de la session, et pour le sens `s2c` c'est l'interface
d'*entrée* de la session — la réponse repart par où la demande est venue.

Ce défaut est la meilleure justification de cette sonde : les 400 cas
unitaires étaient verts, et le pare-feu ne faisait pas passer un ping.

---

### E15 — Phase 2 : l'extraction des primitives NAT

`src/network/nat/rewrite.ts` — **la seule modification de code existant que
le BRD prévoit** (§36.4), et la seule qui exige la suite complète avant et
après.

**Référence capturée d'abord** : 557 cas verts sur 14 fichiers (8 suites
`nat-*` plus 6 adjacentes). **Après extraction** : 571 verts sur 15 —
identique, plus `linux-nat-redirect-output` ajouté au périmètre.

**Ce qui est désormais partagé, en un seul exemplaire** :
`recomputeL4Checksum`, `rewriteSrcIP`, `rewriteDestIP`, `getPacketSrcPort`,
`getPacketDstPort`, `isBroadcastOrMulticastDest`, `parseNatAddress`,
`rewriteNatAddress`.

**Le doublon que `CLAUDE.md` déclarait « délibérément non unifié » est
refermé.** `EndHost.ts` portait ses propres `parseNatAddress` /
`rewriteNatAddress` — « même forme, moteur différent, consolidation non
demandée ». Elle l'est maintenant. `PRD-Port-Forwarding.md` avait dû
corriger **deux fois** le même défaut de somme de contrôle L4 (phase 1 sur
`NATEngine`, phase 5 sur `EndHost`) : c'est précisément ce que cette fusion
rend impossible à repayer une troisième fois.

**Deux différences réelles mesurées avant de fondre**, plutôt que supposées
équivalentes :

| | `EndHost` | `NATEngine` | Retenu |
|---|---|---|---|
| `parseNatAddress` | `parseInt` (accepte `"80x"` → 80) | — | **`parseInt`** — la sémantique en production, pour ne rien changer en douce |
| `rewriteNatAddress` | ne réécrit **pas** l'identifiant ICMP | le réécrit | Celle de `NATEngine`, strictement plus complète |

La seconde est un élargissement de comportement, borné : la branche ICMP ne
s'exécute que si un port est fourni, ce qu'un DNAT iptables sur ICMP ne fait
pas. Les 571 cas le confirment.

#### Défaut introduit et corrigé (B11)

Mon script d'extraction n'a pas trouvé son point d'ancrage et a inséré le
bloc d'`import` **à l'intérieur du commentaire d'en-tête** du fichier — donc
neutralisé. Cinq cas sont tombés.

**Ce que j'ai mal fait en le diagnostiquant** : mon contrôle `tsc` avait
filtré la sortie sur un motif trop étroit et n'a rien montré, ce qui m'a
fait croire le type-check passé. C'est la **référence verte capturée avant**
qui a rattrapé l'erreur — exactement ce pour quoi le BRD l'exigeait. J'ai
confirmé la responsabilité en restaurant l'original sur ce seul fichier
(6 cas verts) avant de corriger.

---

### E16 — `NatPolicyStore` + `FirewallNatEngine`

`src/network/devices/firewall/nat/` — 24 cas.

Le moteur consomme les primitives partagées d'E15 : **aucune fonction de
réécriture n'est réécrite ici.**

**I-N1 et I-N2 sont ce qui distingue ce moteur de celui du routeur.** La
traduction est décidée au premier paquet et **rendue pour être mémorisée sur
la session** ; `reapply()` la réapplique sans consulter la politique, et un
cas le mesure par le compteur `rulesEvaluated` qui ne bouge pas. Le retour
applique l'inverse, lu sur la **même** traduction.

C'est structurellement ce qui rend impossible le défaut que
`PRD-Port-Forwarding.md` a dû corriger **deux fois** côté routeur : la
traduction vit sur la session, pas sur la règle.

#### Deux défauts dans mes propres tests (B12, B13)

Les deux venaient d'une méconnaissance du comportement réel, et le moteur
avait raison les deux fois.

**B12** — j'avais écrit qu'un PAT « réécrit le port source ». **Faux** : un
vrai PAT *préserve* le port quand il est libre (Cisco et netfilter le
documentent tous deux) et n'en change que sur collision. Le cas est
reformulé, et un second cas épingle la collision.

**B13** — j'utilisais le port 1000, **hors de la plage PAT** (1024-65535),
donc non préservable. Corrigé, et un cas dédié épingle désormais cette
règle plutôt que de la laisser implicite.

---

### E17 — Vérification contre les standards, et deux corrections

**Cette entrée existe parce que la recherche a trouvé un défaut dans ce que
je venais d'écrire.** Elle justifie d'en faire une habitude plutôt qu'un
geste ponctuel.

#### RFC 4787 — non-conformité trouvée et corrigée

La lecture des exigences de comportement NAT (BCP 127) a montré que mon
allocateur violait **REQ-1, *Endpoint-Independent Mapping*** : il indexait
les ports utilisés par adresse *traduite* seulement, si bien que le même
couple (IP interne, port interne) recevait **deux ports externes différents**
selon la destination. C'est un *Address-and-Port-Dependent Mapping*, que la
RFC interdit — et dont la conséquence pratique est que toute traversée de
NAT (STUN, WebRTC, jeux en ligne) échoue.

Corrigé par une table de mappage indexée par point de terminaison interne.
Six cas neufs épinglent REQ-1 (mapping stable, y compris quand le port
préféré a dû être changé) et **REQ-3** (pas de *port overloading* : deux
sources n'obtiennent jamais le même port).

Ce que la RFC a aussi **confirmé**, et que j'avais deviné juste : « if the
host's source port was in the range 1024-65535, it is RECOMMENDED that the
NAT's source port be in that range ». La préservation de port bornée à la
plage est donc citée, plus supposée.

#### PAN-OS — la documentation est plus précise que mon BRD

« **Pre-NAT IP, post-NAT everything else** », et surtout : la traduction
« n'a pas lieu tant que le paquet n'a pas quitté le pare-feu ». La
destination NAT doit donc être **décidée avant le routage** — sans quoi la
décision porterait sur l'adresse publique et désignerait la mauvaise
interface de sortie, donc la mauvaise zone, donc la mauvaise règle — tandis
que la politique lit les adresses **pré-NAT**.

C'est exactement ce que `originalPacket` permet, et le BRD §7.5 l'avait
anticipé : « sa simple présence permet aux deux profils de coexister sans
branchement dans le moteur ». Vérifié : un cas monte **la même règle et le
même paquet**, et obtient `accepted` sous le profil PAN-OS et `dropped` sous
le profil ASA 8.3+ — par un seul booléen.

---

### E18 — Le NAT dans le pipeline

Deux étapes neuves, `nat-destination` (avant le routage) et `nat-source`
(après la politique), plus la lecture pré/post-NAT par la politique. 15 cas.

La traduction décidée est **portée jusqu'à `session-install`** et posée sur
la session : c'est I-N1 réalisé de bout en bout. Un cas vérifie qu'un flux
**refusé** n'alloue aucune traduction — sinon un scan épuiserait le pool.

---

### E19 — Sonde de phase 2 : la publication répond sur le fil

10 cas, sur une topologie réelle.

La sonde de phase 1 prouvait l'inspection à états ; celle-ci prouve la
**traduction**, et surtout sa moitié la plus facile à rater : **le retour**.
L'aller se teste tout seul ; le retour ne se voit que du côté du client — si
le pare-feu ne réécrit pas la source du serveur en adresse publique, le
client reçoit une réponse d'une machine à qui il n'a rien demandé et la
jette. Un cas vérifie que la sortie du `ping` contient l'adresse **publique**
et **pas** l'adresse réelle.

**Deux témoins**, parce qu'un seul ne suffirait pas à distinguer les causes :
sans règle NAT le ping échoue, et sans règle de politique **non plus**. Il
faut les deux, et le laboratoire le montre.

La topologie évite délibérément le proxy ARP : l'adresse publique
n'appartient à aucun sous-réseau connecté, donc le client l'atteint par sa
route par défaut. Un laboratoire qui aurait mis la VIP dans le sous-réseau
du client aurait testé le proxy ARP sans le savoir.

#### Défaut trouvé par la sonde (B14)

Le PAT sortant échouait, et la cause est de la même famille que B10. La
réponse du client revient vers `198.51.100.1` — **l'adresse du pare-feu
lui-même**, puisque c'est elle qui a servi de source traduite. Elle était
donc consommée en **livraison locale** au lieu d'être dé-NATée et
réacheminée.

Corrigé : **la recherche de session précède le test « est-ce pour nous ? »**.
Un paquet adressé à notre propre adresse mais appartenant à une session
existante est du transit, pas du trafic local. C'est le comportement réel, et
il n'est pas devinable depuis les tests unitaires — il fallait un PAT complet
sur un vrai câble.

---

### E20 — La recherche corrige encore le socle : l'ACL annule le permit implicite

Avant d'écrire le profil ASA, vérification documentaire du point que le BRD
§27.3 signalait comme « mal dit par beaucoup de cours ». Il l'était aussi
dans mon évaluateur.

**Fait établi** : dès qu'un `access-group` est appliqué à une interface, le
*permit* implicite haut→bas **cesse d'être actif** pour le trafic entrant
sur cette interface. Le trafic est alors gouverné exclusivement par l'ACL, et
ce qui n'y est pas explicitement autorisé est refusé.

C'est la source du symptôme le plus fréquent en formation ASA — « j'ai
ajouté une ACL et tout s'est arrêté » — et mon évaluateur laissait passer le
haut→bas quoi qu'il arrive.

Corrigé par une dépendance injectée, `interfaceHasBoundPolicy`, consultée
avant la règle de niveau de sécurité. **L'annulation est par interface, pas
globale**, et un cas l'épingle : une interface avec ACL refuse pendant qu'une
interface sans ACL autorise, sur le même équipement au même instant.

Six cas, dont le témoin (même topologie sans ACL liée) et le contrôle que
cette dépendance ne change **rien** sous `deny-all` — elle ne concerne que
le modèle ASA.

---

### E21 — `FirewallProfile` et sa première instance, ASA

`FirewallProfile.ts` + `vendors/asa/` — 21 cas.

**Le profil EST le contrat** (BRD §26.2), et ce fichier vérifie deux choses
distinctes : que le profil *déclare* ce qu'un ASA fait, et que l'équipement
*construit depuis ce profil* se comporte en conséquence. Un profil déclaratif
que rien ne lirait serait exactement le défaut « accepté et inerte ».

D'où la moitié du fichier sur le fil : **inside → outside passe sans aucune
règle, outside → inside non**. C'est ce qui distingue un ASA de tous les
autres pare-feux du BRD.

**Le socle est devenu paramétrable sans un seul branchement vendeur** :
nommage et nombre de ports, pipeline, ordre NAT, clé de politique, politique
implicite et niveaux de sécurité viennent tous du profil. `AsaFirewall` fait
**46 lignes** et ne contient aucune décision.

`same-security-traffic permit inter-interface` est un troisième mode de la
même règle de niveau, pas un mécanisme séparé : même niveau refusé par
défaut, autorisé quand le drapeau est posé.

---

### E22 — Les garde-fous d'architecture

`architecture-guards.test.ts` — 12 cas. Ils ne testent aucun comportement :
ils testent des **contraintes**. Les affirmations du BRD sur la
maintenabilité ne valent que si quelque chose les vérifie ; sans cela elles
se dégradent au premier raccourci et personne ne s'en aperçoit avant la
troisième déclinaison.

Écrits **maintenant**, alors qu'il n'y a qu'un vendeur, parce qu'un
garde-fou ajouté après coup constate les dégâts au lieu de les empêcher.

G1 (aucun moteur ni verdict dans la couche vendeur), G2 (aucun branchement
vendeur ni import de `vendors/` dans le socle), G3 (≤ 800 lignes, NFR-M3),
G5 (aucun minuteur global).

#### Deux faux positifs de mes propres garde-fous (B15)

Les deux ont échoué au premier jet, et **le code avait raison les deux
fois** :

- `setTimeout` est une **méthode** de `SessionTable`, pas le minuteur global.
- Les `// ───` sont des **séparateurs de section**, convention établie du
  dépôt (`Equipment.ts`, `Port.ts`, `core/types.ts`), pas des explications.

J'ai **précisé** les garde-fous plutôt que de les relâcher, et ajouté deux
cas qui testent **le garde-fou lui-même** — un contrôle qui ne sait pas
distinguer ce qu'il cherche finit par être désactivé.

---

## Audit de non-duplication

> **Procédure obligatoire, appliquée à chaque élément du module.** Avant
> d'écrire une brique, mesurer le dépôt : la chose existe-t-elle déjà ?
> Si oui, l'enrichir plutôt que la dupliquer. Si elle existe sous une forme
> voisine mais répond à une **autre question**, l'écrire et dire pourquoi.
>
> **Méthode, corrigée après le défaut B7.** Regarder le répertoire qui porte
> le nom du sujet ne suffit pas — dans ce dépôt les implémentations réelles
> vivent souvent dans les ÉQUIPEMENTS (`Router.ts`, `EndHost.ts`,
> `LinuxMachine.ts`) et les répertoires de protocole ne portent qu'une
> fonction annexe. `src/network/arp/` contient l'inspection ARP ; le vrai
> cache ARP est dans `EndHost.ts`. L'audit doit donc **toujours** être un
> `grep` sur tout `src/`, par concept et non par répertoire, et vérifier
> **qui définit le type** autant que qui l'utilise.

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

### A8 — `IFirewallCapable` est un contrat mort du dépôt

Constat fait en auditant la façade, et signalé ici parce qu'il dépasse ce
module : `core/interfaces.ts` déclare `IFirewallCapable` (avec
`firewallFilter(direction, packet, iface): boolean`) **et son garde de
type `isFirewallCapable`**, et son en-tête annonce qu'il « remplace le no-op
par défaut sur `Equipment` ». Mesure : **aucune classe ne l'implémente**, et
`isFirewallCapable` n'a aucun appelant hors de sa propre déclaration.

`Firewall` ne l'implémente **pas**, et c'est délibéré : sa signature ne
prend ni port, ni session, ni zone, et rend un booléen nu — elle ne peut pas
exprimer ce qu'un pare-feu décide (22 motifs de rejet, §37.2). L'implémenter
donnerait un contrat qui ment sur ce qu'il rend.

Le candidat naturel serait `LinuxPC`, qui possède un vrai netfilter
(`LinuxIptablesManager`). C'est un chantier distinct ; le constat est
consigné pour qu'il ne se reperde pas.

### A3 — Le catalogue de services prédéfinis devra lire `WellKnownPorts`

`core/WellKnownPorts.ts` porte une table `IANA` et `getServiceName(port, proto)`.
Aucune duplication **aujourd'hui** — `ObjectStore` ne fournit que `any`.

**Contrainte enregistrée pour le §8.4.3** (catalogues prédéfinis par
vendeur) : les noms et numéros de port doivent venir de cette table, et non
d'une seconde table écrite à côté. Un simulateur où `HTTP` vaudrait 80 dans
un fichier et 8080 dans un autre serait exactement le défaut de départ.

---

### E23 — `AsaShell`, et trois défauts que la CLI a révélés

`AsaShell.ts` (341 lignes) — le troisième des cinq artefacts vendeur : la
**grammaire**. Modes et invites (`ASA1>`, `ASA1#`, `ASA1(config)#`,
`ASA1(config-if)#`, `ASA1(config-network-object)#`), `nameif`,
`security-level`, `ip address`, `shutdown`, `object network` +
`host`/`subnet`/`range`, `object-group network`, `access-list … extended`,
`access-group … in interface`, `same-security-traffic`, et les vues
`show nameif` / `show conn` / `show running-config` / `show version` /
`show access-list`. Les trois familles de messages de P4 sont éprouvées :
une commande implémentée agit, une commande qu'un ASA connaît mais que ce
build ne simule pas nomme la brique manquante, une commande inexistante
reçoit le message d'IOS.

Le shell ne décide du sort d'aucun paquet — il traduit des mots en mutations
de magasins, et G1 le vérifie mécaniquement.

#### La CLI a trouvé ce que 500 tests unitaires ne voyaient pas

Deux cas sont tombés au premier jet, et **aucun des deux n'était un défaut
du shell** :

- **`no shutdown` ne relevait rien.** `InterfaceTable.setUp()` ne mute
  qu'un enregistrement EXISTANT, et la table n'était peuplée que par
  `configureInterface()` : une interface qu'on n'avait pas adressée n'y
  figurait pas. `isUp()` répondait donc `false` pour un port qui existe
  physiquement et n'est pas éteint — pendant que `getPort(nom)` le
  déclarait présent et actif. **Deux magasins qui se contredisent sur la
  même machine au même instant**, exactement le défaut que ce dépôt referme
  partout. La table L3 est désormais peuplée depuis les ports à la
  construction, et `Firewall.setInterfaceUp()` déplace **les deux** — la
  ligne de la table et le port lui-même, par `setAdminShutdown()`, la
  primitive que le dépôt porte déjà. Conséquence mesurée plutôt
  qu'affichée : une interface abaissée perd sa route connectée.

- **`show running-config` ne rendait aucune interface**, même nommée. Même
  cause. Cela dépasse l'affichage : dans ce dépôt une configuration rendue
  est **rejouée à l'import d'une topologie**.

#### Un défaut de fidélité, trouvé en vérifiant plutôt qu'en supposant

`ASA_DEFAULT_SECURITY_LEVELS` portait `dmz: 50`. C'est faux : sur un vrai
ASA **seul `inside` reçoit 100 automatiquement**, tout autre nom reçoit 0 —
50 pour une DMZ est une **convention d'enseignement**, pas un défaut de la
machine, et l'administrateur doit le poser lui-même. Le pire est ce que
cela faisait à mon propre test : « un nom quelconque prend le niveau 0 »
passait parce que la valeur finale était 50 des deux côtés — **il ne
discriminait rien**. Coupé en deux cas, dont le premier tombe sans le
correctif.

Ajouté au passage, parce que la même vérification l'a montré : l'ASA
**annonce** le niveau qu'il a choisi (`INFO: Security level for "outside"
set to 0 by default.`), et il écrit `security-level` dans sa configuration
**même au défaut**. Le rendu conditionnel que j'avais écrit était une
troisième invention.

`ZoneTable.setSecurityLevel()` manquait — la table avait
`setIntraZoneAction()` et rien pour le niveau, si bien que `security-level`
passait par `nameif()`, qui ne modifie pas une zone existante.

#### Un troisième faux positif de mes garde-fous, et ce que j'en fais

G1 a signalé `AsaShell.ts` sur le motif `verdict\s*=`. Le code visé était
`const verdict = l.action === 'allow' ? 'permit' : 'deny'` — le **mot-clé
d'une ACE qu'on rend**, pas le sort d'un paquet. Comme pour B15, j'ai
**précisé** au lieu de relâcher, et des deux côtés : les variables se
nomment `keyword` (c'est ce qu'elles sont), et le garde-fou vise
`.verdict =` — la mutation d'un contexte — plutôt qu'un identifiant. Un cas
neuf teste le garde-fou lui-même sur les trois formes.

Trouvé en typant le module : `'firewall-generic'` avait été ajouté à
`DeviceType` sans entrée dans `DEVICE_CATALOG`, qui est un
`Record<DeviceType, …>` — un type d'équipement que la palette ne savait pas
décrire. Entrée ajoutée avec `paletteCategory: null`, comme
`switch-generic` et pour la même raison : c'est une **base dont les
constructeurs se déclinent**, pas un équipement à déposer sur la toile — il
n'a pas de terminal. Un badge de plus dans la palette aurait fait tomber un
garde-fou existant, et l'ajuster pour accommoder un équipement à moitié
câblé aurait été le mauvais correctif.

**561 cas verts sur 20 fichiers** dans le module, 687 avec les suites
connexes (GUI/palette), lint propre.

---

### E24 — `packet-tracer` : simuler sans rien laisser derrière

Invariant I-F3 du BRD : un outil de diagnostic doit lire le **vrai**
pipeline. C'est la commande où la tentation de tricher est la plus forte —
il serait facile de rendre un texte plausible sans jamais consulter le
moteur, et le jour où les deux divergent, c'est le diagnostic qu'on croit,
pas la machine.

Le socle est `Firewall.simulate()` : il construit un paquet
(`pipeline/SimulatedPacket.ts`), le fait traverser le **même** pipeline que
le trafic du câble, et rend la trace telle quelle. Le rendu ASA
(`vendors/asa/AsaPacketTracer.ts`) n'est qu'un formateur — il traduit les
noms de nos étapes vers ceux d'IOS (`ACCESS-LIST`, `ROUTE-LOOKUP`, `NAT`,
`FLOW-CREATION`), parce qu'un opérateur cherche `ACCESS-LIST` dans sa
sortie, pas `policy-lookup`.

**Ce que la sonde interdit** n'est pas seulement « le code lit le
moteur » : elle **change la politique** et vérifie que le rendu change avec
elle. Un texte fabriqué ne pourrait pas suivre.

#### « Il ne crée ni connexion ni traduction » — vérifié, pas supposé

La documentation Cisco est explicite : `packet-tracer` simule. Le contexte
porte donc `simulated`, honoré en deux points et **deux seulement** :
`session-install` n'installe rien (ni session, ni session de rejet), et
l'allocateur PAT **calcule** le port sans le **réserver**.

Le second point a demandé une précaution qui n'était pas évidente et qui
est gardée par un témoin : une simulation ne doit pas non plus **effacer**
une traduction vivante. Un `release()` après coup l'aurait fait — la
recherche trouve d'abord une correspondance existante, et la relâcher
aurait détruit le flux d'un autre. La règle est donc « ne pose rien » et
non « défais ce que tu as posé ».

Choix assumé et écrit : les compteurs de règles (`hitCount`) **sont**
incrémentés par une simulation, comme sur un vrai ASA, où c'est un travers
connu de la commande.

#### Trois défauts trouvés en écrivant ceci

- **`FirewallVerdict.ruleId` était déclaré et jamais écrit.** Un refus ne
  nommait donc pas la règle qui l'avait prononcé — précisément ce qu'on
  vient chercher dans un diagnostic. Le champ existait depuis la phase 1 ;
  rien ne le remplissait.
- **`__implicit__` fuyait jusqu'à l'opérateur.** Le rendu affichait
  `Config: access-list __implicit__` — un marqueur interne. Il est
  désormais nommé une fois (`IMPLICIT_RULE_ID`, dans `SecurityRule.ts`, là
  où les deux magasins qui l'utilisaient le réécrivaient chacun en dur) et
  rendu `Implicit Rule`, ce qu'écrit la vraie machine.
- **Mes propres spécifications de règle NAT dans les tests étaient
  fausses** (`kind: 'dynamic-pat'`, `address:`) : ni le bon variant ni le
  bon champ. Les cas passaient par le repli `?? interfaceAddress(sortie)`,
  qui donnait la bonne réponse **par accident**. Corrigés sur la vraie
  forme, et le typage strict les aurait attrapés plus tôt — il le fait
  maintenant, `type` étant obligatoire sur `NatRuleDraft`.

#### Un trait d'ASA que la CLI n'avait pas, et qui n'est pas cosmétique

Tous les cas du rendu échouaient au premier jet avec `% Invalid input`,
et la cause n'était pas le rendu : **le laboratoire finit en mode
configuration**, et mon shell n'y acceptait que les commandes de
configuration. Vérification faite contre la référence CLI de Cisco : sur un
ASA « all lower commands can be entered in higher modes » — un `show` (ou
un `packet-tracer`) fonctionne **depuis la configuration, sans `do`**,
contrairement à IOS. C'est une différence que tout opérateur venant d'IOS
remarque au premier jour. La règle est désormais dans `dispatch()` : le
mode courant a la priorité, et ce qu'il refuse retombe sur l'EXEC.
L'inverse reste faux, et un cas le vérifie.

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
| B7 | Audit ARP limité à `src/network/arp/` → doublon partiel de `ARPEntry` | E13 | `ARPEntry` déplacé vers `core/types.ts` + ré-export ; méthode d'audit corrigée |
| B8 | Requête ARP émise vers la MAC nulle au lieu de la diffusion | E14 | Destination Ethernet distinguée du champ ARP |
| B9 | Paquet jeté pendant la résolution ARP | E14 | Cache réinterrogé après émission (livraison synchrone) |
| B10 | Chemin rapide sans interface de sortie → retour jeté | E14 | Sortie lue sur la session, inversée pour `s2c` |
| B11 | `import` inséré dans le commentaire d'en-tête → primitives non résolues | E15 | Placé après le dernier import réel ; rattrapé par la référence verte |
| B12 | Test affirmant qu'un PAT change toujours le port source | E16 | Un vrai PAT le *préserve* quand il est libre ; moteur correct |
| B13 | Test utilisant un port hors de la plage PAT | E16 | Corrigé + cas dédié à la règle |
| B14 | Réponse PAT consommée localement au lieu d'être dé-NATée | E19 | La recherche de session précède le test « pour nous ? » |
| B15 | Garde-fous trop larges : méthode `setTimeout`, séparateurs `// ───` | E22 | Garde-fous précisés + cas testant les garde-fous |
| B16 | `InterfaceTable` ignorait les ports jamais adressés → `isUp()` niait un port présent et actif | E23 | Table peuplée depuis les ports ; `setInterfaceUp()` déplace la ligne ET le port |
| B17 | `dmz: 50` posé comme défaut ASA (c'est une convention, pas un défaut) | E23 | `{ inside: 100 }` seul ; le test qui « passait » ne discriminait rien, coupé en deux |
| B18 | `security-level` rendu conditionnellement ; un vrai ASA l'écrit toujours | E23 | Rendu inconditionnel + message `INFO:` que la vraie machine émet |
| B19 | Garde-fou G1 déclenché par un local nommé `verdict` dans un rendu | E23 | Variables renommées `keyword` ; garde-fou visant `.verdict =` ; cas testant le garde-fou |
| B20 | `'firewall-generic'` absent de `DEVICE_CATALOG` (`Record<DeviceType, …>`) | E23 | Entrée ajoutée, `paletteCategory: null` — c'est une base, pas un équipement à déposer |
| B21 | `FirewallVerdict.ruleId` déclaré depuis la phase 1, jamais écrit | E24 | `deny()` porte la règle ; un refus nomme enfin ce qui l'a prononcé |
| B22 | `__implicit__`, marqueur interne, rendu à l'opérateur | E24 | `IMPLICIT_RULE_ID` nommé une fois ; rendu `Implicit Rule` |
| B23 | Mes règles NAT de test : ni le bon variant ni le bon champ, passant par un repli | E24 | Vraie forme ; `type` obligatoire, donc le typage l'attrape désormais |
| B24 | Un `show` depuis la configuration était refusé — sur ASA il est légal sans `do` | E24 | `dispatch()` : le mode courant d'abord, repli sur l'EXEC |

## Prochaines étapes

Phase 3 (ASA), reste à faire :

1. NAT objet ASA : `nat (inside,outside) static …` sous `object network`,
   et `nat (inside,outside) dynamic interface` — la syntaxe 8.3+ que le
   moteur sait déjà exécuter et que la CLI ne sait pas encore écrire.
2. `show conn` sur des sessions vivantes (le rendu existe, la sonde manque)
   et `show xlate`, son jumeau côté traduction.
3. `ShellFactory.register('asa', …)` puis `DeviceFactory` : `firewall-cisco`
   cesse d'être un `LinuxPC`.

Puis phases 4 à 15 : diagnostics et journaux, FortiOS, cadre ALG, PAN-OS
(configuration candidate), écrans et profils, Junos (validation du contrat,
AC-C1), modes de déploiement, VPN, haute disponibilité, virtualisation,
identification, QoS.
