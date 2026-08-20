# PRD — 802.1X : un moteur réel, sans porte côté Cisco

> **État : livré.** Le §1 décrit le constat de départ et n'est pas
> réécrit.

---

## 0. Comment ce manque a été trouvé

Régénération des 93 suites de transcripts de `src/__tests__/debug/`
(125 fichiers produits, dont 52 qui n'avaient jamais été dumpés), puis
comptage des signatures d'échec. Deux gisements ressortent :

| Signature | Occurrences |
|---|---|
| `% Invalid input` (Cisco/Huawei) | 227 |
| `command not found` (Linux) | 129 |
| `JS EXCEPTION` | 0 |

Le fichier le plus dense après l'EtherChannel est
`cisco-l2-06-port-security-access` : **52** refus, dont **40** pour
cinq lignes `dot1x` répétées sur huit ports.

---

## 1. Le constat

`src/network/dot1x/Dot1xAgent.ts` fait 492 lignes et n'a rien d'une
maquette : rondes EAP réelles, dorsale RADIUS, machine à états par port
(`unauthorized` / `authenticating` / `authorized` / `held`), et surtout
`CiscoSwitch.handleFrame` qui **refuse déjà** de commuter une trame
venant d'un port non autorisé.

`CiscoSwitch` construit cet agent. `HuaweiSwitchShell` le pilote.
`CiscoSwitchShell` ne contenait **pas une seule occurrence** du mot
`dot1x`.

Autrement dit : le moteur tournait, l'application était en place, et il
n'existait aucun moyen de demander quoi que ce soit depuis la CLI la
plus enseignée. Ce n'est pas une fonctionnalité manquante, c'est une
porte manquante sur une fonctionnalité présente — et une asymétrie
entre deux vendeurs au-dessus du même moteur.

---

## 2. Ce qui est livré

### 2.1 Adossé à du réel

| Commande | Ce qu'elle atteint |
|---|---|
| `[no] dot1x system-auth-control` | `setSystemAuthControl` |
| `dot1x pae authenticator` | enregistre le port auprès de l'authentificateur |
| `dot1x port-control {auto\|force-authorized\|force-unauthorized}` | `setPortMode` — et donc le filtrage de `handleFrame` |
| `dot1x timeout quiet-period <s>` | `setHoldTime`, qui pilote vraiment l'état `held` |
| `show dot1x [all]`, `show dot1x interface <if>` | l'état d'exécution réel du port |

`setHoldTime` est le seul ajout au moteur : `holdMs` existait, était
consulté, et n'avait aucun mutateur.

### 2.2 Refusé, en nommant la raison

Le moteur autorise **un** demandeur par port et n'a pas de cycle de
réauthentification périodique — son `reauthCount` compte les
retransmissions d'une requête EAP, pas des cycles. Donc :

- `dot1x host-mode …` → « un port autorise un seul demandeur » ;
- `dot1x reauthentication` et `dot1x timeout reauth-period` → refusés en
  nommant le timer absent ;
- `dot1x pae supplicant` → seul le rôle authentificateur existe.

Les accepter en silence aurait produit exactement le réglage décoratif
que ce dépôt traque : une commande qui répond `OK` et ne change rien.

---

## 3. Ce que la correction change réellement

La probe ne se contente pas de lire un `show`. Deux postes sur un même
commutateur se joignent ; après

```
dot1x system-auth-control
interface FastEthernet0/1
 dot1x pae authenticator
 dot1x port-control auto
```

le ping tombe à `0 received`, et `force-authorized` le rétablit. Le
filtrage n'a pas été ajouté — il était là depuis toujours ; c'est la
demande qui ne pouvait pas l'atteindre.

---

## 4. Hors périmètre

- **PAgP / EtherChannel** : `cisco-l2-05-etherchannel` reste le fichier
  le plus dense (54 refus). Même forme de manque —
  `lacp/LacpAgent.ts` est réel, `setSystemPriority` et `setFastRate` ont
  un effet mesurable sur la cadence, la temporisation et le départage
  d'agrégation, et **ne sont appelés de nulle part**. À traiter dans un
  lot suivant, avec l'incohérence voisine : `channel-group … mode
  desirable|auto` demande PAgP et émet du LACP, alors qu'aucun moteur
  PAgP n'existe.
- **`storm-control`, `show interfaces status err-disabled`,
  `ip dhcp snooping information option`** : les six refus restants de ce
  transcript, non traités ici.
- **Les commandes Linux absentes** (129) : surtout des utilitaires de
  texte (`tac`, `nl`, `paste`, `comm`, `fold`, `column`, `split`, `pr`,
  `fmt`, `cmp`, `expand`, `base64`, `bc`, `tree`) et trois de réseau
  (`ethtool`, `mtr`, `tracepath`). `ethtool` est le plus mûr : son
  `Link detected:` est exactement la porteuse rendue réelle au
  `PRD-Link-State.md` §6, et le §5 de ce même document le déclarait hors
  périmètre faute de cette donnée.

---

## 5. Vérification

`probe-dot1x-01-cli-cisco.test.ts` — 11 cas : la commande atteint
l'agent, la temporisation est celle que l'agent tient, le trafic est
réellement bloqué puis rétabli, et chaque forme non modélisée est
refusée en nommant sa raison.

Régression : les six suites `dot1x-*`, `huawei-dot1x`, les suites du
switch Cisco et `windows-server-nps` — 141 tests verts. Les neuf suites
de transcripts `cisco-l2` régénérées : le fichier port-security passe de
**52 refus à 6**. `tsc` à 127, `eslint` sans erreur nouvelle.

---

## 6. Deuxième lot — LACP, exactement la même forme

Le §4 renvoyait l'EtherChannel à un lot suivant. Le voici, et le
diagnostic était juste : `LacpAgent` fait tourner une vraie machine de
réception 802.3ad, et **`setSystemPriority` et `setFastRate` n'étaient
appelés de nulle part** — alors que le premier entre dans le départage
d'agrégation (`compareSystemId`) et le second ré-arme réellement les
temporisateurs (cadence d'annonce, `current_while` à 3 s au lieu de
90 s). `show etherchannel` était la seule fenêtre sur l'ensemble.

### 6.1 Livré, adossé à du réel

| Commande | Ce qu'elle atteint |
|---|---|
| `lacp system-priority <1-65535>` | `setSystemPriority` — visible dans `show lacp sys-id` et dans le départage |
| `lacp rate {fast\|normal}` | `setFastRate`, qui ré-arme les temporisateurs |
| `lacp port-priority <1-65535>` | nouveau champ, qui **voyage dans la LACPDU** |
| `show lacp {sys-id\|neighbor\|internal\|counters}` | partenaire appris, état, priorités, compteurs réels |
| `show interfaces <if> etherchannel` | la vue par port de ce que `show etherchannel` donne par groupe |

`lacp rate` est per-interface dans la grammaire IOS mais le moteur tient
une cadence par équipement : c'est écrit à l'endroit du code où la
divergence se produit.

### 6.2 Refusé, en nommant la raison

- **`port-channel load-balance`** — une grappe ne sert ici qu'à
  regrouper des membres pour le spanning tree ; **rien ne répartit les
  trames** entre eux. La méthode n'aurait rien à décider. Même
  raisonnement que le `/ab:` de `wevtutil`.
- **PAgP** — `channel-group … mode desirable|auto` était silencieusement
  replié sur LACP actif/passif : on demandait PAgP et on émettait du
  LACP, mensonge que l'opérateur n'avait aucun moyen de voir. Refusé en
  nommant le protocole absent, comme `show pagp`.

### 6.3 Un défaut trouvé en chemin

`runSelection` décidait de la vivacité d'un membre avec
`port.isConnected()` — « un câble est branché ». C'est le défaut
corrigé au `PRD-Link-State.md` §6, resté ici : un membre dont le pair
est désactivé ou hors tension restait agrégé alors qu'il ne portait
plus rien. Il lit maintenant `isOperationallyUp()`, et deux cas de la
probe le figent.

### 6.4 Vérification

`probe-lacp-01-cli-cisco.test.ts` — 16 cas. Régression : les suites
LACP, STP, switch Cisco et Huawei, VRP et les scénarios de panne 01-03 —
374 tests verts. Transcripts régénérés : `cisco-l2-05-etherchannel`
passe de **54 refus à 6**, et l'ensemble du dossier `cisco-l2` de
**227 à 86** sur les deux lots. `tsc` à 127, `eslint` sans erreur.

Reste dans ce dossier, non traité : `storm-control`,
`show interfaces status err-disabled`,
`ip dhcp snooping information option`, et
`show interfaces FastEthernet0/0` — ce dernier étant un refus correct,
le port n'existant pas sur un châssis 24 ports.
