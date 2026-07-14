/**
 * =====================================================================
 *  ARCHITECTURE — INTERPRÉTEUR DE COMMANDES D'UNE MACHINE (command-kernel)
 * =====================================================================
 *
 *  Socle d'interpréteur de commandes indépendant du vendeur, destiné à
 *  remplacer progressivement les implémentations ad hoc de src/bash,
 *  src/powershell et des shells Cisco/Huawei (src/network/devices/shells)
 *  une fois la migration engagée. Ce module ne dépend d'aucun code
 *  existant du projet : chaque équipement se branchera dessus via une
 *  implémentation de `MachineApi`.
 *
 *  Vue d'ensemble des couches :
 *
 *    Utilisateur
 *       │  (frappe clavier / écran)
 *       ▼
 *    Terminal (périphérique : lecture de ligne, écho, Ctrl+C, affichage)
 *       │
 *       ▼
 *    Shell (boucle REPL : prompt, historique, session, exit)
 *       │  (ligne de commande ou script)
 *       ▼
 *    Interpreter ──> Lexer ──> Parser ──> AST (ScriptNode)
 *       │
 *       ▼
 *    Executor ──> CommandRegistry.resolve(name)
 *       │              │
 *       │              ▼
 *       │         ICommand (descriptor + execute)
 *       │              │
 *       ├── PermissionGuard (vérifie descriptor.privileges)
 *       ├── ArgumentParser (argv brut -> ParsedArgs typés)
 *       ▼
 *    command.execute(CommandContext) ──> MachineApi (méthodes internes)
 *
 *  Patrons utilisés :
 *   - Command        : chaque commande est un objet autonome (ICommand)
 *   - Registry       : enregistrement/résolution dynamique (plugins)
 *   - Facade         : MachineApi expose les méthodes internes de la machine
 *   - Interpreter    : AST évalué récursivement (pipes, &&, ||, if, for…)
 *   - Template Method: BaseCommand impose le cycle autorize→parse→validate→execute
 *   - Strategy       : PrivilegePolicy interchangeable, portée par la commande
 *   - Adapter        : Terminal.asCommandIO() branche le périphérique sur l'Executor
 *   - REPL           : Shell = boucle lecture → évaluation → affichage sur un Terminal
 * =====================================================================
 */

// 1. Utilisateurs, sessions & privilèges
export * from "./session/types";
export * from "./session/privilege-policy";

// 2. Flux d'entrée/sortie
export * from "./io/types";
export * from "./io/pipe-buffer";
export * from "./io/file-output-stream";
export * from "./io/interaction";
export * from "./io/channel";

// 3. Façade des méthodes internes de la machine
export * from "./machine/types";

// 4. Spécification & parsing des arguments
export * from "./args/types";
export * from "./args/parsed-args";
export * from "./args/argument-parser";

// 5. La commande
export * from "./command/types";
export * from "./command/base-command";
export * from "./command/text-input";

// 6. Registre de commandes
export * from "./registry/command-registry";

// 7. Lexer / Parser / AST
export * from "./ast/tokens";
export * from "./ast/nodes";
export * from "./ast/lexer";
export * from "./ast/parser";
export * from "./ast/expander";

// 8. Erreurs à codes de sortie
export * from "./errors";

// 9. Garde de privilèges & exécuteur
export * from "./exec/permission-guard";
export * from "./exec/executor";

// 10. Interpréteur
export * from "./interpreter";

// 11. Terminal
export * from "./terminal/types";
export * from "./terminal/terminal";
export * from "./terminal/virtual-terminal";

// 12. Shell
export * from "./shell/history";
export * from "./shell/prompt-builder";
export * from "./shell/exit";
export * from "./shell/shell";

// 13. Commandes d'exemple développées "à part"
export * from "./commands/cat-command";
export * from "./commands/echo-command";
export * from "./commands/shutdown-command";
export * from "./register-core-commands";

// 14. Amorçage
export * from "./bootstrap";
