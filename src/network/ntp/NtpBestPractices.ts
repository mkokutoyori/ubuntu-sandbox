import type { NtpAgent } from './NtpAgent';

export type BestPracticeStatus = 'pass' | 'fail' | 'not-applicable';
export type BestPracticeLevel = 'MUST' | 'SHOULD' | 'RECOMMENDED';

export interface BestPracticeFinding {
  readonly id: string;
  readonly section: string;
  readonly level: BestPracticeLevel;
  readonly status: BestPracticeStatus;
  readonly evidence: string;
}

const RFC = 'RFC 8633';
const MINIMUM_SOURCES = 4;

function finding(
  id: string, section: string, level: BestPracticeLevel, status: BestPracticeStatus, evidence: string,
): BestPracticeFinding {
  return { id: `${RFC}:${id}`, section, level, status, evidence };
}

export function auditNtpBestPractices(agent: NtpAgent): BestPracticeFinding[] {
  const config = agent.getConfig();
  const associations = [...config.associations.values()];
  const configured = associations.filter((a) => !a.ephemeral);
  const upstream = configured.filter((a) => a.mode === 'client');
  const peers = configured.filter((a) => a.mode === 'symmetric-active');
  const keyAlgorithms = [...config.authKeys.values()];
  const servesTime = config.serverMode || config.counters.serverReplies > 0;
  const findings: BestPracticeFinding[] = [];

  findings.push(upstream.length === 0
    ? finding('sources', '3.2', 'SHOULD', 'not-applicable', 'no upstream source configured')
    : finding('sources', '3.2', 'SHOULD', upstream.length >= MINIMUM_SOURCES ? 'pass' : 'fail',
      `${upstream.length} upstream source(s) configured, at least ${MINIMUM_SOURCES} recommended`));

  const controlRestricted = !config.allowModeControl || config.accessGroups.size > 0;
  findings.push(finding('control-messages', '3.4', 'RECOMMENDED', controlRestricted ? 'pass' : 'fail',
    controlRestricted
      ? (config.allowModeControl ? 'control queries are gated by an access group' : 'control messages are disabled')
      : 'control messages answer any source: no access group and control mode not disabled'));

  findings.push(servesTime
    ? finding('time-queries', '5.1', 'SHOULD', config.accessGroups.size > 0 ? 'pass' : 'fail',
      config.accessGroups.size > 0 ? 'time queries are gated by an access group' : 'serves time to any source: no access group')
    : finding('time-queries', '5.1', 'SHOULD', 'not-applicable', 'does not serve time'));

  findings.push(keyAlgorithms.length === 0
    ? finding('key-algorithm', '4.1', 'SHOULD', 'not-applicable', 'no authentication key configured')
    : finding('key-algorithm', '4.1', 'SHOULD', keyAlgorithms.every((k) => k.algo.toLowerCase() !== 'md5') ? 'pass' : 'fail',
      `key(s) ${keyAlgorithms.filter((k) => k.algo.toLowerCase() === 'md5').map((k) => k.id).join(', ') || 'none'} use MD5, considered too weak`));

  const keyed = configured.filter((a) => a.keyId !== undefined);
  const shared = keyed.filter((a) => keyed.some((b) => b !== a && b.keyId === a.keyId));
  findings.push(keyed.length < 2
    ? finding('unique-keys', '4.1', 'RECOMMENDED', 'not-applicable', 'fewer than two keyed associations')
    : finding('unique-keys', '4.1', 'RECOMMENDED', shared.length === 0 ? 'pass' : 'fail',
      shared.length === 0 ? 'each association has its own key' : `key shared by ${shared.map((a) => a.serverIp).join(', ')}`));

  findings.push(config.rateLimit === null && servesTime
    ? finding('kod-rate-limit', '5.4', 'SHOULD', 'fail', 'serves time without rate limiting: no Kiss-o\'-Death can be sent to a misbehaving client')
    : finding('kod-rate-limit', '5.4', 'SHOULD', servesTime ? 'pass' : 'not-applicable',
      servesTime ? 'rate limiting is configured' : 'does not serve time'));

  const announcing = [...config.broadcastServers.values()];
  const listening = config.broadcastClientInterfaces.size > 0 || config.sntpBroadcastClient;
  const broadcastUnsafe = announcing.some((s) => s.keyId === undefined) || (listening && !config.authenticate);
  findings.push(announcing.length === 0 && !listening
    ? finding('broadcast', '5.5', 'SHOULD', 'not-applicable', 'broadcast and multicast modes are not used')
    : finding('broadcast', '5.5', 'SHOULD', broadcastUnsafe ? 'fail' : 'pass',
      broadcastUnsafe ? 'broadcast mode without authentication: any host on the segment can announce time' : 'broadcast mode is authenticated'));

  const unauthenticatedPeers = peers.filter((a) => a.keyId === undefined);
  findings.push(peers.length === 0
    ? finding('symmetric', '5.6', 'SHOULD', 'not-applicable', 'no symmetric association configured')
    : finding('symmetric', '5.6', 'SHOULD', unauthenticatedPeers.length === 0 ? 'pass' : 'fail',
      unauthenticatedPeers.length === 0 ? 'every symmetric peer is authenticated'
        : `symmetric peer(s) without a key: ${unauthenticatedPeers.map((a) => a.serverIp).join(', ')}`));

  return findings;
}
