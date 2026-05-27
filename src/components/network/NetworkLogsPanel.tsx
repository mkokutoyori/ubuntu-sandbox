/**
 * NetworkLogsPanel — live tail of every event the Logger singleton emits.
 *
 * Reads from the `useNetworkLogs` hook (which subscribes to Logger pub/sub)
 * and renders the most recent N entries with level / source / event filters.
 * No persistence; clearing the view also clears the underlying buffer so
 * the panel matches `journalctl --rotate`'s mental model — what you see
 * is what's currently kept.
 */
import { useMemo, useState } from 'react';
import { Trash2, ScrollText, Filter } from 'lucide-react';
import { Logger, type LogLevel } from '@/network/core/Logger';
import { useNetworkLogs } from '@/hooks/useNetworkLogs';
import { cn } from '@/lib/utils';

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: 'text-muted-foreground',
  info:  'text-sky-300',
  warn:  'text-amber-300',
  error: 'text-red-400',
};

const LEVEL_BADGE: Record<LogLevel, string> = {
  debug: 'bg-slate-700/50 text-slate-300',
  info:  'bg-sky-600/30 text-sky-200',
  warn:  'bg-amber-600/30 text-amber-200',
  error: 'bg-red-600/30 text-red-200',
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function NetworkLogsPanel(): JSX.Element {
  const logs = useNetworkLogs({ limit: 500 });
  const [levelFilter, setLevelFilter] = useState<Set<LogLevel>>(
    new Set<LogLevel>(['info', 'warn', 'error']),
  );
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = [];
    for (let i = logs.length - 1; i >= 0; i--) {
      const log = logs[i];
      if (!levelFilter.has(log.level)) continue;
      if (q) {
        const hay = `${log.source} ${log.sourceLabel ?? ''} ${log.event} ${log.message}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      out.push(log);
    }
    return out;
  }, [logs, levelFilter, query]);

  const toggleLevel = (lvl: LogLevel) =>
    setLevelFilter(prev => {
      const next = new Set(prev);
      if (next.has(lvl)) next.delete(lvl);
      else next.add(lvl);
      return next;
    });

  return (
    <div className="h-full flex flex-col bg-card/30 backdrop-blur-xl border-l border-white/10 w-[380px]">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/10 flex items-center gap-2">
        <ScrollText className="w-4 h-4 text-foreground/70" />
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-foreground/90">Network Logs</h2>
          <p className="text-[10px] text-muted-foreground">
            {filtered.length} / {logs.length} entries
          </p>
        </div>
        <button
          onClick={() => Logger.clear()}
          className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
          title="Clear all logs"
          data-testid="logs-clear"
        >
          <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
        </button>
      </div>

      {/* Filters */}
      <div className="px-3 py-2 border-b border-white/10 space-y-2">
        <div className="flex items-center gap-1.5">
          <Filter className="w-3 h-3 text-muted-foreground" />
          {(['debug', 'info', 'warn', 'error'] as LogLevel[]).map(lvl => (
            <button
              key={lvl}
              onClick={() => toggleLevel(lvl)}
              className={cn(
                'px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide',
                'transition-opacity border border-transparent',
                LEVEL_BADGE[lvl],
                !levelFilter.has(lvl) && 'opacity-30',
              )}
            >
              {lvl}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by source / event / message…"
          className="w-full px-2 py-1 text-xs bg-black/30 border border-white/10 rounded
                     focus:outline-none focus:border-primary/50 placeholder:text-muted-foreground/60"
          data-testid="logs-filter"
        />
      </div>

      {/* Live tail (newest first) */}
      <div className="flex-1 overflow-y-auto font-mono text-[11px] leading-tight" data-testid="logs-list">
        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-center text-muted-foreground text-xs">
            No matching log entries.
          </p>
        ) : filtered.map((log, i) => (
          <div
            key={`${log.timestamp}-${i}`}
            className="px-3 py-1 border-b border-white/5 hover:bg-white/[0.02]"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-muted-foreground/60 shrink-0">{formatTime(log.timestamp)}</span>
              <span className={cn('font-semibold uppercase shrink-0', LEVEL_COLOR[log.level])}>
                {log.level}
              </span>
              <span className="text-foreground/70 truncate" title={log.sourceLabel ?? log.source}>
                {log.sourceLabel ?? log.source}
              </span>
            </div>
            <div className="pl-1 mt-0.5">
              <span className="text-primary/70">{log.event}</span>
              <span className="text-foreground/60"> — {log.message}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
