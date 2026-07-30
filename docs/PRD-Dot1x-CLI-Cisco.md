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
