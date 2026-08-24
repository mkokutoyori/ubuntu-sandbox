export type LoginBannerStage = 'pre' | 'post';

export const ADMIN_DISCLAIMER_MESSAGES: Readonly<Record<LoginBannerStage, string>> =
  Object.freeze({
    pre: 'pre_admin-disclaimer-text',
    post: 'post_admin-disclaimer-text',
  });

export const BANNER_ACCEPT_PROMPT = "(Press 'a' to accept): ";
export const BANNER_ACCEPT_KEY = 'a';

export class BannerAcceptance {
  private pending: boolean;

  constructor(private readonly text: readonly string[]) {
    this.pending = text.length > 0;
  }

  awaiting(): boolean { return this.pending; }

  message(): string { return this.text.join('\n'); }

  answer(line: string): 'accepted' | 'refused' {
    this.pending = false;
    return line.trim().toLowerCase() === BANNER_ACCEPT_KEY ? 'accepted' : 'refused';
  }
}

export class LoginBanners {
  private readonly shown = new Map<LoginBannerStage, boolean>();
  private readonly buffers = new Map<string, string>();

  enable(stage: LoginBannerStage, on: boolean): void {
    this.shown.set(stage, on);
  }

  isEnabled(stage: LoginBannerStage): boolean {
    return this.shown.get(stage) === true;
  }

  setBuffer(message: string, buffer: string): void {
    this.buffers.set(message, buffer);
  }

  clearBuffer(message: string): void {
    this.buffers.delete(message);
  }

  buffer(message: string): string {
    return this.buffers.get(message) ?? '';
  }

  lines(stage: LoginBannerStage): readonly string[] {
    if (!this.isEnabled(stage)) return Object.freeze([]);
    const text = this.buffer(ADMIN_DISCLAIMER_MESSAGES[stage]);
    return text.length === 0 ? Object.freeze([]) : text.split('\n');
  }
}
