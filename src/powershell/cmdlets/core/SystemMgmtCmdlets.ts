/**
 * SystemMgmtCmdlets — scheduled tasks + disks/volumes + Get-CimInstance shim.
 *
 * Providers: ctx.providers.scheduledTasks, ctx.providers.disks. CIM cycles
 * back through ctx.providers.processes / ctx.providers.services for the few
 * classes the simulator actually supports.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type {
  IScheduledTaskProvider, IDiskProvider, ScheduledTaskInfo,
} from '@/powershell/providers/PSProviders';
import { LICENSE_STATUS_CODE } from '@/network/devices/windows/licensing/LicensingState';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { SubnetMask } from '@/network/core/types';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';

function requireTasks(ctx: CmdletContext): IScheduledTaskProvider {
  if (!ctx.providers.scheduledTasks) {
    throw new PSRuntimeError('Scheduled-task cmdlets are not recognized in this provider context');
  }
  return ctx.providers.scheduledTasks;
}
function requireDisks(ctx: CmdletContext): IDiskProvider {
  if (!ctx.providers.disks) {
    throw new PSRuntimeError('Disk cmdlets are not recognized in this provider context');
  }
  return ctx.providers.disks;
}

function taskToPSObject(t: ScheduledTaskInfo): Record<string, PSValue> {
  return { TaskPath: t.taskPath, TaskName: t.taskName, State: t.state };
}

// ── Get-Counter (per-process counter paths) ───────────────────────────────
//
// The terminal-session Get-Counter (GetCounter.ts) handles system-wide
// counters (\Processor, \Memory, \Network Interface, …) as a plain-text
// intercept and never touches the object pipeline. Scripts that need to
// capture a numeric sample into a variable — `(Get-Counter ...).CounterSamples`
// — need a real cmdlet; this one covers `\Process(<name>)\<counter>` paths,
// the ones perf/leak-monitoring scripts actually sample.

const PROCESS_COUNTER_RE = /^\\Process\(([^)]+)\)\\(.+)$/i;

function processCounterCookedValue(
  p: { wsK: number; cpuPercent: number; handles: number; threads: number },
  counterName: string,
): number | null {
  const c = counterName.trim().toLowerCase();
  if (c === 'working set - private' || c === 'working set') return Math.floor(p.wsK) * 1024;
  if (c === '% processor time') return Math.round(p.cpuPercent * 100) / 100;
  if (c === 'handle count') return p.handles;
  if (c === 'thread count') return p.threads;
  return null;
}

export class GetCounterCmdlet implements ICmdlet {
  readonly name = 'get-counter';
  readonly displayName = 'Get-Counter';
  readonly aliases = [] as const;
  readonly parameters = ['Counter', 'SampleInterval', 'MaxSamples', 'Continuous'] as const;

  execute(ctx: CmdletContext): PSValue {
    const raw = ctx.named['counter'] ?? ctx.positional[0];
    if (raw === undefined || raw === null) {
      ctx.emitError('Get-Counter: -Counter is required');
      return null;
    }
    const paths = Array.isArray(raw) ? raw.map(psValueToString) : [psValueToString(raw)];
    const procs = ctx.providers.processes;
    const samples: Record<string, PSValue>[] = [];
    for (const path of paths) {
      const m = PROCESS_COUNTER_RE.exec(path);
      if (!m) { ctx.emitError(`Get-Counter: unsupported counter path "${path}"`); continue; }
      const [, instanceName, counterName] = m;
      if (!procs) { ctx.emitError(commandNotFoundMessage('Get-Counter')); continue; }
      const p = procs.getProcess(instanceName);
      if (!p) { ctx.emitError(`Get-Counter: could not find the process "${instanceName}"`); continue; }
      const value = processCounterCookedValue(p, counterName);
      if (value === null) { ctx.emitError(`Get-Counter: unsupported counter "${counterName}"`); continue; }
      samples.push({ Path: path.toLowerCase(), InstanceName: instanceName.toLowerCase(), CookedValue: value });
    }
    return {
      Timestamp: new Date(),
      CounterSamples: samples,
    } as Record<string, PSValue>;
  }
}

// ── Get-ScheduledTask ─────────────────────────────────────────────────────

export class GetScheduledTaskCmdlet implements ICmdlet {
  readonly name = 'get-scheduledtask';
  readonly displayName = 'Get-ScheduledTask';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const tasks = requireTasks(ctx);
    const filter = ctx.named['taskname']
      ? psValueToString(ctx.named['taskname'])
      : ctx.positional[0] ? psValueToString(ctx.positional[0]) : undefined;
    return tasks.listTasks(filter).map(taskToPSObject) as PSValue;
  }
}

// ── Register-ScheduledTask ────────────────────────────────────────────────

export class RegisterScheduledTaskCmdlet implements ICmdlet {
  readonly name = 'register-scheduledtask';
  readonly displayName = 'Register-ScheduledTask';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const tasks = requireTasks(ctx);
    const name = psValueToString(ctx.named['taskname'] ?? '');
    if (!name) { ctx.emitError('Register-ScheduledTask requires -TaskName'); return null; }
    const taskPath = psValueToString(ctx.named['taskpath'] ?? '\\');

    const actionRaw = ctx.named['action'];
    const action = (Array.isArray(actionRaw) ? actionRaw[0] : actionRaw) as ScheduledTaskAction | undefined;
    const command = action ? [action.Execute, action.Argument].filter(Boolean).join(' ') : undefined;

    const triggerRaw = ctx.named['trigger'];
    const trigger = (Array.isArray(triggerRaw) ? triggerRaw[0] : triggerRaw) as ScheduledTaskTrigger | undefined;

    const principalRaw = ctx.named['principal'] as ScheduledTaskPrincipal | undefined;
    const principal = principalRaw
      ? { userId: principalRaw.UserId, runLevel: principalRaw.RunLevel }
      : undefined;

    let runAt: Date | undefined;
    let intervalMs: number | undefined;
    if (trigger) {
      const deviceNow = tasks.now?.() ?? new Date();
      // `Get-Date` now reflects the device's own simulated clock (not real
      // wall time), so a `-At (Get-Date)` argument already IS the correct
      // simulated instant — no rebasing against the real clock needed.
      if (trigger.At instanceof Date) {
        runAt = trigger.At;
      } else {
        runAt = deviceNow;
      }
      const repMs = Number(trigger.RepetitionIntervalMs ?? 0);
      if (repMs > 0) intervalMs = repMs;
      // Un déclencheur quotidien ou hebdomadaire revient de lui-même :
      // sans intervalle, la tâche ne serait partie qu'une fois.
      else if (trigger.Daily) intervalMs = 86_400_000 * (trigger.DaysInterval ?? 1);
      else if (trigger.Weekly) intervalMs = 7 * 86_400_000 * (trigger.WeeksInterval ?? 1);
      // `-AtStartup` et `-AtLogOn` dépendent d'un événement que rien ici
      // ne produit : la tâche est enregistrée, sans heure de départ.
      if (trigger.AtStartup || trigger.AtLogOn) runAt = undefined;
    }

    const ack = tasks.registerTask({
      taskName: name, taskPath, state: 'Ready', command, runAt, intervalMs, principal,
      runAsUser: principal?.userId,
      ...describeTrigger(trigger, runAt),
    });
    return ack;
  }
}

/**
 * Traduit le déclencheur en les champs que `schtasks /query /v` imprime.
 * Sans cela une tâche posée par `Register-ScheduledTask` se relisait avec
 * un « Schedule Type: N/A » alors que son heure de départ, elle, était bien
 * là — le détail manquait à la vue, pas à la tâche.
 */
function describeTrigger(
  trigger: ScheduledTaskTrigger | undefined, runAt: Date | undefined,
): Partial<ScheduledTaskInfo> {
  if (!trigger) return {};
  const scheduleType = trigger.Daily ? 'Daily'
    : trigger.Weekly ? 'Weekly'
    : trigger.AtStartup ? 'At system start up'
    : trigger.AtLogOn ? 'At logon time'
    : 'One Time Only';
  const out: Partial<ScheduledTaskInfo> = { scheduleType };
  if (runAt instanceof Date) {
    out.startTime = `${String(runAt.getHours()).padStart(2, '0')}:${String(runAt.getMinutes()).padStart(2, '0')}`;
    out.startDate = runAt;
  }
  if (trigger.Daily) out.days = `Every ${trigger.DaysInterval ?? 1} day(s)`;
  else if (trigger.Weekly && trigger.DaysOfWeek) out.days = String(trigger.DaysOfWeek).toUpperCase();
  return out;
}

interface ScheduledTaskAction { Execute?: string; Argument?: string; WorkingDirectory?: string }
interface ScheduledTaskTrigger {
  Once?: boolean; Daily?: boolean; Weekly?: boolean;
  AtStartup?: boolean; AtLogOn?: boolean;
  At?: Date; RepetitionIntervalMs?: number; RepetitionDurationMs?: number;
  DaysInterval?: number; WeeksInterval?: number; DaysOfWeek?: string;
}
interface ScheduledTaskPrincipal { UserId: string; LogonType: string; RunLevel: string }

// ── Get-ScheduledTaskInfo / Start / Stop / Enable / Disable / Set ─────────
//
// Les cinq verbes qui manquaient au module ScheduledTasks. Chacun agit
// sur le magasin partagé avec `schtasks`, si bien qu'une tâche
// désactivée par la cmdlet se lit désactivée en ligne de commande.

/** Le nom visé, en `-TaskName` ou en positionnel. */
function taskNameOf(ctx: CmdletContext): string {
  return psValueToString(ctx.named['taskname'] ?? ctx.positional[0] ?? '');
}

function oneTask(ctx: CmdletContext, verb: string): ScheduledTaskInfo | null {
  const name = taskNameOf(ctx);
  if (!name) { ctx.emitError(`${verb} requires -TaskName`); return null; }
  const found = requireTasks(ctx).listTasks(name)[0];
  if (!found) { ctx.emitError(`${verb} : No MSFT_ScheduledTask objects found with property 'TaskName' equal to '${name}'.`); return null; }
  return found;
}

export class GetScheduledTaskInfoCmdlet implements ICmdlet {
  readonly name = 'get-scheduledtaskinfo';
  readonly displayName = 'Get-ScheduledTaskInfo';
  readonly parameters = ['TaskName', 'TaskPath'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const t = oneTask(ctx, 'Get-ScheduledTaskInfo');
    if (!t) return null;
    return {
      TaskName: t.taskName,
      TaskPath: t.taskPath,
      // `LastTaskResult` vaut 267011 (« la tâche n'a pas encore tourné »)
      // tant qu'aucune exécution n'a eu lieu : c'est le code du vrai.
      LastRunTime: (t.lastRunTime ?? null) as unknown as PSValue,
      LastTaskResult: t.lastRunTime ? 0 : 267011,
      NextRunTime: (t.runAt ?? null) as unknown as PSValue,
      NumberOfMissedRuns: t.missedRuns ?? 0,
    } as Record<string, PSValue>;
  }
}

export class StartScheduledTaskCmdlet implements ICmdlet {
  readonly name = 'start-scheduledtask';
  readonly displayName = 'Start-ScheduledTask';
  readonly parameters = ['TaskName', 'TaskPath'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const t = oneTask(ctx, 'Start-ScheduledTask');
    if (!t) return null;
    const tasks = requireTasks(ctx);
    if (!tasks.runTask) { ctx.emitError(commandNotFoundMessage('Start-ScheduledTask')); return null; }
    const err = tasks.runTask(t.taskName);
    if (err) ctx.emitError(err);
    return null;
  }
}

export class StopScheduledTaskCmdlet implements ICmdlet {
  readonly name = 'stop-scheduledtask';
  readonly displayName = 'Stop-ScheduledTask';
  readonly parameters = ['TaskName', 'TaskPath'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    // Arrêter une tâche qui ne tourne pas n'est pas une erreur pour le
    // vrai non plus : l'instance visée n'existe simplement pas.
    oneTask(ctx, 'Stop-ScheduledTask');
    return null;
  }
}

/** `Enable-` et `Disable-` ne diffèrent que par l'état qu'ils posent. */
class ToggleScheduledTaskCmdlet implements ICmdlet {
  readonly aliases = [] as const;
  readonly parameters = ['TaskName', 'TaskPath'] as const;
  constructor(
    readonly name: string,
    readonly displayName: string,
    private readonly state: ScheduledTaskInfo['state'],
  ) {}

  execute(ctx: CmdletContext): PSValue {
    const t = oneTask(ctx, this.displayName);
    if (!t) return null;
    const tasks = requireTasks(ctx);
    if (!tasks.updateTask) { ctx.emitError(commandNotFoundMessage(this.displayName)); return null; }
    const err = tasks.updateTask(t.taskName, { state: this.state });
    if (err) { ctx.emitError(err); return null; }
    return { TaskPath: t.taskPath, TaskName: t.taskName, State: this.state } as Record<string, PSValue>;
  }
}

export class EnableScheduledTaskCmdlet extends ToggleScheduledTaskCmdlet {
  constructor() { super('enable-scheduledtask', 'Enable-ScheduledTask', 'Ready'); }
}
export class DisableScheduledTaskCmdlet extends ToggleScheduledTaskCmdlet {
  constructor() { super('disable-scheduledtask', 'Disable-ScheduledTask', 'Disabled'); }
}

export class SetScheduledTaskCmdlet implements ICmdlet {
  readonly name = 'set-scheduledtask';
  readonly displayName = 'Set-ScheduledTask';
  readonly parameters = ['TaskName', 'TaskPath', 'Action', 'Trigger', 'Principal'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const t = oneTask(ctx, 'Set-ScheduledTask');
    if (!t) return null;
    const tasks = requireTasks(ctx);
    if (!tasks.updateTask) { ctx.emitError(commandNotFoundMessage('Set-ScheduledTask')); return null; }
    const patch: Partial<ScheduledTaskInfo> = {};
    const actionRaw = ctx.named['action'];
    const action = (Array.isArray(actionRaw) ? actionRaw[0] : actionRaw) as ScheduledTaskAction | undefined;
    if (action) patch.command = [action.Execute, action.Argument].filter(Boolean).join(' ');
    const triggerRaw = ctx.named['trigger'];
    const trigger = (Array.isArray(triggerRaw) ? triggerRaw[0] : triggerRaw) as ScheduledTaskTrigger | undefined;
    if (trigger?.At instanceof Date) patch.runAt = trigger.At;
    const err = tasks.updateTask(t.taskName, patch);
    if (err) { ctx.emitError(err); return null; }
    return { TaskPath: t.taskPath, TaskName: t.taskName, State: t.state } as Record<string, PSValue>;
  }
}

// ── Unregister-ScheduledTask ──────────────────────────────────────────────

export class UnregisterScheduledTaskCmdlet implements ICmdlet {
  readonly name = 'unregister-scheduledtask';
  readonly displayName = 'Unregister-ScheduledTask';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const tasks = requireTasks(ctx);
    const name = psValueToString(ctx.named['taskname'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('Unregister-ScheduledTask requires -TaskName'); return null; }
    const msg = tasks.unregisterTask(name);
    if (msg) ctx.emitError(msg);
    return null;
  }
}

// ── New-ScheduledTaskTrigger / -Action / -Principal ───────────────────────

export class NewScheduledTaskTriggerCmdlet implements ICmdlet {
  readonly name = 'new-scheduledtasktrigger';
  readonly displayName = 'New-ScheduledTaskTrigger';
  readonly parameters = ['Once', 'At', 'RepetitionInterval', 'RepetitionDuration', 'Daily', 'Weekly', 'AtStartup', 'AtLogOn', 'DaysInterval', 'WeeksInterval', 'DaysOfWeek'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const rep = ctx.named['repetitioninterval'] as Record<string, PSValue> | undefined;
    const dur = ctx.named['repetitionduration'] as Record<string, PSValue> | undefined;
    const daily = ctx.named['daily'] === true;
    const weekly = ctx.named['weekly'] === true;
    const atStartup = ctx.named['atstartup'] === true;
    const atLogon = ctx.named['atlogon'] === true;
    // `Once` était rendu vrai dès que `-Once` était absent, si bien qu'un
    // `-Daily` explicite ressortait en déclencheur ponctuel.
    const anyKind = daily || weekly || atStartup || atLogon;
    const once = ctx.named['once'] === true || !anyKind;
    const at = parseTriggerAt(ctx.named['at'], ctx);
    const out: Record<string, PSValue> = {
      Once: once, Daily: daily, Weekly: weekly,
      AtStartup: atStartup, AtLogOn: atLogon,
      At: at as unknown as PSValue,
      RepetitionIntervalMs: rep ? Number(rep['TotalMilliseconds'] ?? 0) : 0,
      RepetitionDurationMs: dur ? Number(dur['TotalMilliseconds'] ?? 0) : 0,
    };
    if (daily) out.DaysInterval = Number(psValueToString(ctx.named['daysinterval'] ?? '1')) || 1;
    if (weekly) {
      out.WeeksInterval = Number(psValueToString(ctx.named['weeksinterval'] ?? '1')) || 1;
      const dow = ctx.named['daysofweek'];
      if (dow !== undefined) {
        out.DaysOfWeek = (Array.isArray(dow) ? dow.map(psValueToString) : [psValueToString(dow)]).join(',');
      }
    }
    return out;
  }
}

/**
 * `-At` accepte l'heure telle qu'on l'écrit : `3am`, `3:30pm`, `15:00`,
 * ou un `[datetime]`. `new Date('3am')` rend une date invalide, et le
 * déclencheur portait alors une date de 2001.
 *
 * Une heure sans date se rapporte au jour de la machine, et bascule au
 * lendemain si elle est déjà passée — c'est ce que fait le vrai.
 */
function parseTriggerAt(raw: PSValue | undefined, ctx: CmdletContext): Date | undefined {
  if (raw === undefined) return undefined;
  if (raw instanceof Date) return raw;
  const text = psValueToString(raw).trim();
  const now = ctx.providers.scheduledTasks?.now?.() ?? new Date();
  const clock = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?$/i.exec(text);
  if (clock) {
    let hour = Number(clock[1]);
    const suffix = clock[4]?.toLowerCase();
    if (suffix === 'pm' && hour < 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
    const at = new Date(now);
    at.setHours(hour, Number(clock[2] ?? 0), Number(clock[3] ?? 0), 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export class NewScheduledTaskActionCmdlet implements ICmdlet {
  readonly name = 'new-scheduledtaskaction';
  readonly displayName = 'New-ScheduledTaskAction';
  readonly parameters = ['Execute', 'Argument', 'WorkingDirectory'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    return {
      Execute: psValueToString(ctx.named['execute'] ?? ''),
      Argument: ctx.named['argument'] !== undefined ? psValueToString(ctx.named['argument']) : '',
      WorkingDirectory: ctx.named['workingdirectory'] !== undefined ? psValueToString(ctx.named['workingdirectory']) : '',
    } as Record<string, PSValue>;
  }
}

export class NewScheduledTaskPrincipalCmdlet implements ICmdlet {
  readonly name = 'new-scheduledtaskprincipal';
  readonly displayName = 'New-ScheduledTaskPrincipal';
  readonly parameters = ['UserId', 'LogonType', 'RunLevel'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    return {
      UserId: psValueToString(ctx.named['userid'] ?? ''),
      LogonType: psValueToString(ctx.named['logontype'] ?? 'Interactive'),
      RunLevel: psValueToString(ctx.named['runlevel'] ?? 'Limited'),
    } as Record<string, PSValue>;
  }
}

// ── Get-Disk ──────────────────────────────────────────────────────────────

export class GetDiskCmdlet implements ICmdlet {
  readonly name = 'get-disk';
  readonly displayName = 'Get-Disk';
  readonly parameters = ['Number', 'FriendlyName', 'UniqueId', 'SerialNumber'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const rows = requireDisks(ctx).listDisks().map(d => ({
      Number:           d.number,
      FriendlyName:     d.friendlyName,
      SerialNumber:     d.serialNumber,
      OperationalStatus: d.operationalStatus,
      TotalSize:        gigabytes(d.size),
      PartitionStyle:   d.partitionStyle,
      IsBoot:           d.isBoot,
      IsSystem:         d.isSystem,
      UniqueId:         d.uniqueId,
    } as Record<string, PSValue>));

    const filters: Array<[string, string]> = [
      ['Number', 'number'], ['FriendlyName', 'friendlyname'],
      ['UniqueId', 'uniqueid'], ['SerialNumber', 'serialnumber'],
    ];
    let kept = rows;
    for (const [property, parameter] of filters) {
      const asked = ctx.named[parameter] ?? (parameter === 'number' ? ctx.positional[0] : undefined);
      if (asked === undefined || asked === null) continue;
      const wanted = psValueToString(asked).replace(/^["']|["']$/g, '');
      kept = kept.filter(r => psValueToString(r[property]).toLowerCase() === wanted.toLowerCase());
      if (kept.length === 0) {
        ctx.emitError(`Get-Disk : No MSFT_Disk objects found with ${property} = ${wanted}.`);
        return null;
      }
    }
    return kept as PSValue;
  }
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

// ── Get-Volume ────────────────────────────────────────────────────────────

export class GetVolumeCmdlet implements ICmdlet {
  readonly name = 'get-volume';
  readonly displayName = 'Get-Volume';
  readonly parameters = ['DriveLetter', 'FileSystemLabel', 'FileSystem', 'FileSystemType'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const rows = requireDisks(ctx).listVolumes().map(v => ({
      DriveLetter:       v.driveLetter,
      FriendlyName:      v.fileSystemLabel,
      FileSystem:        v.fileSystem,
      FileSystemType:    v.fileSystem,
      FileSystemLabel:   v.fileSystemLabel,
      DriveType:         v.driveType,
      HealthStatus:      v.healthStatus,
      OperationalStatus: v.operationalStatus,
      SizeRemaining:     gigabytes(v.sizeRemaining),
      Size:              gigabytes(v.size),
    } as Record<string, PSValue>));

    const fileSystem = ctx.named['filesystem'] ?? ctx.named['filesystemtype'];
    if (fileSystem !== undefined && fileSystem !== null) {
      const wanted = psValueToString(fileSystem).toUpperCase();
      const byFs = rows.filter(r => psValueToString(r['FileSystem']).toUpperCase() === wanted);
      if (byFs.length === 0) {
        ctx.emitError(`Get-Volume : No MSFT_Volume objects found with FileSystemType = ${wanted}.`);
        return null;
      }
      return byFs as PSValue;
    }
    const asked = psValueToString(ctx.named['driveletter'] ?? ctx.positional[0] ?? '')
      .replace(/:$/, '').toUpperCase();
    if (!asked) return rows as PSValue;
    const kept = rows.filter(r => psValueToString(r['DriveLetter']).toUpperCase() === asked);
    if (kept.length === 0) {
      ctx.emitError(`Get-Volume : No MSFT_Volume objects found with DriveLetter = ${asked}.`);
      return null;
    }
    return kept as PSValue;
  }
}

export class InitializeDiskCmdlet implements ICmdlet {
  readonly name = 'initialize-disk';
  readonly displayName = 'Initialize-Disk';
  readonly parameters = ['Number', 'PartitionStyle', 'PassThru'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    ctx.emitError('Initialize-Disk : partitioning is not supported in this simulator: '
      + 'a disk carries no partition table.');
    return null;
  }
}

export class FormatVolumeCmdlet implements ICmdlet {
  readonly name = 'format-volume';
  readonly displayName = 'Format-Volume';
  readonly parameters = ['DriveLetter', 'FileSystem', 'NewFileSystemLabel', 'Full', 'Force'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    ctx.emitError('Format-Volume : formatting is not supported in this simulator: '
      + 'a volume is the file system itself, and erasing it would erase the machine.');
    return null;
  }
}

// ── Get-CimInstance (thin shim for the few classes scripts actually ask) ──

export class GetCimInstanceCmdlet implements ICmdlet {
  readonly name = 'get-ciminstance';
  readonly displayName = 'Get-CimInstance';
  // Get-WmiObject/gwmi are the legacy WMI names for the same query surface —
  // an object pipeline (Where-Object/Select-Object/…) needs the real cmdlet,
  // not the legacy string-formatting executor.
  readonly aliases = ['get-wmiobject', 'gwmi'] as const;

  execute(ctx: CmdletContext): PSValue {
    const className = psValueToString(
      ctx.named['classname'] ?? ctx.positional[0] ?? '',
    ).toLowerCase();
    if (!className) { ctx.emitError('Get-CimInstance requires -ClassName'); return null; }

    // Win32_Process → forward to the Process provider.
    if (className === 'win32_process') {
      const procs = ctx.providers.processes;
      if (!procs) throw new PSRuntimeError(commandNotFoundMessage('Get-CimInstance Win32_Process'));
      return procs.listProcesses().map(p => ({
        ProcessId:  p.pid,
        Name:       p.name,
        ParentProcessId: p.ppid,
        SessionId:  p.sessionId,
        ExecutablePath: '',
        CommandLine: '',
      } as Record<string, PSValue>)) as PSValue;
    }
    // Win32_Service → forward to the Service provider.
    if (className === 'win32_service') {
      const svcs = ctx.providers.services;
      if (!svcs) throw new PSRuntimeError(commandNotFoundMessage('Get-CimInstance Win32_Service'));
      return svcs.listServices().map(s => ({
        Name:        s.name,
        DisplayName: s.displayName,
        State:       s.state,
        Status:      s.state,
        StartMode:   s.startType,
        PathName:    s.binaryPath,
        StartName:   s.account,
        ProcessId:   s.processId,
      } as Record<string, PSValue>)) as PSValue;
    }
    // Win32_PerfFormattedData_PerfProc_Process → per-process performance
    // counters (handles/threads/private working set/CPU), forwarded to the
    // Process provider like Win32_Process above.
    if (className === 'win32_perfformatteddata_perfproc_process') {
      const procs = ctx.providers.processes;
      if (!procs) throw new PSRuntimeError(commandNotFoundMessage('Get-CimInstance Win32_PerfFormattedData_PerfProc_Process'));
      return procs.listProcesses().map(p => ({
        Name:                 p.name.replace(/\.exe$/i, ''),
        IDProcess:             p.pid,
        HandleCount:           p.handles,
        ThreadCount:           p.threads,
        WorkingSetPrivate:     Math.floor(p.wsK) * 1024,
        WorkingSet:            Math.floor(p.wsK) * 1024,
        PercentProcessorTime:  Math.round(p.cpuPercent),
      } as Record<string, PSValue>)) as PSValue;
    }
    // SoftwareLicensingProduct → forward to the licensing provider (PRD-Windows-Server-Advanced.md §5 P21).
    if (className === 'softwarelicensingproduct') {
      const licensing = ctx.providers.licensing;
      if (!licensing) throw new PSRuntimeError(commandNotFoundMessage('Get-CimInstance SoftwareLicensingProduct'));
      const state = licensing.getState();
      const key = licensing.getProductKey();
      return [{
        Name: licensing.getProductName(),
        Description: `${licensing.getProductName()} edition`,
        PartialProductKey: key ? key.slice(-5) : '',
        LicenseStatus: LICENSE_STATUS_CODE[state],
      } as Record<string, PSValue>] as PSValue;
    }
    // Win32_NetworkAdapter → forward to the Network provider.
    if (className === 'win32_networkadapter') {
      const net = ctx.providers.network;
      if (!net) throw new PSRuntimeError(commandNotFoundMessage('Get-CimInstance Win32_NetworkAdapter'));
      return net.getAdapters().map(a => ({
        Name:              a.name,
        NetConnectionID:   a.name,
        Description:       a.interfaceDescription,
        Index:             a.ifIndex,
        InterfaceIndex:    a.ifIndex,
        MACAddress:        a.macAddress,
        Speed:             a.linkSpeed,
        NetEnabled:        a.status.toLowerCase() === 'up',
        NetConnectionStatus: a.status.toLowerCase() === 'up' ? 2 : 7,
      } as Record<string, PSValue>)) as PSValue;
    }
    // Win32_NetworkAdapterConfiguration → join adapter + IP + DNS + gateway,
    // all already real on the Network provider (used by Get-NetAdapter/
    // Get-NetIPAddress); this class is just a per-adapter merge of them.
    if (className === 'win32_networkadapterconfiguration') {
      const net = ctx.providers.network;
      if (!net) throw new PSRuntimeError(commandNotFoundMessage('Get-CimInstance Win32_NetworkAdapterConfiguration'));
      const gateway = net.getDefaultGateway();
      return net.getAdapters().map(a => {
        const ips = net.getIPAddresses(a.name);
        return {
          Description:      a.interfaceDescription,
          Index:            a.ifIndex,
          InterfaceIndex:   a.ifIndex,
          MACAddress:       a.macAddress,
          IPEnabled:        ips.length > 0,
          DHCPEnabled:      net.isDHCPConfigured(a.name) || ips.length === 0,
          IPAddress:        ips.map(ip => ip.ipAddress),
          IPSubnet:         ips.map(ip => SubnetMask.fromCIDR(ip.prefixLength).toString()),
          DefaultIPGateway: gateway ? [gateway] : [],
          DNSServerSearchOrder: net.getDnsServers(a.name),
        } as Record<string, PSValue>;
      }) as PSValue;
    }
    // Win32_UserAccount / Win32_Group → forward to the User provider.
    if (className === 'win32_useraccount') {
      const users = ctx.providers.users;
      if (!users) throw new PSRuntimeError(commandNotFoundMessage('Get-CimInstance Win32_UserAccount'));
      return users.listUsers().map(u => ({
        Name:        u.name,
        FullName:    u.fullName,
        Description: u.description,
        SID:         u.sid,
        Disabled:    !u.enabled,
        PasswordRequired: u.passwordRequired,
        LocalAccount: true,
      } as Record<string, PSValue>)) as PSValue;
    }
    if (className === 'win32_group') {
      const users = ctx.providers.users;
      if (!users) throw new PSRuntimeError(commandNotFoundMessage('Get-CimInstance Win32_Group'));
      return users.listGroups().map(g => ({
        Name:        g.name,
        Description: g.description,
        SID:         g.sid,
        LocalAccount: true,
      } as Record<string, PSValue>)) as PSValue;
    }
    if (className === 'win32_computersystem') {
      const hostname = ctx.providers.network?.getHostname?.() ?? '';
      const membership = ctx.providers.computer?.getDomainInfo?.() ?? null;
      const registry = ctx.providers.registry;
      const values = registry?.getItemPropertyValues?.(CURRENT_VERSION_KEY) ?? {};
      return {
        Name:                hostname,
        DNSHostName:         hostname,
        Domain:              membership?.dnsName ?? 'WORKGROUP',
        PartOfDomain:        membership !== null,
        Workgroup:           membership === null ? 'WORKGROUP' : null,
        DomainRole:          membership === null ? 0 : 1,
        Manufacturer:        'Microsoft Corporation',
        Model:               'Virtual Machine',
        PrimaryOwnerName:    String(values['RegisteredOwner'] ?? 'User'),
        SystemType:          'x64-based PC',
        TotalPhysicalMemory: 8589934592,
      } as Record<string, PSValue>;
    }
    if (className === 'win32_operatingsystem') {
      const registry = ctx.providers.registry;
      const values = registry?.getItemPropertyValues?.(CURRENT_VERSION_KEY) ?? {};
      const hostname = ctx.providers.network?.getHostname?.() ?? '';
      const build = String(values['CurrentBuildNumber'] ?? '');
      const currentVersion = String(values['CurrentVersion'] ?? '10.0');
      return {
        Caption:         `Microsoft ${String(values['ProductName'] ?? 'Windows')}`,
        Version:         build ? `${currentVersion}.${build}` : currentVersion,
        BuildNumber:     build,
        CSName:          hostname,
        InstallationType: String(values['InstallationType'] ?? 'Client'),
        OSArchitecture:  '64-bit',
        SystemDirectory: 'C:\\Windows\\system32',
        WindowsDirectory: 'C:\\Windows',
        RegisteredUser:  String(values['RegisteredOwner'] ?? 'User'),
        Organization:    String(values['RegisteredOrganization'] ?? ''),
        SerialNumber:    String(values['ProductId'] ?? ''),
      } as Record<string, PSValue>;
    }
    throw new PSRuntimeError(`Get-CimInstance : Invalid class "${className}"`);
  }
}

const CURRENT_VERSION_KEY = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';

export class GetComputerInfoCmdlet implements ICmdlet {
  readonly name = 'get-computerinfo';
  readonly displayName = 'Get-ComputerInfo';
  readonly aliases = [] as const;
  readonly description = 'Gets a consolidated object of system and operating system properties.';
  readonly parameters = ['Property'] as const;

  execute(ctx: CmdletContext): PSValue {
    const registry = ctx.providers.registry;
    const values = registry?.getItemPropertyValues?.(CURRENT_VERSION_KEY) ?? {};
    const read = (key: string, fallback: string): string =>
      values[key] === undefined ? fallback : String(values[key]);
    const productName = read('ProductName', 'Windows 10 Pro');
    const buildNumber = read('CurrentBuildNumber', '22631');
    const build = `10.0.${buildNumber}`;
    const hostname = ctx.providers.network?.getHostname?.() ?? '';
    const row: Record<string, PSValue> = {
      WindowsProductName: productName,
      WindowsEditionId: read('EditionID', 'Professional'),
      WindowsInstallationType: read('InstallationType', 'Client'),
      WindowsVersion: read('ReleaseId', '2009'),
      WindowsBuildLabEx: `${buildNumber}.1.amd64fre.ni_release`,
      OsName: `Microsoft ${productName}`,
      OsVersion: build,
      OsHardwareAbstractionLayer: build,
      CsDNSHostName: hostname,
      CsName: hostname,
    };
    const wanted = ctx.named['property'] ?? ctx.positional[0];
    if (wanted === undefined) return row as PSValue;
    const names = (Array.isArray(wanted) ? wanted : [wanted]).map(v => String(v));
    const picked: Record<string, PSValue> = {};
    for (const key of Object.keys(row)) {
      if (names.some(n => n.toLowerCase() === key.toLowerCase())) picked[key] = row[key];
    }
    return picked as PSValue;
  }
}
