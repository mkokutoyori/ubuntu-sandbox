import { electionSentence } from '../../../ha/HaTypes';
import type { HaAgent } from '../../../ha/HaAgent';

export interface HaViewFacts {
  readonly model: string;
  readonly hostname: string;
  readonly now: number;
}

export function renderHaStatus(ha: HaAgent, facts: HaViewFacts): string {
  const config = ha.getConfiguration();
  if (config.mode === 'standalone') return 'HA Health Status: OK\nMode: Standalone';

  const lines = [
    'HA Health Status: OK',
    `Model: ${facts.model}`,
    `Mode: HA ${config.mode.toUpperCase()}`,
    `Group Name: ${config.groupName}`,
    `Group ID: ${config.groupId}`,
    'Debug: 0',
    `Cluster Uptime: ${formatUptime(ha.uptimeMs())}`,
    'Master selected using:',
  ];

  for (const record of ha.elections()) {
    lines.push(`<${stamp(record.at)}> ${electionSentence(record.serial, record.reason)}`);
  }

  lines.push(
    `ses_pickup: ${config.sessionPickup ? 'enable' : 'disable'}, ses_pickup_delay=disable`,
    `override: ${config.override ? 'enable' : 'disable'}`,
    'Configuration Status:',
  );

  for (const member of members(ha)) {
    lines.push(`${member.serial}(updated 1 seconds ago): ${member.sync}`);
  }

  const primary = members(ha).find(member => member.role === 'master');
  const secondary = members(ha).find(member => member.role !== 'master');
  if (primary) {
    lines.push(`Master: ${primary.hostname}, ${primary.serial}, cluster index = 0`);
  }
  if (secondary) {
    lines.push(`Slave : ${secondary.hostname}, ${secondary.serial}, cluster index = 1`);
  }
  lines.push('number of vcluster: 1');

  return lines.join('\n');
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
  const rest = seconds % 60;
  return `${days} days ${hours}:${pad(minutes)}:${pad(rest)}`;
}

function stamp(at: number): string {
  const date = new Date(at);
  return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
