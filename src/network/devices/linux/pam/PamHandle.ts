import { PamReturn } from './PamReturnCode';
import type { PamHandler } from './PamStackConfig';

export type PamMessageStyle = 'prompt-echo-off' | 'prompt-echo-on' | 'error' | 'info';

export interface PamMessage {
  readonly style: PamMessageStyle;
  readonly text: string;
}

export interface PamReply {
  readonly text: string | null;
}

export type PamConversationRequest = readonly PamMessage[];

export interface PamValue<T> {
  readonly code: number;
  readonly value: T | null;
}

export type PamConversationFlow<T> = Generator<PamConversationRequest, T, readonly PamReply[]>;

export type PamChoice = 'authenticate' | 'setcred' | 'acct_mgmt' | 'open_session' | 'close_session' | 'chauthtok';

export type PamDataCleanup = (pamh: PamHandle<PamHost>, value: unknown, silent: boolean) => void;

export type PamPriority = 'emerg' | 'alert' | 'crit' | 'err' | 'warning' | 'notice' | 'info' | 'debug';

export const PAM_LIBRARY_NAME = 'PAM';

export function formatPamLogLine(entry: PamLogEntry): string {
  if (entry.module === PAM_LIBRARY_NAME) return `${PAM_LIBRARY_NAME} ${entry.message}`;
  return `${entry.module}(${entry.service}:${pamChoiceLabel(entry.choice)}): ${entry.message}`;
}

export interface PamLogEntry {
  readonly priority: PamPriority;
  readonly module: string;
  readonly service: string;
  readonly choice: PamChoice | null;
  readonly message: string;
}

export interface PamHost {
  readFile(path: string): string | null;
  now(): number;
  log(entry: PamLogEntry): void;
}

const CHOICE_LABEL: Readonly<Record<PamChoice, string>> = {
  authenticate: 'auth',
  setcred: 'setcred',
  acct_mgmt: 'account',
  open_session: 'session',
  close_session: 'session',
  chauthtok: 'chauthtok',
};

export function pamChoiceLabel(choice: PamChoice | null): string {
  return choice === null ? 'unknown' : CHOICE_LABEL[choice];
}

export class PamHandle<H extends PamHost = PamHost> {
  user: string | null = null;
  tty: string | null = null;
  rhost: string | null = null;
  ruser: string | null = null;
  authtok: string | null = null;
  oldAuthtok: string | null = null;
  userPrompt: string | null = null;
  xdisplay: string | null = null;
  authtokType: string | null = null;
  authtokVerified = false;
  readonly environment = new Map<string, string>();
  private readonly dataEntries = new Map<string, { value: unknown; cleanup: PamDataCleanup | null }>();
  choice: PamChoice | null = null;
  currentModule: string | null = null;
  currentHandler: PamHandler | null = null;
  currentArgs: readonly string[] = [];
  readonly messages: PamMessage[] = [];

  constructor(readonly service: string, readonly host: H) {}

  syslog(priority: PamPriority, message: string): void {
    this.host.log({
      priority,
      module: this.currentModule ?? PAM_LIBRARY_NAME,
      service: this.service,
      choice: this.choice,
      message,
    });
  }

  *converse(messages: PamConversationRequest): PamConversationFlow<readonly PamReply[]> {
    const replies = yield messages;
    return replies;
  }

  *prompt(style: 'prompt-echo-off' | 'prompt-echo-on', text: string): PamConversationFlow<string | null> {
    const replies = yield [{ style, text }];
    return replies[0]?.text ?? null;
  }

  *notify(style: 'error' | 'info', text: string): PamConversationFlow<void> {
    this.messages.push({ style, text });
    yield [{ style, text }];
  }

  option(name: string): string | null {
    for (const argument of this.currentArgs) {
      if (argument.startsWith(name)) {
        const rest = argument.slice(name.length);
        if (rest.startsWith('=')) return rest.slice(1);
        if (rest === '') return '';
      }
    }
    return null;
  }

  *getUser(prompt?: string): PamConversationFlow<PamValue<string>> {
    if (this.user !== null) return { code: PamReturn.SUCCESS, value: this.user };
    const text = prompt ?? this.userPrompt ?? 'login: ';
    const answer = yield* this.prompt('prompt-echo-on', text);
    if (answer === null) return { code: PamReturn.CONV_ERR, value: null };
    this.user = answer;
    return { code: PamReturn.SUCCESS, value: answer };
  }

  *getAuthtok(
    prompt: string | null,
    options: { readonly item?: 'authtok' | 'oldauthtok'; readonly noverify?: boolean } = {},
  ): PamConversationFlow<PamValue<string>> {
    const item = options.item ?? 'authtok';
    const changing = this.choice === 'chauthtok';
    let asks = 0;
    let authtokType = '';
    if (changing) {
      if (item === 'authtok') asks = options.noverify === true ? 1 : 2;
      const typed = this.option('authtok_type');
      if (typed === null) authtokType = this.authtokType ?? '';
      else { authtokType = typed; this.authtokType = typed; }
    }
    const previous = item === 'authtok' ? this.authtok : this.oldAuthtok;
    if (previous !== null) return { code: PamReturn.SUCCESS, value: previous };
    if (this.option('use_first_pass') !== null || (asks > 0 && this.option('use_authtok') !== null)) {
      return { code: asks > 0 ? PamReturn.AUTHTOK_ERR : PamReturn.AUTH_ERR, value: null };
    }

    let first: string | null;
    let second: string | null = null;
    const named = (template: string, fallback: string): string => (authtokType === '' ? fallback : template.replace('%s', authtokType));
    if (prompt !== null) {
      first = yield* this.prompt('prompt-echo-off', prompt);
      if (first !== null && asks > 1) second = yield* this.prompt('prompt-echo-off', `Retype ${prompt}`);
    } else if (asks > 0) {
      this.authtokVerified = false;
      first = yield* this.prompt('prompt-echo-off', named('New %s password: ', 'New password: '));
      if (first !== null && asks > 1) {
        second = yield* this.prompt('prompt-echo-off', named('Retype new %s password: ', 'Retype new password: '));
      }
    } else if (item === 'oldauthtok') {
      first = yield* this.prompt('prompt-echo-off', named('Current %s password: ', 'Current password: '));
    } else {
      first = yield* this.prompt('prompt-echo-off', 'Password: ');
    }

    if (first === null || (asks > 1 && second === null)) {
      if (asks > 0) yield* this.notify('error', 'Password change has been aborted.');
      return { code: PamReturn.AUTHTOK_ERR, value: null };
    }
    if (asks > 1 && first !== second) {
      yield* this.notify('error', 'Sorry, passwords do not match.');
      return { code: PamReturn.TRY_AGAIN, value: null };
    }
    if (item === 'authtok') this.authtok = first; else this.oldAuthtok = first;
    if (asks > 1) this.authtokVerified = true;
    return { code: PamReturn.SUCCESS, value: first };
  }

  *getAuthtokVerify(prompt: string | null): PamConversationFlow<PamValue<string>> {
    if (this.choice !== 'chauthtok') return { code: PamReturn.SYSTEM_ERR, value: null };
    if (this.authtokVerified) return { code: PamReturn.SUCCESS, value: this.authtok };
    const typed = this.authtokType ?? '';
    const text = prompt !== null
      ? `Retype ${prompt}`
      : (typed === '' ? 'Retype new password: ' : `Retype new ${typed} password: `);
    const answer = yield* this.prompt('prompt-echo-off', text);
    if (answer === null) {
      this.authtok = null;
      yield* this.notify('error', 'Password change has been aborted.');
      return { code: PamReturn.AUTHTOK_ERR, value: null };
    }
    if (this.authtok !== answer) {
      this.authtok = null;
      yield* this.notify('error', 'Sorry, passwords do not match.');
      return { code: PamReturn.TRY_AGAIN, value: null };
    }
    this.authtokVerified = true;
    return { code: PamReturn.SUCCESS, value: answer };
  }

  setData(name: string, value: unknown, cleanup: PamDataCleanup | null = null): void {
    const previous = this.dataEntries.get(name);
    this.dataEntries.set(name, { value, cleanup });
    if (previous?.cleanup) previous.cleanup(this as unknown as PamHandle<PamHost>, previous.value, true);
  }

  getData<T>(name: string): T | undefined {
    return this.dataEntries.get(name)?.value as T | undefined;
  }

  deleteData(name: string): void {
    const previous = this.dataEntries.get(name);
    this.dataEntries.delete(name);
    if (previous?.cleanup) previous.cleanup(this as unknown as PamHandle<PamHost>, previous.value, false);
  }

  releaseData(): void {
    const entries = [...this.dataEntries.values()];
    this.dataEntries.clear();
    for (const entry of entries) entry.cleanup?.(this as unknown as PamHandle<PamHost>, entry.value, false);
  }

  sanitize(): void {
    this.authtok = null;
    this.oldAuthtok = null;
    this.authtokVerified = false;
  }
}
