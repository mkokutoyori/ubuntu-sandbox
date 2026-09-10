# Audit — Les ACL IPv6

**Périmètre :** `Ipv6AclEngine`, `ipv6 access-list` / `ipv6 traffic-filter` (IOS), `acl ipv6` (VRP)
**Date :** 10 septembre 2026
**Branche auditée :** `mandeng`
**Méthode :** lecture, banc de mesure exécutable, référence constructeur relue en ligne
**Rapports jumeaux :** `AUDIT-ACL-CISCO.md`, `AUDIT-ACL-HUAWEI.md`, `AUDIT-ACL-HUAWEI-SWITCH.md`, `AUDIT-ACL-CISCO-SWITCH.md`

> **Coordination.** Un autre agent refond le système de commandes Cisco
> (`src/cli/**`, le pont de `CiscoShellBase`, la table `socle` de
> `CiscoIOSShell`, `aclHeadSpecs.ts`). Ce lot ne touche à aucun de ces
> fichiers. `src/__tests__/unit/cli/` passe (86 fichiers, 3312 cas).

---

## 0. État des corrections

> **Les dix-huit constats sont corrigés.**
>
> ```bash
> npx vitest run src/__tests__/audit/   # 105 tests, 5 surfaces
> ```
>
> Discrimination par `git stash` des sept fichiers du lot : **19 des 23
> cas tombent authentiquement**. Les 4 restants sont nommés dans
> l'en-tête de la sonde.

---

## 1. Verdict

**Un pare-feu IPv6 se rechargeait en `permit` universel, sans un mot.**

C'est le constat le plus grave des cinq rapports, et il tient en trois
lignes mesurées. La configuration rendue portait la **liaison** :

```
 ipv6 address 2001:db8:1::1/64
 ipv6 traffic-filter BLOQUE in
ipv6 unicast-routing
```

et **jamais la liste `BLOQUE`**. `getIpv6AccessLists()` avait six
lecteurs et **aucun rendu de configuration**. Or une configuration
rendue est rejouée à l'import d'une topologie, et le moteur répond
`permit` pour une liste absente — ce qui est le comportement d'IOS et
n'est pas le défaut. Le défaut est qu'après un aller-retour la liaison
désignait une liste que rien ne recréait.

### La différence avec les quatre rapports précédents

Le commutateur Huawei gardait une **règle fantôme** : il sur-bloquait,
donc l'opérateur le voyait. Ici, c'est l'inverse — **on ouvre**. Une
topologie sauvegardée avec un filtre IPv6, rouverte, filtre zéro et
l'affiche nulle part. Il n'existait aucune vue permettant de s'en
apercevoir : `show ipv6 access-list` était vide parce que la liste
n'existait plus, ce qui **ressemble à une machine jamais configurée**.

### Et le reste était du décor

L'analyseur terminait sa boucle par un `i++` nu — le même défaut que
S-03 sur le commutateur VRP et C-06 sur le commutateur Cisco. Mesuré :

| Frappe | Ce qui était rangé | Effet réel |
|---|---|---|
| `permit tcp any any established` | `permit tcp any any` | **laisse passer un SYN** |
| `deny tcp any any eq telnet` | `dstPort: "telnet"` | **ne correspond à rien** |
| `deny tcp any any gt 1000` | `deny tcp any any` | refuse **tout** le TCP |
| `deny tcp any eq 80 any` | `dstPrefix: "eq"` | ne correspond à rien |
| `deny icmp any any echo-request` | `deny icmp any any` | refuse aussi les **réponses** |
| `deny ipv6 any any dscp 46` | `deny ipv6 any any` | **coupe le lien** |

Les cinq mots-clés `dscp`, `flow-label`, `fragments`, `routing` et
`undetermined-transport` produisaient **cinq entrées identiques** :
`deny ipv6 any any`. Cinq règles différentes, un seul effet, et c'est le
pire possible.

`permit tcp any any established` mérite d'être isolée : c'est **l'idiome
le plus tapé de toutes les ACL IPv6**, celui qui laisse rentrer les
réponses et rien d'autre. Il laissait rentrer les ouvertures.

---

## 2. Les dix-huit constats

| Id | Constat | Gravité | État |
|---|---|---|---|
| V-01 | La configuration rendait la **liaison** et jamais la **liste** : rechargement en `permit` universel | 🔴 Bloquant | **✅ corrigé** |
| V-02 | `established` accepté et **jeté** : un SYN passait | 🔴 Bloquant | **✅ corrigé** |
| V-03 | Un port par **nom** ne correspondait à rien (`eq telnet` inerte) | 🔴 Bloquant | **✅ corrigé** |
| V-04 | Le port **source** était lu comme un préfixe de destination | 🔴 Bloquant | **✅ corrigé** |
| V-05 | Jeton inconnu **avalé en silence** | 🔴 Bloquant | **✅ corrigé** |
| V-06 | `dscp`/`flow-label`/`fragments`/`routing`/`undetermined-transport` jetés — cinq règles, un `deny` total | 🔴 Bloquant | **✅ corrigé** |
| V-07 | `icmp-type` jeté : `deny … echo-request` refusait les réponses | 🔴 Bloquant | **✅ corrigé** |
| V-08 | Tout opérateur autre qu'`eq` jeté : `gt 1000` refusait le port 500 | 🔴 Bloquant | **✅ corrigé** |
| V-09 | **Aucun moyen de supprimer une entrée** : `no …` et `no <seq>` refusés | 🔴 Bloquant | **✅ corrigé** |
| V-10 | VRP : `acl ipv6 name` créait une ACL **IPv4** sous un nom IPv6 | 🔴 Bloquant | **✅ corrigé** |
| V-11 | Évaluation dans l'ordre de **frappe**, pas de séquence | 🟠 Haut | **✅ corrigé** |
| V-12 | Protocole numérique jamais reconnu, et le jeton **consommé deux fois** | 🟠 Haut | **✅ corrigé** |
| V-13 | Aucune numérotation automatique | 🟠 Haut | **✅ corrigé** |
| V-14 | `log` rangé, **rien n'était émis** | 🟠 Haut | **✅ corrigé** |
| V-15 | `show ipv6 access-list` sans compteur ni séquence | 🟡 Moyen | **✅ corrigé** |
| V-16 | Port hors bornes (`99999`) et séquence non numérique acceptés | 🟡 Moyen | **✅ corrigé** |
| V-17 | `permit any any` accepté, rangé, ne correspondant jamais | 🟡 Moyen | **✅ corrigé** |
| V-18 | Port rendu par numéro là où IOS rend le nom | 🟡 Moyen | **✅ corrigé** |

---

## 3. Ce qui a été fait

### Un vocabulaire, pas un second

`router/acl/Ipv6AclSyntax.ts` déclare ce qui est propre à IPv6 — les
protocoles (`icmp` vaut **58** et non 1, le joker s'écrit `ipv6`), les
noms de messages ICMPv6 (`nd-na`, `nd-ns`, `no-route`…) — et **réutilise**
`AclSyntax.ts` pour ce qui ne l'est pas : `parseAclPort` connaît déjà les
noms de service et les bornes, `parseAclPortSpec` les cinq opérateurs.
Une seconde table des ports aurait fini par accepter en IPv6 ce qu'IPv4
refuse.

### Un analyseur qui refuse

`parseIpv6Ace` lit la grammaire dans l'ordre du constructeur —
protocole, source, **opérateur de port source**, destination, opérateur
de port destination, queue — et **refuse tout jeton qu'il ne sait pas
placer**. C'est la règle du dépôt : un critère qu'on n'évalue pas est
refusé à l'analyse plutôt que rangé.

### Ce qui est évalué, et ce qui échoue fermé

`fragments`, `routing` et `undetermined-transport` sont **acceptés,
rendus, et font échouer la correspondance** : `IPv6Packet` ne porte ni
en-tête de fragmentation ni en-tête de routage, donc le moteur ne sait
pas trancher — et un critère intranchable fait échouer, jamais réussir.
C'est le précédent d'`optionName` dans `ACLEngine`. La conséquence est
écrite et vérifiée par test : une règle `dscp 46` **ne coupe pas** le
trafic qui ne porte pas ce DSCP.

`time-range` est le seul de la queue qui soit vraiment évalué : le
routeur passe au moteur IPv6 **le résolveur qu'utilise déjà l'IPv4**,
plutôt qu'une seconde règle horaire.

### Un contexte par équipement, pas un singleton

Le journal et l'horloge arrivent par un `Ipv6AclContext` que le routeur
construit. Un puits de journal au niveau du module aurait été partagé
par deux routeurs d'un même test — un défaut que j'aurais introduit en
corrigeant V-14.

### La bonne facilité syslog

`log` émet `%IPV6_ACL-6-ACCESSLOGP`, **et non** le `%SEC-…-IPACCESSLOGP`
d'IPv4. Router l'IPv6 dans l'événement d'IPv4 aurait marqué un paquet
IPv6 du mnémonique IPv4 : un second mensonge posé en corrigeant le
premier.

### La séquence gouverne

Numérotation automatique **10 puis +10**, évaluation **triée par
séquence** et non par ordre de frappe, et **une séquence en double
REMPLACE** — ce qui est propre à IPv6, là où IPv4 refuse
(`% Duplicate sequence number`). Cette asymétrie n'est pas une
simplification : elle est chez le constructeur, et le lot Cisco IPv4
l'avait déjà établie dans l'autre sens.

### VRP : refusé, en nommant la brique manquante

`acl ipv6 name V6` rangeait la liste dans le magasin **IPv4**, avec le
type `extended`, sous une vue dont l'invite annonçait `acl-adv-V6`. Or
cette vue ne pouvait même pas accepter une adresse IPv6 : son analyseur
de règle valide en IPv4 et refusait `2001:db8::/64`. C'était donc une
ACL IPv6 **entièrement non fonctionnelle qui en avait l'apparence**.

Il n'y a par ailleurs sur VRP ni table de règles ACL6, ni
`traffic-filter ipv6`, ni liaison de plan de données (`HuaweiRouter` ne
surcharge pas `getIpv6TrafficFilter`). Construire la liste aurait donc
créé **un magasin que personne ne lit** — exactement le défaut que ces
cinq audits referment. La commande est refusée **en nommant ce qui
manque**, comme `vpn-instance` l'est déjà dans `HuaweiAclRule.ts` et
comme NQA refuse ses types de test. Le drapeau `ipv6` de la grammaire,
que plus personne ne positionne, est supprimé plutôt que laissé mort.

`CLAUDE.md` §6 porte une nuance qui s'applique ici et a été pesée :
une commande qu'une vraie machine accepte **peut** être stockée plutôt
que refusée, pour qu'un import de topologie ne la perde pas. Elle ne
mord pas dans ce cas — **aucune règle ne pouvait être stockée**, donc
il n'y a pas de configuration à perdre, et l'accepter reconduirait le
mensonge. Le report est écrit dans `TODO.md` avec l'ordre de
construction : la liaison de plan de données **d'abord**.

---

## 4. Ce qui était juste

- **La permission implicite de la découverte de voisins** était là,
  correcte, et à la bonne place — **après** les entrées de l'opérateur,
  de sorte qu'un `deny ipv6 any any` explicite coupe vraiment le lien.
  C'est le piège d'IOS, et le reproduire est plus juste que l'éviter.
- **`remark` et `evaluate` échouaient déjà fermé**, chacun pour la bonne
  raison, et l'en-tête du moteur disait laquelle.
- **Le filtre posé sur un lien vivant coupait déjà le ping** : l'acquis
  de `ipv6-traffic-filter-really-filters`, dont ce lot ne refait rien.
- **Une liste absente laisse passer** — c'est IOS, et c'est ce qui rend
  V-01 dangereux plutôt que visible.

---

## 5. Ce qui reste

- **VRP n'a pas d'ACL6.** La commande est refusée en le disant. Lui en
  donner une suppose une table de règles, `traffic-filter ipv6` et une
  liaison de plan de données : un lot à part, et dans cet ordre — la
  liaison d'abord, sans quoi le reste ne serait lu par personne.
- **`fragments` / `routing` / `undetermined-transport` échouent fermé**
  faute d'en-têtes d'extension sur `IPv6Packet`. Le jour où ils
  existent, le moteur suit sans changer de forme.
- **`reflect` est rangé et rendu, sans table de session** ; `evaluate`
  échoue fermé en conséquence. Les deux moitiés sont cohérentes, aucune
  ne fonctionne.
- **Le commutateur Cisco n'a pas de vue `ipv6 access-list`** — les ACL
  IPv6 restent une affaire de routeur ici.
- **`%SEC-4-IPACCESSLOGP` (IPv4) porte la sévérité 4 là où IOS écrit 6.**
  Constat trouvé en chemin, **non corrigé** : il est antérieur, propre à
  IPv4, et le changer ici serait du bruit dans un lot IPv6.

---

## Annexe — Reproduction

```bash
npx vitest run src/__tests__/audit/
```

105 tests couvrant les cinq surfaces : routeur Cisco, routeur VRP,
commutateur VRP, commutateur Cisco, ACL IPv6. **Chaque test assoit le
comportement juste ; un échec est une régression.**
