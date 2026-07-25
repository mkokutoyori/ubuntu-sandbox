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

## 5. Hors périmètre

- Le retrait effectif des chemins clients en mémoire (étape 2) et le
  repli de `CrossVendorRemoteShell` — dont l'empilement de sous-shells
  (PowerShell / SQL*Plus / RMAN par-dessus SSH) devra migrer côté
  serveur. Cette étape ne fait que lever les blocages qui l'empêchent.
- `createInteractiveShell()` (streaming, Ctrl+C temps réel) pour les
  vendeurs non-Linux : le repli documenté sur `getShell().execute()`
  reste en place.
