import { TCP_INITIAL_RTO_MS } from './RttEstimator';

export async function retransmitSilentSyn<T>(
  attempt: () => T,
  isSilent: (outcome: T) => boolean,
  wait: (ms: number) => Promise<void>,
  connectTimeoutMs?: number,
): Promise<T> {
  const first = attempt();
  if (!isSilent(first)) return first;
  if (connectTimeoutMs !== undefined && connectTimeoutMs < TCP_INITIAL_RTO_MS) return first;
  await wait(TCP_INITIAL_RTO_MS);
  return attempt();
}
