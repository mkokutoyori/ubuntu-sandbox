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

export type PamConversationFlow<T> = Generator<PamConversationRequest, T, readonly PamReply[]>;

export type PamChoice = 'authenticate' | 'setcred' | 'acct_mgmt' | 'open_session' | 'close_session' | 'chauthtok';

export type PamPriority = 'emerg' | 'alert' | 'crit' | 'err' | 'warning' | 'notice' | 'info' | 'debug';

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
  readonly environment = new Map<string, string>();
  readonly moduleData = new Map<string, unknown>();
  choice: PamChoice | null = null;
  currentModule: string | null = null;
  currentHandler: PamHandler | null = null;
  currentArgs: readonly string[] = [];
  readonly messages: PamMessage[] = [];

  constructor(readonly service: string, readonly host: H) {}

  syslog(priority: PamPriority, message: string): void {
    this.host.log({
      priority,
      module: this.currentModule ?? 'libpam',
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

  *getUser(prompt?: string): PamConversationFlow<string | null> {
    if (this.user !== null && this.user !== '') return this.user;
    const text = prompt ?? this.userPrompt ?? 'login: ';
    const answer = yield* this.prompt('prompt-echo-on', text);
    if (answer === null || answer === '') return null;
    this.user = answer;
    return answer;
  }

  *getAuthtok(prompt: string, old = false): PamConversationFlow<string | null> {
    const current = old ? this.oldAuthtok : this.authtok;
    if (current !== null) return current;
    const answer = yield* this.prompt('prompt-echo-off', prompt);
    if (answer === null) return null;
    if (old) this.oldAuthtok = answer; else this.authtok = answer;
    return answer;
  }

  sanitize(): void {
    this.authtok = null;
    this.oldAuthtok = null;
  }
}
