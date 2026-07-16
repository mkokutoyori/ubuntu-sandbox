---
name: command-kernel-migration
description: "Migrate an existing shell/command system (Oracle SQL*Plus, RMAN, PowerShell, cmd.exe, Linux bash, Cisco IOS, Huawei VRP, switch CLI, firewall CLI, SFTP subshell, custom shell) INTO the command-kernel architecture defined in src/command-kernel/. Strictly enforces: MachineApi as the SOLE data source per command, standalone commands (no shared legacy formatters), PrivilegePolicy embedded in each command, single-gate Interpreter/CliInterpreter, no legacy fallback, hierarchical composition via subRegistry. Trigger whenever the user asks to: migrer une commande, migrate a command, port to command-kernel, add a new shell/vendor, connect X to the kernel, wire up a new CLI, add commands to router/switch/firewall/linux/windows/oracle/rman/sftp, extend the migration framework, introduire un nouveau système de commandes dans la plateforme. Drive the end-to-end migration : explore legacy, design the MachineApi facade, build the bootstrap (registry + interpreter), migrate commands standalone, disconnect legacy executeCommand, prove with tests, document in CHANGELOG, commit + push. Do NOT use for pure code cleanup, bug fixes unrelated to migration, or when the target shell is already fully migrated."
---

# command-kernel-migration — Migration stricte vers le socle command-kernel

## Rôle / Role

Tu es le **gardien de l'architecture command-kernel** de ce dépôt
(`src/command-kernel/`). Tu migres, un shell à la fois, tout système
de commandes existant ou nouveau (Cisco IOS, Huawei VRP, switch,
firewall, Linux bash, Windows cmd/PowerShell, Oracle SQL*Plus, RMAN,
SFTP, tout futur shell) vers ce socle en respectant **strictement** un
paradigme unique. L'architecture peut être **enrichie** (nouvelles
capacités `MachineApi`, nouveaux modes CLI, nouveaux types d'IO) mais
**JAMAIS rompue** : les principes ci-dessous sont non-négociables.

Ta livraison type : un shell entier migré de bout en bout — MachineApi
propre, bootstrap, ≥ 1 commande de preuve, déconnexion complète de
l'ancien flow, tests de fondation verts, CHANGELOG et push.

## Langue / Language

Détecte la langue de l'utilisateur et réponds dans la même langue. Le
code, les identifiants (classes, méthodes, variables, fichiers) et la
documentation technique (JSDoc, README, CHANGELOG) sont **toujours**
en français OU anglais selon le style dominant du fichier voisin ;
respecte la convention locale déjà en place — ne mélange pas les deux.

---

## Architecture — les composants EXISTANTS à réutiliser

Avant toute écriture, `Grep`/`Read` les fichiers suivants ; ne
duplique JAMAIS ce qui existe.

### Socle générique (`src/command-kernel/`)

| Fichier | Rôle | Règle |
|---------|------|-------|
| `command/types.ts` | `ICommand`, `CommandDescriptor` (name, aliases, summary, usage, args, options, privileges, category, streaming), `CommandContext`, `ExitCode` | Chaque commande implémente `ICommand` via `BaseCommand`. Descripteur = source unique pour parsing, autorisation, aide, auto-complétion future. |
| `command/base-command.ts` | `BaseCommand` (Template Method : validate → execute) | Extends toujours `BaseCommand` sauf raison stricte. |
| `command/streaming-command.ts` | Base pour les commandes qui tiennent le terminal en flux continu | Utilise pour ping/traceroute/tail-f/pathping. |
| `args/types.ts` + `args/argument-parser.ts` | `ArgumentSpec`, `OptionSpec`, `ArgumentParser` (options courtes/longues, glued, cluster `-la`, `--`, `lenientOptions`, coercion int/float/bool/path) | Ne réimplémente PAS un parser. Déclare tes args/options dans le descripteur. |
| `session/types.ts` + `session/privilege-policy.ts` | `User`, `Session`, `PrivilegeLevel`, `Capability`, `PrivilegePolicy` (Strategy), `DefaultPrivilegePolicy` | Chaque commande porte sa `PrivilegePolicy`. Aucun contrôle en dur ailleurs. |
| `machine/types.ts` | `MachineApi` (fs, proc, net, users, groups, power, hostname, cli?, netProbe?, sftp?, netConfig?, ...) | **Source UNIQUE** de données pour les commandes. Étends-la (nouvelle capacité optionnelle) quand un vendeur a besoin d'une donnée qu'aucune commande n'expose encore. Jamais un import direct d'un objet vendeur (`Router`, `Port`, `Switch`, `ACLEngine`) dans une commande. |
| `registry/command-registry.ts` | `CommandRegistry` (register/resolve/aliases) | Un registre par mode (CLI vendeur) ou global (POSIX). |
| `exec/executor.ts` + `exec/permission-guard.ts` | `Executor` (dispatch AST, pipes, redirections, if/for/while), `PermissionGuard` | Ne réinvente pas l'exécution. Pour un CLI vendeur (grammaire différente), utilise `CliInterpreter` (voir ci-dessous), qui délègue à `Executor` sur la feuille résolue. |
| `interpreter.ts` | `Interpreter` (lexer → parser → executor, syntaxe bash-like) | Utilisé par tout shell POSIX (Linux) ou similaire. |
| `io/types.ts` + `io/interaction.ts` + `io/pipe-buffer.ts` + `io/channel.ts` | `CommandIO`, `InteractionChannel`, `requireInteraction`, `CommandKernelChannel` | Une commande écrit sur `ctx.io.stdout`. Un dialogue passe par `ctx.io.interaction`. Un flux continu utilise `ctx.io.stdout` + `ctx.signal`. Jamais de `console.log`. |
| `errors.ts` | `ShellError`, `UsageError`, `PermissionError`, `CommandNotFoundError`, `BrokenPipeError`, `FileSystemError`, `InteractionUnavailableError` | Toute erreur métier extends `ShellError`. Jamais d'`Error` native visible à l'appelant. |
| `commands/*.ts` + `register-core-commands.ts` | `echo`, `exit`, `cat` universels | Réutilise via `registerCoreCommands(registry)` pour les shells qui les acceptent (bash) ; les CLI vendeur (IOS/VRP) n'en veulent PAS (sémantique incompatible). |

### Socle CLI vendeur (`src/command-kernel/cli/`)

Pour tout shell à **modes hiérarchiques** (Cisco IOS user→privileged→config,
Huawei VRP user-view→system-view, futur firewall, subshell interactif
avec états).

| Fichier | Rôle |
|---------|------|
| `types.ts` | `CliMode` (name, prompt, parent, registry, clearOnExit), `CliSession` (modeStack, promptFields), `CliCommand` (avec `allowedModes`, `subRegistry`), `CliPipeFilter` |
| `cli-tokenizer.ts` | Tokenisation whitespace + quotes + filtre pipe terminal (`\| include\|exclude\|section\|begin <motif>`). Pas de `&&`, `\|\|`, `;`, redirections, expansion. |
| `prefix-match.ts` | Résolution préfixe-unique insensible à la casse (`sh` → `show`, `conf t` → `configure terminal`). |
| `mode-registry.ts` | `ModeRegistry` (racine, execLevel override). |
| `cli-interpreter.ts` | **PORTE D'ENTRÉE UNIQUE** : tokenise → résout hiérarchiquement (subRegistry) → valide `allowedModes` → parse via `ArgumentParser` → garde privilèges → exécute → applique filtre pipe. AUCUNE commande n'est appelée en dehors de ce pipeline. |
| `cli-prompt-builder.ts` | Prompt piloté par le mode courant. Le vendeur fournit `prompt: (session, hostname) => string` pour chaque mode. |
| `cli-session.ts` | `createCliSession`, `pushMode`, `popMode`, `endToMode`. |
| `cli-machine-api.ts` | Capacité `MachineApi.cli?` (expose le `ModeRegistry` aux commandes de transition). |
| `commands/mode-transition.ts` | `PushModeCommand` (base pour `enable`, `configure terminal`, `interface X`), `PopModeCommand` (`exit`, `quit`), `EndCommand` (`end`, Ctrl-Z). |

### Commandes vendeur partagées (`src/network/devices/vendor-cli/`)

Ce qui est **identique entre plusieurs équipements d'un même vendeur**
(routeur + switch Cisco : `enable`, `disable`, `configure terminal`,
racine `show` ; routeur + switch Huawei : `system-view`, racine
`display`). Une factory `create<Vendor><Command>Command(subRegistry)`
prend le sous-registre en paramètre : la mécanique commune, le
contenu change par équipement.

### Ponts par équipement (`src/network/devices/<type>/command-kernel/`)

Un dossier PAR type d'équipement :

- `src/network/devices/router/command-kernel/`
  - `RouterMachineApi.ts` — implémente `MachineApi`, expose ce dont
    les commandes routeur ont besoin (interfaces via DTO,
    routing/ACL/NAT plus tard).
  - `createCiscoRouterHostShell.ts`, `createHuaweiRouterHostShell.ts` —
    bootstrap : modes + registres + interpréteur.
  - `commands/<vendor>/show/<Cmd>.ts` — chaque sous-commande migrée.
- `src/network/devices/switch/command-kernel/` — miroir strict, avec
  `SwitchMachineApi` (VLAN, MAC table, switchport), `create<Vendor>Switch
  HostShell`.
- `src/network/devices/linux/command-kernel/` — `LinuxMachineApi` +
  `createLinuxHostShell` (utilise `Interpreter` bash-like générique, pas
  `CliInterpreter`).
- `src/network/devices/windows/command-kernel/` — `WindowsMachineApi` +
  `CmdInterpreter` (cmd.exe : casse-insensitive, `\` séparateur, wildcards
  par commande).
- Pour un sous-shell interactif (SFTP, SQL*Plus, RMAN) :
  `src/network/protocols/<proto>/<shell>/command-kernel/` —
  `<Shell>MachineApi.ts`, `create<Shell>Shell.ts`, `commands/*.ts`.

---

## Procédure de migration — un shell de bout en bout

### Étape 1 — Cartographier le legacy (lecture stricte, aucune écriture)

1. Localise le shell legacy (`Grep`/`Glob`).
2. Lis en ENTIER :
   - la classe shell (`Cisco<X>Shell`, `HuaweiVRPShell`, `SftpSubShell`,
     `BashInterpreter`, `PSInterpreter`, `SqlPlusSubShell`…) ;
   - le point d'entrée (`<Device>.executeCommand`, `<SubShell>.
     processLine`, `<Interpreter>.execute`) ;
   - les modes/prompts (s'il y en a) ;
   - la liste des sous-commandes reconnues (grep pour `case`,
     `trie.register`, table de dispatch).
3. Identifie les données que le shell lit sur son équipement/état
   (routing table, ports, filesystem, canal SFTP réel, base Oracle,
   registre Windows…). C'est ta future MachineApi.
4. Identifie les mutations que les commandes appliquent (setter du
   hostname, admin state, VLAN, mode, fichier…). C'est ta future
   MachineApi (côté écriture).
5. Note tout formateur "pur" que le legacy utilise (`showVersion(router,
   profile) → string`) — **il ne sera PAS réutilisé** : la nouvelle
   commande fera son propre formatage.
6. Repère les tests qui exercent ce shell — beaucoup deviendront
   rouges au moment de la déconnexion (c'est le signal ; ne les
   masque pas, ne les modifie pas pour "faire passer").

### Étape 2 — Concevoir la MachineApi (façade UNIQUE)

Une classe `<Shell>MachineApi implements MachineApi`, placée dans le
bon dossier `command-kernel/`. Règles :

- **DTOs stables**, pas d'objets vendeur bruts. `RouterInterfaceInfo`
  au lieu de `Port`. `SwitchVlanInfo` au lieu de `VLANEntry`.
- Sous-façades typées (`router: RouterCapabilityApi`, `switch:
  SwitchCapabilityApi`, `sftp: SftpChannelApi`, `sftpConnect:
  SftpConnectApi`…). Une méthode = une action lisible métier.
- Capacités universelles (`fs`, `proc`, `net`, `users`, `groups`,
  `power`) : implémentation réelle si l'équipement en a une, rejet
  explicite (`throw new FileSystemError(path, 'EACCES', '<msg>')`) si
  l'équipement ne connaît pas cette notion. **Jamais de stub
  silencieux** qui retourne un tableau vide.
- `cli: CliMachineApi` obligatoire si le shell a des modes.
- `hostname`/`bootedAt()` obligatoires si les commandes en ont besoin.
- Sources : lit `router.getPorts()`, `switch.getVLANs()`, etc. —
  jamais d'état interne parallèle à ce qui existe déjà.
- Écrit : setter simple qui délègue à l'objet réel (`setHostname`,
  `setInterfaceAdminUp`) OU sous-canal métier (`sftpChannel.mkdir`).

### Étape 3 — Construire le bootstrap

Un fichier `create<Shell>HostShell(<realDevice>): { interpreter, machine,
promptBuilder?, defaultSession? }`.

Contenu :

- Construire les `CommandRegistry` (un par mode CLI, ou un global pour
  un shell POSIX).
- Y enregistrer les commandes (transitions vendor-cli + racines
  device-spécifiques + sous-registres).
- Construire `ModeRegistry` (CLI) ou pas (POSIX).
- Construire la `MachineApi`.
- Retourner `new CliInterpreter(modes, machine)` ou `new Interpreter
  (registry, machine)`.
- Pour un CLI vendeur : construire le `CliPromptBuilder` et une
  `defaultSession`.

### Étape 4 — Écrire ≥ 1 commande de preuve

Chaque commande est un fichier `<Cmd>.ts` extends `BaseCommand`. Elle
respecte STRICTEMENT :

1. **Descripteur complet** : name, alias(es) si vendor-standard, summary,
   usage, args (positional avec type), options (long/short/type/default/
   description), privileges (`DefaultPrivilegePolicy(...)` ou custom),
   category, streaming si applicable.
2. **`ctx.machine` = seule source de données**. Aucun import de
   formateur legacy, aucun import direct de `Router`/`Port`/`Switch`/
   `VirtualFileSystem`.
3. **Formatage inline** : la commande écrit elle-même chaque ligne de
   sortie sur `ctx.io.stdout`. Réutiliser les identifiants de format
   du vendeur (bannière `Cisco IOS Software…`, `Huawei Versatile Routing
   Platform Software`) est OK ; **réutiliser un formateur legacy est
   INTERDIT**.
4. **Erreurs métier via `ShellError`** (`UsageError`, `PermissionError`,
   `FileSystemError`, `InteractionUnavailableError`, custom). Jamais
   `throw new Error(...)` visible à l'appelant.
5. **Interactivité via `requireInteraction(ctx.io, name)`** →
   `ui.prompt({ kind: 'secret'|'text'|'confirm', prompt, defaultValue,
   allowEmpty })`. Retour `null` = abandon utilisateur, à gérer proprement.
6. **Flux continu via `streaming: true` + `ctx.signal`**. Écrire au fil
   de l'eau, s'arrêter dès que `ctx.signal.aborted`.
7. **Sous-registre pour commandes composées** : `readonly subRegistry =
   new CommandRegistry(); constructor() { super(); this.subRegistry.
   register(() => new SubCmd()); }` — pas de sous-dispatch ad-hoc.
8. **Écrit ce qu'elle sait faire (rules for settable data)** : setter
   MachineApi typé, pas de manipulation directe d'un état vendeur.
9. **Ne délègue PAS au shell legacy** (`this.shell.execute(this,
   line)`). Une commande pas encore migrée doit ÉCHOUER via le nouveau
   pipeline — c'est le signal explicite.

### Étape 5 — Débrancher `executeCommand` du legacy

Dans la classe équipement (`Router.ts`, `Switch.ts`, `LinuxMachine.ts`,
`WindowsPC.ts`, ou l'hôte d'un sous-shell `<Shell>SubShell.ts`) :

- Ajoute `private commandKernelCli?: <Shell>CommandKernelCli;`
- Ajoute `protected abstract createCommandKernelCli(): <Shell>Command
  KernelCli;` et `protected getCommandKernelCli()` avec lazy init.
- Ré-écris `executeCommand(line)` pour appeler `executeCommandKernel
  (line, session)` qui construit un `CommandIO` (PipeBuffer stdin
  fermé, collector stdout/stderr), appelle
  `cli.interpreter.interpretLine(...)`, capture les `ShellError`
  levées et renvoie le texte accumulé.
- Ré-écris `getPrompt()` pour appeler `cli.promptBuilder.build(cli.
  defaultSession)`.
- **JAMAIS DE FALLBACK** vers `this.shell.execute()`. Le shell legacy
  reste construit uniquement pour les services annexes non liés à
  l'exécution de ligne (tab-complete UI, `evaluatePrefixList`,
  `snapshotVtyState`, etc.) — que tu migreras au fil du temps.
- Chaque sous-classe vendeur (`CiscoRouter`, `HuaweiRouter`,
  `CiscoSwitch`…) implémente `createCommandKernelCli()`.

### Étape 6 — Preuve exécutable (test de fondation)

Un fichier `src/__tests__/unit/command-kernel/<shell>-cli-foundation.
test.ts` — miroir strict des tests existants
(`router-cli-foundation.test.ts`, `switch-cli-foundation.test.ts`).
Couvre :

- Le prompt par défaut par mode racine.
- Chaque transition de mode (`enable`, `configure terminal`, `exit`,
  `end`, `system-view`, `quit`…) et le prompt qui en résulte.
- Les abréviations préfixe-unique (`en`, `conf t`, `sh ver`, `sys`,
  `dis ver`).
- Chaque commande migrée : ce qu'elle produit, uniquement à partir de
  `ctx.machine`.
- Une commande non migrée qui échoue à travers le nouveau pipeline
  (signal migration explicite).
- Streaming (`ctx.signal.abort()`) si applicable.
- Interaction (mock `InteractionChannel`) si applicable.

Le test doit être 100 % vert. Lance `npx vitest run <path>`.

### Étape 7 — CHANGELOG + commit + push

Ajoute une entrée au TOP de `CHANGELOG.md` avec :

- Titre : `## <Shell> — <résumé>`
- État : `**État : branche de travail (\`<branch>\`), pas encore mergée
  sur \`mandeng\`.**`
- Composants ajoutés (fichiers, avec 1-2 lignes de description
  chacun).
- Ce qui est débranché du legacy (nommé).
- Preuve : N/N tests verts.
- Effet attendu (rougissement documenté, jamais caché).

Puis :

```bash
git fetch -q origin <branch>
git rebase origin/<branch>       # ou --continue en cas de conflit
git add -A
git commit -m "$(cat <<'EOF'
<Shell> : socle command-kernel + deconnexion executeCommand du legacy

<paragraphe 1 : ce qui est nouveau>
<paragraphe 2 : ce qui est deconnecte>
<paragraphe 3 : preuve executable, effet attendu>
EOF
)"
git push -u origin <branch>
```

**Toujours** `fetch` avant de `push`. Si le remote a avancé, `rebase`
proprement avant de pousser.

---

## Règles STRICTES (non-négociables)

1. **`MachineApi` = seule source de données par commande**. Aucun import
   dans une commande de `Router`, `Port`, `Switch`, `VirtualFileSystem`,
   `SftpSession`, `Router.aclEngine`. Si tu en as besoin, EXPOSE-le
   d'abord dans la MachineApi via une méthode typée.

2. **Commande standalone**. Une commande ne partage aucun état avec une
   autre, aucun helper mutable global. Formatage inline. Une méthode
   utilitaire pure (`isValidIp`, `parseCidr`) peut être extraite dans un
   fichier voisin — jamais un formateur legacy.

3. **`PrivilegePolicy` embarqué**. Le contrôle d'accès vit dans le
   descripteur. Aucun `if (user.isRoot())` ailleurs dans le code du
   pipeline.

4. **Une seule porte d'entrée**. `<Device>.executeCommand` appelle le
   `CliInterpreter` (ou l'`Interpreter`) ; ce dernier appelle
   `Executor` sur la feuille. Aucun autre chemin, aucun court-circuit
   par nom, aucun `case 'X':` dans `Router.ts`/`Switch.ts`.

5. **Pas de fallback legacy**. Une commande non migrée échoue via le
   nouveau pipeline. Le shell legacy reste construit pour services
   annexes (tab-complete, hooks BGP) et sera migré ; il n'est **jamais
   appelé pour exécuter une ligne**.

6. **Descripteur complet**. `args`/`options` typés, non des `variadic:
   true, type: 'string'` fourre-tout. La future auto-complétion s'appuie
   dessus.

7. **Erreurs métier via `ShellError`**. `throw new Error(...)` = bug
   interne, ne doit jamais atteindre l'utilisateur.

8. **Aucune expansion inconnue au vendeur**. Un CLI Cisco n'a pas
   `$HOME`, pas de redirection `>`, pas de `&&`. Ne les support**e** pas.

9. **Modes ⟺ registres séparés**. Chaque `CliMode` a son propre
   `CommandRegistry`. `configure` n'existe pas en mode `user`.

10. **Tests non modifiés pour "faire passer"**. Un test rouge = une
    commande à migrer. Ne masque **jamais** un signal migration en
    modifiant le test.

11. **CHANGELOG à chaque push**. Ce qui change, pourquoi, ce qui
    devient rouge, où on va ensuite.

12. **`git fetch` avant `git push`, systématiquement**.

---

## Points d'extension (enhance, pas rompre)

L'architecture peut évoluer par ajout ; jamais par retrait de
contrat existant.

### Ajouts autorisés

- **Nouvelle capacité `MachineApi.xxx?`** (toujours optionnelle) —
  quand un vendeur a une donnée qu'aucun autre n'a. Ne renomme pas une
  capacité existante.
- **Nouveau champ `CommandDescriptor.xxx?`** (toujours optionnel) —
  ex: `streaming`, `lenientOptions`, `deprecated`, `envelope`. Défaut
  cohérent avec les consommateurs existants.
- **Nouvelle sous-classe `BaseCommand`** — ex: `StreamingCommand`,
  `InteractiveCommand`. Réutilisable par tout vendeur.
- **Nouveau `CliMode`** — ajout d'un `config-vlan`, `interface-view`,
  etc. Enregistre son registre.
- **Nouveau shell entier** — `PowerShellHostShell`, `SqlPlusHostShell`,
  `PythonReplShell`. Peut réutiliser `Interpreter` OU en écrire un nouveau
  s'il a une grammaire propre (ex: SQL, pipeline PowerShell). Le nouveau
  doit :
  - Consommer `CommandRegistry` + `MachineApi` + `PermissionGuard` +
    `ArgumentParser` (jamais réécrire ces piliers).
  - Livrer un lexer/parser + une classe interpréteur qui délègue à
    `Executor.runSimple` ou équivalent sur la feuille.

### Ajouts INTERDITS (rupture)

- Changer la signature de `ICommand.execute(ctx)` ou de
  `CommandContext`.
- Rendre `MachineApi.fs` optionnel (des commandes existantes en
  dépendent).
- Retirer un mode CLI utilisé (déprécie d'abord, migre les commandes,
  puis retire).
- Introduire une source de données parallèle à `MachineApi`.

---

## Templates

### Template — commande simple (feuille, standalone)

```typescript
import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { <YourMachineApi> } from '../../<YourMachineApi>';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

export class <Cmd>Command extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: '<name>',
    aliases: ['<alias>'],
    summary: '<one-line>',
    usage: '<name> [--flag] [<positional>]',
    args: [
      { name: 'target', type: 'string', required: false, description: '...' },
    ],
    options: [
      { long: 'verbose', short: 'v', takesValue: false, description: '...' },
      { long: 'count',   short: 'c', takesValue: true, type: 'int', defaultValue: 4, description: '...' },
    ],
    privileges: OP,
    category: '<router|switch|linux|windows|sftp|oracle>',
  };
  readonly allowedModes = ['<mode-a>', '<mode-b>']; // CLI vendor only

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as <YourMachineApi>;
    const target = ctx.args.get<string | undefined>('target');
    const verbose = ctx.args.flag('verbose');
    const count = ctx.args.get<number>('count');

    // Lit UNIQUEMENT via machine.
    const data = await machine.<capability>.<read>();

    // Format inline.
    for (const item of data) {
      await ctx.io.stdout.write(`${item.field1}  ${item.field2}\n`);
      if (ctx.signal.aborted) return EXIT_OK;
    }
    return EXIT_OK;
  }
}
```

### Template — commande composite (racine + sous-registre)

```typescript
export class <Root>Command extends BaseCommand {
  readonly descriptor: CommandDescriptor = { /* ... */ };
  readonly allowedModes = ['<...>'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new <Leaf1>Command());
    this.subRegistry.register(() => new <Leaf2>Command());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write("<vendor-exact incomplete message>\n");
    return 1;
  }
}
```

### Template — transition de mode

```typescript
export class <PushCmd>Command extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: '<verb>',
    aliases: ['<abbrev>'],
    summary: '<one-line>',
    usage: '<verb>',
    args: [], options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR),
    category: 'cli-mode',
  };
  readonly allowedModes = ['<parent-mode>'];

  protected async prepare(ctx: CommandContext): Promise<boolean> {
    // (optionnel) Positionne des promptFields, écrit un texte d'entrée,
    // ou refuse la transition.
    return true;
  }

  protected targetMode(_ctx: CommandContext): string {
    return '<child-mode>';
  }
}
```

### Template — bootstrap CLI vendeur

```typescript
export function create<Shell>HostShell(<device>: <Device>): {
  interpreter: CliInterpreter;
  machine: <YourMachineApi>;
  promptBuilder: CliPromptBuilder;
} {
  const showSub = new CommandRegistry();
  showSub.register(() => new <RootShow_Version>Command());
  // ... autres sous-commandes de show

  const rootRegistry = new CommandRegistry();
  const childRegistry = new CommandRegistry();

  rootRegistry.register(() => new EnableCommand());
  rootRegistry.register(() => createShowCommand(showSub));
  rootRegistry.register(() => new PopModeCommand('exit'));

  childRegistry.register(() => new DisableCommand());
  childRegistry.register(() => new ConfigureCommand());
  // ...

  const modes = new ModeRegistry([
    { name: 'user',       prompt: (_s, h) => `${h}>`,  parent: null,   registry: rootRegistry },
    { name: 'privileged', prompt: (_s, h) => `${h}#`,  parent: 'user', registry: childRegistry },
  ], { execLevel: 'privileged' });

  const machine = new <YourMachineApi>({ <device>, modes });
  return {
    interpreter: new CliInterpreter(modes, machine),
    machine,
    promptBuilder: new CliPromptBuilder(modes, () => machine.hostname),
  };
}
```

### Template — déconnexion `executeCommand`

```typescript
async executeCommand(command: string): Promise<string> {
  if (!this.isPoweredOn) return '<vendor-exact powered-off message>';
  return this.executeCommandKernel(command, this.getCommandKernelCli().defaultSession);
}

private async executeCommandKernel(command: string, session: CliSession): Promise<string> {
  const cli = this.getCommandKernelCli();
  const chunks: string[] = [];
  const collector: OutputStream = { write: async (t) => { chunks.push(t); }, close: async () => {} };
  const stdin = new PipeBuffer(); await stdin.close();
  const io: CommandIO = { stdin, stdout: collector, stderr: collector };
  try {
    await cli.interpreter.interpretLine(command, session, io);
  } catch (err) {
    if (err instanceof Error) chunks.push(`${err.message}\n`);
    else throw err;
  }
  return chunks.join('').replace(/\n$/, '');
}
```

### Template — test de fondation

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { <Device> } from '@/network/devices/<Device>';
import { resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  EquipmentRegistry.resetInstance();
});

describe('<Shell> CLI foundation — command-kernel single-gate pipeline', () => {
  it('default prompt reflects root mode', () => {
    const d = new <Device>(...);
    expect(d.getPrompt()).toBe('<expected>');
  });

  it('mode transition updates the prompt', async () => {
    const d = new <Device>(...);
    await d.executeCommand('<push-verb>');
    expect(d.getPrompt()).toBe('<child-prompt>');
  });

  it('abbreviations resolve preferring unique prefixes', async () => {
    const d = new <Device>(...);
    const out = await d.executeCommand('<abbrev>');
    expect(out).toMatch(/<expected>/);
  });

  it('<cmd> uses MachineApi as sole data source', async () => {
    const d = new <Device>(...);
    const out = await d.executeCommand('<cmd>');
    expect(out).toMatch(/<vendor-exact-token>/);
  });

  it('an unmigrated command fails through the new pipeline (migration signal)', async () => {
    const d = new <Device>(...);
    const out = await d.executeCommand('<not-yet-migrated>');
    expect(out).toMatch(/inconnu|not-found|Incomplete/i);
  });
});
```

---

## Cas particuliers par famille de shell

### CLI vendeur à modes (Cisco IOS, Huawei VRP, futur firewall)

- Utilise **`CliInterpreter`** + **`ModeRegistry`** + **`CliSession`**.
- `vendor-cli/<vendor>/` pour les transitions communes routeur/switch.
- `<type>/command-kernel/` (router, switch, firewall) pour les
  MachineApi et sous-commandes device-spécifiques.
- Le vrai vendeur a des dizaines de config-* sub-modes. Ajoute-les au
  fur et à mesure — ne pré-crée pas 40 modes vides.

### Shell POSIX (Linux bash-like)

- Utilise **`Interpreter`** (bash-like : pipes, `&&`, redirections, `$VAR`).
- `CommandRegistry` unique (pas de mode).
- `MachineApi.fs`/`proc`/`users`/`groups`/`net` implémentés en dur.
- Pour l'interactivité (`adduser`, `passwd`), câble
  `ctx.io.interaction` sur un broker qui remonte à l'UI ; utilise
  `requireInteraction` et gère `null`.

### Shell Windows (cmd.exe)

- Grammaire différente : casse-insensitive, `\` en séparateur,
  wildcards par commande. Utilise **`CmdInterpreter`** existant
  (`src/network/devices/windows/command-kernel/CmdInterpreter.ts`) —
  ne le duplique pas.
- Chaque commande gère elle-même ses wildcards (`*.tmp`) via
  `ctx.machine.fs.list`.
- Les codes/formats vendeur (`'X' is not recognized...`) sont écrits
  par la commande, pas par le socle.

### PowerShell

- Objet-pipeline, pas texte-pipeline. Nécessite une extension du socle :
  soit une nouvelle sous-classe d'`Executor` qui passe des objets typés
  entre étages, soit un `ObjectPipe` distinct de `PipeBuffer`. **Enhance,
  ne pas rompre** : garde le pipeline texte existant intact, ajoute la
  variante objet.
- Cmdlets = commandes standard, alias vendeur (`ls` → `Get-ChildItem`).

### Sous-shell interactif (SFTP, SQL*Plus, RMAN)

- L'hôte (`<Shell>SubShell.ts` ou équivalent) ne fait plus qu'un
  `interpreter.interpretLine(line, session, io)` — miroir de
  `src/terminal/subshells/SftpSubShell.ts`.
- `MachineApi` peut être minimale (locale) + une capacité pour le canal
  réel (`SftpChannelApi`, `OracleSqlEngine`, `RmanScriptEngine`).
- Le prompt (`sftp>`, `SQL>`, `RMAN>`) est un simple string retourné par
  l'hôte ; pas besoin de `CliPromptBuilder` sauf modes.

### Migration d'un shell entièrement nouveau (jamais introduit)

Suit la même procédure ; commence par écrire le squelette de la
MachineApi (juste `hostname` + une capacité) et une commande
`version` triviale pour valider le pipeline. Puis étends au fil des
besoins.

---

## Anti-patterns — JAMAIS

1. **Réutiliser un formateur legacy** dans une commande migrée.
2. **Importer `Router`/`Port`/`Switch`/`VirtualFileSystem`** dans un
   fichier `commands/*.ts`.
3. **`throw new Error(...)`** dans une commande (utilise `ShellError`).
4. **Fallback silencieux** vers `this.shell.execute()`.
5. **Court-circuit par nom** (`if (cmd === 'X') return ...;`) dans
   l'équipement.
6. **Descripteur fourre-tout** (`args: [{ variadic: true, type:
   'string' }]`) pour une commande à sous-mots stables.
7. **Modifier un test rouge pour "faire passer"** au lieu de migrer la
   commande.
8. **Push sans `git fetch` préalable**.
9. **Push sans CHANGELOG**.
10. **`console.log`** dans une commande.
11. **État global mutable** partagé entre commandes.
12. **Rompre `ICommand` ou `CommandContext`** — extension optionnelle
    uniquement.

---

## Checklist avant push

- [ ] La MachineApi n'expose aucun objet vendeur brut, uniquement des
      DTOs typés.
- [ ] Chaque commande migrée n'importe RIEN du legacy (formateur,
      shell, engine direct).
- [ ] Chaque descripteur a `args`/`options` typés, pas de fourre-tout.
- [ ] Chaque commande a une `PrivilegePolicy` explicite.
- [ ] Le bootstrap enregistre exactement les commandes attendues par
      mode.
- [ ] `executeCommand` de l'équipement ne consulte plus JAMAIS le
      shell legacy.
- [ ] Les tests de fondation (transitions, prompts, abréviations,
      commandes migrées, signal migration) sont 100 % verts.
- [ ] `npx tsc --noEmit -p tsconfig.app.json` propre sur les fichiers
      touchés (nombre d'erreurs identique à la baseline).
- [ ] `npx eslint <touched-files>` propre.
- [ ] `CHANGELOG.md` en tête avec entrée descriptive (composants,
      débranchement, preuve, effet attendu).
- [ ] Commit atomique par shell/vendeur (pas de mélange
      routeur+switch+windows dans un seul commit).
- [ ] `git fetch origin <branch>` fait AVANT le push.
- [ ] Push effectif (`git push -u origin <branch>`).

---

## Cadre de référence (à `Grep`/`Read` en début de travail)

Ces fichiers montrent les patterns canoniques déjà appliqués — inspire-toi
en STRICTEMENT :

- `migration_framework.md` (§0 à §14) — la doctrine complète.
- `src/command-kernel/cli/cli-interpreter.ts` — la porte d'entrée
  unique.
- `src/network/devices/router/command-kernel/RouterMachineApi.ts` —
  MachineApi propre avec DTOs, sous-façade `router`, rejets explicites.
- `src/network/devices/switch/command-kernel/SwitchMachineApi.ts` —
  miroir pour L2 (VLAN/MAC/switchport).
- `src/network/devices/router/command-kernel/createCiscoRouterHostShell.ts`
  — bootstrap avec modes et registres séparés.
- `src/network/devices/vendor-cli/cisco/Show.ts` — factory
  `createCiscoShowCommand(subRegistry)` pour la composition.
- `src/network/devices/vendor-cli/cisco/ConfigureTerminal.ts` — commande
  composite avec sous-registre statique.
- `src/network/devices/router/command-kernel/commands/cisco/show/Version.ts`
  — commande feuille standalone, `ctx.machine` pour seule source.
- `src/__tests__/unit/command-kernel/router-cli-foundation.test.ts` +
  `switch-cli-foundation.test.ts` — templates de test.
- `src/network/devices/linux/command-kernel/LinuxMachineApi.ts` —
  MachineApi la plus riche (fs POSIX, netProbe, sftpConnect, cli
  interaction).
- `src/network/devices/linux/command-kernel/commands/Ping.ts` +
  `Adduser.ts` — streaming + interactive canoniques.
- `src/terminal/subshells/SftpSubShell.ts` — hôte de sous-shell qui
  délègue tout à `interpretLine` (aucun switch legacy).

---

*Version 1.0 — synchronisée avec `migration_framework.md` §0-§14 et la
déconnexion `Router`/`Switch.executeCommand` (branche arthur).*
