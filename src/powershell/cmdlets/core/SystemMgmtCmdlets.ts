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
    const ack = tasks.registerTask({ taskName: name, taskPath, state: 'Ready' });
    return ack;
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

// ── New-ScheduledTaskTrigger / -Action — silent shims ─────────────────────
// Real PS returns CimInstance objects we don't model. Match the legacy
// behaviour (silent return) so scripts that build then Register-* still work.

export class NewScheduledTaskTriggerCmdlet implements ICmdlet {
  readonly name = 'new-scheduledtasktrigger';
  readonly displayName = 'New-ScheduledTaskTrigger';
  readonly aliases = [] as const;
  execute(): PSValue { return null; }
}
export class NewScheduledTaskActionCmdlet implements ICmdlet {
  readonly name = 'new-scheduledtaskaction';
  readonly displayName = 'New-ScheduledTaskAction';
  readonly aliases = [] as const;
  execute(): PSValue { return null; }
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
  readonly aliases = [] as const;

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
      } as Record<string, PSValue>)) as PSValue;
    }
    // Other classes — defer to the legacy executor (it has a wider catalog).
    throw new PSRuntimeError(`Get-CimInstance ${className} is not recognized in this provider context`);
  }
}
