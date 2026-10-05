export class RedirectWriteError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
