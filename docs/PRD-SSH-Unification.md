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

## 5. Hors périmètre

- Le retrait effectif des chemins clients en mémoire (étape 2) et le
  repli de `CrossVendorRemoteShell` — dont l'empilement de sous-shells
  (PowerShell / SQL*Plus / RMAN par-dessus SSH) devra migrer côté
  serveur. Cette étape ne fait que lever les blocages qui l'empêchent.
- `createInteractiveShell()` (streaming, Ctrl+C temps réel) pour les
  vendeurs non-Linux : le repli documenté sur `getShell().execute()`
  reste en place.
