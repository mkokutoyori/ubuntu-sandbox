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
import { psValueToString } from '@/powershell/runtime/PSExpansion';

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
      if (!procs) { ctx.emitError('Get-Counter is not recognized in this provider context'); continue; }
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
    }

    const ack = tasks.registerTask({
      taskName: name, taskPath, state: 'Ready', command, runAt, intervalMs, principal,
    });
    return ack;
  }
}

interface ScheduledTaskAction { Execute?: string; Argument?: string; WorkingDirectory?: string }
interface ScheduledTaskTrigger { Once?: boolean; At?: Date; RepetitionIntervalMs?: number; RepetitionDurationMs?: number }
interface ScheduledTaskPrincipal { UserId: string; LogonType: string; RunLevel: string }

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
  readonly parameters = ['Once', 'At', 'RepetitionInterval', 'RepetitionDuration', 'Daily', 'AtStartup', 'AtLogOn'] as const;
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const atRaw = ctx.named['at'];
    const at = atRaw instanceof Date ? atRaw : (atRaw !== undefined ? new Date(psValueToString(atRaw)) : undefined);
    const rep = ctx.named['repetitioninterval'] as Record<string, PSValue> | undefined;
    const dur = ctx.named['repetitionduration'] as Record<string, PSValue> | undefined;
    return {
      Once: ctx.named['once'] === true || ctx.named['once'] === undefined,
      At: at as unknown as PSValue,
      RepetitionIntervalMs: rep ? Number(rep['TotalMilliseconds'] ?? 0) : 0,
      RepetitionDurationMs: dur ? Number(dur['TotalMilliseconds'] ?? 0) : 0,
    } as Record<string, PSValue>;
  }
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
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    return requireDisks(ctx).listDisks().map(d => ({
      Number:           d.number,
      FriendlyName:     d.friendlyName,
      Size:             d.size,
      PartitionStyle:   d.partitionStyle,
      OperationalStatus: d.operationalStatus,
    } as Record<string, PSValue>)) as PSValue;
  }
}

// ── Get-Volume ────────────────────────────────────────────────────────────

export class GetVolumeCmdlet implements ICmdlet {
  readonly name = 'get-volume';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    return requireDisks(ctx).listVolumes().map(v => ({
      DriveLetter:     v.driveLetter,
      FileSystemLabel: v.fileSystemLabel,
      FileSystem:      v.fileSystem,
      SizeRemaining:   v.sizeRemaining,
      Size:            v.size,
      DriveType:       v.driveType,
    } as Record<string, PSValue>)) as PSValue;
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
      if (!procs) throw new PSRuntimeError('Get-CimInstance Win32_Process is not recognized in this context');
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
      if (!svcs) throw new PSRuntimeError('Get-CimInstance Win32_Service is not recognized in this context');
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
      if (!procs) throw new PSRuntimeError('Get-CimInstance Win32_PerfFormattedData_PerfProc_Process is not recognized in this context');
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
    // Other classes — defer to the legacy executor (it has a wider catalog).
    throw new PSRuntimeError(`Get-CimInstance ${className} is not recognized in this provider context`);
  }
}
