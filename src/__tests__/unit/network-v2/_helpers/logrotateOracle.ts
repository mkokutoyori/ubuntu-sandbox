import { createHash } from 'node:crypto';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { gunzipText } from '@/network/devices/linux/coreutils/ArchiveCommands';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { SimulationClock, installSimulationClock } from '@/events/SimulationClock';

export interface OracleFile {
  path: string;
  content?: string;
  mode?: number;
  uid?: number;
  gid?: number;
  mtimeAgoSec?: number;
  sizeBytes?: number;
}

export interface OracleScenario {
  name: string;
  dirs?: Array<{ path: string; mode?: number; uid?: number; gid?: number }>;
  files?: OracleFile[];
  symlinks?: Array<{ path: string; target: string }>;
  hardlinks?: Array<{ path: string; target: string }>;
  configs?: OracleFile[];
  state?: string | null;
  statePath?: string;
  stateMode?: number;
  stateAgo?: Record<string, number>;
  args: string[];
  cwd?: string;
  tz?: string;
}

export interface OracleTreeEntry {
  path: string;
  type: 'dir' | 'file' | 'symlink';
  mode: number;
  uid: number;
  gid: number;
  size: number;
  content?: string | null;
  contentSha256?: string;
  gzip?: boolean;
  target?: string;
}

export interface OracleRecord {
  name: string;
  nowSec: number;
  buildNowSec: number;
  tz: string;
  scenario: OracleScenario;
  output: string;
  exit: number;
  tree: OracleTreeEntry[];
}

export const ORACLE_ROOTS = ['/var/log/lr', '/etc/lr', '/var/lib/lr', '/srv/lr'];

export interface OracleLab {
  readonly server: LinuxServer;
  readonly vfs: VirtualFileSystem;
}

function stateText(record: OracleRecord): string | null {
  const scenario = record.scenario;
  if (scenario.state === undefined || scenario.state === null) return null;
  let text = scenario.state;
  for (const [tag, seconds] of Object.entries(scenario.stateAgo ?? {})) {
    const at = new Date((record.buildNowSec - seconds) * 1000);
    text = text.replace(`{${tag}}`, `${at.getUTCFullYear()}-${at.getUTCMonth() + 1}-${at.getUTCDate()}-${at.getUTCHours()}:${at.getUTCMinutes()}:${at.getUTCSeconds()}`);
  }
  return text;
}

export function buildOracleLab(record: OracleRecord): OracleLab {
  installSimulationClock(new SimulationClock({ startPump: () => () => undefined, originMs: record.nowSec * 1000 }));
  const server = new LinuxServer('linux-server', 'LR');
  const vfs = (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
  const scenario = record.scenario;
  for (const dir of scenario.dirs ?? []) {
    vfs.mkdirp(dir.path, dir.mode ?? 0o755, dir.uid ?? 0, dir.gid ?? 0);
    vfs.chmod(dir.path, dir.mode ?? 0o755);
    vfs.chown(dir.path, dir.uid ?? 0, dir.gid ?? 0);
  }
  const put = (file: OracleFile): void => {
    const content = file.content ?? '';
    const missing = file.sizeBytes !== undefined && file.sizeBytes > content.length ? file.sizeBytes - content.length : 0;
    vfs.writeFile(file.path, content + 'x'.repeat(missing), file.uid ?? 0, file.gid ?? 0, 0o022);
    vfs.chmod(file.path, file.mode ?? 0o644);
    vfs.chown(file.path, file.uid ?? 0, file.gid ?? 0);
    const at = (record.buildNowSec - (file.mtimeAgoSec ?? 0)) * 1000;
    vfs.setTimes(file.path, { atime: at, mtime: at });
  };
  for (const file of scenario.files ?? []) put(file);
  for (const link of scenario.symlinks ?? []) vfs.createSymlink(link.path, link.target, 0, 0);
  for (const link of scenario.hardlinks ?? []) vfs.createHardLink(link.path, link.target);
  for (const config of scenario.configs ?? []) put(config);
  const state = stateText(record);
  if (state !== null && scenario.statePath !== undefined) {
    put({ path: scenario.statePath, content: state, mode: scenario.stateMode ?? 0o640 });
  }
  return { server, vfs };
}

export function snapshotOracleTree(vfs: VirtualFileSystem): OracleTreeEntry[] {
  const out: OracleTreeEntry[] = [];
  const walk = (directory: string): void => {
    for (const entry of vfs.listDirectory(directory) ?? []) {
      if (entry.name === '.' || entry.name === '..') continue;
      const path = `${directory}/${entry.name}`;
      const node = entry.inode;
      const base = { path, mode: node.permissions & 0o7777, uid: node.uid, gid: node.gid, size: node.size };
      if (node.type === 'directory') {
        out.push({ ...base, type: 'dir', size: 4096 });
        walk(path);
      } else if (node.type === 'symlink') {
        out.push({ ...base, type: 'symlink', target: node.target });
      } else {
        const raw = vfs.readFile(path) ?? '';
        const plain = gunzipText(raw);
        const text = plain ?? raw;
        out.push({ ...base, type: 'file', gzip: plain !== null ? true : undefined, ...(text.length > 4096 ? { contentSha256: createHash('sha256').update(text).digest('hex') } : { content: text }) });
      }
    }
  };
  for (const root of ORACLE_ROOTS) {
    if (vfs.exists(root)) walk(root);
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export const normaliseStateSeconds = (text: string | undefined): string | undefined =>
  text?.replace(/(\d+-\d+-\d+-\d+:\d+):\d+/g, '$1:*');

export async function runOracleCommand(lab: OracleLab, record: OracleRecord): Promise<{ output: string; exit: number }> {
  const quoted = record.scenario.args.map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`).join(' ');
  const cwd = record.scenario.cwd ?? '/';
  if (record.tz !== 'UTC') await lab.server.executeCommand(`timedatectl set-timezone ${record.tz}`);
  const raw = await lab.server.executeCommand(`cd ${cwd} && logrotate ${quoted}; echo "__exit:$?"`);
  const match = /\n?__exit:(\d+)\s*$/.exec(raw);
  return { output: raw.slice(0, match === null ? raw.length : match.index) + (match !== null && raw.slice(0, match.index).endsWith('\n') ? '' : ''), exit: match === null ? -1 : Number(match[1]) };
}
