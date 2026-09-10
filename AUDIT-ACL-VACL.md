# Audit — Les VACL (`vlan access-map` / `vlan filter`)

**Périmètre :** `CiscoSwitchShell` (vue `config-access-map`), `Switch.vaclPermits`, rendu de configuration
**Date :** 10 septembre 2026
**Branche auditée :** `mandeng`
**Méthode :** lecture, banc de mesure exécutable, référence constructeur relue en ligne
**Rapports jumeaux :** `AUDIT-ACL-CISCO.md`, `AUDIT-ACL-HUAWEI.md`, `AUDIT-ACL-HUAWEI-SWITCH.md`, `AUDIT-ACL-CISCO-SWITCH.md`, `AUDIT-ACL-IPV6.md`

> **Coordination.** Un autre agent refond le système de commandes Cisco
> (`src/cli/**`, `aclHeadSpecs.ts`, le pont de `CiscoShellBase`, la table
> `socle` de `CiscoIOSShell`). Ce lot ne touche à aucun de ces fichiers.
> Il ne modifie pas non plus l'héritage de mode entre une sous-vue et la
> vue de configuration, chantier que `confinerSousVue` occupe.

---

## 0. État des corrections

> **Les six constats sont corrigés.**
>
> ```bash
> npx vitest run src/__tests__/audit/   # 117 tests, 6 surfaces
> ```
>
> Discrimination par `git stash` des deux fichiers de production :
> **9 des 12 cas tombent**. Les 3 restants sont nommés dans l'en-tête de
> la sonde.

---

## 1. Verdict

**Le mécanisme était bon. C'est sa mémoire qui manquait.**

Contrairement aux cinq surfaces précédentes, il n'y avait ici ni magasin
fantôme ni critère jeté à l'analyse : un VACL posé sur un VLAN **coupe
vraiment** le trafic, le refus implicite de fin de carte est appliqué, et
une ACE `deny` employée comme classifieur fait bien **tomber dans la
séquence suivante** au lieu de rejeter — ce qui est exactement la
sémantique d'IOS et le point que l'on rate le plus souvent.

Le défaut était ailleurs, et il est du même genre que celui des ACL IPv6,
en miroir :

```
SW1(config)# vlan filter M vlan-list 10
SW1# show running-config | include vlan filter
                                              ← rien
```

**La liaison n'était rendue nulle part.** Les cartes revenaient à
l'import d'une topologie, la liaison non — donc le filtre cessait de
s'appliquer, sans un mot. Mesuré de bout en bout : filtre posé, 100 % de
perte ; configuration relue par `replayVendorConfig` ; **0 % de perte**.

| | ACL IPv6 (V-01) | VACL (W-03) |
|---|---|---|
| Rendu | la liaison, **pas** la liste | les cartes, **pas** la liaison |
| Après rechargement | la liaison désigne le vide | les cartes ne sont liées à rien |
| Résultat | `permit` universel | plus aucun filtrage |

Deux moitiés opposées, une seule conséquence : **une ouverture
silencieuse**.

---

## 2. Les six constats

| Id | Constat | Gravité | État |
|---|---|---|---|
| W-03 | `vlan filter` **rendu nulle part** : le filtre disparaît au rechargement | 🔴 Bloquant | **✅ corrigé** |
| W-02 | `no vlan access-map M 20` supprimait **la carte entière** et ses liaisons | 🔴 Bloquant | **✅ corrigé** |
| W-01 | `match ip address A B` ne gardait que **la première** ACL | 🟠 Haut | **✅ corrigé** |
| W-04 | Un qualificatif après `action` était **avalé** (`forward capture` valait `forward`) | 🟡 Moyen | **✅ corrigé** |
| W-05 | Séquence hors de la plage 0-65535 acceptée | 🟡 Moyen | **✅ corrigé** |
| W-06 | Jeton surnuméraire après la séquence avalé | 🟡 Moyen | **✅ corrigé** |

W-02 mérite d'être isolé : `removeVlanAccessMap` supprime **aussi les
liaisons** de la carte. Retirer une séquence sur deux faisait donc
disparaître le filtrage du VLAN entier — l'opérateur croyait retirer une
ligne, il désarmait la protection.

---

## 3. Ce qui a été fait

### Une clause `match` porte une LISTE

`matchIpAcl?: string` devient `matchIpAcls?: string[]`, **remplacé et non
doublé** : garder les deux aurait été deux écritures d'un même fait.
L'entrée correspond si **l'une** des ACL nommées correspond, ce qui est la
règle d'IOS.

### La liaison est rendue

`vlanFilterRunningConfigLines()` lit `getVlanFilterBindings()` — la même
inversion que `show vlan filter` consulte déjà, et non une seconde. La
liste de VLAN est compactée par **`compactVlanList`** (`shells/cli/vlanList.ts`),
qui existait et que DHCP et le commutateur partagent : j'en avais d'abord
écrit une seconde, supprimée avant d'aller plus loin.

### `no` retire ce qu'on lui nomme

`removeVlanAccessMapSequence(nom, séquence)` retire la séquence ;
`no vlan access-map <nom>` sans séquence continue de retirer la carte et
ses liaisons. C'est la règle écrite chez le constructeur : *« Use the no
keyword with a sequence number to remove a map sequence. Use the no
keyword without a sequence number to remove the map. »*

### `action` ne prend que ce que la plateforme modélisée prend

`action forward capture` était **avalé** : le qualificatif partait à la
poubelle et la règle valait `forward`. Il est désormais **refusé**, avec
tout autre mot après `forward` ou `drop`.

**Cette conclusion a d'abord été l'inverse, et la correction vaut d'être
racontée.** La première version de ce lot ACCEPTAIT `forward capture` et
`drop log`, en s'appuyant sur une page de documentation qui écrit bien
`action {drop [log] | forward [capture | vlan <id>] | redirect ...}` —
mais celle d'un **IR8340 sous IOS-XE 17.14**. Or ce shell modélise un
C2960 sous 15.0(2)SE11 et un C3560 sous 12.2(55)SE12
(`CiscoPlatform.ts`), dont la référence de commandes est sans
ambiguïté : `action` y prend `drop` et `forward`, et *« Neither
`capture` nor `log` are among the accepted keywords »*. Accepter ces
deux mots ajoutait donc à la machine des commandes que le vrai matériel
refuse — précisément le défaut que ces audits ferment, commis en le
corrigeant. C'est `CLAUDE.md` §8 : choisir l'autorité **avant** de la
citer, et une page d'une autre plateforme n'en est pas une.

## 4. Ce qui était juste — et trois fausses pistes

**Juste, et vérifié plutôt que supposé :**

- **Le VACL coupe vraiment.** `vaclPermits` est appelé à l'ingress, avant
  la décision de commutation. 0 % de perte avant, 100 % après.
- **Le refus implicite de fin de carte** est appliqué : du trafic IP
  n'appariant aucune séquence est rejeté, comme sur IOS.
- **Une ACE `deny` est un classifieur qui n'apparie pas**, et non un
  rejet : on tombe dans la séquence suivante. C'est le point le plus
  facile à inverser de tout le sujet.
- **`evaluateACLByName` est le bon point d'entrée ici**, et non
  `evaluateForDataPlane` : ce dernier applique la politique du
  constructeur pour un paquet non apparié, ce qui — sur le moteur partagé
  avec VRP, dont la politique est `permit` — ferait apparier **tout**
  paquet. La question posée par une clause `match` n'est pas « ce paquet
  est-il autorisé ? » mais « apparie-t-il une ACE `permit` ? ».
- **Une clause visant une ACL inexistante n'apparie rien** et laisse
  tomber dans la suite — cohérent avec la référence en avant déjà admise
  ailleurs (`ip nat inside source list`).
- **Les séquences sont évaluées triées**, même saisies à l'envers.

**Trois fausses pistes, écartées en mesurant mieux** plutôt qu'en
corrigeant du code juste — elles sont consignées parce qu'un audit qui ne
dit pas ce qu'il a écarté laisse croire qu'il a tout vu :

1. *« `show vlan filter` n'affiche jamais de VLAN actif »* — le
   laboratoire de la sonde ne **créait pas** le VLAN. Le rendu distingue
   correctement « configuré » et « actif ».
2. *« `show vlan access-map <nom>` ignore son argument »* — la sonde
   n'avait qu'**une** carte, donc ne discriminait rien.
3. *« le rejeu d'une configuration ne restaure rien »* — la sonde rejouait
   ligne à ligne au lieu d'appeler **`replayVendorConfig`**, qui revient à
   la vue de base entre deux blocs. C'est le vrai chemin d'import, et
   c'est lui qu'il fallait mesurer.

---

## 5. Ce qui reste

- **`match mac address` est désormais implémentée** (voir le commit du
  même nom). Elle a demandé bien plus que la clause : la référence
  énonce une règle **par type de paquet** — *« If there is a match clause
  for that type of packet (IP or MAC) in the VLAN map, the default action
  is to drop […]. If there is no match clause for that type of packet,
  the default is to forward »* — alors que `vaclPermits` finissait par un
  `return false` inconditionnel. Juste tant qu'une carte portait une
  clause IP ou une entrée sans clause ; **faux** dès qu'une carte ne
  porte que des clauses MAC, l'IP y tombant dans un refus qu'aucune
  clause ne prononce.
- **`match ipv6 address` reste refusée, et c'est JUSTE** — vérifié après
  coup, la première rédaction de ce rapport le présentant à tort comme
  un manque. Les deux plateformes modélisées sont un C2960 sous
  15.0(2)SE11 et un C3560 sous 12.2(55)SE12 (`CiscoPlatform.ts`), et le
  guide de cette version tranche : *« You can configure VLAN maps to
  match Layer 3 addresses for **IPv4** traffic »*, la clause `match` n'y
  prenant que `ip address` et `mac address`. Les cartes de VLAN pour
  IPv6 existent sur d'**autres** modèles (3560-CX / 2960-CX sous
  15.2(7)E) et sont explicitement absentes des 2960-X et 2960-L.
  L'implanter ici ferait diverger le simulateur du matériel qu'il
  déclare être. La conséquence — une trame IPv6 traverse un VLAN filtré
  sans être évaluée — est donc elle aussi le comportement du vrai
  matériel, et non une limite à lever.
- **`action redirect` est refusé** faute de pouvoir honorer l'action
  principale : rediriger vers un port n'est pas modélisé, et le rabattre
  sur `forward` serait plus faux que le refus.
- **VRP n'a pas de `traffic-filter vlan <n> inbound`**, son équivalent de
  VACL. La commande est refusée (elle n'existe pas), donc honnête ;
  consignée dans `TODO.md`.
- **`vlan filter <nom> interface <type> <n>`**, la seconde forme de la
  liaison, n'est pas modélisée — seule `vlan-list` l'est.

---

## Annexe — Reproduction

```bash
npx vitest run src/__tests__/audit/
```

117 tests couvrant les six surfaces : routeur Cisco, routeur VRP,
commutateur VRP, commutateur Cisco, ACL IPv6, VACL. **Chaque test assoit
le comportement juste ; un échec est une régression.**
