import type { PamConversationFlow, PamConversationRequest, PamReply } from './PamHandle';

export class PamDialogue {
  private request: PamConversationRequest = [];
  private replies: PamReply[] = [];
  private index = 0;
  private waitingFor: string | null = null;
  private notices: string[] = [];
  private outcome: number | null = null;
  private started = false;

  constructor(
    private readonly flow: PamConversationFlow<number>,
    private readonly onFinished: () => void = () => undefined,
  ) {}

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    this.advance(this.flow.next());
  }

  private advance(first: IteratorResult<PamConversationRequest, number>): void {
    let step = first;
    while (step.done !== true) {
      this.request = step.value;
      this.replies = [];
      this.index = 0;
      if (this.consume()) return;
      step = this.flow.next(this.replies);
    }
    this.outcome = step.value;
    this.waitingFor = null;
    this.onFinished();
  }

  private consume(): boolean {
    while (this.index < this.request.length) {
      const message = this.request[this.index];
      if (message.style === 'prompt-echo-off' || message.style === 'prompt-echo-on') {
        this.waitingFor = message.text;
        return true;
      }
      this.notices.push(message.text);
      this.replies.push({ text: '' });
      this.index++;
    }
    return false;
  }

  get prompt(): string {
    this.ensureStarted();
    return this.waitingFor ?? '';
  }

  get finished(): boolean {
    this.ensureStarted();
    return this.outcome !== null;
  }

  get code(): number {
    this.ensureStarted();
    return this.outcome ?? -1;
  }

  answer(text: string | null): void {
    this.ensureStarted();
    if (this.waitingFor === null) return;
    this.replies.push({ text });
    this.index++;
    this.waitingFor = null;
    if (this.consume()) return;
    this.advance(this.flow.next(this.replies));
  }

  takeNotices(): string[] {
    this.ensureStarted();
    return this.notices.splice(0);
  }
}
