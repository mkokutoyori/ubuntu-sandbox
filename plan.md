# Plan — Refactoring Terminal Session & Interactive Step Architecture

## Problème

La vue (`TerminalView`) gère trop de logique : parsing ANSI, gestion de focus entre 4 inputs, interprétation des modes, manipulation directe des buffers. Les shells retournent des `string` bruts et c'est la vue qui doit deviner le comportement à adopter. Les interactive steps (password, confirmations, wizards) sont codés en dur dans `LinuxTerminalSession` sans possibilité d'extension aux autres vendors.

## Vision

**Principe fondamental : la vue est BÊTE.** Elle reçoit des objets typés (`TerminalResponse`) qui lui disent exactement quoi afficher et quel type d'input demander. Elle ne fait AUCUNE interprétation. Toute la logique vit côté modèle.

---

## Architecture proposée

### 1. `TerminalResponse` — Le contrat unifié

Chaque interaction du terminal produit un `TerminalResponse` : un objet riche qui remplace les strings bruts.

**Fichier : `src/terminal/core/types.ts`**

```typescript
/** Segment of styled text within a line */
interface TextSegment {
  text: string;
  style?: TextStyle;
}

interface TextStyle {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
}

/** A single output line, pre-parsed and ready to render */
interface OutputLine {
  id: number;
  segments: TextSegment[];   // pre-parsed, no ANSI in the view
  lineType: LineType;
}

type LineType = 'output' | 'error' | 'warning' | 'prompt' | 'info' | 'boot' | 'system';

/** What the view should display and how it should collect input */
interface TerminalResponse {
  /** Lines to append to terminal output */
  lines: OutputLine[];

  /** Next input directive — tells the view what to render */
  inputDirective: InputDirective;

  /** Optional: should the view scroll to bottom */
  scrollToBottom: boolean;

  /** Optional: should the view clear the screen first */
  clearScreen: boolean;

  /** Optional: sound/visual bell */
  bell: boolean;
}
```

### 2. `InputDirective` — Ce que la vue doit demander à l'utilisateur

Remplace l'actuel `InputMode` plat par un objet riche qui porte TOUT le contexte nécessaire.

```typescript
/** Base for all input directives */
interface BaseInputDirective {
  type: InputDirectiveType;
}

type InputDirectiveType =
  | 'command'         // normal command input
  | 'password'        // hidden input
  | 'text-prompt'     // visible prompted input
  | 'confirmation'    // Y/N choice
  | 'choice'          // selection from options
  | 'pager'           // paged output navigation
  | 'editor'          // full-screen editor overlay
  | 'blocked'         // no input allowed (booting, processing)
  | 'reverse-search'; // bash Ctrl+R

/** Normal command input */
interface CommandDirective extends BaseInputDirective {
  type: 'command';
  prompt: string;               // "user@host:~$" or "Router#"
  promptStyle?: TextStyle;      // color the prompt
  completionHint?: string;      // ghost text for tab completion
}

/** Password/hidden input */
interface PasswordDirective extends BaseInputDirective {
  type: 'password';
  prompt: string;               // "[sudo] password for user:"
  mask: 'hidden' | 'dots' | 'asterisks';  // how to mask
  maxAttempts?: number;
  attemptsRemaining?: number;
}

/** Visible text prompt (GECOS fields, etc.) */
interface TextPromptDirective extends BaseInputDirective {
  type: 'text-prompt';
  prompt: string;               // "Full Name []:"
  defaultValue?: string;        // pre-filled value
  allowEmpty: boolean;          // can the user just press Enter?
  validation?: InputValidation;
}

/** Y/N confirmation */
interface ConfirmationDirective extends BaseInputDirective {
  type: 'confirmation';
  prompt: string;               // "Is the information correct? [Y/n]"
  defaultAnswer?: 'yes' | 'no';
}

/** Selection from options (future: menu-driven interfaces) */
interface ChoiceDirective extends BaseInputDirective {
  type: 'choice';
  prompt: string;
  options: { key: string; label: string }[];
}

/** Pager for long output */
interface PagerDirective extends BaseInputDirective {
  type: 'pager';
  indicator: string;            // " --More-- " or "  ---- More ----"
  progress?: number;            // 0-100 percentage
  controls: PagerControls;
}

interface PagerControls {
  nextPage: string;    // "Space"
  nextLine: string;    // "Enter"
  quit: string;        // "q"
  search?: string;     // "/" for Cisco
}

/** Full-screen editor */
interface EditorDirective extends BaseInputDirective {
  type: 'editor';
  editorType: 'nano' | 'vim';
  filePath: string;
  absolutePath: string;
  content: string;
  isNewFile: boolean;
}

/** Input blocked (booting, long-running command) */
interface BlockedDirective extends BaseInputDirective {
  type: 'blocked';
  reason: 'booting' | 'processing' | 'connecting';
  statusMessage?: string;       // "Loading..." text
  progress?: number;            // optional progress bar
  cancellable: boolean;         // can Ctrl+C cancel?
}

/** Reverse search mode */
interface ReverseSearchDirective extends BaseInputDirective {
  type: 'reverse-search';
  query: string;
  matchedCommand?: string;
  matchIndex?: number;
}

type InputDirective =
  | CommandDirective
  | PasswordDirective
  | TextPromptDirective
  | ConfirmationDirective
  | ChoiceDirective
  | PagerDirective
  | EditorDirective
  | BlockedDirective
  | ReverseSearchDirective;

/** Validation rules for text prompts */
interface InputValidation {
  pattern?: RegExp;
  minLength?: number;
  maxLength?: number;
  errorMessage?: string;
}
```

### 3. `InteractiveFlow` — Le moteur de steps généralisé

Remplace le `InteractiveState` codé en dur de Linux. C'est un **mini state machine** réutilisable par tous les vendors.

**Fichier : `src/terminal/core/InteractiveFlow.ts`**

```typescript
/** A single step in an interactive flow */
interface InteractiveStep {
  type: 'password' | 'text' | 'confirmation' | 'choice' | 'output' | 'execute' | 'branch';

  /** For input steps: builds the InputDirective */
  directive?: Omit<InputDirective, 'type'>;

  /** For output steps: lines to display */
  outputLines?: OutputLine[];

  /** For execute steps: async action to run */
  action?: (context: FlowContext) => Promise<void>;

  /** For branch steps: decides which step to jump to */
  predicate?: (context: FlowContext) => number; // returns step index

  /** Key to store the user's input in the context */
  storeAs?: string;

  /** Validation for input steps */
  validation?: (value: string, context: FlowContext) => ValidationResult;
}

interface ValidationResult {
  valid: boolean;
  errorMessage?: string;
  /** If valid:false, how many times can we retry before aborting */
  retriesLeft?: number;
}

/** Shared context across all steps of a flow */
interface FlowContext {
  /** Collected values from input steps, keyed by storeAs */
  values: Map<string, string>;

  /** The device being operated on */
  device: Equipment;

  /** Current user context */
  currentUser: string;

  /** Arbitrary metadata */
  metadata: Map<string, unknown>;
}

/** Abstract flow engine that processes steps sequentially */
abstract class InteractiveFlowEngine {
  private steps: InteractiveStep[];
  private currentIndex: number = 0;
  private context: FlowContext;
  private retryCount: number = 0;

  constructor(steps: InteractiveStep[], context: FlowContext) {
    this.steps = steps;
    this.context = context;
  }

  /** Process steps until we hit an input step or finish */
  async advance(userInput?: string): Promise<TerminalResponse> {
    // If we have user input, validate and store it
    if (userInput !== undefined && this.currentStep) {
      const validation = this.currentStep.validation?.(userInput, this.context);
      if (validation && !validation.valid) {
        this.retryCount++;
        if (validation.retriesLeft !== undefined && this.retryCount > validation.retriesLeft) {
          return this.abort(validation.errorMessage);
        }
        return this.buildRetryResponse(validation.errorMessage);
      }
      if (this.currentStep.storeAs) {
        this.context.values.set(this.currentStep.storeAs, userInput);
      }
      this.currentIndex++;
      this.retryCount = 0;
    }

    // Process non-input steps automatically
    const accumulatedLines: OutputLine[] = [];
    while (this.currentIndex < this.steps.length) {
      const step = this.steps[this.currentIndex];

      switch (step.type) {
        case 'output':
          accumulatedLines.push(...(step.outputLines ?? []));
          this.currentIndex++;
          break;

        case 'execute':
          await step.action?.(this.context);
          this.currentIndex++;
          break;

        case 'branch':
          this.currentIndex = step.predicate?.(this.context) ?? this.currentIndex + 1;
          break;

        case 'password':
        case 'text':
        case 'confirmation':
        case 'choice':
          // Input step — pause and ask the view
          return {
            lines: accumulatedLines,
            inputDirective: this.buildDirective(step),
            scrollToBottom: true,
            clearScreen: false,
            bell: false,
          };
      }
    }

    // Flow complete
    return this.complete(accumulatedLines);
  }

  get isComplete(): boolean {
    return this.currentIndex >= this.steps.length;
  }

  protected abstract buildDirective(step: InteractiveStep): InputDirective;
  protected abstract complete(lines: OutputLine[]): TerminalResponse;
  protected abstract abort(reason?: string): TerminalResponse;
  protected abstract buildRetryResponse(error?: string): TerminalResponse;
}
```

### 4. `InteractiveFlowBuilder` — Factories par vendor

Chaque vendor construit ses flows via un builder typé. Cela remplace le `buildInteractiveSteps()` monolithique.

**Fichier : `src/terminal/flows/LinuxFlowBuilder.ts`** (exemple)

```typescript
class LinuxFlowBuilder {

  static sudo(command: string, targetUser: string): InteractiveStep[] {
    return [
      {
        type: 'password',
        directive: { prompt: `[sudo] password for ${targetUser}:`, mask: 'hidden' },
        storeAs: 'sudo_password',
        validation: (pwd, ctx) => {
          const valid = ctx.device.checkPassword(ctx.currentUser, pwd);
          return { valid, errorMessage: 'Sorry, try again.', retriesLeft: 3 };
        },
      },
      {
        type: 'execute',
        action: async (ctx) => {
          // Execute the actual command as root
          const result = await ctx.device.executeCommand(command, { asRoot: true });
          ctx.metadata.set('command_output', result);
        },
      },
      {
        type: 'output',
        // Dynamic: filled by execute step above
      },
    ];
  }

  static passwd(targetUser: string): InteractiveStep[] {
    return [
      {
        type: 'password',
        directive: { prompt: 'New password:', mask: 'hidden' },
        storeAs: 'new_password',
        validation: (pwd) => ({
          valid: pwd.length >= 1,
          errorMessage: 'Password cannot be empty',
        }),
      },
      {
        type: 'password',
        directive: { prompt: 'Retype new password:', mask: 'hidden' },
        storeAs: 'confirm_password',
        validation: (pwd, ctx) => ({
          valid: pwd === ctx.values.get('new_password'),
          errorMessage: 'Sorry, passwords do not match.',
          retriesLeft: 0,
        }),
      },
      {
        type: 'execute',
        action: async (ctx) => {
          ctx.device.setUserPassword(targetUser, ctx.values.get('new_password')!);
        },
      },
      {
        type: 'output',
        outputLines: [/* "passwd: password updated successfully" */],
      },
    ];
  }

  static adduser(username: string): InteractiveStep[] {
    return [
      // password steps...
      {
        type: 'text',
        directive: { prompt: 'Full Name []:', allowEmpty: true },
        storeAs: 'fullName',
      },
      {
        type: 'text',
        directive: { prompt: 'Room Number []:', allowEmpty: true },
        storeAs: 'roomNumber',
      },
      {
        type: 'text',
        directive: { prompt: 'Work Phone []:', allowEmpty: true },
        storeAs: 'workPhone',
      },
      {
        type: 'text',
        directive: { prompt: 'Home Phone []:', allowEmpty: true },
        storeAs: 'homePhone',
      },
      {
        type: 'text',
        directive: { prompt: 'Other []:', allowEmpty: true },
        storeAs: 'other',
      },
      {
        type: 'confirmation',
        directive: { prompt: 'Is the information correct? [Y/n]', defaultAnswer: 'yes' },
        storeAs: 'confirmed',
      },
      {
        type: 'execute',
        action: async (ctx) => {
          ctx.device.setUserGecos(username, {
            fullName: ctx.values.get('fullName') ?? '',
            roomNumber: ctx.values.get('roomNumber') ?? '',
            workPhone: ctx.values.get('workPhone') ?? '',
            homePhone: ctx.values.get('homePhone') ?? '',
            other: ctx.values.get('other') ?? '',
          });
        },
      },
    ];
  }
}
```

**Fichier : `src/terminal/flows/CiscoFlowBuilder.ts`** (exemple futur)

```typescript
class CiscoFlowBuilder {
  /** Enable mode password prompt */
  static enablePassword(): InteractiveStep[] {
    return [
      {
        type: 'password',
        directive: { prompt: 'Password:', mask: 'hidden' },
        storeAs: 'enable_password',
        validation: (pwd, ctx) => {
          const valid = ctx.device.checkEnablePassword(pwd);
          return { valid, errorMessage: '% Bad secrets' };
        },
      },
    ];
  }

  /** Setup dialog (future) */
  static initialSetup(): InteractiveStep[] {
    return [
      {
        type: 'confirmation',
        directive: {
          prompt: 'Would you like to enter the initial configuration dialog? [yes/no]:',
          defaultAnswer: 'no',
        },
        storeAs: 'wants_setup',
      },
      {
        type: 'branch',
        predicate: (ctx) => ctx.values.get('wants_setup') === 'yes' ? 2 : 99,
      },
      // ... setup steps
    ];
  }
}
```

### 5. `OutputFormatter` — Le parsing ANSI sort de la vue

**Fichier : `src/terminal/core/OutputFormatter.ts`**

```typescript
/**
 * Strategy pattern: each vendor formats output differently.
 * The formatter converts raw shell output (strings) into pre-parsed OutputLine[].
 * This removes ALL parsing logic from the view.
 */
interface IOutputFormatter {
  /** Convert a raw output string into styled OutputLine(s) */
  formatOutput(raw: string, lineType?: LineType): OutputLine[];

  /** Format a prompt string into styled segments */
  formatPrompt(prompt: string): TextSegment[];
}

/** Linux formatter: parses ANSI escape codes */
class AnsiOutputFormatter implements IOutputFormatter {
  formatOutput(raw: string, lineType: LineType = 'output'): OutputLine[] {
    return raw.split('\n').map(line => ({
      id: nextLineId(),
      segments: this.parseAnsi(line),
      lineType,
    }));
  }

  formatPrompt(prompt: string): TextSegment[] {
    return this.parseAnsi(prompt);
  }

  private parseAnsi(text: string): TextSegment[] {
    // Move the ANSI parsing logic from TerminalView here
    // Returns pre-parsed TextSegment[] with colors resolved
  }
}

/** Cisco/Huawei formatter: plain text, no ANSI */
class PlainOutputFormatter implements IOutputFormatter {
  constructor(private theme: TerminalTheme) {}

  formatOutput(raw: string, lineType: LineType = 'output'): OutputLine[] {
    return raw.split('\n').map(line => ({
      id: nextLineId(),
      segments: [{ text: line }],
      lineType,
    }));
  }

  formatPrompt(prompt: string): TextSegment[] {
    return [{ text: prompt, style: { color: this.theme.promptColor } }];
  }
}

/** Windows formatter: handles PS color codes */
class WindowsOutputFormatter implements IOutputFormatter {
  // ...
}
```

### 6. `InputHandler` — Le délégué unique de la vue

**Fichier : `src/terminal/core/InputHandler.ts`**

La vue ne fait QUE une chose : quand l'utilisateur tape, elle appelle `inputHandler.handleInput(event)`. Le handler retourne un `TerminalResponse` qui dit à la vue quoi faire ensuite.

```typescript
/**
 * Single entry point for all user input.
 * The view delegates EVERYTHING here.
 */
interface IInputHandler {
  /** Handle a keystroke event, return what to update in the view */
  handleKey(event: KeyEvent): TerminalResponse | null;

  /** Handle text submission (Enter pressed) */
  handleSubmit(value: string): Promise<TerminalResponse>;

  /** Handle paste */
  handlePaste(text: string): TerminalResponse | null;

  /** Handle special actions (Ctrl+C, Ctrl+Z, Tab, etc.) */
  handleSpecialKey(key: SpecialKey): TerminalResponse | null;

  /** Get current input directive (for initial render) */
  getCurrentDirective(): InputDirective;
}

type SpecialKey = 'ctrl+c' | 'ctrl+z' | 'ctrl+l' | 'ctrl+r' | 'ctrl+d' | 'tab' | 'up' | 'down';
```

### 7. Refactoring de `TerminalSession` — La nouvelle base

La session orchestre les composants. Elle ne fait plus de parsing, plus de gestion d'input directe.

```typescript
abstract class TerminalSession {
  // Composition au lieu de tout faire soi-même
  protected readonly formatter: IOutputFormatter;
  protected readonly inputHandler: IInputHandler;
  private activeFlow: InteractiveFlowEngine | null = null;

  // L'état observable (inchangé pour React subscription)
  lines: OutputLine[];        // Now with pre-parsed TextSegment[]
  currentDirective: InputDirective;

  /** Called by the view on every keystroke */
  handleKey(event: KeyEvent): TerminalResponse | null {
    if (this.activeFlow && !this.activeFlow.isComplete) {
      return this.handleFlowInput(event);
    }
    return this.inputHandler.handleKey(event);
  }

  /** Called by the view on Enter */
  async handleSubmit(value: string): Promise<TerminalResponse> {
    if (this.activeFlow && !this.activeFlow.isComplete) {
      const response = await this.activeFlow.advance(value);
      if (this.activeFlow.isComplete) {
        this.activeFlow = null;
      }
      return response;
    }

    // Execute command normally
    return this.executeCommand(value);
  }

  /** Start an interactive flow (password, wizard, etc.) */
  protected startFlow(steps: InteractiveStep[], context: FlowContext): Promise<TerminalResponse> {
    this.activeFlow = this.createFlowEngine(steps, context);
    return this.activeFlow.advance();
  }

  protected abstract executeCommand(cmd: string): Promise<TerminalResponse>;
  protected abstract createFlowEngine(steps: InteractiveStep[], ctx: FlowContext): InteractiveFlowEngine;
}
```

### 8. Vue simplifiée — `TerminalView` ne fait plus de logique

```tsx
function TerminalView({ session }: { session: TerminalSession }) {
  const version = useSyncExternalStore(session.subscribe, session.getVersion);
  const { lines, currentDirective } = session;

  return (
    <div className="terminal">
      {/* Output: just render pre-parsed segments */}
      <div className="output">
        {lines.map(line => (
          <TerminalLine key={line.id} segments={line.segments} />
        ))}
      </div>

      {/* Input: directive tells us exactly what to render */}
      <TerminalInput
        directive={currentDirective}
        onKey={(e) => session.handleKey(e)}
        onSubmit={(val) => session.handleSubmit(val)}
      />
    </div>
  );
}

/** Pure rendering component — no logic */
function TerminalInput({ directive, onKey, onSubmit }) {
  switch (directive.type) {
    case 'command':
      return <CommandInput prompt={directive.prompt} ... />;
    case 'password':
      return <PasswordInput prompt={directive.prompt} mask={directive.mask} ... />;
    case 'text-prompt':
      return <TextPromptInput prompt={directive.prompt} default={directive.defaultValue} ... />;
    case 'confirmation':
      return <ConfirmationInput prompt={directive.prompt} ... />;
    case 'pager':
      return <PagerDisplay indicator={directive.indicator} controls={directive.controls} ... />;
    case 'editor':
      return <EditorOverlay type={directive.editorType} content={directive.content} ... />;
    case 'blocked':
      return <BlockedDisplay message={directive.statusMessage} cancellable={directive.cancellable} ... />;
    case 'reverse-search':
      return <ReverseSearchBar query={directive.query} match={directive.matchedCommand} ... />;
  }
}
```

---

## Arborescence des nouveaux fichiers

```
src/terminal/
├── core/
│   ├── types.ts                    # TextSegment, OutputLine, TerminalResponse, InputDirective
│   ├── OutputFormatter.ts          # IOutputFormatter + AnsiOutputFormatter, PlainOutputFormatter
│   ├── InputHandler.ts             # IInputHandler interface
│   └── InteractiveFlow.ts          # InteractiveStep, FlowContext, InteractiveFlowEngine
├── flows/
│   ├── LinuxFlowBuilder.ts         # sudo, passwd, adduser, su flows
│   ├── CiscoFlowBuilder.ts         # enable, setup flows
│   ├── HuaweiFlowBuilder.ts        # enable, config flows
│   └── WindowsFlowBuilder.ts       # UAC, elevation flows (future)
├── sessions/
│   ├── TerminalSession.ts          # Refactored: compose formatter + inputHandler + flow engine
│   ├── LinuxTerminalSession.ts     # Refactored: uses LinuxFlowBuilder
│   ├── CLITerminalSession.ts       # Refactored: unified CLI base
│   ├── CiscoTerminalSession.ts     # Thin: theme + vendor-specific overrides
│   ├── HuaweiTerminalSession.ts    # Thin: theme + vendor-specific overrides
│   ├── WindowsTerminalSession.ts   # Refactored: uses WindowsFlowBuilder
│   └── TerminalManager.ts          # Unchanged (factory + registry)
└── ... (existing command files unchanged)
```

---

## Plan d'implémentation (étapes ordonnées)

### Phase 1 — Core types & interfaces (pas de breaking change)
1. Créer `src/terminal/core/types.ts` avec `TextSegment`, `OutputLine` (nouvelle version), `TerminalResponse`, toutes les `InputDirective` variants
2. Créer `src/terminal/core/OutputFormatter.ts` — extraire le parsing ANSI de `TerminalView` vers `AnsiOutputFormatter`
3. Créer `src/terminal/core/InteractiveFlow.ts` — le flow engine abstrait
4. Tests unitaires pour chaque type, formatter, et flow engine

### Phase 2 — Flow builders par vendor
5. Créer `src/terminal/flows/LinuxFlowBuilder.ts` — porter les interactive steps existants (`sudo`, `passwd`, `adduser`, `su`) vers le nouveau format
6. Créer `src/terminal/flows/CiscoFlowBuilder.ts` — `enable` password, pager flow
7. Créer `src/terminal/flows/HuaweiFlowBuilder.ts` — même chose avec les variantes Huawei
8. Tests unitaires pour chaque flow builder (happy path + edge cases + erreurs)

### Phase 3 — Refactoring des sessions
9. Refactorer `TerminalSession` pour composer `IOutputFormatter` et exposer `TerminalResponse`
10. Refactorer `LinuxTerminalSession` pour utiliser `LinuxFlowBuilder` au lieu de `buildInteractiveSteps()`
11. Refactorer `CLITerminalSession` pour le pager via flow engine
12. Refactorer `WindowsTerminalSession` pour la cohérence
13. Tests d'intégration session → flow → response

### Phase 4 — Simplification de la vue
14. Refactorer `TerminalView` : supprimer tout le parsing ANSI, le switch sur `inputMode`, la gestion manuelle de focus
15. Créer les sous-composants purs : `CommandInput`, `PasswordInput`, `TextPromptInput`, `PagerDisplay`, etc.
16. La vue ne fait que : `directive.type` → composant correspondant
17. Tests GUI pour vérifier le rendu
