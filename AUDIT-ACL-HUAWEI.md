# Audit — Implémentation des listes de contrôle d'accès (ACL) Huawei VRP

**Périmètre :** ACL IPv4 sur routeurs et commutateurs Huawei simulés
**Date :** 17 août 2026
**Branche auditée :** `mandeng`
**Méthode :** lecture intégrale du code, banc de preuves exécutable, confrontation à la documentation Huawei officielle
**Rapport jumeau :** `AUDIT-ACL-CISCO.md` — le moteur d'évaluation est **partagé**

---

## 0. État des corrections

> **Les quatorze constats sont corrigés.**
>
> Le corps du rapport décrit l'état **au moment de l'audit** ; il est conservé
> tel quel comme constat daté. La colonne « État » du tableau §3 donne la
> situation à jour.
>
> ```bash
> npx vitest run src/__tests__/audit/   # 53 tests : 34 Cisco + 19 VRP
> ```

---

## 1. Verdict

**L'implémentation VRP ne filtrait pas ce qu'on lui demandait de filtrer, et
filtrait ce qu'on ne lui avait pas demandé.**

Le moteur d'évaluation étant partagé avec Cisco, les dix-neuf constats du
rapport jumeau valaient déjà pour VRP, et leur correction lui profite. Ce qui
suit est ce qui reste **propre à Huawei** — et le plus grave n'est pas un bug de
parseur, c'est une **sémantique importée**.

### Le constat central : une convention Cisco appliquée à VRP

Sur Huawei, l'action appliquée à un paquet **qu'aucune règle n'apparie**
[est décidée par le service qui applique la liste, pas par la liste](https://support.huawei.com/enterprise/en/doc/EDOC1000178175/e9b94643/configuring-acl-based-packet-filtering) :
`traffic-filter` **laisse passer**, tandis qu'un contrôle d'accès de vty refuse.
IOS, lui, refuse toujours — c'est le *deny* implicite.

Le moteur imposait la réponse d'IOS à tout le monde. Conséquence, mesurée :

```
[AR1] acl 3000
[AR1-acl-adv-3000] rule 5 deny ip source 10.0.0.0 0.0.0.255 destination any
[AR1-GigabitEthernet0/0/0] traffic-filter inbound acl 3000
```

| Paquet | VRP réel | Ce simulateur |
|---|---|---|
| depuis `10.0.0.5` | **deny** | deny ✅ |
| depuis `192.168.1.1` | **permit** | **deny** ❌ |

L'ACL la plus banale de tous les cours Huawei — « bloquer un sous-réseau » —
**coupait tout le reste du réseau**. Et le symptôme est trompeur au dernier
degré : l'opérateur voit sa règle « fonctionner » (le trafic visé est bien
bloqué) et conclut que le reste de la panne vient d'ailleurs.

### Le second : sept critères acceptés puis jetés

`icmp-type`, `tcp-flag`, `dscp`, `precedence`, `tos`, `fragment`, `time-range`
figuraient dans une liste de mots-clés servant à décider « ceci n'est pas un
nom de protocole » — et **n'étaient lus par personne d'autre**. Mesuré :

```
rule 5 deny icmp source any destination any icmp-type echo
```

refusait les **réponses** echo aussi bien que les requêtes : le critère
disparaissait, la règle dégénérait en `deny icmp`. Même chose pour `tcp-flag`.

Et comme les deux boucles d'analyse — il y en avait deux, presque identiques —
terminaient par un `i++` nu, **tout mot-clé inconnu était avalé sans un mot** :
`destinaton-port eq 80` (faute de frappe) produisait une règle sans critère de
port, acceptée en silence.

---

## 2. Ce que l'architecture partagée a fait gagner, et coûter

Le moteur unique est globalement un bon choix : les dix-neuf correctifs Cisco
— `remark` qui n'ouvre plus, drapeaux TCP évalués, critères non tranchables qui
échouent fermés — ont bénéficié à VRP **sans une ligne de code Huawei**.

Mais il a coûté exactement là où les deux vendeurs divergent, et il l'a fait
deux fois de la même façon : **une convention d'un vendeur câblée en dur dans
le moteur commun**.

| Question | Réponse d'IOS | Réponse de VRP | Ce que le moteur faisait |
|---|---|---|---|
| 2000–2699, quel type ? | étendue | *basic* (source seule) | la réponse **VRP**, câblée — cassait Cisco (constat F-09) |
| Paquet non apparié ? | refusé | dépend du service | la réponse **IOS**, câblée — cassait VRP (H-12) |
| Numéro d'une règle auto ? | dernier + 10 | multiple du pas suivant | la réponse **IOS** |
| Pas par défaut ? | 10 | 5 | affiché « 5 » en dur, calculé à 10 |

Le même défaut, dans les deux sens. La correction est la même dans les deux
cas : **le vendeur pose sa règle, le moteur n'en devine aucune** — trois
politiques injectées (`AclNumbering`, `AclSequencing`, action par défaut du plan
de données), posées par `HuaweiRouter` et `HuaweiSwitch` dans leur constructeur.

---

## 3. Les quatorze constats

| Id | Constat | Gravité | Nature | État |
|---|---|---|---|---|
| H-12 | Paquet non apparié **refusé** : une ACL VRP de `deny` coupait tout | 🔴 Bloquant | Fond | **✅ corrigé** |
| H-03 | `icmp-type` / `tcp-flag` acceptés puis **jetés** | 🔴 Bloquant | Fond | **✅ corrigé** |
| H-03b | `dscp` / `precedence` / `tos` / `fragment` / `time-range` de même | 🔴 Bloquant | Fond | **✅ corrigé** |
| H-01 | ACL de base : mot-clé inconnu **avalé en silence** | 🔴 Bloquant | Fond | **✅ corrigé** |
| H-02 | ACL avancée : idem | 🔴 Bloquant | Fond | **✅ corrigé** |
| H-05 | Numéro de règle **calculé à l'affichage** (`index × 5`), ≠ du stocké | 🟠 Haut | Fond | **✅ corrigé** |
| H-07 | **`undo rule` n'existait pas** : aucune règle supprimable | 🟠 Haut | Fond | **✅ corrigé** |
| H-13 | Numérotation auto au pas d'IOS (10) au lieu du pas VRP (5) | 🟠 Haut | Fidélité | **✅ corrigé** |
| H-04 | `step` stocké dans une propriété ad hoc, **lu par personne** | 🟡 Moyen | Fond | **✅ corrigé** |
| H-06 | `description` stockée, **rendue nulle part** | 🟡 Moyen | Fond | **✅ corrigé** |
| H-09 | `traffic-filter` refusait une ACL **nommée** | 🟡 Moyen | Fidélité | **✅ corrigé** |
| H-10 | `display acl` **refusé depuis la vue ACL** | 🟡 Moyen | Fidélité | **✅ corrigé** |
| H-08 | ACL existante mais vide annoncée **inexistante** | 🟡 Moyen | Fidélité | **✅ corrigé** |
| H-11 | Corps de règle **vide** à l'affichage (`rule 0 permit`) | 🟢 Faible | Forme | **✅ corrigé** |

---

## 4. Le détail de ce qui a été corrigé

### H-12 — La sémantique, rendue au vendeur

`ACLEngine.evaluateForDataPlane()` est nouveau, et il est le **seul** point qui
applique la règle du vendeur pour un paquet non apparié. `Router` (les deux
plateformes) et `Switch` l'appellent pour `ip access-group` / `traffic-filter`.

Ce qui n'a **pas** changé, et c'est le point délicat : `evaluateACLByName()`
garde le refus par défaut, parce que NAT, vty, NTP et IPSec posent une autre
question — « cette liste DÉSIGNE-t-elle ce trafic ? » — dont la réponse est non
en l'absence de règle, sur les deux plateformes. Les deux sémantiques coexistent
donc, chacune chez son consommateur, et un test le pin dans les deux sens.

**Le test porte un témoin Cisco monté dans le même cas.** Sans lui, un moteur
qui répondrait « permit » à tout le monde serait indiscernable d'une sémantique
correctement distinguée — c'est la précaution que le rapport Cisco avait déjà
imposée pour les clés IKE par nom.

### H-03 — Les critères, évalués

`HuaweiAclRule.ts` remplace les deux boucles jumelles par une analyse unique
paramétrée par la vue (*basic* / *advanced*). Elle lit `icmp-type` (noms VRP
traduits vers ceux que le moteur évalue — `fragmentneeded-DFset` → code 4,
`host-redirect` → `redirect`, et la forme numérique `icmp-type <type> <code>`),
`tcp-flag` (avec la sémantique VRP : **tous** les drapeaux nommés doivent être
posés, donc `match-all`), `dscp`, `precedence`, `tos`, `fragment`, `time-range`
et `logging`.

**`vpn-instance` est refusé** plutôt que stocké : rien ici ne porte de plan de
transfert par instance, et l'accepter ferait croire à un filtrage qui n'a pas
lieu. C'est la règle du dépôt — *ne jamais stocker un critère qu'on n'évalue
pas* — appliquée à VRP.

### H-05 — Un seul numéro par règle

Le numéro était **calculé à l'affichage** (`index × 5`) tandis qu'un **autre**
numéro était stocké (10, 20 — le pas d'IOS). Deux nombres pour la même règle,
et celui qu'affichait la machine n'était celui d'aucun magasin : il changeait
dès qu'une règle était insérée ou supprimée, et `undo rule <id>` — s'il avait
existé — aurait visé le mauvais.

`VRP_SEQUENCING` implémente la règle réelle : *le multiple du pas suivant*. Une
liste contenant la règle 7 avec un pas de 5 numérote la suivante **10**, et non
17 — ce n'est pas la formule d'IOS, et c'est pinné par test.

### H-04, H-06 — Ce qui était rangé nulle part

`step` et `description` vivaient dans `router._huaweiAclStep` et
`router._huaweiAclDesc`, deux `Map` accrochées au routeur par un `as any` et
**lues par personne**. La vue annonçait `ACL's step is 5` en dur — donc mentait
dès qu'on écrivait `step 10` — et la description n'était rendue ni par la vue ni
par la configuration, donc perdue au rechargement d'une topologie.

Elles vivent désormais sur la liste (`AccessList.step` / `.description`), sont
lues par la numérotation, par la vue et par `display current-configuration`.

### H-08 — Exister et être vide sont deux états

`display acl 2000` répondait `Error: ACL 2000 does not exist or has no rules.`
— une phrase qui confond deux situations et envoie chercher une faute de frappe
là où il manque simplement une règle. La cause était plus profonde : **`acl 2000`
ne créait pas la liste**, seulement la vue ; elle n'existait qu'à la première
règle. C'est aussi pourquoi `step` et `description` tapés juste après n'avaient
rien où se poser.

La liste existe désormais dès l'ouverture de sa vue, et une liste vide s'affiche
avec ses 0 règle. Une liste jamais créée reste inexistante — les deux cas sont
distingués, et testés.

---

## 5. Ce qui était juste

- **La grammaire de `acl`** (`HuaweiAclGrammar.ts`) est un bon fichier, et son
  en-tête raconte honnêtement le défaut qu'il a refermé : deux grammaires
  divergentes entre routeur et commutateur. Elle borne les numéros, connaît
  `advance` autant qu'`advanced`, et refuse les plages L2/utilisateur en nommant
  la borne tenue plutôt qu'en ouvrant une vue inutile.
- **`traffic-filter` était correctement branché** au plan de données, dans les
  deux directions.
- **`sequenceConfigured`** distinguait déjà le numéro écrit par l'opérateur de
  celui attribué par la machine — la bonne notion existait, elle n'était
  simplement pas reliée au bon calcul.
- Les commentaires du fichier documentaient un défaut réel déjà corrigé (le
  numéro de règle consommé deux fois), signe d'un entretien attentif.

---

## 6. Ce qui reste, et qui est dit plutôt que tu

- **Les compteurs `(N matches)`** de `display acl` ne comptent que ce que le
  plan de données a évalué. C'est correct, mais VRP affiche aussi des compteurs
  par règle sur les ACL appliquées en QoS, ce qui n'existe pas ici.
- **Les ACL L2 (4000-4999) et utilisateur (5000-5999)** restent refusées, comme
  avant l'audit : aucune n'est évaluable, et la grammaire le dit.
- **`display acl` ne pagine pas** et n'a pas la forme longue `display acl all`
  de certaines plateformes.
- **Le commutateur Huawei** partage désormais les trois politiques VRP, mais son
  shell garde sa propre table de règles (`HuaweiSwitchShell`) à côté du moteur —
  c'est une divergence connue et antérieure, hors du périmètre de cet audit.

---

## Sources

- [Configuring ACL-based Packet Filtering — Huawei](https://support.huawei.com/enterprise/en/doc/EDOC1000178175/e9b94643/configuring-acl-based-packet-filtering) — un paquet non apparié est transmis sous `traffic-filter`
- [ACLs Applied to a Traffic Policy — Huawei](https://info.support.huawei.com/hedex/api/pages/EDOC1100277644/AEM10221/04/resources/ne/dc_ne_acl4_feature_0009.html) — le sort d'un paquet non apparié dépend du module de service
- [Adjusting the Step of ACL Rules — Huawei](https://support.huawei.com/enterprise/en/doc/EDOC1100034077/cc90b313/adjusting-the-step-of-acl-rules) — pas par défaut 5, première règle numérotée 5
- [traffic-filter (interface view) — Huawei](https://info.support.huawei.com/hedex/api/pages/EDOC1100334321/AEM1020X/05/resources/dc/traffic-filter_interface_view.html) — `{ acl-number | name acl-name }`

## Annexe — Reproduction

```bash
npx vitest run src/__tests__/audit/
```

53 tests : 34 pour Cisco, 19 pour VRP. **Chaque test assoit le comportement
juste ; un échec est une régression.** Le fichier VRP porte un témoin Cisco sur
la sémantique du paquet non apparié — sans lui, la distinction ne serait pas
prouvée.
