import type { CronJob } from './CronSchedule';

export interface CronRunResult {
  output: string;
  exitCode: number;
}

export interface CronSource {
  dueJobs(at: Date): CronJob[];
  rebootJobs(): CronJob[];
}

export interface CronEngineDeps {
  sources: CronSource[];
  runner(command: string, ctx: { user: string; env: Record<string, string> }): CronRunResult;
  syslog(tag: string, message: string): void;
  deliverMail(recipient: string, body: string): void;
  homeFor(user: string): string;
  hostname: string;
  now(): Date;
}

export class CronEngine {
  private running = false;
  private lastMinute = '';

  constructor(private readonly deps: CronEngineDeps) {}

  get isRunning(): boolean { return this.running; }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastMinute = '';
    this.fireReboot();
  }

  stop(): void {
    this.running = false;
  }

  tick(now: Date = this.deps.now()): void {
    if (!this.running) return;
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    if (key === this.lastMinute) return;
    this.lastMinute = key;
    for (const source of this.deps.sources) {
      for (const job of source.dueJobs(now)) this.runJob(job);
    }
  }

  private fireReboot(): void {
    for (const source of this.deps.sources) {
      for (const job of source.rebootJobs()) this.runJob(job);
    }
  }

  private runJob(job: CronJob): void {
    const env = this.buildEnv(job);
    this.deps.syslog('CRON', `(${job.user}) CMD (${job.command})`);
    const result = this.deps.runner(job.command, { user: job.user, env });
    this.maybeMail(job, result);
  }

  private buildEnv(job: CronJob): Record<string, string> {
    return {
      SHELL: '/bin/sh',
      PATH: '/usr/bin:/bin',
      HOME: this.deps.homeFor(job.user),
      LOGNAME: job.user,
      USER: job.user,
      ...job.env,
    };
  }

  private maybeMail(job: CronJob, result: CronRunResult): void {
    const mailto = job.env.MAILTO;
    if (mailto === '') return;
    if (result.output.trim() === '') return;
    const recipient = mailto && mailto.length > 0 ? mailto : job.user;
    this.deps.deliverMail(recipient, this.formatMail(job, recipient, result.output));
  }

  private formatMail(job: CronJob, recipient: string, output: string): string {
    const headers = [
      `From: root (Cron Daemon)`,
      `To: ${recipient}@${this.deps.hostname}`,
      `Subject: Cron <${job.user}@${this.deps.hostname}> ${job.command}`,
      `Content-Type: text/plain; charset=UTF-8`,
      `X-Cron-Env: <SHELL=/bin/sh>`,
      `X-Cron-Env: <PATH=${this.buildEnv(job).PATH}>`,
      `X-Cron-Env: <HOME=${this.deps.homeFor(job.user)}>`,
      `X-Cron-Env: <LOGNAME=${job.user}>`,
      `X-Cron-Env: <USER=${job.user}>`,
      '',
    ];
    return `${headers.join('\n')}\n${output.endsWith('\n') ? output : output + '\n'}`;
  }
}
