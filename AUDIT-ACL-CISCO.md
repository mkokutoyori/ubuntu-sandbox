# Audit — Implémentation des listes de contrôle d'accès (ACL) Cisco

**Périmètre :** ACL IPv4 et IPv6 sur routeurs et commutateurs Cisco simulés
**Date :** 16 août 2026
**Branche auditée :** `mandeng` @ `f3388c51`
**Méthode :** lecture intégrale du code, banc de preuves exécutable, confrontation à la documentation Cisco officielle

---

## 0. État des corrections

> **Les dix-neuf constats sont corrigés.** Paliers 0 à 3 traités les 16 août 2026.
>
> Le corps du rapport ci-dessous décrit l'état **au moment de l'audit**, non
> l'état courant : il est conservé tel quel comme constat daté, parce qu'un
> audit réécrit après coup ne vaut plus rien. La colonne « État » du tableau §3
> et le §11 donnent la situation à jour.
>
> Le banc de preuves a changé de nature avec le code. Il assoyait le
> comportement fautif ; il assoit désormais le comportement juste —
> **33 tests de non-régression**, et plus aucune sonde de défaut ouvert.
>
> ```bash
> npx vitest run src/__tests__/audit/     # 33 passed
> ```

---

## 1. Verdict

**L'implémentation des ACL Cisco de ce projet est un filtre de sécurité qui ne filtre pas.**

Ce n'est pas une formule. Sur les dix-neuf défauts mesurés ci-dessous, **sept inversent le sens de la règle écrite par l'opérateur** : une liste qui dit `deny` laisse passer. Et l'inversion ne demande pas une manipulation exotique — il suffit d'écrire un commentaire.

Le cas qui résume tout, mesuré et reproductible :

```
ip access-list extended BLOCK
 remark bloque le VLAN invité      ← ce commentaire annule les deux lignes suivantes
 deny ip 10.0.0.0 0.0.0.255 any
 permit ip any any
```

Verdict rendu par le moteur pour un paquet venant de `10.0.0.5` : **`permit`**.

Le `remark` est enregistré comme une entrée `permit` de source `0.0.0.0/255.255.255.255`, et la fonction de correspondance ne teste jamais le champ `remark`. Le commentaire est donc la première règle, il correspond à tout, et il rend un `permit`. **Toute ACL de ce simulateur contenant un commentaire est une ACL ouverte.** Elle s'affiche correctement sous `show access-lists`, elle se relit correctement dans `show running-config`, et elle ne bloque rien.

C'est la pire catégorie de défaut qu'un dispositif de sécurité puisse avoir : il n'échoue pas, il ment. Un pare-feu absent est un risque connu ; un pare-feu qui affiche `deny` et rend `permit` est un risque que personne ne cherche.

Sur un simulateur pédagogique, la conséquence est directe et sérieuse : **l'outil enseigne activement le contraire de ce qu'il prétend enseigner.** Un étudiant qui écrit une ACL correcte, la commente comme on lui a appris à le faire, et observe que le trafic passe, en conclura que sa règle est fausse. Elle ne l'est pas. C'est le simulateur qui l'est.

### Ce qui aggrave le jugement

Le moteur IPv6 de ce même dépôt, `Ipv6AclEngine.ts`, traite **exactement les deux mêmes concepts** — `remark` et `evaluate` — et les traite **correctement** :

```ts
// Ipv6AclEngine.ts:67-71
if (entry.remark !== undefined) return false;
// A reflexive-list reference has no session table behind it here, so it
// matches nothing rather than everything — failing an unbacked clause
// CLOSED is the rule this repo already applies to `RoutePolicy`.
if (entry.evaluate !== undefined) return false;
```

Le commentaire dit explicitement : *« faire échouer une clause non étayée en mode FERMÉ est la règle que ce dépôt applique déjà »*. Cette règle est énoncée, justifiée, et appliquée dans le fichier IPv6 — **et violée dans le fichier IPv4 d'à côté**, celui qui porte la quasi-totalité du trafic. L'auteur du moteur IPv6 a vu le piège, l'a documenté, et personne n'est revenu appliquer la même discipline au moteur v4.

Ce n'est donc pas une lacune de compétence. C'est une **lacune de rigueur** : la bonne réponse existait dans le dépôt, à cent lignes de là, et n'a pas été propagée.

---

## 2. Périmètre et méthode

### Fichiers audités

| Fichier | Lignes | Rôle |
|---|---|---|
| `src/network/devices/router/ACLEngine.ts` | 460 | Moteur IPv4 — stockage, correspondance, compteurs |
| `src/network/devices/router/Ipv6AclEngine.ts` | 100 | Moteur IPv6 |
| `src/network/devices/shells/cisco/CiscoAclCommands.ts` | 803 | CLI IOS — analyse, affichage, `running-config` |
| `src/network/devices/Router.ts` | (extraits) | Intégration plan de données, VTY, NTP, NAT, IPSec |
| `src/network/devices/Switch.ts` | (extraits) | VACL / port ACL — **réutilise le moteur IPv4** |

### Méthode

Les constats ne reposent pas sur une lecture. Chacun est adossé à un test exécutable dans
`src/__tests__/audit/cisco-acl-audit-preuves.test.ts`.

À l'audit, le fichier comptait 19 sondes asseyant le comportement *fautif*. Depuis la
correction du palier 0 il en compte 28, en deux blocs :

```bash
npx vitest run src/__tests__/audit/
# PALIER 0 — CORRIGÉ (non-régression)  → 17 tests : le comportement JUSTE
# CONSTATS OUVERTS (paliers 1 à 3)     → 11 sondes : les défauts restants
# Tests  28 passed (28)
```

Les comportements IOS de référence ont été vérifiés sur la documentation Cisco, pas de mémoire (sources en §10).

---

## 3. Tableau de synthèse

| Id | Constat | Gravité | Nature | État |
|---|---|---|---|---|
| F-01 | `remark` = `permit any` → **neutralise toute ACL commentée** | 🔴 Bloquant | Fond | **✅ corrigé** |
| F-02 | `evaluate <nom>` = `permit any` → ACL réflexive grande ouverte | 🔴 Bloquant | Fond | **✅ corrigé** |
| F-03 | `match-any/match-all <flags>` analysé, stocké, affiché, **jamais évalué** | 🔴 Bloquant | Fond | **✅ corrigé** |
| F-09 | ACL 2000–2699 typées `standard` → destination et ports **ignorés** | 🔴 Bloquant | Fond | **✅ corrigé** |
| F-04 | Mot-clé ICMP inconnu → critère **abandonné en silence** (ouverture) | 🔴 Bloquant | Fond | **✅ corrigé** |
| F-06 | Mot-clé DSCP/precedence inconnu → critère **abandonné** (ouverture) | 🔴 Bloquant | Fond | **✅ corrigé** |
| F-10 | Charge utile L4 absente → critères de port **ignorés** (ouverture) | 🔴 Bloquant | Fond | **✅ corrigé** |
| F-07 | ACL étendue + sonde source seule → **`TypeError`, routeur planté** | 🟠 Haut | Fond | **✅ corrigé** |
| F-15 | Re-entrer `ipv6 access-list NOM` **efface toutes les règles** | 🟠 Haut | Fond | **✅ corrigé** |
| F-05 | `icmpCode` jamais évalué → tous les *unreachable* confondus | 🟡 Moyen | Fond | **✅ corrigé** |
| F-08 | CLI refuse 1300–1999 et 2000–2699, **pourtant valides sur IOS** | 🟡 Moyen | Fidélité | **✅ corrigé** |
| F-11 | Séquence auto = `floor(max/10)*10+10` au lieu de `max+10` | 🟡 Moyen | Fidélité | **✅ corrigé** |
| F-12 | Numéros de séquence dupliqués acceptés en silence | 🟡 Moyen | Fidélité | **✅ corrigé** |
| F-13 | ACL nommée vide absente de `running-config` | 🟡 Moyen | Fidélité | **✅ corrigé** |
| F-14 | `no permit <ace>` (suppression par texte) non géré, erreur trompeuse | 🟡 Moyen | Fidélité | **✅ corrigé** |
| F-16 | Jetons inconnus **avalés en silence** — aucun `% Invalid input` | 🟡 Moyen | Fidélité | **✅ corrigé** |
| F-17 | `log` / `log-input` analysés, affichés, **n'émettent jamais rien** | 🟡 Moyen | Fond | **✅ corrigé** |
| F-18 | `remark` porte un compteur et affiche `(N matches)` | 🟢 Faible | Forme | **✅ corrigé** |
| F-19 | Affichage ACL standard : `host X` au lieu de l'IP nue | 🟢 Faible | Forme | **✅ corrigé** |

**Rayon de souffle :** `Switch.ts` instancie le **même `ACLEngine`** pour les VACL et les ACL de port. Les sept défauts d'ouverture frappaient donc **aussi les commutateurs**, pas seulement les routeurs — et les correctifs du palier 0 leur profitent de la même manière (mesuré au banc de preuves).

---

## 4. Constats bloquants — le filtre est ouvert

### F-01 — Un commentaire annule la liste

`CiscoAclCommands.ts:408-417` et `:508-520` enregistrent un `remark` en appelant `addNamedAccessListEntry(..., 'permit', { srcIP: 0.0.0.0, srcWildcard: 255.255.255.255, remark: ... })`.

`ACLEngine.aclEntryMatches()` ne consulte jamais `entry.remark`. L'entrée est donc une règle de plein droit, source *any*, action *permit*, placée en tête.

**Impact.** Le commentaire est une pratique *recommandée* — Cisco documente `remark` précisément pour rendre les ACL maintenables. Le simulateur punit la bonne pratique par une ouverture totale. La probabilité de rencontre est donc **maximale chez l'utilisateur consciencieux**.

**Correction.** Une ligne, au sommet de `aclEntryMatches` : `if (entry.remark !== undefined) return false;` — exactement ce que fait déjà `Ipv6AclEngine.ts:67`.

### F-02 — `evaluate` ouvre au lieu de fermer

`CiscoAclCommands.ts:495-507` enregistre `evaluate NOM` comme un `permit ip any any` porteur d'un champ `evaluate`. Ce champ n'est jamais lu.

Il n'existe aucune table de sessions réflexives dans ce moteur — `reflect` est également stocké et jamais exploité. La clause n'a donc rien derrière elle. Le choix implicite a été de la faire **réussir**, donc d'ouvrir. Le moteur IPv6 fait le choix inverse, et le justifie en commentaire.

**Impact.** Une ACL réflexive est, par construction, la barrière extérieure d'un site. `evaluate` en première ligne suivi de `deny ip any any` — la configuration canonique — donne : tout passe.

### F-03 — Les drapeaux TCP sont décoratifs

`CiscoAclCommands.ts:140-149` analyse `match-any` / `match-all` et remplit `opts.tcpFlags`. `formatACLEntry` le réaffiche fidèlement. `aclEntryMatches` ne le lit **jamais**.

Conséquence mesurée : `deny tcp any any match-any rst` **refuse un paquet SYN**. Le critère disparaît, la règle dégénère en `deny tcp any any`.

**Ce défaut est particulièrement insidieux** parce qu'il est bidirectionnel : sur un `deny` il sur-bloque (déni de service silencieux), sur un `permit` il sur-autorise. L'ACE fait toujours autre chose que ce qui est écrit, et `show access-lists` réaffiche le texte d'origine, ce qui rend le diagnostic impossible depuis l'intérieur du simulateur.

### F-09 — La numérotation Huawei contamine le routeur Cisco

`ACLEngine.ts:151` :

```ts
const type = (id < 100 || (id >= 2000 && id <= 2999)) ? 'standard' : 'extended';
```

La plage 2000–2999 est **la plage des ACL de base Huawei**. Sur IOS, [2000–2699 est la plage des ACL *étendues*](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_data_acl/configuration/15-mt/sec-data-acl-15-mt-book/sec-access-list-ov.html). Symétriquement, 1300–1999 (standard étendue IOS) tombe ici dans la branche `extended`.

**Les deux conventions sont inversées.** Une ACL 2500 créée par l'API est typée `standard`, donc `aclEntryMatches` **retourne `true` dès que la source correspond** (`ACLEngine.ts:328-330`) : destination, protocole et ports sont abandonnés sans un mot.

Mesuré : `access-list 2500 permit tcp 10.0.0.0 0.0.0.255 host 192.168.1.1 eq 22` rend **`permit`** pour un paquet vers `8.8.8.8:443`.

**C'est le symptôme d'un défaut d'architecture**, pas d'une faute de frappe : un moteur unique sert deux vendeurs aux conventions de numérotation incompatibles, sans porter la moindre notion de vendeur. Voir §7.

### F-04 / F-06 — Le typo est une ouverture

Trois critères suivent le même patron fautif :

```ts
// ACLEngine.ts:357-358  (ICMP)
const expected = ACL_ICMP_KEYWORD_TO_TYPE[entry.icmpType];
if (expected !== undefined && expected !== pktType) return false;

// ACLEngine.ts:363-364  (DSCP) — même forme
// ACLEngine.ts:368-369  (precedence) — même forme
```

Si le mot-clé n'est pas dans la table, `expected` vaut `undefined`, la condition est fausse, **le critère est purement et simplement sauté**. L'ACE devient plus permissive que ce qui est écrit.

Ce n'est pas théorique, et l'écart est large. Le validateur CLI `ICMP_TYPE_KEYWORDS` accepte **23 mots-clés** ; la table d'évaluation `ACL_ICMP_KEYWORD_TO_TYPE` en connaît **11**. **Treize mots-clés ICMP parfaitement valides passent la validation puis sont abandonnés à l'évaluation** :

`administratively-prohibited`, `information-reply`, `information-request`, `mask-reply`, `mask-request`, `packet-too-big`, `parameter-problem`, `router-advertisement`, `router-solicitation`, `source-quench`, `timestamp-reply`, `timestamp-request`, `traceroute`

Le CLI dit oui, le moteur oublie. Pire : les 11 mots-clés effectivement connus ne se projettent que sur **5 types distincts** — la table écrase quatre variantes d'*unreachable* sur une seule valeur (voir F-05).

Mesuré : `deny icmp any any administratively-prohibited` **refuse un echo-request**.

Le sens correct est l'inverse : un critère qu'on ne sait pas évaluer doit faire **échouer** la correspondance, jamais la valider.

### F-10 — Pas de couche 4, pas de filtrage

`ACLEngine.ts:342` :

```ts
if ((entry.protocol === 'tcp' || entry.protocol === 'udp') && ipPkt.payload) {
```

Si `payload` est absent, tout le bloc de test des ports est sauté et la fonction continue vers `return true`. Un paquet TCP sans objet de charge utile satisfait `permit tcp any any eq 22`.

Aggravant : `portMatches()` (`:385-397`) rend `true` quand ni `spec` ni `exact` ne sont fournis — un second niveau d'ouverture par défaut dans la même chaîne.

Aggravant encore : le code transtype la charge utile en `UDPPacket` (`ACLEngine.ts:343`) **sans vérifier `payload.type`**. Il n'y a aucune garantie que l'objet reçu porte réellement `sourcePort`/`destinationPort` ; s'il ne les porte pas, la comparaison se fait contre `undefined` et retombe, là encore, sur le chemin permissif.

---

## 5. Constats hauts — plantage et perte de données

### F-07 — Une ACL étendue sur VTY plante le routeur

`Router.ts:4461` fabrique un paquet-sonde ne contenant **que** `sourceIP`, et force le typage :

```ts
evaluateAclPermit(acl: string, srcIp: string): boolean {
  return this.aclEngine.evaluateACLByName(
    acl, { type: 'ipv4', sourceIP: new IPAddress(srcIp) } as never) === 'permit';
}
```

Ce `as never` supprime la seule protection qui aurait signalé le problème. Si l'ACL visée est **étendue**, `aclEntryMatches` atteint `wildcardMatch(ipPkt.destinationIP, ...)` avec `destinationIP === undefined`, et appelle `.getOctets()` dessus.

**Mesuré :** `TypeError: Cannot read properties of undefined (reading 'getOctets')`.

Ce point d'évaluation est, d'après son propre commentaire, **partagé par NAT, VTY et `ntp access-group`**. Le commentaire vante la mutualisation :

> *« Un seul point d'evaluation, partage (lot N6) : NAT, VTY et `ntp access-group` posent la meme question, et deux evaluateurs finiraient par repondre differemment pour la meme liste. »*

L'intention est juste. L'exécution mutualise **un défaut** au lieu d'une réponse : les trois chemins plantent ensemble. Le même piège existe en `Router.ts:541-543` pour la correspondance d'ACL NAT — or une ACL NAT étendue (`access-list 101 permit ip 10.0.0.0 0.0.0.255 any`) est *la* forme canonique.

Le correctif n'est pas de rendre `wildcardMatch` tolérant : c'est de construire une sonde **complète** (destination *any*, protocole, ports neutres) et de retirer le `as never` pour que le typage refasse son travail.

### F-15 — Rentrer dans une ACL IPv6 l'efface

`CiscoAclCommands.ts:733-743` :

```ts
configTrie.registerGreedy('ipv6 access-list', ..., (args) => {
  addIPv6ACLEntry(ctx.r(), name, 'permit', null);
  const acl = ctx.r().getIpv6AccessLists().find((a) => a.name === name);
  if (acl) acl.entries = [];        // ← efface une liste existante
  ...
});
```

Mesuré : une ACL de 2 règles retombe à **0 règle** au simple fait de retaper `ipv6 access-list V6` pour l'éditer.

Sur IOS, ré-entrer dans une ACL nommée **ouvre la liste existante en ajout**. C'est le geste le plus banal de l'édition d'ACL. Ici il détruit la configuration sans avertissement — et comme l'ACL reste liée à l'interface, elle passe silencieusement de « filtre » à « liste vide », c'est-à-dire, d'après `evaluateIpv6Acl:94`, à **`permit` inconditionnel**.

Le détour par `addIPv6ACLEntry(..., 'permit', null)` suivi d'un effacement est par ailleurs incompréhensible : la fonction insère une entrée `permit` bidon uniquement pour créer la liste, puis la vide. Si la relecture échoue, l'entrée bidon **reste**.

---

## 6. Constats moyens — infidélité à IOS

Rappel : la fidélité *est* la fonction du produit. Un simulateur qui diverge d'IOS n'a pas un défaut cosmétique, il a un **défaut de mission** — il enseigne un IOS qui n'existe pas.

**F-08 — Plages refusées.** `CiscoAclCommands.ts:245` : `if (num < 1 || num > 199) return '% Invalid access-list number. Valid range: 1-199.'`
Les plages [1300–1999 et 2000–2699 sont valides sur IOS](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_data_acl/configuration/15-mt/sec-data-acl-15-mt-book/sec-access-list-ov.html). Le message d'erreur est en outre **factuellement faux** : il énonce une règle qui n'est pas celle d'IOS. Un étudiant qui le lit apprend une contre-vérité.

**F-11 — Séquence auto erronée.** `ACLEngine.ts:229-233` calcule `Math.floor(maxSeq/10)*10 + 10`. IOS applique [« un numéro de séquence supérieur de 10 au dernier »](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_data_acl/configuration/15-mt/sec-data-acl-15-mt-book/sec-acl-seq-num.html), soit `maxSeq + 10`. Après une entrée en 15, IOS donne 25 ; ce code donne **20**. Mesuré.

**F-12 — Doublons de séquence acceptés.** Deux ACE au même numéro coexistent sans erreur. IOS refuse. L'ordre final dépend alors de la stabilité du tri, c'est-à-dire d'un détail d'implémentation — pour un objet dont **l'ordre est la sémantique**.

**F-13 — ACL vide invisible.** `ip access-list extended FOO` ne crée rien : la liste n'existe qu'à la première ACE. Elle est donc absente de `show running-config`. Sur IOS elle y figure. Effet de bord : la branche « liste vide » de `evaluateACL` (`:304`) est **inatteignable** par le CLI, donc jamais éprouvée.

**F-14 — Suppression par texte non gérée.** `no permit tcp any any eq 80` rend `% Incomplete command.` — un message qui désigne la mauvaise cause. Seul `no <séquence>` fonctionne. Sur IOS les deux formes existent.

**F-16 — Le silence sur l'erreur.** `parseTrailingOptions` (`:120-205`) termine sa boucle par un `i++` nu : **tout jeton non reconnu est ignoré sans un mot**. Mesuré : `permit tcp any any eq 80 estalbished` (faute de frappe sur `established`) est accepté, rend chaîne vide, et produit une ACE *sans* `established`. L'opérateur croit avoir écrit un filtre d'état ; il a écrit un `permit` sec.

C'est le multiplicateur de tous les autres défauts : IOS refuse l'inconnu (`% Invalid input detected at '^' marker`), ce qui transforme chaque faute de frappe en erreur visible. Ici chaque faute de frappe devient un **trou silencieux**.

**F-17 — `log` n'a jamais journalisé.** `log` et `log-input` sont analysés, stockés, rendus dans `show` et dans `running-config`. Aucun point du code n'émet quoi que ce soit sur leur base (vérifié par recherche exhaustive). La fonctionnalité est **une façade complète** : elle a toute l'apparence de l'existence, sauf l'effet.

**F-18 / F-19 — Affichage.** Un `remark` accumule un compteur et s'affiche `10 remark hello (1 match)` — un commentaire ne « correspond » à rien sur IOS. Et une ACL standard affiche `permit host 10.0.0.1` là où [IOS affiche l'adresse nue](https://www.cisco.com/c/en/us/support/docs/security/ios-firewall/23602-confaccesslists.html) : `permit 10.0.0.1`.

---

## 7. Critique de l'architecture

### 7.1 Un moteur, deux vendeurs, aucune notion de vendeur

`ACLEngine` sert simultanément Cisco IOS, Huawei VRP, les VACL de commutateur et les ACL cryptographiques IPSec. Il ne porte **aucun champ de vendeur**. La conséquence est F-09 : la numérotation Huawei est câblée en dur dans une condition, et casse Cisco.

Le fichier trahit d'ailleurs le mélange : `ACLEngine.ts` exporte `formatHuaweiAclEntry()`, une fonction de rendu **VRP**, depuis le module de moteur. Une couche de présentation d'un vendeur vit à l'intérieur du moteur partagé.

Le découpage juste est connu et déjà pratiqué ailleurs dans ce dépôt : un cœur de correspondance neutre, et une politique par vendeur (plages de numéros, mots-clés, rendu) injectée. Ici les trois sont fondus.

### 7.2 Une posture de sécurité incohérente au sein du même dépôt

| Situation | `ACLEngine` (v4) | `Ipv6AclEngine` (v6) |
|---|---|---|
| `remark` rencontré | **correspond → permit** | ne correspond pas ✅ |
| `evaluate` sans table | **correspond → permit** | ne correspond pas ✅ |
| Protocole inconnu | `'ip'` → **critère sauté** | `undefined` → **refus** ✅ |
| Mot-clé inconnu | **critère sauté** | *(sans objet)* |

Le moteur v6 fait quatre fois le bon choix. Le moteur v4 fait quatre fois le mauvais. **Il n'existe aucune règle écrite dans ce projet qui tranche « ouvert ou fermé par défaut ».** Le résultat dépend de qui a écrit le fichier. Pour un composant de sécurité, l'absence de cette règle est en soi le défaut le plus grave de l'audit — les dix-neuf autres en découlent.

### 7.3 Encapsulation ouverte par convention

`getAccessListsInternal()` et `getInterfaceACLBindingsInternal()` rendent les **structures vivantes**, protégées par un simple commentaire `@internal`. **Dix-huit appelants hors tests** s'en servent, dont du code d'affichage. `getAccessLists()` prend soin de copier — puis la porte de service annule la précaution dix-huit fois.

Effet observé : `showAccessLists` et `runningConfigACL` détiennent une référence mutable sur l'état de sécurité du routeur, pour lire du texte.

### 7.4 Les compteurs de correspondance sont pollués

`evaluateACL` incrémente `matchCount` **à chaque appel**, quel que soit l'appelant. Or elle est appelée par IPSec, par NAT, par le contrôle d'accès VTY, par le service HTTP, et par `debugLineMatchesAcl` (`Router.ts:4145`) — la fonction qui filtre l'affichage de `debug ip packet`.

Conséquence : **taper `debug ip packet 101` fait monter les compteurs de l'ACL 101.** `show access-lists` cesse alors de mesurer le trafic pour mesurer l'activité de l'observateur. C'est exactement l'outil qu'un étudiant utilise pour vérifier si sa règle est atteinte — et il est faussé par l'acte de regarder.

---

## 8. Critique de la forme

Le fond est grave ; la forme indique **comment** il l'est devenu.

### 8.1 Code mort laissé en place

`CiscoAclCommands.ts:437-439`, au milieu d'une fonction d'enregistrement de commandes :

```ts
for (let n = 1; n <= 99; n++) {
  void n;
}
```

Une boucle de 99 tours qui ne fait rien. Elle a survécu à la revue, au *lint*, et à tous les commits qui ont suivi.

Autres résidus, dans le même fichier :
- `parsePort()` (`:48-55`) — **jamais appelée**, supplantée par `parsePortSpec`.
- `consumedAfterSource()` (`:231-233`) — rend toujours `0`, utilisée dans `src.consumed ?? consumedAfterSource(rest)` où l'opérande gauche n'est **jamais** nul. Branche morte servant de garde à une garde inutile.
- `runningConfigACL` (`:636`) — variable `bindings` déclarée, jamais lue.
- `registerSequenceEdits` — paramètre `_aclType` jamais employé.

### 8.2 Le lint parle, personne n'écoute — et la documentation dit le contraire

`CLAUDE.md` affirme que `@typescript-eslint/no-unused-vars` est
«&nbsp;disabled project-wide&nbsp;». **C'est faux.** `eslint.config.js` le règle sur
`warn`, avec `argsIgnorePattern`/`varsIgnorePattern` sur `^_`&nbsp;:

```js
"@typescript-eslint/no-unused-vars": ["warn", {
  argsIgnorePattern: "^_", varsIgnorePattern: "^_",
  caughtErrors: "none", ignoreRestSiblings: true,
}],
```

La règle tourne, et elle **trouve exactement le code mort de cet audit**. Sur
les seuls fichiers ACL&nbsp;:

```
CiscoAclCommands.ts
   48:10  warning  'parsePort' is defined but never used
  642:9   warning  'bindings' is assigned a value but never used
```

Le constat est donc pire que celui d'un outil éteint, et différent&nbsp;:
**le signal existe, il est juste, et il est ignoré.** `npm run lint` ne casse
sur aucun avertissement, personne ne les lit, et le code mort s'accumule sous
un avertissement permanent. Éteindre une règle est une décision&nbsp;; laisser
une règle crier dans le vide en est une aussi, moins avouée.

S'y ajoute une **documentation fausse** : un contributeur — ou un agent — qui
lit `CLAUDE.md` conclut que ce détecteur n'existe pas, et n'ira jamais voir ce
qu'il dit. La ligne 200 de `CLAUDE.md` est à corriger.

Ce n'est pas un détail de style : dans un moteur de sécurité, **un champ
déclaré et jamais lu est la signature exacte de F-03, F-17, F-02 et F-05** —
`tcpFlags`, `log`, `evaluate`, `icmpCode`. L'outil automatique qui pointe vers
la classe de bug dominante du projet tourne déjà. Il suffisait de le lire.

Une nuance, à décharge : la boucle vide de §8.1 échappe **légitimement** à la
règle, `void n` comptant comme une utilisation. Celle-là, seul un relecteur
humain pouvait l'arrêter.

### 8.3 Neuf champs sur vingt-neuf sont des façades

Sur les champs de `ACLEntry`, **neuf sont acceptés par le CLI, stockés, réaffichés par `show` et `running-config`, et n'ont aucun effet** : `icmpCode`, `tcpFlags`, `reflect`, `reflectTimeout`, `evaluate`, `optionName`, `remark`, `log`, `logInput`.

Un tiers de la surface déclarée de l'objet ACL est décorative. Et comme le rendu est fidèle, **rien dans le simulateur ne permet de distinguer un champ qui agit d'un champ qui décore.**

### 8.4 Le transtypage employé comme silencieux

`as never` (`Router.ts:4461`), `as any` (`:541`), `as unknown as IPv4Packet` (`:4142`) : à chaque frontière où le type dit « ce paquet est incomplet », le code impose le silence au vérificateur plutôt que de compléter le paquet. F-07 est la conséquence directe et mesurée de l'un de ces trois transtypages.

### 8.5 Commentaires justes, code faux

`ACLEngine.ts:303` : `// Undefined or empty ACL = no ACL applied (real IOS), not deny-all.` — exact.
`Router.ts:4457-4460` : la justification de la mutualisation — juste.
`Ipv6AclEngine.ts:1-23` : l'exposé du piège NDP — remarquable.

La qualité rédactionnelle des commentaires de ce dépôt est nettement au-dessus de la moyenne. Elle rend le contraste plus dur, pas plus doux : **l'auteur de `Ipv6AclEngine.ts` a écrit noir sur blanc la règle « échouer fermé », dans un fichier voisin de celui qui échoue ouvert.** Le savoir était présent. Il n'a pas été appliqué.

---

## 9. Critique du dispositif de test

C'est le constat structurel le plus important du rapport.

**Quatre suites ACL, 83 tests, tous au vert. Elles détectent 0 des 19 défauts.**

```
cisco-acl.test.ts, acl-icmp-type.test.ts,
acl-undefined-name.test.ts, router-inbound-acl-control-plane.test.ts
→ Tests  83 passed (83)
```

Ces 83 tests ne sont pas mauvais : ils vérifient consciencieusement que `permit` autorise et que `deny` refuse sur des ACL nominales. Ils partagent tous le même angle mort — **ils n'écrivent que des ACL correctes et simples.** Aucun n'ajoute de commentaire, aucun ne teste une clause non étayée, aucun ne fait une faute de frappe, aucun ne passe un paquet incomplet, aucun n'utilise 2500 comme numéro.

Or c'est **exactement là** que vit la totalité des défauts.

Le banc de preuves joint établit qu'un contre-test coûte **une dizaine de lignes** et se rédige en quelques minutes. Le coût n'était pas l'obstacle. L'obstacle est méthodologique : la suite valide que la fonctionnalité *marche*, jamais qu'elle *ne cède pas*. Pour du filtrage, c'est la moitié du travail — et la moins importante.

Le dépôt dispose par ailleurs de suites `debug/` volumineuses (`acl-security.debug.test.ts`, `cisco-router-acl-aaa-security.debug.test.ts`) qui déroulent des centaines d'étapes et **vident leur sortie sans rien affirmer**. Elles produisent du volume, pas de la garantie. Un `deny` devenu `permit` y traverse sans un bruit.

**Enfin, la couverture de tests est configurée pour ne mesurer que `src/network/protocols/ssh/**`** (seuils 85 %). Le moteur ACL — le composant de sécurité central de ce simulateur — n'est sous **aucun seuil de couverture**.

---

## 10. Ce qui est juste

Un audit qui ne relève que les fautes est un réquisitoire, pas un audit. Les points suivants ont été vérifiés et sont corrects.

- **L'ordre des opérations ACL/NAT est exact, dans les deux sens.** L'ACL entrante est évaluée avant la traduction entrante (`Router.ts:2227` puis `:2229`) ; l'ACL sortante l'est après la traduction sortante (`:2728`). C'est [précisément l'ordre documenté par Cisco](https://www.cisco.com/c/en/us/support/docs/ip/network-address-translation-nat/6209-5.html), et c'est un point que beaucoup d'implémentations manquent.
- **La correspondance par masque générique** (`wildcardMatch`, `:399-409`) est correcte, y compris sur les masques non contigus.
- **`established`** teste bien ACK ou RST (`:348-352`) — conforme.
- **Le refus produit un ICMP *administratively-prohibited* (code 13)**, correctement conditionné par `no ip unreachables`. C'est un raffinement que peu de simulateurs implémentent.
- **Le résolveur de plages horaires** est correctement branché (`Router.ts:369`) et applique la sémantique « ACE inactive → règle suivante ».
- **`Ipv6AclEngine.ts`** est un bon fichier : la permission implicite des messages de découverte de voisins est correctement placée *après* la boucle de règles — donc un `deny icmp any any` explicite bloque bien NDP, comme sur IOS —, la posture d'échec est fermée, et l'exposé du piège en tête de fichier est de qualité professionnelle.

La compétence n'est pas en cause. La discipline l'est.

---

## 11. Remédiation priorisée

### Palier 0 — ✅ FAIT (16 août 2026)

Une **règle d'échec** unique a été posée en tête de `aclEntryMatches`, et
documentée sur place : *un critère que le moteur ne sait pas trancher fait
échouer la correspondance — jamais réussir, jamais « sauter le critère ».*
Les cinq points en découlent.

1. **F-01, F-02** — `remark` et `evaluate` ne correspondent plus à rien. Un
   commentaire redevient un commentaire ; une référence réflexive non étayée
   échoue fermé, comme dans `Ipv6AclEngine`.
2. **F-04, F-06** — mot-clé ICMP, DSCP, precedence ou ToS non résolu ⇒ pas de
   correspondance. La table ICMP porte désormais un commentaire expliquant que
   `ICMPType` ne modélise que cinq types, et pourquoi les autres mots-clés
   échouent fermé plutôt que d'être inventés.
3. **F-03** — `match-any` / `match-all` sont évalués, préfixes `+` / `-`
   compris. Le **mode** est conservé (il était perdu : `match-all` était stocké
   comme `match-any`) et rendu correctement par `show`. Un nom de drapeau
   inconnu échoue fermé.
4. **F-09** — la numérotation devient une **politique injectée**
   (`AclNumbering`), IOS par défaut ; `HuaweiRouter` et `HuaweiSwitch` posent
   `VRP_ACL_NUMBERING` dans leur constructeur. Le moteur ne devine plus la
   convention d'un vendeur.
5. **F-10** — un critère de port sans couche 4 échoue fermé, tandis qu'une ACE
   *sans* critère de port continue de correspondre. La distinction est testée
   dans les deux sens.

**Effet de bord :** F-18 tombe avec F-01 — un `remark` n'accumule plus de
compteur, donc `show access-lists` cesse d'afficher `(N matches)` sur une ligne
de commentaire.

**Vérification :** 17 tests de non-régression dans
`src/__tests__/audit/`, plus 134 fichiers / 2200 tests des suites ACL, NAT,
IPSec, VTY, sécurité et pare-feu — tous verts. Aucune erreur de typage
nouvelle (343 avant, 343 après).

### Palier 1 — ✅ FAIT

6. **F-07** — une sonde COMPLÈTE (`sourceProbePacket`) remplace l'objet
   source-seul de VTY / NTP / NAT, et les `as never` / `as any` qui faisaient
   taire le vérificateur sont retirés. Le moteur, en outre, traite un champ
   manquant comme un critère intranchable — il échoue, il ne plante plus.
7. **F-15** — ré-entrer dans une ACL IPv6 l'ouvre en ajout. Le détour par une
   entrée bidon suivie d'un effacement a disparu avec la fonction qui le portait.
8. **F-16** — tout jeton inconnu rend `% Invalid input detected at '^' marker.`
   et **rien n'est enregistré**. C'était le multiplicateur : une faute de frappe
   produisait une ACE silencieusement différente de ce qui avait été tapé.
9. **F-17** — `log` / `log-input` émettent un vrai
   `%SEC-4-IPACCESSLOGP: list 100 denied tcp 10.0.0.1(1234) -> 10.0.0.2(22), 1 packet`.
   Le mappage syslog est corrigé au passage : IOS ne journalise **que** les ACE
   marquées, là où toute ACE refusée produisait la ligne — ce qui privait
   précisément `log` de tout effet observable.

### Palier 2 — ✅ FAIT

10. **F-05** — le code ICMP discrimine enfin les variantes : `host-unreachable`
    ne bloque plus les `port-unreachable`. `administratively-prohibited` et
    `packet-too-big` deviennent évaluables (codes 13 et 4).
11. **F-08** — les quatre plages IOS sont acceptées, et le message d'erreur les
    énonce exactement au lieu d'affirmer une règle fausse.
12. **F-11** — séquence auto = dernier + 10. **F-12** — un numéro déjà pris rend
    `% Duplicate sequence number.` **F-13** — une liste nommée vide existe dès sa
    création et figure dans `running-config`. **F-14** — `no permit <ace>`
    supprime par texte, et l'absence se dit (`% Access list entry does not
    exist.`) au lieu de `% Incomplete command.` **F-19** — le `show` d'une liste
    standard rend l'IP nue.

### Palier 3 — ✅ FAIT (le seul qui empêche la récidive)

13. **La règle d'échec est écrite dans `CLAUDE.md`**, pas seulement dans un
    commentaire de `ACLEngine.ts` — avec sa conséquence : *ne jamais stocker un
    critère qu'on n'évalue pas ; l'appliquer, ou le refuser à l'analyse.*
14. **Moteur et présentation vendeur séparés** : `formatHuaweiAclEntry` quitte
    `ACLEngine` pour `shells/huawei/HuaweiAclFormat.ts`, et la numérotation est
    une politique injectée (`IOS_ACL_NUMBERING` / `VRP_ACL_NUMBERING`).
15. **Code mort supprimé** — la boucle de 99 tours, `parsePort`,
    `consumedAfterSource`, `addIPv6ACLEntry`, la variable `bindings` — et
    l'affirmation fausse de `CLAUDE.md` sur `no-unused-vars` est rectifiée
    (la règle tourne en `warn`, elle signalait ce code, elle était ignorée).
    La mention d'un répertoire `src/network/acl/` inexistant est retirée.
16. **Le moteur ACL passe sous seuil de couverture** dans `vite.config.ts` : il
    n'y était soumis par aucun, alors qu'il est le composant de sécurité central.
17. **§7.4 — les compteurs ne sont plus pollués** : `evaluateACL` accepte
    `countMatches`, et le filtre d'affichage de `debug ip packet` observe sans
    compter. `show access-lists` remesure le trafic, pas l'observateur.

## 12. Conclusion

Le simulateur reproduit correctement la **plomberie** des ACL — l'ordre par rapport au NAT, les masques génériques, les ICMP de refus, les plages horaires. Ce sont les parties difficiles, et elles sont faites.

Il échoue sur la **sémantique de sécurité**, et il y échoue systématiquement dans la même direction : **vers l'ouverture**. Neuf champs déclarés sans effet, sept chemins qui inversent la règle écrite, un `remark` qui annule une liste, et 83 tests verts qui n'en voient aucun.

Le défaut racine n'est aucun des dix-neuf. C'est **l'absence d'une règle écrite sur la posture d'échec** — une règle que ce dépôt connaît, puisqu'elle est énoncée et justifiée dans `Ipv6AclEngine.ts`, et qu'il n'a simplement jamais promue au rang de convention. Les dix-neuf constats sont les feuilles ; celle-là est la racine. Corriger les feuilles sans la racine garantit la repousse.

**Recommandation initiale.** Traiter le palier 0 comme un correctif bloquant : en l'état, l'implémentation ACL Cisco de ce simulateur n'est pas pédagogiquement utilisable, parce qu'un étudiant qui suit les bonnes pratiques enseignées — commenter ses ACL — obtient une liste ouverte, sans le moindre signal.

### Suite donnée — 16 août 2026

Les dix-neuf constats sont corrigés, paliers 0 à 3 compris.

**Ce qui a réellement changé.** Pas dix-neuf rustines : une règle. *Un critère
que le moteur ne sait pas trancher fait échouer la correspondance* — jamais
réussir, jamais « sauter le critère ». Les sept défauts d'ouverture en
découlaient tous, et c'est cette règle, désormais écrite dans `CLAUDE.md` et
non plus seulement dans un commentaire, qui empêche le prochain critère d'ACE
de rouvrir la liste. Sa conséquence est écrite avec elle : **ne jamais stocker
un critère qu'on n'évalue pas** — l'appliquer, ou le refuser à l'analyse.

**Ce que l'audit a corrigé de lui-même.** Deux affirmations du rapport initial
étaient fausses, et ont été rectifiées en place plutôt qu'effacées :

- `no-unused-vars` n'est **pas** désactivé (§8.2). La règle tourne en `warn`,
  elle signalait nommément le code mort trouvé ici, et elle était ignorée —
  un constat plus dur que celui d'un outil éteint. `CLAUDE.md` l'affirmait à
  tort ; la ligne est corrigée.
- La numérotation de séquence dupliquée : la correction a cassé un scénario de
  test qui supposait qu'un numéro réutilisé **remplace** l'entrée. Vérification
  faite auprès de la documentation, IOS refuse en IPv4 (`% Duplicate sequence
  number.`) et n'accepte le remplacement qu'en IPv6. Le scénario a été aligné
  sur IOS — il fait maintenant `no 10` avant de réécrire, comme un opérateur.

**Ce qui reste vrai.** Le dispositif de test garde son angle mort d'origine :
83 tests ACL verts n'avaient vu aucun des dix-neuf défauts, faute de sonder les
cas dégradés. Les 33 tests du banc ne le comblent que pour les défauts connus.
La discipline qui manquait n'était pas l'écriture de tests, mais l'habitude de
tester **ce qui cède** plutôt que ce qui marche.

---

## Sources

Comportement IOS de référence, vérifié en ligne :

- [IP Access List Overview — Cisco IOS 15M&T](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_data_acl/configuration/15-mt/sec-data-acl-15-mt-book/sec-access-list-ov.html) — plages 1–99 / 1300–1999 (standard), 100–199 / 2000–2699 (étendue)
- [IP Access List Entry Sequence Numbering — Cisco IOS XE](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_data_acl/configuration/xe-3s/sec-data-acl-xe-3s-book/sec-acl-seq-num.html) — incrément par défaut : dernier + 10
- [Configure IP Access Lists — Cisco](https://www.cisco.com/c/en/us/support/docs/security/ios-firewall/23602-confaccesslists.html) — format d'affichage `show access-lists`
- [NAT Order of Operation — Cisco](https://www.cisco.com/c/en/us/support/docs/ip/network-address-translation-nat/6209-5.html) — ACL entrante avant NAT, ACL sortante après NAT

## Annexe — Reproduction

```bash
npx vitest run src/__tests__/audit/
```

28 tests, en deux blocs qui ne se lisent pas de la même façon :

- **`PALIER 0 — CORRIGÉ`** (17 tests) assoit le comportement **juste**. Ce sont
  de vrais tests de non-régression : un échec ici est une régression.
- **`CONSTATS OUVERTS`** (11 sondes) assoit le comportement **actuel**, donc
  fautif. Un test qui *passe* est un défaut toujours présent ; un test qui
  *échoue* signale une correction — le déplacer vers le premier bloc et mettre à
  jour la colonne « État » du tableau §3.
