export type LoginBannerStage = 'pre' | 'post';

export const ADMIN_DISCLAIMER_MESSAGES: Readonly<Record<LoginBannerStage, string>> =
  Object.freeze({
    pre: 'pre_admin-disclaimer-text',
    post: 'post_admin-disclaimer-text',
  });

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
