# Framework de migration `command-kernel` — Ubuntu Sandbox

Ce document est le référentiel unique pour tout agent (humain ou IA) qui
migre une commande, un sous-système ou un nouvel équipement vers
l'architecture `command-kernel`. Il ne décrit pas ce que fait le code
existant en détail — l'architecture de classes le fait déjà — mais
**comment s'y prendre pour y ajouter quelque chose sans casser les
invariants du système**, avec le code réel du projet à l'appui, pas des
généralités.

Le respect de ce framework est **non négociable**. En cas de doute entre
« aller vite » et « respecter le framework », c'est toujours le framework
qui gagne. Si une étape ci-dessous semble superflue pour un cas précis,
c'est un signal pour relire §7 avant de la sauter — c'est exactement ce
raisonnement qui a produit 25 régressions silencieuses la dernière fois.

---

## 0. Principes directeurs (à ne jamais violer)

1. **Une seule porte d'entrée vers la machine.** Une commande ne touche
   *jamais* `VirtualFileSystem`, `LinuxUserManager`, `LinuxProcessManager`
   directement. Elle ne connaît que `ctx.machine : MachineApi`
   (`src/command-kernel/machine/types.ts`). Si une capacité manque sur la
   façade, on l'y ajoute — on ne contourne jamais.
2. **La politique de sécurité vit sur la commande, pas sur le moteur.**
   `CommandDescriptor.privileges: PrivilegePolicy` est LA source de
   vérité (`src/command-kernel/session/privilege-policy.ts`). Le moteur
   (`Executor`/`PermissionGuard`) ne fait qu'appliquer ce que la commande
   déclare — zéro logique de sécurité codée en dur pour une commande
   particulière dans `executor.ts` ou `interpreter.ts`.
3. **Le moteur ne connaît aucune commande concrète.** `Executor`,
   `Interpreter`, `Lexer`, `Parser` n'importent jamais `CatCommand` ni
   quoi que ce soit de similaire. Le seul point de couplage autorisé est
   `CommandRegistry.register(() => new XxxCommand())`.
4. **Isolation de session explicite.** Tout ce qui clone une `Session`
   (`Executor.run`, cas `"subshell"`) doit cloner `variables`/`env` par
   copie (`new Map(session.variables)`), jamais par référence — et
   documenter précisément ce qui remonte vers le parent (le code de
   sortie, jamais les variables).
5. **Aucune commande ne connaît le `Terminal`.** Elle ne parle qu'à
   `ctx.io : CommandIO` (`src/command-kernel/io/types.ts`), qui peut être
   un vrai terminal, un étage de pipeline (`PipeBuffer`), ou le buffer de
   capture construit par `LinuxMachine.tryCommandKernel()`.
6. **Un `ScriptNode` = un `case` dans `Executor.run`.** Toute nouvelle
   construction syntaxique doit être un nouveau membre de l'union
   `ScriptNode` (`src/command-kernel/ast/nodes.ts`), jamais une variante
   cachée dans un nœud existant via un `if` spécial.
7. **Jamais de repli silencieux sur l'ancien chemin après un début
   d'exécution.** Voir §6 — c'est la règle la plus facile à violer par
   accident, et celle qui protège l'invariant « on sait toujours ce qui
   est réellement migré ».
8. **Reproduire les effets de bord legacy, jamais les contourner.** Voir
   §7 — le prélude d'audit/privilège de `LinuxCommandExecutor.dispatch()`
   doit être répliqué pour toute commande migrée, pas ignoré parce que
   « ça n'a l'air de rien changer visiblement ».
9. **Discipline Git stricte** (détaillée en §11) : branche de travail
   assignée uniquement, un push = une fonctionnalité complète et testée,
   pas de commentaires dans le code livré (le nommage porte le sens),
   pas de duplication, `CHANGELOG.md` tenu à jour à chaque push.
10. **Tests localisés, jamais la suite complète** (détaillée en §10) —
    16 000+ scénarios, ce n'est pas praticable, et ce n'est pas
    nécessaire si le lot de tests localisés est choisi correctement.

---

## 1. Cartographie des couches et où intervenir

```
Terminal / VirtualTerminal            (src/command-kernel/terminal/)
        │
      Shell (REPL, historique, prompt) (src/command-kernel/shell/)
        │
     Interpreter.interpretLine(line, session, io)   (interpreter.ts)
        │
   Lexer → Token[] → Parser → ScriptNode            (ast/)
        │
     Executor.run(ast, session, io)                 (exec/executor.ts)
        │            │
        │      PermissionGuard.check(command, user, args)  (exec/permission-guard.ts)
        │            │
        ├─ résout la commande via CommandRegistry     (registry/command-registry.ts)
        ├─ expand (Expander) + glob (expandGlob) chaque Word   (ast/expander.ts, exec/glob-expand.ts)
        ├─ ArgumentParser.parse(argv, descriptor) → ParsedArgs (args/)
        └─ command.execute(ctx: CommandContext)
                 │
              ctx.machine : MachineApi
                 (fs / proc / net / users / groups / power / audit?)
```

| Couche | Fichier(s) | Quand on y touche |
|---|---|---|
| Terminal | `terminal/terminal.ts`, `terminal/virtual-terminal.ts` | nouveau front (test, capture) |
| Shell | `shell/shell.ts`, `shell/history.ts`, `shell/prompt-builder.ts` | nouveau comportement de boucle interactive |
| Interpreter | `interpreter.ts` | nouvelle méthode d'entrée (rare — `interpretLine`/`runScript` couvrent déjà les deux usages) |
| Lexer/Parser/AST | `ast/lexer.ts`, `ast/parser.ts`, `ast/nodes.ts`, `ast/tokens.ts` | nouvelle construction syntaxique (voir §5 avant de toucher ici) |
| Expander | `ast/expander.ts` | nouvelle règle d'expansion (`$VAR`, `~`, échappement — voir le piège `ESCAPED_DOLLAR` en §5.4) |
| Executor | `exec/executor.ts` | nouveau `kind` de `ScriptNode`, nouvelle sémantique d'exécution |
| PermissionGuard | `exec/permission-guard.ts` | jamais, sauf nouveau mécanisme de vérification générique (rare) |
| Registry | `registry/command-registry.ts` | jamais, sauf nouveau mode de résolution |
| Command | `command/base-command.ts`, `command/types.ts` + `<vendeur>/command-kernel/commands/*.ts` | **c'est ici que 90 % du travail se fait** (§3) |
| MachineApi | `machine/types.ts` (contrat) + `<vendeur>/command-kernel/*MachineApi.ts` (implémentation) | nouvelle capacité système nécessaire à une commande (§3.4) |
| Pont legacy | `src/network/devices/LinuxMachine.ts` (`tryCommandKernel`, `getCommandKernelShell`) | jamais pour ajouter une commande — seulement si les garanties de sécurité elles-mêmes doivent évoluer (§6) |

**Règle pratique** : avant d'écrire une ligne de code, identifie une
seule couche cible. Si l'ajout semble toucher trois couches à la fois,
c'est probablement le signe qu'une méthode `MachineApi` manque — on
l'ajoute d'abord, isolément (§3.4), avant de continuer.

---

## 2. Frontière avec le plan réseau existant (ne rien réinventer)

Le simulateur a **déjà** un plan de données réseau mature, complet, et
testé sur 250+ fichiers de protocoles (OSPF, BGP, EIGRP, STP, ARP, DHCP,
IPSec…). `command-kernel` ne réimplémente **jamais** ce plan — il ne fait
que l'exposer, via `MachineApi.net`, aux commandes qui en ont besoin
(`ping`, `ip`, `traceroute`…).

### 2.1 Comment le trafic circule réellement (existant, ne pas dupliquer)

```
Equipment.send(frame, portName)
   → Port.sendFrame(frame)
   → Cable.transmit(frame, thisPort)
   → autrePort.receiveFrame(frame)
   → Equipment.handleFrame(portName, frame)   // abstract, implémenté par chaque sous-classe
```

- `src/network/equipment/Equipment.ts` — classe abstraite, `handleFrame()`
  est le point d'entrée que chaque device (switch, routeur, PC…)
  implémente pour définir son comportement (apprentissage MAC, routage,
  réponse ICMP…).
- `src/network/hardware/Port.ts` / `Cable.ts` — couche physique : un
  câble relie deux ports, la transmission passe TOUJOURS par lui (jamais
  de téléportation d'un résultat réseau).
- `src/network/core/types.ts` — les structures de trame/paquet
  (`EthernetFrame`, `IPv4Packet`, `ARPPacket`, `ICMPPacket`, `UDPPacket`,
  `RIPPacket`) et les types d'adresse (`MACAddress`, `IPAddress`,
  `SubnetMask`).
- `src/events/` (`EventBus`, `Scheduler`, `TimerSet`, `Signal`) — les
  primitives réactives déjà utilisées par les protocoles temporisés
  (OSPF, DHCP, BGP…). `IScheduler`/`VirtualTimeScheduler` jouent déjà le
  rôle d'une horloge logique déterministe pour les tests.

### 2.2 Ce que `command-kernel` doit faire (et ne doit jamais faire)

Une commande réseau migrée (`ping`, `ip addr`, `traceroute`…) doit
**déléguer** au plan existant via une extension de `NetworkApi`, jamais
fabriquer une réponse « en dur » :

```ts
// machine/types.ts — extension correcte
export interface NetworkApi {
  interfaces(): Promise<{ name: string; ip: string; up: boolean }[]>;
  setInterfaceState(name: string, up: boolean): Promise<void>;
  // Nouvelle capacité : DOIT déléguer au vrai Equipment/Port/Cable de
  // l'équipement, jamais renvoyer un résultat calculé sans qu'une trame
  // ait réellement traversé la topologie.
  ping(targetIp: string, count?: number): Promise<PingResult>;
}
```

Et côté pont Linux (`LinuxNetworkApi` dans `LinuxMachineApi.ts`),
l'implémentation doit invoquer le mécanisme ICMP réel déjà utilisé par le
device (`EndHost`/`LinuxPC`), pas une simulation parallèle :

```ts
async ping(targetIp: string, count = 4): Promise<PingResult> {
  // délègue à la même mécanique ICMP que `EndHost` utilise déjà —
  // jamais une seconde implémentation d'ICMP ad hoc dans command-kernel.
  return this.deps.icmpClient.ping(targetIp, count);
}
```

**Ce chapitre n'est pas une invitation à construire un nouveau
`Topology`/`Fabric`/`NetworkScheduler`** — ces briques existent déjà sous
d'autres noms (`Equipment`, `Port`, `Cable`, `IScheduler`). Le travail de
migration réseau consiste à **brancher** `MachineApi.net` dessus, pas à
les reconstruire. Si une capacité manque réellement dans
`Equipment`/`Port`/`Cable` pour supporter une commande, c'est un chantier
à part, à documenter et discuter explicitement avant de s'y engager — pas
une extension silencieuse de `command-kernel`.

---

## 3. Développer une nouvelle commande — procédure complète

### 3.1 Checklist (dans l'ordre, aucune étape sautée)

1. **Lire l'implémentation legacy en entier** — pas seulement la logique
   métier du `case 'xxx':` dans `LinuxCommandExecutor.dispatch()` (ou la
   fonction `cmdXxx` associée dans `LinuxTextCommands.ts`/
   `LinuxFileCommands.ts`/etc.), mais **tout ce qui l'entoure** : appels
   `publishFsAccess`/`publishSyscall` (§7), vérifications de privilège,
   formats de message d'erreur EXACTS, codes de sortie.
2. **Repérer TOUS les tests qui l'exercent**, pas seulement ceux dont le
   nom contient la commande :
   ```bash
   grep -rl "'nom_commande " src/__tests__/unit/network-v2/
   ```
   … et systématiquement aussi (§7, §10) :
   ```
   auditctl.test.ts  auditctl-other.test.ts
   journalization.test.ts  journalization-and-audit.test.ts
   command-privilege-policy.test.ts
   ```
3. **Vérifier qu'elle n'est pas déjà migrée ailleurs.** Le projet a un
   AUTRE framework de migration, antérieur à `command-kernel` :
   `src/network/devices/linux/commands/` (`LinuxCommand`, enregistré
   dans `LinuxCommandRegistry`, invoqué via
   `LinuxMachine.tryNetworkCommand()`). Certaines commandes (`chown`,
   `chgrp`…) existent dans les DEUX endroits. Vérifie laquelle est
   réellement empruntée avant de dupliquer — ne suppose jamais, lis le
   code de dispatch (§8).
4. **Écrire le descripteur AVANT le code** :
   - `args: readonly ArgumentSpec[]` — un `variadic: true` doit toujours
     être en dernière position.
   - `options: readonly OptionSpec[]` — `short`, `long`, `takesValue`,
     `type`, `defaultValue?`, `numericShorthand?` (pour `head -3`),
     `requiredCapability?` (si une option précise exige une capacité
     au-delà de la politique globale de la commande).
   - `privileges: PrivilegePolicy` — voir §3.3.
   - `usage`/`summary` exacts (alimentent l'aide `--help` générée).
5. **Implémenter `execute(ctx: CommandContext): Promise<ExitCode>`** :
   - lire les arguments via `ctx.args.get<T>(name)` / `ctx.args.has(name)`
     / `ctx.args.flag(name)` — jamais parser `ctx.rawArgv` à la main sauf
     nécessité documentée (ex : syntaxe trop irrégulière pour
     `ArgumentParser`, voir §3.5) ;
   - n'appeler QUE `ctx.machine.*` pour toute interaction système ;
   - écrire la sortie via `ctx.io.stdout`/`ctx.io.stderr` — jamais
     `console.log` ;
   - publier les effets de bord d'audit AVANT de retourner mais APRÈS
     que l'opération ait réellement réussi (§7.4) ;
   - retourner un `ExitCode` cohérent (§9).
6. **`protected override validate(args, session)`** (hook de
   `BaseCommand`) : uniquement pour la cohérence *entre arguments déjà
   parsés* (ex : `ChmodCommand` y vérifie que le mode correspond au motif
   octal OU symbolique). La validation de type reste le travail de
   `ArgumentParser`.
7. **Enregistrer** dans `createLinuxHostShell.ts` :
   `registry.register(() => new XxxCommand())`.
8. **Ne PAS écrire de nouveau test unitaire**, sauf instruction explicite
   contraire. Le critère de réussite est : *les tests déjà présents dans
   le projet passent*, en mode localisé (§10).
9. **Typecheck ciblé** :
   ```bash
   npx tsc --noEmit -p tsconfig.app.json --ignoreDeprecations 5.0 \
     2>&1 | grep -iE "command-kernel|LinuxMachine"
   ```
10. **Tests localisés** (§10), lot « effets de bord » (§7) inclus
    systématiquement dès que la commande touche filesystem/utilisateur/
    privilège/processus.
11. **`CHANGELOG.md`** — nouvelle entrée : ce qui est migré, ce qui a été
    trouvé/corrigé EN TESTANT CONTRE LA SUITE EXISTANTE (avec la cause
    racine, pas juste le symptôme), ce qui reste hors périmètre.
12. **Commit + push** sur la branche de travail assignée uniquement
    (§11).

### 3.2 Gabarit complet (réel, basé sur `Chmod.ts`)

```ts
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { UsageError } from '@/command-kernel/errors';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class ExempleCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'exemple',
    summary: 'Résumé en une ligne, visible dans `--help`',
    usage: 'exemple [-o VALEUR] <cible...>',
    args: [
      { name: 'targets', type: 'path', required: true, variadic: true,
        description: 'cibles à traiter' },
    ],
    options: [
      { long: 'option', short: 'o', takesValue: true, type: 'string',
        description: '...' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const targets = ctx.args.get<string[]>('targets');
    const actor = toFileSystemActor(ctx.session.user);

    for (const target of targets) {
      const path = ctx.machine.fs.resolve(ctx.session.cwd, target);
      await ctx.machine.fs.stat(path, actor); // ... logique métier via MachineApi
      // effets de bord d'audit APRÈS l'opération réussie, pas avant (§7.4)
      ctx.machine.audit?.fsAccess(path, 'r');
    }
    return EXIT_OK;
  }
}
```

### 3.3 Choisir la `PrivilegePolicy`

```ts
export interface PrivilegePolicy {
  readonly minLevel: PrivilegeLevel;               // ANY | AUTHENTICATED | OPERATOR | ROOT
  readonly requiredGroups?: readonly string[];      // ex: ["sudo", "wheel"]
  readonly requiredCapabilities?: readonly Capability[]; // FS_CHOWN, PROC_KILL, NET_ADMIN...
  authorize(user: User): AuthorizationResult;
}
```

`DefaultPrivilegePolicy` (`session/privilege-policy.ts`) couvre l'immense
majorité des cas — `root` passe toujours, sinon vérifie niveau, groupes,
capacités dans cet ordre. **Avant de choisir un niveau**, vérifie dans
`src/network/devices/linux/iam/policy/defaultCommandPrivileges.ts` si la
commande a une entrée legacy : si oui, la politique command-kernel doit
être strictement équivalente (le §7 explique pourquoi une différence ici
est un vrai trou de sécurité, pas un détail cosmétique).

### 3.4 Étendre `MachineApi` — règles

`src/command-kernel/machine/types.ts` est **vendor-agnostic par
construction**. Avant d'y ajouter quoi que ce soit :

1. Le type ajouté ne doit contenir **aucun détail Linux-spécifique**
   (`inode`, nom de syscall Linux, format `/etc/passwd`…) sauf s'il s'agit
   d'une capacité explicitement **optionnelle**, comme `audit?: AuditApi`
   (§7) — un équipement Cisco/Windows n'implémente simplement pas le
   champ optionnel.
2. Documente en une ligne (commentaire JSDoc sur l'interface, pas sur
   l'usage) pourquoi cette méthode est nécessaire à un niveau
   suffisamment général pour qu'un autre vendeur puisse un jour
   l'implémenter différemment.
3. Implémente-la dans **chaque** `<Vendeur>MachineApi` qui déclare
   `implements MachineApi` — TypeScript te le rappellera au typecheck
   (voir l'ajout de `FileSystemApi.touch()` dans le commit qui a
   introduit `LinuxAuditRules`/`vfs.onWrite` — a nécessité une
   implémentation dans `LinuxFileSystemApi` ET dans
   `testing/in-memory-machine.ts`, le `MachineApi` factice utilisé par
   les tests du socle lui-même).
4. Interface `FileSystemApi` actuelle, pour référence exacte :
   ```ts
   export interface FileSystemApi {
     readFile(path: string, actor: FileSystemActor): Promise<string>;
     writeFile(path: string, content: string, actor: FileSystemActor, append?: boolean): Promise<void>;
     touch(path: string, actor: FileSystemActor): Promise<void>;
     list(path: string, actor: FileSystemActor): Promise<FileStat[]>;
     stat(path: string, actor: FileSystemActor): Promise<FileStat>;
     lstat(path: string, actor: FileSystemActor): Promise<FileStat>;
     exists(path: string, actor: FileSystemActor): Promise<boolean>;
     remove(path: string, actor: FileSystemActor, recursive?: boolean): Promise<void>;
     mkdir(path: string, actor: FileSystemActor, parents?: boolean): Promise<void>;
     chmod(path: string, mode: number, actor: FileSystemActor): Promise<void>;
     chown(path: string, uid: number, gid: number, actor: FileSystemActor): Promise<void>;
     copy(source: string, destination: string, actor: FileSystemActor): Promise<void>;
     rename(source: string, destination: string, actor: FileSystemActor): Promise<void>;
     symlink(target: string, path: string, actor: FileSystemActor): Promise<void>;
     readlink(path: string, actor: FileSystemActor): Promise<string>;
     resolve(cwd: string, path: string): string;
   }
   ```
   `touch()` existe **séparément** de `writeFile()` — ce n'est pas une
   redondance : `touch` sur un fichier existant ne fait que rafraîchir sa
   date de modification, sans passer par le chemin d'écriture générique
   (raison exacte en §7.4, point le plus subtil du fix).

### 3.5 Quand `ArgumentParser` ne suffit pas

`ArgumentParser.parse(argv, descriptor)` gère : options courtes/longues,
valeurs collées (`-d,`, `-n5` via `matchGluedShortValue`), clusters de
booléens (`-la` = `-l -a`), raccourci numérique (`head -3` via
`numericShorthand: true`), positionnels variadiques. Pour une syntaxe
plus irrégulière (ex : `sort -k 2,2n` où la valeur peut être collée ou
séparée ET porte elle-même une mini-grammaire), le pattern établi est de
laisser `ArgumentParser` extraire la valeur BRUTE de l'option
(`ctx.args.get<string>('key')`), puis parser cette chaîne dans la
commande elle-même (voir `parseSortKey()` dans
`commands/Sort.ts`) — **jamais** complexifier `ArgumentParser` pour un
besoin propre à une seule commande.

Cas limite documenté : un token qui *ressemble* à une option mais ne doit
JAMAIS lever d'erreur si non reconnu (`echo -w texte-quelconque` doit
afficher le texte littéralement, comme le vrai `echo`, pas échouer).
Pour ce cas précis, `CommandDescriptor.lenientOptions?: boolean` fait
qu'un token `-x` non reconnu devient un positional au lieu de lever
`UsageError` — opt-in, uniquement sur les commandes dont le comportement
réel l'exige (`EchoCommand`), jamais activé par défaut.

---

## 4. Développer un nouveau type d'équipement

Le principe : `command-kernel` (le socle, `src/command-kernel/`) ne
change JAMAIS pour un nouvel équipement. Seul un nouveau pont apparaît,
sur le modèle du pont Linux.

### 4.1 Étapes

1. Créer `src/network/devices/<vendeur>/command-kernel/`.
2. Implémenter `<Vendeur>MachineApi implements MachineApi` — une classe
   interne par sous-API (`<Vendeur>FileSystemApi implements FileSystemApi`,
   `<Vendeur>ProcessApi implements ProcessApi`, etc.), chacune enveloppant
   les objets **réels déjà existants** pour cet équipement (jamais de
   `Map` parallèle dupliquant un état qui vit déjà ailleurs). Modèle
   exact : `LinuxMachineApi.ts` — chaque sous-API prend en constructeur
   la référence vers l'objet legacy réel (`VirtualFileSystem`,
   `LinuxUserManager`…), rien de plus.
3. Implémenter `<Vendeur>User implements User` — adapte le compte
   utilisateur réel de cet équipement au contrat `User` (uid/gid/
   groupes/capacités). Modèle : `LinuxUser.ts` + `resolveLinuxUser()`.
4. Écrire `create<Vendeur>HostShell(deps): Interpreter` :
   ```ts
   export function create<Vendeur>HostShell(deps: <Vendeur>MachineApiDeps): Interpreter {
     const registry = new CommandRegistry();
     const machine = new <Vendeur>MachineApi(deps);

     registerCoreCommands(registry); // exit, echo — universelles, jamais dupliquées
     registry.register(() => new PwdCommand());
     // ... uniquement les commandes qui ont un sens pour CE vendeur

     return new Interpreter(registry, machine);
   }
   ```
5. Câbler un pont `tryCommandKernel()`-like dans la classe d'équipement
   existante (`<Vendeur>Machine.ts`), en respectant EXACTEMENT les
   garanties de sécurité du §6 — copier-coller la structure de
   `LinuxMachine.tryCommandKernel()`, pas la réinventer.
6. Ne migrer QUE les commandes qui ont un sens pour ce vendeur — un
   switch niveau 2 pur n'a pas de `chown`, un firewall n'a pas de `vlan`.
   Pas de copie mécanique de la liste Linux.

### 4.2 Isoler les particularités de privilège par équipement

Dans la `PrivilegePolicy` de CHAQUE commande, jamais dans le moteur. Ex :
sur un switch, une commande `vlan` peut exiger
`PrivilegeLevel.OPERATOR` alors qu'elle n'existe même pas côté PC Linux —
c'est une question de descripteur, pas de branchement dans `Executor`.

---

## 5. Sémantique du langage (Lexer/Parser/Executor) — ce qui existe déjà

### 5.1 L'AST réel (`ast/nodes.ts`)

```ts
export interface Word { readonly text: string; readonly noExpand: boolean; }

export interface SimpleCommandNode { readonly kind: "command"; readonly name: string;
  readonly argv: readonly Word[]; readonly redirections: readonly RedirectionNode[]; }
export interface RedirectionNode { readonly kind: "redirect";
  readonly mode: "in" | "out" | "append"; readonly target: string; }
export interface PipelineNode { readonly kind: "pipeline"; readonly stages: readonly SimpleCommandNode[]; }
export interface LogicalNode { readonly kind: "and" | "or"; readonly left: ScriptNode; readonly right: ScriptNode; }
export interface SequenceNode { readonly kind: "sequence"; readonly statements: readonly ScriptNode[]; }
export interface IfNode { readonly kind: "if"; readonly condition: ScriptNode;
  readonly thenBranch: ScriptNode; readonly elseBranch?: ScriptNode; }
export interface ForNode { readonly kind: "for"; readonly variable: string;
  readonly items: readonly string[]; readonly body: ScriptNode; }
export interface WhileNode { readonly kind: "while"; readonly condition: ScriptNode; readonly body: ScriptNode; }
export interface AssignmentNode { readonly kind: "assign"; readonly name: string; readonly value: string; }
export interface SubshellNode { readonly kind: "subshell"; readonly body: ScriptNode; }

export type ScriptNode = SimpleCommandNode | PipelineNode | LogicalNode | SequenceNode
  | IfNode | ForNode | WhileNode | AssignmentNode | SubshellNode;
```

`Word.noExpand` existe précisément pour qu'un mot issu (même
partiellement) de guillemets simples ne subisse jamais l'expansion
`$VAR` — c'est un bug réel trouvé en migrant (un argument `'texte $VAR'`
était expansé à tort avant ce correctif). Toute nouvelle règle de citation
doit respecter ce champ, jamais le contourner.

### 5.2 `Executor.run` — un `case` par nature de nœud, jamais plus

```ts
async run(node: ScriptNode, session: Session, io: CommandIO): Promise<ExitCode> {
  switch (node.kind) {
    case "command":  return this.runSimple(node, session, io);
    case "pipeline": return this.runPipeline(node, session, io);
    case "and": { const code = await this.run(node.left, session, io);
      return code === EXIT_OK ? this.run(node.right, session, io) : code; }
    case "or":  { const code = await this.run(node.left, session, io);
      return code !== EXIT_OK ? this.run(node.right, session, io) : code; }
    case "sequence": { let last = EXIT_OK;
      for (const stmt of node.statements) { last = await this.run(stmt, session, io); session.lastExitCode = last; }
      return last; }
    case "if": { const cond = await this.run(node.condition, session, io);
      if (cond === EXIT_OK) return this.run(node.thenBranch, session, io);
      return node.elseBranch ? this.run(node.elseBranch, session, io) : EXIT_OK; }
    case "for": { let last = EXIT_OK;
      for (const rawItem of node.items) {
        const [item] = this.expander.expand(rawItem, session);
        session.variables.set(node.variable, item);
        last = await this.run(node.body, session, io); session.lastExitCode = last;
      } return last; }
    case "while": { let last = EXIT_OK;
      while ((await this.run(node.condition, session, io)) === EXIT_OK) {
        last = await this.run(node.body, session, io); session.lastExitCode = last;
      } return last; }
    case "assign": { const [value] = this.expander.expand(node.value, session);
      session.variables.set(node.name, value); session.lastExitCode = EXIT_OK; return EXIT_OK; }
    case "subshell": {
      const cloned: Session = { ...session, variables: new Map(session.variables), env: new Map(session.env) };
      const code = await this.run(node.body, cloned, io);
      // le sous-shell n'expose JAMAIS ses variables au parent (isolation),
      // mais son code de sortie remonte bien vers l'appelant.
      return code;
    }
  }
}
```

**Invariant à ne jamais casser** : `subshell` clone `variables`/`env`
par COPIE (`new Map(...)`), pas par référence. Tout test qui touche à un
sous-shell doit vérifier séparément : (1) que le corps du sous-shell ne
modifie pas `cwd`/`variables`/`env` du parent, (2) que `$?` du parent est
mis à jour avec le code de sortie du sous-shell.

### 5.3 Pipeline — isolation par étage, pas de mélange avec les redirections

```ts
private async runPipeline(node: PipelineNode, session: Session, io: CommandIO): Promise<ExitCode> {
  let previous: InputStream = io.stdin;
  let last: ExitCode = EXIT_OK;
  for (let i = 0; i < node.stages.length; i++) {
    const isLast = i === node.stages.length - 1;
    const pipe = new PipeBuffer();
    last = await this.runSimple(node.stages[i], session,
      { stdin: previous, stdout: isLast ? io.stdout : pipe, stderr: io.stderr });
    await pipe.close();
    previous = pipe;
  }
  session.lastExitCode = last;
  return last;
}
```

Chaque étage reçoit un `PipeBuffer` **frais** ; seul le dernier étage
écrit vers le `io.stdout` réel. `runSimple` (l'exécution d'une commande
simple, appelée aussi bien depuis `run("command")` que depuis
`runPipeline`) résout la commande, vérifie les privilèges
(`PermissionGuard`), applique les redirections (`applyRedirections` —
`>`/`>>`/`<`, via `FileOutputStream`), construit le `CommandContext`, et
capture toute `ShellError` pour l'afficher proprement sur `stderr` sans
jamais laisser fuiter une exception native.

### 5.4 Expander — piège du `$` échappé

```ts
export class Expander {
  expand(word: string, session: Session): string[] {
    let result = word
      .replace(/\$\?/g, String(session.lastExitCode))
      .replace(/\$\{(\w+)\}/g, (_, name) => session.variables.get(name) ?? session.env.get(name) ?? "")
      .replace(/\$(\w+)/g, (_, name) => session.variables.get(name) ?? session.env.get(name) ?? "");
    if (result.startsWith("~")) result = (session.env.get("HOME") ?? "/") + result.slice(1);
    result = result.split(ESCAPED_DOLLAR).join("$"); // restitue le '$' échappé, voir ci-dessous
    return [result];
  }
}
```

`ESCAPED_DOLLAR` (`ast/tokens.ts`) est un caractère sentinelle
(``, zone d'usage privé Unicode) posé par le `Lexer` quand il
rencontre `\$` (guillemets doubles ou nu). Sans ce mécanisme, `echo
"prix: \$5"` verrait son `\$5` réduit à `$5` PAR LE LEXER, puis
l'`Expander` tenterait de substituer une variable `5` inexistante et
l'effacerait silencieusement — bug réel trouvé en migrant `echo`. Le
sentinel survit à travers le pipeline (Lexer → mot brut → Expander) sans
jamais déclencher d'expansion, et n'est restitué en `$` littéral qu'à la
toute fin. Toute nouvelle règle d'échappement doit suivre ce même schéma
(marqueur interne intraçable, jamais un simple retrait du backslash au
lexing) — sinon le bug se reproduit sous une autre forme.

### 5.5 Ce que ce chapitre N'EST PAS : les sous-shells interactifs (`ISubShell`)

Ne pas confondre `SubshellNode` (`( … )`, une construction du LANGAGE,
traitée ci-dessus) avec les sessions interactives imbriquées du projet
(`sqlplus`, `rman`, `sftp`, PowerShell, un shell distant poussé par
`ssh`). Celles-ci sont un système **séparé, déjà mature, extérieur à
`command-kernel`** :

```ts
// src/terminal/subshells/ISubShell.ts — DÉJÀ EXISTANT, ne pas réinventer
export interface ISubShell extends IShellBase {
  getPrompt(): string;
  handleKey(e: KeyEvent): boolean;
  processLine(line: string): SubShellResult | Promise<SubShellResult>;
  getCompletions?(line: string): string[];
  handleInput?(value: string): SubShellResult | Promise<SubShellResult>;
  dispose(): void;
}
```

Implémentations réelles : `SqlPlusSubShell`, `RmanSubShell`,
`SftpSubShell`, `CmdSubShell`, `PowerShellSubShell`,
`RemoteShellSubShell` (`src/terminal/subshells/`). `command-kernel` ne
migre PAS ce système et ne doit pas le dupliquer — si une commande
migrée a besoin de lancer un sous-shell interactif (un futur `ssh`
migré, par exemple), le point d'intégration correct est de faire pointer
`SubShellResult.childShell`/le mécanisme `ISubShell` existant depuis la
commande migrée, pas d'inventer un second système de REPL imbriqué dans
`command-kernel`.

---

## 6. Le pont de migration legacy → command-kernel

`LinuxMachine.tryCommandKernel()` est la pièce la plus délicate du
framework — toute violation de ses garanties peut soit exécuter une
commande deux fois (double effet de bord), soit exécuter silencieusement
une commande à moitié migrée.

```ts
// src/network/devices/LinuxMachine.ts (état réel, à date)
private async tryCommandKernel(trimmed: string): Promise<string | null> {
  // 1. Bail-out AVANT toute tentative — pas un repli après échec, un
  //    refus structurel de router une syntaxe jamais supportée.
  if (trimmed.includes('$(') || trimmed.includes('`')) return null;

  const { interpreter, registry } = this.getCommandKernelShell();

  // 2. Parse en PRÉ-VOL avec le Lexer/Parser du socle. Toute erreur de
  //    parsing => repli intégral, zéro exécution partielle.
  let ast;
  try { ast = new Parser().parse(new Lexer().tokenize(trimmed)); }
  catch { return null; }

  // 3. Ne route QUE si l'AST se réduit à une commande simple ou un
  //    pipeline — ; && || boucles conditions sous-shells restent
  //    intégralement sur l'ancien chemin (src/bash/ + LinuxCommandExecutor).
  if (ast.kind !== 'command' && ast.kind !== 'pipeline') return null;

  // 4. Ne route QUE si CHAQUE commande nommée est déjà enregistrée.
  const names = ast.kind === 'command' ? [ast.name] : ast.stages.map((s) => s.name);
  if (!names.every((name) => registry.has(name))) return null;

  // 5. Réplique le prélude du dispatch() legacy pour CHAQUE étage —
  //    obligatoire, voir §7. Ne jamais omettre cette ligne pour une
  //    nouvelle commande migrée.
  for (const name of names) this.executor.publishCommandExecve(name);

  const user = resolveLinuxUser(this.executor.userMgr, this.executor.userMgr.currentUser);
  const session = createSession({
    id: 'legacy-bridge', user,
    cwd: this.executor.getCwd(),
    env: this.executor.getEnvSnapshot(), // vrai environnement calculé, pas un Map figé
  });
  const chunks: string[] = [];
  const collector = { write: async (t: string) => { chunks.push(t); }, close: async () => {} };
  const io = { stdin: new PipeBuffer(), stdout: collector, stderr: collector };

  // 6. Une fois lancé, AUCUN repli sur l'ancien chemin, même en cas
  //    d'erreur venant DE L'INTÉRIEUR d'une commande migrée.
  try {
    await interpreter.interpretLine(trimmed, session, io);
  } catch (err) {
    if (err instanceof CommandNotFoundError) return null; // jamais tenté, pas un échec
    if (err instanceof ShellError) return `${err.message}\n`; // une vraie erreur, pas un repli
    throw err;
  }
  this.executor.setCwd(session.cwd); // répercute cwd/cd vers l'état legacy partagé
  return chunks.join('').replace(/\n$/, '');
}
```

**Ce qui est un refus légitime de router** (bail-out AVANT toute
exécution, étapes 1 à 4) : commande non enregistrée, syntaxe non
supportée par le Lexer/Parser du socle, construction jamais implémentée.

**Ce qui n'est PAS un refus légitime** : une commande migrée qui lève une
erreur PENDANT son exécution (étape 6). Cette erreur remonte comme une
vraie erreur, jamais un repli — sinon deux exécutions pourraient se
produire (double effet de bord filesystem, par exemple) et plus personne
ne sait ce qui est réellement fiable dans la migration.

`getCommandKernelShell()` construit paresseusement l'`Interpreter` (une
seule fois par instance de `LinuxMachine`), avec les dépendances
suivantes câblées sur les objets legacy réels — jamais de duplication :

```ts
private getCommandKernelShell(): { interpreter: Interpreter; registry: CommandRegistry } {
  if (!this.commandKernelShell) {
    const interpreter = createLinuxHostShell({
      vfs: this.executor.vfs,
      userManager: this.executor.userMgr,
      processManager: this.executor.processMgr,
      hostname: this.name,
      ports: this.getPorts(),
      getUmask: () => this.executor.getUmask(),
      powerOn: () => this.powerOn(),
      powerOff: () => this.powerOff(),
      publishFsAccess: (path, perm, syscall) => this.executor.publishAuditFsAccess(path, perm, syscall),
      publishSyscall: (syscall, path) => this.executor.publishAuditSyscall(syscall, path),
    });
    this.commandKernelShell = { interpreter, registry: interpreter.commands };
  }
  return this.commandKernelShell;
}
```

---

## 7. ⚠️ Piège critique : parité audit/privilège du prélude `dispatch()`

**Lis cette section avant de migrer QUOI QUE CE SOIT qui touche le
filesystem, un utilisateur, ou un privilège.** C'est la régression la
plus sérieuse rencontrée jusqu'ici — 25 tests cassés silencieusement,
découverts seulement en élargissant les tests localisés bien après coup,
sur une migration qui semblait pourtant déjà validée.

### 7.1 Le problème

`LinuxCommandExecutor.dispatch()` (le point d'entrée legacy) exécute un
**prélude avant son `switch`**, pour TOUTE commande :

```ts
private dispatch(cmd: string, args: string[], stdin?: string): { output: string; exitCode: number } {
  if (!cmd.startsWith('/') && !cmd.startsWith('.')) this.currentCommandHead = cmd;

  const registryPrivilege = this._registryPrivilegeHook?.(cmd);
  const privilegeDenial = registryPrivilege !== undefined
    ? evaluatePrivilegeRequirement(registryPrivilege, cmd, args, this.privilegeActor())
    : this.commandPrivileges.check(cmd, args, this.privilegeActor());
  if (privilegeDenial) return privilegeDenial;

  if (cmd.startsWith('/') || cmd.startsWith('./') || cmd.startsWith('../')) {
    // ... vérification d'exécutabilité + publishFsAccessOutcome/publishSyscallOutcome ...
  } else {
    this.publishFsAccess(`/usr/bin/${cmd}`, 'x');
    this.publishFsAccess(`/bin/${cmd}`, 'x');
    this.publishSyscall('execve', resolveExePath(cmd));
  }

  switch (cmd) {
    case 'touch': { /* publie ('w','open') PAR ARGUMENT avant d'agir */ }
    case 'chmod': { /* publie ('a','chmod') */ }
    case 'chown': { /* publie ('a','chown'), seulement pour les arguments absolus */ }
    case 'mv':    { /* publie ('w','rename') pour CHAQUE argument (source ET destination) */ }
    case 'rm':    { /* publie ('w','unlink') seulement si la cible existe */ }
    case 'ls':    { /* publie ('r') par argument, SANS syscall explicite */ }
    case 'cat':   { /* publie ('r','openat') + syscall('openat', ...) */ }
    // ...
  }
}
```

Ces appels alimentent le moteur d'audit simulé (`auditd`/`ausearch`/
`aureport`). Le pont `tryCommandKernel` **contourne `dispatch()` en
entier** — donc, sans intervention explicite, **aucune commande migrée
ne produit la moindre trace d'audit**, silencieusement. Pire : la
vérification de privilège (`commandPrivileges.check`) est AUSSI dans ce
prélude — une commande migrée pourrait échapper à une restriction
legacy si sa `PrivilegePolicy` côté command-kernel n'est pas strictement
équivalente (§3.3).

### 7.2 Comment on l'a découvert — méthode reproductible

En élargissant les tests localisés pour une phase qui semblait « n'avoir
rien à voir » (migration de commandes texte : `grep`, `sort`, `cut`...),
on a lancé, par prudence, `auditctl.test.ts`, `auditctl-other.test.ts`,
`journalization.test.ts`, `journalization-and-audit.test.ts` (480 tests
au total). Résultat : 25 échecs.

Vérification qu'il s'agit bien d'une régression et non d'un artefact —
comparaison contre un `git worktree` pointant sur le commit **juste
avant** l'existence de `command-kernel` :

```bash
git log --oneline --reverse <branche> -- src/command-kernel | head -1   # premier commit command-kernel
git worktree add /tmp/baseline-check <ce-sha>^                          # état juste avant
cd /tmp/baseline-check && npx vitest run <mêmes fichiers de test>
# 480/480 passaient => régression confirmée, pas un test flaky
git worktree remove /tmp/baseline-check --force
```

**Leçon, à appliquer systématiquement** : pour TOUTE commande qui touche
le filesystem, un utilisateur/groupe, un privilège, ou un processus,
ajoute à ton lot de tests localisés (§10) au minimum :
```
src/__tests__/unit/network-v2/auditctl.test.ts
src/__tests__/unit/network-v2/auditctl-other.test.ts
src/__tests__/unit/network-v2/journalization.test.ts
src/__tests__/unit/network-v2/journalization-and-audit.test.ts
src/__tests__/unit/network-v2/command-privilege-policy.test.ts
```
Principe général, pas juste cette liste figée : **si legacy fait quelque
chose « en plus » de l'opération elle-même (log, audit, effet de bord
sur un compteur global, notification), le pont doit le reproduire — et
les tests qui vérifient cet effet de bord doivent être dans ton lot
localisé, même si tu es sûr que ta commande « n'a rien à voir avec
l'audit ».**

### 7.3 Le fix — à répliquer pour toute nouvelle commande sensible

`MachineApi` porte une capacité **optionnelle** :

```ts
// machine/types.ts
export interface AuditApi {
  fsAccess(path: string, perm: "r" | "w" | "x" | "a", syscall?: string): void;
  syscall(name: string, path?: string): void;
}
export interface MachineApi {
  readonly fs: FileSystemApi; readonly proc: ProcessApi; readonly net: NetworkApi;
  readonly users: UserManagementApi; readonly groups: GroupManagementApi;
  readonly power: PowerApi; readonly hostname: string;
  readonly audit?: AuditApi;   // optionnelle — un équipement sans auditd ne l'implémente pas
  now(): Date;
}
```

Câblage Linux (`LinuxMachineApiDeps` + `LinuxAuditApi`), sur les
wrappers publics déjà existants — **jamais dupliquer la logique
d'audit, ces wrappers existaient avant `command-kernel`** :

```ts
class LinuxAuditApi implements AuditApi {
  constructor(private readonly deps: Pick<LinuxMachineApiDeps, 'publishFsAccess' | 'publishSyscall'>) {}
  fsAccess(path: string, perm: 'r' | 'w' | 'x' | 'a', syscall?: string): void { this.deps.publishFsAccess(path, perm, syscall); }
  syscall(name: string, path?: string): void { this.deps.publishSyscall(name, path); }
}
```

Nouveau `LinuxCommandExecutor.publishCommandExecve(cmd)` — réplique
EXACTEMENT le prélude de `dispatch()` :

```ts
publishCommandExecve(cmd: string): void {
  this.currentCommandHead = cmd;
  this.publishFsAccess(`/usr/bin/${cmd}`, 'x');
  this.publishFsAccess(`/bin/${cmd}`, 'x');
  this.publishSyscall('execve', resolveExePath(cmd));
}
```

Appelé par le pont pour **chaque étage d'un pipeline**, pas seulement la
première commande (§6, étape 5).

### 7.4 Ordre des opérations — publier APRÈS succès, jamais avant

Chaque commande fichier migrée publie l'événement correspondant, à
l'identique de son `case` legacy, **après** l'opération réussie :

```ts
// Chmod.ts — pattern correct
await ctx.machine.fs.chmod(path, mode, actor);   // 1. l'opération d'abord
ctx.machine.audit?.fsAccess(path, 'a', 'chmod'); // 2. l'audit seulement si elle a réussi
ctx.machine.audit?.syscall('chmod', path);
```

Publier AVANT (`ctx.machine.audit?.fsAccess(...)` puis `await
ctx.machine.fs.chmod(...)`) produit une entrée d'audit même quand
l'opération échoue ensuite — constaté concrètement sur `touch` vers un
montage read-only : le test attendait explicitement qu'AUCUNE entrée
n'apparaisse dans le log, et une régression a été introduite puis
corrigée sur ce point précis pendant cette même migration.

### 7.5 Piège dans le piège : `writeFile()` générique vs `touch()` dédié

`touch` a d'abord été implémenté via `ctx.machine.fs.writeFile(path, '',
actor, alreadyExists)` — ça semblait correct (l'audit apparaissait bien
dans les logs). Mais un test d'exclusion de règle
(`auditctl -a never,exit -F dir=/tmp`) a ensuite échoué : `touch
/tmp/fichier` générait quand même une entrée, malgré la règle
d'exclusion. Cause racine : `LinuxAuditRules` a un mécanisme SÉPARÉ,
bas niveau, attaché directement aux règles `-w PATH` :

```ts
// LinuxAuditRules.ts — mécanisme indépendant de publishFsAccess/onAccess,
// ne respecte PAS isExcludedByNeverDir()
const unsub = this.vfs.onWrite(path, () => this.fire('open', path, key));
```

`vfs.onWrite()` réagit à **tout appel à `vfs.writeFile()`** sur un
chemin surveillé, quel que soit l'appelant — mais PAS à `vfs.touch()`.
Legacy's `cmdTouch` appelait déjà `ctx.vfs.touch(...)`, jamais
`vfs.writeFile(...)` — ce n'était donc pas un bug de `command-kernel` au
sens strict, mais une divergence d'API introduite en choisissant la
mauvaise méthode VFS pour reproduire `touch`. Fix : ajout de
`FileSystemApi.touch()` (§3.4) implémenté via `vfs.touch()`, jamais
`vfs.writeFile()`.

**Leçon générale, au-delà de ce cas précis** : quand tu migres une
commande, **vérifie quelle méthode VFS (ou plus généralement, quelle
méthode de l'objet legacy réel) elle appelle EXACTEMENT** — ne suppose
jamais qu'un chemin générique équivalent en apparence produit le même
comportement. Un hook bas niveau attaché à une méthode précise peut
dépendre de cette précision.

---

## 8. Chevauchement avec l'autre framework de migration (`LinuxCommand`)

Avant de migrer une commande vers `command-kernel`, vérifie si elle
n'est pas DÉJÀ migrée vers l'autre système existant,
`src/network/devices/linux/commands/` (`LinuxCommand`, dans
`LinuxCommandRegistry`, invoqué via `LinuxMachine.tryNetworkCommand()`
avec sa propre re-application du privilège — voir le commentaire dans
`tryNetworkCommand()` : *"A registry command bypasses
LinuxCommandExecutor's dispatch(), so the declarative privilege gate ...
must be re-applied here explicitly"*).

Ce framework couvre déjà une grande partie de : réseau (`ip`, `ifconfig`,
`iptables`, `nmap`, `ping`…), IAM avancé (`useradd`, `usermod`, `passwd`,
`chage`, `gpasswd`…), matériel (`lspci`, `lsblk`, `dmidecode`…), audit
(`auditctl`, `ausearch`), systemd/services, DNS.

**`chown`/`chgrp` existent dans les DEUX frameworks simultanément** —
vérifié : le `case 'chown':` du switch legacy (`dispatch()`) reste
actuellement la voie réellement empruntée en pratique (le pont
`command-kernel` shadowait silencieusement `commands/fs/Chown.ts` sans
que ce dernier soit jamais invoqué — un des symptômes du piège §7). Ne
jamais supposer qu'une commande absente d'un grep rapide sur
`command-kernel/commands/` n'est migrée nulle part — vérifie aussi
`src/network/devices/linux/commands/`.

---

## 9. Conventions de code de sortie (`ExitCode`)

| Plage | Signification | Classe / constante |
|---|---|---|
| `0` | succès | `EXIT_OK` |
| `1` | échec générique métier | retour direct de `execute()` |
| `2` | erreur d'usage / argument | `UsageError` (`errors.ts`) |
| `126` | droits insuffisants | `PermissionError` |
| `127` | commande introuvable | `CommandNotFoundError` (déclenche le repli du pont, §6) |
| `128+n` | terminé par un signal `n` | réservé, ne pas utiliser pour une erreur métier |

Toute nouvelle erreur métier propre à une commande doit être une
sous-classe de `ShellError` (`errors.ts`) avec un `exitCode` explicite —
jamais une exception native (`Error`/`TypeError`) qui remonterait telle
quelle jusqu'à `Executor.runSimple`.

`FileSystemError` (`code: FileSystemErrorCode` — `ENOENT`, `EACCES`,
`ENOTDIR`, `EISDIR`, `EEXIST`, `ENOTEMPTY`) est le vocabulaire attendu
pour toute erreur filesystem ; une commande qui veut distinguer un cas
précis (ex : `rm -f` qui avale silencieusement un `ENOENT`) teste
`err.code`, jamais le texte du message.

---

## 10. Discipline de test — LOCALISÉ uniquement

Le projet a plus de 16 000 scénarios de test. **Ne jamais lancer la
suite complète** — ni par `npm run test:run`, ni par un motif trop large.

### 10.1 Procédure

1. Identifie les fichiers qui exercent la commande/le sous-système :
   ```bash
   grep -rl "'nom_commande" src/__tests__/unit/network-v2/
   ```
2. Ajoute systématiquement, dès que la commande touche filesystem/
   utilisateur/privilège/processus, le lot du §7.2.
3. Lance de façon ciblée :
   ```bash
   npx vitest run src/__tests__/unit/network-v2/fichier1.test.ts src/__tests__/unit/network-v2/fichier2.test.ts
   ```
4. Le critère de succès n'est PAS « mes nouveaux tests passent » — il
   n'y a pas de nouveaux tests à écrire (§3.1, étape 8). Le critère est
   : **les tests déjà présents dans le projet passent**, en mode
   localisé.
5. En cas de doute sur l'impact réel d'un changement, compare contre la
   baseline pré-migration avec un `git worktree` (§7.2) plutôt que de
   supposer.
6. Typecheck ciblé systématique avant tout commit :
   ```bash
   npx tsc --noEmit -p tsconfig.app.json --ignoreDeprecations 5.0 \
     2>&1 | grep -iE "command-kernel|LinuxMachine"
   ```
7. Lint ciblé :
   ```bash
   npx eslint src/command-kernel src/network/devices/linux/command-kernel
   ```

### 10.2 Catégories à couvrir pour toute commande touchée (dans les tests déjà existants, pas de nouveaux à écrire)

- cas nominal simple ;
- cas avec options combinées (clusters courts, valeurs collées) ;
- cas d'erreur de droits (`PrivilegeLevel` insuffisant) ;
- cas d'erreur d'argument (`UsageError`) ;
- comportement en pipeline (si la commande produit ou consomme du
  texte — vérifier en particulier le traitement du saut de ligne final,
  voir `textInput.ts`/`splitLines`/`joinLines`, piège récurrent) ;
- comportement en sous-shell si la commande modifie `cwd` ou des
  variables (isolation, §5.2) ;
- **effets de bord d'audit/privilège** (§7) — jamais optionnel dès que
  la commande touche filesystem/utilisateur/processus.

---

## 11. Discipline Git

- Développe sur la branche de travail assignée pour la session — jamais
  sur une autre branche (notamment `mandeng`) sauf instruction explicite
  et récente de l'utilisateur pour CETTE action précise.
- **Un push = une fonctionnalité complète et testée.** Pas de push
  intermédiaire avec un correctif à moitié fini.
- Aucun commentaire dans le code livré — les noms d'identifiants portent
  le sens. Un commentaire n'est acceptable que pour une contrainte non
  évidente et non déductible du code (ex : pourquoi `endChar` doit être
  `undefined` et pas `1` par défaut dans `parseSortKey`, ou pourquoi
  `ESCAPED_DOLLAR` doit être un caractère sentinelle plutôt qu'un simple
  retrait du backslash).
- `CHANGELOG.md` mis à jour à CHAQUE push : ce qui est migré, les bugs
  trouvés puis corrigés en testant contre la suite existante (avec la
  cause racine, pas juste le symptôme — voir le style des entrées
  « Bugs trouvés puis corrigés » déjà présentes), ce qui reste
  explicitement hors périmètre.
- Jamais de `git reset --hard`/`push --force` sans autorisation explicite
  et récente de l'utilisateur pour CETTE action précise.
- Jamais de `--no-verify` pour contourner un hook qui échoue — corriger
  la cause, pas le symptôme du hook.

---

## 12. État de la migration (résumé — voir `CHANGELOG.md` pour le détail complet)

### Migré vers `command-kernel`, avec parité audit/privilège vérifiée

- **Session/filesystem de base** : `pwd`, `cd`, `ls`, `cat`, `mkdir`,
  `touch`, `rm`, `cp`, `mv`, `stat`, `chmod`, `chown`.
- **Traitement de texte** : `grep`, `head`, `tail`, `wc`, `sort`, `cut`,
  `uniq`, `tr`.
- **Universel** (tout équipement, `registerCoreCommands`) : `echo`,
  `exit`.

### Explicitement hors périmètre (reste sur `LinuxCommand`/legacy — voir §8)

- Réseau avancé, IAM avancé, matériel, audit (`auditctl` lui-même, pas
  ses effets), systemd — déjà largement couverts par
  `src/network/devices/linux/commands/{net,iam,hw,audit,system}/`.
- `umask` : lu dynamiquement depuis `LinuxCommandExecutor`, mais aucune
  commande `umask` n'est migrée pour le modifier depuis command-kernel.

### Avant de choisir la prochaine commande à migrer

1. Vérifie si elle existe déjà sous `src/network/devices/linux/commands/`
   (§8). Si oui, ne la migre pas une deuxième fois sans discussion
   explicite — décide plutôt s'il faut la déplacer ou la laisser là.
2. Vérifie ses effets de bord réels dans `LinuxCommandExecutor.dispatch()`
   (audit, privilège, formats d'erreur exacts) — §7.
3. Repère tous les fichiers de test qui l'exercent, y compris
   indirectement (audit, privilège, scénarios croisés SSH/sudo/cron).
4. Migre, teste en localisé (§10), documente (`CHANGELOG.md`), commit +
   push (§11).

---

## 13. Checklist de revue avant push (à cocher systématiquement)

- [ ] La commande ne contourne `MachineApi` nulle part (§0.1).
- [ ] Aucune logique de sécurité codée en dur hors `PrivilegePolicy` (§0.2, §3.3).
- [ ] Aucune exception native non convertie en `ShellError` (§9).
- [ ] Aucun `console.log` — tout passe par `ctx.io` (§0.5).
- [ ] Vérifié que la commande n'est pas déjà migrée sous
      `src/network/devices/linux/commands/` (§8).
- [ ] Effets de bord audit/privilège répliqués, APRÈS l'opération
      réussie, pas avant (§7.3, §7.4).
- [ ] Vérifié que la méthode VFS/legacy appelée est EXACTEMENT la même
      que celle du code legacy, pas une méthode générique d'apparence
      équivalente (§7.5).
- [ ] Tests localisés lancés, lot audit/privilège inclus (§7.2, §10.1).
- [ ] Typecheck ciblé et lint ciblé passés (§10.1).
- [ ] Aucune duplication introduite (recherche croisée avant push).
- [ ] Aucun commentaire laissé dans le code livré (§11).
- [ ] `CHANGELOG.md` mis à jour avec une entrée descriptive (cause
      racine des bugs trouvés, pas juste le symptôme) (§11).
- [ ] Un seul push, correspondant à une fonctionnalité complète (§11).
- [ ] Commande de traitement de texte : réutilise
      `command/text-input.ts` du socle, jamais une redéfinition locale
      (§14.3).
- [ ] Commande interactive (mot de passe, GECOS, confirmation) : passe par
      `requireInteraction()`/`ctx.io.interaction`, gère `null` (Ctrl+C/EOF)
      comme un abandon propre, et sa migration supprime le flux
      `LinuxFlowBuilder` legacy correspondant (§14.4).
- [ ] Commande à sortie continue (suivi, sonde réseau) : écrit sur
      `ctx.io.stdout` au fil de l'eau, s'arrête sur `ctx.signal.aborted`,
      et sa migration supprime l'intercepteur `tryStartXxx` de la session
      ET son parsing dupliqué (§14.6).

---

## 14. Buffers d'entrée/sortie et interactions utilisateur

Origine : `docs/PROPOSAL-command-kernel-io-buffers.md` (constats §1.1–§1.9,
propositions P1–P8). Cette section codifie ce qui a été retenu et
implémenté dans le socle — toute nouvelle commande migrée s'appuie sur ces
contrats, jamais sur des suppositions.

### 14.1 Invariants du contrat de flux (`io/types.ts`)

1. **`string` uniquement, jamais binaire.** Les flux transportent du texte
   UTF-16 JS. Une commande qui aurait besoin de simuler un contenu binaire
   (`xxd`, `base64 -d` vers un vrai binaire…) doit d'abord faire l'objet
   d'une discussion explicite — jamais encoder des octets dans une `string`
   par convention informelle.
2. **`read()` ne renvoie jamais `""` pour dire « rien pour l'instant ».**
   Il renvoie le prochain chunk disponible, ou `null` quand plus rien n'est
   disponible. Aucun appelant ne doit boucler en attente active sur ce
   contrat — si un besoin d'attente réelle apparaît un jour (`tail -f`),
   il passera par les primitives de `src/events/` (`Signal`), pas par du
   polling sur `read()`.
3. **Pipelines séquentiels, flux bornés.** Les étages d'un pipeline
   s'exécutent l'un après l'autre : le producteur termine avant que le
   consommateur ne démarre (`Executor.runPipeline`, §5.3). Une commande à
   flux non borné (générateur infini façon `yes`) est **hors périmètre**
   de ce modèle — la migrer exige d'abord de faire évoluer ce modèle,
   chantier à discuter explicitement. `PipeBuffer` porte un garde-fou de
   capacité (`PIPE_CAPACITY_DEFAULT`, 8 M caractères) qui transforme une
   dérive mémoire silencieuse en `PipeCapacityError` explicite.

### 14.2 Erreurs I/O — toujours des `ShellError` (§9 s'applique)

| Situation | Erreur | Exit code |
|---|---|---|
| écriture vers un pipe fermé | `BrokenPipeError` | 141 (= 128 + SIGPIPE) |
| dépassement de capacité d'un pipe | `PipeCapacityError` | 1 |
| saisie interactive sans canal disponible | `InteractionUnavailableError` | 1 |
| interruption par Ctrl+C (`ctx.signal`) | retour direct | `EXIT_INTERRUPTED` (130) |

Les constantes `EXIT_INTERRUPTED`/`EXIT_BROKEN_PIPE` vivent dans
`command/types.ts`. Toute commande dont `execute()` contient une boucle non
bornée (lecture répétée, attente d'événement) doit vérifier
`ctx.signal.aborted` à chaque itération et retourner `EXIT_INTERRUPTED` —
la couche I/O ne le fait pas à sa place.

### 14.3 Lecture texte partagée (`command/text-input.ts`)

`splitLines`/`joinLines`/`readTextInput`/`readPerFileInputs` vivent dans
**le socle** (`src/command-kernel/command/text-input.ts`) — le module Linux
historique (`linux/command-kernel/commands/textInput.ts`) n'est plus qu'un
ré-export de compatibilité. Toute commande de traitement de texte, quel que
soit le vendeur, réutilise ce module : le motif « stdin si aucun fichier,
sinon chaque fichier, en préservant l'absence de saut de ligne final » ne
se réécrit jamais localement (piège récurrent du saut de ligne final,
§10.2).

### 14.4 Dialogues interactifs : `CommandIO.interaction`

Le canal `interaction?: InteractionChannel` (`io/interaction.ts`) est le
**terminal de contrôle** d'une commande — la voie officielle pour tout
dialogue en cours d'exécution : mot de passe masqué, champs GECOS,
confirmation `[Y/n]`. À la différence de `stdin` (un flux de données
redirigeable), il représente l'humain derrière le terminal et survit aux
pipes et redirections (l'`Executor` le propage à chaque étage).

```ts
// Commande interactive — pattern canonique
const ui = requireInteraction(ctx.io, 'passwd'); // ShellError propre si absent
const current = await ui.prompt({ kind: 'secret', prompt: 'Current password: ' });
if (current === null) return 1; // EOF / Ctrl+D = abandon, jamais une boucle
const fullName = await ui.prompt({ kind: 'text', prompt: '\tFull Name []: ', allowEmpty: true });
const ok = await ui.prompt({ kind: 'confirm', prompt: 'Is the information correct? [Y/n] ', defaultValue: 'Y' });
```

Règles :

1. **Le canal est optionnel.** Présent quand l'IO vient d'un
   `Terminal.asCommandIO()` (câblé sur `readLine`/`readSecret`) ou d'un
   hôte qui fournit un `InteractionBroker`. Absent sur un pipe de test, un
   script, ou le pont legacy actuel — `requireInteraction()` convertit
   cette absence en `InteractionUnavailableError` (jamais un blocage ni une
   `Error` native).
2. **`InteractionBroker` est l'adaptateur pause/reprise.** Il réconcilie le
   modèle « `execute()` déroulé jusqu'au bout » avec les hôtes pilotés par
   l'UI (le pattern `InteractiveFlowEngine.advance()` de
   `src/terminal/core/InteractiveFlow.ts`) : la commande `await`e
   `prompt()`, le broker remet un `PromptRequest {spec, respond}` à l'hôte,
   et l'exécution reste réellement suspendue jusqu'au `respond(saisie)` —
   sans polling, sans file d'attente, sans réécrire la commande en machine
   à états.
3. **`command-kernel` ne réimplémente PAS `InteractiveFlowEngine`.** Le
   moteur de flux UI (directives, validation/retry, rendu des prompts)
   reste le système mature de `src/terminal/` (même statut que `ISubShell`,
   §5.5). Le broker est le point de rencontre : côté session, un
   `PromptRequest` se traduit en directive d'input existante
   (`PasswordDirective`/`TextPromptDirective`/`ConfirmationDirective`) et
   la saisie remonte par `respond()`.
4. **Le pont interactif est câblé sur le chemin terminal.** La chaîne
   réelle, sans nouveau mécanisme inventé — chaque maillon existait déjà :

   ```
   TerminalSession (UI, inputMode password/interactive-text, Ctrl+C)
      └─ SessionInputHost (requestInput/submitPending/cancelPending)
           └─ PromiseInputBroker (Promise résolue à la saisie)
                └─ createKernelInteraction(broker)        (src/shell/input/kernelInteraction.ts)
                     └─ CommandKernelChannel.interaction
                          └─ LinuxBashShell.dispatch → executeCommandInSession(line, session, channel)
                               └─ tryCommandKernel → ctx.io.interaction  (la commande await prompt())
   ```

   Un `await ui.prompt(...)` dans une commande migrée suspend réellement
   l'exécution jusqu'à la saisie ; Ctrl+C/Ctrl+D pendant le prompt passe
   par `SessionInputHost.cancelPending()` → le broker résout `cancelled` →
   `prompt()` renvoie `null` → la commande abandonne proprement. Les
   commandes dialoguantes (`passwd`, `chfn`…) sont donc **migrables** —
   chacune reste son propre chantier (§3, §7, parité stricte avec le flux
   legacy `LinuxFlowBuilder` correspondant, qui n'est supprimé qu'avec la
   migration de sa commande). Deux chemins restent SANS canal, par
   construction : `runCommandKernelResolved` (commande invoquée depuis un
   script bash — un script n'a pas de tty à offrir) et les appels
   programmatiques `executeCommand()`/`executeCommandInSession()` sans
   `channel` (tests, SSH exec) — `requireInteraction()` y échoue proprement.

### 14.5 Point d'extension réservé : redirections `stderr`

`RedirectionNode.fd?: "stdout" | "stderr"` existe dans l'AST (absent =
`stdout`, comportement inchangé) mais **aucun token du Lexer ne le produit
encore** : `2>`/`2>&1`/heredoc restent non supportés, par choix (§3.5 — pas
de complexité par anticipation). Le jour où une commande migrée en a
réellement besoin, le travail commence par le Lexer/Parser et un nouveau
lot de tests localisés — pas par un contournement dans la commande.

### 14.6 Canal hôte unifié : `CommandKernelChannel` — un seul chemin pour toutes les natures de commandes

`io/channel.ts` définit LE contrat standard entre un hôte de terminal et le
pont d'un équipement :

```ts
export interface CommandKernelChannel {
  readonly interaction?: InteractionChannel;      // dialogues (§14.4)
  readonly onOutput?: (chunk: string) => void;    // sortie en flux continu
  readonly signal?: AbortSignal;                  // Ctrl+C de l'hôte
}
```

Il est plombé de bout en bout : `executeCommandInSession(line, session,
channel)` → `executeCommand` → `tryCommandKernel` → `buildCommandKernelIO`
(chaque `write` d'une commande part en temps réel vers `channel.onOutput`
tout en restant collecté pour l'appelant) et `interpretLine(...,
channel.signal)` → `ctx.signal`.

**Objectif de convergence** : les commandes « qui tiennent le terminal »
(`ping`, `traceroute`, `mtr`, `tcpdump`, `watch`, suivis `-f`…) passent
aujourd'hui par des intercepteurs dédiés dans `LinuxTerminalSession`
(`tryStartPingStream`, `tryStartTracerouteStream`, `tryStartTcpdump`…),
chacun avec son propre parsing d'arguments et son propre couplage
session↔device. Ce sont des **chemins legacy à éteindre** : la cible est
qu'une commande à sortie continue soit une commande command-kernel comme
les autres — même registre, même `PrivilegePolicy`, même `ArgumentParser` —
qui écrit sur `ctx.io.stdout` au fil de l'eau (l'hôte la voit vivre via
`onOutput`) et s'arrête sur `ctx.signal.aborted` (Ctrl+C).

Recette de migration d'un intercepteur (une commande = un chantier = un
push, jamais un lot) :

1. Exposer la capacité temps réel manquante comme extension **optionnelle**
   de `MachineApi` (§3.4), déléguant au moteur réseau réel de l'équipement
   (§2.2 — ex : le moteur ICMP que `pingStreamInSession` enveloppe déjà),
   jamais une seconde implémentation du protocole.
2. Écrire la commande kernel : parsing via le descripteur, sortie via
   `ctx.io.stdout.write()` ligne à ligne, arrêt via `ctx.signal.aborted`,
   statistiques finales émises aussi sur interruption (comportement `ping`
   réel).
3. Supprimer l'intercepteur `tryStartXxx` de la session ET le parsing
   d'arguments dupliqué qu'il portait — la session n'a plus qu'à router la
   ligne comme n'importe quelle commande, avec un `channel` branché sur sa
   machinerie de job de premier plan existante (`startAsyncCommand` :
   `ctx.sink` ↔ `onOutput`, `ctx.onCancel` ↔ `signal`).
4. Parité de sortie stricte contre les tests existants de la commande
   (§10) — les formats de ligne (`64 bytes from…`, en-têtes, stats) sont
   massivement testés.
