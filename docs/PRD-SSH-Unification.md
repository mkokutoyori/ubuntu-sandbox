# PRD — Unification des chemins SSH (étape 1 : shells serveur stateful)

## 1. Contexte

### 1.1 Le problème : quatre drivers clients

Le simulateur possède **quatre** implémentations client d'une session SSH
interactive, conséquence de deux architectures de terminal parallèles
(`src/terminal/sessions/` historique, `src/shell/` plus récente) :

| Driver | Transport | Utilisé pour |
|---|---|---|
| `SshInteractiveSubShell` | vrai fil, canal shell persistant | Linux → Linux |
| `RemoteShellSubShell` | vrai fil, un exec par ligne | repli, machine non résolue |
| `adoptRemoteChild` + `createSessionForDevice` | **en mémoire** | terminal Linux → Cisco/Huawei/Windows |
| `sshLauncher` + `CrossVendorRemoteShell` | **en mémoire** | terminaux Windows cmd/PowerShell |

Le coût de cette duplication est mesuré, pas théorique : la correction du
bug « SSH survit au débranchement » (docs/PRD-Link-State.md) a dû être
appliquée **trois fois**, sur trois de ces chemins.

### 1.2 Le serveur, lui, est déjà unifié

`SshServerHandler` traite `shell_open` / `shell_input` de façon
vendor-agnostique, et les trois vendeurs implémentent
`ISshServerContext.getShell()` :
`LinuxSshServerContext`, `RouterSshServerContext`, `WindowsSshServerContext`.

### 1.3 Pourquoi le verrou Linux ne peut pas être levé tel quel

Le chemin en mémoire (ligne 3 du tableau) existe pour deux raisons
concrètes, vérifiées par sonde sur le vrai fil :

**a) Le shell serveur routeur est sans état.**
`RouterSshServerContext.getShell()` (`RouterSshServerContext.ts:104`)
délègue chaque ligne à `CiscoRouter.runSshCommandSync`
(`CiscoRouter.ts:413`), un filtre à motifs one-shot. Résultat mesuré sur
le vrai fil :

| Commande | Résultat |
|---|---|
| `hostname` | `router-cisco` |
| `show version` | bannière IOS complète |
| `enable` | `command not recognised on this device` |
| `configure terminal` | `command not recognised on this device` |
| `hostname R99` | `command not recognised on this device` |

Basculer les routeurs sur le vrai fil aujourd'hui supprimerait donc la
**configuration d'un routeur par SSH**. Windows, à l'inverse, a déjà un
shell serveur qui tient son état (`cd` persiste d'une ligne à l'autre).

**b) Le prompt ne circule pas.**
`ILinuxShell` (`ISshServerContext.ts:31`) n'expose que
`execute(line)` — aucun prompt. Le prompt est purement client :
`SshInteractiveSubShell.getPrompt()` code en dur la forme bash
`user@host:cwd$`. Un routeur change pourtant de prompt selon le mode
(`R1>` → `R1#` → `R1(config)#`), et Windows affiche `C:\Users\User>`.

### 1.4 Précédents à réutiliser

- **Isolation par canal** : `LinuxSshServerContext.getShell()`
  (`LinuxSshServerContext.ts:322`) alloue une `LinuxShellSession` dédiée
  par canal — « exactement comme un vrai pty » — et la libère via
  `ILinuxShell.dispose()`. `SshServerHandler` appelle `getShell()` **une
  fois** par `shell_open` et réutilise l'objet pour chaque
  `shell_input` (`SshServerHandler.ts:403`, `:453`). C'est le modèle à
  suivre pour les routeurs.
- **Shell routeur déjà stateful et déjà porteur du prompt** :
  `IRouterShell` expose `execute(router, rawInput)` (le mode vit dans
  l'instance) **et** `getPrompt(router)`. `Router.createShell()`
  (`Router.ts:645`) permet d'instancier un shell neuf — donc un contexte
  de mode propre par canal, config d'équipement partagée : la sémantique
  VTY réelle.
- **Le fil est extensible sans rupture** : les réponses sont du JSON
  (`conn.write(JSON.stringify({ ...result, channelId }))`,
  `SshServerHandler.ts:454`). Ajouter un champ est purement additif.

## 2. Objectif de cette étape

Rendre les shells serveur de **tous** les vendeurs aussi capables que
celui de Linux, et faire circuler le prompt sur le fil.

**Aucun chemin client n'est supprimé dans cette étape.** C'est un
prérequis : il ajoute des capacités sans retirer de comportement, donc
sans risque de régression. Le retrait du bypass devient une étape
ultérieure, mécanique.

Bénéfice immédiat et indépendant : configurer un routeur par SSH sur le
vrai fil devient possible, ce qui ne l'est pas aujourd'hui.

### 2.1 Phases

| Phase | Contenu | Dépend de |
|---|---|---|
| A1 | Prompt sur le fil : `ILinuxShell.getPrompt?()`, propagation serveur → canal → client | — |
| A2 | Shell serveur routeur stateful par canal (modes enable/config), prompt vendeur | A1 |
| A3 | Prompt Windows (`C:\…>`) sur le fil | A1 |
| A4 | Le client interactif affiche le prompt du serveur quand il est fourni | A1, A2, A3 |

## 3. Modèle

### 3.1 Contrat de prompt

```ts
export interface ILinuxShell {
  execute(line: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Prompt courant du shell distant. Absent = le client garde le sien. */
  getPrompt?(): string;
  dispose?(): void;
}
```

`ExecResult` gagne `prompt?: string`, renseigné par `SshServerHandler`
après chaque ligne — le prompt d'**après** exécution, puisque la commande
peut l'avoir changé (`enable`, `configure terminal`).

### 3.2 Isolation du shell routeur par canal

`RouterSshServerContext.getShell()` retourne un shell adossé à une
instance `IRouterShell` **neuve** (via `Router.createShell()`), pas au
shell console partagé :

- le mode (user exec / privileged / config) est propre à la session SSH,
  comme une vraie ligne VTY ;
- la configuration de l'équipement reste partagée, puisqu'elle vit sur le
  `Router`, pas sur le shell.

## 4. Critères d'acceptation

1. `ILinuxShell.getPrompt?()` reste optionnel : un contexte serveur qui ne
   l'implémente pas fonctionne exactement comme avant.
2. Une réponse `shell_input` porte le prompt d'après exécution.
3. Sur le vrai fil vers un routeur Cisco : `enable` puis
   `configure terminal` puis `hostname R99` **prennent effet**, et
   `show running-config` reflète le changement.
4. Le prompt renvoyé suit le mode : `R1>` → `R1#` → `R1(config)#`.
5. Deux sessions SSH simultanées vers le même routeur ont des modes
   indépendants ; la config, elle, est partagée.
6. Une session SSH en mode config n'altère pas le mode de la console
   locale du routeur.
7. Idem sur Huawei (`<R1>` → `[R1]`).
8. Windows renvoie son prompt (`C:\Users\User>`).
9. Non-régression : toute la suite SSH existante passe inchangée.

## 4bis. Étape 2 — ce que coûte réellement le retrait des bypass

L'étape 1 a levé les deux blocages qu'elle visait. Une mesure des
capacités effectives montre qu'elle ne suffit pas : le bypass en mémoire
n'est pas seulement un raccourci, il apporte des fonctions que le vrai
fil ne transporte pas encore.

| Capacité | Bypass en mémoire | Vrai fil |
|---|---|---|
| Exécution ligne par ligne | oui | oui |
| État de session (cwd, mode CLI) | oui | oui (depuis A2) |
| Prompt vendeur | oui | oui (depuis A1/A3/A4) |
| Code retour réel | oui | oui (depuis A5) |
| **Complétion Tab** | oui | **non** |
| **Aide contextuelle `?` (IOS/VRP)** | oui | **non** |
| **Sous-shells (PowerShell, SQL\*Plus, RMAN)** | oui | **non** |
| **Éditeurs (vim, nano)** | oui | **non** |

Les quatre dernières lignes sont documentées par le code lui-même
(en-tête de `SshInteractiveSubShell`, « Still out of scope: … `sqlplus`,
RMAN, `sftp`/`ftp` sub-shells, `vim`/`nano` »), et `SshInteractiveSubShell`
n'implémente pas `ISubShell.getCompletions`.

Conséquence : **basculer aujourd'hui un vendeur quelconque sur le vrai
fil est une régression fonctionnelle**, y compris pour les routeurs — on
y perdrait `?` et Tab, qui sont au cœur de l'usage pédagogique d'un CLI
Cisco.

### 4bis.1 Obstacle structurel : la complétion est synchrone

`ISubShell.getCompletions?(line): string[]` est **synchrone**, et le
terminal l'appelle ainsi (`LinuxTerminalSession` ligne 3642). Une
complétion servie par le serveur suppose un aller-retour asynchrone sur
le canal. Porter la complétion sur le fil impose donc d'abord de rendre
asynchrone le chemin de complétion de la couche terminal — ce n'est pas
un détail d'implémentation, c'est un changement de contrat.

### 4bis.2 Prérequis ordonnés

| Prérequis | Contenu | Ampleur |
|---|---|---|
| B1 | Chemin de complétion asynchrone dans la couche terminal, puis `shell_complete` sur le fil (Tab + `?`) | moyen |
| B2 | Empilement de sous-shells côté serveur (PowerShell, SQL\*Plus, RMAN) | lourd |
| B3 | Éditeurs sur le fil (vim / nano) | lourd |
| B4 | Retrait des bypass, `CrossVendorRemoteShell` replié | mécanique une fois B1-B3 faits |

Tant que B1-B3 ne sont pas faits, le nombre de drivers clients reste à
quatre. Les réduire prématurément échangerait de la dette d'architecture
contre de la perte de fonctionnalité — un mauvais échange.

### 4bis.3 B2 : l'empilement est piloté par l'enregistrement du shell

Un interpréteur n'est plus déclaré à deux endroits (une table de
déclencheurs dans `LinuxBashShell`, un aiguillage dans le serveur SSH).
`ShellFactory.register(kind, ctor, { launcher, launchableFrom })` porte
désormais la ligne de commande qui l'ouvre ; `launcherKindFor(line,
from)` répond à la question « cette ligne ouvre-t-elle un REPL ? », et
les deux consommateurs — le terminal local (`LinuxBashShell`) et la pile
serveur (`SubShellStack`, utilisée par `LinuxSshServerContext`) — la
posent au même endroit. Ajouter `python3`, `psql` ou `mysql` se réduit
donc à écrire l'adaptateur `IShell` et à l'enregistrer avec son
`launcher` : prompt, complétion, `exit` et passage sur le fil SSH
suivent sans toucher au terminal ni au serveur.

Corollaire côté client : `exit` n'appartient plus au client. Le serveur
publie `nested` à chaque réponse `shell_input` (`ILinuxShell.isNested`,
`SshVtyShell.isNested`) ; tant qu'un interpréteur est empilé,
`SshInteractiveSubShell` laisse passer `exit` sur le fil au lieu de
fermer la session — seul l'`exit` du shell de login la termine.

Reste ouvert sous B2 : `lsnrctl` n'a pas d'adaptateur `IShell`
enregistré, donc il continue de s'exécuter comme une commande unique et
non comme un REPL.

### 4bis.4 B3 : le moteur d'édition tourne là où est le fichier

Mesure préalable : un aller-retour sur le fil n'est **pas** synchrone
(la réponse arrive au tick suivant), donc un `EditorFsContext` distant
synchrone était exclu — il aurait fallu mentir sur le résultat des
écritures. Le moteur tourne donc côté serveur, sur la session shell du
canal, et seuls les frappes et un écran sérialisable traversent le fil :

    client → serveur  { op: 'editor_open', data: '<ligne>' }
    client → serveur  { op: 'editor_key' | 'editor_paste' | 'editor_cursor' }
    serveur → client  { op: 'editor_view', view }
    client → serveur  { op: 'editor_close' }

Même forme d'extensibilité que B2 : `registerEditorSession` lie un
moteur à un nom d'éditeur, `parseEditorLaunch` est le seul endroit qui
sait quelles lignes ouvrent un éditeur et ce que valent `-v`, `-l`,
`+LIGNE,COL`. Un futur moteur, c'est une entrée dans chacun.

Côté rendu, les overlays n'ont pas été dupliquées : `VimEditor` /
`NanoEditor` acceptent un `driver` optionnel — exactement la surface
qu'elles lisaient déjà sur un moteur local — et les deux fonctions de
vue pures appelées avec arguments (`:set list` de vim, colonnes
d'affichage de nano) vivent dans `editorRender.ts`, partagées.

Vérifié de bout en bout : les permissions, les fichiers d'échange et
`:!cmd` sont ceux du distant (un `:w` dans `/etc/` sous un compte non
privilégié rend le refus du distant et ne laisse aucun fichier), et un
test Playwright édite puis enregistre un fichier sur `PC2` en vérifiant
qu'aucun fichier n'apparaît sur `PC1`.

Reste ouvert sous B3 : les éditeurs ne sont ouverts sur le fil que
depuis une session Linux ; les hôtes Windows et les CLI vendeurs n'ont
pas d'éditeur à exposer.

### 4bis.5 B4 : « mécanique » était faux — mesure

Le PRD annonçait B4 comme mécanique une fois B1-B3 faits. **C'est
démenti par la mesure.** En basculant le terminal Linux sur le fil pour
tous les vendeurs, la suite SSH+shell passe de 4 échecs (préexistants) à
**21**. Les capacités fonctionnelles, elles, étaient bien là :
`configure terminal`, `system-view`, l'empilement PowerShell et `exit`
passaient déjà — ce qui manquait, c'est tout ce qu'un client *supposait*
au lieu de le demander au distant.

Cinq de ces suppositions ont été retirées et remplacées par des
capacités portées par le fil, chacune couverte par un test :

| Supposition du client | Capacité du fil |
|---|---|
| le prompt est une forme bash tant qu'aucune ligne n'a tourné | `prompt` dans l'accusé de `shell_open` |
| `clear` efface l'écran | `posixShell` — sur cmd c'est inconnu, sur un CLI vendeur `clear counters` est une vraie commande |
| Ctrl+D déconnecte | idem `posixShell` — cmd.exe l'ignore |
| une demande de mot de passe vient forcément du client | `pendingInput` dans la réponse + op `shell_input_value` |
| `exit`/`logout` sont les mots de sortie | `sessionEnded` — le distant annonce sa propre déconnexion |

Après quoi il restait **6 échecs**, tous de la même famille : un `ssh`
imbriqué tapé *à l'intérieur* d'un saut vendeur. Le bascule a donc été
**annulée** — le terminal Linux reste sur le bypass pour les vendeurs —
plutôt que de livrer 6 régressions. Les capacités ci-dessus sont
conservées : elles n'enlèvent rien et sont ce dont la bascule aura
besoin.

### 4bis.6 B4 : la bascule est faite pour les sessions d'origine Linux

Les deux points restants ci-dessus avaient **la même cause**, trouvée en
corrigeant un bug signalé à l'usage : le passthrough générique de
`SshInteractiveSubShell` avait un retour anticipé pour le cas
`onProgress` — celui que le terminal emprunte toujours — qui jetait
d'abord le `pendingInput` du distant, puis son `sessionEnded`. Le saut
imbriqué depuis une frame vendeur n'échouait donc pas : il ne demandait
rien. Les deux chemins de retour sont maintenant fusionnés, ce qui
supprime la classe de bug plutôt que ses deux instances.

Un troisième écart est apparu à la bascule : le fil publie le nom
canonique du compte (`C:\Users\User`), le bypass ré-affichait la casse
tapée (`C:\Users\user`). Le fil a raison — un profil Windows porte
l'orthographe du compte. `ShellFactory` et `adoptRemoteChild` résolvent
désormais le compte via `resolveAccountName`, donc les deux chemins
s'accordent.

État : **le terminal Linux pilote tous les vendeurs sur le fil**, sans
régression (mêmes 3 échecs préexistants qu'avant la bascule, 33 tests
e2e SSH au vert). Sept assertions portaient sur l'architecture du bypass
(`foreground instanceof <Vendeur>TerminalSession`) : elles portent
maintenant sur le comportement (le prompt du vendeur, le hostname du
petit-fils), puisqu'un saut piloté par le fil n'a pas de session enfant
locale dont être une instance.

Reste pour clore B4 : les terminaux d'origine **Windows**
(`WindowsTerminalSession`) et **CLI vendeur** (`CLITerminalSession`)
utilisent encore `createSessionForDevice` + `adoptRemoteChild`. Les
basculer suit la même recette, désormais éprouvée ; `CrossVendorRemoteShell`
ne pourra être replié qu'ensuite.

## 5. Hors périmètre

- Le retrait effectif des chemins clients en mémoire (étape 2) et le
  repli de `CrossVendorRemoteShell` — dont l'empilement de sous-shells
  (PowerShell / SQL*Plus / RMAN par-dessus SSH) devra migrer côté
  serveur. Cette étape ne fait que lever les blocages qui l'empêchent.
- `createInteractiveShell()` (streaming, Ctrl+C temps réel) pour les
  vendeurs non-Linux : le repli documenté sur `getShell().execute()`
  reste en place.

## 6. Ce qui reste sur la SECONDE pile SSH (`src/shell/`), mesuré

Relevé fait d'abord par lecture, puis MESURÉ (voir §6.1). Le plan de refonte SSH annonçait cette
pile comme « un second chantier de taille comparable ». Elle est en fait
**à moitié migrée**, et le reste tient en deux points précis.

**Déjà filaire.** Le chemin INTERACTIF de `sshLauncher.ts` passe par
`openWireSshShell()` puis `WireRemoteShell` (l. 438 et 478) — une vraie
session, un vrai canal. `WireRemoteShell` dit lui-même remplacer
`CrossVendorRemoteShell`, et `ssh-no-legacy-shell.test.ts` épingle déjà
que la couche terminal ne référence plus l'ancien pilote.

**Encore local, et c'est exactement le défaut que l'audit visait :**

1. **`sshLauncher.ts:370` — `verifyCredentials()`**. Le mot de passe est
   vérifié par un appel direct à `device.checkPassword()` / `userMgr`,
   zéro octet sur le fil, AVANT toute session. Le serveur ne voit donc
   pas cette authentification : ni `MaxStartups`, ni le throttling
   fail2ban, ni `AllowUsers`, ni l'entrée d'audit ne s'appliquent. C'est
   le même contournement que la Phase 3 a retiré du client Linux.
2. **`runSshExec()` — `dev.executeCommand(command)`**. Le mode exec
   (`ssh user@host cmd`) appelle la méthode de l'équipement distant en
   mémoire. Trois appelants : `LinuxBashShell`, `WindowsCmdShell`,
   `WindowsPowerShellShell` (deux sites chacun).

**Ce que cela dit du périmètre.** Il ne s'agit pas de réécrire une pile :
il s'agit de faire pour ces deux fonctions ce que la Phase 3 a fait pour
`LinuxSshClient` — remplacer la vérification locale par la négociation
que `openWireSshShell` sait déjà mener, et l'appel direct par un canal
exec. Le chemin filaire existe et tourne juste à côté, dans le même
fichier.

### 6.1 La mesure du point 1 — et sa CORRECTION

Une première mesure, consignée ici, concluait « six refus, aucun
blocage ». **Reprise depuis, elle est fausse**, et il vaut mieux le dire
que coder contre un constat périmé. Ce que la machine répond aujourd'hui,
sur le chemin exact du terminal (`tryInterpretSshLaunch` puis
`finalisePendingAuth`), contre un compte réel d'un serveur réellement
câblé :

| ce qu'on essaie | ce qui se passe |
| --- | --- |
| six mauvais mots de passe | cinq refus, puis le sixième est refusé **au connect** (`Connection refused`) — le limiteur du serveur s'applique |
| `AllowUsers bob`, puis `ssh alice` avec le BON mot de passe | refusé |
| `DenyUsers alice`, bon mot de passe | refusé |
| `PermitRootLogin no`, `ssh root` avec le bon mot de passe | refusé |
| compte verrouillé (`usermod -L`), bon mot de passe | refusé |
| mot de passe vide, `PermitEmptyPasswords no` par défaut | refusé |

La raison de ce démenti est instructive et n'était pas visible par
lecture. Le mot de passe JUSTE, lui, ouvre bel et bien une session
filaire (`openWireSshShell`) : c'est elle qui applique
`AllowUsers`/`DenyUsers`/`PermitRootLogin`, et son refus revient sous le
même `bad-password`. Quant au limiteur fail2ban, il compte parce que la
trace côté client (`tryRecordSshLogin`) appelle `recordSshLogin` sur
l'objet cible, laquelle ÉMET `auth_failure` sur le bus du serveur. Le
blocage est donc réel, mais obtenu par un raccourci en mémoire plutôt
que par le fil.

**Ce qui restait vraiment faux, et qui est corrigé.** La seule limite au
nombre d'essais était la constante `3`, recopiée dans `LinuxBashShell`,
`WindowsCmdShell`, `WindowsPowerShellShell`, `WindowsTerminalSession` et
`SshSession`. Or `3` est le `NumberOfPasswordPrompts` du CLIENT — une
règle qui n'a rien à voir avec le `MaxAuthTries` du SERVEUR, jamais
consulté ici. Mesuré avec `MaxAuthTries 1` : deux mauvais mots de passe
passaient sans conséquence, et le troisième essai — correct —
**ouvrait la session**, sur une machine dont la configuration
interdisait d'aller au-delà du premier échec.

`finalisePendingAuth` lit désormais la règle du serveur
(`readMaxAuthTries`, jumeau de `readForceCommand`, blocs `Match`
compris) au lieu d'en appliquer une à lui, et rend la coupure avec les
mots d'OpenSSH (`Received disconnect … Too many authentication failures`
/ `Disconnected from …`). La vérification a lieu avant la présentation du
mot de passe autant qu'après l'échec : une connexion tombée reste tombée,
et un bon mot de passe présenté ensuite ne rattrape rien. Une cible sans
`/etc/ssh/sshd_config` — routeur, machine Windows — ne se voit imposer
aucune limite du serveur, parce qu'en inventer une serait pire que de
n'en pas avoir. Les cinq copies de `3` sont devenues un seul
`SSH_PASSWORD_PROMPTS`, déclaré dans la couche du PROTOCOLE (`SshSession`)
et non dans celle du shell, pour que la session filaire n'ait pas à
dépendre d'un terminal.

`ssh-maxauthtries-interactive.test.ts` (10 cas, 8 en échec authentique
avant le correctif) garde la référence du bon mot de passe dans le même
laboratoire — sans elle, un labo mal monté et un refus correct seraient
indiscernables — et compare explicitement les deux chemins : le filaire
refusait déjà, l'interactif refuse maintenant.

**Ce qui reste, après ce correctif.** Un mauvais mot de passe ne touche
toujours pas le fil : il est vérifié localement, et c'est ce qui oblige à
LIRE la configuration du serveur plutôt qu'à la laisser s'appliquer. Le
point 2 (`runSshExec`) est intact.

### 6.2 Un TROISIÈME chemin client, trouvé en cherchant le pendant e2e

Écrire le test de bout en bout de §6.1 a buté sur un fait que ni le plan
ni ce document ne mentionnaient : un `ssh [user@]host` NU tapé à
l'intérieur d'une session distante n'atteint ni `sshLauncher` ni le
`LinuxBashShell` de la machine distante. `SshInteractiveSubShell`
l'intercepte (`startNestedHop`, la regex `/^ssh\s+(?:(\S+)@)?(\S+)$/`)
et ouvre lui-même une `SshSession`. Il y a donc TROIS clients ssh
interactifs et non deux : `LinuxTerminalSession.connectAndEnterSsh` pour
le premier saut, `startNestedHop` pour les suivants, et `sshLauncher`
pour les formes que la regex ne prend pas (options, mode exec).

Ce chemin-là est filaire, donc le serveur y applique déjà son
`MaxAuthTries` — c'est une bonne nouvelle, et c'est pourquoi le correctif
de §6.1 ne s'y voit pas. **Deux choses y avaient été mesurées sans être
expliquées.** La première est corrigée, la seconde reste ouverte, et les
deux sont écrites ici plutôt que tues.

**Corrigé : la seconde invite n'expliquait rien.** Après un mauvais mot
de passe, le terminal redemandait sans jamais écrire le
`Permission denied, please try again.` d'OpenSSH — deux invites
identiques, et aucune raison pour la seconde. Deux causes, silencieuses
l'une comme l'autre par construction. `HopInteractionHandler`
n'implémentait pas `showAuthFailure`, que `SshSession` appelle par une
méthode OPTIONNELLE (`?.()`) : l'appel ne levait donc rien, il ne faisait
rien. Et `pumpHopConnect` rendait `output: []` sur sa branche « invite »,
jetant ce que le gestionnaire avait accumulé avant l'invite suivante —
si bien que même une fois `showAuthFailure` écrit, la ligne aurait été
perdue. Les deux vont ensemble. C'est un défaut de RENDU, donc il se
prouve là où l'opérateur lit : `ssh-nested-auth-failure.spec.ts`,
discriminé par `git stash` (le cas du refus tombe avant le correctif, la
référence passe des deux côtés puisqu'elle vérifie une absence).

**Corrigé à son tour : la coupure du serveur est honorée.** Avec
`MaxAuthTries 1`, le client redemandait le mot de passe alors que le
serveur avait fermé la connexion au premier échec — une invitation à
taper dans une prise que plus personne n'écoute. Mesuré au niveau de la
session filaire plutôt que du terminal, ce qui rend le compte exact :
`MaxAuthTries 1` donnait TROIS invites, `MaxAuthTries 2` en donnait trois
aussi, et deux `Permission denied, please try again.` annonçaient des
invites qui n'auraient pas dû exister.

Deux moitiés, et il fallait les deux. Le serveur fermait au bon moment
mais ne le DISAIT pas : `requestServerAuth` ramenait un simple booléen,
où un refus ordinaire et une porte close sont le même `ok: false`. Et
`PasswordAuthMethod` lisait `ctx.getAttemptsRemaining()` une seule fois,
avant sa boucle — un contexte même bien informé n'aurait plus été
consulté. Distinguer sans redemander ne sert à rien, redemander sans
distinguer non plus.

La réponse du serveur porte donc un `ended`, posé au moment où il décide
(après l'incrément, pas avant), le contexte met ses tentatives à zéro
quand il le voit, et la boucle le relit à chaque tour. Aucune dépendance
à l'ordre d'arrivée d'un événement de fermeture : le serveur énonce sa
décision, le client l'applique. `ssh-client-stops-when-server-hangs-up.test.ts`
(5 cas, 3 en échec authentique avant correctif) compte les invites plutôt
que de lire une transcription, et garde la référence du bon mot de passe.

C'est le chemin filaire que TOUS les clients interactifs partagent — le
premier saut du terminal, `startNestedHop` et la jambe filaire de
`sshLauncher` — donc le correctif vaut pour les trois d'un coup.

**Non traité ici, et volontairement :** `WindowsPC.createVtyShell()` est
le dernier usage de `CrossVendorRemoteShell` en production, et il est
légitime — il est CÔTÉ SERVEUR, où empiler cmd/PowerShell localement est
précisément ce qu'un serveur doit faire. Le replier serait une erreur, pas
un progrès.

## 7. Phase 4 (SCP/SFTP) : ce que la mesure dit, et la décision qui reste

Le canal SFTP filaire EXISTE et il est complet — `SshSftpChannel` parle un
vrai protocole (`OPENDIR`/`READDIR`/`LSTAT`/`REALPATH`/`OPEN`/`READ`/
`WRITE`…) et `WireSftpFileSystem` l'expose derrière `ISftpFileSystem`.
`tryOpenWireSftpFs` l'ouvre. Rien de tout cela n'est à écrire.

**Ce que la mesure montre malgré tout.** Un `scp` d'un fichier de 9 octets
et un `scp` d'un fichier de 200 001 octets coûtent EXACTEMENT le même
trafic : 25 trames, ~7 111 octets de charge utile dans les deux cas. Le
fichier arrive pourtant à destination, intact. Le contenu ne traverse
donc pas le câble — seule l'authentification le fait.

Compter les trames sans faire varier la charge n'aurait rien montré : 25
n'est pas zéro, et l'on aurait conclu « ça passe par le réseau ». C'est
la comparaison 9 octets / 200 001 octets qui tranche, exactement comme
pour le mode exec du §6.

**La cause, isolée.** `tryOpenWireSftpFs` rend `WireSftpFileSystem` quand
un mot de passe est fourni, et `null` quand il n'y en a pas — le serveur
refuse un mot de passe vide, ce qui est correct. Or l'appelant retombe
alors EN SILENCE sur `resolveRemoteSftpFsFromDevice`, qui saisit le VFS de
la machine distante en mémoire. Un `scp` tapé sans justificatif ne
contourne donc pas seulement le réseau : il contourne aussi
l'authentification, et signale une réussite.

**La décision qui reste, et elle n'est pas technique.** Le correctif
évident — ne plus retomber en silence dès lors qu'un `tcpConnector`
existe, et remonter le refus — est juste du point de vue de la fidélité :
un vrai `scp` vers un compte protégé par mot de passe échoue avec
`Permission denied`. Mais il change un comportement visible dans 27
fichiers de tests qui font `executeCommand('scp …')` sans justificatif et
en attendent la réussite, et il rendrait tous les TP « copier un fichier
d'une machine à l'autre » dépendants d'un mot de passe. C'est un choix
pédagogique autant que technique, et il appartient à l'auteur du projet,
pas à ce document.

### 7.1 Le retrait du repli : tenté, mesuré, pas encore livrable

La décision étant prise (refuser plutôt que copier en mémoire), le
correctif produit tient en quelques lignes et fonctionne. Ce qui bloque
n'est pas lui, c'est la migration des laboratoires, et la mesure vaut
d'être écrite pour que la prochaine tentative ne reparte pas de zéro.

**Ce qui a été appris en le faisant.** Le premier essai a fait tomber les
`scp` authentifiés par CLÉ, ce qui n'était pas un problème de
laboratoire : `tryOpenWireSftpFs` n'offrait aucune identité. C'est ce
constat qui a produit le correctif déjà livré (les identités par défaut
sont désormais offertes). Une fois celui-ci en place, il reste **23 cas
dans 7 fichiers** qui copient sans le moindre justificatif.

**Ce qui NE marche pas pour les migrer :** ensemencer une paire de clés
dans les constructeurs de laboratoire. Mesuré deux fois, y compris avec
un nom de clé (`id_ecdsa`) que personne d'autre ne gère : la seule
PRÉSENCE d'un `authorized_keys` chez tout le monde casse §10, §12 et §16,
c'est-à-dire les cas qui vérifient justement qu'une clé ne marche PAS
avant `ssh-copy-id`, qu'un `IdentityFile` précis est choisi, et qu'un
agent authentifie. On répare §15 en cassant ce qui teste la gestion des
clés. Un ensemencement global est donc le mauvais outil, quel que soit le
nom du fichier.

**Ce qu'il faut à la place :** décider cas par cas quel justificatif
chaque test doit porter — mot de passe via `sshpass`, clé posée
localement pour ce cas-là, ou refus attendu. C'est un travail d'auteur,
pas une passe mécanique, et il touche la pédagogie de chaque TP.

Ce qui est acquis en attendant : le chemin filaire fonctionne réellement
dès qu'un justificatif est fourni, et le repli est désormais NOMMÉ plutôt
que découvert. Le chemin SYNCHRONE de `scp`/`sftp` (`dispatch()`, sans
`runSshTransportAsync`) n'essaie même pas le canal filaire — c'est la
seconde moitié du même chantier.
