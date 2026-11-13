import type { WinScheduledTask } from './WinSystemCommands';

const DAY_NAMES: Record<string, string> = {
  SUN: 'Sunday', MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday',
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
];

const MONTH_ABBREVIATIONS = MONTH_NAMES.map((name) => name.slice(0, 3).toUpperCase());

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function localStamp(date: Date, fractionDigits = 0): string {
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return fractionDigits === 0 ? base : `${base}.${pad(date.getMilliseconds(), 3).padEnd(fractionDigits, '0')}`;
}

function startBoundary(task: WinScheduledTask, now: Date): string {
  const at = task.runAt ?? task.startDate ?? now;
  return localStamp(at);
}

function splitCommand(command: string): { program: string; arguments: string } {
  const trimmed = command.trim();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end > 0) return { program: trimmed.slice(1, end), arguments: trimmed.slice(end + 1).trim() };
  }
  const space = trimmed.search(/\s/);
  return space < 0 ? { program: trimmed, arguments: '' } : { program: trimmed.slice(0, space), arguments: trimmed.slice(space).trim() };
}

function repetition(intervalMs: number): string {
  const hours = intervalMs % MS_PER_HOUR === 0 && intervalMs >= MS_PER_HOUR;
  const iso = hours ? `PT${intervalMs / MS_PER_HOUR}H` : `PT${Math.round(intervalMs / MS_PER_MINUTE)}M`;
  return `<Repetition> <Interval>${iso}</Interval> </Repetition>`;
}

function weekdays(days: string | undefined, fallback: Date): string {
  const listed = (days ?? '').split(',').map((d) => d.trim().toUpperCase()).filter((d) => DAY_NAMES[d] !== undefined);
  const names = listed.length > 0 ? listed : [Object.keys(DAY_NAMES)[fallback.getDay()]];
  return names.map((d) => `<${DAY_NAMES[d]}/>`).join(' ');
}

function monthsOf(months: string | undefined): string {
  const listed = (months ?? '').split(',').map((m) => m.trim().toUpperCase()).filter((m) => MONTH_ABBREVIATIONS.includes(m));
  const names = listed.length > 0 ? listed.map((m) => MONTH_NAMES[MONTH_ABBREVIATIONS.indexOf(m)]) : MONTH_NAMES;
  return names.map((m) => `<${m}/>`).join(' ');
}

function trigger(task: WinScheduledTask, now: Date): string {
  const boundary = `<StartBoundary>${startBoundary(task, now)}</StartBoundary>`;
  const kind = (task.scheduleType ?? '').toLowerCase();
  const interval = task.intervalMs ?? 0;
  if (kind === 'one time only, minute' || kind === 'one time only, hourly') {
    return `<TimeTrigger> ${boundary} ${repetition(interval)} </TimeTrigger>`;
  }
  if (kind === 'one time only') return `<TimeTrigger> ${boundary} </TimeTrigger>`;
  if (kind === 'daily') {
    return `<CalendarTrigger> ${boundary} <ScheduleByDay> <DaysInterval>${Math.max(1, Math.round(interval / MS_PER_DAY))}</DaysInterval> </ScheduleByDay> </CalendarTrigger>`;
  }
  if (kind === 'weekly') {
    const weeks = Math.max(1, Math.round(interval / (7 * MS_PER_DAY)));
    return `<CalendarTrigger> ${boundary} <ScheduleByWeek> <WeeksInterval>${weeks}</WeeksInterval> <DaysOfWeek> ${weekdays(task.days, task.runAt ?? now)} </DaysOfWeek> </ScheduleByWeek> </CalendarTrigger>`;
  }
  if (kind === 'monthly') {
    const day = Number(task.days) || (task.runAt ?? now).getDate();
    return `<CalendarTrigger> ${boundary} <ScheduleByMonth> <DaysOfMonth> <Day>${day}</Day> </DaysOfMonth> <Months> ${monthsOf(task.months)} </Months> </ScheduleByMonth> </CalendarTrigger>`;
  }
  if (kind === 'at system start up') return `<BootTrigger> ${boundary} </BootTrigger>`;
  if (kind === 'at logon time') return `<LogonTrigger> ${boundary} </LogonTrigger>`;
  return '';
}

export function renderTaskDefinition(task: WinScheduledTask, now: Date): string {
  const registered = localStamp(task.startDate ?? now, 7);
  const author = escapeXml(task.author ?? '');
  const runAs = escapeXml(task.runAsUser ?? '');
  const action = splitCommand(task.command ?? '');
  const enabled = task.state !== 'Disabled';
  const triggers = trigger(task, now);
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    ` <RegistrationInfo> <Date>${registered}</Date> <Author>${author}</Author> </RegistrationInfo>`,
    triggers === '' ? ' <Triggers />' : ` <Triggers> ${triggers} </Triggers>`,
    ` <Principals> <Principal id="Author"> <RunLevel>LeastPrivilege</RunLevel> <UserId>${runAs}</UserId> <LogonType>InteractiveToken</LogonType> </Principal> </Principals>`,
    ' <Settings> <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy> <DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>'
      + ' <StopIfGoingOnBatteries>true</StopIfGoingOnBatteries> <AllowHardTerminate>true</AllowHardTerminate> <StartWhenAvailable>false</StartWhenAvailable>'
      + ' <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable> <IdleSettings> <StopOnIdleEnd>true</StopOnIdleEnd> <RestartOnIdle>false</RestartOnIdle> </IdleSettings>'
      + ` <AllowStartOnDemand>true</AllowStartOnDemand> <Enabled>${enabled}</Enabled> <Hidden>false</Hidden> <RunOnlyIfIdle>false</RunOnlyIfIdle>`
      + ' <WakeToRun>false</WakeToRun> <ExecutionTimeLimit>P3D</ExecutionTimeLimit> <Priority>7</Priority> </Settings>',
    ` <Actions Context="Author"> <Exec> <Command>${escapeXml(action.program)}</Command>${action.arguments === '' ? '' : ` <Arguments>${escapeXml(action.arguments)}</Arguments>`} </Exec> </Actions>`,
    '</Task>',
  ].join('\n');
}
