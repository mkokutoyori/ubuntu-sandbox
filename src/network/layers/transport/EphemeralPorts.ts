const RANDOM_ATTEMPTS = 256;

export const EPHEMERAL_EXHAUSTED = 'EADDRINUSE: No ephemeral ports available';

export function allocateEphemeralPort(
  min: number, max: number, isTaken: (port: number) => boolean,
): number {
  const range = max - min + 1;
  for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt++) {
    const port = min + Math.floor(Math.random() * range);
    if (!isTaken(port)) return port;
  }
  for (let port = min; port <= max; port++) {
    if (!isTaken(port)) return port;
  }
  throw new Error(EPHEMERAL_EXHAUSTED);
}
