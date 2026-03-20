/**
 * Core terminal types — The unified contract between terminal model and view.
 *
 * Design principle: the view is DUMB. It receives InputDirective objects
 * that tell it exactly what to render and what input to collect. All logic
 * lives in the session/flow layer. The view never interprets raw strings.
 */

import type { Equipment } from '@/network';

// ─── Text styling (pre-parsed, no ANSI in the view) ──────────────────

/** A single styled segment within a line */
export interface TextSegment {
  text: string;
  style?: TextStyle;
}

export interface TextStyle {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
}

// ─── Output lines ────────────────────────────────────────────────────

export type LineType = 'output' | 'error' | 'warning' | 'prompt' | 'info' | 'boot' | 'system';

/** A single output line, pre-parsed and ready to render */
export interface RichOutputLine {
  id: number;
  segments: TextSegment[];
  lineType: LineType;
}

// ─── Terminal Response ───────────────────────────────────────────────

/**
 * The unified object that sessions return to the view after any interaction.
 * Tells the view: what lines to show, what input to collect next,
 * and any visual effects to apply.
 */
export interface TerminalResponse {
  /** Lines to append to terminal output */
  lines: RichOutputLine[];

  /** Next input directive — tells the view what to render */
  inputDirective: InputDirective;

  /** Should the view scroll to bottom after this response */
  scrollToBottom: boolean;

  /** Should the view clear all existing lines first */
  clearScreen: boolean;

  /** Visual/audible bell */
  bell: boolean;
}

// ─── Input Directives ────────────────────────────────────────────────

/**
 * Discriminated union of all possible input modes.
 * Each variant carries ALL the context the view needs — no guessing.
 */
export type InputDirectiveType =
  | 'command'
  | 'password'
  | 'text-prompt'
  | 'confirmation'
  | 'choice'
  | 'pager'
  | 'editor'
  | 'blocked'
  | 'reverse-search';

/** Base interface for all directives */
interface BaseInputDirective {
  type: InputDirectiveType;
}

/** Normal command input (the default state) */
export interface CommandDirective extends BaseInputDirective {
  type: 'command';
  prompt: string;
  promptSegments?: TextSegment[];
  completionHint?: string;
}

/** Hidden input for passwords */
export interface PasswordDirective extends BaseInputDirective {
  type: 'password';
  prompt: string;
  mask: 'hidden' | 'dots' | 'asterisks';
  maxAttempts?: number;
  attemptsRemaining?: number;
}

/** Visible text prompt with a question (GECOS fields, hostnames, etc.) */
export interface TextPromptDirective extends BaseInputDirective {
  type: 'text-prompt';
  prompt: string;
  defaultValue?: string;
  allowEmpty: boolean;
  validation?: InputValidation;
}

/** Y/N confirmation prompt */
export interface ConfirmationDirective extends BaseInputDirective {
  type: 'confirmation';
  prompt: string;
  defaultAnswer?: 'yes' | 'no';
}

/** Selection from a list of options (future: menu-driven CLI) */
export interface ChoiceDirective extends BaseInputDirective {
  type: 'choice';
  prompt: string;
  options: { key: string; label: string }[];
}

/** Pager for long output (--More-- / ---- More ----) */
export interface PagerDirective extends BaseInputDirective {
  type: 'pager';
  indicator: string;
  progress?: number;
  controls: PagerControls;
}

export interface PagerControls {
  nextPage: string;
  nextLine: string;
  quit: string;
  search?: string;
}

/** Full-screen editor overlay */
export interface EditorDirective extends BaseInputDirective {
  type: 'editor';
  editorType: 'nano' | 'vim';
  filePath: string;
  absolutePath: string;
  content: string;
  isNewFile: boolean;
}

/** Input blocked (booting, processing) */
export interface BlockedDirective extends BaseInputDirective {
  type: 'blocked';
  reason: 'booting' | 'processing' | 'connecting';
  statusMessage?: string;
  progress?: number;
  cancellable: boolean;
}

/** Reverse search mode (Ctrl+R) */
export interface ReverseSearchDirective extends BaseInputDirective {
  type: 'reverse-search';
  query: string;
  matchedCommand?: string;
  matchIndex?: number;
}

export type InputDirective =
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
export interface InputValidation {
  pattern?: RegExp;
  minLength?: number;
  maxLength?: number;
  errorMessage?: string;
}

// ─── Interactive Flow types ──────────────────────────────────────────

/**
 * A single step in an interactive flow (password wizard, adduser, etc.).
 * Steps are processed sequentially by the InteractiveFlowEngine.
 *
 * - 'password', 'text', 'confirmation', 'choice' → pause and ask the user
 * - 'output' → display lines and continue automatically
 * - 'execute' → run an async action and continue
 * - 'branch' → conditionally jump to a different step index
 */
export type InteractiveStepType = 'password' | 'text' | 'confirmation' | 'choice' | 'output' | 'execute' | 'branch';

export interface InteractiveStep {
  type: InteractiveStepType;

  /** For password steps: prompt text and mask style */
  prompt?: string;
  mask?: 'hidden' | 'dots' | 'asterisks';

  /** For text steps: prompt, default value, allow empty */
  defaultValue?: string;
  allowEmpty?: boolean;

  /** For confirmation steps: default answer */
  defaultAnswer?: 'yes' | 'no';

  /** For choice steps: available options */
  options?: { key: string; label: string }[];

  /** For output steps: text lines to display */
  outputLines?: string[];
  outputLineType?: LineType;

  /** For execute steps: async action to run */
  action?: (context: FlowContext) => Promise<void>;

  /** For branch steps: returns the step index to jump to */
  predicate?: (context: FlowContext) => number;

  /** Key to store the user's input in the context (for input steps) */
  storeAs?: string;

  /** Validation for input steps */
  validation?: (value: string, context: FlowContext) => ValidationResult;
}

export interface ValidationResult {
  valid: boolean;
  errorMessage?: string;
  /** On invalid: how many total retries allowed before aborting. undefined = infinite */
  maxRetries?: number;
}

/**
 * Shared context that flows through all steps of an interactive flow.
 * Accumulates collected values and carries device/session references.
 */
export interface FlowContext {
  /** Collected user inputs, keyed by InteractiveStep.storeAs */
  values: Map<string, string>;

  /** The device being operated on */
  device: Equipment;

  /** Current user at flow start */
  currentUser: string;

  /** Current UID at flow start */
  currentUid: number;

  /** Arbitrary metadata for flow-specific state */
  metadata: Map<string, unknown>;

  /**
   * Execute a command on the device (with timeout + power-off guard).
   * Provided by the session — allows flow builders to run commands
   * without coupling to session internals.
   */
  executeCommand?: (command: string) => Promise<string>;

  /**
   * Display output to the terminal. Called by execute steps
   * that produce visible results (command output, status messages).
   * Provided by the session — the flow engine can't addLine() directly.
   */
  onOutput?: (text: string, lineType?: string) => void;

  /**
   * Clear the terminal screen. Called by execute steps when output
   * contains ANSI clear screen sequences.
   */
  onClearScreen?: () => void;
}
