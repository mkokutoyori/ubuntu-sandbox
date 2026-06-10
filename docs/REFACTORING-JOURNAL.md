# Refactoring Journal — Network Protocol Conformance & Architecture

> Journal de bord des défaillances et limites corrigées. Chaque entrée
> correspond à un lot livré (un commit poussé). Les audits initiaux ont
> couvert : protocoles de redondance FHRP (HSRP/VRRP/GLBP), routage
> dynamique (OSPF/BGP/EIGRP/RIP), couche 2 (STP/LACP/CDP/LLDP/VTP/DTP/
> UDLD/IGMP-snooping), et pile cœur (ARP/DHCP/TCP/ICMP/IPv4).

---

## Lot 1 — EIGRP : métrique composite réelle, faisabilité DUAL, variance

**Date :** 2026-06-10

### Défaillances constatées (audit)

1. **Métrique codée en dur à `1`** (`EIGRPEngine.computeRoutes`) : toutes
   les routes EIGRP s'installaient avec la métrique 1, sans rapport avec
   la formule composite de référence (RFC 7868 §5.6.2). `show ip route`
   affichait `[90/1]` au lieu des valeurs réelles (3072, 30720, …).
2. **K-values absents** : pas de coefficients K1–K5, donc pas de
   vérification de compatibilité entre voisins — sur un vrai équipement,
   un désaccord de K bloque l'adjacence (RFC 7868 §5.4).
3. **`variance` et `maximum-paths` inopérants** : les champs existaient
   dans la config mais n'étaient jamais consommés ; la commande CLI
   `variance` n'alimentait que le dépôt de config, jamais le moteur.
4. **Pas de condition de faisabilité DUAL** : la sélection de chemin
   dédupliquait par préfixe (premier vu = installé) au lieu de comparer
   FD/RD.
5. **Routes vers ses propres réseaux connectés** : le moteur installait
   une route EIGRP pour un préfixe déjà connecté localement — un vrai
   IOS n'installe jamais cela (connected AD 0 gagne toujours).
6. **`bandwidth`/`delay` sans effet** : les commandes d'interface
   écrivaient dans le Port mais aucun consommateur n'existait
   (`getDelayUs()` n'était lu nulle part).
7. **`show interfaces` mensonger** : BW/DLY/duplex/MTU/ARP timeout
   étaient déduits du *nom* de l'interface (codés en dur), pas de l'état
   réel du port.

### Corrections livrées

- **`src/network/eigrp/metric.ts`** (nouveau, pur) : métrique composite
  classique 256×(K1·10⁷/BW + K3·delay/10) avec termes K2/K5 complets,
  saturation à l'infini protocolaire, `kValuesMatch()` pour la porte
  d'adjacence. Vérifié contre les valeurs IOS de référence : 2816
  (connecté GigE), 3072 (1 saut GigE), 30720 (chemin FastEthernet).
- **`EIGRPEngine`** : sélection de successeur DUAL par préfixe (tri par
  FD), alternates admis seulement si RD < FD(successeur) **et**
  FD ≤ variance × FD(successeur), plafonné par `maximum-paths` ;
  filtrage des préfixes connectés localement ; porte K-values dans
  `computeNeighbors`. Constante `EIGRP_EXTERNAL_AD = 170` exportée
  (consommée quand la redistribution sera implémentée — lot ultérieur).
- **`Port`** : `getDelayUs()` retourne désormais le défaut IOS dépendant
  de la vitesse négociée (GigE 10 µs, FastE 100 µs, Ether 1000 µs) si
  aucun `delay` explicite ; nouveau `getEffectiveBandwidthKbps()`
  (override `bandwidth` ou vitesse négociée).
- **Seams topologiques** (`ConnectedNetwork`, `RoutingPeer`) : attributs
  optionnels bande passante/délai, peuplés par `RouterDynamicRouting`
  depuis l'état réel des ports — les moteurs restent découplés du
  matériel (DIP préservée).
- **CLI Cisco** : `variance` valide (1–128) et converge le moteur ;
  nouvelle commande `metric weights tos k1 k2 k3 k4 k5` ;
  `maximum-paths` alimente le moteur EIGRP.
- **`show interface`** : BW/DLY/duplex/vitesse/MTU/ARP timeout lus du
  port réel (les commandes `bandwidth`, `delay`, `mtu`, `arp timeout`,
  `duplex` ont enfin un effet observable).

### Tests

- Nouveau `eigrp-metric.test.ts` (valeurs IOS de référence, division par
  zéro, saturation, termes K2/K5, défauts DLY par vitesse).
- `eigrp-engine.test.ts` étendu : métrique réelle 3072, blocage
  K-mismatch, filtrage des préfixes connectés, successeur seul à
  variance 1, partage à coût inégal admis par variance, exclusion des
  chemins infaisables (RD ≥ FD), plafond `maximum-paths`.

### Limites restantes (suivi)

- Redistribution (`redistribute …`) toujours non implémentée dans les
  4 moteurs — config morte ; AD 170 prête côté EIGRP.
- Pas de timers hello/hold EIGRP (5 s/15 s) — l'adjacence est
  recalculée par convergence événementielle, pas par keepalive.
- DUAL multi-sauts non simulé (le moteur n'apprend que les préfixes
  originés par les voisins directs).

---

## Lot 2 — RIP : moteur unique réactif, multicast RIPv2, triggered updates RFC

**Date :** 2026-06-10

### Défaillances constatées (audit)

1. **Moteur RIP dupliqué (~430 lignes)** : `devices/router/RouterRIPEngine.ts`
   était une copie quasi-verbatim de `rip/RIPEngine.ts` *sans*
   l'infrastructure réactive (timers natifs `setTimeout`/`setInterval`
   non injectables, aucun événement de bus, aucun Signal). Le Router de
   production utilisait la copie legacy ; le moteur réactif n'était
   exercé que par un test.
2. **RIPv2 émettait en broadcast** `255.255.255.255` / MAC broadcast au
   lieu du groupe multicast `224.0.0.9` / `01:00:5e:00:00:09`
   (RFC 2453 §4.3). Pire : l'événement `rip.update.sent` publiait
   `destIp: '224.0.0.9'` alors que le paquet réel partait en broadcast.
3. **Triggered updates incomplets** (RFC 2453 §3.10.1) : déclenchés
   uniquement à l'invalidation ; jamais à l'apprentissage d'une route
   ni au changement de métrique ; envoi immédiat sans le délai
   aléatoire 1–5 s anti-tempête ; une rafale de changements produisait
   une rafale de paquets au lieu d'un lot.
4. **Filtre L2 du Router** : seul le multicast IPv6 (`33:33`) était
   accepté — toute trame au MAC multicast IPv4 (`01:00:5e:…`) était
   jetée par le routeur de base (les sous-classes Cisco/Huawei ne la
   rattrapaient que pour leurs propres protocoles FHRP/IGMP/PIM).
5. **Livraison locale L3** : seules l'IP d'interface exacte et
   `255.255.255.255` étaient consommées ; un datagramme multicast
   passait dans le chemin de forwarding.
6. **Hack de constructeur** : `new (Object.getPrototypeOf(x).constructor)`
   pour éviter d'importer `IPAddress`/`SubnetMask`/`MACAddress` — alors
   qu'aucun cycle d'import n'existe.

### Corrections livrées

- **`RouterRIPEngine` réécrit en Adapter mince** (~110 lignes au lieu de
  430) : il câble ports/RIB/bus/scheduler du Router sur **l'unique**
  moteur réactif `rip/RIPEngine`. Une seule source de vérité RFC 2453.
- **`rip/RIPEngine`** : destination v2 = `224.0.0.9` + MAC RFC 1112,
  v1 = broadcast (sélection dynamique via `getRipVersion`) ; version
  reflétée dans les paquets émis ; imports propres ; nouvelle méthode
  `configure()` pour la fusion de config au ré-enable.
- **Triggered updates conformes** : coalescence des routes changées dans
  une fenêtre aléatoire 1–5 s (constantes `RIP_TIMERS.TRIGGERED_*`),
  flush en un lot par interface avec split-horizon/poison-reverse,
  déclenchement sur apprentissage, changement de métrique et
  invalidation ; rafraîchissement sans changement ⇒ aucun trigger.
- **Router (base)** : filtre L2 accepte `01:00:5e:…` ; le contrôle-plane
  consomme localement broadcast **et** multicast IPv4 (jamais forwardés).

### Tests

- 6 nouveaux tests dans `RIP.reactive.test.ts` : adressage multicast v2 /
  broadcast v1, fenêtre 1–5 s (rien avant 1 s, flush à 5 s), coalescence
  d'une rafale en un seul lot, trigger sur changement de métrique,
  absence de trigger sur refresh sans changement.
- Régression complète network-v2 + events : 278 fichiers / 6831 tests OK.

### Limites restantes (suivi)

- Pas d'authentification RIPv2 (MD5/texte, RFC 2453 §4.1).
- La suppression « pas de triggered si update régulier imminent »
  (§3.10.1, optionnelle) n'est pas implémentée.

---

## Lot 3 — BGP : sélection de chemin RFC 4271 §9.1.1

**Date :** 2026-06-10

### Défaillances constatées (audit)

1. **Aucune sélection de chemin** : `computeRoutes` installait le
   *premier* chemin rencontré par préfixe (`Set` de dédup), ignorant
   totalement l'ordre de décision RFC 4271 §9.1.1 (weight, LOCAL_PREF,
   AS_PATH, origin, MED, eBGP/iBGP, router-id). Avec deux pairs
   annonçant le même préfixe, le résultat dépendait de l'ordre
   d'itération de la Map de voisins.
2. **Aucun attribut de chemin** : pas d'AS_PATH (donc pas de
   comparaison de longueur), pas de LOCAL_PREF, pas de weight Cisco,
   pas d'origin, pas de MED, pas de tie-break par router-id.
3. **Routes vers ses propres préfixes connectés** installées (même
   défaut que EIGRP avant le lot 1).
4. **CLI** : `neighbor … weight` et `bgp default local-preference`
   inexistants ou non câblés au moteur.
5. **Conflit de trie CLI découvert au passage** : la boucle "catch-all"
   des options de routage ré-enregistrait `metric` APRÈS le handler
   dédié du lot 1 (le dernier `registerGreedy` gagne dans
   `CommandTrie`), rendant `metric weights` muet. Corrigé en fusionnant
   les sémantiques RIP/EIGRP dans un seul handler et en retirant
   `metric` du catch-all.

### Corrections livrées

- **`src/network/bgp/bestPath.ts`** (nouveau, pur) : comparateur
  RFC 4271 complet — weight → LOCAL_PREF → origination locale →
  longueur d'AS_PATH → origin (IGP<EGP<incomplete) → MED (comparé
  uniquement entre chemins du même AS voisin, §9.1.2.2) → eBGP>iBGP →
  router-id → IP du pair. `selectBestPath` n'installe qu'UN best path
  par préfixe, sans muter l'entrée.
- **`BGPEngine`** : construit de vrais candidats par préfixe —
  AS_PATH `[asn-du-pair]` pour eBGP (le pair prépende son AS,
  §5.1.2), `[]` pour iBGP ; LOCAL_PREF du pair propagé en iBGP
  seulement (§5.1.5, ne traverse pas les frontières d'AS) ; weight par
  voisin ; filtrage des préfixes localement connectés. Config :
  `defaultLocalPref` (défaut 100) et `weight` par voisin.
- **CLI Cisco** : `neighbor <ip> weight <0-65535>` (validé) et
  `bgp default local-preference <n>` alimentent le moteur et
  convergent.

### Tests

- Nouveau `bgp-bestpath.test.ts` : chaque étape de l'ordre de décision
  isolément (poids dominant, LOCAL_PREF, origination locale, AS_PATH,
  origin, MED comparable/non-comparable, eBGP>iBGP, router-id, IP),
  ensemble vide, non-mutation de l'entrée.
- `bgp-engine.test.ts` étendu (double-homing vers le même préfixe) :
  un seul best path installé, weight prioritaire, LOCAL_PREF entre
  pairs iBGP, AS_PATH vide (originé dans l'AS) bat un chemin externe
  plus long — comportement RFC fidèle —, tie-break router-id,
  filtrage des préfixes connectés.

### Limites restantes (suivi)

- Pas de FSM temporisée (keepalive 60 s / hold 180 s, §6.4) : l'état de
  session est recalculé par convergence événementielle. Un vrai FSM
  par messages OPEN/KEEPALIVE serait un chantier dédié.
- MED toujours fixe à 0 (pas de `default-metric`/route-map).
- Multi-saut : AS_PATH limité à un saut (modèle 1-hop du moteur).

---

## Lot 4 — Commutation L2 : adresses de groupe IEEE et IGMP snooping unifié

**Date :** 2026-06-10

### Défaillances constatées (audit)

1. **Détection multicast incomplète dans `Switch.handleFrame`** : seuls
   le broadcast et le multicast IPv6 (`33:33:…`) étaient reconnus. Tout
   MAC multicast IPv4 (`01:00:5e:…`, mapping RFC 1112) ou protocolaire
   (`01:80:c2`, `01:00:0c`) était traité comme *unicast inconnu*. 
   Conséquence directe : le chemin IGMP-snooping
   (`resolveSnoopedMulticastEgressPorts`) n'était **jamais invoqué**
   pour du trafic multicast IPv4 réel — le forwarding contraint
   (RFC 4541 §2.1.2) était mort sur le data-path, le trafic inondait
   tout le VLAN même avec une table snooping correcte.
2. **Pipeline snooping dupliqué verbatim** (~12 lignes × 2) dans
   `CiscoSwitch` et `HuaweiSwitch` — même corps, même logique, deux
   points de maintenance.

### Corrections livrées

- **Détection conforme IEEE 802.3 §3.2.3** : un MAC est une adresse de
  groupe si son bit I/G (LSB du premier octet) est à 1 — couvre
  IPv4 (`01:00:5e`), IPv6 (`33:33`), MACs protocolaires, etc. Les
  trames de groupe ne sont jamais confrontées à la table MAC.
- **Pipeline snooping hoisted dans la base `Switch`** (Template
  Method) : la logique vendeur-neutre (etherType IPv4 → destination
  224/4 → VLAN snooping actif → ports membres/routeur) vit une seule
  fois ; les vendeurs ne fournissent plus que le hook
  `getIgmpSnoopingAgentOrNull()` (1 ligne chacun). Nouvelle interface
  ségrégée `IgmpSnoopingAgentLike` : la base ne voit que les deux
  méthodes dont elle a besoin (ISP).

### Tests

- `igmp-snooping.test.ts` étendu avec 2 tests **data-path** : un groupe
  enregistré n'égresse que vers le port membre (H2 non-membre ne reçoit
  rien), un groupe non enregistré inonde classiquement le VLAN.
  Ces tests échouaient avant le correctif (le multicast IPv4 partait en
  flood inconditionnel).
- Suite network-v2 complète : 6604 tests OK.

### Limites restantes (suivi)

- STP reste 802.1D pur (pas de RSTP 802.1w, TCN non émis) — chantier
  dédié envisagé.
- VTP pruning déclaré mais non appliqué au flooding.
