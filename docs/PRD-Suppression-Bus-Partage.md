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

### Incrément 2 — les autres lecteurs de trames passent au tap
`RouterDebugService` et `HuaweiDebugService` lisent
`port.frame.received` pour `debug`. Même bascule. **Sortie** : plus
aucun abonnement à `port.frame.*` nulle part.

### Incrément 3 — l'UI n'a plus de bus global
Les crochets React (`useDevices`, `useActivePackets`, `useBusEvents`, …)
lisent aujourd'hui le bus global. Ils deviennent des abonnés du magasin
et des taps des machines affichées. **Sortie** : `src/react/hooks/` ne
mentionne plus `getDefaultEventBus`.

### Incrément 4 — l'interconnexion RAC devient du vrai trafic
Le battement de cœur CSS et les messages GCS deviennent de vrais
datagrammes sur le port d'interconnexion. **Sortie** : une éviction se
produit parce que le battement **n'arrive plus** — la cause réelle — et
non parce qu'un événement a été lu sur un bus. Le témoin obligatoire :
un laboratoire où l'interconnexion est coupée par `tc qdisc` évince, et
le même laboratoire sans coupure n'évince pas.

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
