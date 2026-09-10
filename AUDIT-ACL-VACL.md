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
| W-04 | `action forward capture` / `drop log` **silencieusement rabattus** | 🟡 Moyen | **✅ corrigé** |
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

### `capture` et `log` sont gardés

`action forward capture` et `action drop log` sont **stockés et rendus**
plutôt que refusés : l'action principale (`forward` / `drop`) est honorée
pour de bon, et seul l'effet secondaire — copie vers un port de capture,
journalisation — n'est pas modélisé. C'est la nuance de `CLAUDE.md` §6 :
une commande qu'une vraie machine accepte et dont on honore l'essentiel
est stockée, sans quoi un import de topologie la perdrait. Un qualificatif
inconnu, lui, est refusé.

---

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

- **`match mac address` et `match ipv6 address` sont refusés.** Ce sont de
  vraies clauses d'IOS, et le refus est honnête plutôt que silencieux.
  La moitié MAC vient de se réduire pendant ce lot : le commit
  `0f9e7ebaa` d'un autre agent a apporté `switch/MacAccessList.ts` et
  `evaluateMacAcl`, donc la brique existe. Ce qui reste est un **câblage**
  et non une absence — cette évaluation est liée au **port**, pas au
  VLAN, et `vaclPermits` sort par sa première ligne dès que la trame
  n'est pas `ETHERTYPE_IPV4`, c'est-à-dire exactement pour les trames
  qu'une liste MAC regarde. La sémantique est déjà établie par la
  référence que ce commit cite — une liste IP ne filtre **que** l'IP, une
  liste MAC **que** le non-IP — et l'inverser apprendrait le contraire
  d'un vrai Catalyst. Côté IPv6 rien n'a bougé : les listes vivent sur le
  routeur, le commutateur n'ayant pas de vue `ipv6 access-list`.
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
