# Audit — implémentation des privilèges sur les équipements Cisco

Date : 2026-08-13 · Portée : `CiscoRouter` / `CiscoSwitch` · Branche : `mandeng`

Objet : niveaux de privilège (0-15), `privilege <mode> level`, `enable` /
`disable`, vues d'analyseur (CLI Views / RBAC), autorisation AAA par
commande, application du niveau aux lignes `console` / `vty`.

---

## 0. Méthode, et pourquoi elle est dite avant les conclusions

Trois sources ont été croisées, dans cet ordre :

1. **Lecture du code** — `cli/CliAuthorization.ts`, `CiscoShellBase.ts`,
   `CiscoIOSShell.ts`, `CiscoSwitchShell.ts`, `router/security/CiscoSecurityConfig.ts`,
   `router/aaa/AaaAuthenticator.ts`, `shells/vty/CliShellSession.ts`,
   `terminal/sessions/CiscoTerminalSession.ts`.
2. **Documentation officielle Cisco** (liens en §9). `www.cisco.com` est
   bloqué en sortie depuis cet environnement ; les faits ont été établis
   par recherche indexée sur le domaine `cisco.com` et sont cités avec
   leur page d'origine. **Deux points sont explicitement marqués « non
   vérifié »** plutôt que présentés comme acquis.
3. **Mesure** — 35 sondes rejouées contre le simulateur réel
   (`CiscoRouter`/`CiscoSwitch`, `executeCommand`, `loginAs`, `cliHelp`,
   `cliTabComplete`). Toutes les transcriptions citées ci-dessous sont des
   sorties **réelles**, pas des reconstitutions. Les fichiers de sonde ont
   été retirés de l'arbre après mesure ; ils sont reproductibles à partir
   des séquences citées.

Ce qui a été **trouvé correct** est dit au §8 : sans cela un audit ne
distingue pas un sous-système fragile d'un sous-système attaqué de biais.

---

## 1. Synthèse — la seule chose à retenir

> **`privilege exec level 15 show version` refuse `show version` au niveau 1
> et laisse passer `sh ver`.**

L'autorisation compare la **chaîne tapée** à la **chaîne de la règle**.
IOS résout l'abréviation vers la commande canonique *avant* d'autoriser ;
ici l'abréviation ne ressemble à rien et retombe donc sur le niveau par
défaut. Le contournement demande trois lettres de moins que la commande
elle-même, ne suppose aucune connaissance du simulateur, et vaut pour
**toutes** les commandes des **deux** plateformes.

Le même défaut casse la délégation dans l'autre sens : un opérateur de
niveau 5 à qui l'on a donné `show running-config` obtient le caret sur
`sh run` — l'abréviation la plus tapée d'IOS.

Autour de ce défaut de tête, la mesure a trouvé **29 constats**, dont
**8 de gravité critique** — 5 sont des élévations de privilège ou des
divulgations, 3 sont des mécanismes de sécurité annoncés qui ne
s'exécutent nulle part.

| # | Gravité | Constat | Preuve |
|---|---|---|---|
| C1 | **Critique** | L'abréviation contourne `privilege exec level` | §2.1 |
| C2 | **Critique** | `enable view` sort de n'importe quelle vue vers root/15 **sans mot de passe** | §2.2 |
| C3 | **Critique** | `enable view <autre>` saute d'une vue à l'autre **sans mot de passe** | §2.2 |
| C4 | **Critique** | Le `secret` d'une vue est en **écriture seule** — personne ne le lit | §2.2 |
| C5 | **Critique** | `show running-config` **n'est pas filtré** par niveau — fuite de `snmp-server community` et des condensés | §2.3 |
| C6 | **Critique** | Le secret de vue est rendu **en clair** dans running/startup-config | §2.4 |
| C7 | **Critique** | La vue active est **globale au shell** et **survit à la déconnexion** | §2.5 |
| C8 | **Critique** | `aaa authorization commands` n'est branché que sur le terminal graphique ; `aaa authorization exec` sur rien | §2.6 |
| M1-M12 | Majeur | Fonctions annoncées inopérantes ou absentes | §3 |
| G1-G9 | Génie logiciel | Code mort, magasins doubles, contrats faux | §4 |
| F1-F8 | Fidélité | Messages, carets, ordre de rendu | §5 |

---

## 2. Constats critiques

### 2.1 — C1. L'abréviation contourne tout le mécanisme de niveaux

**Mesuré.** Routeur neuf, `privilege exec level 15 show version`, puis
`disable` :

```
--- show privilege
Current privilege level is 1
--- show version
% Invalid input detected at '^' marker.        ← refusé, correct
--- sh ver
Cisco IOS Software, C2900 Software (C2900-UNIVERSALK9-M), Version 15.7(3)M5
Copyright (c) 1986-2025 by Cisco Systems, Inc.
...                                            ← EXÉCUTÉ
```

**Et dans l'autre sens.** `privilege exec level 5 show running-config`
+ `privilege exec level 5 show`, session à `enable 5` :

```
--- show privilege
Current privilege level is 5
--- show running-config
Building configuration...                      ← accordé, correct
--- sh run
% Invalid input detected at '^' marker.        ← REFUSÉ
```

**Cause.** `CommandLevelTable.levelOf()`
(`shells/cli/CliAuthorization.ts:139`) ne fait qu'une comparaison de
**préfixe textuel** entre la règle stockée et la commande normalisée
(`normalise()` = trim + minuscules + espaces réduits, ligne 88). Aucune
résolution de l'arbre n'a lieu. La règle `exec show version` ne couvre
donc pas `sh ver`, et `authorize()` retombe sur `defaultLevel` — 1 pour
l'arbre utilisateur — donc `run`.

**Conséquences en cascade**, toutes mesurées :

* `cliTabComplete('sh vers')` rend `'show version '` — la complétion
  propose une commande que l'exécution refuse.
* `cliHelp('sh ')`, `cliHelp('sho ')`, `cliHelp('show v')`,
  `cliHelp('show ver')` proposent tous `version`. Seul `cliHelp('show ')`
  — le préfixe **complet** — filtre correctement. Le filtre de `getHelp()`
  (`CiscoShellBase.ts:2825-2833`) construit la ligne à juger par
  concaténation brute `` `${input.trim()} ${c.keyword}` `` : pour
  `input = 'sh '` cela donne `'sh version'`, que `niveauParDefautDe()` ne
  reconnaît dans aucun arbre, donc `null`, donc **non jugé**.
* Dans une vue, l'abréviation échoue dans l'autre sens : `ParserViewRegistry.visible()`
  (ligne 212) compare aussi littéralement, donc une vue qui inclut
  `show version` **refuse `sh ver`**. Une vue est inutilisable au clavier.

Ce constat invalide directement l'affirmation portée par l'en-tête de
`CliAuthorization.ts` : « `executeOnTrie`, la completion et l'aide posent
la MEME question, donc ne peuvent plus repondre differemment ». Elles la
posent au même objet, mais **sur des chaînes différentes**, et répondent
donc différemment.

**Correctif attendu.** Canonicaliser avant d'autoriser : passer la
commande par `CommandTrie.match()` et juger sur
`matchedKeywords.join(' ')`, jamais sur le texte tapé. Les règles doivent
être stockées canonicalisées elles aussi (voir M4).

---

### 2.2 — C2/C3/C4. Le mot de passe d'une vue n'est vérifié nulle part

Cisco documente que `enable view` **demande un mot de passe**, que la vue
racine confère les privilèges de niveau 15, et qu'**une vue doit être
associée à un mot de passe** par la commande `secret`
([Role-Based CLI Access, IOS 15MT](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_usr_cfg/configuration/15-mt/sec-usr-cfg-15-mt-book/sec-role-base-cli.html)).

**Mesuré.** Routeur avec `enable secret ENSEC`, vue `VUE` avec
`secret Vue@2026` :

```
enable view VUE  (mot de passe fourni : "TOTALEMENT-FAUX")  => ""
show parser view => Current view is 'VUE'          ← ENTRÉE ACCORDÉE
enable view       (mot de passe fourni : "AUSSI-FAUX")      => ""
show parser view => Current view is 'root'
show privilege   => Current privilege level is 15  ← NIVEAU 15 ACCORDÉ
```

Puis, depuis la racine ainsi obtenue :

```
configure terminal
enable secret HACKED            ← accepté
```

Trois constats distincts se lisent là-dedans :

* **C2** — depuis n'importe quelle vue restreinte, `enable view` seul
  rend la **racine et le niveau 15**, sans présenter quoi que ce soit.
  Toute la valeur de confinement du mécanisme tombe en une commande de
  onze caractères. Un compte `username X view NOC` est donc, en pratique,
  un compte de niveau 15.
* **C3** — `enable view HIGH` depuis la vue `LOW` est accordé sans le
  secret de `HIGH` (mesuré séparément). Les vues ne sont pas cloisonnées
  entre elles.
* **C4** — `ParserView.secret` (`CiscoSecurityConfig.ts:346`) est **écrit**
  par le handler `secret` (`CiscoShellBase.ts:5180`) et **lu par un seul
  appelant**, `renderViewSecret()`, qui sert le rendu de la configuration.
  Aucun chemin d'authentification ne le consulte. C'est exactement le
  motif que ce dépôt referme partout ailleurs — « une commande acceptée
  dont personne ne lit le résultat » — laissé ouvert sur la commande dont
  c'est la fonction unique.

**Aggravant — le défaut est épinglé comme contrat par un test.**
`tuto-cli-views-cisco.test.ts:176-190` affirme la sortie sans mot de
passe et la présente comme une fonctionnalité anti-souricière :

```js
await ios(r, ['enable view']);
expect(await ios(r, ['show parser view'])).toBe("Current view is 'root'");
// Et la racine retrouve tout.
expect(await ios(r, ['show ip interface brief'])).not.toContain('% Invalid input');
```

Un correctif de C2 fera **échouer ce test**. Il doit être corrigé, pas
contourné.

**Aggravant — un second test croit couvrir la porte et ne couvre rien.**
`probe-privileges-banque.test.ts:249` appelle
`executeCommand('enable view VUE_PRESTA', { passwordInput: 'Vue@Presta2026' })`.
La mesure ci-dessus montre que **n'importe quelle chaîne** passe : ce
`passwordInput` est décoratif, et le test ne discrimine rien. C'est le
pire état d'un test — il donne l'assurance sans la propriété.

**Point de fidélité lié** (non vérifié faute d'accès direct à la page) :
sous AAA, IOS émettrait une requête d'authentification pour l'utilisateur
`root` lors de `enable view`. Non modélisé.

---

### 2.3 — C5. `show running-config` n'est pas filtré par niveau

Cisco documente ce filtrage comme une **mesure de sécurité**, et nomme
lui-même le contre-exemple :

> « This command displays all of the commands that the current user is
> able to modify (…) The command should not display commands above the
> user's current privilege level because of security considerations. If
> so, commands such as `snmp-server community` could be used to modify
> the current configuration of the router and gain complete access. »
> — [IOS Privilege Levels Cannot See Complete Running Configuration](https://www.cisco.com/c/en/us/support/docs/security-vpn/terminal-access-controller-access-control-system-tacacs-/23383-showrun.html)

**Mesuré.** `privilege exec level 5 show running-config` + `privilege exec
level 5 show`, session `enable 5`, `show running-config` rend **la
configuration entière**, dont :

```
username alice privilege 1 secret 5 $1$5a3bb267$GMxzH3cixF6IBk2wvBsiA1
username bob   privilege 1 secret 5 $1$b46a6ab6$mOIfvoax7TqBCSzdcnncZ.
...
snmp-server community SECRETSTRING RO
```

Le simulateur divulgue précisément l'exemple que la documentation Cisco
cite pour justifier le filtrage : la communauté SNMP en écriture-lecture,
et l'ensemble des condensés de mots de passe locaux, à un opérateur de
niveau 5.

C'est le constat le plus lourd pédagogiquement : un laboratoire de
délégation enseigne ici l'inverse de ce que la machine réelle fait, et le
« bon » réflexe appris (donner `show running-config` au niveau 5) est en
réalité une divulgation complète.

---

### 2.4 — C6. Le secret d'une vue est écrit en clair dans la configuration

**Mesuré.** `parser view NOC` / `secret 0 nocpw`, puis `write memory` :

```
parser view NOC
 secret 0 nocpw          ← EN CLAIR
 commands exec include show version
!
username noc privilege 1 secret 5 $1$4664afe2$syyuZSP2EDPfke/8y39ON/
```

Sur la **même machine**, dans le **même fichier**, un secret de compte est
haché et un secret de vue ne l'est pas. Sur IOS, `secret 0 <pw>` signifie
« l'entrée est du clair », jamais « stocke du clair » — c'est la même
convention que `enable secret 0`, que ce dépôt applique correctement
ailleurs. `renderViewSecret()` (`CiscoSecurityConfig.ts:372`) propage
`secretAlgo = 'plain'` jusqu'au rendu au lieu de hacher à l'écriture.

Aggravant : `service password-encryption` ne touche pas cette ligne — le
rendu des vues emprunte un chemin distinct — donc la parade habituelle ne
s'applique pas non plus.

---

### 2.5 — C7. La vue est globale au shell et survit à la déconnexion

`activeParserView` et `selectedParserView` sont des champs du **shell**
(`CiscoShellBase.ts:531,540`). `VtySnapshot`
(`shells/vty/CliShellSession.ts:40-92`) **ne les porte pas** :
`snapshotVtyState()` ne les enregistre pas, `applyVtyState()` ne les
restaure pas. `fermerSessionExec()` (`CiscoShellBase.ts:2528`) remet
`currentPrivilegeLevel`, `mode`, `cmdHistory`, `terminalMonitor` — **pas
la vue**. `reinitialiserSessionApresRedemarrage()` non plus.

**Mesuré.** Compte `username v view VUE secret v`, connexion, puis
déconnexion :

```
loginAs(v)=true
show parser view => Current view is 'VUE'
exit => Connection closed.
[nouvelle session] show parser view => % Invalid input detected at '^' marker.
[nouvelle session] show privilege   => % Invalid input detected at '^' marker.
[nouvelle session] show ip route    => % Invalid input detected at '^' marker.
```

La console est laissée **enfermée dans la vue de l'utilisateur
précédent**, et ne peut même pas demander dans quelle vue elle se trouve.

Ce dernier point est un défaut à part entière : `CliAuthorization`
déclare `show parser view` toujours joignable (`TOUJOURS_EN_EXEC`, ligne
86) au motif explicite qu'« une vue dont on ne peut pas sortir n'est plus
un role, c'est une souriciere ». La garantie ne tient pas, parce que
`show parser view` figure dans `PRIVILEGED_EXEC_ONLY`
(`cisco/CiscoExecScope.ts:35`) et n'est donc **pas enregistrée dans
l'arbre utilisateur** : au niveau 1, l'autorisation l'accorde et l'arbre
ne la contient pas. Deux mécanismes qui se contredisent.

C'est le même défaut que celui que le dépôt a corrigé pour `terminal
monitor` (« ce qui est per-session est qui a accepté de les recevoir ») :
un état de session logé sur un objet partagé par toutes les sessions.

---

### 2.6 — C8. L'autorisation AAA par commande n'est branchée qu'au terminal graphique

`AaaAuthenticator.authorizeCommand()` (`router/aaa/AaaAuthenticator.ts:103`)
est correcte et réellement branchée sur TACACS+. Elle a **un seul
appelant de production** : `CiscoTerminalSession.checkAaaCommandAuthorization()`
(`terminal/sessions/CiscoTerminalSession.ts:659`).

Conséquence mesurée : `aaa authorization commands 15 default group tacacs+`
configuré et rendu dans la configuration, puis `show version` sur le
chemin scripté — **aucun contrôle**, aucune connexion TACACS+, réponse
immédiate. Toute session SSH, telnet ou scriptée échappe donc à
l'autorisation par commande.

C'est littéralement le défaut que ce dépôt a déjà corrigé pour
`test aaa group` (« la commande existait dans `CiscoTerminalSession`, donc
dans le terminal graphique et NULLE PART ailleurs »), reproduit sur le
mécanisme d'autorisation lui-même.

**Deux défauts de sémantique s'ajoutent, indépendants du branchement :**

* `authorizeCommand` filtre les listes par
  `(m.privilegeLevel ?? 15) === privilegeLevel` où `privilegeLevel` est
  **le niveau de la SESSION**. IOS applique la liste correspondant au
  **niveau de la COMMANDE**. Avec la seule liste `commands 15`, une
  session de niveau 15 tapant `show version` (commande de niveau 1) est
  ici soumise à la liste 15 ; sur IOS elle relèverait de la liste 1, non
  configurée, donc non autorisée. Symétriquement `aaa authorization
  commands 1` ne se déclencherait jamais pour une session de niveau 15.
* **`aaa authorization exec` est accepté, stocké, rendu, et consulté par
  personne.** Le parseur le connaît (`CiscoSecurityCommands.ts:99` :
  `authorization: ['exec', 'commands', 'network', 'config-commands',
  'reverse-access']`) et `AaaAuthenticator` n'expose aucune méthode
  correspondante. C'est la commande par laquelle un serveur TACACS+
  attribue le niveau de privilège (`priv-lvl`) à l'ouverture de session —
  la moitié « autorisation » du chapitre AAA est donc décorative.
  `config-commands`, `network` et `reverse-access` sont dans le même état.

---

## 3. Constats majeurs — fonctions annoncées, inopérantes ou absentes

### M1. `privilege level N` sur une ligne : appliqué par une porte sur deux

`Router.loginAs()` (`devices/Router.ts:3137-3162`) lit le niveau **du
compte** (`compte?.privilege ?? 1`) et ignore la ligne.
`CiscoTerminalSession` fait l'inverse et **correctement** :
`consoleLinePrivilegeOverride()` / `vtyLinePrivilegeOverride()` priment
sur le compte, avec le commentaire qui cite la documentation Cisco.

**Mesuré.**

```
line con 0 / privilege level 15 / login local
username joe privilege 1 secret joe
loginAs(joe)=true
show privilege => Current privilege level is 1        ← devrait être 15
```

Deux portes, une seule branchée : le motif exact que ce dépôt referme
ailleurs. Toute session non issue du terminal graphique (SSH, telnet,
script, import de topologie) ignore `privilege level` sur la ligne.

### M2. Le niveau de la ligne console vit sur le shell, pas sur l'équipement

`consoleLinePrivilegeLevel` est un champ de `CiscoShellBase` (ligne 387),
alors que le pendant vty vit sur `VtyLineConfig` (l'équipement). Comme
`createVtyShell()` construit un shell neuf par session, `line con 0` /
`privilege level 15` tapé **via SSH** se range sur le shell de cette
session SSH et disparaît avec elle. Même famille que M1.

### M3. Pas de promotion des commandes parentes

Cisco documente :

> « When you set a command to a privilege level, all commands whose
> syntax is a subset of that command are also set to that level. For
> example, if you set the `show ip traffic` command to level 15, the
> `show` commands and `show ip` commands are automatically set to
> privilege level 15 unless you set them to a different level. »
> — [Configuring Security with Passwords, Privileges, and Logins](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_usr_cfg/configuration/12-4t/sec-usr-cfg-12-4t-book/sec-cfg-sec-4cli.html)

**Mesuré.** `privilege exec level 5 show running-config` n'ajoute **aucune**
ligne `privilege exec level 5 show` à la configuration.

Ce n'est pas cosmétique : c'est le piège n°1 du chapitre — sur une vraie
machine, cette seule commande retire **tous** les `show` au niveau 1, et
c'est le comportement que l'apprenant doit rencontrer puis corriger. Le
simulateur enseigne ici une délégation qui n'a pas d'effet de bord, donc
une fausse sécurité.

### M4. Une règle `privilege` peut être rendue et sans effet

`privilege` (`CiscoShellBase.ts:4551`) écrit la clé **brute** :
`` `${mode} ${args.slice(3).join(' ')}` ``. `CommandLevelTable.levelOf()`
compare cette clé brute à une cible **normalisée en minuscules**.

**Mesuré.**

```
--- privilege exec level 15 SHOW VERSION
--- show running-config | include privilege exec
privilege exec level 15 SHOW VERSION            ← la config l'annonce
--- disable
--- show version | include Cisco IOS Software
Cisco IOS Software, ... Version 15.7(3)M5       ← et la règle ne s'applique pas
```

### M5. Trois dérivations de clé pour un même fait

| Écrivain | Clé produite | Fichier |
|---|---|---|
| `privilege <m> level <n> <c>` | `` `${mode} ${args.slice(3).join(' ')}` `` (brut) | `CiscoShellBase.ts:4569` |
| `no privilege <m> level <n> <c>` | `` `${mode} ${args.slice(3).join(' ')}` `` (brut) | `CiscoShellBase.ts:4629` |
| `privilege <m> reset <c>` | `` `${mode} ${commande.toLowerCase()}` `` | `CiscoShellBase.ts:2110` |

**Mesuré** — `privilege exec reset` ne retire rien quand la casse diffère :

```
--- privilege exec level 5 Reload
--- show running-config | include privilege exec
privilege exec level 5 Reload
--- privilege exec reset Reload
                                     ← aucun message
--- show running-config | include privilege exec
privilege exec level 5 Reload        ← toujours là
```

Échec **silencieux** : l'opérateur croit avoir rendu la commande à son
niveau d'origine.

### M6. Le mot-clé `all` n'existe pas

Cisco documente `privilege <mode> [all] level <n> <commande>`, et le cite
comme la solution recommandée aux problèmes de délégation
(`privilege configure all level 5 interface`,
`privilege exec all level 5 show ip`).

**Mesuré** : `privilege exec all level 5 show ip` → `% Incomplete command.`

De même côté vues : `commands exec include all show ip` → `%Command not found`.

### M7. Les vues ne connaissent que le mode `exec`

`commands configure include interface` et `commands interface include ip address`
sont refusés (`CiscoShellBase.ts:5226`, refus assumé par commentaire).
Une vue IOS s'écrit sur tous les modes d'analyseur ; le sous-système ne
peut donc décrire aucun rôle qui configure quoi que ce soit.

### M8. `include-exclusive` est traité comme `include`

`CiscoShellBase.ts:5243` : `if (sens === 'include' || sens === 'include-exclusive')`.
Sur IOS, `include-exclusive` ajoute la commande à cette vue **et
l'interdit à toutes les autres**. Les confondre laisse deux vues
revendiquer la même commande, ce qu'IOS refuse. Le mot-clé est donc
accepté en produisant autre chose que ce qu'il promet — même forme que
le défaut `username … algorithm-type` corrigé par le PRD §4.

### M9. Aucune limite de 15 vues

Cisco : « The maximum number of CLI views and superviews (…) that can be
configured is 15. This does not include the root view. » **Mesuré** :
17 vues créées sans un message.

### M10. Les vues sont à moitié implémentées sur `CiscoSwitch` — et produisent une vue-piège

`CiscoSwitchShell` n'a **pas de `configViewTrie`**. **Mesuré** sur un
Catalyst :

```
--- parser view NOC              ← accepté, la vue est créée
--- secret noc
^
% Invalid input detected at '^' marker.        ← refusé
--- commands exec include show version
^
% Invalid input detected at '^' marker.        ← refusé
--- show parser view all
Views/Superviews Present in System:
  NOC                            ← la vue existe pourtant
--- enable view NOC
--- show version | include Cisco IOS
                                 ← VIDE : vue sans aucune commande
```

On obtient donc une vue qui existe, ne peut rien contenir, ne peut pas
avoir de mot de passe, et dans laquelle on peut entrer. Un refus franc de
`parser view` sur cette plateforme vaudrait mieux.

### M11. Le sous-mode `config-view` n'est pas confiné

**Mesuré**, à l'intérieur de `parser view NOC` :

```
--- hostname PWNED                        ← exécuté
--- username x privilege 15 secret x      ← exécuté
--- interface GigabitEthernet0/0          ← exécuté, CHANGE DE MODE
--- exit
--- end
--- show running-config | include hostname|username x
hostname PWNED
username x privilege 15 secret 5 $1$7b84dfb1$...
```

`(config-view)#` d'IOS n'accepte que `commands`, `secret`, `name`, `view`,
`exit`, `end`. Ici l'arbre de configuration global est joignable, et
`interface …` déplace la machine à états : le `exit` suivant ne quitte
plus la vue mais l'interface, laissant la définition à moitié faite.

### M12. La complétion par tabulation ne filtre pas

`Router.cliTabComplete()` → `shell.tabComplete()` → `trie.tabComplete()`
(`CiscoShellBase.ts:2861`) : **aucun filtre d'autorisation**, alors que
`tabCandidates()` (ligne 2866) en applique un. **Mesuré** au niveau 1
avec `show version` hissée à 15 : `tabCandidates('show vers')` → `[]`,
`tabComplete('show vers')` → `'show version '`.

---

## 4. Génie logiciel

### G1. `CommandLevelTable` : 4 de ses 6 méthodes sont mortes

`setLevel`, `reset`, `remove`, `grantedAtOrBelow` n'ont **aucun appelant**
dans tout le dépôt (vérifié par recherche exhaustive). Or l'en-tête du
module écrit :

> « Le stockage reste la `Map` que porte l'equipement (…) mais plus
> personne ne la parcourt a la main : la regle de resolution vit ici, une
> fois. »

C'est faux pour les trois écrivains réels, qui manipulent la `Map`
directement (`CiscoShellBase.ts:4570, 4630, 2112`). Le module n'est le
lieu unique que de la **lecture**, et cette asymétrie est précisément la
cause de M4 et M5 : `setLevel` normalise, les écrivains réels non.

### G2. `reglesExecAccordees()` duplique `grantedAtOrBelow()`

`CiscoShellBase.ts:2053` réimplémente, sur la `Map` brute, exactement ce
que `CommandLevelTable.grantedAtOrBelow()` fait — la méthode morte de G1.
C'est la duplication que `CliAuthorization` prétend dans son en-tête avoir
supprimée (« CINQ predicats (…) Chacun relisait la table des regles a sa
facon »). Il en reste un.

### G3. Deux magasins pour les règles de privilège

`_ciscoPrivilegeRules` **décide**. La liste des « unhandled config lines »
(`_recordUnhandledConfigLine`, ligne 4572) **rend**. Rien ne les relie :
M4 est la démonstration qu'ils peuvent diverger, et la configuration
rendue étant **rejouée à l'import d'une topologie**, la divergence est
persistante.

### G4. `CiscoSecurityConfig.usernames` : magasin mort et destructeur

`CiscoSecurityCommands.ts:312` écrit
`sec().usernames.set(name, { name, privilege: privilege ?? 1, secret, password: undefined })`.
Ce magasin n'est **lu nulle part** ; `asRunningConfigLines()` fait même
`void this.usernames;` avec un commentaire expliquant pourquoi il ne le
rend pas. Il perd `view` et `secretAlgo`, et **écrase `privilege` à 1**
quand la commande ne le précise pas. Un second magasin, mort, et faux.
`UsernameEntry` (ligne 154) devrait disparaître avec lui.

### G5. Autorisation **fail-open** quand `deviceRef` est nul

La fabrique de `CommandLevelTable` (`CiscoShellBase.ts:1988-1994`) rend
`undefined` si `this.deviceRef` est nul ; `levelOf()` rend alors le
**niveau par défaut**, donc `authorize()` rend `run`. Une table
d'autorisation illisible doit refuser, pas accorder. Que
`commandVisibleTo()` (ligne 945) ait dû inventer un mécanisme d'emprunt
de device montre que ce cas se produit en pratique.

### G6. Le test qui épingle le défaut, et celui qui ne prouve rien

Détaillé en §2.2 : `tuto-cli-views-cisco.test.ts:176-190` fige C2 comme
contrat ; `probe-privileges-banque.test.ts:249` passe un `passwordInput`
qui n'est jamais vérifié. Un correctif devra traiter les deux.

### G7. Un fichier de mise au point commité

`src/__tests__/unit/network-v2/zz-priv.test.ts` : `describe('p')`,
`it('x')`, quatre `console.log`, un seul `expect(1).toBe(1)`. Il ne peut
pas échouer et ne décrit rien. Introduit par `37b550f5`.

### G8. Commentaires contradictoires sur l'invite, dans le même fichier

`CiscoShellBase.ts:170-174` : « `#` iff level 15 (…) matching real IOS
exactly, where even privilege 7 still shows `>` ».
`CiscoShellBase.ts:2577-2580` : « L'invite affiche `#` des le niveau 2 ».
Le code (ligne 2951) fait le second, qui est le comportement réel d'IOS ;
le premier commentaire est faux et doit être supprimé — la convention du
dépôt étant de supprimer plutôt que de corriger un commentaire.

### G9. Castes non encapsulées répétées

`as unknown as { _ciscoPrivilegeRules?: Map<string, number> }` apparaît à
cinq endroits (`CiscoShellBase.ts` 1989, 2054, 2106, 2568, 4625-4626).
`CLAUDE.md` demande explicitement de passer par les interfaces de
capacité (`HostCapabilities` / `RouterServiceCapabilities`) plutôt que
par un cast en ligne. Une capacité `CiscoPrivilegeStore` manque ici.

---

## 5. Fidélité de rendu et de messages

| # | Constat | Mesuré |
|---|---|---|
| F1 | Caret mal placé : `privilege badmode level 5 show` place le `^` sous `level` (col. 21) au lieu de `badmode` (col. 10) | oui |
| F2 | `privilege exec badkeyword 5 show` rend `% Incomplete command.` là où IOS rend `% Invalid input detected` | oui |
| F3 | Les lignes `privilege …` sont rendues **après** les blocs `interface` et après `! Last configuration change` ; IOS les place dans la section globale | oui |
| F4 | `snmp-server community …` rendu après les interfaces, même remarque | oui |
| F5 | `show parser view all` rend `  NOC  ` (deux espaces avant, deux après) — format **non adossé à une capture réelle**, contrairement à l'exigence posée par `PRD-Tableaux-CLI.md` | à vérifier |
| F6 | Niveau 0 : IOS y place `disable, enable, exit, help, logout`. Le simulateur expose `exit, end, logout` + `disable, enable, show parser view` : `help` manque, `end` n'en fait pas partie sur IOS, `show parser view` y est ajouté | oui |
| F7 | `privilege <mode> level <n> <chaîne>` accepte une commande **inexistante** (`privilege exec level 5 shwo verison` stocké et rendu) alors que `commands exec include` valide contre le trie (`%Command not found`). Deux mécanismes du même fichier, deux exigences. *Le comportement d'IOS sur ce point n'a pas pu être vérifié ; l'incohérence interne, elle, est certaine.* | oui |
| F8 | `parser view` exige `aaa new-model` (correct) mais n'exige pas d'être **authentifié au niveau 15 par mot de passe** pour atteindre la vue racine — corollaire de C2 | oui |

---

## 6. Ce qu'un correctif doit traiter, dans l'ordre

L'ordre suit la dépendance technique, pas seulement la gravité : C1
conditionne la valeur de tout le reste.

1. **C1 — canonicaliser avant d'autoriser.** Juger sur
   `CommandTrie.match(cmd).matchedKeywords`, jamais sur le texte tapé ;
   canonicaliser aussi la règle à l'écriture. Corrige du même coup M12 et
   la fuite de `?` sur préfixe abrégé.
2. **G1/G5/M4/M5 — un seul écrivain.** Router `privilege`, `no privilege`
   et `privilege reset` vers `CommandLevelTable.setLevel/reset/remove` ;
   faire échouer l'autorisation quand la table est illisible.
3. **C2/C3/C4 — brancher le secret des vues.** Plan d'interaction sur
   `enable view [<nom>]` : secret de la vue pour une vue nommée, secret
   d'activation pour la racine. Corriger `tuto-cli-views-cisco.test.ts` et
   `probe-privileges-banque.test.ts`.
4. **C6 — hacher le secret de vue à l'écriture**, comme
   `username … secret`.
5. **C7 — porter `activeParserView` dans `VtySnapshot`** et le remettre à
   zéro dans `fermerSessionExec()` ; enregistrer `show parser view` dans
   l'arbre utilisateur pour que la garantie de sortie tienne au niveau 1.
6. **C5 — filtrer `show running-config`** par le niveau de la session.
7. **C8 — appeler `authorizeCommand` depuis le shell** (donc SSH/telnet/
   script), corriger la sémantique du niveau (niveau de la **commande**),
   et implémenter `aaa authorization exec`.
8. **M1/M2 — une seule règle de niveau à l'ouverture de session** :
   AAA > ligne > compte, lue par `loginAs` **et** par le terminal ;
   déplacer `consoleLinePrivilegeLevel` sur l'équipement.
9. **M3/M6 — promotion des parents et mot-clé `all`.**
10. **M10/M11 — vues sur le commutateur, confinement de `config-view`.**
11. **M7/M8/M9, puis G2/G4/G7/G8/G9, puis F1-F8.**

Chaque correctif devrait être livré avec une sonde **discriminée par
`git stash`**, comme le fait déjà ce dépôt : la mesure ci-dessus fournit
les transcriptions attendues avant et après.

---

## 7. Portée du contournement C1 sur les laboratoires existants

Les fichiers suivants construisent des scénarios de délégation par
niveaux ou par vues, et sont donc à re-mesurer après correctif de C1 :
`probe-privileges-banque.test.ts`, `probe-privileges-multinationale.test.ts`,
`probe-privileges-evasion.test.ts`, `probe-privileges-porte-reseau.test.ts`,
`cross-equipment-privilege-suite.test.ts`,
`cisco-privilege-levels-really-gate.test.ts`,
`cisco-local-auth-privilege-levels.test.ts`,
`conformite-privileges-cisco.test.ts`, `tuto-cli-views-cisco.test.ts`,
`cisco-views-and-round-trip.test.ts`, `attaques-securite-cisco.test.ts`.

Aucun ne tape d'abréviation : c'est pourquoi le défaut a survécu.
`probe-privileges-evasion.test.ts` porte le nom du sujet et ne l'atteint
pas.

---

## 8. Ce qui est correct, et qui n'a donc pas été touché

Le dire est ce qui distingue un audit d'un réquisitoire. Vérifié par
mesure :

* **Le filtrage par niveau fonctionne réellement** dès lors que la
  commande est tapée en toutes lettres — dans les quatre espaces
  (`exec`, `configure`, `interface`, `line`). Mesuré : au niveau 5 avec
  `privilege configure level 5 interface` + `privilege interface level 5
  shutdown`, `shutdown` passe et `ip address …` est refusé.
* **La règle la plus longue gagne**, comme dans l'arbre d'IOS
  (`levelOf`) : `privilege exec level 7 show` et `… level 10 show
  running-config` cohabitent correctement.
* **Hisser une commande la retire vraiment** du niveau inférieur
  (`privilege exec level 5 show` fait disparaître `show privilege` au
  niveau 1) — le mécanisme n'est pas qu'additif.
* **Pas d'escalade par `end`** : une session à `enable 5` qui sort de
  configuration reste au niveau 5 (`modeDeRetour`, ligne 2582).
* **`disable <niveau>`** fonctionne et refuse un niveau supérieur ou
  hors bornes.
* **Le repli de la porte `enable N` sur le secret du niveau 15** est
  correct et correspond à la documentation Cisco.
* **`enable` demande trois essais** puis rend `% Bad secrets`, avec
  `% Access denied` entre-temps, et rend la main en mode utilisateur.
* **`superview`** fonctionne : union réelle des vues membres, refus
  d'imbriquer une superview.
* **`exclude`** fonctionne et prime sur `include`.
* **`username X view Y`** refuse une vue inexistante, se rend sur une
  ligne séparée, et la session s'ouvre bien **dans** la vue via
  `beginExecSession`.
* **L'ordre du rendu des vues** est correct : `parser view` précède
  `username`, les vues membres précèdent les superviews — la
  configuration est rejouable sur ce point.
* **Bornes de niveau** : `privilege exec level 16`, `enable 16`,
  `disable 99`, `username X privilege 16` sont tous refusés.
* **`show privilege`** lit `currentPrivilegeLevel` et non le mode, y
  compris après redémarrage.

---

## 9. Sources

Documentation Cisco (consultée par recherche indexée ; `www.cisco.com`
est bloqué en accès direct depuis cet environnement) :

- [Role-Based CLI Access — User Security Configuration Guide, IOS 15MT](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_usr_cfg/configuration/15-mt/sec-usr-cfg-15-mt-book/sec-role-base-cli.html) — vues, superviews, `enable view` et son mot de passe, limite de 15 vues, `include-exclusive`.
- [Configuring Security with Passwords, Privileges, and Logins, IOS 12.4T](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_usr_cfg/configuration/12-4t/sec-usr-cfg-12-4t-book/sec-cfg-sec-4cli.html) — promotion des commandes parentes, niveaux par défaut.
- [IOS Privilege Levels Cannot See Complete Running Configuration](https://www.cisco.com/c/en/us/support/docs/security-vpn/terminal-access-controller-access-control-system-tacacs-/23383-showrun.html) — filtrage de `show running-config` par niveau et sa justification de sécurité.
- [Controlling Switch Access with Passwords and Privilege Levels (Catalyst 3850)](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3850/software/release/3se/security/configuration_guide/b_sec_3se_3850_cg/b_sec_3se_3850_cg_chapter_011.html) — niveaux 0/1/15, les cinq commandes du niveau 0.
- [Cisco IOS Configuration Fundamentals Command Reference — F through K](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/command/cf_command_ref/F_through_K.html) — syntaxe `privilege <mode> [all] {level <n> | reset} <commande>`.
- [How to Assign Privilege Levels with TACACS+ and RADIUS](https://www.cisco.com/c/en/us/support/docs/security-vpn/remote-authentication-dial-user-service-radius/13860-PRIV.html) — attribution du niveau par AAA.

Documents internes lus : `docs/PRD-Acces-Privileges-Cisco.md`,
`docs/PRD-Acces-Mot-De-Passe-Cisco.md`, `CLAUDE.md`.

---

# 10. Carnet de bord des correctifs

Tenu au fil de l'eau, une entrée par étape. Chaque étape est livrée en
TDD — le test d'abord, rouge vérifié, puis le code — et poussée seule sur
`mandeng`. La non-régression est mesurée sur les **fonctionnalités
connexes** (CLI, privilèges, vues, AAA), pas à l'échelle du dépôt.

Convention de lecture : **Rouge** = ce que le test refusait avant le
code ; **Vert** = ce qu'il vérifie après ; **Portée** = ce qui reste
ouvert et pourquoi.

---

## Étape 1 — `CommandCanonicalizer` : `sh ver` et `show version` sont la même commande

*Traite la racine de C1, M12 et de la fuite du `?`. Aucun câblage encore :
le module est posé et éprouvé seul, avant d'être branché.*

**Fichiers** — `src/network/devices/shells/cli/CommandCanonicalizer.ts` (neuf),
`src/__tests__/unit/network-v2/cli-command-canonicalizer.test.ts` (neuf, 13 cas).

**Rouge** — le module n'existait pas ; le fichier de test ne se chargeait
même pas.

**Vert** — 13/13. `sh ver` → `show version`, `sh run` →
`show running-config`, `SHOW VERSION` → `show version` (la casse vient de
l'**arbre**, pas de la saisie), `pin 10.0.0.1` → `ping 10.0.0.1`.

**Quatre décisions, chacune parce que l'inverse était possible :**

- **Une abréviation ambiguë rend `null`, pas un candidat.** `show c` avec
  `show clock` et `show cdp` déclarés n'est pas une commande ; la résoudre
  arbitrairement ferait porter une décision d'autorisation sur une
  commande que l'opérateur n'a pas désignée. C'est la seule réponse qui
  ne devine pas.
- **Les arguments sont conservés tels quels.** Une règle de niveau est un
  **préfixe** — `privilege exec level 5 ping` couvre `ping 10.0.0.1` —
  donc les effacer changerait la portée de toutes les règles existantes.
  Seuls les mots-clés sont canonicalisés.
- **Une commande incomplète se canonicalise** (`sh` → `show`). L'aide
  juge des lignes incomplètes par construction : sans cela le filtre de
  `?` resterait aveugle, ce qui est précisément le défaut mesuré au §2.1.
- **La source des arbres est un port** (`CanonicalisationSource`), pas une
  référence au shell. Le module est ainsi éprouvable sur des arbres
  jouets, et réutilisable pour VRP — dont la CLI abrège aussi — sans rien
  y changer.

**Vision long terme.** Ce module est délibérément plus général que le
besoin d'aujourd'hui : il prend un `AuthScope` et une liste d'arbres,
alors que le premier câblage n'aura besoin que de l'espace `exec`. C'est
ce qui permettra, sans réécriture, de canonicaliser les règles
`privilege configure|interface|line` (M4/M5), les inclusions de vues
(M8/M7) et l'autorisation AAA par commande (C8), qui ont toutes le même
besoin.

**Portée** — aucun appelant de production à ce stade : `sh ver` contourne
toujours les niveaux. C'est l'objet de l'étape 2.

---

## Étape 2 — l'autorisation décide sur la forme canonique (C1, M4, M5, M12, G3)

*La plus grosse étape du chantier : elle referme le défaut de tête et,
avec lui, trois de ses conséquences.*

**Fichiers** — `cli/CliAuthorization.ts`, `cli/CommandCanonicalizer.ts`,
`CiscoShellBase.ts`, `cisco/CiscoShowCommands.ts`, `CiscoSwitchShell.ts`,
`Router.ts`, `Switch.ts` ;
`src/__tests__/unit/network-v2/cisco-privilege-abbreviation.test.ts` (neuf, 18 cas).

**Rouge — discrimination mesurée : 12 échecs sur 18.** Les 6 cas verts
des deux côtés sont nommés ici plutôt que laissés à découvrir : 2 sont
les cas de **non-régression** (machine sans aucune règle), dont c'est
l'objet même ; 2 sont les cas de vue sur `sh ver`, qui échouaient déjà
dans le bon sens (une vue refusait l'abréviation de ce qu'elle inclut —
inutilisable, mais pas dangereux) ; 2 sont le cas d'abréviation ambiguë,
qui ne prouvait rien du mécanisme.

**Vert** — 18/18, puis **33 fichiers / 1 125 cas** de non-régression sur
les fonctionnalités connexes (privilèges, vues, AAA, aide, complétion,
hygiène du trie, tutoriels d'accès), tous verts. `tsc` : **296 erreurs
avant, 296 après** — aucune ajoutée (le dépôt en porte déjà 296, hors
sujet ici).

**Ce que le correctif fait, dans l'ordre où il fallait le faire :**

1. **`CliAuthorization` reçoit un canonicaliseur** et l'applique dans
   `authorize()` **et** `estAccordee()`. Une seule méthode privée,
   `forme()`, décide quelle chaîne toutes les autres regardent — c'est
   la propriété qui manquait, pas le filtre.
2. **La source d'arbres reflète exactement `niveauParDefautDe`.**
   `arbresDe(scope)` rend `[userTrie, privilegedTrie]` pour `exec`, dans
   **le même ordre** que la résolution du niveau par défaut. Si les deux
   lisaient des arbres différents, ils pourraient décider de deux
   commandes différentes pour une même frappe — la classe de défaut
   qu'on referme. `interface` et `line` nomment désormais leur propre
   arbre, parce que `privilege interface level 5 shutdown` se tape en
   configuration globale, où cet arbre n'est pas actif.
3. **Les trois écrivains passent par une seule dérivation de clé.**
   `setCommandLevel` / `resetCommandLevel` sur `CliAuthorization`
   canonicalisent puis délèguent. `privilege`, `no privilege` et
   `privilege reset` écrivaient la `Map` à la main avec trois
   dérivations, dont deux minusculaient et une non : **M4 et M5 tombent
   ensemble**, parce qu'ils étaient le même défaut vu de deux endroits.
   Au passage, `no privilege` valide enfin son mode et refuse une ligne
   incomplète.
4. **Les règles sont rendues depuis la table qui décide**
   (`privilegeConfigLines`), plus depuis le fourre-tout des « lignes non
   traitées » — **G3**. Deux magasins pour un fait, dont un seul décidait
   et l'autre s'affichait : c'est ce qui laissait
   `privilege exec level 5 Reload` paraître dans la configuration sans
   avoir le moindre effet. La configuration étant **rejouée à l'import
   d'une topologie**, la divergence était persistante. Un seul rendu,
   partagé par le routeur et le commutateur.
5. **`tabComplete` filtre** (**M12**). `tabCandidates` filtrait déjà : la
   *liste* des candidats respectait le niveau et la complétion d'un
   candidat *unique* le contournait. Deux portes sur la même question,
   une seule gardée.
6. **Le filtre de l'aide juge la bonne ligne.** Il concaténait l'entrée
   brute au mot-clé proposé : `show ver?` produisait `show ver version`,
   que nul arbre ne connaît, donc **non jugé, donc proposé** — alors que
   son exécution était refusée. Le mot partiel en cours de frappe est
   maintenant *remplacé*, pas complété.

**Une décision qui méritait d'être écrite.** Le canonicaliseur est
**optionnel** dans le constructeur de `CliAuthorization`. Ce n'est pas
une facilité : c'est ce qui garde le module éprouvable seul, sans arbre,
et ce qui rend son absence explicitement équivalente au comportement
d'avant plutôt que silencieusement dangereuse.

**Portée — ce qui reste ouvert, et pourquoi.** `reglesExecAccordees()`
(G2) duplique toujours `grantedAtOrBelow()` ; la méthode `reglesAccordees`
est en place pour l'absorber, mais la migration est un pas séparé et sans
rapport avec la canonicalisation. La **promotion des commandes parentes**
(M3) et le mot-clé **`all`** (M6) restent entiers : ce sont des règles
d'IOS sur l'*écriture* des règles, pas sur leur lecture.

---

## Étape 3 — le secret d'une vue est vérifié (C2, C3, C4)

*Le défaut le plus grave de l'audit : `ParserView.secret` était écrit par
sa commande, rendu dans la configuration, et lu par personne.*

**Fichiers** — `CiscoShellBase.ts` ;
`src/__tests__/unit/network-v2/cisco-view-password.test.ts` (neuf, 10 cas) ;
`tuto-cli-views-cisco.test.ts` (corrigé).

**Rouge — 5 échecs sur 10.** Les 5 cas verts des deux côtés sont nommés :
2 sont les **limites assumées** (pas de secret sur la vue, pas de secret
d'activation) qui doivent passer des deux côtés ; 1 est le refus d'une
vue inexistante, déjà correct ; et 2 — « le bon secret ouvre la vue » et
« un secret rangé en condensé se vérifie » — passaient avant correctif
**parce que tout ouvrait la vue**. Ces deux-là ne prouvaient rien seuls :
ce sont les trois cas de refus qui portent la démonstration.

**Vert** — 10/10, puis 34 fichiers / 1 135 cas connexes.

**Le mécanisme.** `porteDeVue(nom)` rend ce qui garde l'entrée : le
`secret` de la vue nommée, ou — pour la vue **racine**, qui confère le
niveau 15 — le secret d'activation. `enableViewInteractionPlan` est
calqué sur celui d'`enable` : trois essais sur une même invocation,
`% Access denied` tant qu'IOS redemande, `% Bad secrets` quand il
renonce. `entrerDansUneVue` **consomme** l'autorisation, exactement comme
`enable` consomme la sienne — sans quoi le plan afficherait une invite
que le gestionnaire ignorerait.

**Le branchement se fait aux DEUX portes**, et c'était nécessaire :
`enable view` en mode utilisateur tombait dans le plan d'`enable`, où
`parseInt('view')` donne `NaN`, donc aucun plan, donc aucune
vérification ; en mode privilégié aucun cas ne le reconnaissait. Une
seule des deux aurait laissé l'autre ouverte.

**Une décision qui méritait d'être écrite : sans secret, la porte reste
ouverte.** C'est la même règle qu'`enable` sur une machine sans
`enable secret`, et l'inverse ferait d'une vue sans secret une
**souricière** sur toute topologie déjà enregistrée. La propriété
anti-souricière que le mécanisme revendique est donc préservée telle
quelle : ce qui change, c'est qu'elle ne s'applique plus *malgré* un
secret configuré.

**Trois tests avaient figé le défaut comme contrat** — l'audit l'avait
annoncé (G6), et c'est ce qui s'est produit : ils entraient dans une vue
protégée sans présenter son secret. Ils ont été **corrigés, pas
contournés** : un helper `entrerVue` présente le secret, et chaque cas
vérifie désormais la **vue courante** avant d'éprouver quoi que ce soit —
un `enable view` refusé laisse la session à la racine, où tout
fonctionne, donc l'assertion suivante ne veut rien dire sans ce contrôle.
C'est aussi ce qui rend enfin probant le quatrième cas, que l'en-tête du
fichier signalait lui-même comme passant pour la mauvaise raison.

**Portée.** Le secret de vue est toujours rendu **en clair** quand il a
été saisi sous la forme `secret 0 <pw>` (**C6**) : la porte le vérifie
désormais, mais la configuration le divulgue. C'est l'étape suivante.
Cisco impose par ailleurs qu'une vue ait un secret **avant** de pouvoir
recevoir des commandes ; ce refus n'est pas encore implémenté.

---

## Étape 4 — un `secret` saisi en type 0 est rendu haché (C6, et sa famille)

*L'audit avait nommé C6 sur les vues. La mesure faite pour le corriger a
montré que le défaut était **familial**, et le correctif tient en une
ligne — au bon endroit.*

**Fichiers** — `cisco/ciscoPasswordRender.ts` (une ligne) ;
`src/__tests__/unit/network-v2/cisco-secret-type0-hashed.test.ts` (neuf,
12 cas) ; `cisco-password-render.test.ts` et
`cisco-password-encryption.test.ts` (corrigés).

**Ce que la mesure a ajouté au constat.** Le chiffre `0` était rangé
comme un **algorithme** (`plain`) par les **trois** commandes de la
famille — `enable secret`, `enable secret level N`, `username … secret`
et le `secret` d'une vue — alors qu'il décrit le format de ce qu'on
**tape**. Un `secret` est irréversible par définition : IOS rend
`enable secret 0 cisco` en `enable secret 5 $1$…`. Le défaut n'était donc
pas propre aux vues, et le corriger sur les seules vues aurait laissé la
même fuite sur les deux commandes les plus tapées du chapitre.

**Rouge — 5 échecs sur 12**, soit exactement les cinq sorties
d'équipement (vue, `enable secret 0`, `enable secret level N 0`,
`username … secret 0`, et le commutateur). Les 7 verts des deux côtés
sont les cas de non-régression de la famille **réversible** et les
formes déjà correctes (condensé collé, forme nue).

**Vert** — 12/12, puis **39 fichiers / 1 189 cas** connexes, dont toute
la famille des mots de passe (`cisco-password-render`,
`cisco-password-encryption`, `cisco-enable-password`,
`cisco-accounts-one-referential`, `probe-acces-mot-de-passe-et-console`).

**Pourquoi une seule ligne suffit.** `renderSecretField` et
`renderPasswordField` sont déjà **proprement séparés** : le premier ne
sert que les `secret` (irréversibles), le second la famille `password`
(réversible, où le clair reste légitime tant que
`service password-encryption` n'est pas posé). Vérifié appelant par
appelant avant de toucher quoi que ce soit. Le correctif consiste donc à
faire tomber `'plain'` dans la branche `md5` du **seul** rendu concerné,
et il vaut du même coup pour les quatre commandes et les deux
plateformes. Un correctif par commande aurait été quatre fois plus long
et aurait pu diverger.

**Deux tests figeaient l'ancien comportement**, et ils sont corrigés
plutôt que contournés — même motif que G6 à l'étape 3.
`cisco-password-render` affirmait le rendu verbatim, donc la fuite
elle-même. `cisco-password-encryption` avait un objet **légitime** —
l'étiquette `secret` et non `password` — qu'il vérifie toujours ; seule
son assertion figeait en plus la valeur en clair.

**Limite assumée, écrite plutôt que tue.** Le secret reste stocké **en
clair en mémoire** et n'est haché qu'au rendu — c'est déjà le cas de la
forme nue depuis toujours, et changer le modèle de stockage est un autre
chantier. Ce qui fuyait, et qui est refermé, c'est la **configuration**,
c'est-à-dire ce qui s'affiche, s'enregistre et se rejoue.

---

## Étape 5 — une vue appartient à la session, pas à la machine (C7)

**Fichiers** — `shells/vty/CliShellSession.ts`, `CiscoIOSShell.ts`,
`CiscoSwitchShell.ts`, `CiscoShellBase.ts`,
`terminal/sessions/CiscoTerminalSession.ts` ;
`src/__tests__/unit/network-v2/cisco-view-is-per-session.test.ts` (neuf, 6 cas).

**Rouge — 5 échecs sur 5** au premier jet (le 6ᵉ cas est né du défaut
trouvé en chemin, ci-dessous).

**Vert** — 6/6, puis **41 fichiers / 1 429 cas** connexes.

**Le correctif.** `activeParserView` entre dans `VtySnapshot`, donc
`snapshotVtyState()` l'enregistre et `applyVtyState()` le restaure, sur
les deux plateformes. `fermerSessionExec()` et
`reinitialiserSessionApresRedemarrage()` le remettent à `null` — la
première laissait la console **enfermée dans le rôle de l'opérateur
précédent**, sans qu'elle puisse même demander lequel.

**Le sens compte dans les deux directions**, et une seule des deux aurait
paru suffisante : une vue qui **survit** confine quelqu'un qui n'a rien
demandé ; une vue qui **fuit** vers une autre session lui donne un rôle
qu'elle n'a pas présenté. Les six cas couvrent les deux.

**Un défaut trouvé en rendant la vue per-session, et corrigé avec elle.**
`InteractionPlanContext.view` était **déclaré et rempli par personne** —
le motif « écrit, lu par personne » pris à l'envers. Tant que la vue
était globale au shell, l'oubli ne se voyait pas : le planificateur
lisait la bonne valeur par accident. Dès que la vue voyage avec sa
session, une commande **absente de la vue ouvrait quand même son
dialogue** : `reload` demandait confirmation à un opérateur qui n'a pas
le droit de recharger. `CiscoTerminalSession` transmet désormais la vue
de sa session, comme il transmettait déjà son niveau.

**Et le repli devait changer avec lui.** `ctx?.view ?? this.activeParserView`
confondait une vue **racine transmise explicitement** (`null`) avec une
**absence de contexte**, et retombait alors sur la vue du shell —
c'est-à-dire sur celle d'une autre session. Le test d'appartenance
(`'view' in ctx`) distingue les deux.

**Une leçon de méthode, notée parce qu'elle a failli coûter cher.** La
non-régression a signalé un cas de `attaques-securite-cisco.test.ts`. La
reproduction rapide que j'en ai faite échouait **identiquement avant mes
changements** : elle ne reproduisait pas le laboratoire du test, et
conclure dessus aurait envoyé chercher une régression inexistante dans le
rendu des mots de passe. C'est la comparaison avec l'état d'avant, et
non la reproduction seule, qui a tranché.

---

## Étape 6 — `show running-config` ne montre que ce qu'on peut modifier (C5)

*Le constat le plus lourd pédagogiquement : le simulateur divulguait
précisément l'exemple que Cisco cite pour justifier le filtrage.*

**Fichiers** — `cli/CliAuthorization.ts` (`filterConfigForLevel`),
`CiscoShellBase.ts`, `CiscoIOSShell.ts`, `CiscoSwitchShell.ts` ;
`src/__tests__/unit/network-v2/cisco-running-config-filtered.test.ts`
(neuf, 9 cas) ; `probe-privileges-multinationale.test.ts` (corrigé).

**Rouge — 7 échecs sur 9.** Les 2 verts des deux côtés sont les cas de
**non-régression au niveau 15**, dont c'est l'objet.

**Vert** — 9/9, puis **42 fichiers / 1 439 cas** connexes, plus les
**9 fichiers / 86 cas** de sérialisation et d'aller-retour de topologie.

**Le mécanisme, et la seule décision qui comptait.** `filterConfigForLevel`
juge chaque ligne : à l'indentation 0 dans l'espace `configure`, indentée
dans l'espace du bloc qui la porte (`interface` → `interface`, `line` →
`line`). **Un bloc dont l'en-tête est invisible disparaît en entier** —
montrer ` ip address 10.0.0.1` sans dire de quelle interface il s'agit ne
serait ni plus sûr ni plus lisible. Les lignes d'ancrage (`!`, `end`, les
en-têtes) ne sont gouvernées par aucun niveau et traversent.

**Au niveau 15, la sortie est rendue telle quelle**, par un retour
anticipé : le cas courant ne traverse aucune logique nouvelle, ce qui
borne le risque de ce correctif à la seule situation qu'il vise.

**`show startup-config` est filtré aussi.** La NVRAM porte la *même*
configuration que la mémoire vive ; laisser l'autre commande la rendre en
entier aurait rouvert la fuite par la porte d'à côté.

**Vérifié plutôt que supposé : l'export de topologie n'est pas touché.**
Il passe par `Router.getRunningConfig()` → `shell.getRunningConfigText()`,
et non par la commande du trie — donc il capture toujours l'intégralité,
ce qu'un export doit faire. Les neuf fichiers d'aller-retour le
confirment.

**Un test encodait C5 comme contrat de scénario**, et c'est le troisième
de la série (après G6 à l'étape 3 et les deux de l'étape 4).
`probe-privileges-multinationale` affirmait qu'un auditeur de niveau 5
« LIT la configuration entière », y compris les comptes locaux et les
délégations — exactement ce que Cisco dit qui ne doit pas arriver. Le
scénario **garde son objet** (« lire n'est pas écrire ») et gagne le bon
enseignement : déléguer `show running-config` ne délègue pas la lecture
de tout, et ce que l'auditeur doit voir se délègue ligne à ligne. Un
second cas a été ajouté pour montrer cette délégation explicite, plutôt
que de retirer la propriété sans la remplacer.

**Portée.** Reste C8 — l'autorisation AAA par commande, branchée sur le
seul terminal graphique — puis les constats majeurs M1/M2 (le niveau de
la ligne), M3/M6 (promotion des parents, mot-clé `all`), M7/M8/M9/M10/M11
(les vues), et le nettoyage G1/G2/G4/G7/G8/G9.

---

## Étape 7 — l'autorisation AAA par commande garde toutes les portes (C8)

**Fichiers** — `router/aaa/AaaAuthenticator.ts`, `cli/CliAuthorization.ts`,
`CiscoShellBase.ts`, `shells/vty/CliShellSession.ts`, `CiscoIOSShell.ts`,
`CiscoSwitchShell.ts`, `HuaweiVRPShell.ts`, `HuaweiSwitchShell.ts`,
`Router.ts`, `Switch.ts`, `terminal/sessions/CiscoTerminalSession.ts` ;
`src/__tests__/unit/network-v2/cisco-aaa-command-authorization-everywhere.test.ts`
(neuf, 9 cas).

**Rouge — 5 échecs sur 8** au premier jet (le 9ᵉ cas est né de la
régression trouvée en chemin). Les 3 verts des deux côtés sont les cas de
non-régression : sans `aaa authorization commands`, et sans utilisateur
authentifié, rien ne doit changer.

**Vert** — 9/9, puis **45 fichiers / 1 468 cas** connexes. `tsc` : aucune
erreur ajoutée (2 retirées ; la base est passée de 296 à 321 du fait d'un
travail concurrent sur la branche, pas de ce chantier).

**Une porte, pas deux.** La garde vit désormais sur
`Router.executeCommand` / `Switch.executeCommand`, que **tous** les
appelants empruntent — terminal, vty, SSH, telnet, script. Celle que
portait `CiscoTerminalSession` est **retirée** : la garder en plus aurait
soumis deux fois la même commande au serveur et doublé ses compteurs.

**La sémantique était fausse, et les deux défauts se voyaient l'un
l'autre.** La liste consultée était choisie sur le niveau de la
**session** ; IOS la choisit sur le niveau de la **commande**.
`levelOfCommand` la lit sur la forme canonique (étape 2), donc une
commande **descendue par `privilege`** change de liste avec son niveau.
Corriger le branchement sans la sémantique aurait fait refuser des
commandes de niveau 1 sur toute machine portant
`aaa authorization commands 15` — le correctif aurait été pire que le
défaut.

**L'identité voyage avec la session.** La porte n'avait aucun nom à
soumettre pour une session ouverte par le terminal : l'utilisateur vivait
sur `configSessionLabel`, un champ du **shell**. C'est le même défaut que
C7, sur un troisième champ — et il avait sa propre conséquence, deux
sessions simultanées s'attribuant mutuellement leurs commandes dans les
traces de comptabilité. `VtySnapshot` porte donc `sessionUser`, comme il
porte le niveau et la vue.

**La régression trouvée en chemin, et ce n'était pas l'autorisation mais
le MOMENT.** Deux cas Huawei sont tombés. Cause : un `await`
inconditionnel sur le chemin que **toute** commande emprunte diffère
l'exécution d'un tour de micro-tâches — donc change l'instant où une
commande prend effet, y compris sur une machine sans le moindre AAA. Un
appelant qui n'attend pas `executeCommand` voyait son `system-view`
arriver trop tard. `hasCommandAuthorization` est donc un prédicat
**synchrone**, et la porte rend `null` synchroniquement quand il n'y a
rien à autoriser ; elle ne rend une promesse que lorsqu'une autorisation
a réellement lieu. Un cas dédié le fixe.

**Une erreur de ma part, dite plutôt que tue.** Une découpe de fichier
mal bornée a supprimé `Router.jouerDialogueSansTerminal` au passage.
C'est la non-régression connexe qui l'a attrapée immédiatement
(`TypeError` sur 20 cas), et non une relecture — argument de plus pour
faire tourner la suite connexe à chaque étape plutôt qu'à la fin.

**Portée.** `aaa authorization exec` — la commande par laquelle un
serveur TACACS+ attribue le niveau de privilège à l'ouverture de session
— reste **acceptée, stockée, rendue et consultée par personne**, de même
que `config-commands`, `network` et `reverse-access`. C'est la moitié
restante de C8, et l'étape suivante.
