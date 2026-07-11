# Framework de migration `command-kernel`

Ce document est la référence unique pour tout agent (humain ou IA) qui
migre une commande, un sous-système ou un nouvel équipement vers
l'architecture `command-kernel`. Il remplace toute connaissance implicite
acquise pendant les phases précédentes : **lis-le en entier avant de
toucher au moindre fichier**, y compris si tu es tenté de « juste ajouter
une commande de plus ».

Le respect de ce framework est **non négociable**. En cas de doute entre
« aller vite » et « respecter le framework », c'est toujours le framework
qui gagne.

---

## 0. Principes directeurs (non négociables)

1. **Une seule porte vers l'état de la machine.** Une commande ne touche
   *jamais* directement `VirtualFileSystem`, `LinuxUserManager`,
   `LinuxProcessManager`, etc. Elle ne connaît que `ctx.machine`
   (`MachineApi`). C'est ce qui rend une commande testable, mockable, et
   réutilisable sur un autre équipement.
2. **La politique de privilège vit sur la commande, pas sur le moteur.**
   `CommandDescriptor.privileges` (une `PrivilegePolicy`) est LA source de
   vérité. Le moteur (`Executor`/`PermissionGuard`) ne fait qu'appliquer
   ce que la commande déclare — il n'a aucune connaissance métier.
3. **Le moteur (`Executor`, `Interpreter`, `Lexer`, `Parser`) n'importe
   jamais une commande concrète.** Il ne connaît que `ICommand`/
   `CommandRegistry`. Ajouter une commande ne doit jamais nécessiter de
   modifier `src/command-kernel/exec/executor.ts` ou `interpreter.ts`.
4. **Isolation de session explicite.** Un sous-shell clone son
   environnement (`variables`/`env`), ne le partage jamais par référence
   avec le parent (voir `Executor.run`, cas `subshell`).
5. **Un seul `case` par nature de nœud AST dans l'`Executor`.** Si tu as
   besoin d'un nouveau comportement, ajoute un nœud AST propre plutôt que
   de brancher un `if` spécial dans un `case` existant.
6. **Discipline git stricte** (détaillée en §7) : un push = une
   fonctionnalité complète et testée. Jamais de commentaires dans le code
   livré — les noms portent le sens. Jamais de duplication. Le
   `CHANGELOG.md` est tenu à jour à chaque push.
7. **Jamais de repli silencieux sur l'ancien chemin après un début
   d'exécution.** Voir §4 — c'est la règle la plus facile à violer par
   accident et celle qui a causé la régression la plus sérieuse de ce
   projet (§6).

---

## 1. Architecture en couches

```
Terminal / VirtualTerminal
        │
      Shell (REPL, historique, prompt)
        │
     Interpreter.interpretLine(line, session, io)
        │
   Lexer → tokens → Parser → AST (ScriptNode)
        │
     Executor.run(ast, session, io)
        │            │
        │      PermissionGuard.check(command, user, args)
        │            │
        ├─ résout la commande via CommandRegistry
        ├─ expand (Expander) + glob (glob-expand) chaque Word
        ├─ ArgumentParser.parse(argv, descriptor) → ParsedArgs
        └─ command.execute(ctx: CommandContext)
                 │
              ctx.machine : MachineApi (fs / proc / net / users / groups / power / audit?)
```

### Emplacement des fichiers du socle (`src/command-kernel/`)

| Répertoire | Contenu |
|---|---|
| `session/` | `User`, `Session`, `PrivilegePolicy`, `createSession` |
| `args/` | `ArgumentSpec`, `OptionSpec`, `ArgumentParser`, `ParsedArgs` |
| `io/` | `CommandIO`, `PipeBuffer`, `FileOutputStream` |
| `machine/types.ts` | **Le contrat `MachineApi` — vendor-agnostic, jamais de détail Linux/Windows/Cisco ici** |
| `command/` | `ICommand`, `BaseCommand`, `CommandDescriptor`, `CommandContext` |
| `registry/` | `CommandRegistry` |
| `ast/` | `Lexer`, `Parser`, `nodes.ts` (AST), `Expander`, `tokens.ts` |
| `exec/` | `Executor` (interprète l'AST), `PermissionGuard`, `glob-expand.ts` |
| `interpreter.ts` | Façade `texte → AST → exécution` |
| `shell/`, `terminal/` | REPL, historique, prompt, terminal virtuel |
| `commands/` | Commandes **universelles**, indépendantes de tout vendeur (`echo`, `exit`) |
| `testing/in-memory-machine.ts` | `MachineApi` factice pour les tests **du socle lui-même** (pas pour les tests projet) |

### Le pont par équipement (exemple Linux, `src/network/devices/linux/command-kernel/`)

| Fichier | Rôle |
|---|---|
| `LinuxMachineApi.ts` | Implémentation **réelle** de `MachineApi` — enveloppe `VirtualFileSystem`, `LinuxUserManager`, `LinuxProcessManager` **existants**, jamais de duplication d'état |
| `LinuxUser.ts` | Adapte un `LinuxUserAccount` réel au contrat `User` |
| `commands/*.ts` | Une classe `BaseCommand` par commande migrée |
| `createLinuxHostShell.ts` | Bootstrap : construit le `CommandRegistry`, enregistre les commandes, retourne l'`Interpreter` |

Le point d'entrée réel du projet (`LinuxMachine.executeCommand()`) ne
connaît PAS `command-kernel` directement — il passe par
`LinuxMachine.tryCommandKernel()` (voir §4).

---

## 2. Procédure pour migrer UNE commande

1. **Lire l'implémentation legacy en entier** (le `case 'xxx':` dans
   `LinuxCommandExecutor.dispatch()` ou la fonction `cmdXxx` associée) —
   pas seulement la logique métier, mais **tout ce qui l'entoure** :
   audit (`publishFsAccess`/`publishSyscall`), vérifications de
   privilège, cas d'erreur, formats de message exacts.
2. **Repérer les tests déjà existants** qui exercent cette commande —
   `grep -rl "'xxx " src/__tests__/unit/network-v2/` ne suffit pas,
   il faut aussi vérifier les suites `auditctl*.test.ts`,
   `journalization*.test.ts`, `command-privilege-policy.test.ts` (voir
   §6 — c'est le piège n°1).
3. **Écrire la commande** dans
   `src/network/devices/linux/command-kernel/commands/Xxx.ts` :
   - `descriptor` complet (`args`, `options`, `privileges`, `usage`).
   - `execute(ctx)` utilise exclusivement `ctx.machine.*`, jamais
     d'import direct vers `VirtualFileSystem`/`LinuxUserManager`.
   - Reproduire **fidèlement** les effets de bord legacy (audit, codes de
     sortie, formats de message) — voir §6, ce n'est pas optionnel.
4. **Enregistrer** la commande dans `createLinuxHostShell.ts`
   (`registry.register(() => new XxxCommand())`).
5. **Ne PAS écrire de nouveau test unitaire.** Le critère de succès est :
   *les tests déjà présents dans le projet passent*, en mode localisé
   (§5). Si un test manque pour un comportement legacy que tu migres,
   documente le trou dans `CHANGELOG.md` plutôt que d'en écrire un —
   sauf instruction contraire explicite de l'utilisateur.
6. **Étendre `MachineApi` seulement si nécessaire**, et seulement de
   façon **vendor-agnostic** (ex : `AuditApi` est une capacité
   *optionnelle* — d'autres équipements n'ont simplement pas besoin de
   l'implémenter). N'ajoute jamais un champ Linux-spécifique
   (`inode`, `syscall`, …) sans réfléchir à ce qu'un équipement Cisco/
   Windows ferait de ce champ.
7. **Typecheck ciblé** :
   `npx tsc --noEmit -p tsconfig.app.json --ignoreDeprecations 5.0 2>&1 | grep -iE "command-kernel|LinuxMachine"`
8. **Tests localisés** (§5), en incluant systématiquement le lot
   « effets de bord » (§6).
9. **Mets à jour `CHANGELOG.md`** — nouvelle entrée ou complément de
   l'entrée de phase en cours, avec : ce qui est migré, ce qui a été
   trouvé/corrigé, ce qui reste hors périmètre.
10. **Commit + push sur la branche de travail uniquement** (§7).

---

## 3. Développer un nouveau type d'équipement

Le principe : `command-kernel` (le socle) ne change JAMAIS pour un
nouvel équipement. Seul un nouveau pont apparaît :

1. Créer `src/network/devices/<vendeur>/command-kernel/`.
2. Implémenter `<Vendeur>MachineApi implements MachineApi` — une classe
   par sous-API (`FileSystemApi`, `ProcessApi`, `NetworkApi`,
   `UserManagementApi`, `GroupManagementApi`, `PowerApi`), enveloppant
   les objets **réels** déjà existants pour cet équipement. Ne jamais
   dupliquer l'état (pas de `Map` parallèle).
3. Implémenter `<Vendeur>User implements User`.
4. Écrire `create<Vendeur>HostShell(deps)` (bootstrap + registre).
5. Câbler un pont `tryCommandKernel()`-like dans la classe d'équipement
   existante, EXACTEMENT selon les garanties de sécurité du §4.
6. Ne migrer QUE les commandes qui ont un sens pour ce vendeur — pas de
   copier-coller mécanique de la liste Linux.

---

## 4. Le pont de migration — garanties de sécurité obligatoires

Le pont (`tryCommandKernel()` sur `LinuxMachine`, ou l'équivalent pour un
autre équipement) est la pièce la plus délicate du framework. Il doit
respecter EXACTEMENT ces garanties :

```ts
private async tryCommandKernel(trimmed: string): Promise<string | null> {
  // 1. Bail-out immédiat sur tout ce qui n'est structurellement jamais
  //    routé (substitution de commande, backticks) — PAS un repli après
  //    échec, un refus de tenter.
  if (trimmed.includes('$(') || trimmed.includes('`')) return null;

  // 2. Parse en PRÉ-VOL avec le Lexer/Parser du socle. Toute erreur de
  //    parsing => repli intégral, zéro exécution partielle.
  let ast;
  try { ast = new Parser().parse(new Lexer().tokenize(trimmed)); }
  catch { return null; }

  // 3. Ne route QUE si l'AST se réduit à une commande simple ou un
  //    pipeline — jamais ;, &&, ||, boucles, conditions, sous-shells
  //    (ceux-ci restent intégralement sur l'ancien chemin).
  if (ast.kind !== 'command' && ast.kind !== 'pipeline') return null;

  // 4. Ne route QUE si CHAQUE commande nommée est déjà enregistrée.
  const names = /* ... */;
  if (!names.every((name) => registry.has(name))) return null;

  // 5. Réplique le prélude par-commande du dispatch legacy (§6) —
  //    NE JAMAIS OUBLIER CETTE ÉTAPE.
  for (const name of names) this.executor.publishCommandExecve(name);

  // 6. Exécute. Une fois lancé, AUCUN repli sur l'ancien chemin, même en
  //    cas d'erreur venant DE L'INTÉRIEUR d'une commande migrée — sinon
  //    on ne sait plus ce qui est réellement migré.
  try {
    await interpreter.interpretLine(trimmed, session, io);
  } catch (err) {
    if (err instanceof CommandNotFoundError) return null; // jamais tenté, pas un échec
    if (err instanceof ShellError) return `${err.message}\n`; // une vraie erreur, pas un repli
    throw err;
  }
}
```

**Ce qui est un refus légitime de router** (bail-out AVANT toute
exécution) : commande non enregistrée, syntaxe non supportée par le
Lexer/Parser du socle, construction jamais implémentée (`$(...)`).

**Ce qui n'est PAS un refus légitime** : une commande migrée qui lève une
erreur pendant son exécution. Cette erreur doit remonter comme une vraie
erreur (`ShellError` → message affiché), jamais déclencher un repli
silencieux vers l'ancien chemin — sinon deux exécutions pourraient se
produire (double effet de bord) et plus personne ne sait ce qui est
réellement fiable dans la migration.

---

## 5. Discipline de test — tests LOCALISÉS uniquement

Le projet a plus de 16 000 scénarios de test. **Ne jamais lancer la
suite complète** — ça prend trop de temps et ce n'est pas nécessaire.

À la place :
1. Identifie les fichiers de test qui exercent la commande/le
   sous-système touché (`grep -rl "'nom_commande" src/__tests__/unit/network-v2/`).
2. Lance-les de façon ciblée :
   ```bash
   npx vitest run src/__tests__/unit/network-v2/fichier1.test.ts src/__tests__/unit/network-v2/fichier2.test.ts
   ```
3. Ajoute **systématiquement** le lot du §6 (audit/privilège) dès que tu
   touches une commande qui lit/écrit le filesystem, change un
   utilisateur, ou change un état sensible — même si tu es sûr que ça
   n'a « rien à voir ».
4. Le critère de succès n'est PAS « mes nouveaux tests passent » — il
   n'y a pas de nouveaux tests à écrire. Le critère est : **les tests
   déjà présents dans le projet passent**, en mode localisé.
5. En cas de doute sur l'impact réel d'un changement, compare contre la
   baseline pré-migration avec un `git worktree` (voir §6.3) plutôt que
   de supposer.

---

## 6. ⚠️ Piège critique : parité audit/privilège du prélude `dispatch()`

**Lis cette section avant de migrer QUOI QUE CE SOIT qui touche le
filesystem, un utilisateur, ou un privilège.** C'est la régression la
plus sérieuse rencontrée jusqu'ici — 25 tests cassés silencieusement,
découverts seulement en élargissant les tests localisés bien après coup.

### 6.1 Le problème

`LinuxCommandExecutor.dispatch()` (le point d'entrée legacy) exécute un
**prélude avant son `switch`**, pour TOUTE commande :

```ts
private dispatch(cmd: string, args: string[], stdin?: string): {...} {
  this.currentCommandHead = cmd;
  const privilegeDenial = /* vérification de privilège déclarative */;
  if (privilegeDenial) return privilegeDenial;

  this.publishFsAccess(`/usr/bin/${cmd}`, 'x');
  this.publishFsAccess(`/bin/${cmd}`, 'x');
  this.publishSyscall('execve', resolveExePath(cmd));

  switch (cmd) {
    case 'touch': {
      // ... publie ('w','open') PAR ARGUMENT avant d'agir ...
    }
    case 'chmod': { /* publie ('a','chmod') */ }
    case 'chown': { /* publie ('a','chown'), seulement pour les args absolus */ }
    case 'mv':    { /* publie ('w','rename') pour CHAQUE arg (source ET dest) */ }
    case 'rm':    { /* publie ('w','unlink') seulement si la cible existe */ }
    // ...
  }
}
```

Ces appels alimentent le moteur d'audit simulé (`auditd`/`ausearch`/
`aureport`). Le pont `tryCommandKernel` **contourne `dispatch()` en
entier** — donc, sans intervention explicite, **aucune commande migrée
ne produit la moindre trace d'audit**, silencieusement.

Pire : ce n'est pas qu'un problème de logs. `commandPrivileges.check(...)`
(la vérification de privilège par nom de commande) est AUSSI dans ce
prélude — une commande migrée pourrait échapper à une restriction de
privilège legacy si sa `PrivilegePolicy` côté command-kernel n'est pas
strictement équivalente.

### 6.2 Comment on l'a découvert (et comment tu dois le détecter toi-même)

En élargissant les tests localisés pour une phase qui semblait n'avoir
« rien à voir » (migration de commandes texte : `grep`, `sort`, `cut`...),
on a lancé — par prudence, pas par certitude qu'il y avait un problème —
`auditctl.test.ts`, `auditctl-other.test.ts`, `journalization.test.ts`,
`journalization-and-audit.test.ts` (480 tests). Résultat : 25 échecs.

Comparaison contre un `git worktree` pointant sur le commit **juste
avant** l'existence de `command-kernel` : les 480 tests passaient. Donc
c'était bien une régression introduite par la migration, silencieuse
depuis la Phase 1.

**Leçon : pour TOUTE commande qui touche le filesystem, un utilisateur/
groupe, un privilège, ou un processus, ajoute systématiquement à ton lot
de tests localisés** :
```
src/__tests__/unit/network-v2/auditctl.test.ts
src/__tests__/unit/network-v2/auditctl-other.test.ts
src/__tests__/unit/network-v2/journalization.test.ts
src/__tests__/unit/network-v2/journalization-and-audit.test.ts
src/__tests__/unit/network-v2/command-privilege-policy.test.ts
```
Ce n'est pas une liste figée — le principe général est : **si legacy fait
quelque chose « en plus » de l'opération elle-même (log, audit, effet de
bord sur un compteur global, notification), le pont doit le reproduire,
et les tests qui vérifient cet effet de bord doivent être dans ton lot
localisé.**

### 6.3 Comment vérifier qu'une suite de tests est une VRAIE régression

Ne jamais supposer. Utilise un `git worktree` pour comparer contre l'état
juste avant que `command-kernel` existe :
```bash
git log --oneline --reverse <branche> -- src/command-kernel | head -1
git worktree add /tmp/baseline-check <sha-juste-avant>^
cd /tmp/baseline-check && npx vitest run <mêmes fichiers de test>
# compare : si ça passait avant et échoue maintenant => régression confirmée
git worktree remove /tmp/baseline-check --force
```

### 6.4 Le fix (déjà en place, à répliquer pour toute nouvelle commande)

- `MachineApi` porte une capacité **optionnelle** `audit?: AuditApi`
  (`fsAccess(path, perm, syscall?)`, `syscall(name, path?)`) —
  `src/command-kernel/machine/types.ts`. Optionnelle car un équipement
  Cisco/Windows n'a pas forcément d'équivalent auditd.
- `LinuxMachineApiDeps` reçoit `publishFsAccess`/`publishSyscall`, câblés
  dans `LinuxMachine.getCommandKernelShell()` sur les wrappers publics
  déjà existants : `LinuxCommandExecutor.publishAuditFsAccess`/
  `publishAuditSyscall`. **Ne jamais dupliquer la logique d'audit** — ces
  wrappers existaient déjà avant `command-kernel`, réutilise-les.
- `LinuxCommandExecutor.publishCommandExecve(cmd)` réplique exactement le
  prélude de `dispatch()` (bookkeeping + accès `/usr/bin/<cmd>` +
  `/bin/<cmd>` + `execve`). Le pont l'appelle pour **chaque étage d'un
  pipeline** avant l'exécution — pas seulement la première commande.
- Chaque commande migrée qui touche le filesystem appelle
  `ctx.machine.audit?.fsAccess(...)` / `ctx.machine.audit?.syscall(...)`
  **après** l'opération réussie (jamais avant) — sinon une opération qui
  échoue produirait quand même une entrée d'audit, ce qui est une
  incohérence différente mais tout aussi réelle (constaté sur `touch`
  vers un montage read-only : le test attendait explicitement qu'aucune
  entrée n'apparaisse).
- Pour une opération qui a un effet différent selon qu'elle passe par le
  chemin générique (`writeFile`, utilisé aussi par les redirections
  `>`/`>>`) ou un chemin dédié (`vfs.touch()` pour `touch`), vérifie
  lequel legacy utilisait réellement. Confondre les deux a d'abord semblé
  correct (l'audit apparaissait bien) puis a cassé un test d'exclusion de
  règle (`-a never,exit -F dir=...`) parce que `vfs.onWrite()` (un hook
  bas niveau attaché aux règles `-w`) réagit à `writeFile()` mais pas à
  `vfs.touch()`, et ce hook ne respecte pas les règles d'exclusion.
  **Vérifie toujours quelle méthode VFS legacy appelle réellement**
  (`ctx.vfs.touch(...)` vs `ctx.vfs.writeFile(...)`) plutôt que de
  supposer qu'un chemin générique suffit.

---

## 7. Discipline git

- Développe sur la branche de travail assignée (voir les instructions de
  session — jamais sur `mandeng` sauf instruction explicite contraire).
- **Un push = une fonctionnalité complète et testée.** Pas de push
  intermédiaire avec un correctif à moitié fini.
- Aucun commentaire dans le code livré — les noms d'identifiants portent
  le sens. Un commentaire n'est acceptable que pour une contrainte non
  évidente (ex : pourquoi `endChar` doit être `undefined` et pas `1` par
  défaut dans `parseSortKey`).
- `CHANGELOG.md` est mis à jour à CHAQUE push : ce qui est migré, les
  bugs trouvés puis corrigés en testant contre la suite existante (avec
  la cause racine, pas juste le symptôme), ce qui reste explicitement
  hors périmètre.
- Jamais de `git reset --hard`/`push --force` sans autorisation explicite
  et récente de l'utilisateur pour CETTE action précise.

---

## 8. État de la migration (résumé — voir `CHANGELOG.md` pour le détail)

### Migré vers `command-kernel`

- **Session/filesystem de base** : `pwd`, `cd`, `ls`, `cat`, `mkdir`,
  `touch`, `rm`, `cp`, `mv`, `stat`, `chmod`, `chown`.
- **Traitement de texte** : `grep`, `head`, `tail`, `wc`, `sort`, `cut`,
  `uniq`, `tr`.
- **Universel** (tout équipement) : `echo`, `exit`.
- **Parité audit/privilège** pour toutes les commandes ci-dessus (§6).

### Explicitement hors périmètre (reste sur `LinuxCommand`/legacy)

- Réseau (`ip`, `ping`, `iptables`, `ifconfig`, `nmap`…) — **attention**,
  une partie de ce périmètre a déjà sa propre migration séparée vers
  `src/network/devices/linux/commands/` (un framework `LinuxCommand`
  distinct de `command-kernel`, avec son propre mécanisme de parité
  audit/privilège dans `LinuxMachine.tryNetworkCommand()`). **Vérifie
  toujours si une commande n'est pas déjà migrée là avant de la migrer
  vers command-kernel** — `chown`/`chgrp` existent par exemple dans les
  DEUX endroits ; le switch legacy reste actuellement la voie réellement
  empruntée pour `chown`, mais ne suppose jamais, vérifie.
- IAM avancé (`useradd`, `usermod`, `passwd`, `chage`, `gpasswd`,
  `groupadd`…) — également partiellement présent sous
  `src/network/devices/linux/commands/iam/`.
- Matériel (`lspci`, `lsblk`, `dmidecode`…), audit (`auditctl`,
  `ausearch`), systemd — déjà largement couverts par
  `src/network/devices/linux/commands/{hw,audit,system}/`.
- `chown` : résout groupe par nom (fixé) et par gid numérique.
- `umask` : lu dynamiquement depuis `LinuxCommandExecutor`, mais aucune
  commande `umask` n'est migrée pour le modifier depuis command-kernel.

### Avant de choisir la prochaine commande à migrer

1. Vérifie si elle existe déjà sous `src/network/devices/linux/commands/`
   (le framework `LinuxCommand`, distinct de `command-kernel` — voir
   ci-dessus). Si oui, ne la migre pas une deuxième fois sans discussion
   explicite — décide plutôt s'il faut la **déplacer** ou la laisser là.
2. Vérifie ses effets de bord réels dans `LinuxCommandExecutor.dispatch()`
   (audit, privilège, formats d'erreur exacts) — §6.
3. Repère tous les fichiers de test qui l'exercent, y compris
   indirectement (audit, privilège, scénarios croisés SSH/sudo/cron).
4. Migre, teste en localisé (§5), documente (`CHANGELOG.md`), commit +
   push (§7).
