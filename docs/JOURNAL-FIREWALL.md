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

### E45 — RIP et OSPF : les minuteurs font l'adjacence, pas une commande

`routing/{DynamicRoutingTypes,FirewallRouting,RoutingWiring}.ts`,
`l3/LocalDelivery.ts`, `schema/routerDynamic.ts` (tous neufs),
`ospf/OSPFEngine.ts`, `Firewall.ts`, `l3/RouteTable.ts`,
`diag/getViews.ts` — **15 cas** neufs plus 5 specs Playwright. **11 des
15** tombent avant correctif ; les 4 autres sont nommés dans l'en-tête du
fichier de sonde plutôt que laissés à découvrir (deux témoins négatifs,
deux cas BGP qui passaient parce que le schéma entier était absent).

**Une prémisse fausse, et elle était la mienne.** La note de périmètre de
cette phase affirmait que le BRD §22.3 refusait RIP et OSPF en nommant un
couplage à `Router`. §22.3 ne dit rien de tel — elle traite du partage
entre VDOM — et §19.3 disait déjà l'inverse : « Les moteurs existent. Le
travail est de les brancher […] pas de les réécrire. » L'erreur a voyagé
d'une note jusqu'à l'en-tête d'un fichier de test ; les deux sont
corrigés. La leçon n'est pas celle de LDAP et de DH/3DES (« une case ❌
vieillit ») mais sa jumelle : **on vérifie une citation avant de la
répéter.** La mesure elle-même tient : `OSPFEngine` se construit avec un
numéro de processus et parle au fil par `setSendCallback` ; `RIPEngine`
se construit avec `RIPCallbacks`, qui EST déjà un port étroit. Ce qui
appartient à `Router`, c'est la GLU — un pare-feu a besoin de la sienne.

**Le défaut central n'était pas dans le pare-feu mais dans le moteur
partagé, et il était le mien.** `OSPFEngine.activateInterface` construit
un objet d'interface NEUF, `neighbors: new Map()` compris, et l'écrit
par-dessus l'ancien sans condition. Les quatre appelants du dépôt s'en
gardent tous par un `if (!engine.getInterface(name))` — quatre copies de
la même garde, donc une garde que le moteur aurait dû porter. Ma glu
appelait sans garde : l'adjacence atteignait `ExStart`, puis l'appel
suivant l'effaçait. `reactivateInterface` met désormais les faits à jour
EN PLACE et ne réinitialise la machine à états que lorsque quelque chose
invalide vraiment les adjacences — changement de zone, d'adresse, de
masque ou de type de réseau (RFC 2328 : un voisin d'une autre zone n'est
pas un voisin). Les quatre appelants gardés ne traversent jamais ce
chemin, donc le correctif ne peut rien changer pour eux : 48 fichiers
OSPF/RIP et 220 fichiers de routage et de CLI constructeur passent.

**`convergeDynamicRouting()` a été écrit, puis SUPPRIMÉ, et c'est le
correctif qui compte.** Première version : une commande qui pompait des
Hello, forçait l'élection et lançait le SPF. Un vrai FortiGate n'a pas
cette commande, et surtout elle mesurait sa propre complaisance — elle
faisait exister l'adjacence au lieu de l'observer. Les deux bouts
portent de VRAIS minuteurs (`HelloActor` est armé par
`OSPFEngine.setEventBus`, `RIPEngine.start()` arme un `setInterval` de
30 s), donc il ne manquait rien qu'un déclencheur : les interfaces sont
activées au COMMIT de la configuration — comme sur une vraie machine, et
comme le fait `Firewall.configureInterface` quand une adresse change — et
la sonde avance une horloge virtuelle. `RIPEngine.sendUpdates()`, ajouté
en chemin, est retiré pour la même raison : c'était une seconde façon de
faire ce que le minuteur fait déjà.

**Deux valeurs rangées et lues par personne**, trouvées en branchant :
je poussais dans `engine.getConfig().networks` alors que `addNetwork()`
existe et fait TROIS choses — dédoublonner, déclarer la zone, amorcer sa
base de données d'états de liens ; sans la zone, le SPF n'avait rien sur
quoi tourner et rendait zéro route avec une adjacence pourtant `Full`. Et
`config area … set type` était stocké et jamais transmis : il passe
maintenant par `setAreaType`.

**La table de routage rendait un format qu'aucun FortiGate ne produit.**
Vérifié contre la documentation Fortinet et des captures : le vrai rend
`C 10.0.1.0/24 is directly connected, port4` — notation CIDR, et le
préfixe suivi d'UNE espace, seule la colonne de code étant calée. Le
dépôt écrivait `192.168.1.0 255.255.255.0` et calait le préfixe sur 22
caractères. Corrigé dans le rendu partagé (`FIXED_TABLE`), et l'attente
de `fortios-diagnostic.test.ts` corrigée avec — c'est le test qui
encodait le mauvais format, pas le code qui régressait. Une route apprise
dont le saut suivant est vide se rend `[110/1] is directly connected`,
comme le vrai, plutôt que `via , port2`.

**BGP reste refusé**, et sa note ne parle plus d'un couplage inexistant :
le moteur BGP est réel, il lui manque la session TCP que ce pare-feu
n'ouvre pas encore pour lui. `FortiNavigator` lit `spec.unavailable`, donc
le refus est une propriété du schéma et non un cas particulier écrit à la
main.

**Trois extractions plutôt qu'un seuil relevé** (G1/G3 ont tiré à 850
lignes) : `routing/RoutingWiring.ts`, `l3/LocalDelivery.ts`, et le report
de `logPipelineOutcome`/`publishPoolProxyArp` dans les modules qui les
concernent. `Firewall.ts` retombe à 799.

**Trouvé et NON corrigé, parce que ce n'est pas à moi** :
`cisco-acl.test.ts` « 4.2 named extended ACL » échoue déjà sans aucune de
mes modifications (vérifié par `git stash push -- src/network/`).

---

### E44 — FGCP : deux FortiGate élisent un primaire, et le fil en décide

`ha/{HaTypes,HaAgent,HaSessionSync,FirewallHa}.ts`,
`vdom/VdomLinkTable.ts`, `l3/SwitchGroupTable.ts`, `schema/ha.ts`,
`diag/haRenderer.ts` (tous neufs), `Firewall.ts`, `FortiShell.ts`,
`FortiSocle.ts` — **28 cas** neufs plus 4 specs Playwright. **27 des 28**
tombent avant correctif.

**La contrainte P6 est tenue : la synchronisation traverse le fil.** Les
battements de cœur sont de vraies trames sur `hbdev` (`etherType`
0x8890), et débrancher le câble de synchronisation produit un cerveau
divisé observable — les deux membres se croient primaires — puis le
rebrancher le résorbe. Ce laboratoire n'existe que parce qu'aucune
synchronisation en mémoire n'a été prise.

**L'ordre de départage est celui de FortiOS et chaque critère a son
cas** : nombre d'interfaces surveillées ACTIVES, puis priorité, puis
durée de fonctionnement par tranches de cinq minutes, puis numéro de
série. Le cas qui porte le chapitre est le premier : on débranche un
câble surveillé et le rôle bascule bien qu'on n'ait touché à aucune
priorité.

**Trois défauts trouvés en mesurant, tous dans ma propre conception** :

1. **Un membre fraîchement configuré se déclarait primaire** avant
   d'avoir entendu la grappe, et la règle de l'occupant le maintenait
   ensuite indéfiniment. Un membre qui rejoint entre désormais comme
   secondaire et n'est promu que s'il gagne.
2. **La règle de l'occupant ne savait pas départager DEUX prétendants** :
   après un cerveau divisé, les deux se disent primaires et `find`
   choisissait le premier venu. Quand plus d'un revendique le rôle, la
   règle se retire et l'élection tranche.
3. **`execute ha failover set` n'était su que du membre qui l'exécute** :
   le pair continuait de l'élire sur sa priorité. Le retrait voyage
   maintenant DANS le battement, comme tout le reste.

**Le condensé de configuration exclut ce qui diffère légitimement d'un
membre à l'autre** (nom d'hôte, priorité, et le bloc `config system ha`
lui-même). Ce n'est pas cosmétique : sans cela `diagnose sys ha checksum
show` aurait annoncé une désynchronisation permanente sur une grappe
saine, et surtout la configuration rejouée aurait porté `set password ENC
…` — un condensé que ce simulateur ne sait pas relire — donc la
synchronisation aurait CASSÉ le mot de passe de la grappe qu'elle
prétendait maintenir.

**`set password` est rendu `ENC <condensé>`** comme sur une vraie
machine ; l'attribut porte `secret: true` et le rendu est unique, de
sorte qu'aucun autre secret du schéma ne puisse être oublié.

**Le laboratoire donne à chaque membre ses PROPRES liens surveillés**, et
c'est une correction de méthode : au premier essai les deux membres
partageaient les câbles, donc en couper un faisait perdre une interface
aux DEUX et le critère ne départageait rien.

Trois extractions imposées par G3, jamais un seuil relâché :
`ha/FirewallHa.ts`, `vdom/VdomLinkTable.ts`, `l3/SwitchGroupTable.ts`.

### E43 — SD-WAN : la sonde mesure, et la sélection suit la mesure

`sdwan/{SdwanTable,SdwanHealthProbe,SdwanService}.ts`,
`diag/TraceRing.ts`, `schema/sdwan.ts`, `diag/sdwanRenderer.ts` (tous
neufs), `Firewall.ts`, `FortiSocle.ts`, `FortiDiagCommands.ts` —
**14 cas** neufs plus 3 specs Playwright. **13 des 14** tombent avant
correctif.

`config system sdwan` n'avait aucun schéma. La matière existait : le
pare-feu route, `Cable` porte `packetLossRate` — ce qui rend le seuil de
perte DÉMONTRABLE plutôt que décoratif — et le pipeline a déjà un étage
de route de politique, qui est exactement ce qu'une règle de service
SD-WAN est.

**La sonde envoie de VRAIS échos**, depuis l'interface du membre vers le
serveur déclaré. Le pare-feu n'avait pas de client d'écho ICMP — il
RÉPOND, il n'appelle pas — et c'est la brique qui manquait ;
`SdwanHealthProbe` la fournit et compte ce qui revient. Le moteur IP SLA
du dépôt n'a **pas** été adopté ici, et c'est une décision mesurée :
`IpSlaHost` est un port LARGE (`tracePath`, `computeKeyDigest`,
`sendTrap`, `fetchHttp`, `sendIcmpv6Echo`…) dont un pare-feu ne remplirait
presque rien, et ce qu'une sonde de santé SD-WAN a besoin de savoir tient
en une phrase — « combien d'échos sont revenus ». Écrire l'adaptateur
aurait produit plus de code inerte que de code utile.

**Le laboratoire est à deux fournisseurs qui mènent au MÊME serveur** par
une dorsale commune, et ce n'est pas un détail : au premier essai la
sonde visait l'adresse du premier fournisseur, donc le second membre
échouait pour une raison de topologie et non de produit. Une bascule qui
« marche » parce que le second lien ne mène nulle part ne prouve rien.

**Les seuils de latence et de gigue sont acceptés, stockés, rendus — et
jamais franchis**, la livraison de trame étant synchrone. C'est la même
limite qu'IP SLA a mesurée et écrite ; l'aide de l'attribut la nomme, de
sorte qu'un apprenant lise la contrainte au lieu de la découvrir. Le
seuil de PERTE, lui, est mesuré pour de bon.

**Le format de `diagnose sys sdwan health-check` est celui de FortiOS**,
relevé sur la documentation Fortinet : un membre mort n'affiche NI
latence NI gigue, ce qu'une implantation écrite de mémoire aurait raté.

**Trois garde-fous ont mordu, et chacun avait raison.** G2 a attrapé une
vraie faute d'architecture : le socle importait un type de la couche
vendeur (`FortiSdwanPatch`) — la configuration SD-WAN appartient au
socle, et c'est FortiOS qui s'y projette. G8 a attrapé un rang de rendu
en double, G3 a imposé l'extraction de `diag/TraceRing.ts`.

### E42 — SSL-VPN en mode web : le portail écoute, et il présente un certificat

`vpn/SslVpnPortal.ts`, `auth/FirewallPortals.ts` (neufs), `schema/vpn.ts`,
`schema/types.ts`, `commit/vpnCommits.ts`, `Firewall.ts` — **13 cas**
neufs plus 3 specs Playwright. **12 des 13** tombent avant correctif.

`config vpn ssl settings` n'avait aucun schéma, donc toute la famille
tombait dans le vide — un apprenant qui suit un tutoriel FortiGate
s'arrête à la première ligne. La matière, elle, était là : le pare-feu
porte une pile TCP, un serveur HTTP/1.1 réel (le portail
d'authentification de la phase 7), un serveur TLS réel, et depuis E40 un
magasin où `set servercert` peut puiser. **Ce chantier est donc le
premier consommateur du précédent** : le certificat qu'un opérateur
importe sert vraiment à quelque chose.

**Le défaut trouvé en le mesurant dépasse largement le SSL-VPN** : un
pare-feu ne remettait **AUCUN segment TCP à sa propre pile**.
`deliverLocally` répondait à l'écho ICMP, puis à IKE depuis E39, et
jetait tout le reste. Conséquence : **tout écouteur que le pare-feu porte
était sourd**, le portail d'authentification de la phase 7 compris — dont
aucun test n'avait jamais joint le port depuis le fil, tous visant un
serveur situé DERRIÈRE le pare-feu. Une fonction livrée, testée, et
injoignable.

**Un portail déclaré sans certificat ne s'ouvre PAS en clair**, il est
refusé : la même règle que `tlsMaterialFor` applique côté nginx/Apache,
et pour la même raison — tout ce qui suit traite le port 10443 comme
chiffré, donc y servir du clair serait la pire réponse disponible.

**`tunnel-mode` est REFUSÉ en nommant la brique absente** (il faudrait un
client FortiClient qui n'existe pas ici) plutôt que rangé inerte. Le mode
web, lui, est servi pour de bon : `curl -k https://<fgt>:10443/` rend la
page de connexion, et `curl -v` montre le certificat configuré.

**`authentication-rule` décide qui entre** : un membre d'un groupe nommé
par une règle est admis, un utilisateur qu'aucune règle ne nomme est
refusé — sans règle, personne n'entre, ce qui est le défaut sûr.

Trois extractions imposées par G3 : `auth/FirewallPortals.ts`,
`nat/clearVdomTranslations`, et le déplacement des ports du portail.

### E41 — `dpd` et `nattraversal` agissent, et `diagnose` rapporte une mesure

`schema/vpn.ts`, `schema/types.ts`, `commit/vpnCommits.ts`,
`vpn/{IpsecTunnelTable,IpsecProgramming,IpsecDataPlane}.ts`,
`diag/vpnTunnelRenderer.ts`, `ipsec/{IPSecEngine,IPSecTypes}.ts` —
**11 cas** neufs. **7 des 11** tombent avant correctif.

Les deux réglages étaient acceptés, rangés, rendus par `show` ET par
`diagnose vpn tunnel list` — et le moteur ne les recevait pas. Le rendu
correct est précisément ce qui rendait le décor crédible : la
configuration relue reproduisait ce qu'on avait tapé, seule la MACHINE
l'ignorait.

**`natt: mode=` était pire qu'inerte, il était FAUX.** La vue le
dérivait de la CONFIGURATION (`enable` → `silent`), alors que ce champ
décrit ce que la session a NÉGOCIÉ. Sur un chemin sans traduction
d'adresses, un vrai FortiGate écrit `natt: mode=none` quoi qu'on ait
configuré, NAT-T ne s'employant que lorsqu'une traduction est détectée.
La vue lit désormais l'état de l'association, et `nattraversal` est une
POLITIQUE dans le moteur (`disable` interdit, `forced` impose, `enable`
laisse la détection décider) là où il n'existait que la détection.

**`dpd` atteint le moteur**, dont la détection était complète et
configurée par personne : `on-idle` arme le mode périodique, `on-demand`
le mode à la demande, `disable` n'arme rien, et `dpd-retryinterval` /
`dpd-retrycount` — absents du schéma — portent les défauts de FortiOS
(15 s, 3 essais). Un pair muet fait tomber les associations après le
nombre d'essais configuré, ce que la sonde vérifie en coupant le port du
voisin.

**Défaut trouvé en mesurant** : `diagnose vpn tunnel up` REPROGRAMMAIT le
moteur et ne NÉGOCIAIT rien — la commande dont le nom est « monte ce
tunnel » se contentait de constater qu'aucune association n'existait.
`IPSecEngine.initiateTunnel` est l'entrée publique qui manquait.

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

### E50 — Les collecteurs syslog émettent, et leur chemin CLI était faux

`logging/SyslogCollectors.ts` (neuf), `schema/log.ts`, `schema/types.ts`,
`runtime/commitDevice.ts`, `FortiShell.ts`, `FortiSocle.ts`,
`Firewall.ts` — **8 cas** neufs plus 5 specs Playwright. **7 des 8**
tombent avant correctif ; le huitième est le témoin négatif.

**Quatre collecteurs déclarés, `onCommit` VIDES** — la famille de défaut
d'E47 exactement. `config log syslogd` acceptait serveur, port, mode,
facilité, format, interface source et filtre, `show` les reproduisait, et
aucun datagramme ne partait. Un vrai `rsyslog` sur une vraie machine
Linux (`imudp` décommenté, ce que fait le laboratoire) reçoit maintenant
la ligne dans son `/var/log/syslog` : `FGT fortios %FORTIOS-…: Deny ICMP
src port1:192.168.1.10/0 dst port2:203.0.113.10/0`. Le test lit ce
fichier, pas un compteur.

**LE CHEMIN CLI ÉTAIT FAUX, et c'est plus qu'un détail de frappe.** Le
schéma déclarait `config log syslogd` avec un enfant `filter` ; un vrai
FortiGate a `config log syslogd setting` et `config log syslogd filter`
comme **frères**, vérifié contre la référence CLI de Fortinet. La
conséquence dépasse la saisie : `show` rendait `config log syslogd`, donc
une configuration exportée d'ici ne se colle pas sur une vraie machine —
et la configuration rendue est REJOUÉE à l'import d'une topologie. Les
trois cas de `fortios-diagnostic.test.ts` qui utilisaient l'ancien chemin
encodaient le défaut ; ils sont corrigés, pas contournés. `FortiShell`
lisait le format sur ce même chemin et le lisait donc désormais nulle
part : corrigé dans la foulée, sans quoi les quatre formats seraient
devenus muets.

**Le filtre FILTRE.** `set severity emergency` retient une notification
ordinaire, et le cas qui le vérifie a dû être renforcé : il passait des
deux côtés tant qu'il ne prouvait pas d'abord que le message arrivait
sans le filtre.

**Un collecteur désactivé disparaît de la liste des destinations** plutôt
que d'y rester inerte — `listServers()` est ce que l'agent utilise pour
émettre, donc l'y laisser aurait continué d'envoyer.

`SyslogCollectorTable` projette les quatre collecteurs sur l'agent unique
du socle. Elle ne réécrit pas `projectLoggingOntoSyslogAgent`, qui
projette l'AUTRE source (le `LoggingConfig` de style Cisco, que l'ASA
utilise) : deux sources, un agent, et c'est la table qui décide pour
FortiOS.

**Trois compactions plutôt qu'un seuil relevé** (G3 a tiré à 802 lignes) :
`Firewall.ts` retombe à 798.

---

### E49 — Le portail captif capture, et un défaut du socle TCP tombe avec

`auth/CaptivePortalRedirect.ts`, `mgmt/ManagementWiring.ts`,
`l3/Ipv4Ingress.ts` (neufs), `tcp/TcpStack.ts`, `Firewall.ts`,
`schema/system.ts`, `schema/firewallPolicy.ts`, `schema/types.ts`,
`runtime/commitDevice.ts` — **9 cas** neufs plus 5 specs Playwright.
**6 des 9** tombent avant correctif ; les trois autres sont nommés dans
l'en-tête (un témoin de non-régression, deux témoins négatifs).

**Le détournement est une vraie réponse HTTP sur une vraie connexion
TCP.** Un `curl` d'un `LinuxPC` vers un serveur distant reçoit
`303 See Other` avec `Location: http://192.168.1.1:1000/fgtauth` — format
vérifié contre la documentation Fortinet, port pris de
`config system global auth-http-port`. Une fois l'identité liée, le même
`curl` atteint nginx : un portail dont on ne sort pas serait une
souricière, pas un portail.

**Le mécanisme est celui d'un vrai portail captif** : un écouteur TCP
générique (`0.0.0.0:80`) répond À LA PLACE de la destination. Le paquet
refusé par `auth-check` est remis à la pile TCP du pare-feu au lieu
d'être jeté, et la pile — dont l'écouteur générique accepte n'importe
quelle destination — termine la connexion et sert la redirection.

**UN DÉFAUT DU SOCLE TCP EST TOMBÉ AVEC, et il dépasse le portail.**
`TcpStack.transmit` sourçait chaque segment depuis `egress.srcIp`,
l'adresse que le ROUTAGE choisit vers le pair, au lieu de
`socket.localIp`, l'adresse que le pair a réellement adressée. Pour une
socket ordinaire les deux coïncident, ce qui rendait le défaut invisible ;
pour une socket acceptée sur un écouteur générique elles diffèrent, et le
SYN-ACK partait de `192.168.1.1` alors que le client attendait
`203.0.113.10` — le client répondait RST, mesuré. C'est la même forme que
plusieurs défauts déjà refermés ici : une valeur re-dérivée d'une
deuxième façon au lieu d'être lue là où elle est décidée. 168 fichiers
TCP, HTTP, SSH et telnet restent verts.

**Un flux capturé n'est plus du transit.** Après le SYN, l'ACK et la
requête tombaient plus tôt, à `tcp-state-check` (`no-session-non-syn`) :
aucune session n'existe, puisque le SYN a été refusé. Le portail retient
donc les quadruplets qu'il a capturés et les réclame AVANT le pipeline,
à côté des autres revendications de plan de contrôle — ce qui est la
vérité du modèle : une connexion que le pare-feu termine lui-même n'est
pas du trafic qui le traverse.

**`security-mode captive-portal` est l'autre forme**, par interface au
lieu de par politique, et elle détourne sans qu'aucune politique n'exige
d'authentification. `set security-mode none` la retire vraiment — le cas
qui le vérifie a dû être renforcé, car il passait des deux côtés tant
qu'il ne prouvait pas d'abord que le détournement avait lieu.

**Ce qui n'est pas du HTTP est REFUSÉ, pas détourné** : on ne redirige
pas un ping vers un formulaire, et prétendre le contraire serait pire que
le refus. HTTPS n'est pas capturé non plus : il faudrait présenter un
certificat pour un nom qu'on n'a pas, ce que la phase 6 refuse déjà faute
de point de terminaison TLS re-signant.

**Trois extractions plutôt qu'un seuil relevé** (G3 a tiré à 865 lignes) :
`mgmt/ManagementWiring.ts` rassemble le câblage des quatre services qui
terminent des connexions (portails, HA, NTP, portail captif) —
le constructeur en faisait 166 lignes —, `l3/Ipv4Ingress.ts` prend la
CLASSIFICATION d'un paquet entrant (consommé, désencapsulé, local,
transit) et la rend lisible d'un coup d'œil, et la glu du portail
descend dans le module du portail. `Firewall.ts` retombe à 798.

---

### E48 — Horaires ponctuels, groupes d'horaires, NTP

`mgmt/FirewallNtp.ts`, `pipeline/PipelineCache.ts`,
`runtime/commitDevice.ts` (neufs), `model/ScheduleObject.ts`,
`schema/firewallObjects.ts`, `schema/system.ts`, `schema/types.ts`,
`FortiShell.ts`, `Firewall.ts` — **12 cas** neufs plus 5 specs Playwright.
**9 des 12** tombent avant correctif ; les trois autres sont nommés dans
l'en-tête, et aucun ne prouve quoi que ce soit du mécanisme.

**Une vérification a démenti le carnet, et c'était une bonne nouvelle.**
§6.2 bis annonçait `PolicyEvaluator.scheduleActive` « câblé par
personne » : il l'est depuis `VdomRegistry:183`. La porte existait ; il
manquait les deux formes d'horaire qui la traversent.

**`onetime` est une fenêtre ABSOLUE, et c'est ce qui le distingue du
récurrent.** `HH:MM YYYY/MM/DD` des deux côtés, format vérifié contre la
référence CLI de Fortinet. Avant sa date la politique bloque, pendant
elle passe, après elle bloque à nouveau — les trois sont mesurées par un
vrai ping, pas par un affichage. `startAt`/`endAt` sont des instants
absolus et non des minutes dans la journée : réutiliser
`startMinutes`/`endMinutes` aurait fait d'un horaire ponctuel un horaire
récurrent portant une date décorative.

**Un groupe est l'UNION de ses membres**, et la récursion porte un jeu de
noms déjà visités : un groupe qui se contiendrait lui-même boucle
autrement. Un membre inexistant est refusé au lieu d'être stocké — sans
quoi une faute de frappe donnerait un groupe silencieusement vide, donc
une politique qui ne s'ouvre jamais sans que rien ne le dise.

**`moment()` est un attribut à DEUX parties**, heure puis date. Le
déclarer en `text()` ne captait rien : `set start 23:00 2026/12/31`
laissait `effective('start')` vide et l'horaire naissait sans bornes.
La moitié heure est typée `TIME` donc `25:99` est refusé par la CLI, et
la moitié date est vérifiée au commit par `makeOnetimeSchedule`, qui
refuse aussi une fin antérieure au début.

**NTP branche l'agent du dépôt.** `NtpAgent` sert déjà le routeur ;
`FirewallNtp` lui donne le port d'hôte du pare-feu. Un `type custom` sans
serveur est refusé plutôt que stocké — c'est une configuration qui
promet une synchronisation que rien ne peut faire.

**Trois extractions plutôt qu'un seuil relevé** (G1 et G3 ont tiré) :
`runtime/commitDevice.ts` sort les 245 lignes de la fabrique de commit
hors du shell vendeur — avec les quatre fonctions utilitaires qu'elle
seule employait —, `pipeline/PipelineCache.ts` prend le cache de
pipelines, et `buildFirewallNtp` rejoint son propre module. `FortiShell.ts`
retombe de 808 à 544, `Firewall.ts` à 798.

**Deux cas de sonde corrigés, pas le code** : la lecture de la
configuration NTP passe par `associations`, pas par un champ `servers`
que ce type n'a pas ; et le refus d'un membre inconnu tombe sur `set`,
pas sur `next`.

---

### E47 — DHCP : le schéma existait, `onCommit` était VIDE

`l3/FirewallDhcp.ts`, `l3/L3ServiceWiring.ts` (neufs), `schema/system.ts`,
`FortiShell.ts`, `diag/getViews.ts`, `Firewall.ts`, `ha/FirewallHa.ts` —
**8 cas** neufs plus 5 specs Playwright. **6 des 8** tombent avant
correctif ; les deux autres sont nommés dans l'en-tête du fichier.

**`config system dhcp server` était déclaré, stocké, rendu par `show` —
et son `onCommit` était littéralement `onCommit() {}`.** La famille de
défaut que ce module passe son temps à refermer : une valeur affichée que
rien ne soutient. Le socle DHCP du dépôt est complet et sert déjà le
routeur, le commutateur et Windows Server ; il ne manquait que le
branchement. Un vrai `LinuxPC` obtient maintenant un vrai bail par un
vrai DISCOVER sur le fil, la passerelle et le DNS déclarés arrivent
jusqu'à `ip route` et `/etc/resolv.conf` du client, et deux clients du
même segment reçoivent deux adresses différentes.

**La plage FortiOS est traduite en exclusions, parce que les deux modèles
diffèrent.** `DHCPServer` est de forme IOS — un réseau, un masque, des
plages EXCLUES — là où FortiOS déclare `start-ip`/`end-ip`.
`gapsOutsideRanges` exclut ce qui est en dehors des plages déclarées :
c'est la traduction exacte, et elle évite d'écrire un second allocateur à
côté de celui qui existe.

**`set status disable` éteint pour de bon**, et le cas qui le vérifie a
dû être renforcé : il passait des deux côtés parce que rien ne servait
avant correctif. Il obtient maintenant un bail D'ABORD, puis désactive,
puis vérifie qu'un nouveau bail n'est plus délivré — sans ce premier
temps, l'assertion ne distinguait pas « éteint » de « jamais allumé ».

**`set mode dhcp` est un vrai CLIENT.** `DHCPClient` et
`WireDhcpChannel` existaient ; le pare-feu leur fournit son propre
émetteur de trames et reçoit les réponses par un second point de dispatch
(UDP/68), symétrique de celui du serveur (UDP/67). L'adresse obtenue
passe par `configureInterface` et la passerelle pose une route par défaut
identifiée `dhcp:<iface>`, donc retirée quand le bail tombe.

**`execute dhcp lease-list`** rend le format du vrai — nom d'interface
sur sa ligne, puis les colonnes `IP MAC-Address Hostname VCI SERVER-ID
Expiry` — et ne montre que ce qui est réellement mesuré : les colonnes
que ce simulateur ne renseigne pas restent vides plutôt que d'être
inventées.

**Une erreur de laboratoire de ma part, corrigée** : mes deux clients
étaient d'abord sur deux ports différents du pare-feu, donc sur deux
segments, ce qui ne teste pas l'allocation mais la topologie. Ils passent
par un `GenericSwitch`, dont les ports s'appellent `eth0…` et non
`Fa0/1`.

**Quatre extractions plutôt qu'un seuil relevé** (G3 a tiré à 834
lignes) : `l3/L3ServiceWiring.ts` rassemble le câblage du routage, du
DHCP et du SD-WAN — le constructeur en faisait 171 lignes à lui seul ;
`buildFirewallHa` rejoint `ha/FirewallHa.ts` ; `claimedByControlPlane`
réunit les trois tests de plan de contrôle du chemin d'entrée en un
seul ; et les délégations `applyDhcpScope`/`removeDhcpScope` disparaissent
au profit de `getDhcp()`. `Firewall.ts` retombe à 798.

---

### E46 — BGP : le refus était le mien, et rien ne manquait

`routing/FirewallBgp.ts`, `bgp/bgpTransport.ts` (neufs),
`schema/routerDynamic.ts`, `FortiShell.ts`, `diag/getViews.ts`,
`l3/RouteTable.ts`, `RouterDynamicRouting.ts` — **11 cas** neufs plus 5
specs Playwright. **10 des 11** tombent avant correctif ; le onzième est
le témoin négatif, nommé dans l'en-tête du fichier.

**La note de la phase 10 disait « le moteur BGP est réel, la session TCP
ne lui est pas ouverte ». C'était faux.** Le pare-feu porte un
`TcpStack` depuis la phase 7, et j'avais moi-même branché la livraison
locale TCP en phase 8 (`deliverLocally` → `this.tcp.handleIp`).
`BGPEngine.setWire(wire)` est un port d'UNE méthode,
`connect(ip): BgpPeerLink | null`. Il ne manquait donc rien : la session
TCP/179 s'ouvre, l'adjacence atteint `Established` **des deux côtés**
(mesuré sur le voisin Cisco, pas seulement chez nous), le préfixe distant
est appris et rendu `B`, notre propre préfixe est ANNONCÉ — R1 installe
`B 192.168.1.0/24 [20/0] via 10.0.0.1` — et un ping traverse.

**Le défaut central était que je n'appelais pas `enable()`.** Je
remplissais `engine.getConfig()` à la main puis appelais `converge()` ;
or `converge()` sort par sa première ligne tant que le moteur n'est pas
`enabled`, si bien que rien ne se passait et que `getNeighbors()`
répondait vide. `enable(config)` fusionne ET converge : c'est le chemin
public, et le contourner revenait à écrire un second démarrage à côté du
vrai.

**Une seule implémentation du transport.** `bgpTransport(socket)` vivait
en fonction privée dans `RouterDynamicRouting.ts` ; la recopier dans le
pare-feu aurait donné deux adaptateurs pour un seul protocole. Elle est
extraite dans `bgp/bgpTransport.ts` et les deux appelants la lisent.

**`edit "10.0.0.2"` est entre guillemets, `edit 0.0.0.0` ne l'est pas**,
et ce n'est pas une incohérence de FortiOS : la table `neighbor` de BGP
cite sa clé, la table `area` d'OSPF ne la cite pas — les deux captures le
montrent. Le rendu déduisait le guillemet du `keyType`, ce qui ne peut
pas distinguer deux tables dont la clé est du même type ; `quotedKey` est
donc une propriété **de la table**, déclarée là où la différence existe.

**`RouteTable.protocolOf` ne connaissait pas `bgp:`**, si bien qu'une
route apprise par BGP se rendait `S` (statique) — le code de protocole
est ce qui distingue « quelqu'un me l'a annoncée » de « je l'ai tapée ».

**Deux extractions plutôt qu'un seuil relevé** (G1 et G3 ont tiré à 805
et 803 lignes) : `bgpFacts()` descend dans `FirewallBgp.summaryFacts()`
— le service qui détient la donnée — et les trois délégations
`applyRip`/`applyOspf`/`applyBgp` de `Firewall.ts` disparaissent, la
couche vendeur appelant `getRouting()` directement. Piège rencontré en
chemin : mettre `BgpSummaryFacts` dans `diag/getViews.ts` faisait
importer la couche VENDEUR par le socle, ce que G2 interdit ; le type
vit dans `routing/DynamicRoutingTypes.ts`.

**Un cas de sonde corrigé, pas le code** : le refus d'un numéro d'AS hors
bornes tombe sur `set` (validation) et non sur `end` (commit) — l'inverse
du piège de la phase 9b, où le refus tombait au commit. La sortie réelle
est celle de FortiOS, `Command fail. Return code -61` précédé de
`value parse error before '…'`.

Les deux cas de `fortios-routage-dynamique.test.ts` qui affirmaient BGP
refusé sont remplacés par un cas qui l'affirme disponible.

---

## Périmètre pris — FortiOS phase 27 (une politique IPv6 juge)

**Agent `mandeng`.** L'entrée `[politique] le TRANSIT IPv6 est refusé,
faute de politique v6`, que la phase 26 a inscrite comme son propre
reste. La mesure la confirme et trouve **deux défauts que l'entrée ne
nomme pas**.

**Mesure de départ** :

```
config firewall address6   → unknown configuration path
config firewall addrgrp6   → unknown configuration path
config firewall policy6    → unknown configuration path
```

Aucune des trois tables n'existe. S'y ajoutent :

- **`AddressObject.family` est écrit et LU PAR PERSONNE.** Le champ
  existe (`'ipv4' | 'ipv6'`), chaque constructeur d'objet adresse le
  remplit — et `grep '\.family\b'` hors de son propre fichier ne rend
  RIEN. Le type dit que la famille compte ; le code ne la consulte
  jamais.
- **`addressObjectMatches` ne peut pas correspondre à une adresse v6.**
  Les cinq comparateurs (`sameAddress`, `matchesCareMask`,
  `matchesRange`, `matchesResolved`) passent tous par `tryIpToUint32`,
  une conversion sur 32 bits qui rend `null` pour toute adresse IPv6.
  Un candidat v6 ne peut donc correspondre qu'à `any` — et y correspond,
  puisque `kind === 'any'` sort avant toute vérification de famille.
  C'est le défaut le plus dangereux du lot : une règle écrite `all` →
  `all` en v4 juge aussi du trafic v6 sans que rien ne le dise.
- **`firewall address6` est RÉFÉRENCÉE par une table qui existe** :
  `schema/utm.ts` déclare `reference('address6', …, ['firewall
  address6'])` pour `ssl-exempt`, vers une table jamais déclarée. La
  source de données ne peut donc jamais résoudre.

**Fichiers que la phase 27 prendra** :

```
firewall/model/AddressObject.ts     ← la famille DÉCIDE, les comparateurs v6
firewall/model/ObjectStore.ts       ← la famille du candidat filtre l'objet
firewall/policy/PolicyEvaluator.ts  ← une règle ne juge que sa famille
firewall/l3/FirewallIpv6.ts         ← le verrou de transit consulte la politique
vendors/fortios/schema/firewallObjects.ts ← `address6`, `addrgrp6`
vendors/fortios/schema/firewallPolicy.ts  ← `policy6`
```

**Décision de périmètre** : `policy6` est la table SÉPARÉE de FortiOS
antérieur à 7.0, et c'est elle qui est écrite — pas la politique unifiée
de 7.0+, où une seule table porte les deux familles. Deux raisons, et la
seconde est la vraie : la table séparée est celle que la documentation et
les tutoriels accessibles décrivent avec des exemples complets ; et une
politique unifiée demanderait de rendre CHAQUE règle existante
bi-famille, donc de toucher le chemin v4 qui fonctionne. Ce que le
verrou de la phase 26 devient : refus tant qu'aucune `policy6` ne
permet, au lieu d'un refus inconditionnel.

---

## Périmètre pris — FortiOS phase 26 (le pare-feu parle IPv6)

**Agent `mandeng`.** L'entrée `[execute] ping6 absente, faute d'émetteur
ICMPv6 sur le pare-feu`. Le report est juste sur la cause et **trop
étroit sur l'étendue** : ce n'est pas une commande qui manque, c'est
IPv6 en entier.

**Mesure de départ**, sur une machine neuve :

```
execute ping6 ::1                    → unknown action "ping6"
config system interface / edit port1 / config ipv6
                                     → unknown configuration path "ipv6"
set ip6-address 2001:db8::1/64       → unknown attribute "ip6-address"
config router static6                → unknown configuration path
diagnose ipv6 neighbor-cache list    → unknown command
```

`grep -l IPv6 src/network/devices/firewall/` ne rend que cinq fichiers,
et aucun ne PRODUIT de paquet : `PacketContext` déclare
`FirewallPacket = IPv4Packet | IPv6Packet` et rien ne construit jamais le
second membre de cette union. Le pare-feu n'a ni adresse v6, ni NDP, ni
table de routage v6, ni ICMPv6.

**Ce qu'il ne faut surtout pas faire est écrire un second ICMPv6.**
`router/IPv6DataPlane.ts` (1174 lignes) est un plan de données IPv6
complet — NDP, cache de voisins, annonces de routeur, table de routage,
écho, DHCPv6 — et il est déjà construit sur un **port étroit**,
`IPv6RouterContext` : `getPorts()`, `sendFrame()`, `getCounters()`,
`getBus()`, `getScheduler()`, plus des crochets facultatifs. Il porte
même `sendEchoRequest()`, exactement l'émetteur que le report déclare
manquant. Le pare-feu peut REMPLIR ce port : c'est un `Equipment`, il a
des ports, un bus et un ordonnanceur. Une seule machine à états NDP dans
le dépôt, pas deux.

De même côté rendu : `diag/FirewallPing.ts` a déjà la forme
(`header` / `step` / `statistics`) et le texte de FortiOS ; ping6 rend le
MÊME texte sur une vraie machine (`PING …: 56 data bytes`, `64 bytes
from …: icmp_seq=0 ttl=64 time=…`), donc c'est le constructeur de paquet
qui varie, pas le rendu.

**Fichiers que la phase 26 prendra** :

```
firewall/l3/FirewallIpv6.ts        ← le pare-feu remplit IPv6RouterContext (neuf)
firewall/Firewall.ts               ← héberge le plan de données, aiguille ETHERTYPE_IPV6
firewall/diag/FirewallPing.ts      ← le rendu sert les deux familles
vendors/fortios/schema/system.ts   ← `config ipv6`, `ip6-address`, `ip6-allowaccess`
vendors/fortios/schema/router.ts   ← `config router static6`
vendors/fortios/diag/              ← `diagnose ipv6 address list`, `neighbor-cache list`
vendors/fortios/FortiSocle.ts      ← `execute ping6`, `get router info6 routing-table`
```

**Décision de périmètre, prise et non subie** : le moteur de politiques
est v4 seulement (`SecurityRule` porte des adresses v4, `iprope` compile
du v4). Un paquet IPv6 EN TRANSIT est donc **refusé**, pas relayé —
c'est le refus implicite d'un vrai FortiGate sans politique IPv6, et
c'est la posture que `CLAUDE.md` impose à tout moteur de décision
(« security criteria fail CLOSED »). Héberger le plan de données sans ce
verrou ferait passer du trafic v6 sans qu'aucune politique le juge :
ce serait ouvrir le pare-feu, pas l'améliorer. Ce que la phase livre est
donc IPv6 **pour la machine elle-même** — adresse, voisinage, écho,
routes — et le transit sous politique v6 est le sujet de la phase 27.
### Livré

L'entrée `[execute] ping6` est retirée de `TODO.md`.

**Aucun second ICMPv6 n'a été écrit, et c'est tout le correctif.**
`l3/FirewallIpv6.ts` remplit `IPv6RouterContext` — quatre lignes de
délégation vers `Equipment` (ports, `sendFrame`, bus, ordonnanceur) plus
un `DHCPv6Server` que le pare-feu porte sans encore l'exposer — et le
plan de données du routeur tourne tel quel sur le pare-feu. NDP, cache
de voisins, table de routage v6, écho : une seule machine à états dans
le dépôt. `Firewall.handleFrame` aiguille `ETHERTYPE_IPV6` vers elle,
là où seuls FGCP, ARP et IPv4 étaient reconnus.

`diag/FirewallPing6.ts` reprend la forme de `FirewallPing`
(`header`/`step`/`statistics`) parce qu'un vrai FortiGate rend le MÊME
texte pour les deux familles ; ce qui change est le constructeur de
paquet et l'attente, pas le rendu.

**Le verrou de transit est la décision structurante.** `ipv6FilterPermits`
— le crochet que le plan de données consulte déjà pour les ACL IPv6 d'un
routeur — répond `false` en direction `out`, donc un paquet v6 qu'aucune
politique ne peut juger ne traverse pas. Le même crochet sert, en
direction `in`, à faire de `ip6-allowaccess` une vraie porte : une
requête d'écho adressée à nous sur une interface qui n'autorise pas
`ping` est écartée, et rien d'autre ne l'est — écarter tout ce qui n'est
pas pour nous aurait aussi bloqué les sollicitations de voisin, donc NDP
lui-même.

**Mesure écrite dans la sonde plutôt que masquée** : le PREMIER écho
reste sans réponse. Le voisin doit d'abord résoudre notre adresse de
couche 2 en sens inverse — exactement ce qui fait perdre le premier
paquet d'un ping sur une vraie machine pendant la résolution ARP ou ND.
La sonde mesure donc le FORMAT et l'arrivée des réponses, pas une perte
nulle ; ma première rédaction demandait `0% packet loss` et c'est elle
qui avait tort.

Livrées avec : `config system interface / config ipv6` (`ip6-address`,
`ip6-allowaccess`, `ip6-send-adv`, `ip6-manage-flag`, `ip6-other-flag`),
`config router static6`, `execute ping6`, `diagnose ipv6 address list`,
`diagnose ipv6 neighbor-cache list` et `get router info6 routing-table`.

`fortios-ipv6.test.ts` (12 cas) est discriminé par
`git stash push -- src/network/` : 9 tombent avant correctif, et les 3
qui passent des deux côtés sont nommés dans l'en-tête — les deux témoins
et le cas `ip6-allowaccess`, dont le silence était indiscernable d'une
absence d'ICMPv6. `e2e/fortigate-ipv6.spec.ts` (4 cas) rejoue
l'adressage, la vue, le refus sans route et la route statique dans le
vrai navigateur.

---

## Périmètre pris — FortiOS phase 25 (une zone suit ses MEMBRES)

**Agent `mandeng`.** Les deux entrées `[sdwan]` de `TODO.md`. Les deux
reports sont VRAIS cette fois — c'est la première phase depuis longtemps
où la re-mesure les confirme — mais elle trouve un troisième défaut que
ni l'un ni l'autre ne nomme, et **les trois ont la même cause**.

**Mesure de départ** (laboratoire : trois ports adressés, une zone
`virtual-wan-link`, membres 1 et 2, une route statique par la zone) :

- **Ajouter le membre 3 ne développe rien.** La table de routage porte
  toujours exactement les deux routes des membres 1 et 2. Entrée 2,
  confirmée.
- **`delete 2` sous `config members` ne retire rien** — ni la route du
  membre 2, qui reste dans la table, ni le membre lui-même. **Ce défaut
  n'est dans aucune des deux entrées**, et il est plus grave que celui
  qui l'est : le pare-feu continue d'aiguiller du trafic vers un membre
  que l'opérateur a supprimé.
- **Une politique nommant `port1` n'empêche pas `port1` de devenir
  membre.** Les deux commandes sont acceptées au même instant. Entrée 1,
  confirmée.

**La cause commune** : `SdwanService.apply()` ne fait que `set`. Or
`onCommit` lui passe la configuration COMPLÈTE à chaque commit — la
liste entière des membres, des zones, des contrôles et des services.
Une méthode qui reçoit l'état voulu et se contente d'ajouter n'est pas
une application, c'est une accumulation : ce qui a disparu de la
configuration survit dans la table, et ce qui vient d'y entrer n'est
signalé à personne. `apply` doit RÉCONCILIER, et les routes de zone
doivent être rejouées après elle — le chaînon existe déjà
(`Firewall.installSdwanRoute` est rejoué à chaque transition de santé),
il n'est simplement pas appelé là.

**La protection de l'entrée 1 est un mécanisme général, et c'est une
VRAIE commande** plutôt qu'un échafaudage inventé : un FortiGate répond
« qu'est-ce qui référence cet objet ? » par `diagnose sys cmdb refcnt
show <path.object.mkey>`, et c'est ce compteur qui fait qu'une interface
référencée n'apparaît même pas dans la liste des membres possibles. Le
refus a une transcription attestée, prise sur le cas RÉCIPROQUE (une
interface déjà membre du SD-WAN qu'on tente d'ajouter à
`config system zone`) :

```
(zone_test01) set interface wan1
entry not found in datasource
value parse error before 'wan1'
Command fail. Return code -3
```

FortiOS refuse donc **au niveau de la source de données** : la valeur
n'est pas dans la liste des valeurs possibles, d'où ces deux lignes. Les
deux existent déjà ici (`FORTI_NOT_FOUND`, `FortiMessages.valueError`).

**Fichiers que la phase 25 prendra** :

```
firewall/model/InterfaceReferences.ts  ← qui nomme cette interface (socle, neuf)
firewall/sdwan/SdwanService.ts         ← `apply` réconcilie au lieu d'accumuler
firewall/sdwan/SdwanTable.ts           ← retrait de ce qui a disparu
firewall/Firewall.ts                   ← les routes de zone rejouées au commit
vendors/fortios/schema/sdwan.ts        ← le refus d'un membre référencé
vendors/fortios/diag/                  ← `diagnose sys cmdb refcnt show`
```

**Hors périmètre, et dit plutôt que tu** : le code de retour. La
transcription ci-dessus porte `-3` là où ce module rend `-61` pour tout
refus. Les deux LIGNES de message sont reprises telles quelles ; le code
suit celui du module, faute d'une capture par famille de message qui
permettrait de les apparier un par un. Inscrit dans `TODO.md`.
### Livré

Les deux entrées `[sdwan]` sont retirées de `TODO.md`.

**Une seule cause pour les trois défauts, et le correctif est une seule
phrase** : `SdwanService.apply()` RÉCONCILIE. Zones, membres, contrôles
de santé et services qui ont disparu de la configuration disparaissent
de la table ; ce qui y entre y entre. `Firewall.applySdwan` rejoue
ensuite les routes de zone par `applySdwanStaticRoute`, le chemin qui
sait déjà décider entre une route de zone et une route ordinaire — pas
une seconde écriture de cette décision.

**La protection de l'entrée 1 n'a demandé AUCUN moteur neuf, et c'est le
point important.** Ma première écriture a créé
`firewall/model/InterfaceReferences.ts` : un index de références nourri à
la main par les politiques, les routes, les zones et les membres. Il a
été SUPPRIMÉ avant commit, parce que `vendors/fortios/runtime/
references.ts` existe depuis longtemps, fait la même chose en mieux — il
parcourt l'ARBRE de configuration en lisant les `referenceTo` déclarés
par le schéma, donc il couvre toutes les tables au lieu des quatre que
j'avais énumérées — et rend déjà les deux formes de ligne attestées. Il
n'avait qu'une porte, `diagnose sys checkused`. Il en a deux :
`FortiConfigTree.referenceHolders()` pour le refus, et
`diagnose sys cmdb refcnt show <path.object.attribute> <value>`, la vraie
commande FortiOS, dont les lignes sont attestées :

```
entry used by child table srcintf:name 'X' of table firewall.policy:policyid '6'
entry used by table router.static:seq-num '1'
```

Il n'y a PAS de ligne de total — une référence par ligne, rien du tout
s'il n'y en a aucune. La sonde l'avait supposée et la vérification l'a
démentie ; c'est la seule chose qu'elle a corrigée dans mes suppositions.

Le refus vaut dans les **deux sens** : une interface encore nommée par
une politique, une route statique ou une `config system zone` est refusée
comme membre SD-WAN, et une interface déjà membre est refusée dans une
`config system zone` — la réciproque est celle dont j'ai la
transcription. La table qui commet est exclue de son propre décompte,
sans quoi re-commettre un membre existant le refuserait lui-même.

`fortios-sdwan-membres.test.ts` (13 cas) est discriminé par
`git stash push -- src/network/` : 11 tombent avant correctif, et les 2
qui passent des deux côtés sont nommés dans l'en-tête — deux
`not.toContain` sur une commande qui n'existait pas, donc une absence de
sortie et une sortie vide y sont indiscernables.
`e2e/fortigate-sdwan-membres.spec.ts` (3 cas) rejoue le refus, la vue des
références et le développement de la route dans le vrai navigateur.

---

## Périmètre pris — FortiOS phase 24 (la bannière s'AFFICHE et s'ACCEPTE)

**Agent `mandeng`.** Deux entrées `[durcissement]` de `TODO.md`, et là
encore la re-mesure corrige ce qui était écrit.

**Entrée 1 — « la bannière d'après-connexion ne demande pas d'être
acceptée ».** Le report dit : « la bannière s'affiche, la session s'ouvre
sans rien demander ». **Le défaut est plus large** :
`mgmt/LoginBanners.ts` est écrit par `commitDevice` et **lu par
personne** — `getLoginBanners()` n'a aucun appelant hors de ce point
d'écriture. Ni `pre-login-banner` ni `post-login-banner` ne paraît
JAMAIS, sur aucune porte. Les deux réglages sont donc acceptés, rendus
dans la configuration, et sans effet.

Les deux crochets existent pourtant des deux côtés :
`ISshServerContext.getBanner?()` (que le contexte du pare-feu
n'implémente pas) et `FirewallTelnetServerContext.banner()`, qui rend
`null` en dur.

**Entrée 2 — « `set reuse-password disable` est refusé ».** Le report est
juste sur la cause (aucun historique de secrets) et le tenait pour
rédhibitoire. Il ne l'est pas : le magasin de comptes existe, il lui
manque de garder les N derniers. Les options sont attestées —
`reuse-password` enable|disable, `reuse-password-limit` 0-20,
`min-change-characters` 0-128 — et la politique de mot de passe est DÉJÀ
appliquée pour la longueur et les classes de caractères
(`schema/passwordPolicy.ts`), donc la seule pièce manquante est la
mémoire.

Mesure de départ :

- **Aucune bannière ne paraît**, ni en SSH ni en telnet, quel que soit le
  réglage.
- **`set reuse-password disable`** est refusé en nommant l'absence
  d'historique ; **`min-change-characters`** est accepté et n'est comparé
  à rien.

**Fichiers que la phase 24 prendra** :

```
firewall/identity/PasswordHistory.ts  ← les N derniers secrets (socle, neuf)
firewall/mgmt/LoginBanners.ts         ← l'acceptation en attente
firewall/mgmt/FirewallCliServer.ts    ← les deux portes affichent
firewall/identity/AdminAccounts.ts    ← l'historique au changement
vendors/fortios/schema/passwordPolicy.ts ← réutilisation et écart
vendors/fortios/schema/system.ts      ← `reuse-password` cesse d'être refusé
```

**Hors périmètre, et c'est une décision déjà prise plutôt qu'un oubli** :
la troisième entrée `[durcissement]`, `config system replacemsg` au-delà
du groupe `admin`. Son report tient toujours — les autres groupes
décrivent des pages servies par des fonctions que ce pare-feu n'a pas, et
une table acceptée dont le texte ne s'affiche nulle part serait le décor
que ce dépôt passe son temps à défaire.

### Livré

Les deux entrées `[durcissement]` sont retirées de `TODO.md`.

**La bannière.** `BannerAcceptance` (`mgmt/LoginBanners.ts`) porte
l'acceptation en attente et les deux portes la lisent :
`FirewallSshServerContext.getBanner()` rend la bannière d'avant-connexion
par le mécanisme d'annonce pré-authentification que la pile SSH portait
déjà (RFC 4252 §5.4 — la bannière part après que le nom est offert et
avant que le mot de passe soit demandé, ce qui est exactement l'ordre
d'un vrai FortiGate en CLI), et `FirewallTelnetServerContext.banner()`
cesse de rendre `null`. La bannière d'APRÈS-connexion passe par
`motd()` côté telnet et, côté SSH, par la sortie asynchrone que le
canal poussait déjà pour les traces `debug` — `getMotd()` est déclarée
sur `ISshServerContext`, implémentée par quatre contextes et **lue par
personne**, donc s'appuyer dessus aurait été s'appuyer sur un accesseur
mort.

**Le texte est celui de la vraie machine, pas une invention** : le
FortiGate écrit la bannière puis `(Press 'a' to accept):`, transcription
lue sur `rancid-discuss` (octobre 2018) et confirmée par les rapports
oxidized #2021, netmiko #2775 et paramiko #2034, qui la reconnaissent
tous par cette même chaîne. Tant que la réponse n'est pas donnée,
l'invite du shell EST cette question — donc `FGT #` n'apparaît pas et la
session n'est pas ouverte. **Ce que la documentation Fortinet ne dit
pas**, et c'est écrit ici plutôt que passé sous silence : ce qui se
produit si l'on répond autre chose. La règle retenue est que seule la
lettre `a` accepte et que toute autre réponse FERME la session — c'est la
seule lecture compatible avec « must be accepted before proceeding », et
c'est aussi ce que rapportent les outils d'automatisation, dont les
sauvegardes ÉCHOUENT au lieu de rester en attente.

**L'historique.** `identity/PasswordHistory.ts` garde les secrets par
compte, alimenté par `applyAdminAccount` — donc au point où un mot de
passe est réellement accepté, pas à côté. `ManagementPlane` le détient
comme il détient déjà `secrets`, et `Firewall.getPasswordHistory()` est
la seule porte.

**Deux sémantiques que la première écriture avait fausses, et que la
vérification a corrigées** :

- **`reuse-password-limit` n'est pas une profondeur de mémoire** mais un
  NOMBRE DE REPRISES : « Number of times the password for system
  administrators or local users can be reused (0 - 20, default = 0) »
  (FortiOS 7.6.0, *Customizable password reuse thresholds*). La
  profondeur est un autre réglage, `user-history-password-threshold`
  (3-15, défaut 3) sous `config system global`, qui n'existait pas ici et
  est ajouté ; la limite ne peut pas la dépasser, et `refuseReuseLimit`
  le refuse en le nommant. Écrire la limite comme une profondeur aurait
  donné une machine qui refuse l'inverse de ce qu'on lui demande.
- **`min-change-characters` ne compare pas position par position** mais
  compte les caractères du nouveau mot de passe ABSENTS de l'ancien
  (« Minimum number of unique characters in new password which do not
  exist in old password »). La différence est mesurable et un cas la
  mesure : un mot de passe RETOURNÉ diffère à presque toutes les
  positions et n'apporte aucun caractère neuf — la première écriture
  l'aurait accepté, la vraie machine le refuse.

`fortios-bannieres-et-historique.test.ts` (15 cas) est discriminé par
`git stash push -- src/network/` : 10 tombent avant correctif, et les 5
qui passent des deux côtés sont nommés dans l'en-tête du fichier avec la
raison pour laquelle aucun ne prouve le mécanisme.
`e2e/fortigate-bannieres.spec.ts` (2 cas) rejoue la pose de la bannière
et le refus d'un mot de passe déjà employé dans le vrai navigateur.

---

## Périmètre pris — FortiOS phase 23 (le journal dit D'OÙ, et le tampon ALERTE)

**Agent `mandeng`.** Deux entrées `[journal]` de `TODO.md`, et **les
deux reports sont faux** — chacun pour une raison différente, et c'est
la re-mesure qui l'établit.

**Entrée 1 — « l'origine d'une modification est toujours `jsconsole` ».**
Le report dit : « le shell ne sait pas par quelle porte il est atteint —
`FortiShell` est construit une fois par équipement et les sessions
distantes le partagent ». **C'est faux** :
`FortiGate.createManagementCli(user)` fait `new FortiShell(this)` — un
shell PAR SESSION, depuis la phase 14. Les trois portes (onglet du
terminal, SSH, telnet) portent déjà chacune une `source` (l'adresse du
pair) jusqu'à `createCli`. Il ne manque que de la transmettre et que
`administrativeInterface()` la lise au lieu de rendre `'jsconsole'` en
dur.

Vocabulaire attesté, et rien de plus : la note technique de Fortinet
écrit que le changement fait par la console graphique porte
`ui=jsconsole` et celui fait en SSH `ui=ssh` ; la documentation
d'administration montre la forme parenthésée `jsconsole(2.0.225.112)`.

**Entrée 2 — « le seuil de remplissage du tampon mémoire n'alerte
pas ».** Le report dit qu'écrire trois événements « inventerait deux
identifiants », la référence ne portant qu'un `22023`. **Il cherchait
dans la mauvaise famille.** Les trois existent, en 32xxx :

| Seuil | Identifiant | Symbole |
|---|---|---|
| `full-first-warning-threshold` (75 %) | 32023 | `LOG_ID_MEM_LOG_FIRST_FULL` |
| `full-second-warning-threshold` (90 %) | 32042 | `LOG_ID_MEM_LOG_SECOND_FULL` |
| `full-final-warning-threshold` (95 %) | 32043 | `LOG_ID_MEM_LOG_FINAL_FULL` |

Et `22023` n'est pas « Memory log first full » mais
`LOG_ID_LEAVE_EXTREME_LOW_MEM_MODE` — autre sujet. Le sens de 32023 est
publié : « Memory log full over first warning level ».

Mesure de départ :

- **`administrativeInterface()` rend `'jsconsole'` en dur.** Une
  modification faite en SSH et une faite dans l'onglet donnent la même
  ligne, donc l'audit ne distingue pas les deux.
- **Les trois seuils sont acceptés, rendus, et lus par personne.** Le
  tampon est pourtant borné pour de bon depuis la phase 16 (il compte ses
  octets et réserve sa RAM), donc la matière est là : il manque de
  comparer le remplissage aux seuils et d'émettre.

**Fichiers que la phase 23 prendra** :

```
firewall/logging/LogFullEvent.ts     ← les trois événements (socle, neuf)
firewall/logging/FirewallLogStore.ts ← le franchissement, mesuré
firewall/mgmt/FirewallCliServer.ts   ← la porte descend jusqu'au shell
firewall/mgmt/ManagementWiring.ts    ← idem
firewall/Firewall.ts                 ← `createManagementCli(user, origin)`
vendors/fortios/FortiShell.ts        ← `administrativeInterface()` la lit
vendors/fortios/schema/log.ts        ← les seuils atteignent le magasin
```

**Une décision d'avance, parce qu'elle sera posée de toute façon** : un
franchissement s'annonce UNE FOIS, pas à chaque enregistrement écrit
au-dessus du seuil — sinon le tampon se remplirait de ses propres
alarmes. Le retour sous le seuil réarme.

### E69 — Livré, et ce que la mesure a corrigé

**11 cas, 7 tombent avant correctif.** Les deux entrées `[journal]` sont
fermées.

**La porte descend jusqu'au shell, elle ne s'y devine pas.**
`createCli(user)` devient `createCli(user, origin)`, et chaque porte
écrit ce qu'elle EST : `ssh(<adresse>)` côté SSH, `telnet(<adresse>)`
côté telnet, `jsconsole` par défaut. Rien n'est reconstitué a posteriori,
donc aucune vue ne peut se tromper sur l'origine d'une ligne.

**Le vocabulaire est celui de Fortinet et rien de plus** : la note
technique écrit `jsconsole` pour la console graphique et `ssh` pour une
session SSH ; la forme parenthésée vient de la documentation
d'administration (`jsconsole(2.0.225.112)`).

**Une session relayée par la grappe reporte `jsconsole`, et c'est un
choix, pas un repli.** `execute ha manage` (phase 22) donne une VRAIE
session sur le membre distant : ce membre voit une session locale, comme
un vrai FortiGate. Inventer un mot pour « venu du lien de grappe » aurait
été une valeur que personne n'a jamais vue dans ce champ.

**Le franchissement est calculé APRÈS l'insertion et ne se réentre
pas.** `announceFullness` est gardée par un drapeau, sans quoi l'alarme
qu'elle écrit relancerait le calcul et le tampon se remplirait de ses
propres alarmes. Le retour sous le seuil retire le niveau du jeu
annoncé, donc réarme.

**Le cas qui garde le défaut** : « une modification faite dans l'onglet
porte `ui=jsconsole` » passe des DEUX côtés, et c'est normal — avant,
c'était la seule valeur possible. Ce sont ses voisins, SSH et telnet, qui
prouvent le mécanisme ; lui vérifie que la valeur par défaut n'a pas
bougé.

---

## Périmètre pris — FortiOS phase 22 (le battement de cœur porte une VOIE DE COMMANDE)

**Agent `mandeng`.** Deux entrées `[ha]` de `TODO.md` reportent la même
chose, et c'est le report qui nomme la phase : FGCP n'a ici qu'une
**annonce périodique à sens unique**. Il manque un échange
requête/réponse, et c'est un seul mécanisme qui ferme les deux.

Mesure de départ :

- **`execute ha manage 1 admin` répond `Connecting to <nom> (<série>)…`
  et rend la main.** On ne se retrouve jamais sur l'autre machine : le
  `get system status` suivant répond encore pour le membre local.
- **`execute ha synchronize start` tapé sur un SECONDAIRE n'attire
  rien.** Il appelle `requestSynchronisation()`, qui émet le battement
  du secondaire — c'est-à-dire sa propre configuration, exactement ce
  dont personne n'a besoin. Rien ne change tant que le primaire n'a pas
  émis de lui-même.

**Ce que la documentation de Fortinet ajoute, et qui lie les deux
commandes en un seul geste** : `execute ha synchronize` **se tape depuis
le subordonné**, et on atteint le subordonné par `execute ha manage`.
Les deux ne sont pas deux commandes voisines mais les deux moitiés d'un
seul mode opératoire — `manage`, puis `synchronize start`, puis `exit`.
La même source précise que `manage` demande un mot de passe **évalué
contre le magasin de comptes du membre CIBLE**, ce qui est une propriété
de sécurité vérifiable et pas un détail d'invite.

**Le report disait qu'un registre partagé « contournerait le fil ». Il a
raison, et c'est pour cela que la voie de commande passe SUR le fil** :
même `ETHERTYPE_FGCP`, mêmes interfaces de battement, une requête et une
réponse. Un vrai FortiGate relaie précisément la session CLI par le lien
de grappe ; le modéliser ainsi est fidèle, pas commode.

**Fichiers que la phase 22 prendra** :

```
firewall/ha/HaCommandChannel.ts   ← requête/réponse (socle, neuf)
firewall/ha/HaTypes.ts            ← les deux messages
firewall/ha/HaAgent.ts            ← émission, réception, routage
firewall/Firewall.ts              ← le point d'entrée déjà branché
vendors/fortios/FortiShell.ts     ← `ha manage`, `ha synchronize start`
```

**Hors périmètre, et dit plutôt que tu** : l'entrée `[ha] les adresses
MAC VIRTUELLES du cluster n'existent pas` reste ouverte. Elle touche
`Port` et l'apprentissage MAC de tous les commutateurs du projet — c'est
un changement du matériel simulé, pas du pare-feu, et il n'a rien à voir
avec la voie de commande.

### E68 — Livré, et les deux décisions qui tenaient tout

**13 cas, 6 tombent avant correctif.** Deux messages nouveaux sur
`ETHERTYPE_FGCP` — `fgcp-command-request` et `fgcp-command-reply` — et
les deux entrées `[ha]` visées se ferment ensemble.

**Décision 1 : la voie passe sur le FIL, et l'échange est synchrone
parce que la livraison de trames l'est.** `ask()` diffuse la requête et
relit sa table d'échanges juste après : quand le pair est joignable, sa
réponse y est déjà. Ce n'est pas un raccourci — c'est la propriété que ce
simulateur a partout, et c'est elle qui rend une session CLI distante
possible sans machine à états asynchrone. Le corollaire est ce qui rend
le cas du câble coupé vrai : rien ne revient, `answered` est faux, et la
commande le dit.

**Décision 2 : l'authentification est évaluée chez la CIBLE, et la suite
de la session tient à un JETON.** Une première version envoyait le nom du
compte à chaque ligne et laissait le distant ré-authentifier — sauf qu'il
n'y avait plus de mot de passe à présenter, donc soit on acceptait sans
rien vérifier (une porte ouverte), soit rien ne passait. Le distant
délivre donc un jeton à l'authentification et n'exécute une ligne que
sous ce jeton : c'est ce qu'est une session mandatée, et c'est vérifiable
— le mot de passe du membre LOCAL est refusé, celui du membre cible est
accepté.

**Ce que la documentation de Fortinet a évité de faire inventer** :
`execute ha synchronize` se tape depuis le SUBORDONNÉ. Sans cela on
aurait écrit une commande qui pousse depuis le primaire — utile, et pas
ce que la commande fait. Sur le primaire elle pousse (comportement
conservé), sur un secondaire elle demande au primaire d'émettre.

**Un cas DURCI après discrimination** : « câble coupé, la voie ne répond
plus » passait avec `/fail/`, parce que le mot de passe tapé en clair
était alors une commande inconnue — donc `Command fail`. Vrai pour la
mauvaise raison ; il exige désormais le message exact et vérifie que
l'invite est restée locale.

**Réutilisé plutôt que réécrit** : `createManagementCli(admin)` — le
constructeur de CLI que le serveur SSH emploie déjà — sert la ligne
distante, et `management.login()` l'authentifie, avec `ha-cluster` comme
source. Aucun second chemin d'exécution n'a été écrit.

---

## Périmètre pris — FortiOS phase 21 (un datagramme fragmenté est RECOLLÉ)

**Agent `mandeng`.** L'entrée `[pare-feu] les fragments recus ne sont pas
REASSEMBLES` de `TODO.md` nomme le point, et son **report est à
re-mesurer** : il dit qu'il faut « d'abord décider QUAND » réassembler,
« cette condition n'étant modélisée nulle part ». Deux choses ont changé
depuis qu'il a été écrit — la phase 17 a donné au pare-feu une notion
d'inspection de FLUX, et la documentation de Fortinet, relue, répond
elle-même à la question.

Mesure de départ :

- **Le pare-feu fragmente à la sortie et ne recolle jamais à l'entrée.**
  `Firewall.ts` importe `fragmentIPv4` et lui seul ; `IPv4Reassembler`
  — qui existe dans `core/Ipv4Fragmentation.ts` et que `Router.ts`
  utilise — n'a AUCUN appelant côté pare-feu.
- **Conséquence observable** : les fragments qui suivent le premier ne
  portent pas d'en-tête de couche 4, donc leur clé de flux est bâtie sur
  des ports absents. Un seul datagramme ouvre plusieurs sessions.
- **Conséquence de sécurité, qui est la vraie raison de la phase** : une
  règle qui refuse un port ne peut se prononcer que sur le premier
  fragment. Les suivants ne portent pas ce port et échappent à la règle
  qui les nomme — c'est l'évasion par fragmentation, et un pare-feu qui
  la laisse passer enseigne l'inverse de ce qu'il existe pour montrer.

**Ce que la documentation de Fortinet tranche**, et qui rend le report
caduc : la défragmentation existe « so that policy can be applied to
reassembled packets », le chemin logiciel (processeur) traite TOUS les
fragments par défaut, et le déchargement matériel NP7 — désactivé par
défaut — est une optimisation orthogonale. La réponse à « quand ? » est
donc **avant la recherche de politique, toujours**, ce que fait déjà
`Router.forwardPacket` avec la même brique.

**Deux commandes réelles à servir plutôt qu'à inventer** :

- `config system settings` → `set ip-fragment-mem-thresholds <32-2047>`
  (mégaoctets, défaut 32). Elle doit BORNER quelque chose : au-delà, les
  fragments sont perdus et `ReasmFails` monte.
- `diagnose snmp ip frags` → les compteurs de la MIB IP
  (`ReasmTimeout`, `ReasmReqds`, `ReasmOKs`, `ReasmFails`), qui doivent
  être une MESURE du réassembleur et non un affichage.

**Fichiers que la phase 21 prendra** :

```
firewall/l3/FragmentReassembly.ts   ← la table et sa borne (socle, neuf)
firewall/Firewall.ts                ← le recollage avant la politique
firewall/diag/                      ← les compteurs de la MIB IP
vendors/fortios/schema/system*.ts   ← ip-fragment-mem-thresholds
vendors/fortios/diag/               ← `diagnose snmp ip frags`
```

Rien n'est écrit pour réassembler : `IPv4Reassembler` porte déjà la
fenêtre, le recouvrement et l'expiration. Ce qui est neuf est la BORNE
mémoire, qu'il n'a pas, et le branchement.

### E67 — Livré, et ce que la mesure a corrigé

**13 cas, 10 tombent avant correctif.** Le branchement est une ligne dans
`handleIpv4Frame`, avant `classifyIpv4` : le recollage précède la
recherche de politique parce que seul le premier fragment porte l'en-tête
de couche 4.

**Ce que la discrimination a appris, et qui a corrigé la sonde plutôt que
le produit.** Deux cas écrits comme décisifs — « le datagramme arrive
ENTIER » et « il ouvre UNE session » — **passaient avant le correctif**.
La raison n'était pas prévue : sous une politique PERMISSIVE
(`service "ALL"`), un pare-feu qui ne recolle pas transmet quand même les
trois fragments, et **c'est le serveur qui les recolle**, avec son propre
`IPv4Reassembler`. La délivrance ne dit donc rien du pare-feu. Le cas qui
montre le défaut est celui dont la politique **ne nomme que le port
5000** : les fragments 2 et 3 ne portent pas ce port, sont refusés un par
un, et le datagramme n'arrive jamais. C'est la même leçon qu'à la
phase 20 — l'observable doit être une décision du PARE-FEU, pas ce que
voit le destinataire.

**Trois pièges rencontrés, chacun mesuré :**

1. **DF est posé par défaut sur tout UDP sortant** (`EndHost.ts`, comme
   une pile qui découvre le MTU du chemin), donc le routeur intercalé ne
   fragmentait pas : il rendait un ICMP « Fragmentation Needed » et
   jetait le datagramme. Rien n'arrivait au pare-feu et les compteurs
   restaient à zéro — ce qui ressemblait à un branchement mort. La sonde
   envoie `{ df: false }`, et le comportement observé était juste.
2. **La borne mémoire ne se remplit pas depuis une maquette** : 32 Mo de
   fragments demandent vingt-cinq mille datagrammes. Le cas est donc au
   niveau du module, avec un seuil posé sous le minimum de la CLI, et
   c'est écrit dans le fichier — les bornes 32-2047 appartiennent au
   schéma, que le cas de refus vérifie séparément.
3. **Un jeu incomplet ne se produit pas non plus depuis une maquette** :
   la livraison de trames est synchrone, donc les fragments d'un même
   datagramme traversent dans le même appel, et les deux leviers réels
   qui pourraient en perdre un — perte et corruption de câble — sont
   PROBABILISTES, incapables de désigner lequel. Inventer un levier
   « jette le n-ième fragment » aurait été la porte dérobée refusée à la
   phase 16 ; le cas est au niveau du module, nourri par la VRAIE sortie
   de `fragmentIPv4`.

**Ce qui a été ajouté au socle plutôt que recopié** : `fragmentKey`,
`isIPv4Fragment` et `forget` sont exportés de `core/Ipv4Fragmentation.ts`
et `IPv4Reassembler` les emploie lui-même — la borne mémoire a besoin de
la même clé que la table qu'elle borne, et deux clés finiraient par
désigner deux datagrammes différents.

**Une décision écrite plutôt que subie** : au-dessus du seuil, c'est le
jeu le PLUS ANCIEN qui est perdu. Évincer le plus récent laisserait un
flot de fragments orphelins chasser le jeu légitime en cours
d'assemblage, ce qui ferait de la borne une arme contre le trafic
qu'elle protège.

**Limite mesurée et assumée** : le seuil est déclaré `config system
settings`, donc par VDOM, parce que c'est là que la documentation de
Fortinet le place ; la table, elle, est unique pour l'équipement. Deux
VDOM qui poseraient deux seuils écriraient donc successivement sur la
même borne. Le modéliser par VDOM demanderait une table par contexte,
qui n'apporterait rien tant qu'un laboratoire n'a pas deux VDOM sous
charge de fragments.

---

## Périmètre pris — FortiOS phase 20 (un VIP répartit vers un serveur VIVANT)

**Agent `mandeng`.** §6.4 du carnet et l'entrée `[vip]` de `TODO.md`
nomment le point : le type `server-load-balance` « n'a aucune brique
existante à réutiliser (grappe de serveurs réels + moniteurs de santé) ».
La mesure corrige cette phrase, et c'est ce qui rend la phase possible.

Mesure de départ :

- **`set type server-load-balance` est REFUSÉ** (phase 15b), donc un VIP
  de répartition ne peut pas exister. Le refus était le bon choix tant
  que rien ne pouvait le servir.
- **`config firewall ldb-monitor` n'existe pas** : aucun moniteur de
  santé, donc rien pour distinguer un serveur vivant d'un serveur mort.
- **La grappe de serveurs réels n'existe pas** : `config realservers`
  est inconnu.

**Ce qui a été trouvé et qui change la conclusion du TODO** — trois
briques existent :

1. **Le point d'accroche du DNAT est déjà là.** `FirewallNatEngine`
   choisit l'adresse traduite par `spreadDestination(translation, packet)`
   et **inscrit le choix dans la session** (`translation.translatedDest`).
   Une répartition de charge est donc un `destinationTranslation` dont le
   choix vient d'une grappe au lieu d'une plage — et **la persistance
   d'une session est gratuite**, puisque le retour se dé-traduit déjà
   depuis la session.
2. **Le pare-feu sait déjà sonder.** `FirewallPing` est son ping réel, et
   `TcpStack.connect` ouvre une vraie connexion. Un moniteur `ping` et un
   moniteur `tcp` n'ont rien de neuf à écrire.
3. **`SdwanHealthProbe` existe** — et il est examiné puis ÉCARTÉ : il est
   indexé sur les membres SD-WAN (des interfaces) et rend latence, gigue
   et perte pour les règles SD-WAN. Un moniteur de serveur réel demande
   « ce serveur:port répond-il ? ». Question différente, clé différente.
   Ce qu'il partage — l'écho ICMP — est ce que `FirewallPing` porte déjà.

**Fichiers que la phase 20 prendra** :

```
firewall/nat/RealServerPool.ts     ← la grappe et son choix (socle, neuf)
firewall/health/LdbMonitor.ts      ← les moniteurs (socle, neuf)
firewall/nat/FirewallNatEngine.ts  ← le choix par la grappe
vendors/fortios/schema/firewallNat.ts ← realservers, ldb-monitor
```

**Décisions de découpage, écrites ici pour ne pas être découvertes** :

- **`ldb-method`** : `static`, `round-robin`, `weighted`, `first-alive`
  et `least-session` sont implémentés — chacun se décide avec ce que la
  grappe et la table des sessions savent déjà. **`least-rtt` est REFUSÉ**
  (les trames sont livrées de façon synchrone, sans horloge de fil : il
  n'y a pas de temps d'aller-retour à comparer, et ce simulateur porte
  déjà ce refus ailleurs sous le même motif) et **`http-host` est
  REFUSÉ** (le choix du serveur se fait à la traduction, donc avant que
  la moindre charge utile HTTP soit lue).
- **Types de moniteur** : `ping` et `tcp` sont réels. `http`/`https`,
  `dns` et `passive-sip` seront tranchés en mesurant ce que le pare-feu
  sait composer lui-même — jamais acceptés inertes.

**Critère de sortie** : un vrai client atteint un vrai serveur à travers
un VIP de répartition, deux serveurs se partagent les connexions selon
la méthode réglée, un serveur qui ne répond plus est retiré de la
grappe, et une session déjà ouverte reste sur SON serveur.

**Livrée.** Trois choses méritent d'être gardées :

- **L'entrée `TODO.md` était fausse, et c'est elle qui a rendu la phase
  possible une fois vérifiée.** « Aucune brique existante à réutiliser »
  s'est révélé inexact sur les trois points : le DNAT choisissait déjà
  son adresse en un seul endroit ET inscrivait le choix dans la session
  — donc la persistance d'une session n'a demandé AUCUNE ligne, ce qui
  est le genre de réutilisation qui ne se voit pas dans le diff. La
  leçon : une entrée du registre affirme un manque, et un manque affirmé
  se re-mesure avant d'être cru.
- **L'OBSERVABLE de la sonde était faux sur trois cas**, et c'est la
  leçon de méthode. Le client compose le VIP et voit le VIP, puisque le
  retour est dé-traduit : c'est CORRECT, et cela ne dit rien du serveur
  choisi. Le choix est une décision du pare-feu et se lit dans la
  session qu'il vient d'ouvrir. Un quatrième cas attendait une connexion
  vouée à ne jamais aboutir (grappe entièrement morte) : elle ne se
  résout qu'après le repli RFC 6298, bien au-delà du délai d'un test.
  La livraison des trames étant synchrone ici, le SYN a déjà traversé
  quand la promesse est rendue, donc le cas n'attend plus.
- **`retry` compte de vrais échecs CONSÉCUTIFS.** Une seule passe ne
  déclare rien mort, et c'est voulu : un moniteur qui condamnerait un
  serveur au premier paquet perdu serait inutilisable.

**Refusé plutôt que laissé inerte**, chacun en nommant sa brique :
`least-rtt` (pas d'horloge de fil, donc tous les serveurs répondent en
zéro temps), `http-host` (le serveur est choisi à la traduction, avant
qu'une charge utile HTTP existe), et les moniteurs `http`/`https`/`dns`
— les accepter marquerait chaque serveur vivant sans jamais le lui
demander, ce qui est pire que le refus. `passive-sip` n'a aucun SIP à
observer.

---

## Périmètre pris — FortiOS phase 19 (la configuration garde son HISTORIQUE)

**Agent `mandeng`.** §6.5 du carnet nomme le point : « `execute
backup|restore|revision` (BRD §29.4-29.5) appartient au chapitre
`execute` et n'a pas été pris ». La mesure le réduit et le précise :
`backup` et `restore` EXISTENT depuis E42 et passent par un vrai TFTP.
Ce qui manque est l'**historique**.

Mesure de départ :

- **`execute revision` n'existe pas du tout** — ni `list`, ni `delete`.
  Un vrai FortiGate garde ses configurations précédentes et
  `execute revision list config` les rend avec les colonnes `ID`,
  `TIME`, `ADMIN`, `FIRMWARE VERSION`, `COMMENT`.
- **`execute restore config flash <id>`** — la forme qui rejoue une
  révision, celle que la documentation Fortinet donne pour revenir en
  arrière — est refusée : seul `tftp` est accepté comme destination.
- **`revision-backup-on-logout` n'existe pas** dans le schéma de
  `config system global`, alors que c'est le réglage qui, sur un vrai
  boîtier, CRÉE une révision.
- **Trouvé en mesurant** : `FORTI_CLI_LOGOUT` est produit par `exit` et
  `quit` et **consommé par personne** dans tout le dépôt. Sur une
  session SSH ou telnet, `FirewallCliServer.closesSession` intercepte le
  mot avant que la CLI ne le voie, donc la sentinelle ne sort pas ; il
  reste à établir ce que fait la console.

**Fichiers que la phase 19 prendra** :

```
firewall/config/RevisionStore.ts       ← l'historique (socle, neuf)
vendors/fortios/FortiShell.ts          ← restore depuis flash, révisions
vendors/fortios/FortiSocle.ts          ← le vocabulaire `execute revision`
vendors/fortios/schema/system.ts       ← revision-backup-on-logout
```

**Ce qui existe déjà et ne sera pas réécrit** : `renderWholeConfig` rend
la configuration entière, et le chemin de restauration sait déjà REJOUER
un texte de configuration à travers la vraie CLI — c'est exactement ce
qu'une révision restaurée demande. Rien de neuf n'est écrit pour cela.

**Décision de découpage, écrite ici pour ne pas être découverte** : sur
un vrai FortiGate une révision naît d'une mise à jour de micrologiciel,
d'une sauvegarde automatique à la déconnexion, ou de la sauvegarde par
l'interface web. Ce simulateur n'a ni mise à jour de micrologiciel ni
interface web, donc **le seul déclencheur honnête est la déconnexion
d'un administrateur**, sous `revision-backup-on-logout`. Les autres ne
seront pas inventés.

**Sera fermé au passage** : le point que la phase 18 a laissé en le
disant SÛR — `vdom-mode` est une commande cachée sur un vrai 7.4/7.6 et
figure ici dans `show`, `show full` et la liste du `?`. Il touche le
rendu de `system global`, c'est-à-dire ce qu'une révision capture.

**Critère de sortie** : une déconnexion sous `revision-backup-on-logout`
crée une révision, `execute revision list config` la rend avec ses
colonnes réelles, `execute restore config flash <id>` remet la
configuration d'alors, et `execute revision delete config <id>` la
retire.

**Livrée.** Quatre choses méritent d'être gardées :

- **Rien n'est écrit pour restaurer.** Le chemin de restauration savait
  déjà rejouer un texte de configuration à travers la vraie CLI, et
  `renderWholeConfig` sait rendre la configuration entière : une révision
  EST ce texte, et la restaurer EST ce rejeu. `restoreRevision` tient en
  dix lignes pour cette raison, et c'est le genre de réutilisation qui
  ne se voit pas dans le diff — d'où cette ligne.
- **La déconnexion est branchée aux DEUX endroits** où une session
  d'administration se termine : `FirewallCliServer` pour SSH et telnet,
  `FortiTerminalSession.endExecSession` pour la console. Un historique
  qui ne se remplirait que sur SSH serait exactement la moitié que ce
  module passe son temps à refermer.
- **`vdom-mode` est cachée**, et le socle CLI portait déjà tout ce qu'il
  fallait : `CommandSpec.hidden` et le filtre `forHelp` existent depuis
  la construction du socle. Seul `FortiAttributeSpec.hidden` est ajouté,
  puis propagé aux deux rendus — la configuration et la complétion.
  C'était le point que la phase 18 avait laissé en le disant SÛR.
- **`FORTI_CLI_LOGOUT` est supprimée plutôt que branchée.** La sentinelle
  était produite par `exit` et `quit` et consommée par PERSONNE : au
  niveau le plus haut, `exit` rendait `\0forti-cli-logout` à l'appelant.
  Les deux vrais appelants tranchent eux-mêmes — `closesSession` côté
  SSH/telnet, `isTopLevelExit` côté console — donc la sentinelle ne
  servait à rien et la brancher aurait ajouté un troisième mécanisme
  pour la même décision.

**Une assertion de ma sonde était fausse et c'est ELLE qui a été
corrigée**, pas le produit : `execute restore config tftp` sans serveur
refuse par « a TFTP server address is missing » et non par le nom de
fichier — le serveur est vérifié en premier, ce qui est le bon ordre.

**Ce qui n'est PAS modélisé, et pourquoi ce n'est pas un report** : une
révision naît aussi, sur un vrai FortiGate, d'une mise à jour de
micrologiciel et de la sauvegarde par l'interface web. Ce simulateur n'a
ni l'une ni l'autre, donc ces deux déclencheurs n'ont rien à déclencher.
Les inventer aurait produit des révisions que rien ne cause.

---

## Périmètre pris — FortiOS phase 18 (le pont apprend, VIEILLIT, et se lit)

**Agent `mandeng`.** §6.6 du carnet nomme le point : « l'apprentissage MAC
du mode transparent est une table simple sur le châssis, sans
vieillissement ni STP — `Switch` en a une plus complète, et la partager
serait le prochain pas ».

Mesure de départ, faite en lisant `Firewall.ts` :

- **La table est un `Map<string, string>`** — MAC vers nom de port, rien
  d'autre. Pas d'horodatage, donc **aucun vieillissement** : une entrée
  apprise une fois vit jusqu'à l'extinction de la machine. Sur un vrai
  FortiGate en mode transparent, la durée de vie d'une entrée est de
  **300 secondes** et l'entrée est ensuite réapprise.
- **Aucune vue ne la lit.** `diagnose netlink brctl name host root.b` —
  la commande que tout cours de mode transparent fait taper — n'existe
  pas, et `diagnose netlink brctl list` non plus. Une table
  d'apprentissage qu'on ne peut pas regarder ne sert à rien pour le
  diagnostic, qui est sa seule raison d'être.
- **Elle est unique pour tout le châssis**, alors qu'un vrai FortiGate
  porte une instance de pont **par VDOM** (`root.b`, `<vdom>.b`).
- **Rien ne la purge quand un port tombe**, donc une trame continue de
  viser un port mort.

**Fichiers que la phase 18 prendra** :

```
firewall/l2/BridgeFdb.ts        ← la base d'apprentissage (socle, neuf)
firewall/Firewall.ts            ← apprentissage, consultation, purge
vendors/fortios/diag/…          ← `diagnose netlink brctl`
```

**Réutilisation examinée et ÉCARTÉE, avec sa raison** — c'est la
première règle de `CLAUDE.md` et elle demande d'écrire pourquoi quand on
ne réutilise pas. `Switch.ts` porte bien une table plus complète, mais
la mesure montre que les deux objets ne répondent pas à la même
question : celle du commutateur est indexée par **`vlan:mac`** et
distingue `static` / `dynamic` / `blackhole`, avec la sécurité de port
et le vieillissement accéléré de STP par-dessus (28 points d'appel dans
le fichier). Un pont de mode transparent n'a ici ni VLAN, ni entrée
statique, ni trou noir, ni STP. Partager le stockage forcerait l'un à
porter les notions de l'autre. Ce qu'ils partagent vraiment est la
**règle de vieillissement**, qui tient en trois lignes. La table du
commutateur n'est donc **pas** touchée par cette phase, et l'extraction
d'un primitif commun reste un chantier de `Switch.ts`, pas une tranche
d'une phase FortiGate.

**Décision de découpage** : l'expiration est calculée à la LECTURE, pas
par un minuteur — le garde-fou G5 interdit les minuteurs bruts, et le
pare-feu porte déjà son horloge. C'est la même mécanique que la posture
du mode conserve en phase 16 : piloté par l'événement et par la lecture,
jamais par la scrutation.

**Critère de sortie** : une entrée apprise expire au bout de 300
secondes d'horloge de l'équipement, `diagnose netlink brctl name host
root.b` rend le tableau avec ses colonnes réelles, chaque VDOM a son
pont, et un port qui tombe perd ses entrées.

**Livrée.** Les quatre défauts sont fermés et le périmètre annoncé n'a
pas bougé. Trois choses méritent d'être gardées :

- **Le refus de partager la table de `Switch.ts` est la décision de
  cette phase**, et elle va contre ce que le carnet suggérait. La
  mesure la tranche : 28 points d'appel, une clé `vlan:mac`, des
  entrées statiques et des trous noirs, la sécurité de port et le
  vieillissement accéléré de STP. Un pont de mode transparent n'a ici
  aucune de ces notions. Ce qu'ils partagent vraiment tient en trois
  lignes — l'âge depuis la dernière trame vue —, et forcer un stockage
  commun ferait porter à l'un les notions de l'autre. La règle de
  `CLAUDE.md` prévoit ce cas et demande d'écrire ce qu'on a regardé et
  pourquoi cela ne pouvait pas servir : c'est fait, ici et dans le
  message de commit.
- **Le rendu a fait apparaître une propriété de `FIXED_TABLE`** qu'il
  vaut mieux connaître : une colonne alignée à DROITE ne laisse aucun
  blanc après elle, puisque la largeur porte son propre blanc. La
  première version collait `port no` à `device` et `ttl` à
  `attributes`. L'alignement à gauche est le bon choix pour ce tableau,
  et c'est aussi celui du vrai outil.
- **Deux notes du carnet ont été corrigées en passant** : celle qui
  disait `config system admin` sans schéma était périmée (il existe
  depuis la phase 7 et la phase 14 l'a branché sur SSH), et
  `split-vdom` est désormais inscrit dans `TODO.md` avec sa mesure.

**Ce qui n'est PAS fait, et pourquoi ce n'est pas un report déguisé** :
`split-vdom` est accepté et se replie sur `multi-vdom`. Les deux
corrections possibles — lui donner son mécanisme, ou le refuser en
nommant la raison — dépendent de la même question à laquelle je n'ai pas
pu répondre depuis ce réseau : ce mode existe-t-il encore en 7.6 ? Une
source secondaire le dit retiré depuis 7.2.0 et remplacé par un type de
VDOM `Admin` ; la documentation Fortinet décrit encore deux modes de
6.2 à 7.6. Choisir au hasard ferait soit inventer un mécanisme que la
vraie machine n'a plus, soit refuser une commande qu'elle accepte. La
mesure est écrite dans `TODO.md`, y compris un fait sûr et indépendant :
`vdom-mode` est une commande CACHÉE sur un vrai 7.4/7.6, absente de
`show`, de `show full` et de la liste du `?`, alors qu'elle figure dans
les trois ici.

---

## Périmètre pris — FortiOS phase 17 (l'inspection lit un FLUX, pas un segment)

**Agent `mandeng`.** §6.7 du carnet nomme le point de loin : « le
filtrage de fichiers lit le nombre magique en tête de corps, donc ne voit
pas un fichier réparti sur plusieurs segments ». La mesure montre que le
défaut est plus large que le filtrage de fichiers et qu'il n'est pas
cosmétique du tout : c'est une **évasion**.

Mesure de départ, faite en lisant `inspectedFlowOf`
(`pipeline/stages/coreStages.ts`) et `inspection/ContentInspector.ts` :

- **`inspectedFlowOf` construit son `InspectedFlow` à partir de la charge
  utile d'UN paquet.** Il n'existe nulle part de tampon par session.
- **`containsEicar(flow.payload)`** cherche donc la signature dans un
  segment. Une signature coupée en deux par une frontière de segment
  n'est vue par personne — et couper une charge utile en deux est le
  geste le plus simple qui soit.
- **`detectFileType` fait `body.startsWith(magic)`** : le nombre magique
  doit se trouver au tout début du corps DE CE segment. Un fichier dont
  l'en-tête HTTP occupe le premier segment n'est jamais typé.
- **`ProtocolOptions` ne porte aucune borne de mise en tampon** : ni
  `oversize-limit` ni l'option `oversize`, alors que ce sont exactement
  les deux réglages qui, sur un vrai FortiGate, disent jusqu'où on
  bufferise et ce qu'on fait au-delà.

Ce n'est pas une imprécision d'affichage : un contrôle de sécurité qui se
contourne en découpant un envoi est un contrôle qui n'existe pas, et
`CLAUDE.md` porte déjà la règle qui le juge — un critère que le moteur ne
peut pas décider doit faire ÉCHOUER la correspondance, jamais la laisser
passer en silence.

**Fichiers que la phase 17 prendra** :

```
firewall/inspection/StreamAssembler.ts   ← le flux par session (socle, neuf)
firewall/inspection/ContentInspector.ts  ← le type de fichier lu sur le flux
firewall/inspection/UtmProfiles.ts       ← oversize-limit et l'option oversize
firewall/pipeline/stages/coreStages.ts   ← `inspectedFlowOf` lit le flux
vendors/fortios/schema/utm.ts            ← les deux réglages, valeurs réelles
```

**Ce qui existe déjà et ne sera pas réécrit** : `flowKeyFromPacket` donne
une clé DIRECTIONNELLE (source→destination), donc les deux sens d'une
connexion ne se mélangent pas sans qu'on ait rien à inventer ;
`SessionTable` sait dire quand une session se ferme, donc l'éviction a
son crochet ; `ContentInspector` porte déjà toutes les détections.

**Décision de découpage, écrite ici pour ne pas être découverte** : on
réassemble le **TCP seulement**. UDP n'est pas un flux — accumuler deux
datagrammes DNS produirait un message que personne n'a envoyé, et
`parseDnsQuestion` lirait n'importe quoi. La borne est celle du vrai
boîtier : `oversize-limit` en mégaoctets (défaut 10, minimum 1), et
au-delà le comportement documenté — le fichier passe SANS être analysé,
sauf si `set options oversize` demande de le bloquer. Cette valeur par
défaut est celle de Fortinet et elle est laxiste ; la changer « pour être
plus sûr » ferait mentir le simulateur sur ce que fait la vraie machine.

**Critère de sortie** : une signature EICAR coupée en deux segments est
DÉTECTÉE, un fichier dont le nombre magique arrive après la frontière de
segment est TYPÉ, un envoi qui dépasse `oversize-limit` suit le
comportement réglé, et le tampon d'une session disparaît quand la session
se ferme.

**Livrée.** La leçon de ce chantier n'est pas dans le produit, elle est
dans le LABORATOIRE, et elle mérite d'être écrite : **la première version
de la sonde ne prouvait rien**. Montée sur `nginx`, le serveur répondait
`400 Bad Request` et fermait la connexion avant le second `write` — un
seul segment traversait le pare-feu, et le cas central aurait pu passer
comme échouer sans rien dire du réassemblage. Ce n'est pas une erreur
qu'on découvre en relisant : elle s'est vue en imprimant les segments qui
ont RÉELLEMENT traversé, et pas autrement. Le serveur écoute désormais
sans répondre, sur le port 80 parce que c'est celui que
`profile-protocol-options` déclare comme HTTP — sur un autre port le flux
n'est pas classé `http` et le profil antivirus ne s'applique pas, ce qui
est le comportement d'un vrai FortiGate et non un contournement.

**Un cas a été DURCI par la discrimination**, ce qui est le deuxième
enseignement : « le nombre magique arrive après la frontière » passait
des DEUX côtés, parce que le second segment commençait par `%PDF-` et se
typait tout seul. Il coupe désormais AU MILIEU du nombre magique, où
aucun des deux segments ne peut se typer seul. Sans le passage par
`git stash`, ce cas serait resté au fichier en donnant l'illusion de
couvrir le mécanisme.

**Trois décisions, chacune parce que l'inverse était possible** :

- **UDP n'est pas réassemblé.** UDP n'est pas un flux ; coller deux
  datagrammes DNS produirait un message que personne n'a envoyé, et
  `parseDnsQuestion` lirait n'importe quoi.
- **La clé du flux est celle du paquet**, `flowKeyFromPacket`, qui est
  déjà directionnelle. Les deux sens d'une connexion ne se mélangent donc
  pas sans qu'on ait rien eu à inventer, et deux connexions non plus.
- **Le défaut laxiste de Fortinet est gardé.** Au-delà de
  `oversize-limit`, un fichier passe SANS être analysé sauf si
  `set options oversize` demande de le bloquer. Le durcir « pour être
  plus sûr » ferait mentir le simulateur sur ce que fait la vraie
  machine, et un apprenant qui mesure ici et sur un vrai FortiGate doit
  trouver la même chose.

**Ce qui reste de la phase 6 et n'est pas touché ici** : le catalogue de
catégories reste LOCAL, l'antivirus reconnaît EICAR et rien d'autre, et
`scan-archive-contents` ne descend dans aucune archive faute de
décompresseur. Ces trois-là demandent une brique qui n'existe pas ; le
réassemblage, lui, n'en demandait aucune — c'est pourquoi il est fait.

---

## Périmètre pris — FortiOS phase 16 (la charge est mesurée, le mode conserve engage)

**Agent `mandeng`.** §6.5 du carnet nomme le point, et le carnet le dit
déjà dans la langue de ce module : « `get system performance status` ne
rend **ni CPU ni mémoire** : aucun modèle de charge n'existe, et une
constante affichée là où la vue promet une mesure est précisément le
défaut que ce dépôt referme. »

Mesure de départ, faite en lisant les trois vues et leur source unique
`vendors/fortios/diag/systemLoad.ts` :

- **`CPU_STATES` est un objet GELÉ à `idle: 100`** et tout le reste à
  zéro. `get system performance status` et `diagnose sys top` le
  rendent tous les deux : un pare-feu qui vient d'acheminer cent mille
  paquets annonce cent pour cent d'inactivité.
- **`memoryStates()` rend `usedKib: 0`**, donc `freeKib = totalKib`. Un
  équipement dont la mémoire utilisée est nulle n'a pas démarré. La
  conséquence dépasse l'affichage : `conserveModeLines()` calcule
  `memory conserve mode: on|off` à partir de cette valeur, donc le mode
  conserve est **structurellement impossible** — la vue décrit un
  mécanisme qui ne peut pas se produire.
- **Les seuils sont des constantes que l'opérateur ne peut pas régler** :
  `CONSERVE_THRESHOLDS` est figé à 88/82/78 et
  `memory-use-threshold-extreme|red|green` n'existent pas dans le
  schéma de `config system global`.
- **La table des processus de `diagnose sys top` rend `0.0 0.0`** en dur
  pour chaque processus, colonnes `%CPU` et `%mem` comprises.
- **Les ressources de la machine sont déclarées CINQ fois** : `1985` et
  `1` dans `systemLoad.ts`, et à nouveau en dur dans `FortiShell` pour
  la ligne `VM Resources` de `get system status`. Rien ne les relie, et
  `FirewallProfile` — qui décrit pourtant le châssis (ports, temporisateurs,
  catalogue d'usine) — ne porte ni RAM ni CPU.

**Fichiers que la phase 16 prendra** :

```
firewall/health/SystemLoad.ts            ← le modèle unique (socle, neuf)
firewall/FirewallProfile.ts              ← la RAM et les CPU du châssis
firewall/Firewall.ts                     ← le compteur de travail à l'entrée
vendors/fortios/diag/systemLoad.ts       ← devient un RENDU, plus une source
vendors/fortios/schema/system.ts         ← memory-use-threshold-*
```

**Ce qui existe déjà et ne sera pas réécrit** : `SessionTable.statistics()`
compte les sessions actives, créées et fermées ; `PolicyStore`,
`ObjectStore`, `RouteTable`, `ArpService` et le tampon de journaux
comptent chacun ce qu'ils portent ; `SystemClock` donne l'horloge.
`MemoryProfile` (`devices/host/hardware/`) est le modèle mémoire du
projet — il est lu ici pour ce qu'il sait faire (réserver et rendre) et
n'est pas dupliqué.

**Décision de découpage, écrite ici pour ne pas être découverte** : la
charge est DÉRIVÉE de ce que l'équipement porte et fait vraiment — le
nombre de sessions, d'objets, de politiques, de routes, d'entrées de
journal, et les paquets traités dans la dernière fenêtre — jamais d'un
tirage aléatoire ni d'une constante décorative. Ce qui n'a pas de source
mesurable reste à ZÉRO et est dit tel quel : `nice`, `iowait`, `irq` ne
correspondent à rien qu'on mesure, et les inventer serait exactement le
défaut qu'on referme.

**Critère de sortie** : remplir la table des sessions fait MONTER la
mémoire utilisée, le mode conserve s'active pour de bon au seuil rouge
et se relâche au seuil vert, un paquet arrivant en mode conserve extrême
est vraiment refusé, l'événement est journalisé, et les trois vues
lisent le même modèle.

**Livrée.** Le périmètre annoncé a été ÉLARGI par la vérification contre
la documentation Fortinet, qui a trouvé trois choses que la mesure de
départ n'avait pas vues :

- **Les seuils étaient FAUX**, pas seulement non réglables : le dépôt
  portait 88/82/78 là où un vrai FortiGate donne extrême 95, rouge 88,
  vert 82 (plage 70-97, inchangée de 7.4 à 8.0). Le 88 du dépôt était le
  seuil ROUGE pris pour l'extrême et le 82 le seuil VERT pris pour le
  rouge ; 78 ne figure nulle part.
- **Le seuil extrême se mesure sur `utilisé + libérable`** quand le rouge
  et le vert se mesurent sur l'`utilisé` seul. C'est écrit dans
  l'intitulé même de la vue (`memory used + freeable threshold extreme`),
  que le dépôt rendait déjà sans que rien ne l'applique.
- **`Current sessions:`, `Total sessions created:` et
  `Total sessions closed:` n'existent pas** dans cette commande sur un
  vrai boîtier — trois lignes inventées — pendant qu'il lui manquait
  `Average session setup rate:`, qu'elle a.

**Deux erreurs de MON premier modèle**, trouvées en lisant la sortie
rendue plutôt qu'en la supposant juste, et corrigées :

1. `utilisé + libre + libérable = total`. Ce sont TROIS catégories
   disjointes et non deux dont l'une contiendrait l'autre — la capture
   d'un vrai boîtier tranche : 68,6 + 18,8 + 12,6 = 100. Ma première
   version comptait le tampon de journaux DEUX fois.
2. Le tampon de journaux n'est pas réclamable : le libérer perdrait les
   journaux, donc il est UTILISÉ en entier, réserve comprise. Une fois
   réservé, le remplir ne change plus rien.

**Le levier de pression mémoire de la sonde est une vraie commande
d'opérateur** — `config log memory global-setting` / `set max-size` — et
non une porte dérobée. Sur un vrai FortiGate ce tampon est de la RAM
réservée et le sur-dimensionner est une cause documentée de mode
conserve. Aucune méthode de test n'est ajoutée à l'équipement ; la
première version de la sonde en ouvrait une (`setMemoryPressureForTest`)
et a été réécrite avant d'être exécutée une seule fois.

**Le mode conserve a deux conséquences, de polarités OPPOSÉES**, et c'est
le fait le moins intuitif de ce chantier : l'inspection MANDATAIRE échoue
OUVERTE par défaut (`av-failopen pass` — le trafic passe sans être
inspecté), l'inspection de FLUX échoue FERMÉE par défaut
(`ips global fail-open disable` — le trafic est jeté). Les deux valeurs
par défaut sont réelles. `one-shot` reste collé après la sortie du mode
conserve, ce qui est sa raison d'être.

Trouvé en chemin et corrigé dans le fichier qu'on touchait : `renderTable`
ne savait pas rendre un tableau SANS intitulé de colonne, alors que les
deux vues de ce chantier en sont. `TableStyle.header` le permet, et les
deux passent par le module commun au lieu de caler leurs blancs à la
main.

Ce qui n'a **pas** de source mesurable reste à ZÉRO et est dit dans le
fichier : `nice`, `iowait`, `irq`. De même le %CPU par processus n'est
attribué qu'aux processus d'inspection — le travail du noyau n'appartient
à aucun processus utilisateur, ce que la documentation Fortinet dit
elle-même de la colonne mémoire de `diagnose sys top`.

**Rien n'est laissé ouvert.** Il n'y a pas de minuteur de surveillance
(G5 l'interdit) et il n'en faut pas : `memory()` règle la posture à
chaque LECTURE, et chaque mutation qui déplace vraiment la mémoire
(réserve de journaux, compte de sessions, changement de seuil) la
rappelle. Un mécanisme piloté par l'événement plutôt que par la scrutation.

---

## Périmètre pris — FortiOS phase 15 (le type du VIP gouverne, un bloc expire)

**Agent `mandeng`.** §6.4 du carnet nomme les deux points, et ce sont les
deux mêmes familles que ce module referme depuis quatorze phases.

Mesure de départ :

- **`config firewall vip` : `set type` est accepté, rendu par `show`, et
  commis à personne dès qu'il vaut autre chose que `static-nat`.**
  L'`onCommit` commence littéralement par
  `if (object.effective('type')[0] !== 'static-nat') return;` — donc un
  VIP `fqdn` ou `dns-translation` existe dans la configuration, se
  relit, et ne traduit rien. Il manque aussi `mapped-addr`, l'attribut
  que la documentation Fortinet donne comme LE mappage du type `fqdn`.
- **`pba-timeout` est stocké et ne périme rien** : `nat/IpPool.ts` n'a
  pas d'horloge, alors que le pare-feu en porte une (`services.now`).

**Fichiers que la phase 15 prendra** :

```
vendors/fortios/schema/firewallNat.ts   ← mapped-addr, le commit par type
firewall/nat/VipTable.ts                ← le VIP résolu à la traduction
firewall/nat/IpPool.ts                  ← l'horloge et l'expiration des blocs
```

**Ce qui existe déjà et ne sera pas réécrit** : `AddressObject` porte
`kind: 'fqdn'` et sa résolution, `VipTable` porte la traduction
statique, `IpPool` porte l'allocation par blocs.

**Décision de découpage, écrite ici pour ne pas être découverte** :
`dns-translation` est un VRAI relais applicatif DNS (il observe les
réponses qui traversent, réécrit un enregistrement A et retient le
mappage avec un TTL). La brique existe — `decodeDnsMessage` est déjà
utilisé par l'inspecteur du pare-feu — mais c'est un sujet à lui seul,
et il fera la phase 16. **En attendant il est REFUSÉ** par
`unimplementedValues` en nommant la brique manquante, comme
`two-factor` : il n'existe à aucun moment un mot-clé accepté et inerte.

**Critère de sortie** : un VIP `fqdn` traduit vraiment vers l'adresse que
l'objet FQDN résout, un bloc de ports rendu redevient disponible après
`pba-timeout`, et `dns-translation` est refusé avec sa raison.

**Livrée**, en deux temps (15a `pba-timeout`, 15b le type du VIP), et le
périmètre annoncé ci-dessus a été **réduit par la synchronisation** : la
branche portait déjà `FirewallDnsClient`, `config system dns` commis et
`resolveFqdn` câblé sur le magasin d'objets. La première version de ce
travail écrivait un client DNS et une pile UDP pour le pare-feu — un
DOUBLON — et a été supprimée avant tout commit. Ce qui restait, et qui
est fait, est le type du VIP lui-même.

Deux découvertes en chemin, chacune dans le fichier qu'on touchait :

- **`overloadMappings` fuyait ET était inerte** : inséré sous
  `pool|source:PORT SOURCE`, supprimé sous `pool|source:PORT ALLOUÉ`. La
  table ne pouvait donc jamais perdre une entrée, et personne ne la
  relisait — un même flux se voyait attribuer un nouveau port public à
  chaque appel. Une PAT qui n'est pas stable pour un flux est une PAT
  dont la réponse ne revient pas.
- **`pba-timeout` mesure une INACTIVITÉ**, pas un bail à durée fixe (la
  documentation Fortinet le dit ainsi). Les deux lectures s'écrivaient
  aussi naturellement ; un cas de la sonde éprouve explicitement que
  l'usage repousse l'échéance.

**Refusé plutôt que laissé inerte** : `dns-translation`, avec la brique
nommée (un relais applicatif DNS sur le chemin de transit) et l'entrée
correspondante dans `TODO.md`.

---

## Périmètre pris — FortiOS phase 14 (le plan de gestion a une porte)

**Agent `mandeng`.** §6.8 du carnet nomme le point : « l'authentification
d'un compte administrateur à l'ouverture de session **n'est pas branchée
sur une vraie connexion SSH** au pare-feu — le pare-feu n'a pas encore de
serveur SSH ». Les « prochaines étapes » de ce journal le nomment aussi,
depuis la phase 3 : « démon SSH sur le pare-feu, la CLI est là, il lui
manque le transport (E27) ».

Mesure de départ, et elle est plus large que le point annoncé :

- `set allowaccess ssh|telnet|http|https|snmp` est **stocké et lu par
  personne**. `Firewall.allowsAccess()` n'a qu'un seul appelant,
  `allowsPing` ; toute connexion TCP vers une adresse du pare-feu est
  livrée localement sans qu'aucune de ces valeurs soit consultée. Le
  seul autre lecteur du dépôt est un test qui interroge le magasin.
- `admin-ssh-port`, `admin-telnet-port`, `admin-port`, `admin-sport`,
  `admin-lockout-threshold`, `admin-lockout-duration` et `admintimeout`
  sont déclarés dans `config system global` et **ne sont passés à
  personne** : l'`onCommit` n'en transmet que quatre autres.

**Fichiers pris** :

```
firewall/mgmt/ManagementAccess.ts      ← nouveau : le tableau service → port
firewall/mgmt/FirewallSshServer.ts     ← nouveau : le démon et son contexte
firewall/Firewall.ts                   ← la porte locale et le montage
firewall/l3/LocalDelivery.ts           ← le filtre par port de destination
vendors/fortios/schema/system.ts       ← les réglages transmis
vendors/fortios/FortiGate.ts           ← la CLI par session
```

**Ce qu'elle touchera du socle SSH** : rien. `SshServerHandler` et
`ISshServerContext` existent et servent déjà quatre familles d'appareils
(Linux, Windows, Cisco, Huawei) ; le pare-feu en devient la cinquième.

**Critère de sortie** : `ssh admin@<pare-feu>` depuis un vrai `LinuxPC`
ouvre une vraie session, les trames sont comptées sur le câble, une
interface sans `allowaccess ssh` refuse, un `trusthost` qui ne couvre pas
la source refuse, et `admin-ssh-port` déplace vraiment la porte.

**Livrée.** Les six points du critère sont tenus, et telnet est monté par
le même chemin avec sa propre invite (`credentialPrompts()`, crochet
optionnel du contexte telnet partagé, donc Cisco et Huawei gardent le
libellé d'IOS). Deux points appris en mesurant :

- **le refus est un rejet SILENCIEUX**, pas un refus — la documentation
  Fortinet décrit le paquet jeté avant que le serveur ne le voie, donc le
  client n'obtient pas même une invite de mot de passe. La sonde l'affirme
  par l'absence d'invite plutôt que par un message ;
- **l'invite de configuration reproduisait le CHEMIN et non le dernier
  mot** — `config system global` rendait `FGT (system global) #` là où une
  vraie machine rend `FGT (global) #`. `FortiNavigator.label()` prenait la
  CLÉ de l'objet, ce qui est juste pour une entrée de table (`edit port1`
  → `(port1)`) et faux pour un objet unique, dont la clé EST le chemin.

**Trouvé en mesurant, annoncé faux, puis corrigé.** Cette entrée disait
d'abord que `EndHost.tcpConnect` rendait une promesse qui ne se résout
JAMAIS quand le SYN est jeté. **La mesure sous horloge virtuelle a
contredit cette affirmation** : elle se résout à ~63 s, le repli RFC 6298
avec `TCP_MAX_RETRANSMITS = 5` — aucun test à horloge réelle ne l'atteint,
et c'est tout.

Le vrai défaut était ailleurs et il était plus large : **un REFUS et un
SILENCE donnaient le même diagnostic**. `connectOutcome` distinguait déjà
`refused` de `timeout` une couche plus bas, et `tcpConnect` rendait un
`null` sans motif, donc `SshSession` appelait les deux
`CONNECTION_REFUSED`. Un pare-feu qui JETTE — ce que fait `allowaccess` —
répondait « Connection refused », c'est-à-dire le diagnostic qui envoie
vérifier un service au lieu d'une règle de filtrage. Corrigé pour les
quatre plateformes (`TcpDialFailure`, `dialTcp`, `CONNECTION_TIMEOUT`,
`TelnetDialect.timedOut`), avec `tcpConnect` réduit à une enveloppe sur
`tcpDial` sur `EndHost` ET `Router`, qui en portaient deux copies
identiques.

**Contrainte retirée dans la même livraison** : la limite de 800 lignes par
fichier (NFR-M3, garde-fous G1 et G3). Le comptage de lignes s'est révélé un
mauvais indicateur de couplage — il imposait des extractions dictées par un
compteur plutôt que par la cohésion. Ce qui gouverne le découpage reste
NFR-M1, NFR-M2, NFR-M4 et NFR-M6, qui parlent tous de dépendances.

---

## Périmètre pris — FortiOS phase 13 (les collecteurs syslog émettent)

**Agent `mandeng`.** §6.5 du carnet nomme le point : « les collecteurs
syslog sont **configurables et n'émettent pas encore** vers un vrai
collecteur — `SyslogAgent` existe sur le socle, le branchement du
formateur FortiOS vers lui reste à faire ». Mesure de départ :
`schema/log.ts` déclare les quatre collecteurs (`syslogd` à `syslogd4`)
avec serveur, port, mode, facilité, format, interface source et filtre —
et leurs `onCommit` sont **vides**, exactement comme l'était celui du
serveur DHCP en E47.

Le laboratoire peut être vrai de bout en bout : `LinuxRsyslogService`
existe et écoute pour de bon (`imudp`), donc un datagramme parti du
pare-feu peut atterrir dans le `/var/log/syslog` d'une vraie machine.

---

### E59 — Le MTU de sortie est respecté, et `set mtu` était rangé par personne

Périmètre : l'entrée jumelle de celle du TTL — « la fragmentation n'existe
pas ». Un datagramme plus grand que le MTU de l'interface de sortie était
relayé tel quel, ni fragmenté ni refusé, donc la découverte de MTU de chemin
ne pouvait pas fonctionner à travers ce pare-feu.

**La mesure a trouvé plus large que l'entrée n'annonçait** : `set mtu` était
un attribut de schéma **stocké, rendu, et lu par personne**. `FortiInterfacePatch`
ne le portait pas, `applyInterface` ne le posait pas, et `L3Interface.mtu`
restait à 1500 quoi que l'opérateur écrive. C'est le défaut que ce dépôt passe
son temps à défaire, sur une commande que le tutoriel emploie.

**`mtu-override` est le critère, et l'ignorer aurait été une infidélité dans
l'autre sens.** Sur un vrai FortiGate, `set mtu` ne fait rien tant que
`set mtu-override enable` n'est pas posé — les deux attributs existaient ici,
tous deux morts. Le patch ne porte le MTU **que** si l'override est actif, et
un cas de témoin le vérifie : `set mtu 600` seul laisse passer 1228 octets.

**Deux moitiés, deux endroits, et l'ordre est celui de Linux.** Le refus
(`DF` posé + trop gros) est une étape de pipeline, `mtu-check`, placée juste
après `ttl-decrement` — c'est l'ordre d'`ip_forward()`, qui vérifie le TTL
puis `ip_exceeds_mtu` avant le crochet FORWARD. La fragmentation elle-même est
au point d'émission (`Firewall.forward`), comme dans `ip_output`, donc elle
vaut aussi pour les paquets que le pare-feu produit lui-même. `mtu-exceeded-df`
redevient un motif de refus **avec un producteur**, comme `ttl-expired` la
veille : les deux motifs que le garde-fou G-P2 avait trouvés orphelins sont
maintenant vivants tous les deux.

**Rien n'est écrit de neuf pour la découpe** : `fragmentIPv4` (RFC 791 §3.2)
est la fonction du socle que `Router.ts` utilise déjà, et `buildICMPError` avec
`ICMP_UNREACH_FRAG_NEEDED` porte le MTU du saut suivant dans le champ prévu
par la RFC 1191. `sendTimeExceeded` et `sendFragmentationNeeded` passent par un
seul `sendIcmpError` — deux émetteurs auraient fini par ne pas sourcer l'erreur
depuis la même interface.

**Ce que la sonde vérifie est le FIL, pas seulement le succès.** Le premier
essai avait un cas « DF absent : le datagramme arrive » qui passait **avant
correctif**, puisqu'un datagramme non contraint arrive de toute façon : il
compte maintenant les trames sorties sur `port3` — une seule quand ça tient,
plusieurs quand il faut découper. Le message rendu au PC est celui du vrai
`ping` : `From 192.168.10.1 icmp_seq=1 Frag needed and DF set (mtu = 600)`.

**Reste ouvert et réécrit dans `TODO.md`** : le sens inverse, le réassemblage.
`IPv4Reassembler` existe dans le socle, donc c'est un branchement — mais un
pare-feu de transit ne réassemble pas par défaut sur un vrai FortiGate (il ne
le fait que sous inspection UTM), et cette condition n'est modélisée nulle
part. La brancher sans la condition serait inventer un comportement.

**Discrimination** (`git stash push -- src/network`) : 3 des 6 cas tombent
avant correctif. Les 3 témoins sont le datagramme qui tient (une seule trame
des deux côtés), `set mtu` sans override (qui ne doit rien changer, et ne
changeait rien non plus avant) et l'envoi sans contrainte.

**Vérifié** : 1825 cas du module pare-feu (92 fichiers). Typecheck inchangé
à 342.

---

### E58 — La table de routage et la table de sessions écoutent la santé SD-WAN

Périmètre : deux entrées ouvertes de `TODO.md` — « la route de la zone ne
SUIT ni la santé ni un changement de membre » et « une session DÉJÀ ouverte
ne change pas de membre ». **Elles nommaient toutes deux le même chaînon
manquant**, et c'est la raison de les prendre ensemble : la mesure de santé
n'avait aucun consommateur en dehors de son propre afficheur.

**Ce qui manquait n'était pas la mesure, c'était l'événement.**
`recordHealth` calculait déjà l'état DÉCLARÉ d'un membre — avec `failtime` et
`recoverytime`, livrés au TP 20 — et le rangeait sans que personne
l'apprenne. Il rend maintenant la TRANSITION (`{check, sequence, alive}`) ou
`null` quand rien ne change, la sonde les collecte, et `SdwanService` les
publie à un observateur. Rendre `null` sur un non-changement est ce qui rend
l'événement utilisable : sans cela, chaque tour de sonde aurait redéveloppé
toutes les routes et fermé les mêmes sessions.

**Deux consommateurs, un seul développement de route.** La route d'une zone
SD-WAN était développée en une route par membre AU MOMENT du commit, dans
`commitDevice` — donc figée. Le développement vit désormais sur l'équipement
(`Firewall.installSdwanRoute`), le commit l'appelle et la transition de santé
le rejoue : **une seule implémentation**, sinon la route posée au commit et
celle reposée après une bascule auraient fini par différer. L'équipement
garde les routes de zone DÉCLARÉES (`sdwanRoutes`), parce qu'on ne peut pas
redévelopper ce qu'on n'a pas gardé — la table de routage ne porte que les
copies développées.

**`update-static-route` est le critère, et il existait sur le vrai produit
sans exister ici.** Actif par défaut, il gouverne le retrait : `set
update-static-route disable` laisse la route en place alors que la sonde
déclare le membre mort, et un cas le vérifie. L'écrire était nécessaire —
retirer la route inconditionnellement aurait été honorer un comportement que
l'opérateur peut désactiver.

**La session fermée plutôt que reroutée.** Un vrai FortiGate réévalue les
sessions affectées ; ici la table de sessions ferme celles dont l'interface
de sortie est celle du membre mort, si bien que le paquet suivant retraverse
le pipeline et se fait aiguiller vers le survivant. Le résultat observable
est le même — le trafic vers LA MÊME adresse repart par l'autre membre — et
le mécanisme est celui que la table sait déjà faire (`clearMatching`), plutôt
qu'une réécriture d'entrée de session qui n'aurait rien de plus.

**Un garde-fou a repris la main en cours de route, et il avait raison** :
ma première version déclarait les faits de route avec le type
`FortiStaticRoute` de la déclinaison FortiOS, ce qui aurait fait importer la
couche vendeur par `Firewall.ts` — G2. `DeclaredStaticRoute` est donc un type
du socle (`l3/RouteTable.ts`), que la déclinaison satisfait par sa forme.
C'est la deuxième fois en deux entrées que ce garde-fou attrape le même
réflexe.

**Corrigé dans ma propre sonde** : `diagnose sys session list` ne nomme pas
les interfaces (il écrit `dev=4->3/3->4`, des index), donc mes assertions sur
`port1` ne prouvaient rien ; elles portent maintenant sur `gwy=`, la
passerelle du membre, qui est ce que la session dit vraiment. Et `Cable` n'a
pas de `reconnect()` — le retour du lien se fait par un `connect()` sur les
deux mêmes ports.

**Reste ouvert et réécrit** : ajouter ou retirer un membre de la zone APRÈS
avoir écrit la route ne redéveloppe rien. Le chaînon existe désormais ; ce
qui manque est l'ordre de commit entre deux tables distinctes, et rejouer
trop tôt développerait une route sur une zone encore vide.

**Discrimination** (`git stash push -- src/network`) : 3 des 7 cas tombent
avant correctif — le retrait de la route, la fermeture de la session, et le
départ par l'autre membre. Les 4 autres sont les témoins : les deux membres
vivants, le retour du membre (qui passait parce que la route n'était jamais
partie), `update-static-route disable` (idem), et la session du membre vivant
qui survit.

**Vérifié** : 1819 cas du module pare-feu (91 fichiers). Typecheck inchangé
à 342.

---

### E57 — Les deux vues OSPF que le tutoriel nomme, au format de leur vrai auteur

Périmètre : l'entrée ouverte « les vues `get router info ospf database` et
`... interface` n'existent pas ». Le pare-feu ne répondait qu'à
`get router info ospf neighbor` ; les deux autres, que le §20.2 nomme dans le
même bloc de vérification, rendaient `unknown configuration path` sur une
machine dont la base contenait au même instant trois LSA.

**La matière était là en entier** — `getLSDB()` porte les LSA par aire et les
externes, `getInterfaces()` porte l'état, le DR, le BDR, le coût et les
temporisateurs. Ce qui manquait était le rendu, et le rendu est la seule
partie qui ne se déduit pas : `get router info ospf …` de FortiOS est la
sortie de **zebra/FRR**, pas celle d'IOS, et les deux diffèrent.

**Le format vient de la source de FRR, pas de ma mémoire.** La documentation
Fortinet et les blogs qui la citent sont hors de portée depuis ce réseau
(le mandataire les refuse), mais `raw.githubusercontent.com` répond : les
chaînes de `ospfd/ospf_vty.c` donnent l'en-tête de chaque section
(`show_database_desc`), la ligne de colonnes (`show_database_header` — dont
le décalage d'un caractère par rapport aux données est REPRODUIT, parce
qu'il est réel), le format de ligne (`%-15pI4` deux fois, puis `%4d
0x%08lx 0x%04x`), la mention `E2 <préfixe> [0x<tag>]` des LSA externes, et
les onze lignes de `show ip ospf interface` avec leur ponctuation exacte —
`MTU mismatch detection: enabled`, `Transmit Delay is 1 sec, State …`,
`Timer intervals configured, Hello 10s, Dead 40s, Wait 40s, Retransmit 5`,
`No Hellos (Passive interface)`, `Neighbor Count is N, Adjacent neighbor
count is M`. Rien n'est inventé, et là où FRR distingue deux phrases
(`OSPF not enabled on this interface` contre `OSPF is enabled, but not
running`) la distinction est gardée.

**Les types de faits vivent dans le SOCLE, pas dans la déclinaison.** La
première version les avait posés à côté du rendu, dans
`vendors/fortios/diag/` — et `FirewallRouting`, qui est du socle, aurait dû
importer la couche vendeur pour les produire. C'est exactement ce que le
garde-fou G2 interdit. `OspfLsaFacts`/`OspfAreaFacts`/`OspfDatabaseFacts`/
`OspfInterfaceFacts` sont donc dans `routing/DynamicRoutingTypes.ts` : le
socle MESURE, la déclinaison MET EN FORME, et la prochaine déclinaison
(zebra chez d'autres, IOS chez Cisco) réutilisera la mesure sans réécrire la
lecture de la base.

**Deux prémisses de ma sonde étaient fausses, et c'est la mesure qui a
tranché** : j'attendais `Internet Address 192.168.100.99/24, Area 0.0.0.0`
alors que FRR intercale `Broadcast 192.168.100.255,` — le produit avait
raison ; et mon laboratoire n'avait ni interface de bouclage ni avance
d'horloge, donc AUCUNE adjacence ne se formait et je lisais une base à un
seul LSA en croyant tester le rendu de deux. Le laboratoire reprend celui du
TP 19, `VirtualTimeScheduler` compris.

`get router info ospf interface <nom>` répond aussi pour une interface qui
ne fait PAS d'OSPF (`OSPF not enabled on this interface`, ce que FRR écrit)
et refuse un nom qui n'existe sur la machine à aucun titre — les deux sont
des réponses différentes et le restent.

**Discrimination** (`git stash push -- src/network`) : 11 des 12 cas tombent
avant correctif ; le douzième est le refus d'un nom d'interface inconnu, qui
passait parce que la commande entière était refusée.

**Vérifié** : 1812 cas du module pare-feu (90 fichiers). Typecheck inchangé
à 342.

---

### E56 — Le verrou porte sur le COMPTE, et un paquet qui traverse perd un saut

Périmètre : deux entrées ouvertes de `TODO.md`, prises pour elles-mêmes.

**① `admin-lockout-threshold` ne comptait rien sur la console.** Le compteur
existait, fonctionnait, et était indexé par **SOURCE** — or une connexion de
console n'a pas d'adresse d'origine, donc la console appelait
`authenticateAdmin` directement et trois mots de passe faux d'affilée ne
verrouillaient rien. Le TP 24 configure précisément ce réglage à son étape 4.

La mesure a montré que la clé était fausse pour tout le monde, pas seulement
pour la console : **un vrai FortiGate verrouille le COMPTE**, ce que la
documentation Fortinet dit explicitement (« the amount of time an
administrator account is locked out »). Le compteur est donc ré-indexé par
nom de compte — SSH et telnet compris —, la console passe par `login()` au
lieu de contourner le compteur, et `refusesSource()` ne consulte plus le
verrou du tout : il ne juge plus que le `trusthost`, ce qui est sa question.
Détail qui n'en est pas un : `onManagementAuthFailure` recevait DÉJÀ le nom
d'utilisateur et le jetait (`(_user, source) => …`) — la donnée était là, la
clé était l'autre.

**Conséquence assumée, parce qu'elle est celle d'une vraie machine** :
verrouiller `admin` depuis l'extérieur le verrouille aussi pour la console
pendant `admin-lockout-duration`. C'est exactement le risque contre lequel
`trusthost` existe, et le tutoriel l'enseigne déjà.

**Corrigé en chemin dans ma propre sonde**, deux fois : `getPrompt()` rend
`FGT-01 # ` même pendant l'invite de connexion (l'invite du flux interactif
est ailleurs), donc l'assertion ne prouvait rien — elle compte maintenant les
`Login incorrect`. Et un seuil de `0` n'existe pas : FortiOS accepte de 1 à
10, le simulateur le refusait déjà, et mon cas « un seuil de zéro ne
verrouille jamais » testait une commande refusée. Il pose maintenant le refus
comme contrat.

**② Un paquet qui TRAVERSE ne perdait pas un saut.** Le pare-feu était
**invisible à un `traceroute`** : mesuré avant tout changement, `traceroute`
depuis le LAN vers la DMZ affichait le serveur au saut 1. Une boucle de
routage passant par lui n'aurait jamais pu se rompre.

Rien n'a été écrit de neuf pour le fermer : `IcmpErrors.ts`
(`buildICMPError`, `mayGenerateICMPError`, les codes RFC 792) est le module
partagé que `Router.ts` et `EndHost.ts` utilisent déjà, et le décrément est
une étape de pipeline (`ttl-decrement`) placée **après la décision de
routage et avant la politique** — l'ordre de `ip_forward()` sous Linux, dont
FortiOS dérive. `ttl-expired` redevient un motif de refus **avec un
producteur**, ce que le garde-fou G-P2 exigeait.

**Ce qui a demandé de la mesure plutôt que du raisonnement** : la première
version décrémentait bien à l'aller et pas au retour. La cause est que
`session-lookup` est un **chemin rapide** qui accepte et saute toutes les
étapes suivantes — comme sur une vraie machine, sauf qu'une vraie machine
décrémente quand même. La règle est donc UNE fonction (`transitTtl`) appelée
par l'étape ET par le chemin rapide, plutôt que deux copies qui finiraient
par ne pas décider pareil.

**Le mode transparent ne décrémente pas**, parce qu'un pare-feu transparent
est un PONT. Et cette condition est écrite **une seule fois**, dans
`transitTtl` : la faire porter aussi par la liste d'étapes du profil aurait
donné deux décideurs pour une même règle, exactement le défaut que ce dépôt
passe son temps à défaire. L'étape figure donc dans tous les pipelines, y
compris transparents, et c'est l'`opmode` qui tranche.

**Reste ouvert et réécrit dans `TODO.md`** : la seconde moitié du même
sujet, la fragmentation. Un datagramme plus grand que le MTU de sortie est
relayé tel quel, ni fragmenté ni refusé par un ICMP Fragmentation Needed.
`Ipv4Fragmentation.ts` existe déjà dans le socle, donc c'est un branchement —
mais il demande un réassembleur et une étape de plus.

Deux entrées de `TODO.md` sont retirées : le verrouillage, et les bannières
de connexion (fermées en E55, l'entrée était restée).

**Discrimination** (`git stash push -- src/network src/terminal`) : 6 des 7
cas du verrouillage et 5 des 7 du TTL tombent avant correctif. Les témoins
qui passent des deux côtés sont le refus d'un seuil de 0 (la commande était
déjà refusée), la réponse du pare-feu à son propre écho, et le mode
transparent — dont l'objet est justement de ne rien changer.

**Vérifié** : 1798 cas du module pare-feu (89 fichiers). Typecheck inchangé
à 342.

---

### E55 — Les deux derniers TP du tutoriel, et le durcissement qui n'existait pas

Périmètre : TP 23 (dépanner trois pannes) et TP 24 (durcir et sauvegarder),
les deux derniers laboratoires du tutoriel FortiGate encore non vérifiés.

**TP 23 se joue en entier sans qu'une ligne de produit change**, et c'est le
résultat le plus utile de la mesure. Les trois pannes — service de politique
qui ne couvre plus le trafic, `set nat disable`, `mappedip` vers une machine
inexistante — se provoquent, se diagnostiquent et se réparent exactement
comme le tutoriel les écrit : le renifleur montre le paquet qui ARRIVE sur
`port2` et ne ressort pas sur `port3`, la trace de flux dit
`Denied by forward policy check (policy 0)` pour la première et
`Allowed by Policy-1` pour la seconde, la table de sessions ne porte aucun
`act=snat` tant que le NAT est coupé, et `execute ping 192.168.20.99` ne
répond pas. Les 15 cas passent avant comme après correctif.

**Ce qui a échoué au premier essai était ma propre lecture.** J'avais écrit
la sonde en relisant la trace par `diagnose debug flow show console`, en la
prenant pour une commande d'AFFICHAGE. Ce n'en est pas une : c'est un
RÉGLAGE (`show console enable|disable`), et la trace se lit en réémettant
`diagnose debug enable`, ce que le TP 9 faisait déjà correctement. Le test
était faux, pas le produit — mais la mesure a trouvé un vrai défaut à côté :

**`diagnose debug flow show` ne lisait PAS l'option qu'on lui nomme.** Le
répartiteur faisait `state.showFunctionName = rest[3] !== 'disable'` sans
jamais regarder `rest[2]`, c'est-à-dire le NOM de l'option. Conséquences
mesurées : `show console enable` allumait les noms de fonction — une option
en activait une autre ; `show console disable` les éteignait ; `show iprope`
faisait de même ; et une option SANS valeur (`show function-name` tout court)
était prise pour un `enable`. Les trois options sont maintenant distinguées :
`function-name` agit comme avant, **`console` tait la trace sans arrêter le
traçage** (ce qu'elle fait sur une vraie machine chargée, où la trace noie la
console — activée par défaut, sans quoi le TP 9 cesserait de fonctionner), et
`iprope` est refusée en nommant ce qui manque plutôt qu'acceptée sans effet
(inscrit dans `TODO.md`). Une valeur absente ou inconnue est refusée.

**TP 24 était, lui, largement intapable.** Trois familles manquaient.

**① La sauvegarde chiffrée ne l'était pas.** `execute backup config tftp
<fichier> <serveur> <mot de passe>` acceptait le mot de passe et le JETAIT :
`const [destination, file, server] = rest.slice(1)` ne lisait pas le
quatrième mot. Les deux fichiers étaient **octet pour octet identiques**, et
`execute restore` sans mot de passe restaurait le prétendu fichier chiffré
sans broncher. L'étape 2 du TP — « Fais l'expérience. C'est ce qui convainc
de toujours chiffrer » — enseignait donc l'inverse de ce qu'elle promet.
Le chiffrement est maintenant réel et sa forme est celle de Fortinet, non une
invention : **AES-256-GCM**, clé dérivée du mot de passe par **un seul tour de
SHA-256** — la faiblesse réelle et documentée de ce format, celle qui rend un
mot de passe court cassable — puis en-tête, vecteur d'initialisation de 12
octets, étiquette GCM de 16 octets, chiffré. Rien n'est écrit de neuf :
`aesGcmEncrypt`/`aesGcmDecrypt` et `sha256` sont ceux du dépôt. **Une seule
divergence, assumée et écrite** : le fichier réel est binaire, le VFS de ce
simulateur ne stocke que de l'UTF-8 (contrainte déjà documentée par
`PRD-OpenSSL` pour `openssl enc`), donc le corps est armuré en base64 sous une
ligne d'en-tête. La restauration DÉTECTE : mot de passe absent, mauvais mot
de passe et octet retourné sont trois refus distincts, et c'est l'étiquette
GCM qui les prononce — un XOR ne l'aurait pas pu.

**Corrigé au passage dans le tutoriel, car sa phrase était fausse** : « tu y
liras `set psksecret`… en clair ». Non — un vrai FortiGate écrit
`set psksecret ENC <base64>`, et ce simulateur le faisait déjà. Le danger
n'est pas que le secret soit en clair, c'est qu'`ENC` soit un encodage
RÉVERSIBLE à clé statique publiée (CVE-2019-6693) : la sonde décode le blob
de la sauvegarde en clair et retrouve la clé partagée, ce qui démontre la
leçon au lieu de l'affirmer.

**② `config system password-policy` n'existait pas** — toute l'étape 3 et le
point ④ du §25.4 étaient injouables. La table est écrite avec ses attributs
réels (`status`, `apply-to`, `minimum-length` 8–128, les quatre minimums de
classes de caractères, `expire-status`/`expire-day`), et surtout **elle
refuse pour de bon** : le refus se produit au moment du `set`, comme sur une
vraie machine, et **nomme la règle non remplie**. `apply-to` décide de la
portée et porte AUSSI sur `psksecret`, ce qui est le seul endroit du pare-feu
où la qualité d'une clé partagée est vérifiée.

Cela a demandé un vrai chaînon : la validation d'un attribut ne voyait que sa
propre valeur, jamais l'état de la machine. `FortiAttributeSpec` gagne
`valueRefusal(value, environment)` et `FortiValidator` reçoit le
`FortiSchemaEnvironment` — qui n'est pas un objet nouveau, c'est le contrat
que `FortiConfigTree` remplit déjà et que `isRouted`/`isStatic` lisent depuis
toujours par `object.setting('system settings', 'opmode')`. Le hook rend la
RAISON plutôt qu'un booléen, parce qu'un refus qui ne dit pas quelle règle a
échoué envoie l'opérateur deviner. `reuse-password` et
`min-change-characters` sont refusés en nommant l'absence d'historique de
mots de passe (`TODO.md`).

**③ La bannière n'existait pas non plus** : `pre-login-banner` et
`post-login-banner` étaient refusés par `config system global`, et
`config system replacemsg` n'existait pas du tout. Les deux moitiés sont
écrites et **restent deux réglages distincts** — le drapeau sans texte
n'affiche rien, le texte sans drapeau non plus, et les deux cas sont épinglés
par test parce que c'est l'erreur la plus fréquente sur cette commande.

Une particularité de FortiOS a dû être modélisée pour cela, et elle n'est pas
cosmétique : **`config system replacemsg admin "pre_admin-disclaimer-text"`
porte la clé sur la ligne `config`**, pas sur un `edit`. Le socle
n'enregistrait que des chemins exacts, donc la forme du tutoriel n'atteignait
même pas le navigateur. `FortiTableSpec.keyOnConfigLine` le déclare, et il
gouverne les TROIS endroits qui doivent s'accorder : la commande enregistrée
(qui prend la clé en argument, donc la complète aussi), la descente du
navigateur, et le RENDU — sans quoi `show` aurait écrit une forme que
l'import d'une topologie n'aurait pas su rejouer. Un cas rejoue le `show`
d'une machine sur une autre et vérifie que la bannière y arrive.

**Discrimination** (`git stash push -- src/network src/terminal`) : 19 des
69 cas tombent avant correctif — 4 sur `tuto-fortigate-tp09` (les options de
`show`), 7 sur `tuto-fortigate-tp24`, 8 sur `fortigate-durcissement`. **Les
15 cas de `tuto-fortigate-tp23` passent des deux côtés**, ce qui est le
constat et non un défaut de la sonde. Nuance dite plutôt que tue : les trois
fichiers NOUVEAUX du produit (`ConfigEncryption`, `LoginBanners`,
`passwordPolicy`) ne sont pas suivis par git, donc le `stash` n'a retiré que
leur BRANCHEMENT — ce qui est la bonne granularité, un module que personne
n'appelle ne fait rien, mais il faut le dire.

**Vérifié** : 1786 cas du module pare-feu (87 fichiers). Typecheck inchangé
à 342.

---

### E54 — Une vue de lecture ne peut plus être écrite, et une l'était

G8 de BRD-Firewall §40.6 — « les vues de lecture n'exposent aucune
mutation », dont la colonne *Vérification* dit **« vérification de type »**
— était le dernier des huit à n'exister nulle part. Il est écrit, sous le
nom **G-P4** pour la même raison de numérotation que les trois précédents.

**Ce qu'il vérifie**, sur toute interface du module dont le nom finit par
`View` : un champ est `readonly` (sans quoi un lecteur le réaffecte) ; une
méthode ne rend pas `void` (une vue répond à une question, elle n'agit
pas) ; et un tableau rendu est `readonly T[]` — sans quoi l'appelant tient
une poignée **vive** sur le tableau du magasin et peut y pousser une entrée
que le magasin n'a jamais acceptée. Le retour arrière depuis chaque `[]`
compte les accolades, pour que `readonly { a: string; b: string }[]` ne
soit pas pris pour un tableau nu à cause du dernier `:` rencontré ; le
témoin oppose cette forme-là à sa jumelle mutable.

**À sa première exécution il a trouvé une porte ouverte**, et une seule :
`FortiObjectView.key` était déclaré `key: string`. Cette vue est le port
étroit remis aux prédicats du schéma — `availableWhen`, `renders`,
`isStaticNat`, une centaine de fonctions dans `schema/` — et n'importe
laquelle pouvait donc écrire `object.key = …`. Ce n'est pas théorique : la
clé est **l'index de la table**. `FortiTable.rename()` la change en
réécrivant du même geste la `Map` et l'ordre de rendu ; une écriture par la
vue n'aurait fait que la moitié, laissant l'objet porter un nom que sa
propre table ne connaît pas — `get` par l'ancien nom rendrait un objet qui
se dit autrement, et `show` écrirait une configuration que `edit` ne sait
pas rejouer. Un mot suffit à fermer : `readonly key: string`. Aucun appel
n'a bougé — une classe dont le champ est mutable satisfait toujours une
interface qui le déclare en lecture seule, et `FortiObject.key` reste
assignable pour `rename()`, qui est le seul à en avoir le droit.

Les autres vues du module passaient déjà : `PolicyStoreView`,
`SessionTableView`, `ModeCfgView`, `MemberView`. `LogViewFilter` et
`HaViewFacts` sont hors périmètre et le garde le voit tout seul — leur nom
ne finit pas par `View`, et le premier est justement un accumulateur que le
parseur remplit. La limite est dite plutôt que tue : **le garde ne voit que
ce qui se nomme `View`** ; une vue de lecture baptisée autrement lui est
invisible.

**Corrigé en passant** : les deux décisions écrites en E53 portaient les
numéros D43 et D44, déjà pris par l'autre session pour tout autre chose
(le TTL de `buildEchoRequest`, le réarmement après cycle d'alimentation).
Elles deviennent **D56** et **D57** ; la règle de ce carnet est prise
après lecture de ce qu'il porte, pas d'après le dernier numéro qu'on se
rappelle avoir écrit.

BRD-Firewall §40.6 est désormais entièrement couvert. Le fichier de
garde-fous passe de 31 à 37 cas. **Vérifié** : 1723 cas du module pare-feu
(84 fichiers). Typecheck inchangé à 342.

---

### E53 — Trois garde-fous que le BRD nommait et qui n'existaient pas

`architecture-guards.test.ts` portait G1, G2, G5 du BRD générique et G6, G7,
G8 du BRD FortiGate. Il manquait trois garde-fous que BRD-Firewall §40.6
nomme depuis le début. Ils sont écrits, chacun avec son **témoin**.

**G-P1 — un profil ne nomme que des étapes qui existent**, et toute étape
écrite est nommée par au moins un profil. Ce garde-fou aurait épargné une
session entière de mise au point : l'étage SD-WAN livré plus tôt ce mois-ci
ne s'exécutait pas du tout, parce que son nom manquait dans
`FORTIOS_PIPELINE` — le registre l'avait, le pipeline ne le nommait pas, et
rien ne le disait. Vérifié en retirant pour de bon `sdwan` du profil : le
garde l'attrape.

**G-P2 — chaque motif de refus déclaré a un producteur.** À son écriture il
en a trouvé **onze** que personne n'émettait :
`policy-route-deny`, `sequence-out-of-window`, `screen-anomaly`,
`screen-flood`, `screen-recon`, `alg-violation`, `application-shift-deny`,
`ttl-expired`, `mtu-exceeded-df`, `unsupported-protocol`,
`context-not-found`. Aucun n'est produit nulle part **dans tout le dépôt**,
et aucun n'est consommé par un rendu. Ils sont retirés — un motif de refus
qu'aucun chemin n'emprunte est la même chose qu'un attribut stocké et lu
par personne (D7).

**Deux d'entre eux nommaient un vrai manque**, et la connaissance est
inscrite dans `TODO.md` plutôt que perdue avec la déclaration : le pare-feu
ne décrémente **jamais** le TTL d'un paquet qu'il relaie et n'émet aucun
ICMP Time Exceeded, donc il est invisible à un `traceroute` qui le
traverse ; la fragmentation (`mtu-exceeded-df`) est absente pour la même
raison. Fermer demande un plan de données IP complet, que `Router.ts` porte
et que ce pare-feu n'a jamais eu.

**G-P3 — toute commande enregistrée porte une description.** C'est
l'analogue du `cisco-help-every-keyword-described` du dépôt, dont le BRD
disait qu'il « a attrapé quatre nœuds intermédiaires nus ». Rien à
attraper aujourd'hui côté FortiOS ; le garde reste, avec son témoin.

**Numérotation** : `G-P*` et non `G*`, parce que le BRD générique et le BRD
FortiGate donnent tous deux un sens à G6/G7/G8. Reprendre les chiffres
aurait fait croire que ce fichier porte les huit du générique.

`architecture-guards.test.ts` passe de 21 à 31 cas. **Vérifié** : 1650 cas
du module pare-feu (78 fichiers). Typecheck inchangé à 344.

---

### E52c — Une liste de valeurs se complète à chaque valeur

Troisième passage, même périmètre. `set srcaddr NET-LAN ` ne proposait plus
rien — or `set srcaddr "NET-LAN" "NET-DMZ"` est la forme ordinaire, et le
tutoriel l'écrit partout.

**La cause est la forme de la place.** Un attribut multiple reçoit un seul
argument `REST` : le curseur y voit tout ce qui reste de la ligne et compare
donc `NET-LAN ` aux candidats, qui ne commencent pas par là. La porte
FortiOS interroge maintenant le socle sur le SEUL mot en cours.

**Et seulement quand l'attribut accepte vraiment plusieurs valeurs.** Le
premier jet ne posait pas la condition : `set action accept ` reproposait
alors les valeurs de l'énumération, ce qu'un vrai FortiGate ne fait pas.
C'est le cas témoin qui l'a attrapé — il était écrit pour ça.

**Le garde-fou G6 a refusé le premier correctif, et il avait raison.**
J'avais écrit `new Set(['set', 'append', 'select', 'unselect'])` dans le
shell : une seconde liste de verbes, alors que `FortiSocle` les énumère déjà
pour déclarer leurs specs. `VALUE_LIST_VERBS` est exporté et lu par les
deux. Le garde ne visait pas ce cas — il interdit les listes blanches
d'attributs hors du schéma — mais sa règle textuelle a trouvé une vraie
duplication.

`fortigate-cli-resolution.test.ts` passe de 36 à 41 cas ; les 5 nouveaux
sont discriminés sur les seules modifications de ce passage : **4 tombent**,
le cinquième étant le témoin, qui doit passer des deux côtés.

**Vérifié** : 1637 cas du module pare-feu (78 fichiers), 1224 du socle CLI.
Typecheck inchangé à 344.

---

### E52b — La complétion suit les guillemets, et descend le chemin

Second passage sur le même périmètre, mesuré après le premier. Deux
manques, et les deux portent sur ce qu'un opérateur tape le plus souvent.

**Une valeur commencée entre guillemets ne se complétait pas.**
`set srcaddr "N` + Tab ne proposait rien. La cause est simple et se voyait
mal : le guillemet ouvrant fait partie du préfixe comparé, et aucun
candidat ne commence par `"`. Or c'est la forme que le tutoriel écrit
partout (`set srcaddr "NET-LAN"`), et celle que Fortinet emploie dans sa
propre documentation. La complétion travaille désormais sur la valeur nue
et rend les deux guillemets. Un guillemet ouvert qui ne correspond à rien
ne propose toujours rien — la règle vaut dans les deux sens.

**Le chemin d'un `show`/`get` ne se complétait qu'au premier niveau.**
`show system ` ne proposait pas `interface`, et `show firewall address `
aucune clé. C'est la conséquence directe de D32 : les `alternatives` d'un
chemin libre sont une liste STATIQUE, donc les têtes de branche. La
descente est faite dans `FortiShell.completions()` — la porte FortiOS, qui
lit le même arbre — et non dans le socle : un chemin libre reste libre, et
c'est le vendeur qui sait ce qu'il y a dessous.

Les trois derniers cas vérifient tout cela **dans le terminal**, à travers
`FortiTerminalSession` et de vraies touches Tab, et non seulement sur le
shell : c'est là que l'opérateur tape. Ils confirment au passage que le
terminal ajoute l'espace après le mot complété, comme le vrai.

`fortigate-cli-resolution.test.ts` passe de 25 à 36 cas ; les 11 nouveaux
sont discriminés par `git stash push -- src/network/ src/cli/` sur les
seules modifications de ce passage : **7 tombent**, les 4 autres étant déjà
servis par E52 (la valeur nue, la clé entre guillemets, le chemin qui n'est
pas une table, la commande abrégée depuis le terminal).

**Vérifié** : 1632 cas du module pare-feu (78 fichiers), 1224 du socle CLI
(42 fichiers). Typecheck inchangé à 344.

---

### E52 — Une commande s'abrège, `execute` connaît ses mots, `edit` propose ses clés

**Ce qui a été mesuré avant d'écrire** est dans le périmètre pris
ci-dessous. Ce qui a été livré :

**L'abréviation du CHEMIN.** `resolvePathWords` (`view/pathResolution.ts`)
résout mot à mot : correspondance exacte d'abord, préfixe unique ensuite,
ambiguïté nommée sinon, et le mot tel que tapé quand rien ne correspond —
pour que le message d'erreur nomme ce que l'opérateur a écrit. Le
vocabulaire à chaque profondeur est l'union des branches de l'arbre et des
vues déclarées, parce que `get system status` n'est pas un chemin de
l'arbre : sans les vues, `sy stat` ne pouvait pas se résoudre. Mesuré au
passage : l'union produisait `system` deux fois et l'annonçait « ambiguous:
system, system » — les candidats sont dédoublonnés.

**Le vocabulaire d'`execute`.** Neuf sous-commandes déclarées une fois,
lues par la répartition (un `switch` sur le nom résolu), par la complétion
et par l'aide. `execute pin` répondait « is not implemented in this
simulator » ; il répond maintenant que le mot est ambigu entre `ping` et
`ping-options`, ce qui est vrai. `execute zorglub` répond `unknown action`
sans parler du simulateur.

**Un défaut du SOCLE PARTAGÉ, trouvé en cherchant pourquoi `edit ` ne
propose rien.** `argumentCompletableValues` filtrait les valeurs
proposables sur `/^[a-z][a-z0-9:._-]*$/` : une valeur commençant par une
majuscule n'était jamais proposée. Or les clés d'une table FortiOS —
`SRV-WEB`, `NET-LAN`, `GRP-Direction` — en sont presque toujours. Le filtre
visait les PLACEHOLDERS (`WORD`, `A.B.C.D`, `<1-4094>`) et se servait de la
casse comme approximation. Il compare maintenant au placeholder réel de la
place (`argumentPlaceholder(spec)`) et aux formes de placeholder connues.
Conséquence sur les autres constructeurs : ils gagnent la même chose, et
les 1221 cas du socle CLI comme les 181 cas de complétion Cisco/VRP passent
sans changement.

**`edit ?` liste les entrées ET garde la place libre.** `argumentSuggestions`
n'émettait plus le placeholder dès qu'une place portait des `alternatives` ;
une place non-`REST` le rend désormais en tête, comme un vrai `edit ?` qui
montre `<string>` puis les entrées. Les places `REST` (`get`, `show`) ne le
rendent pas : leurs alternatives SONT des formes, et annoncer une forme
libre par-dessus n'apprendrait rien.

**Supprimé** : `FirewallProfile.unimplemented`, déclaré, lu par personne, et
faux — il rangeait `config vpn ipsec` et `diagnose debug flow` parmi les
absents alors que les deux sont livrés depuis les phases 8 et 4.

`fortigate-cli-resolution.test.ts` (25 cas) est discriminé par `git stash
push -- src/network/ src/cli/` : **17 tombent**. Trois d'entre eux sont des
GARDES — toute sous-commande déclarée répond, toute vue déclarée rend
quelque chose, la liste proposée est exactement la liste déclarée — sans
quoi les deux vocabulaires pourraient dériver en silence vers la promesse
fausse que ce périmètre vient de fermer.

**Vérifié** : 1624 cas du module pare-feu (78 fichiers), 1221 du socle CLI
(42 fichiers), 181 des suites de complétion Cisco/VRP. Typecheck inchangé à
344.

---

## Périmètre pris — FortiOS : résolution, suggestions, complétion (2e volet)

**Agent `mandeng` (session tutoriel/TP).** Le premier volet du confort CLI
est livré par l'autre agent (Tab qui défile — D31, `get`/`show` qui
proposent l'arbre — D32, le ping au fil de l'eau — D33). Ce périmètre-ci
ne le recouvre pas : il porte sur ce que la **mesure** trouve encore
manquant en amont de la complétion, c'est-à-dire la RÉSOLUTION d'une
commande abrégée et les propositions qui n'existent pas du tout.

**Mesuré avant d'écrire** (sonde jetable, sur une machine neuve) :

| Saisie | Résultat mesuré |
|---|---|
| `g system status` | ✅ le VERBE s'abrège |
| `get sys status` | ❌ `unknown configuration path "sys status"` |
| `show system glo` | ❌ idem |
| `diag sy session stat` | ✅ (chemin de mots-clés) |
| `execute pin 1.1.1.1` | ❌ **`execute pin` is not implemented in this simulator** |
| `execute ` + Tab | ❌ 4 propositions sur ~15 sous-commandes réelles |
| `edit ` + Tab dans une table peuplée | ❌ aucune proposition |

**Ce que dit Fortinet**, et c'est son propre exemple : « You can
abbreviate words in the command line to their smallest number of
non-ambiguous characters. For example, the command `get system status`
could be abbreviated to `g sy stat`. » Le simulateur abrège le verbe et
pas le chemin.

**Le message de refus d'`execute` est FAUX** et c'est le plus coûteux des
quatre : `execute pin` répond que la commande n'est pas implémentée dans
ce simulateur, alors que `execute ping` l'est. Il envoie chercher une
limite de produit là où il n'y a qu'une abréviation non résolue.

**Cause commune des deux dernières lignes** : `execute` est UNE seule
`CommandSpec` dont l'argument `REST` avale toute la ligne, et le
répartiteur est une chaîne de `if` dans `FortiShell.executeVerb`. Les noms
des sous-commandes ne vivent donc nulle part où la complétion, l'aide ou
la résolution puissent les lire.

**Fichiers pris** :

```
vendors/fortios/FortiSocle.ts        ← alternatives d'`execute` et d'`edit`
vendors/fortios/FortiShell.ts        ← répartition d'`execute`, résolution du chemin
vendors/fortios/execute/…            ← la table déclarative des sous-commandes
```

**Critère de sortie** : `g sy stat`, `exe pin 1.1.1.1`, `execute ` + Tab et
`edit ` + Tab se comportent comme sur une vraie machine, une abréviation
ambiguë est refusée en le disant, et aucun message ne prétend qu'une
commande implémentée ne l'est pas.

---

## Périmètre pris — FortiOS phase 12 (le portail captif capture)

**Agent `mandeng`.** §6.8 du carnet nomme le point : « le portail sert le
formulaire et traite le POST, mais **rien n'INTERCEPTE encore le premier
flux HTTP pour y rediriger** : le laboratoire s'authentifie en appelant
le portail, pas en étant détourné vers lui ». Un portail captif qui ne
capture pas est exactement la famille de défaut que ce module referme —
la fonction a un nom, une configuration et une vue, et le mécanisme
qu'elle promet n'a pas lieu.

S'y ajoute `security-mode captive-portal` sur une interface, l'autre
forme du portail (par interface au lieu de par politique), qui n'a pas de
schéma.

---

## Périmètre pris — FortiOS phase 11 (les points restés ouverts)

**Agent `mandeng`.** `docs/CARNET-FortiGate.md` fait foi pour l'état.
§39 du BRD s'arrête à la phase 10 : ce qui reste n'est pas une phase
suivante mais la liste des points laissés ouverts, et l'instruction est
de les FERMER, pas de les documenter une fois de plus.

**BGP d'abord, parce que le refus était le mien et qu'il reposait sur
une prémisse fausse.** La note de la phase 10 disait « le moteur BGP est
réel, la session TCP ne lui est pas ouverte ». Mesure : le pare-feu porte
un `TcpStack` depuis la phase 7, et j'ai moi-même branché la livraison
locale TCP en phase 8 (`deliverLocally` → `this.tcp.handleIp`).
`BGPEngine.setWire(wire: BgpWire)` est un port étroit d'une seule
méthode, `connect(ip): BgpPeerLink | null`, exactement de la même forme
que `RIPCallbacks`. Il ne manquait donc rien : la troisième fois qu'un
refus de ce module s'appuie sur une case périmée.

**Ensuite les restes de la phase 2** (§6.2 bis du carnet) : `config
system ntp`, `config system dhcp server` côté plan de données, `config
system interface` en `mode dhcp`, `config firewall schedule onetime` et
`schedule group`. Les socles NTP et DHCP existent — l'utilisateur l'a
rappelé — donc le travail est de les brancher, pas de les réécrire.

---

## Périmètre pris — FortiOS phase 10 (routage dynamique)

**Agent `mandeng`.** `docs/CARNET-FortiGate.md` fait foi pour l'état.

**CORRECTION (E45).** Ce paragraphe attribuait à §22.3 du BRD un refus
que §22.3 NE CONTIENT PAS — cette section traite du partage entre VDOM.
Le BRD dit même l'inverse, et le disait déjà : §19.3 classe OSPFv2 « oui,
réel », RIP et BGP « oui », et conclut « Les moteurs existent. Le travail
est de les brancher sur le pare-feu et sur la grammaire CLI de chaque
vendeur, pas de les réécrire. » La leçon n'est donc pas « une case ❌
vieillit » mais **« on vérifie une citation avant de la répéter »** : la
prémisse fausse était la mienne, pas celle du BRD, et elle a voyagé d'une
note de périmètre jusqu'à l'en-tête d'un fichier de test. Ce que la
mesure établit reste vrai et vaut d'être gardé : `OSPFEngine` se construit avec un `processId` et rien
d'autre, et parle au fil par un `setSendCallback` ; `RIPEngine` se
construit avec un identifiant, un nom d'hôte et une interface
`RIPCallbacks` qui EST déjà le port étroit que §22.3 demande d'écrire
(adresse, masque et MAC d'un port, liste des ports, envoi de trame,
table de routage, pose et retrait de route). Les 148 occurrences du mot
« Router » dans `OSPFEngine` sont du vocabulaire du protocole
(`RouterLSA`, `advertisingRouter`, Router ID), pas la classe.

**Ce qui est réellement propre à `Router`, c'est la GLU d'intégration**
(`devices/router/RouterOSPFIntegration.ts`), et un pare-feu n'a pas
besoin qu'on la découple : il a besoin de la sienne. La phase n'est donc
pas un chantier de socle mais une déclinaison de plus, ce qui la rend
beaucoup moins risquée que le BRD ne l'annonçait.

**Prélèvement sur le socle** : `routing/` (nouveau répertoire du module
pare-feu — intégration RIP et OSPF), et le dispatch du protocole 89 et
du port UDP 520 dans le plan de données du pare-feu.

**Fichiers FortiOS pris** : `schema/routerDynamic.ts` (neuf),
`schema/index.ts`, `diag/getViews.ts` (codes de protocole dans
`get router info routing-table all`), `Firewall.ts`.

**Réutilisations imposées, à ne pas réécrire** : `ospf/OSPFEngine.ts`,
`rip/RIPEngine.ts` — les moteurs, tels quels. Écrire un second moteur
donnerait deux réponses possibles à « cette route est-elle apprise ? ».

**Ce que la phase ne prend PAS** : BGP. Son moteur s'appuie sur une
session TCP et sur `AbstractRoutingProtocolEngine` ; c'est une
livraison distincte, et l'annoncer ici sans la mesurer serait refaire
l'erreur que cette entrée corrige. Le refus de §22.3 est donc conservé
POUR BGP SEUL, et sa note est corrigée : elle nommait un couplage qui
n'existe pas.

---

## Périmètre pris — FortiOS phase 9b (haute disponibilité)

**Agent `mandeng`.** `docs/CARNET-FortiGate.md` fait foi pour l'état.

**Prélèvement sur le socle** : `ha/` (nouveau répertoire — `HaAgent`,
table de configuration, élection, empreinte de configuration), et le
transport des battements de cœur sur `hbdev`.

**Fichiers FortiOS pris** : `schema/ha.ts` (neuf), `schema/index.ts`,
`diag/haRenderer.ts` (neuf), `FortiSocle.ts` (chemins `diagnose sys ha`
et `execute ha`), `Firewall.ts`.

**Réutilisations imposées, à ne pas réécrire** : `Port`/`Cable` pour les
trames de battement, `EthernetFrame` avec un `etherType` propre au
protocole, `SessionTable` pour `session-pickup`.

**Décision du BRD §27.3, suivie** : `HaAgent` s'INSPIRE de `VrrpAgent`
sans le réutiliser — les critères de départage sont différents (nombre
d'interfaces surveillées actives d'abord, puis priorité, puis durée de
fonctionnement, puis numéro de série) et forcer la réutilisation
produirait un agent paramétré au point d'être illisible.

**Contrainte P6, non négociable** : la synchronisation TRAVERSE LE FIL.
Débrancher `hbdev` doit produire un cerveau divisé observable ; une
synchronisation en mémoire rendrait ce laboratoire impossible et c'est
le plus instructif du chapitre.

---

## Périmètre pris — FortiOS phase 9a (SD-WAN)

**Agent `mandeng`.** `docs/CARNET-FortiGate.md` fait foi pour l'état.

**Prélèvement sur le socle** : `sdwan/` (nouveau répertoire —
table des membres, sondes de santé, sélection de service), et le
**client d'écho ICMP** que le pare-feu n'a pas (il répond, il n'appelle
pas).

**Fichiers FortiOS pris** : `schema/sdwan.ts` (neuf),
`schema/index.ts`, `commit/sdwanCommits.ts` (neuf),
`diag/sdwanRenderer.ts` (neuf), `Firewall.ts`.

**Réutilisations imposées, à ne pas réécrire** : `Cable.packetLossRate`
(c'est ce qui rend le seuil de perte mesurable), `RouteTable` et le
`policyRouteStage` du pipeline pour la sélection, `events/Scheduler`.

**Ce que la phase ne prend PAS, et pourquoi** : les seuils de **latence**
et de **gigue** sont acceptés et jamais franchis — la livraison de trame
est synchrone, donc le temps d'aller-retour est nul en temps virtuel.
C'est la même limite qu'IP SLA a mesurée et écrite ; la nier ici ferait
diverger deux modules sur le même fait. La HA (`config system ha`) est
une livraison distincte, 9b.

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
