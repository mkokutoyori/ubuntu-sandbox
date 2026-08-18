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
| 3 | Sections NAT (socle) + `object network … nat` (ASA) | 29 | ✅ |
| 3 | `show conn` / `show xlate` / `clear` sur trafic réel | 18 | ✅ |
| 3 | L'ASA devient un équipement déposable et ouvrable | 17 | ✅ |
| 3 | NAT manuel (« twice NAT »), section 1 et `after-auto` | 17 | ✅ |
| **4** | **Journalisation : le pare-feu émet, `show logging`** | 16 | ✅ |
| 4 | `logging host` — les messages quittent la machine | 9 | ✅ |
| **5** | **FortiOS — deuxième déclinaison** | 32 | ✅ |
| **F1** | **FortiOS phase 1 — la grammaire se déclare** | 70 | ✅ |
| **F2** | **FortiOS phase 2 — système, objets, laboratoire L1** | 29 | ✅ |
| **F3** | **FortiOS phase 3 — NAT complet (VIP, pools, PBR)** | 34 | ✅ |
| **F3b** | `?` descend dans l'arbre ; l'interface passe en anglais | 13 | ✅ |
| **F4** | **FortiOS phase 4 — diagnostic et journaux** | 44 | ✅ |
| **F5** | **FortiOS phase 5 — VDOM et modes de deploiement** | 27 | ✅ |
| 3 | NAT objet ASA (`nat (dmz,outside) static`) | — | ⏳ |
| 3 | `ShellFactory` + `DeviceFactory` | — | ⏳ |

**Total actuel : 971 cas verts sur 35 fichiers** du module.
**Phases 1 et 2 fonctionnelles ; phase 3 en cours.**

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

### E25 — L'auto NAT passe après le manuel, et une statique publie vraiment

`nat (inside,outside) dynamic interface` et `nat (dmz,outside) static <ip>`
sous `object network` — la syntaxe 8.3+. Le moteur savait déjà traduire ;
ce qui manquait était la grammaire **et une règle d'ordonnancement que la
syntaxe seule ne donne pas**.

#### La règle qu'on ne devine pas en lisant la syntaxe

La documentation Cisco fixe l'ordre : **NAT manuel, puis auto NAT, puis
auto-after** — quel que soit l'ordre de saisie. C'est le piège le plus
connu de l'ASA : une règle objet écrite en premier ne s'applique pas en
premier. Une implémentation qui empilerait dans l'ordre tapé donnerait la
bonne réponse tant qu'on ne mélange pas les deux, et la mauvaise le jour
où on les mélange — c'est-à-dire le jour où cela compte.

`NatPolicyStore` porte donc une **section**, numérique et sans nom de
constructeur (G2 interdit un branchement vendeur dans le socle) : les noms
ASA vivent dans `ASA_NAT_SECTIONS`, côté vendeur. `ordered()` trie par
section, l'ordre de saisie tranchant *à l'intérieur* d'une section — le tri
de JavaScript étant stable, il n'y a rien de plus à écrire pour ça. La
numérotation rendue suit l'ordre **évalué**, pas celui de la saisie, sans
quoi `show nat` décrirait un ordre que le moteur n'applique pas.

#### `bidirectional` était stocké et lu par PERSONNE

Constat fait en relisant mon propre test : il vérifiait que le drapeau est
**posé**. C'est exactement le défaut « accepté et inerte » que ce dépôt
referme partout — et il portait sur ce qui EST la publication d'un serveur
sur un ASA. Une recherche sur tout le module l'a confirmé : quatre
occurrences, toutes des écritures, aucune lecture.

Mesuré avant de corriger, par quatre cas qui font traverser du trafic :
depuis dehors, l'adresse publiée n'était pas dé-NATée, et le paquet ne
ressortait pas vers le serveur réel. `translateInboundBidirectional()` lit
la règle **à l'envers** — la zone de sortie devient celle d'entrée, et
l'adresse traduite devient le critère de correspondance sur la
destination, ce qui est précisément la façon dont un ASA fait son un-NAT.

Le témoin sortant a fait tomber un piège de laboratoire au passage : ma
première version visait une destination **sans route**, si bien que le
paquet s'arrêtait à `route-lookup` et n'atteignait jamais l'étape NAT — le
cas aurait échoué pour une raison sans rapport avec ce qu'il prétend
mesurer. Un cas de plus vérifie qu'une règle **dynamique** n'est PAS
bidirectionnelle : sans lui, « tout dé-NATer » passerait le test principal.

#### Rendu

`show nat` sépare les sections par leur titre réel (`Auto NAT Policies
(Section 2)`), et `show running-config` rend enfin les objets — lus depuis
`ObjectStore`, pas depuis une copie tenue par le shell, seule la ligne
`nat` étant mémorisée telle qu'elle a été tapée pour être reproduite mot
pour mot.

---

### E26 — `show conn` et `show xlate`, mesurés sur du trafic réel

Les deux tables qu'un ASA fait consulter, écrites ensemble parce qu'elles
décrivent le **même** flux vu de deux endroits. Une machine où elles se
contrediraient serait indiagnosticable — et c'est exactement ce qui arrive
quand deux rendus lisent deux magasins ; ici les deux lisent la
`SessionTable`, `show xlate` n'étant que sa projection sur les sessions
qui portent une traduction.

**Le trafic du test est réel**, sur un vrai câble, avec de vrais pings. Un
test qui poserait les sessions à la main vérifierait le formateur et rien
d'autre — or la question est de savoir si la table se remplit quand des
paquets traversent, et si ce qu'elle annonce correspond à ce qui a
circulé. Les compteurs d'octets et les drapeaux sont donc des **mesures** :
`U` dit que la connexion est établie, `I` qu'il est entré des données, `O`
qu'il en est sorti (documentation Cisco, vérifiée). L'ordre des champs
vient de la même source et n'est pas devinable — `TCP outside <distant>
inside <local>`, le côté extérieur d'abord, quel que soit le sens dans
lequel la connexion a été ouverte.

#### Mes deux témoins étaient faux, et chacun pour une raison instructive

- **« trois pings comptent plus d'octets qu'un seul »** mesurait 168 des
  deux côtés. La cause n'est pas le compteur : trois pings créent **trois
  sessions**, et mon expression régulière ne lisait que la première ligne.
- **« un flux qui ne reçoit rien ne porte pas `I` »** posait une règle de
  refus sur le retour et attendait que la réponse soit bloquée. C'est
  l'inverse d'un pare-feu à états : le retour d'une session établie passe
  par le chemin rapide et ne consulte aucune politique. Le code avait
  raison, le test avait tort. Remplacé par un ping vers une adresse
  **routable dont personne ne répond** — le seul montage où il n'entre
  vraiment rien.

#### Un défaut mesuré, hors périmètre, et écrit plutôt que tu

Les trois sessions ci-dessus viennent de `EndHost` : **`ping` attribue un
identifiant ICMP NOUVEAU à chaque sonde** (`pingIdCounter` incrémenté dans
la boucle) là où un vrai `ping` garde un identifiant pour tout le processus
et n'incrémente que le numéro de séquence. Conséquence observable :
`show conn` affiche trois connexions pour un `ping -c 3`, quand un vrai ASA
en affiche une.

Ce n'est **pas** un défaut du pare-feu — `FlowKey` indexe l'ICMP par
identifiant, ce qui est juste et ce que fait un vrai pare-feu. C'est le
poste émetteur qui se comporte comme trois processus. Non corrigé ici :
`EndHost` est un autre sous-système, `pingIdCounter` sert aussi à
corréler les réponses sur le bus, et le rayon d'action couvre des
centaines de tests — le mélanger à ce chantier serait mal cadré. Consigné
pour être traité pour lui-même.

---

### E27 — L'ASA devient un équipement qu'on dépose et qu'on ouvre

Tout le module était juste, et **rien n'en était atteignable**. La palette
construisait un `LinuxPC` sous le nom `firewall-cisco` : déposer un
pare-feu Cisco donnait une machine Ubuntu avec un `bash`. C'est le défaut
que le badge « Limited » de `DevicePalette` signale honnêtement — et qu'il
signalerait indéfiniment tant que rien ne le remplace.

Trois choses devaient tenir ensemble, et chacune pouvait échouer seule :
`DeviceFactory` construit un vrai `AsaFirewall` ; l'équipement expose une
CLI (`ICLIDevice` — sinon le terminal n'a rien à interroger) ;
`createSessionForDevice` ouvre un terminal au lieu de rendre `null`, ce
qu'il faisait pour tout `getOSType()` inconnu.

**`AsaFirewall` porte désormais son shell**, comme `Router` porte le sien,
et délègue `getPrompt`/`executeCommand`/`cliHelp`/`cliTabComplete`. Le
point qui comptait : `?` et la complétion **lisent le vocabulaire du mode
courant** (`AsaVocabulary.ts`) plutôt qu'une liste figée — un cas vérifie
que les candidats changent après `enable`, sans quoi l'aide décrirait un
mode où l'on n'est pas.

`ICLIDevice` s'est révélé être exactement la bonne prise : six méthodes,
aucune dépendance à `Router`. `AsaTerminalSession` tient en 59 lignes sur
`CLITerminalSession`, qui apporte l'amorçage, le pager et l'aide en ligne
— rien n'a été réécrit.

#### Encore un défaut dans mon propre test

`createDevice(type, x, y)` prend des **coordonnées**, pas un nom : la
fabrique nomme elle-même depuis le préfixe du catalogue. J'avais passé
`'ASA1'` à la place de `x`. Le cas le vérifie maintenant explicitement,
parce que passer une chaîne où l'on attend une coordonnée est le genre
d'erreur qui ne se voit jamais.

#### Limite assumée, écrite plutôt que tue

**SSH vers l'ASA n'est pas servi** : `Firewall` n'installe aucun démon,
donc la connexion est refusée — franc, et non un `bash` silencieux qui
serait le pire des deux. `primaryShellKindFor` n'a donc pas été touché ;
il le sera avec le démon, pas avant.

---

### E28 — Le NAT manuel, et l'ordre qui s'inverse sans qu'on le voie

`nat (a,b) source static … destination static …` — la section 1, dite
« twice NAT ». Sa raison d'être : traduire la source **en fonction de la
destination**, ce qu'une règle objet ne sait pas faire puisqu'elle ne
connaît qu'un objet.

**Le détail qui s'inverse sans qu'on le voie** : `source` s'écrit RÉELLE
puis TRADUITE, et `destination` s'écrit TRADUITE puis RÉELLE. L'ordre est
inversé entre les deux clauses, et c'est logique une fois dit — pour la
destination, le paquet ARRIVE sur l'adresse traduite, donc c'est elle qu'on
nomme en premier, comme critère. Aligner les deux clauses « pour la
cohérence » dé-NATerait vers la mauvaise machine, sans que rien ne le
signale.

Les recherches secondaires se contredisaient sur ce point et `cisco.com`
est bloqué par le mandataire de sortie ; ce qui a tranché est **l'exemple
du BRD lui-même** (`nat (outside,dmz) source static any any destination
static PUB_IP SRV_WEB`), écrit en son temps à partir de la documentation.
Le fichier de test le dit, plutôt que de le laisser deviner.

`after-auto` range la règle en section 3. Sans elle la section 3 serait un
rang que rien ne peut atteindre — et c'est la seule façon d'écrire une
règle manuelle qui passe APRÈS une règle objet. Deux cas opposés vérifient
l'ordre obtenu dans les deux sens.

#### Deux défauts préexistants, révélés parce que quelque chose s'en sert

- **La zone de sortie ne peut pas être un critère de dé-NAT.** Le
  `match()` du moteur exigeait `toZone == egressZone`, or le dé-NAT a lieu
  **avant** la recherche de route : la zone de sortie n'est pas encore
  décidée, donc aucune règle de destination ne pouvait jamais correspondre.
  Le critère n'est appliqué que lorsque la zone est connue.
- **La destination était réécrite avec le NOM de l'objet.** `rewriteDestIP`
  recevait `'SRV_WEB'` là où il attend une adresse : le chemin de
  destination n'avait jamais résolu un objet, personne ne lui en ayant
  jamais passé. Il lit désormais `resolveAddress()`, la même fonction que
  le chemin bidirectionnel.

---

### E29 — Le pare-feu journalise, sans second moteur de journal

Phase 4. L'audit de non-duplication a été fait **avant** d'écrire une
ligne, et il a décidé du travail : `LoggingConfig` existe, il est mûr
(sévérités, tampon, collecteurs, horodatage, discriminateurs), et son rendu
produit **déjà** le format d'un ASA — `%${tag}-${niveau}-${mnémonique}`
donne `%ASA-6-302013` sans qu'une ligne du moteur change. Écrire un second
journal aurait été le doublon que ce dépôt passe son temps à refermer.

Ce qui manquait n'était donc pas un moteur mais deux choses : le pare-feu
**n'émettait rien** — or c'est le journal qu'on lit pour savoir pourquoi
une application ne passe pas, donc un pare-feu muet est inexploitable ; et
les **numéros de message sont propres au constructeur**, donc ils sont une
DONNÉE du profil (`syslogCatalog`), conformément au §26 du BRD.

Les identifiants sont ceux d'un vrai ASA — 302013 (connexion ouverte),
302014 (fermeture), 106023 (refus par ACL), 305011 (traduction créée) —
parce que ce sont eux qu'un opérateur cherche ; les inventer aurait rendu
le journal illisible pour quiconque connaît la machine.

#### Trois divergences ASA / IOS, chacune réelle

- **`logging enable`** (ASA) contre **`logging on`** (IOS) : le shell
  traduit le mot et passe le reste au parseur du moteur. Traduire du
  vocabulaire est exactement le rôle de la couche vendeur ; réimplémenter
  le parseur ne l'aurait pas été.
- **La journalisation est COUPÉE par défaut sur un ASA**, allumée sur IOS.
  `AsaFirewall` pose donc `enabled = false` à la construction, et la
  configuration rendue porte `logging enable` — ce qui est correct dans les
  deux sens, la ligne décrivant un écart au défaut.
- **`clear logging buffer`** existe là où IOS écrit `clear logging`.

#### Mon test se trompait de seuil, pas le catalogue

« un tampon réglé sur `errors` retient quand même un refus » est faux :
`errors` vaut 3 et `warnings` 4, donc `errors` est le seuil le PLUS strict
et écarte les avertissements. La sévérité 4 du message 106023 est celle du
vrai ASA — le catalogue avait raison. La paire de cas est réécrite sur
`warnings`, qui discrimine vraiment : elle écarte l'ouverture (6) et
retient le refus (4).

Trouvé au passage : le type `Severity` de `LoggingConfig` était **déclaré
et non exporté**, alors que `SEVERITY_NAMES` l'était. Exporté plutôt que
redéfini.

---

### E30 — `logging host` : la projection est EXTRAITE, pas recopiée

`SyslogAgent` existe et émet de vrais datagrammes ; son contrat d'hôte ne
demande que `getHostname`/`getPort`/`getPorts`/`sendFrame`, qu'un
`Firewall` a tous. Mieux : `CiscoShellBase` portait **déjà** la projection
`LoggingConfig` → `SyslogAgent`. Elle est extraite dans
`syslog/loggingProjection.ts` plutôt que recopiée — une seconde projection
aurait fini par contredire la première sur la sévérité ou la facilité.
`CiscoShellBase` perd 40 lignes et gagne un appel.

Le test **compte les trames**. Une configuration qui s'affiche sans qu'un
datagramme parte est le défaut « accepté et inerte », et il ne se voit
qu'en regardant le fil : témoin sans collecteur (zéro trame), plus de
trafic donne plus de datagrammes, et `logging trap emergencies` fait taire
l'émission en laissant le tampon local se remplir — ce qui *est* la
différence entre les deux seuils.

Divergence ASA réelle : `logging host <nameif> <ip>`, l'interface **avant**
l'adresse. Le shell traduit et rend la ligne dans la forme tapée — une
configuration rendue étant rejouée à l'import, la rendre en forme IOS
l'aurait rendue irrejouable sur un ASA.

---

### E31 — FortiOS : la deuxième déclinaison est l'épreuve du contrat

L'ASA prouvait qu'un profil peut décrire un constructeur. FortiOS prouve
autre chose : il **diverge de l'ASA sur presque tout** ce que le BRD avait
isolé comme axe de variation. Si le contrat tient pour lui, il tient.

Trois artefacts, aucun moteur (G1 le vérifie) : `FortiProfile`,
`FortiGate`, `FortiShell` — 403 lignes en tout, contre 1 300 pour l'ASA
parce que le socle est désormais en place.

#### Les divergences, et ce que chacune a coûté au socle

- **Le NAT est un CHAMP de la politique** (`set nat enable`), pas une
  politique à part. `natIsPolicyField` était écrit en phase 3 et **lu par
  personne** ; `SecurityRule.natEnabled` était dans le même état — trois
  écritures, aucune lecture. FortiOS est ce qui les rend réels :
  `applyPolicyNat()` traduit vers l'adresse de l'interface de sortie quand
  la règle qui a matché porte le drapeau. Le témoin sans `nat enable`
  vérifie que rien ne bouge.
- **Aucun niveau de sécurité** : rien ne passe sans règle, même de
  l'intérieur. C'est l'inverse exact de l'ASA et la première chose qui
  surprend en passant de l'un à l'autre.
- **La CLI est hiérarchique** (`config`/`edit`/`set`/`next`/`end`), pas un
  arbre de mots-clés. `edit 0` attribue le prochain identifiant libre.

#### Un défaut du socle que seul un second constructeur pouvait révéler

L'étape `ingress-zone` **refusait toute interface sans zone**. Sur un ASA
cela ne se voyait pas : `nameif` crée la zone. Sur FortiOS les interfaces
s'utilisent nues, donc aucun paquet ne pouvait entrer. `zoneNameFor()`
retombe sur le nom de l'interface quand le profil déclare
`policyKeyedBy: 'interface'` — ce qui est honnête pour les deux, la zone de
l'ASA restant trouvée quand elle existe.

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
| B25 | `NatPolicyStore` n'avait aucune notion de section : l'ordre de saisie décidait seul | E25 | `section` sur la règle ; `ordered()` trie par section, saisie ensuite |
| B26 | `bidirectional` écrit en 4 endroits, lu par aucun — la publication de serveur ne marchait pas | E25 | `translateInboundBidirectional()` lit la règle à l'envers ; 4 cas de trafic |
| B27 | Mon propre témoin visait une destination sans route : il s'arrêtait avant l'étape mesurée | E25 | Destination routable ; le cas mesure enfin ce qu'il annonce |
| B28 | Témoin d'octets ne lisant que la PREMIÈRE ligne de `show conn` | E26 | Somme de toutes les lignes |
| B29 | Témoin attendant qu'une règle de refus bloque un RETOUR établi | E26 | C'est l'inverse d'un pare-feu à états ; remplacé par une destination qui ne répond pas |
| B30 | `firewall-cisco` construisait un `LinuxPC` : le pare-feu était injoignable | E27 | `DeviceFactory` → `AsaFirewall` ; `ICLIDevice` ; `AsaTerminalSession` |
| B31 | Mon test passait un NOM là où `createDevice` attend une coordonnée | E27 | Vraie signature, et un cas qui pin le nommage par la fabrique |
| B32 | Le dé-NAT exigeait une zone de SORTIE pas encore décidée : aucune règle de destination ne pouvait correspondre | E28 | Critère appliqué seulement quand la zone est connue |
| B33 | La destination était réécrite avec le NOM de l'objet, pas son adresse | E28 | `resolveAddress()`, la même que le chemin bidirectionnel |
| B34 | Le pare-feu n'émettait aucun message : ni connexion, ni refus | E29 | `logFirewallEvent` sur le point de décision ; catalogue dans le profil |
| B35 | `Severity` déclaré et non exporté par `LoggingConfig` | E29 | Exporté plutôt que redéfini |
| B36 | Mon test prenait `errors` pour un seuil plus permissif que `warnings` | E29 | Paire réécrite sur `warnings`, qui discrimine vraiment |
| B37 | La projection `LoggingConfig`→`SyslogAgent` allait être recopiée | E30 | Extraite dans `syslog/loggingProjection.ts`, deux appelants |
| B38 | `natIsPolicyField` et `SecurityRule.natEnabled` écrits, lus par personne | E31 | `applyPolicyNat()` — FortiOS les rend réels |
| B39 | `ingress-zone` refusait toute interface sans zone : FortiOS ne pouvait rien recevoir | E31 | Repli sur le nom d'interface quand `policyKeyedBy: 'interface'` |

### E32 — FortiOS phase 1 : la grammaire se déclare

`vendors/fortios/{schema,runtime,render}/` — **60 cas** neufs, plus 10 de
garde-fou (G6, G7, G8), plus 4 specs Playwright. Les 32 cas de la phase 5
restent verts **sans modification**.

**Ce que la phase remplace.** `FortiShell` portait deux `Set<string>`
littéraux d'attributs et deux fonctions de validation écrites à la main.
À ce rythme, cent tables font cent listes et cent fonctions, et le
premier attribut oublié devient un `Command fail` inexplicable. La
grammaire de FortiOS est régulière, donc elle se **déclare** :
`FortiTableSpec` porte le chemin, la clé, l'ordre, la portée, le groupe
de droits, le rang de rendu, les attributs et leurs défauts ; le shell ne
connaît plus aucune table.

**Ce que le schéma rend possible, et qui ne l'était pas.** `show` ne rend
que le modifié et `get` rend tout — la distinction la plus employée d'un
FortiGate — parce que le schéma porte les **valeurs par défaut**. `unset`
rétablit le défaut au lieu de supprimer, pour la même raison. `append`,
`select` et `unselect` se distinguent de `set` parce que le schéma dit
quels attributs sont des listes. `?` et la complétion sortent du même
schéma que la validation, donc une commande refusée à l'exécution cesse
d'être proposée.

**B40 — le piège que la sonde à l'aveugle a attrapé.** `onCommit`
faisait `remove` puis `append` : rééditer la règle 1 d'une table de trois
la **remontait en fin de liste**, donc changeait l'ordre d'évaluation
sans que rien ne le demande. Le BRD l'avait nommé (§33.4 c) ; le test
l'a mesuré. `FortiCommitContext` porte désormais la `position`, et la
politique est réinsérée là où la table la tient.

**B41 — `always` n'est pas un horaire, c'est l'absence de restriction.**
Passer `schedule: 'always'` au socle faisait échouer toute correspondance :
`PolicyEvaluator` refuse une règle dont l'horaire n'est pas évaluable, et
l'objet horaire n'arrive qu'en phase 2. La traduction juste est
`undefined` — aucune restriction de temps — et non un nom que personne ne
sait résoudre.

**B42 et B43 — deux défauts d'INTERFACE, trouvés par la spec Playwright
et invisibles à toute suite unitaire.** Ouvrir un FortiGate dans le
canevas **plantait l'arbre React** : `TerminalView` appelle
`session.getSshContextInfo()` puis `session.getPromptParts()` sous un cast
`as LinuxTerminalSession`, sur le seul critère
`getSessionType() === 'linux'`. Le cast est un mensonge dès qu'une
session non-Linux déclare ce type pour son rendu — un FortiGate le fait —
et la bannière n'a aucun garde-fou d'erreur, donc le terminal ne
s'ouvrait pas du tout. `createSessionForDevice` rendait pourtant une
session, et un cas unitaire l'affirmait. Les deux méthodes descendent
dans `TerminalSession` avec la réponse par défaut qui convient : « pas de
session SSH » et « mon invite n'a pas de forme `user@hôte:chemin` ». Les
deux casts disparaissent, et aucun type de session ne peut plus faire
tomber le rendu.

**Hors du module, mesuré ici** : `FortiTerminalSession.getSessionType()`
rend `'linux'` alors qu'un FortiGate est un équipement à CLI comme l'ASA,
qui rend `'cisco'`. Le corriger changerait le thème et le chemin de
collage ; le correctif retenu est général plutôt que local, parce que le
défaut l'était.

**Mesures.** 810 cas verts sur 30 fichiers du module ; 653 cas de
`unit/terminal*` et 176 de `unit/react` + `unit/gui` verts. Discrimination :
**43 des 60 cas** de `fortios-grammar.test.ts` tombent avant correctif.
Typecheck exactement à la base (347), lint identique fichier par fichier.

---

### E33 — FortiOS phase 3 : la traduction d'adresses devient réelle

`vendors/fortios/schema/firewallNat.ts`, `nat/IpPool.ts`,
`l3/PolicyRouteTable.ts` (neufs) — **34 cas** neufs, plus 5 specs
Playwright. **27 des 34 tombent avant correctif** (`git stash push --
src/network/`) ; les 7 restants sont nommés dans l'en-tête du fichier
plutôt que laissés à découvrir.

**Ce que la phase livre** : `config firewall ippool` (les quatre types),
`config firewall vip` (avec renvoi de port), l'**ARP mandataire**, le
trafic *hairpin*, `config firewall central-snat-map` avec son bascule
`set central-nat`, et `config router policy` avec son étape de pipeline.

**Renversement de la décision annoncée.** Le périmètre pris annonçait
`policySeesPreNatDestination` passant à `true`. La recherche l'a
contredit avant qu'une ligne soit écrite : FortiOS traduit la
destination **avant** de chercher la politique, donc la politique voit
l'adresse traduite. Ce qui la fait quand même nommer la VIP dans
`dstaddr`, c'est que l'objet adresse d'une VIP désigne l'adresse
**interne** — d'où `vipAddress(nom, adresseMappée, …)` et non
`vipAddress(nom, adresseExterne, …)`. Le profil est resté à `false`.

**B44 — une adresse littérale n'était jamais reconnue par le moteur
NAT.** `FirewallNatEngine.match()` résolvait `originalSource` et
`originalDestination` par `ObjectStore.matchesAnyAddress`, qui cherche un
objet **par nom** ; une règle portant une adresse en clair — ce qu'est
l'`extip` d'une VIP — ne correspondait donc à rien. Le moteur portait
déjà le prédicat juste (`addressMatches`, nom **ou** littéral), employé
par la seule voie bidirectionnelle. Une seule cause pour quatre
symptômes : la VIP injoignable, le renvoi de port sans effet, le hairpin
mort et `match-vip` inobservable.

**B45 — le NAT de politique ÉCRASAIT la traduction de destination.**
`applyPolicyNat` posait une traduction neuve au lieu de la fusionner,
donc une session qui subit DNAT **puis** SNAT perdait la moitié
destination : `originalDest` devenait l'adresse déjà traduite, et la
réponse repartait avec l'adresse **interne** au lieu de l'adresse
publique appelée. Le client la refusait comme non sollicitée. Le défaut
est antérieur à cette phase et était **inatteignable** faute de VIP ; la
branche « pool » écrite ici fusionnait déjà, l'autre non.

**B46 — une VIP posée sur l'adresse de l'interface était servie
localement.** `Firewall.handleIpv4Frame` livrait au traitement local tout
paquet dont la destination appartient à une interface, avant tout NAT —
or le renvoi de port le plus courant met la VIP sur l'adresse même du
WAN. `hasInboundRule` tranche désormais avant la livraison locale, comme
un vrai FortiGate qui fait la recherche de VIP en premier.

**`match-vip` : le défaut vaut `enable`, et la version le décide.**
Fortinet l'a inversé en 7.2.3 ; ce simulateur annonce 7.4.4, donc une
règle `deny` placée au-dessus **attrape** le trafic d'une VIP. Écrire
l'inverse aurait été tout aussi naturel et faux. L'attribut n'existe que
sur une règle `deny`, comme sur la vraie machine.

**Deux magasins ne pouvaient pas se contredire, et l'un manquait.**
`availableWhen` ne voyait que l'objet en cours ; `set nat` doit
disparaître de la politique quand `system settings` porte
`central-nat enable`, ce qui est un autre objet. `FortiObjectView` gagne
`setting(chemin, attribut)`, servi par `FortiConfigTree` lui-même — pas
un second magasin, la table elle-même.

**Trouvé au passage** : `ObjectStore.addAddress` refuse un doublon, donc
le motif `removeAddress` + `addAddress` des `onCommit` laissait
silencieusement l'ancienne valeur dès que l'objet était membre d'un
groupe. `upsertAddress` remplace inconditionnellement, ce qu'un `commit`
veut dire.

**Mesures.** 887 cas verts sur 32 fichiers du module ; 262 cas de
`unit/cli` + garde-fous verts ; 5 specs Playwright vertes. Typecheck 350
(base 351), aucune erreur dans le module ; lint propre.

---

### E34 — FortiOS phase 4 : le diagnostic lit ce que le paquet a vécu

`vendors/fortios/diag/` et `vendors/fortios/log/` (neufs),
`logging/FirewallLogStore.ts` et `diag/PacketCapture.ts` sur le socle —
**44 cas** neufs, plus 7 specs Playwright. **40 des 44 tombent avant
correctif** ; les 4 restants sont nommés dans l'en-tête du fichier.

**Ce que la phase livre** : `diagnose sys session list` au format
complet avec ses filtres et son `clear`, `diagnose debug flow`,
`diagnose firewall iprope`, `diagnose sniffer packet`, les vues `get`
(`system status`, `system performance status`, `system arp`,
`system interface`, `router info routing-table all`), `config log *`
avec ses quatre collecteurs et ses quatre formats, et
`execute log filter|display|delete-all`. **Le badge « Limited
simulation » est retiré du FortiGate** — critère de sortie annoncé par
le BRD §39.

**Deux affirmations écrites à l'aveugle, renversées par la mesure**, et
les deux fois c'est la sonde qui avait tort, jamais le produit :

- **les champs d'un journal FortiOS sont entre guillemets**
  (`type="traffic"`, `action="deny"`), les numériques exceptés — la
  sonde attendait `type=traffic` ;
- **la règle implicite ne journalise PAS par défaut.** Fortinet laisse
  `fwpolicy-implicit-log` désactivé pour ne pas noyer le collecteur ;
  la sonde tenait le refus implicite pour journalisé d'office. Le
  réglage existe donc, sous `config log setting`, et c'est lui qui
  décide.

**B47 — `logtraffic utm` journalisait TOUT.** `logEnd` était commis
depuis `logtraffic !== 'disable'`, donc la valeur par défaut — `utm`,
qui ne journalise que ce qu'un profil a déclenché — écrivait une ligne
pour chaque session. Un opérateur qui n'a rien demandé recevait le
journal complet de sa passerelle. `logEnd` vaut désormais
`logtraffic === 'all'`, et `utm` se tait tant qu'aucun profil n'existe.

**B48 — le filtre de session ne pouvait pas trouver l'adresse
d'origine.** `sessionMatchesFilter` lisait `session.c2s`, qui porte le
tuple **traduit** puisque la session est installée après le NAT : sur
un laboratoire avec `set nat enable` — le cas normal —
`diagnose sys session filter src 192.168.1.10` ne trouvait jamais rien,
alors que c'est exactement l'adresse qu'un opérateur connaît.
`originalFlow()` rend le tuple d'origine quand une traduction existe, et
le rendu comme le filtre le lisent tous les deux.

**B49 — l'expression du renifleur était coupée aux espaces.** Le moteur
de commandes découpe un `REST` en mots, donc
`diagnose sniffer packet any 'host 192.168.1.10' 4 10` arrivait avec
`'host` pour filtre et `192.168.1.10` pour verbosité.
`splitSnifferArguments()` rend sa forme à l'expression entre
apostrophes avant de lire les deux nombres qui la suivent.

**Le garde-fou d'architecture a fait son travail, et il avait
raison.** G1 (« un fichier vendeur reste petit — il assemble, il ne
calcule pas ») est tombé quand `FortiShell` a dépassé 800 lignes en
absorbant le dispatch du diagnostic. La correction n'est pas de
desserrer le seuil mais de sortir le calcul :
`diag/FortiDiagCommands.ts` porte les commandes, le shell les appelle.
G6 est tombé sur un `new Set([…])` littéral dans le formateur de
journaux, nommé depuis par une constante.

**Ce que la phase ne fait PAS, mesuré et écrit plutôt que tu** :
`get system performance status` ne rend ni CPU ni mémoire — ce
simulateur n'a aucun modèle de charge, et publier « 100% idle » serait
une constante affichée là où la vue promet une mesure. Les lignes
antivirus, IPS et licence sont omises pour la même raison, comme
`show ip http server status` l'avait déjà décidé côté Cisco.

**Correction du BRD.** §30.6 FGT-DIA-8 demandait que
`get firewall policy` rende les compteurs de coups. Un vrai FortiGate
n'en met pas : cette vue est un vidage de champs, et les compteurs
vivent dans `diagnose firewall iprope list`. La sonde a d'ailleurs
attrapé ma propre tentative — trois cas de `fortios-grammar` sont
tombés quand une vue écrite à la main a déplacé le rendu du schéma.

**Mesures.** 1070 cas verts sur 50 fichiers (module pare-feu +
`unit/gui`) ; 7 specs Playwright ; aucune erreur de typecheck dans le
module ; lint propre.

---

### E35 — FortiOS phase 5 : un châssis, plusieurs pare-feu logiques

`vdom/VdomRegistry.ts` (socle, neuf), `vendors/fortios/schema/vdom.ts`
(neuf) — **27 cas** neufs, plus 6 specs Playwright.

**Le piège que le BRD nommait « à éviter absolument » (§10.2) a été
évité, et c'est le cœur de la phase.** Un FortiGate multi-VDOM est UNE
machine : un châssis, des ports physiques, une pile, une horloge, un
cache ARP. Instancier deux `Firewall` aurait créé deux jeux de ports
qu'il aurait ensuite fallu recoller. `Firewall` porte donc un
**registre** de `VdomContext`, chacun tenant ce qui lui est propre —
zones, objets, politique, NAT, routes, sessions, horaires, journaux,
réglages — et `FirewallServices` les **résout** par VDOM
(`vdomOf(iface)`) au lieu de les porter en dur.

**Ce que la mesure prouve, et qui n'était pas acquis** : les **944 cas**
antérieurs sont restés verts sans qu'un seul ait été touché pour la
forme. Le mono-VDOM n'est pas une branche conditionnelle du
multi-VDOM : c'est son cas particulier, un registre à une entrée
(FGT-VDM-2).

**B50 — un VDOM est une PORTÉE, pas un conteneur.** `FortiNavigator`
traitait tout objet ouvert comme un parent dont on ne peut descendre que
vers ses enfants déclarés ; `config vdom` / `edit VENTES` /
`config firewall address` échouait donc, alors que c'est la séquence
normale d'un FortiGate. `FortiTableSpec.scopeOnly` nomme la différence,
et `FortiSocle` rouvre l'arbre complet sous un objet de portée.

**B51 — l'arbre de configuration était partagé entre VDOM.**
`FortiConfigTree` indexait ses tables par chemin seul : `VENTES` et
`TECHNIQUE` auraient édité la MÊME table, et `show` aurait rendu la
configuration des deux mélangée. La clé de rangement compose désormais
le chemin avec la portée pour un spec `scope: 'vdom'`, et le laisse nu
pour un spec global — la déclaration existante décide, aucune liste ne
s'ajoute.

**Le mode transparent est un autre PIPELINE, pas un drapeau.**
`FirewallProfile.pipeline` devient un dictionnaire par mode
(FGT-DEP-6) : la liste transparente n'a ni `route-lookup` ni `nat-*`, et
a `mac-lookup`. Un drapeau dans une étape aurait laissé les étapes de
NAT s'exécuter pour ne rien faire — et la trace de `diagnose debug flow`
aurait montré des étapes que le paquet n'a pas vraiment subies.

**`vdom-link` est un vrai câble.** Le BRD le demandait explicitement —
« deux `Port` reliés par un `Cable` interne, le dépôt a déjà tout ce
qu'il faut » — et c'est ce qui fait qu'un paquet traverse VRAIMENT les
deux politiques : il sort par `lien10`, arrive par `lien11`, et
retraverse le pipeline dans l'autre VDOM. Un appel direct entre les deux
bouts aurait été le raccourci que ce dépôt refuse.

**`switch-interface` court-circuite la politique**, et le témoin le
mesure : hors du groupe, la même topologie passe par `policy-lookup` et
se fait refuser. C'est la confusion classique (« pourquoi ma règle ne
s'applique pas ? ») rendue observable.

**Le garde-fou anti-commentaires a servi une fois de plus** : un bloc
`/** */` explicatif ajouté dans `FortiShell` a fait tomber la
convention du dépôt, et il a été retiré.

**Mesures.** 971 cas verts sur 35 fichiers du module ; 6 specs
Playwright ; typecheck sans erreur dans le module ; lint propre.
Discrimination : 19 des 27 cas tombent — la mesure porte sur la moitié
CLI, le socle ayant été poussé dans un commit antérieur, ce qui est dit
dans l'en-tête du fichier plutôt que laissé à supposer.

---

### E36 — FortiOS phase 6 : l'inspection lit le trafic, et le fil dit non

`inspection/UtmProfiles.ts` + `inspection/ContentInspector.ts` (socle,
neufs), `vendors/fortios/schema/utm.ts` (neuf) — **36 cas** neufs, plus
6 specs Playwright. **15 des 36 tombent avant correctif.**

**Le témoin a sauvé la phase.** Le premier cas de la sonde — « sans
profil UTM, la requête passe intacte » — a échoué. Sans lui, les trois
cas de BLOCAGE passaient tous, et j'aurais conclu que l'UTM
fonctionnait : ils vérifient une ABSENCE (`not.toContain`), et une
requête qui n'aboutit jamais satisfait cette absence aussi bien qu'un
blocage réussi. Un test qui ne peut pas distinguer « bloqué » de
« cassé » ne mesure rien.

**B52 — aucune connexion TCP n'a jamais pu traverser ce pare-feu avec
NAT.** Le défaut est antérieur à cette phase et vaut pour les DEUX
constructeurs, l'étage étant dans le socle. `sessionInstallStage`
indexait la session sur le paquet **APRÈS traduction** : la clé aller
était donc l'adresse traduite, que le client ne porte jamais. Le premier
paquet crée la session, la réponse correspond (elle arrive bien sur
l'adresse traduite) — et **tout paquet suivant de l'initiateur rate la
voie rapide**, se fait rejuger comme une nouvelle connexion, et un ACK
nu est refusé par `tcp-state-check`. Mesure : `curl` répond
`Empty reply from server` avec `set nat enable`, sert la page avec
`set nat disable`, et la trace des segments montre le SYN qui passe,
le SYN-ACK qui revient, puis l'ACK du client qui n'arrive jamais au
serveur. `context.originalPacket` existait depuis toujours et n'était
pas lu ; `SessionTable.install` reçoit désormais la clé retour
explicitement, parce que l'inverse de la clé aller n'est PAS la clé
retour dès qu'il y a traduction. **ICMP masquait le défaut** : un
`ping -c 1` n'émet qu'un paquet aller, donc la voie rapide n'était
jamais sollicitée une seconde fois — toutes les phases précédentes
n'avaient mesuré que de l'ICMP. La phase 4 avait d'ailleurs rencontré la
conséquence et soigné le symptôme : `originalFlow(session)`
reconstituait la vue avant traduction pour l'affichage, faute de
regarder la clé elle-même.

**B53 — l'inspection ne voyait jamais la charge utile.** `utm-inspect`
n'était placé que sur le chemin du PREMIER paquet ; or une requête HTTP
ne voyage jamais dans le SYN. `sessionLookupStage` court-circuite en
« fastpath » dès qu'une session existe, donc le GET traversait sans
être lu. L'inspection est appelée depuis les deux endroits par UNE
fonction (`inspectUtm`), jamais recopiée. Piège relevé au passage :
`proceed()` rend `Continue`, pas `accept` — ma première garde
court-circuitait sur tout verdict non-`accept` et faisait retomber les
paquets propres dans le pipeline complet, où la réponse du serveur
n'avait aucune politique retour et se faisait refuser. Seul un `drop`
doit court-circuiter.

**B54 — un enfant de type objet était injoignable depuis la CLI.**
`FortiSocle` n'enregistrait `config <nom>` que pour les enfants de type
TABLE (`object.child(name)` ne rend que celles-là), donc `config http`,
`config https`, `config web`, `config ftgd-wf` — tous les sous-blocs
d'un profil UTM — répondaient « unknown configuration path ». Même
cause, deuxième symptôme : `showRenderer.childLines` ne rendait pas
davantage ces blocs, si bien qu'un réglage tapé disparaissait de la
configuration rendue — donc du rechargement d'une topologie.

**B55 — la clé d'un objet n'était lisible nulle part.** `get` affichait
`name : ""` pour un profil nommé `AV`, la clé n'étant portée par aucun
attribut. `keyAttributeName(spec)` la dérive une fois (le premier
attribut, non modifiable par `set`), un garde-fou l'épingle, et cette
dérivation a immédiatement trouvé **deux tables qui ne déclaraient pas
leur clé du tout** (`system dhcp server`, `router static`).

**Le schéma que j'avais écrit n'était pas celui d'un vrai FortiGate.**
La sonde a échoué sur le filtrage d'URL, et la vérification a montré que
la faute était dans le produit : `config url-filter` **à l'intérieur**
du profil est une invention. Un vrai FortiGate déclare
`config webfilter urlfilter` / `edit 1` / `config entries`, puis
RÉFÉRENCE la table par son numéro depuis `config web` /
`set urlfilter-table 1` ; le filtre DNS a la même forme
(`config dnsfilter domain-filter`, référencée par
`set domain-filter-table`). Corrigé aux deux endroits. La différence
n'est pas cosmétique : une table référencée modifiée APRÈS le profil
prend effet, une table recopiée non — c'est une référence, pas une
copie, et `UtmProfileStore` la résout au moment de l'inspection.

**`deep-inspection` est REFUSÉ, en nommant la brique absente.** Elle
consiste à terminer la session du client et à la ré-émettre vers le
serveur sous un certificat re-signé par l'AC du FortiGate. Ce pare-feu
achemine des paquets et ne détient aucun point de terminaison TCP ni
TLS : il ne peut présenter aucun certificat. L'accepter aurait laissé
la session chiffrée pendant que la CLI aurait annoncé qu'elle est
déchiffrée. `FortiAttributeSpec.unimplementedValues` refuse le mot-clé
seul, pas l'attribut — `certificate-inspection`, elle, est RÉELLE.

**`certificate-inspection` lit le SNI d'un VRAI ClientHello**, et
Fortinet documente que c'est exactement ce qu'un FortiGate filtre sans
déchiffrer : le nom d'hôte, jamais le chemin. Les deux moitiés sont
épinglées, dont celle qui manque.

**Aucun analyseur n'est réécrit.** `parseHttpRequest` passe par
`Http1Wire.parseRequest` (RFC 9112), la question DNS par
`decodeDnsMessage` (RFC 1035), le SNI par `TlsRecordWire.decodeRecords`
+ `decodeMessages`. Trois expressions régulières sur du texte ont été
supprimées au profit des codecs du dépôt : deux analyseurs d'un même
protocole finissent toujours par se contredire, et ici ils lisent
désormais le VRAI format du fil au lieu d'en gratter la sérialisation.

**Interface en anglais** : six chaînes françaises restaient dans
`FortiValidator` et `FortiNavigator` — les messages d'erreur de valeur,
les plus lus de tous.

---

### E37 — FortiOS phase 7 : le pare-feu apprend qui parle

`identity/{IdentityTable,UserDirectory,AdminAccounts}.ts`,
`authz/AccessMatrix.ts`, `auth/AuthPortal.ts` (socle, neufs),
`schema/{user,admin}.ts` (neufs) — **43 cas** neufs, plus 8 specs
Playwright. **28 des 43 tombent avant correctif.**

**Le pare-feu n'avait aucune pile TCP, et c'est la brique dont
l'absence avait fait refuser `deep-inspection` en phase 6.** Il en a une
maintenant, et l'adaptateur n'est pas écrit : c'est celui de `Router`,
qui prouve depuis longtemps qu'un équipement non-hôte peut en porter
une. Le portail d'authentification est un vrai `Http1ServerSession`
dessus — pas un second moteur HTTP.

**B56 — le mandataire ne faisait pas partie de la clé de cache.**
`FortiSocle` met en cache la table de commandes par contexte, et la clé
composait le chemin, les attributs disponibles et l'empreinte des
références — mais pas QUI demande. Un compte `readonly` héritait donc
de l'arbre du compte précédent, et la matrice de droits n'avait aucun
effet observable. Deux cas de la sonde l'ont attrapé ; la correction est
d'un mot dans la clé, mais sans elle tout le mécanisme d'autorisation
était décoratif.

**La matrice est une MATRICE**, et c'est le troisième mécanisme
d'autorisation du dépôt après les niveaux d'IOS (ordre total) et les
vues d'analyseur (remplacement d'arbre). Un groupe `none` rend le chemin
ABSENT, un groupe `read` laisse lire et refuse d'écrire — vérifié sur le
produit, pas seulement sur l'objet.

**LDAP N'ÉTAIT PAS ABSENT, et le BRD se trompait.** Le tableau §23.4
portait « ❌ Aucun client ni serveur LDAP » et concluait à un refus
famille 2 ; j'avais écrit ce refus. Or le chantier Active Directory
avait déjà livré `LdapClient`, `LdapServer`, le codec BER, `LdapDN`,
`LdapFilter`, StartTLS et le bind GSSAPI — huit fichiers de test.
`config user ldap` est donc RÉEL : il compose le DN depuis `cnid` et
`dn`, ouvre une vraie connexion TCP/389 par `dialLdap` et fait un vrai
bind. **La leçon dépasse LDAP** : une case « ❌ » d'un tableau de
faisabilité vieillit, et il faut la vérifier dans le code avant de
refuser — un refus injustifié coûte plus cher qu'une absence, parce
qu'il ferme la porte ET la documente comme fermée.

**Rien n'est réécrit.** Les comptes passent par
`NetworkOsCredentialStore` (verrouillage compris), RADIUS par
`RadiusClientAgent`, TACACS+ par `TacacsClientAgent`, LDAP par
`LdapClient`, le portail par `Http1ServerSession`, et `trusthost`
compare l'adresse par `addressObjectMatches` — le même prédicat que les
objets d'adresse du pare-feu, pour que les deux ne puissent pas rendre
deux verdicts sur la même adresse. Les deux adaptateurs d'hôte réseau
que j'avais écrits (un pour TCP, un pour les agents) étaient
identiques : il n'en reste qu'un.

**L'étage `auth-check` refuse tant que l'adresse n'est pas associée**,
et l'association EXPIRE — une identité qui ne vieillit pas est une porte
ouverte pour toujours. `authtimeout` du groupe l'emporte sur le réglage
global, comme sur un vrai FortiGate.

**Trois extractions plutôt qu'un seuil relevé** (G1 et G3 ont tiré) :
`commit/identityCommits.ts`, `identity/AdminAccounts.ts`,
`logging/logFacts.ts`. La réponse à un fichier trop gros reste
d'extraire le calcul.

---

### E40 — `authmethod signature` authentifie, et le certificat entre par la CLI

`vpn/CertificateStore.ts` (neuf), `schema/vpn.ts`, `schema/types.ts`,
`commit/vpnCommits.ts`, `runtime/FortiNavigator.ts`,
`vpn/IpsecProgramming.ts`, `vdom/VdomRegistry.ts` — **10 cas** neufs plus
3 specs Playwright. **7 des 10** tombent avant correctif.

Le mot-clé était accepté, rangé, rendu par `show`, et le moteur
continuait de s'authentifier par clé partagée : rien n'appelait
`setIkeCertAuth`. Le moteur, lui, savait déjà tout faire — émettre une
charge utile de certificat, la VÉRIFIER contre des ancres de confiance,
refuser un certificat expiré ou révoqué. Il lui manquait uniquement
d'être configuré depuis FortiOS, c'est-à-dire deux magasins et un
branchement. **Encore une fois le refus aurait été le mauvais choix** :
la matière était là.

**`config vpn certificate local` et `config vpn certificate ca` sont
deux magasins distincts**, et c'est la distinction qui porte le sens :
l'un est l'IDENTITÉ de la machine (certificat ET clé privée), l'autre ce
qu'elle CROIT. Les noms d'attributs sont ceux de FortiOS, relevés sur la
documentation Fortinet et sur les modules Ansible qui en dérivent
(`certificate`, `private-key`, `range`, `source`, `trusted`), et le
certificat entre en PEM — la forme que produit n'importe quel outil, y
compris l'`openssl` de ce dépôt.

**Le cas qui décide est le certificat qu'aucune ancre ne signe** : le
tunnel ne monte pas. Sans lui, une implantation qui rangerait le
certificat sans jamais le lire passerait tous les autres cas.

**Un `onCommit` peut désormais REFUSER**, et il le fallait : `set
authmethod signature` sans `set certificate` décrit une phase 1 qui ne
peut pas s'authentifier, et un vrai FortiGate refuse à la fermeture de
l'objet plutôt qu'à la saisie — c'est là que la valeur est validée. Le
contrat passe de `=> void` à `=> string | void`, `next`/`end` rendent
`Command fail` et laissent l'objet OUVERT pour qu'on puisse le corriger.
Un PEM illisible est refusé de la même façon, et rien n'est rangé.

### E39 — FGT-VPN-3 : un paquet traverse le tunnel, pour de bon

`vpn/{IpsecDataPlane,FirewallIpsecHost}.ts`, `l3/ProxyArpTable.ts`
(neufs), `Firewall.ts`, `FirewallAgents.ts`, `ipsec/{IpsecHost,
IPSecEngine}.ts`, `Router.ts` — **12 cas** neufs plus 1 spec Playwright.
**8 des 12** tombent avant correctif.

La phase 8 avait livré la déclaration, la programmation et le
diagnostic ; elle laissait ouvert le seul point qui prouve qu'un tunnel
existe. Cette entrée le ferme, et la mesure a trouvé QUATRE défauts là
où j'en attendais un.

**(1) Un pare-feu ne recevait aucun datagramme adressé à lui-même, sauf
un écho ICMP.** `deliverLocally` répondait au ping et jetait tout le
reste, IKE compris : un FortiGate pouvait donc ÉMETTRE une offre IKE et
aucun ne pouvait y RÉPONDRE. Le tunnel ne montait jamais, quelle que
soit la configuration. C'est la cause première, et elle n'était pas dans
le VPN. Un point de fidélité au passage, vérifié contre la documentation
Fortinet plutôt que supposé : `allowaccess` ne gouverne PAS IKE — il
décrit l'accès d'ADMINISTRATION, et un tunnel monte sur une interface
qui n'autorise que `ping`.

**(2) `IPSecEngine` fouillait la table de ports de son hôte** par
`(this.router as any)._getPortsInternal()`, une méthode que seul
`Router` porte : chaque chemin de chiffrement explosait sur un pare-feu.
`IpsecHost` gagne les quatre FAITS que le moteur cherchait vraiment —
adresse locale d'une interface, adresses locales, interface tombée,
interface de sortie vers un pair — et les cinq fouilles disparaissent
avec quinze erreurs `no-explicit-any` préexistantes. Le moteur ne sait
plus ce qu'est un port : il pose des questions, l'hôte répond.

**(3) `removeStaticRoute` avait un CORPS VIDE.** `delete 1` sous `config
router static` retirait la route de la configuration et la laissait dans
la table de transfert : `show router static` ne la listait plus pendant
que le pare-feu continuait d'acheminer dessus. Même racine, un second
défaut : changer le `dst` d'une route existante en laissait une seconde
derrière, la suppression cherchant la NOUVELLE destination. La cause est
que la table de routage était indexée par préfixe alors que FortiOS
indexe par numéro de séquence ; `RouteTable` retient désormais l'identité
de configuration qui a posé chaque route, donc la suppression est exacte
— ce qui règle du même coup deux routes vers le même préfixe par deux
passerelles, qui disparaissaient ensemble.

**(4) Une carte de chiffrement pour tous les tunnels** ne permettait pas
de retrouver celle d'un tunnel donné : la séquence était calculée dans
une boucle. Une carte par tunnel (`FORTI_<nom>`) rend la recherche
stable, et `findEntryForPeer` parcourt de toute façon toutes les cartes.

**Ce qui a été écrit, et non contourné** : l'interface de tunnel est
choisie par la ROUTE, le sélecteur de phase 2 décide ensuite, le paquet
sort en ESP par l'interface physique liée, et à l'arrivée il RENTRE dans
le pipeline avec le tunnel comme interface d'ENTRÉE — donc la politique
`srcintf "vers_a"` le voit, ce que la sonde vérifie sur la session
ouverte côté distant. Rien n'est livré par appel direct : le laboratoire
est fait de deux FortiGate câblés, et les trames ESP sont comptées sur le
fil.

**Trois extractions imposées par G3**, jamais un seuil relâché :
`vpn/FirewallIpsecHost.ts`, `l3/ProxyArpTable.ts` et
`identity/AdminAccounts.remoteAuthenticate`.

### E38 — FortiOS phase 8 : le tunnel devient une interface, et IKE calcule vraiment

`crypto/dh/modp.ts`, `ipsec/{IkeKeyExchange,IpsecHost}.ts`,
`vpn/{IpsecTunnelTable,IpsecProposals,IpsecProgramming}.ts`,
`schema/vpn.ts` (tous neufs) — **42 cas** de phase plus **40 cas** de
crypto, plus 6 specs Playwright. **20 des 42** et **17 des 40** tombent
avant correctif.

**Deux affirmations du BRD étaient fausses, et les deux ont été
VÉRIFIÉES avant d'être suivies.** C'est la même leçon que LDAP en phase
7, et elle se répète assez pour mériter d'être une règle : un tableau de
faisabilité vieillit, et il faut le confronter au code avant de refuser
quoi que ce soit.

**(1) `IMPLEMENTED_GROUPS` ne gouvernait pas IKE.** Le BRD demandait de
refuser tout groupe Diffie-Hellman hors de cette liste. Or elle
appartient à l'échange de clés de TLS, qu'IKE n'appelle jamais : le
moteur NÉGOCIAIT un groupe, l'APPARIAIT entre les deux pairs (un
désaccord fait vraiment échouer le tunnel) et l'AFFICHAIT — sans le
CALCULER pour aucun groupe, le matériel de clé venant de la seule PSK à
travers un vrai PRF+ IKEv2. Appliquer le refus aurait rejeté `dhgrp 14`,
le groupe du laboratoire L8 de ce même document, sur un motif inexact.
**Le calcul est devenu réel** plutôt que le refus élargi : les nombres
premiers des groupes 1, 2, 5, 14, 15 et 16 sont EXTRAITS du texte des
RFC 2409 et 3526 — pas recopiés de mémoire — puis vérifiés (longueur en
bits, encadrement par 64 bits à un, `p mod 24 == 23`, primalité). Les
messages IKE portent une charge KEi/KEr (RFC 7296 §1.2). Mesure : le
secret est identique des deux côtés, DIFFÉRENT pour un tiers qui a tout
écouté, différent à chaque échange, et un groupe de 2048 bits coûte
5 ms.

**(2) 3DES n'était pas irrécupérable.** Le BRD le refusait faute de
`desCbcDecrypt` — exact — mais `desDecryptBlock` existait déjà, donc le
mode CBC était à quelques lignes. Il est écrit, le triple DES EDE avec,
et **ESP les APPLIQUE** : jusque-là un SA annoncé en `3des-cbc`
chiffrait en AES, ce qui est exactement le défaut « une vue affirme ce
que rien ne fait ». Le vecteur FIPS 81 est reproduit et 3DES à trois
clés identiques se réduit bien à DES.

**Le moteur IKE est celui du dépôt, pas un second.** Il était lié à
`Router` par un simple alias de type, et n'utilisait de lui que SIX
membres. `IpsecHost` nomme ce port étroit ; `Router` le satisfait sans
une ligne de changement, et `Firewall` l'implémente. Écrire un second
moteur aurait donné deux réponses possibles à « ce tunnel est-il
monté ? ».

**B57 — une interface de tunnel ne pouvait être ni routée ni
référencée.** C'est le point pédagogique du chapitre (« une fois le
tunnel monté, il n'y a plus de VPN — il y a une interface, une route et
une politique ») et il échouait en silence : le résolveur de références
n'énumérait que les objets de `config system interface`, donc
`set device "vers_site_b"` répondait « entry not found in datasource ».
La sonde à l'aveugle l'a attrapé au premier tir.

**Trouvé et corrigé en passant, hors phase** : un cas de
`fortios-grammar` encodait une prémisse devenue fausse. Le correctif CLI
d'un autre agent fait désormais entrer l'ATTRIBUT dans la résolution
d'une abréviation — `se srcaddr` reste ambigu entre `set` et `select`,
`se action` ne l'est plus puisque seul `set` porte `action`. C'est un
progrès ; le test le dit maintenant dans les deux sens.

**Quatre extractions plutôt qu'un seuil relevé** (G1 et G3 ont tiré) :
`commit/objectCommits.ts`, `FirewallAgents.ts`, `l3/FirewallEgress.ts`,
`logging/emitFirewallEvent.ts`.

---

## Périmètre pris — FortiOS phase 8 (VPN)

**Agent `mandeng`.** `docs/CARNET-FortiGate.md` fait foi pour l'état.

**Prélèvement sur le socle** : `vpn/` (nouveau répertoire —
`IpsecTunnelTable`, adaptation du moteur IKE existant au pare-feu),
interface de tunnel sur `InterfaceTable`, étage de chiffrement dans
`pipeline/stages/`.

**Fichiers FortiOS pris** : `schema/vpn.ts` (neuf),
`schema/{firewallPolicy,index,types}.ts`, `FortiShell.ts`,
`diag/*` (`diagnose vpn tunnel list`).

**Réutilisations imposées, à ne pas réécrire** : `ipsec/IPSecEngine.ts`
(IKEv1 et IKEv2 réels, ESP), `IMPLEMENTED_GROUPS` de
`tls/keyExchange.ts`, `crypto/` (AES-GCM, SHA-256), `TcpStack` et
`HttpsServerSession` du pare-feu pour le portail SSL-VPN.

**Ce que la phase ne prend PAS** : 3DES et DES sont REFUSÉS (le dépôt
n'a pas de `desCbcDecrypt` — même décision que `openssl enc`), et tout
groupe DH hors `IMPLEMENTED_GROUPS` de même.

---

## Périmètre pris — FortiOS phase 7 (utilisateurs et authentification)

**Agent `mandeng`.** `docs/CARNET-FortiGate.md` fait foi pour l'état.

**Prélèvement sur le socle** : `identity/IdentityTable.ts` (neuf — le
pendant de `SessionTable` pour les identités), `auth/AuthPortal.ts`
(neuf, monté sur `Http1ServerSession` du dépôt), `authz/AccessMatrix.ts`
(neuf), une pile TCP sur `Firewall` (adaptateur repris de `Router`),
étage `auth-check` dans `pipeline/stages/coreStages.ts`.

**Fichiers FortiOS pris** : `schema/user.ts` et `schema/admin.ts`
(neufs), `schema/{firewallPolicy,index,types}.ts`, `FortiShell.ts`,
`FortiSocle.ts`, `diag/*`.

**Réutilisations imposées, à ne pas réécrire** :
`NetworkOsCredentialStore` (comptes, verrouillage), `RadiusClientAgent`,
`TacacsClientAgent`, `synthTcpPacket`/`VtyIncomingPolicy` (trusthost),
`Http1ServerSession` (portail), `TcpStack` (adaptateur de `Router`).

**Ce que la phase ne prend PAS** : LDAP, FSSO et SAML sont REFUSÉS
famille 2 en nommant la brique absente, pas laissés ouverts.

---

## Périmètre pris — FortiOS phase 6 (inspection et UTM)

**Agent `mandeng`.** `docs/CARNET-FortiGate.md` fait foi pour l'état.

**Prélèvement sur le socle** : `inspection/UtmProfiles.ts` et
`inspection/ContentInspector.ts` (nouveau répertoire), `UtmProfileStore`
porté par `VdomContext`, étage `utm-inspect` dans
`pipeline/stages/coreStages.ts`, six champs UTM sur
`model/SecurityRule.ts`, `utmVerdict`/`inspectedSni` sur
`pipeline/PacketContext.ts`.

**Fichiers FortiOS pris** : `schema/utm.ts` (nouveau),
`schema/{firewallPolicy,index,types}.ts`, `FortiShell.ts`,
`runtime/{FortiObject,FortiNavigator,FortiValidator}.ts`,
`FortiMessages.ts`.

**Ce que la phase ne prend PAS** : `application list`, `ips sensor`,
`dlp sensor` et `firewall shaper` sont REFUSÉS dans le produit en
nommant la brique absente, pas laissés ouverts ; `deep-inspection` de
même.

---

## Périmètre pris — FortiOS phase 5 (VDOM et modes de déploiement)

**Agent `mandeng`.** `docs/CARNET-FortiGate.md` fait foi pour l'état.

**Prélèvement sur le socle, et c'est l'essentiel de la phase** :
`vdom/VdomRegistry.ts` + `VdomContext` (BRD-FortiGate §10.3, qui exige
explicitement que cela vive au SOCLE et non dans `vendors/fortios/`,
PAN-OS et Junos en bénéficiant à l'identique). `Firewall.ts` déplace
ses magasins par VDOM dans le registre ; `FirewallServices` les résout
par VDOM au lieu de les porter en dur. **Un seul VDOM `root` reste le
cas particulier du cas général, sans branche conditionnelle**
(FGT-VDM-2).

`FirewallProfile.pipeline` devient un **dictionnaire par mode**
(FGT-DEP-6) ; `pipeline/stages/` gagne `vdom-bind`, `mac-lookup` et
`switch-bridge`.

**Fichiers FortiOS pris** : `schema/{system,index,types}.ts`,
`FortiShell.ts`, `FortiSocle.ts`, `FortiProfile.ts`.

**Ce que la phase ne prend PAS** : le laboratoire L9 (FortiGate vs ASA)
est une comparaison documentaire, pas un mécanisme ; il est écrit dans
le BRD et non dans le code.

---

## Périmètre pris — FortiOS phase 4 (diagnostic et journaux)

**Agent `mandeng`.** `docs/CARNET-FortiGate.md` fait foi pour l'état.

**Fichiers pris** : `vendors/fortios/diag/*` (nouveau répertoire),
`vendors/fortios/schema/log.ts` (nouveau), `vendors/fortios/FortiShell.ts`,
`schema/{index,types,firewallPolicy}.ts`.

**Prélèvements sur le socle** : `logging/FirewallLogStore.ts` (nouveau —
un journal STRUCTURÉ, circulaire et borné, sans lequel
`execute log filter field srcip` ne peut filtrer sur rien) ;
`Firewall.ts` branche `SessionTable.onClosed`, jamais câblé, sans lequel
`set logtraffic all` — qui journalise à la FERMETURE — ne peut rien
écrire ; `Firewall.ts` porte aussi la capture de trames pour
`diagnose sniffer packet`.

**Ce que la phase ne prend PAS** : `execute backup/restore/revision`
(§29.4-29.5), qui appartiennent au chapitre `execute` et non au
diagnostic.

---

## Périmètre pris — FortiOS phase 3 (NAT complet)

**Agent `mandeng`.** `docs/CARNET-FortiGate.md` fait foi pour l'état.

**Fichiers pris** : `vendors/fortios/schema/firewallNat.ts` (nouveau),
`schema/{index,types,firewallPolicy}.ts`, `vendors/fortios/FortiShell.ts`,
`runtime/{FortiObject,FortiTable,FortiConfigTree}.ts`.

**Prélèvements sur le socle**, les suivants des treize (BRD §31.2) :
`model/AddressObject.ts` gagne le genre **`vip`** (FGT-S5 : une VIP est à
la fois un objet adresse et une règle NAT) ; `l3/ArpService.ts` gagne
l'**ARP mandataire**, sans lequel une VIP n'est joignable par personne ;
`Firewall.ts` porte les adresses mandatées.

**Correction de profil annoncée ici et RENVERSÉE par la mesure** :
ce périmètre annonçait `policySeesPreNatDestination` passant de `false`
à `true`. La documentation Fortinet dit l'inverse — la traduction de
destination a lieu **avant** la recherche de politique, donc la
politique voit l'adresse **traduite** ; ce qui la fait quand même
nommer la VIP dans `dstaddr`, c'est que l'objet adresse d'une VIP
désigne l'adresse **interne**. Le profil reste à `false` et c'est
`vipAddress()` qui porte la nuance. Voir E33.

---

## Périmètre pris — FortiOS phase 2 (système et objets)

**Agent `mandeng`.** BRD dédié : `docs/BRD-FortiGate.md` (6019 lignes,
44 chapitres, 230 exigences). Phase 1 livrée (E32) ; phase 2 = le système
et les objets, §39.

**Fichiers que la phase 2 prendra** :

```
vendors/fortios/schema/system.ts            ← global, settings, interface, zone, dns, ntp, dhcp
vendors/fortios/schema/firewallObjects.ts   ← addrgrp, service custom/group, schedule
vendors/fortios/schema/router.ts            ← static
vendors/fortios/schema/predefined.ts        ← le catalogue d'usine (BRD §44.2)
```

**Ce qu'elle touchera du socle**, et c'est le premier prélèvement des
treize que le BRD identifie (§31.2) : l'objet **horaire** (`model/`,
spécifié par BRD-Firewall §8.5 et jamais implémenté) et le branchement
de `PolicyEvaluator.scheduleActive`, qui existe comme dépendance et
n'est câblé par personne.

**Critère de sortie** : le laboratoire L1 du BRD — interfaces, objets,
route par défaut, politique, `set nat enable` — se joue de bout en bout
dans un terminal, et `allowaccess` refuse vraiment une connexion.

---

## Prochaines étapes

Phase 3 (ASA), reste à faire :

1. Démon SSH sur le pare-feu, puis `ShellFactory.register('asa', …)` — la
   CLI est là, il lui manque le transport (E27).
2. `%ASA-6-302014` à la fermeture d'une session — le catalogue le porte, la
   table des sessions n'a pas encore de crochet de fermeture branché.
3. PAN-OS, qui apporte le seul axe encore inéprouvé du contrat : la
   **configuration candidate** (`commit`), là où ASA et FortiOS sont tous
   deux immédiats. Puis Junos.

Hors périmètre de ce module, mesuré ici et à traiter pour lui-même :
`EndHost.pingIdCounter` incrémenté par sonde plutôt que par processus
(E26).

Puis phases 4 à 15 : diagnostics et journaux, FortiOS, cadre ALG, PAN-OS
(configuration candidate), écrans et profils, Junos (validation du contrat,
AC-C1), modes de déploiement, VPN, haute disponibilité, virtualisation,
identification, QoS.
