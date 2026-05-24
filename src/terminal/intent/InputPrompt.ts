/**
 * InputPrompt — a vendor-neutral description of an input the backend
 * needs the user to provide.
 *
 * Kinds:
 *   - text         — visible single-line text (login name, hostname, …)
 *   - password     — masked text (echo: hidden / dots / asterisks)
 *   - confirm      — Y/N or [yes/no] confirmation
 *   - select       — pick one of N labelled options
 *   - multiSelect  — pick any of N labelled options
 *   - secret       — like password, but explicitly never echoed and not
 *                    stored in scrollback (TOTP, recovery codes, …)
 *   - multiline    — paragraph input (paste a key block, …)
 *
 * Each instance is a frozen value object. Validation is expressed as a
 * pure predicate so the flow stays declarative and validations are
 * trivially composable / testable.
 */

import { InputValidator } from './InputValidator';

export type InputPromptKind =
  | 'text' | 'password' | 'confirm' | 'select' | 'multiSelect' | 'secret' | 'multiline';

export interface SelectOption {
  /** Stable machine key (returned in InputResponse.value). */
  readonly key: string;
  /** Human-friendly label rendered by the UI. */
  readonly label: string;
  /** Optional longer description for richer pickers. */
  readonly description?: string;
}

export interface InputPromptOptions {
  /** What the user sees ("[sudo] password for alice:"). */
  readonly label: string;
  /** Optional grey placeholder for empty text/multiline fields. */
  readonly placeholder?: string;
  /** Optional pre-filled default — Enter on empty input accepts it. */
  readonly defaultValue?: string;
  /** Maximum retry attempts before {@link IntentFlow} aborts the prompt. */
  readonly maxAttempts?: number;
  /** When true, value must not be retained beyond the response. */
  readonly sensitive?: boolean;
  /** When false, an empty submission is rejected before validation runs. */
  readonly allowEmpty?: boolean;
  /** Default for confirm prompts. */
  readonly defaultAnswer?: 'yes' | 'no';
  /** Mask style for password / secret prompts. */
  readonly mask?: 'hidden' | 'dots' | 'asterisks';
  /** Options for select / multiSelect. */
  readonly choices?: ReadonlyArray<SelectOption>;
  /** Validator predicate; null = always accept. */
  readonly validator?: InputValidator | null;
}

export class InputPrompt {
  readonly kind: InputPromptKind;
  readonly label: string;
  readonly placeholder?: string;
  readonly defaultValue?: string;
  readonly maxAttempts: number;
  readonly sensitive: boolean;
  readonly allowEmpty: boolean;
  readonly defaultAnswer?: 'yes' | 'no';
  readonly mask: 'hidden' | 'dots' | 'asterisks';
  readonly choices: ReadonlyArray<SelectOption>;
  readonly validator: InputValidator | null;

  private constructor(kind: InputPromptKind, opts: InputPromptOptions) {
    this.kind = kind;
    this.label = opts.label;
    this.placeholder = opts.placeholder;
    this.defaultValue = opts.defaultValue;
    this.maxAttempts = opts.maxAttempts ?? Infinity;
    this.sensitive = opts.sensitive ?? (kind === 'password' || kind === 'secret');
    this.allowEmpty = opts.allowEmpty ?? (kind !== 'password' && kind !== 'secret');
    this.defaultAnswer = opts.defaultAnswer;
    this.mask = opts.mask ?? (kind === 'password' || kind === 'secret' ? 'hidden' : 'hidden');
    this.choices = Object.freeze([...(opts.choices ?? [])]);
    this.validator = opts.validator ?? null;
    Object.freeze(this);
  }

  static text(opts: InputPromptOptions): InputPrompt { return new InputPrompt('text', opts); }
  static password(opts: InputPromptOptions): InputPrompt { return new InputPrompt('password', opts); }
  static confirm(opts: InputPromptOptions): InputPrompt { return new InputPrompt('confirm', opts); }
  static select(opts: InputPromptOptions): InputPrompt {
    if ((opts.choices?.length ?? 0) === 0) {
      throw new Error('InputPrompt.select requires at least one choice');
    }
    return new InputPrompt('select', opts);
  }
  static multiSelect(opts: InputPromptOptions): InputPrompt {
    if ((opts.choices?.length ?? 0) === 0) {
      throw new Error('InputPrompt.multiSelect requires at least one choice');
    }
    return new InputPrompt('multiSelect', opts);
  }
  static secret(opts: InputPromptOptions): InputPrompt { return new InputPrompt('secret', opts); }
  static multiline(opts: InputPromptOptions): InputPrompt { return new InputPrompt('multiline', opts); }
}
