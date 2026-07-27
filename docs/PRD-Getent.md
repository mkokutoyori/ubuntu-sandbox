# PRD — `getent` et le Name Service Switch (NSS)

## 0. Contexte et portée

`getent` interroge les bases administratives du système (passwd, group,
hosts, services…) à travers le Name Service Switch — la couche
d'indirection glibc qui, selon `/etc/nsswitch.conf`, consulte `files`,
`dns`, `systemd`, etc. dans l'ordre déclaré. Ce PRD couvre
`src/network/devices/linux/nss/` (le moteur NSS complet : types, config,
sources, résolveur, formateur) et `GetentCommand.ts` (la commande
elle-même).

**Ce sous-système est, à ce stade de la relecture, l'un des plus matures
et des plus fidèles de tout ce dépôt** — pas une découverte à minimiser :
vocabulaire de types calqué sur les structures glibc réelles (`struct
passwd`/`hostent`/`servent`…), moteur de dispatch `[STATUS=action]`
(`return`/`continue`/`merge`) fidèle à `nsswitch.conf(5)`, codes de sortie
`getent` exacts (0/1/2/3), et ~1466 lignes de tests dédiés déjà en place
(§1.1). Ce PRD ne propose donc **aucune reprise en profondeur** — seulement
deux constats précis et bornés trouvés par cette relecture (§1.3), plus un
troisième qui s'avère, après vérification, être une conformité et non un
défaut (§1.2, à ne pas « corriger »).

### 0.1 Chaîne de dépendances

- **Le sous-système SMTP** (`src/network/smtp/`, 18 fichiers, avec
  livraison locale réelle) a grandi substantiellement depuis que le
  commentaire de `GetentCommand.ts` justifiant le stub de `getent
  aliases` a été écrit — cf. §1.3 item 1, ce commentaire est aujourd'hui
  imprécis (pas totalement faux, mais trompeur) pour la même raison que
  d'autres constats de ce PRD ont déjà été trouvés périmés ailleurs dans
  cette série (`docs/PRD-VTP.md §0.1`, MSTP).
- Aucune autre dépendance — `getent`/NSS ne dépend d'aucun autre PRD de
  cette série et n'en bloque aucun.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle |
|---|---|
| `src/network/devices/linux/nss/types.ts` (210 lignes) | Vocabulaire NSS complet : `NssStatus`/`NssResult`/`NssEnumResult`, une interface par base (`passwd`/`group`/`shadow`/`gshadow`/`hosts`/`services`/`protocols`/`networks`/`ethers`/`rpc`/`netgroup`), `NssDatabase` couvrant `ahosts`/`ahostsv4`/`ahostsv6`/`initgroups`/`aliases` |
| `src/network/devices/linux/nss/NameServiceSwitch.ts` (291 lignes) | Résolveur : `lookup`/`enumerate` appliquent réellement les règles `[STATUS=action]` (`return`/`continue`/`merge`) par source, dans l'ordre déclaré ; signal de cache-invalidation câblé sur 12 topics de bus IAM/topologie (§1.3 item 2) |
| `src/network/devices/linux/nss/NssConfig.ts` (201 lignes) | Parseur `/etc/nsswitch.conf` fidèle (tolérant, syntaxe `[STATUS=action]`), config par défaut **verbatim Ubuntu 22.04** (y compris `netgroup: nis`, cf. §1.2) |
| `src/network/devices/linux/nss/GetentCommand.ts` (438 lignes) | Commande complète : 15 bases supportées, détection clé numérique/nom/IP/MAC, `-s`/`--service` (global et par base), codes de sortie glibc exacts |
| `src/network/devices/linux/nss/GetentFormatter.ts` (72 lignes) | Formatage ligne-à-ligne fidèle, y compris la triplication STREAM/DGRAM/RAW de `ahosts` |
| `FilesNssSource.ts` (448 l.) / `DnsNssSource.ts` (184 l.) / `SystemdNssSource.ts` (102 l.) | Les 3 sources réellement enregistrées (`files`/`dns`/`systemd`) — `db`/`nis`/`ldap`/`compat` ne sont jamais enregistrées (§1.2) |
| 8 fichiers de tests directement pertinents (~1466 lignes) | `getent-command.test.ts` (502 l.), `nss-resolver.test.ts` (350 l.), `linux-nsswitch-resolv-order.test.ts` (153 l.), `nss-systemd.test.ts` (108 l.), `nss-resolution-unified.test.ts` (96 l.), `scenario-session-07-getent.test.ts` (96 l.), `nss-merge.test.ts` (66 l.), `nss-dns-wire.test.ts` (95 l.) |

### 1.2 Ce qui est déjà réel et solide — y compris un point vérifié qui n'est PAS un défaut

- **Dispatch `[STATUS=action]` complet**, y compris `merge` (agrégation
  multi-sources, testé isolément par `nss-merge.test.ts`) — pas seulement
  `return`/`continue`, la nuance la plus souvent oubliée dans ce genre de
  ré-implémentation.
- **Héritages de configuration fidèles** : `ahosts`/`ahostsv4`/`ahostsv6`
  héritent de la ligne `hosts` quand ils ne sont pas déclarés séparément,
  `initgroups` hérite de `group` — exactement le comportement glibc réel
  (`NssConfig.sourcesFor`).
- **Invalidation réactive câblée sur de vrais événements** (création/
  suppression/modification d'utilisateur ou de groupe, changement de mot
  de passe, changement d'IP, power-on/off) — correcte en soi, cf. §1.3
  item 2 pour la nuance qui reste à traiter.
- **Point vérifié qui s'avère être une conformité, pas un bug** : la
  configuration par défaut déclare `netgroup: nis` (`NssConfig.ts:47`),
  et aucune source `nis` n'est jamais enregistrée
  (`LinuxCommandExecutor.ts:533-540` n'enregistre que `files`/`dns`/
  `systemd`) — si bien que `getent netgroup` renvoie systématiquement
  vide/UNAVAIL sur un équipement fraîchement démarré, sans qu'aucun
  fallback ne prenne le relais dans cette ligne précise de configuration.
  **Ce n'est pas un défaut de fidélité** : un vrai Ubuntu fraîchement
  installé embarque exactement cette même ligne `netgroup: nis` alors
  qu'aucun client NIS n'est jamais installé par défaut — `getent
  netgroup` échoue de la même façon sur une vraie machine tant qu'aucun
  administrateur n'a explicitement reconfiguré `nsswitch.conf` ou installé
  NIS/SSSD. Le moteur `FilesNssSource` implémente pourtant bien
  `/etc/netgroup` (`getnetgrent`/`enumNetgroup`, `FilesNssSource.ts:417-
  430`) et reste atteignable via `-s files` ou une reconfiguration
  manuelle — exactement comme sur une vraie machine. Mentionné ici pour
  mémoire, avec la vérification qui l'accompagne, plutôt que
  silencieusement laissé de côté ou signalé à tort comme un gap.

### 1.3 Gap analysis — limites vérifiées

| # | Limite | Comparé à | Sévérité |
|---|---|---|---|
| 1 | **`getent aliases` est un stub commenté « pas de sous-système mail », un constat aujourd'hui imprécis.** `GetentCommand.ts:175-178` retourne inconditionnellement `{ output: '', exitCode: 2 }` avec le commentaire « the simulator has no mail subsystem ». Or `src/network/smtp/` (18 fichiers, dont une livraison locale réelle, `localDelivery.ts`) existe bel et bien — la lecture de ce fichier confirme cependant qu'aucune notion d'aliasing local (`/etc/aliases`, expansion nom→destinataire(s) avant remise) n'y existe non plus. Le commentaire n'est donc pas complètement faux (l'aliasing manque vraiment) mais sa justification (« pas de sous-système mail ») est trompeuse et périmée — le vrai manque est plus étroit : une couche d'aliasing locale, pas un sous-système mail entier, qui existe déjà. | `/etc/aliases`/`newaliases`/Postfix-Sendmail local aliasing réel | Moyenne (fonctionnalité manquante + justification obsolète à corriger) |
| 2 | **Le signal d'invalidation de cache n'a aucun consommateur.** `NameServiceSwitch.onCacheInvalidated()` (l. 79-82) permet de s'abonner, et `wireBusInvalidation()` (l. 245-290) branche bien 12 topics de bus réels (IAM utilisateur/groupe, IP, power-on/off) qui appellent `fwd(db)` — mais **aucun appelant de `onCacheInvalidated` n'existe nulle part dans le code de production** (recherche exhaustive). Le commentaire de la classe le dit lui-même : « A future LRU layer can sit on top of this class ». Douze abonnements de bus tournent donc aujourd'hui pour zéro auditeur — inoffensif (le résolveur n'a de toute façon pas besoin de cache pour rester correct, cf. son propre commentaire : lire la VFS/le registre à chaque appel reste bon marché), mais un investissement de câblage qui n'a jamais servi. | Couche de cache anticipée mais jamais construite | Faible (aucun impact fonctionnel, infrastructure non exploitée) |

---

## 2. Objectifs

### 2.1 Objectifs (priorité décroissante)

- **P1 — Aliasing mail local réel (item 1).** Ajouter `NssAliasEntry`
  (`name:destinataire1,destinataire2,…`, format `/etc/aliases` réel) au
  vocabulaire de types, une lecture `/etc/aliases` dans `FilesNssSource`
  (`getaliasbyname`/`enumAliases`, sur le même modèle que les autres
  bases fichier), un handler `handleAliases` réel dans `GetentCommand.ts`
  (remplaçant le stub), et surtout : la livraison locale SMTP
  (`localDelivery.ts`) doit consulter cette table avant remise finale —
  un mail adressé à un alias local doit se retrouver livré à ses
  destinataires réels, pas simplement une commande `getent` qui répond
  correctement en vase clos. Corrige au passage la justification
  obsolète du commentaire existant.
- **P2 — Décision explicite sur le signal de cache inexploité (item 2).**
  Deux issues possibles, à trancher en conception détaillée plutôt que
  laissées ambiguës indéfiniment : (a) construire la couche LRU que le
  commentaire de la classe anticipe déjà — un cache court-terme (quelques
  secondes) sur les résolutions `passwd`/`group`/`hosts`, invalidé par le
  signal déjà câblé, avec un bénéfice réel si un futur scénario multiplie
  les appels `getent`/résolution en boucle serrée ; ou (b) si aucun besoin
  concret ne justifie cette couche, retirer `wireBusInvalidation()` et les
  12 abonnements associés plutôt que de garder une infrastructure qui ne
  sert jamais. Ce PRD recommande (a) comme option par défaut, dans la
  mesure où le câblage existant en a déjà fait la moitié du travail et où
  le retirer perdrait un investissement déjà fait pour un bénéfice futur
  proche de zéro à retirer par rapport à le finir.

### 2.2 Non-objectifs (explicitement exclus)

- **« Corriger » le comportement de `netgroup: nis`** (§1.2) — ce n'est
  pas un défaut, c'est une reproduction fidèle d'un vrai comportement
  Ubuntu de base ; toute correction romprait la fidélité au lieu de
  l'améliorer.
- **Sources `db`/`ldap`/`compat`** — non enregistrées aujourd'hui, mais
  chaque base qui les déclare dans la config par défaut a `files` comme
  repli dans la même ligne (sauf `netgroup`, déjà couvert en §1.2) ; aucun
  cas d'usage observé ne justifie de les implémenter pour l'instant.
- **NIS/SSSD/LDAP réels** — hors périmètre, aucune infrastructure
  d'annuaire réseau de ce type n'existe ni n'est prévue ailleurs dans ce
  dépôt pour Linux (à distinguer d'Active Directory côté Windows, déjà
  couvert par sa propre série de PRD).

---

## 3. Architecture cible

**P1.** `NssAliasEntry` rejoint `types.ts` sur le modèle exact des autres
entrées fichier (`name`/`members: string[]`). `FilesNssSource` lit
`/etc/aliases` avec le même lecteur de lignes déjà utilisé pour
`/etc/group`/`/etc/netgroup` (`readRecords`, déjà partagé). Le point
d'intégration réel est `localDelivery.ts` : avant remise, résoudre le
destinataire local à travers cette table (expansion récursive si un alias
pointe vers un autre alias, comme un vrai `/etc/aliases`) — c'est ce qui
transforme la fonctionnalité d'un simple affichage `getent` correct en un
comportement de bout en bout observable dans une livraison réelle.

**P2 (option retenue : construire le cache).** Une petite structure LRU/
TTL (quelques entrées, quelques secondes) devant `NameServiceSwitch.lookup`/
`enumerate`, invalidée par le signal déjà émis — aucun nouveau mécanisme
de bus à inventer, seulement un consommateur pour celui qui existe déjà.

---

## 4. Modèle de données

```ts
// nss/types.ts — aliasing mail (P1)
export interface NssAliasEntry {
  name: string;
  members: string[]; // destinataires ou autres alias, expansion récursive à la livraison
}
```

---

## 5. Plan de mise en œuvre

1. **P2** en premier si l'option (a) est retenue — isolé, ne touche à
   aucune sémantique de résolution existante, purement additif au-dessus
   d'un signal déjà correct.
2. **P1** — touche `types.ts`/`FilesNssSource.ts`/`GetentCommand.ts` (peu
   risqué, nouvelle base) et `localDelivery.ts` (le point d'intégration
   réel, à traiter avec le même soin de non-régression que le reste du
   sous-système SMTP).

Après chaque phase : `npx tsc --noEmit -p .`, `npx eslint`, puis exécution
complète des 8 fichiers de tests NSS/getent existants (~1466 lignes) avant
de passer à la suivante.

---

## 6. Stratégie de test

- **Non-régression obligatoire** : les 8 fichiers déjà en place
  (`getent-command.test.ts`, `nss-resolver.test.ts`,
  `linux-nsswitch-resolv-order.test.ts`, `nss-systemd.test.ts`,
  `nss-resolution-unified.test.ts`, `scenario-session-07-getent.test.ts`,
  `nss-merge.test.ts`, `nss-dns-wire.test.ts`).
- **Nouveaux cas** :
  - `getent-aliases.test.ts` (P1) : `getent aliases <nom>` résout un
    alias simple et un alias en chaîne (alias → alias → destinataire
    réel) ; un mail SMTP adressé à l'alias est effectivement livré aux
    destinataires réels par `localDelivery.ts`.
  - `nss-cache-invalidation.test.ts` (P2, option a) : une résolution
    `passwd` mise en cache est effectivement invalidée par
    `linux.iam.user.modified`, pas seulement stockée puis jamais
    rafraîchie.

---

## 7. Risques et points d'attention

- **P1 touche `localDelivery.ts`**, un fichier du sous-système SMTP déjà
  mature et testé séparément — traiter cette intégration avec la même
  discipline de non-régression que le reste de ce sous-système, pas
  seulement comme une extension du côté `getent`.
- **Ne pas confondre P2 (cache) avec une nécessité de correction** — le
  résolveur est déjà correct sans cache aujourd'hui ; P2 est une
  optimisation/complétion d'une infrastructure déjà à moitié construite,
  pas un correctif de bug.
- **Ne pas répertorier `netgroup: nis` comme un défaut dans un futur audit
  sans relire ce PRD** — §1.2 documente explicitement la vérification
  déjà faite ; le retrouver sans ce contexte pourrait conduire à une
  « correction » qui romprait la fidélité.

---

## 8. Critères d'acceptation

- `getent aliases <nom>` retourne les destinataires réels d'un alias
  simple ou en chaîne, formaté `nom: dest1,dest2,…`.
- Un message SMTP adressé à un alias local est livré à ses destinataires
  réels via `localDelivery.ts`, pas seulement affiché correctement par
  `getent`.
- (Si option a retenue) une résolution mise en cache est invalidée par
  les événements IAM/topologie déjà câblés, sans jamais servir une
  réponse périmée après une modification utilisateur/groupe/IP.
- Les 8 fichiers de tests NSS/getent existants passent toujours sans
  modification de leurs assertions à l'issue de toutes les phases.
