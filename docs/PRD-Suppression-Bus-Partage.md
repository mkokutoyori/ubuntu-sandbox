# PRD — Le bus partagé disparaît, le tap le remplace

**Version** : 1.0
**Date** : 2026-08-25
**Agent** : `mandeng`
**Demande** : « je ne veux plus [de] système de bus partagé, il faut
supprimer le système de bus, et trouver un autre moyen d'envoyer les
messages dans le réseau comme sur un vrai équipement. »

**Dépendances** : `docs/BRD-Modele-TCP-IP.md` (même chantier
d'architecture), `docs/PRD-Frame-Only-Refactor.md` (invariants « trames
uniquement » et « bus interne »), dont ce document **termine** l'ambition
plutôt que de la rouvrir.

---

## 1. La mesure de départ

Chiffres relevés sur l'arbre courant, hors `src/__tests__`.

| Mesure | Valeur |
|---|---|
| Fichiers de production touchant un bus | **260** |
| Fichiers touchant le bus **global** (`getDefaultEventBus`) | **47** |
| **Abonnements** au bus global en production | **3** |

**Le chiffre qui compte est le dernier.** Les 47 autres fichiers ne font
que **publier**, ou obtenir le relais interne à leur propre machine. Il
n'existe que trois endroits où du code *lit* le bus global, et ce sont
les seuls qui s'en servent comme d'un **canal de communication** :

| Site | Ce qu'il écoute | Ce que c'est en vrai |
|---|---|---|
| `database/oracle/rac/RacCssAgent.ts` | `port.link.down` de **n'importe quelle** machine | Un battement de cœur manqué sur l'interconnexion RAC |
| `database/oracle/rac/RacCacheFusionAgent.ts` | `oracle.dml.executed` d'une **autre** instance | Un message GCS sur l'interconnexion |
| `terminal/sessions/FortiTerminalSession.ts` | `device.power-on` d'une autre machine | Rien : une observation d'interface |

Les deux premiers sont de **vrais protocoles réseau joués sur un objet
global**. C'est exactement ce que la demande vise.

**Ce que la mesure a aussi établi, et qui corrige une lecture facile** :
la capture de paquets (`LinuxMachine`, c'est-à-dire `tcpdump`) ne fuit
PAS. Elle s'abonne au bus **de sa propre machine** et filtre en plus sur
`deviceId`. Le défaut n'était pas qu'elle voyait le trafic des autres —
elle ne le voyait pas — mais que le **mécanisme** le permettait à qui le
voulait. La différence est structurelle, pas comportementale, et ce
document le dit plutôt que de s'attribuer une correction de bogue.

---

## 2. Le remplacement : un tap par interface

Sur une vraie machine, une capture s'attache à une **interface de cette
machine** : `AF_PACKET` lie un index d'interface, `libpcap` ouvre un
périphérique par son nom. Il n'existe aucun objet permettant à un hôte de
lire les trames d'un autre — le seul moyen de voir le trafic du voisin
est d'être sur son domaine de collision et de recevoir la trame
soi-même.

`src/network/hardware/PortTap.ts` porte la règle :

```
Port.attachTap(tap) -> DetachTap
Equipment.attachCapture(tap, iface?) -> DetachTap
```

**La garantie est structurelle et non disciplinaire** : un tap s'attache
à un `Port`, un `Port` appartient à exactement une machine, donc
« observer une machine qu'on ne possède pas » n'est pas exprimable.

Deux directions, parce qu'une vraie capture voit les deux (`tcpdump -Q
in|out`). Et le tap **rend l'objet trame qui voyage**, sans copie :
`CLAUDE.md` documente que `Cable` livre la même instance de bout en bout
et que c'est délibéré ; un tap qui clonerait casserait l'assertion
d'identité de `hardware.test.ts`.

---

## 3. Le plan, par incréments

### Incrément 1 — le tap existe et `tcpdump` s'en sert — **LIVRÉ**
`PortTap.ts`, `Port.attachTap`, `Equipment.attachCapture`, et la capture
de `LinuxMachine` bascule dessus. **Sortie** : les 21 suites `tcpdump`
du dépôt (249 cas), écrites avant ce chantier, passent à travers le
nouveau mécanisme sans modification.

### Incrément 2 — les autres lecteurs de trames passent au tap — **LIVRÉ**
`RouterDebugService` et `HuaweiDebugService` prennent un port étroit
`FrameSource` et lisent le tap. Plus aucun abonnement à `port.frame.*`
en production.

**Deux choses trouvées en le faisant, et aucune n'était prévue.**

**(1) La capture au niveau machine ne devait pas FIGER l'ensemble des
ports.** La première version parcourait `this.ports` à l'attache, si bien
qu'une interface créée ensuite — une sous-interface `dot1q`, un port
ajouté après coup — n'était jamais écoutée. Sept cas de debug sont tombés
là-dessus. `Equipment` porte désormais son propre `TapPoint`, chaque port
y émet dès sa création dans `addPort`, et `attachCapture` s'abonne à la
machine plutôt qu'à une liste de ports datée.

**(2) `cisco-debug-arp-subscription.test.ts` n'éprouvait pas la
fonction.** Ses deux injecteurs publiaient un événement de bus
SYNTHÉTIQUE (`bus.publish({ topic: 'port.frame.received', … })`) sans
jamais toucher un port : le test pouvait passer alors qu'aucune trame ne
circulait, et son titre disait le mécanisme (« event subscription »)
plutôt que le comportement. Il fait désormais RECEVOIR et ÉMETTRE une
vraie trame sur un vrai port câblé. C'est une correction de test, pas un
assouplissement : l'exigence — l'opérateur voit la ligne — est
inchangée, et elle est mieux gardée qu'avant.

### Incrément 3 — l'UI n'a plus de bus global
Les crochets React (`useDevices`, `useActivePackets`, `useBusEvents`, …)
lisent aujourd'hui le bus global. Ils deviennent des abonnés du magasin
et des taps des machines affichées. **Sortie** : `src/react/hooks/` ne
mentionne plus `getDefaultEventBus`.

### Incrément 4 — l'interconnexion RAC devient du vrai trafic — **LIVRÉ**
Le battement de cœur CSS et les messages GCS deviennent de vrais
datagrammes sur le port d'interconnexion. **Sortie** : une éviction se
produit parce que le battement **n'arrive plus** — la cause réelle — et
non parce qu'un événement a été lu sur un bus. Le témoin obligatoire :
un laboratoire où l'interconnexion est coupée évince, et le même
laboratoire sans coupure n'évince pas.

**Ce qui a réellement changé.** Le fichier avouait son raccourci dans son
propre en-tête : « *eviction here fires the instant the interconnect NIC
itself loses carrier (`port.link.down`)* ». C'est remplacé par un vrai
battement de cœur : chaque membre ÉMET un datagramme sur l'interconnexion
toutes les secondes et chaque membre ÉCOUTE ; l'éviction suit le
`misscount` de 30 s, comme le vrai CSSD. **Le cas qui prouve la
différence** est celui d'un nœud ÉTEINT : aucun `port.link.down` n'est
publié pour son propre port, donc l'ancien mécanisme ne pouvait pas le
remarquer — le nouveau l'évince, parce que le battement cesse.

**Une règle a dû être ajoutée, et elle vient du vrai produit** : quand
l'interconnexion tombe, les deux nœuds cessent de s'entendre
MUTUELLEMENT, donc une lecture naïve les évince tous les deux et le
laboratoire perd sa base. Un vrai CSS garde la cohorte survivante ; ici
le survivant est le membre dont l'interface d'interconnexion est encore
utilisable. Le quorum par disque de vote n'est pas modélisé, et c'est
écrit ici plutôt que sous-entendu.

**Deux conséquences assumées.** L'éviction n'est plus INSTANTANÉE : les
deux cas de `scenario-oracle-07` avancent désormais une horloge virtuelle
de `misscount`, parce qu'un battement de cœur ne peut pas conclure sans
que le temps passe — leur ancienne forme encodait le raccourci comme
contrat. Et l'instance Oracle publie ses événements sur le bus de SA
machine (`db.instance.setEventBus(device.getBus())`), sans quoi la fusion
de cache ne pouvait pas quitter le bus global.

**Reste partagé, et ce n'est pas le bus** : `RacClusterRegistry` est une
table de grappe globale, et `EquipmentRegistry` sert à retrouver un
pair. Les deux relèvent de `PRD-Frame-Only-Refactor.md`, pas de ce
document.

### Incrément 5 — `getDefaultEventBus` est supprimé
Le relais `ForwardingEventBus` ne forwarde plus vers un global ; le
singleton disparaît. **Sortie** : un garde-fou structurel échoue si
`getDefaultEventBus` réapparaît, comme le BRD §7 le prescrit.

---

## 4. Ce qui ne change pas, et pourquoi

- **Le bus INTERNE d'une machine reste.** La demande vise le bus
  *partagé*. Un équipement réel a bien une signalisation interne — un
  pilote qui prévient la pile, `netlink` qui prévient l'espace
  utilisateur. Ce qui n'existe pas sur une vraie machine, c'est un objet
  que **plusieurs machines** partagent.
- **Les Signals et observables** que l'UI lit restent : ils décrivent
  l'état d'une machine, ils ne transportent rien entre machines.
- **Aucune sémantique protocolaire ne change**, même règle que le BRD
  §4.1 — sauf pour RAC (incrément 4), où c'est justement l'objet.

---

## 5. Limite assumée et écrite

Les tests du dépôt utilisent massivement le bus global pour observer
(mes propres sondes des phases précédentes comprises). L'incrément 5 les
fera basculer sur le tap. Tant qu'il n'est pas livré, `getDefaultEventBus`
reste disponible **pour les tests** et le garde-fou ne porte que sur
`src/` hors `__tests__` — ce qui est écrit ici pour que personne ne
prenne cette tolérance pour un oubli.
