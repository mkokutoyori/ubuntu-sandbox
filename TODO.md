# TODO — manquements mesurés, non encore fermés

Un manquement n'entre ici que s'il a été **mesuré** : commande tapée,
état relu, écart constaté. Chaque entrée dit *ce qui est cassé*, *comment
on l'a vu*, et *pourquoi ce n'est pas fermé*. Une entrée fermée est
retirée d'ici et racontée dans son message de commit, jamais dans le
code (`CLAUDE.md` : le code ne porte pas de commentaire).

Format : `[famille] intitulé` puis constat / mesure / raison du report.

---

## Commutateur Huawei (VRP)

### [suppression] `multicast-suppression` / `unicast-suppression` absentes, `broadcast-suppression` décorative
Les deux premières sont refusées ; la troisième est acceptée et rangée en
TEXTE dans `ifCfg`, sans moteur de limitation derrière.
**Mesure** : `broadcast-suppression 30` → rendu dans `display this`, aucun
compteur, aucune trame écartée.
**Report** : compléter la famille ajouterait deux décors. Il faut d'abord
un vrai seau à jetons par port et par type de trafic (le `CarPolicer` du
routeur en est un, mais il vit sur `Router`, que `Switch` n'étend pas).

### [mac-limit] deux lignes pour un seul réglage
`mac-limit maximum 5` puis `mac-limit maximum 5 vlan 10` se rendent tous
les deux, alors que VRP remplace le premier par le second.
**Mesure** : les deux lignes apparaissent dans `display this`.
**Report** : défaut général du magasin de texte par interface (`ifCfg`),
qui empile au lieu de remplacer — il touche toute la vue interface, pas
seulement `mac-limit`.

### [qos car] policé sur un routeur VRP, texte sur un commutateur VRP
`CarPolicer` est un vrai seau à jetons sur le chemin de données, mais il
vit sur `Router` ; `Switch` ne l'étend pas.
**Report** : demande de sortir `CarPolicer` du routeur vers une base
partagée, ou de le monter sur `Switch` — travail d'architecture.

### [vues système non mesurées]
Familles repérées comme présentes mais jamais passées au banc :
`dhcp enable`, `dhcp snooping enable`, `observe-port`, `traffic classifier`,
`user-interface vty`, `info-center enable`, `ip route-static` sur un
commutateur L3.
**Report** : pas encore mesurées — à passer au banc avant d'affirmer quoi
que ce soit.

---

## Moteur L2 partagé (`Switch.ts`)

### [stp] `display stp brief` liste les ports sans câble en `DISA LISTENING`
Un port administrativement actif mais sans lien apparaît dans le tableau
avec un rôle et un état, ce qui noie les deux lignes utiles.
**Mesure** : maquette à 25 ports, 23 lignes `DISA LISTENING`.
**Report** : il faut d'abord vérifier sur une vraie machine si VRP les
liste ou non — l'affirmer sans capture serait inventer.

### [stp] MSTI : la BPDU porte son instance en clair
L'arbre commun (CIST) est désormais nommé sur la trame (`cist`), donc
MSTP et PVST se rencontrent. Les MSTI, elles, portent toujours leur
numéro d'instance : deux régions dont les tables VLAN→instance diffèrent
échangeraient des BPDU sur des instances qui ne se correspondent pas.
**Report** : à l'intérieur d'une région les tables sont identiques par
définition, donc le cas ne se produit pas dans un laboratoire ; le fermer
demande de propager le condensé de région et de ne plus échanger que le
CIST entre régions.

---

## Commutateur Cisco

### [stp] `spanning-tree mode mst` déplace l'arbre commun
Passer de PVST (arbre commun = VLAN 1) à MST (CIST = instance 0) laisse
l'ancienne instance convergée derrière et repart d'une instance vide.
La règle 802.1D §8.6.9 ajoutée (réponse à une information inférieure) fait
converger le voisin, donc le symptôme est refermé côté VRP.
**Report** : le cas Cisco n'a pas été mesuré ; à passer au banc.

---

### [interface range] la vue de plage n'a pas été mesurée
`interface range <a> to <b>` entre dans une vue et n'y dérive pas
(`huawei-eth-trunk.test.ts` le vérifie), mais rien ne dit que ses
commandes atteignent les membres — la vue `port-group`, qui vient d'être
fermée, avait exactement cette forme.
**Report** : à passer au banc ; si le défaut est le même, la sortie est
la même (`executerSurMembres`).

## Journal des entrées fermées

- `mac-address learning disable` (VRP interface + VLAN) et
  `no mac address-table learning` (Cisco) — fermé, moteur réel sur le
  chemin de données, les deux actions `discard`/`forward`.
- `mac-address static` / `blackhole` / `aging-time` sur VRP — fermé.
- Famille `stp` du commutateur VRP — fermé.
- Vue `port-group` (temporaire et permanente) — fermée : les commandes
  atteignent vraiment chaque membre, les groupes permanents vivent sur
  l'équipement et se rendent, `display port-group` existe.
- `#` ne ramenait pas en vue de base au REJEU d'une configuration VRP —
  fermé dans `replayVendorConfig` ; un bloc d'interface vide faisait
  perdre tout ce qui le suivait.
