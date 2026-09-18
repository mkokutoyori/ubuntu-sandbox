import { electionSentence } from '../../../ha/HaTypes';
import type { HaAgent } from '../../../ha/HaAgent';

export interface HaViewFacts {
  readonly model: string;
  readonly hostname: string;
  readonly now: number;
  readonly localStamp: (at: number) => string;
}

const MEMBER_INDENT = ' '.repeat(4);
export const ROLE_LABEL = Object.freeze({ master: 'Primary', slave: 'Secondary' });

function roleLine(label: string, member: MemberView, index: number): string {
  return `${label} : ${member.hostname}, ${member.serial}, HA cluster index = ${index}`;
}

const NO_STATE_CHANGE = 'N/A';
const USAGE_HEADINGS: readonly string[] = Object.freeze([
  'System Usage stats:', 'HBDEV stats:',
]);

function stateChangeTime(ha: HaAgent, facts: HaViewFacts): string {
  const records = ha.elections();
  const last = records[records.length - 1];
  return last === undefined ? NO_STATE_CHANGE : facts.localStamp(last.at);
}

function preamble(
  ha: HaAgent, facts: HaViewFacts, mode: string, uptimeMs: number,
): string[] {
  const config = ha.getConfiguration();
  return [
    'HA Health Status: OK',
    `Model: ${facts.model}`,
    `Mode: ${mode}`,
    `Group: ${config.groupId}`,
    'Debug: 0',
    `Cluster Uptime: ${formatUptime(uptimeMs)}`,
    `Cluster state change time: ${stateChangeTime(ha, facts)}`,
  ];
}

function pickupLines(ha: HaAgent): string[] {
  const config = ha.getConfiguration();
  return [
    `ses_pickup: ${config.sessionPickup ? 'enable' : 'disable'}, ses_pickup_delay=disable`,
    `override: ${config.override ? 'enable' : 'disable'}`,
  ];
}

export function renderHaStatus(ha: HaAgent, facts: HaViewFacts): string {
  const config = ha.getConfiguration();
  if (config.mode === 'standalone') {
    return [
      ...preamble(ha, facts, 'Standalone', 0),
      ...pickupLines(ha),
      ...USAGE_HEADINGS,
      'number of vcluster: 0',
    ].join('\n');
  }

  const lines = [
    ...preamble(ha, facts, `HA ${config.mode.toUpperCase()}`, ha.uptimeMs()),
    `${ROLE_LABEL.master} selected using:`,
  ];

  for (const record of ha.elections()) {
    lines.push(`${MEMBER_INDENT}<${electionStamp(facts.localStamp(record.at))}>`
      + ` ${electionSentence(record.serial, record.reason)}`);
  }

  lines.push(...pickupLines(ha), 'Configuration Status:');

  for (const member of members(ha)) {
    lines.push(`${MEMBER_INDENT}${member.serial}(updated 1 seconds ago): ${member.sync}`);
  }

  lines.push(...USAGE_HEADINGS);

  const primary = members(ha).find(member => member.role === 'master');
  const secondary = members(ha).find(member => member.role !== 'master');
  if (primary) lines.push(roleLine(ROLE_LABEL.master, primary, 0));
  if (secondary) lines.push(roleLine(ROLE_LABEL.slave, secondary, 1));
  lines.push('number of vcluster: 1');

  return lines.join('\n');
}

function electionStamp(localStamp: string): string {
  return localStamp.replace(/-/g, '/');
}

export function renderHaChecksum(ha: HaAgent): string {
  const rows = [
    { serial: ha.serial(), digest: ha.configurationDigest() },
    ...ha.knownPeers().map(peer => ({
      serial: peer.serial, digest: peer.configurationDigest,
    })),
  ].sort((left, right) => (left.serial < right.serial ? -1 : 1));

  return rows.map(row => `${row.serial}: ${row.digest}`).join('\n');
}

interface MemberView {
  readonly serial: string;
  readonly hostname: string;
  readonly role: string;
  readonly sync: string;
}

function members(ha: HaAgent): readonly MemberView[] {
  const own: MemberView = {
    serial: ha.serial(),
    hostname: ha.hostname(),
    role: ha.role(),
    sync: 'in-sync',
  };
  const digest = ha.configurationDigest();
  const peers = ha.knownPeers().map(peer => ({
    serial: peer.serial,
    hostname: peer.hostname,
    role: peer.role,
    sync: peer.configurationDigest === digest ? 'in-sync' : 'out-of-sync',
  }));
  return [own, ...peers];
}

export function renderHaChecksumCluster(ha: HaAgent): string {
  const blocks = members(ha)
    .slice()
    .sort((left, right) => (left.role === 'master' ? -1 : right.role === 'master' ? 1 : 0))
    .map(member => {
      const manage = member.serial === ha.serial() && ha.role() === 'master' ? 1 : 0;
      const digest = member.serial === ha.serial()
        ? ha.configurationDigest()
        : ha.knownPeers().find(peer => peer.serial === member.serial)?.configurationDigest ?? '';
      return [
        `================== ${member.serial} ==================`,
        `is_manage_master()=${manage}, is_root_master()=${manage}`,
        'debugzone',
        `global: ${digest}`,
        `root: ${digest}`,
        '',
        'checksum',
        `global: ${digest}`,
        `root: ${digest}`,
      ].join('\n');
    });
  return blocks.join('\n\n');
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days} days ${hours}:${minutes}:${seconds % 60}`;
}
