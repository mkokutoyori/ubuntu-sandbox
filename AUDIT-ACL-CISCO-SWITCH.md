# Audit — Les ACL du commutateur Cisco

**Périmètre :** `CiscoSwitchShell` — `access-list`, vue d'ACL nommée, `show access-lists`
**Date :** 17 août 2026
**Branche auditée :** `mandeng`
**Méthode :** lecture, banc de preuves exécutable, comparaison au routeur IOS corrigé
**Rapports jumeaux :** `AUDIT-ACL-CISCO.md`, `AUDIT-ACL-HUAWEI.md`, `AUDIT-ACL-HUAWEI-SWITCH.md`

> **Coordination.** Un autre agent refond le système de commandes Cisco
> (`src/cli/**`, le pont de `CiscoShellBase`, la table `socle` de
> `CiscoIOSShell`). Ce lot ne touche à aucun de ces fichiers, et n'inscrit
> aucun chemin migré : `migratedPaths()` du commutateur rend `[]`, et les
> trois familles migrées (`tunnel`, `clear crypto`, `show crypto`) ne
> concernent que le routeur. Le garde-fou `migration-guard.test.ts` passe.

---

## 0. État des corrections

> **Les neuf constats sont corrigés.**
>
> ```bash
> npx vitest run src/__tests__/audit/   # 82 tests, 4 plateformes
> ```

---

## 1. Verdict

**Le commutateur Cisco avait le même défaut que le commutateur Huawei —
deux magasins — et il l'avait en pire.**

Un écho verbatim du texte tapé, affiché par `show access-lists`, à côté des
entrées du moteur, qui seules filtrent. Alimentés par deux chemins.

### La divergence muette

```
SW1(config)# ip access-list extended BLOCK
SW1(config-acl)# deny tcp any any
SW1(config-acl)# no deny tcp any any
```

| Question | Réponse |
|---|---|
| `show access-lists` montre-t-il encore la règle ? | **non** |
| Le moteur refuse-t-il encore ? | **oui — `deny`** |

`no` était traité comme les quatre autres mots-clés — poussé dans le magasin
de texte — et **n'atteignait jamais le moteur**. Une règle supprimée
continuait de filtrer. Exactement S-01 du rapport commutateur Huawei, sur
l'autre plateforme.

### Ce qui était pire

L'analyseur du commutateur, `parseSwitchAclLine`, ne lisait que **protocole,
source, destination**. Tout le reste était jeté sans un mot :

```
SW1(config-acl)# deny tcp any any eq 22      ← `eq 22` jeté
```

Cette règle refusait **tout le TCP**, port 80 compris. Mesuré. Et
`show access-lists` affichait fidèlement `eq 22`, puisqu'il lisait le texte —
**la vue montrait un critère dont le moteur n'avait aucune trace**.

Même sort pour `established`, `icmp-type`, `log`, `dscp`, `time-range`,
`fragment` : `deny icmp any any echo` refusait aussi les *réponses*.

### Et une entrée qui disparaissait entièrement

```
SW1(config-acl)# 10 deny ip any any
```

`% Invalid input detected` — mais sur le **routeur**, la même frappe
fonctionne. La cause est fine : `CiscoShellBase` réécrit déjà un chiffre
initial en `sequence <…>` dans une sous-vue d'ACL, seulement
`isAclSubMode()` connaît `config-std-nacl` / `config-ext-nacl` /
`config-ipv6-nacl` — et le commutateur nomme la sienne `config-acl`. La
forme numérotée nue d'IOS, celle qu'on tape, était donc refusée sur une
plateforme et acceptée sur l'autre.

---

## 2. Les neuf constats

| Id | Constat | Gravité | État |
|---|---|---|---|
| C-01 | `no ...` n'atteignait pas le moteur : **la règle continuait de filtrer** | 🔴 Bloquant | **✅ corrigé** |
| C-04 | Critères de **port jetés** : `deny tcp any any eq 22` refusait tout le TCP | 🔴 Bloquant | **✅ corrigé** |
| C-05 | `established` / `icmp-type` / `log` / `dscp` jetés de même | 🔴 Bloquant | **✅ corrigé** |
| C-06 | Jeton inconnu **avalé en silence** | 🔴 Bloquant | **✅ corrigé** |
| C-03 | La forme numérotée nue `10 permit …` **disparaissait des deux magasins** | 🟠 Haut | **✅ corrigé** |
| C-09 | La vue affichait un critère absent du moteur | 🟠 Haut | **✅ corrigé** |
| C-02 | `show access-lists` déduisait le type de « est-ce un nombre ? » — `access-list 100` s'annonçait **Standard** | 🟡 Moyen | **✅ corrigé** |
| C-07 | `ip access-list standard` sans nom créait une liste **nommée « standard »** | 🟡 Moyen | **✅ corrigé** |
| C-08 | `show access-lists` échoait les `no` comme des règles | 🟡 Moyen | **✅ corrigé** |

Les neuf n'en font qu'un : **deux magasins**.

---

## 3. Ce qui a été fait

### Un magasin

`this.acls` est supprimée. Le moteur est le seul magasin ; `access-list`,
`ip access-list`, les cinq mots-clés de la vue nommée et la forme numérotée
y écrivent tous, et `show access-lists` en lit.

### Une analyse, partagée avec le routeur

`parseSwitchAclLine` et `parseAclAddressSpec` — le **troisième** analyseur
d'ACE Cisco du dépôt — sont supprimés. `CiscoAclCommands` exporte désormais
`parseCiscoAce(args, type, sequence?)`, extrait des deux fermetures qui
vivaient dans ses constructeurs de commandes, et le commutateur l'appelle.
Il hérite d'un coup de tout ce que le lot F-01→F-19 avait donné au routeur :
ports, `established`, drapeaux TCP, `icmp-type` avec discrimination par code,
`dscp`, `log`, `time-range`, et le **refus** de tout jeton inconnu.

### Un rendu

`showAccessListsFrom(acls, ref?)` est extrait de `showAccessLists(router)`.
Les deux plateformes l'appellent — le type vient de la liste, les compteurs
de correspondance du moteur, et `show access-lists <nom>` filtre.

### La forme numérotée nue

`isAclSubMode()` est **surchargée dans `CiscoSwitchShell`** pour reconnaître
`config-acl`, et `sequence` est enregistré sur son trie d'ACL. Le choix de
surcharger plutôt que d'ajouter le mode à `CiscoShellBase` est délibéré :
ce fichier est en cours de refonte par un autre agent, et la règle est
propre au shell du commutateur.

---

## 4. Ce qui était juste

- **`handleArpAclLine`** était déjà séparé et gardé en tête des handlers : les
  ARP ACL ne passaient pas par le magasin de texte, et n'ont pas bougé.
- **La dérivation du type numéroté** (`id < 100 || 1300-1999`) était correcte
  ici, avant même que le moteur ait sa politique de numérotation — elle est
  simplement devenue redondante et cède la place à `IOS_ACL_NUMBERING`.
- **`reset acl counter`** et les VACL (`vlan access-map`) parlaient déjà au
  moteur.
- **`CiscoShellBase` portait déjà la réécriture du chiffre initial** en
  `sequence` : il n'y avait rien à inventer, seulement un mode à déclarer.

---

## 5. Ce qui reste

- **`show access-lists` du commutateur n'affiche pas les VACL** (`vlan
  access-map`), qui ont leur propre vue.
- **`ip access-group` n'existe pas en vue d'interface** sur le commutateur —
  c'est `traffic-filter` côté VRP et les VACL côté Cisco ; un port ACL IOS
  (`ip access-group` sur une SVI) n'est pas modélisé.
- **La table de règles ARP** (`selectedArpAcl`) garde son propre magasin. Elle
  n'est pas évaluée par `ACLEngine` et n'entre pas dans ce périmètre.

---

## Annexe — Reproduction

```bash
npx vitest run src/__tests__/audit/
```

82 tests couvrant les quatre surfaces : routeur Cisco, routeur VRP,
commutateur VRP, commutateur Cisco. **Chaque test assoit le comportement
juste ; un échec est une régression.**
