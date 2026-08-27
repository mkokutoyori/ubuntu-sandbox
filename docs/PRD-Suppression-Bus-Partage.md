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

### Incrément 3 — l'UI n'a plus de bus global — **LIVRÉ**
**Sortie atteinte** : `src/react/hooks/` ne mentionne plus
`getDefaultEventBus`, et un cas structurel le garde.

**Ce que les huit crochets regardaient se répartit en trois, et chaque
part a un propriétaire qui n'est pas un bus partagé.**

**Le cycle de vie de la TOPOLOGIE** (`device.registered`,
`device.deregistered`, `registry.cleared`) appartient au registre qui en
décide. `EquipmentRegistry.subscribe(listener)` le dit directement, au
lieu de passer par un bus que n'importe qui peut lire.
`useDevices`, `useEngineSignal` et `useHostObservables` le lisent.

**L'état PAR APPAREIL** appartient à l'appareil rendu, qui a déjà son bus
de machine. `useMacTable` tenait déjà l'instance — son filtre par
`deviceId` devient inutile, ce qui est le signe qu'on a trouvé le bon
propriétaire. `useConnectionPerf` s'abonne aux deux appareils du câble.

**Les TRAMES** de l'animation appartiennent au tap de l'incrément 1.
`useActivePackets` quittait `cable.frame.dispatched` : il pose un tap sur
chaque machine et déduit le câble et le pair du port émetteur.

**`useBusEvents`** est l'échappatoire générique. Son bus était optionnel
et retombait sur le global ; il est désormais **obligatoire**. Vérifié
avant de le durcir : ce crochet n'a aucun appelant de production, et son
seul test passait déjà un bus explicite.

**Une découverte qui a élargi le lot.** `useOracle` écoute
`oracle.instance.state-changed`, et une instance Oracle publiait sur le
bus GLOBAL — l'incrément 4 ne l'avait câblée sur le bus de sa machine
que pour RAC. C'est fait pour toutes. Mais `oracleHooks.test.tsx` a
nommé le reste : il fait tourner Oracle sur un identifiant d'appareil qui
n'est PAS dans le registre, donc s'abonner aux appareils ne suffit pas.
Le vrai propriétaire du cycle de vie d'une instance est la table qui la
détient : `subscribeOracleInstances` est son observateur.

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

### Incrément 5a — plus rien en production ne LIT le bus partagé — **LIVRÉ**

**Sortie atteinte** : `getDefaultEventBus().subscribe` n'apparaît nulle
part hors de `src/events/` et des tests, et un cas structurel le garde
en relançant la recherche à chaque exécution.

Deux lecteurs restaient, tous deux trouvés APRÈS la mesure d'ouverture —
qui n'en annonçait que trois, et disait vrai à l'instant où elle a été
prise.

**`FortiTerminalSession`** écoutait `device.power-on` sur le bus global
puis **filtrait par identifiant**. Le filtre est l'aveu : la source était
plus large que la question. Son appareil a son propre bus, et le filtre
disparaît avec la migration — c'est le même signe qu'avec `useMacTable`
à l'incrément 3.

**`networkStore`** relaie `port.link.*` et `port.config.ip-changed` vers
une révision de canevas. **Ce paragraphe disait que rien n'y était à
corriger, et c'était faux** — le pont lisait bel et bien le bus global,
à travers une variable locale que le garde-fou de cet incrément ne
voyait pas. Corrigé à l'incrément 5b : le magasin surveille les
appareils qu'il DÉTIENT. Le cas de comportement, lui, reste le bon : une
interface qui tombe fait monter la révision sans qu'aucune action du
magasin ne soit appelée.

**Pourquoi le garde-fou porte sur l'ABONNEMENT et non sur le symbole.**
Une machine qui relaie ses propres événements, à sens unique, vers un
observateur est exactement ce que `PRD-Frame-Only-Refactor.md` autorise
pour Logger, l'UI et les tests. Ce qui ne doit jamais revenir, c'est du
code de production qui LIT ce relais — c'est la seule forme sous laquelle
un bus partagé redevient un canal de communication.

### Incrément 5b — le relais est COUPÉ (LIVRÉ)
`Equipment.getBus()` rendait un `ForwardingEventBus` recopiant chaque
événement interne vers le singleton global. Il rend un `EventBus` nu :
plus aucun événement de machine ne quitte sa machine.

**Le garde-fou de 5a était trop faible, et c'est ce qui l'a montré.** Il
cherchait le texte `getDefaultEventBus().subscribe` ; un bus rangé dans
une variable locale le contourne, et `networkStore` le contournait
exactement ainsi. Une orthographe ne garde pas une propriété.
`machine-bus-is-not-shared.test.ts` l'éprouve par le COMPORTEMENT : une
machine publie, une autre n'entend rien, le bus partagé non plus. Deux
TÉMOINS empêchent qu'un bus qui ne livrerait rien satisfasse la règle.

**Ce que la coupure a rendu sourd, et qui est réparé.** Trois
observateurs globaux vivaient du relais : `networkStore`,
`TerminalManager` (gel des terminaux à l'extinction) et
`FaultProjection` (tout son plan F1/F2/F3/F6). Plutôt que trois boucles
identiques, `equipment/DeviceWatch.ts` porte UNE implantation :
`watchDevices(topics, handler)` suit le registre, s'abonne au bus propre
de chaque appareil qui arrive, se désabonne de celui qui part.

**Ce qui reste sur le bus global, et pourquoi.** Un `Cable` est
PHYSIQUEMENT partagé par deux machines — c'est ce qu'est un câble — donc
`cable.frame.*` y demeure sans contredire la règle. `Logger` et
`EquipmentRegistry` sont des observateurs à l'échelle du simulateur, pas
des machines ; ils gardent leur canal, et aucune production ne le LIT.
Le symbole `getDefaultEventBus` n'est donc pas encore supprimé : le
supprimer demande de leur donner un nom qui dit ce qu'ils sont, et c'est
l'objet de l'incrément 5c.

**34 fichiers de test convertis**, mes trois sondes d'abord — il aurait
été malvenu de prêcher contre le bus global dans des sondes qui le
lisent. `support/wireWatch.ts` porte l'observation de trames une seule
fois, là où trois suites de mirroring recopiaient le même
`captureFramesOn`. Deux agents publiaient EN DUR sur le global
(`MdnsAgent`, `LlmnrAgent`, 16 sites) alors qu'ils appartiennent à un
hôte : ils publient sur le bus de cet hôte.

### Incrément 5c — plus aucun repli vers un canal partagé (LIVRÉ)
Vingt-huit fichiers de production portaient encore
`busOverride ?? getDefaultEventBus()`. **Le repli EST le défaut** : il
n'est atteint que lorsque personne n'a injecté de bus — c'est-à-dire
lorsque l'objet n'appartient à aucune machine — et il publie alors dans
un canal que toutes les machines partagent. `events/BusHolder.ts` porte
la règle une seule fois : le bus qu'on m'a donné, sinon le mien.

**Trois défauts réels que le relais cachait**, tous trouvés parce que la
suppression les a rendus visibles :

1. **Les quatre adaptateurs Oracle écoutaient le bus partagé** pendant
   que l'instance publiait sur celui de son équipement. Ils ne
   recevaient rien par eux-mêmes ; le relais leur recopiait tout. Sept
   cas sont tombés à la coupure, cinq se sont relevés en leur donnant le
   bus de l'hôte.
2. **`OracleDatabase` s'abonnait au bus de l'instance À SA
   CONSTRUCTION**, et `setEventBus` le remplaçait juste après. Son
   abonnement restait donc sur le bus d'avant, et le ré-balayage SoD
   après un `GRANT` ne se déclenchait que par le relais. `onBusChanged`
   ré-abonne, ce qu'un changement de bus doit faire.
3. **`SyslogAgent` et `LoggingConfig` s'abonnaient DEUX fois** — au bus
   de la machine et au bus partagé — avec un filtre anti-doublon pour
   réparer la conséquence. La seconde était morte de toute façon
   (`device.syslog.entry` n'est publié que sur le bus de la machine) ;
   `LoggingConfig` lit désormais `Logger` par son API propre, qui filtre
   déjà par équipement.

**Ce qui garde légitimement un canal partagé, et pourquoi.** `Cable`
est PHYSIQUEMENT partagé par deux machines — c'est ce qu'est un câble.
`Logger` est un observateur à l'échelle du simulateur et porte sa propre
API d'abonnement. `EquipmentRegistry` n'est pas une machine mais le
registre des machines : il possède maintenant son bus (il ne se replie
plus sur un global), et c'est là que vivent `device.registered`,
`device.deregistered`, `device.removed` et `registry.cleared` — que le
magasin, `TerminalManager` et `FaultProjection` lisent.

**Le garde-fou est structurel et grandit tout seul** :
`no-component-falls-back-to-a-shared-bus.test.ts` REFAIT la recherche à
chaque exécution et NOMME ses contrevenants, au lieu d'une liste écrite
à la main qui pourrit. Trois fichiers y sont autorisés, chacun pour la
raison ci-dessus.

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
