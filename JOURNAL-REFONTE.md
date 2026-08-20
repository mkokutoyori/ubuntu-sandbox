# Journal de bord — Refonte structurelle du simulateur réseau

Ce journal documente, par incréments, les défaillances et limites corrigées lors
de la refonte progressive du simulateur. Principe directeur retenu :
**toute communication entre deux équipements doit transiter physiquement par les
câbles/connecteurs (Port → Cable → Port), pas par un registre global ni par un
appel direct de méthode sur un autre équipement.**

Chaque incrément est petit, vérifié par les tests, poussé séparément, et consigné
ici (problème → cause → correction → vérification).

---

## Méthodologie & cadrage (audit initial)

Branche de travail : `mandeng` (branche de développement active, 12 commits en
avance sur la branche pré-configurée de l'environnement au démarrage).

Deux audits transverses ont été menés (chemin de transmission des trames ;
réalisme des moteurs de protocoles), puis **systématiquement re-vérifiés contre le
code réel** avant toute correction.

### Constat de cadrage important

Le simulateur est **plus avancé qu'il n'y paraît** et une migration « frame-driven »
est déjà en cours. Plusieurs défauts signalés par l'audit automatique se sont
révélés **déjà corrigés** dans le code actuel :

- **EIGRP** échange déjà de vraies trames IPv4 protocole-88 (multicast 224.0.0.10)
  sur le fil (`RouterDynamicRouting.sendEigrpFrame` → `Port → Cable`).
- **BGP** utilise déjà de vraies sessions **TCP/179** via la pile TCP
  (`RouterDynamicRouting.bgpConnect` / listener passif), sans god-mode.
- **OSPF** : la découverte des voisins, le 2-Way et l'échange DD/LSR/LSU se font
  déjà par de **vraies trames Hello** (`pumpHellos` → `sendHelloOnInterface`) ;
  la synchro LSDB se fait « entirely on the wire ». L'injection synthétique
  `formAdjacency()` ne subsiste que pour les interfaces **virtuelles** (tunnels
  GRE, virtual-links) qui n'ont pas encore de transport de trame.

Conséquence méthodologique : **on ne « corrige » rien sans avoir relu le code
courant** ; on documente ce qui est déjà fait pour éviter les régressions, et on
cible les défaillances réellement présentes.

### Défaillances réelles confirmées (backlog priorisé)

1. **DHCP — découverte god-mode** (`EndHost.autoDiscoverDHCPServers`) : enregistre
   directement les objets serveur en marchant la topologie, **plus un fallback de
   scan global** `Equipment.getAllEquipment()` qui permet à un client d'obtenir un
   bail d'un serveur sans aucun chemin physique (rupture d'isolation de sous-réseau).
   Or le chemin « wire » (broadcast UDP 68→67 réel, `WireDhcpChannel`) est complet
   et fonctionnel. → *Migration wire-first.*
2. **IPSec — résolution du pair par scan global d'IP** (`IPSecEngine.findRouterByIP`
   / `findEquipmentByIP`) au lieu de la table de routage / ARP. À re-vérifier puis
   corriger.
3. **OSPF — énumération de domaine par BFS sur le registre** (`collectOSPFDomain`,
   `Equipment.getById`) : sert à piloter une convergence synchrone (les Hellos
   passent bien par le fil, mais l'orchestration appelle directement les moteurs
   des autres routeurs). Chantier de fond : convergence autonome pilotée par timers.
4. **Médium physique** : `Cable.transmit()` calcule le délai de propagation mais
   livre de façon **synchrone** (migration prévue vers une livraison ordonnancée).
5. **Duplication transverse** : patterns de timers/scheduler et machines à états de
   voisins répliqués dans plusieurs moteurs, malgré l'existence de bases communes
   (`AbstractRoutingProtocolEngine`, `ReactiveAgentBase`, `FhrpAgentBase`) que tous
   les protocoles n'adoptent pas encore (OSPF/RIP notamment).

---

## Incréments

<!-- Chaque correction poussée est consignée ci-dessous : problème, cause, correctif, vérification, commit. -->
