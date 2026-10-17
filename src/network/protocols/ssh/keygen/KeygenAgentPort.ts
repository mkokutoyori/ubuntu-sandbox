import { LocalAgentPort, type AgentPort } from '../agent/AgentService';
import type { KeygenAgent } from './KeygenTypes';

export function keygenAgentOf(port: AgentPort | undefined): KeygenAgent | undefined {
  if (!(port instanceof LocalAgentPort)) return undefined;
  return { identities: () => port.identitiesNow(), sign: (blob, data, flags) => port.signNow(blob, data, flags) };
}
