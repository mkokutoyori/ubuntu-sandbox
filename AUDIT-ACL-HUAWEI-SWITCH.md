# Audit — La table de règles ACL du commutateur Huawei

**Périmètre :** `HuaweiSwitchShell` — vue ACL, table de règles, affichages
**Date :** 17 août 2026
**Branche auditée :** `mandeng`
**Méthode :** lecture, banc de preuves exécutable, comparaison au routeur VRP corrigé
**Rapports jumeaux :** `AUDIT-ACL-CISCO.md`, `AUDIT-ACL-HUAWEI.md`

---

## 0. État des corrections

> **Les huit constats sont corrigés.** Le commutateur partage désormais le
> magasin, l'analyse et le rendu du routeur.
>
> ```bash
> npx vitest run src/__tests__/audit/   # 68 tests : 34 Cisco + 19 VRP + 15 commutateur
> ```

---

## 1. Verdict

**Il y avait deux magasins, et une règle supprimée continuait de filtrer.**

Le §6 du rapport VRP avait signalé cette divergence comme « connue et
antérieure ». La mesure montre qu'elle était bien pire qu'une divergence de
forme : le commutateur tenait **un écho verbatim du texte tapé** à côté des
**entrées du moteur**, alimentés par deux chemins distincts, et ils
divergeaient de toutes les façons possibles.

### Le cas qui résume tout, mesuré

```
[SW1] acl 3000
[SW1-acl-adv-3000] rule 5 deny tcp source any destination any destination-port eq 22
[SW1-acl-adv-3000] undo rule 5
```

| Question | Réponse |
|---|---|
| `display this` montre-t-il encore la règle ? | **non** — elle a disparu de la configuration |
| Le moteur refuse-t-il encore le port 22 ? | **oui — `deny`** |

`undo rule` retirait la ligne du **texte** sans toucher au moteur. Une règle
supprimée de la configuration continuait de bloquer le trafic, et **rien dans
la machine ne permettait de s'en apercevoir** : l'opérateur voit sa règle
partie, le trafic reste bloqué, et il n'existe aucune vue montrant la règle
fantôme.

C'est la même famille que le `remark` de l'audit Cisco — un dispositif de
sécurité qui n'échoue pas, qui *ment* — à ceci près que le sens est inversé :
là où le `remark` ouvrait ce qu'on croyait fermé, ici on ferme ce qu'on croit
ouvert.

### Le second cas, aussi net

```
[SW1-acl-adv-3000] rule 5 permit ip source any destination any
```

| Vue | Ce qu'elle rend |
|---|---|
| `display this` | ` rule 5 permit ip source any destination any` |
| `display acl 3000` | ` rule 0 permit ip` |

**La même règle, deux numéros, deux textes, la même machine, le même instant.**
Le premier était l'écho de la frappe, le second un `index × 5` recalculé à
l'affichage. Aucun des deux n'était le numéro stocké par le moteur.

---

## 2. Les huit constats

| Id | Constat | Gravité | État |
|---|---|---|---|
| S-01 | `undo rule` efface le texte ; **la règle continue de filtrer** | 🔴 Bloquant | **✅ corrigé** |
| S-03 | Mot-clé inconnu **avalé en silence** | 🔴 Bloquant | **✅ corrigé** |
| S-04 | `icmp-type` / `tcp-flag` **jamais lus** sur le commutateur | 🔴 Bloquant | **✅ corrigé** |
| S-02 | Le **numéro de règle écrit par l'opérateur était jeté** | 🟠 Haut | **✅ corrigé** |
| S-05 | Une règle malformée **entrait dans le texte, pas dans le moteur** — et une adresse invalide **levait une exception** | 🟠 Haut | **✅ corrigé** |
| S-06 | `display acl` numérotait à l'affichage et codait le pas en dur | 🟡 Moyen | **✅ corrigé** |
| S-07 | `step` et `description` écrits, **lus par personne** | 🟡 Moyen | **✅ corrigé** |
| S-08 | `display this` et `display acl` **répondaient différemment** | 🟡 Moyen | **✅ corrigé** |

Les huit n'en font qu'un : **deux magasins**. La correction est donc unique —
il n'y en a plus qu'un, le moteur, celui qui filtre pour de bon.

---

## 3. Ce qui a été fait

### Un magasin

`this.acls` — la `Map<clé, {rules: string[], description?, step?}>` — est
**supprimée**. La liste naît dans le moteur à l'ouverture de sa vue
(`ensureAccessList` / `ensureNamedAccessList`), les règles y vivent seules,
`step` et `description` sont posés sur elle.

Ce que le shell garde est un **scalaire d'état de vue** : `selectedAclType`
(`basic` / `adv`). Ce n'est pas un second magasin de règles, c'est la même
chose que `selectedVlan` ou `selectedInterface` — et c'est **nécessaire**, pour
une raison qui n'était pas devinable et que la mesure a donnée : `swRef` est
**null hors exécution de commande**, or l'invite se rend précisément à ce
moment-là. Le shell ne peut donc pas interroger le moteur pour savoir quelle
vue est ouverte. C'est aussi pourquoi le code d'origine lisait sa table locale
là — le choix était fondé, sa généralisation aux règles ne l'était pas.

### Une analyse

`parseVrpAclRule` et `parseVrpAclAddr` — le **troisième** analyseur de règle
VRP du dépôt — sont supprimés. Le commutateur appelle `analyserRegleVrp`, celui
du routeur, et hérite d'un coup de tout ce que le lot précédent lui avait donné :
`icmp-type` avec ses noms VRP traduits, `tcp-flag` avec la sémantique VRP,
`dscp`, `precedence`, `tos`, `fragment`, `time-range`, `logging`, le refus de
`vpn-instance`, et le **refus** de tout mot-clé inconnu.

Trouvé en corrigeant S-05 et corrigé pour les deux plateformes : une adresse
malformée faisait **lever** `new IPAddress()`, et l'exception traversait le
gestionnaire de commande au lieu de rendre un message. Les adresses sont
validées avant d'être construites.

### Un rendu

`formatHuaweiAclHeader`, `formatHuaweiAclRules`, `formatHuaweiAcl` et
`formatHuaweiAclConfig` vivent dans `HuaweiAclFormat.ts`, à côté du rendu d'une
règle. Le routeur et le commutateur les appellent tous deux — **deux
plateformes ne peuvent plus répondre différemment à la même question**, ce qui
était exactement le défaut S-08.

`display this` rend la forme **configuration** (`acl advanced 3000`, `step`,
`description`, règles) ; `display acl` rend la forme **opérationnelle**
(en-tête, compte de règles, pas, compteurs). Deux formes légitimement
différentes, un seul magasin derrière — et un seul numéro par règle.

---

## 4. Ce qui était juste

- **`analyserAcl`** était déjà partagée avec le routeur, et son en-tête raconte
  le défaut qu'elle avait refermé : deux grammaires divergentes entre les deux
  plateformes. Le travail de mutualisation était commencé ; il ne s'était pas
  étendu aux règles.
- **Le commentaire du type `acls`** disait la vérité sans détour : *« Ecrits par
  `description` et `step` en vue ACL, et lus par personne — ni ici ni ailleurs.
  Les declarer ne les rend pas vivants ; cela les rend greppables »*. Le dépôt
  savait. C'est ce genre de note qui rend un audit rapide.
- **`renderAclOperational` lisait déjà le moteur** — son propre commentaire
  expliquait pourquoi (« unlike `renderAcl`'s verbatim echo »). La bonne
  intention était là ; il lui manquait d'être la seule.
- **`reset acl counter`** parlait déjà au moteur, pas au texte.

---

## 5. Ce qui reste

- **La vue ACL du commutateur n'a pas de `display acl all` paginé**, comme le
  routeur.
- **Les ACL L2 (4000-4999)** restent refusées par la grammaire, sur les deux
  plateformes, faute d'être évaluables.
- **`HuaweiSwitchShell` reste un fichier de plus de 5 000 lignes** portant
  toutes les vues du commutateur. Le découper est un chantier propre, sans
  rapport avec les ACL, et n'a pas été entrepris ici.

---

## Annexe — Reproduction

```bash
npx vitest run src/__tests__/audit/
```

68 tests : 34 pour Cisco, 19 pour le routeur VRP, 15 pour le commutateur.
**Chaque test assoit le comportement juste ; un échec est une régression.**
