const CHUNK_LOAD_FAILURE = /dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError|Unable to preload CSS/i;

export const RELOAD_WINDOW_MS = 30_000;

export function isChunkLoadFailure(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return CHUNK_LOAD_FAILURE.test(text);
}

export interface DeploymentSkewHost {
  readonly nothingToLose: () => boolean;
  readonly lastReloadAt: () => number | null;
  readonly rememberReloadAt: (at: number) => void;
  readonly now: () => number;
  readonly reload: () => void;
  readonly announce: () => void;
}

export type SkewOutcome = 'reloaded' | 'announced';

export function deploymentSkewHandler(host: DeploymentSkewHost): () => SkewOutcome {
  return () => {
    const last = host.lastReloadAt();
    const now = host.now();
    const reloadedRecently = last !== null && now - last < RELOAD_WINDOW_MS;
    if (host.nothingToLose() && !reloadedRecently) {
      host.rememberReloadAt(now);
      host.reload();
      return 'reloaded';
    }
    host.announce();
    return 'announced';
  };
}
