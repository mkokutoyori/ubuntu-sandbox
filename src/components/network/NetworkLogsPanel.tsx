/**
 * NetworkLogsPanel — live tail of every event the Logger singleton emits.
 *
 * Reads from the `useNetworkLogs` hook (which subscribes to Logger pub/sub)
 * and renders the most recent N entries with level / source / event filters.
 * No persistence; clearing the view also clears the underlying buffer so
 * the panel matches `journalctl --rotate`'s mental model — what you see
 * is what's currently kept.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Trash2, ScrollText, Filter, X, Copy, Download, Pause, Play } from 'lucide-react';
import { Logger, type LogLevel, type NetworkLog } from '@/network/core/Logger';
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

/** Trigger a browser download for the given text payload. */
function downloadText(filename: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Escape a value for CSV: wrap in quotes, double internal quotes. */
function csvCell(value: unknown): string {
  if (value == null) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function exportJson(rows: readonly NetworkLog[]): string {
  return JSON.stringify(
    rows.map(r => ({
      timestamp: new Date(r.timestamp).toISOString(),
      level: r.level,
      source: r.source,
      sourceLabel: r.sourceLabel,
      event: r.event,
      message: r.message,
      data: r.data,
    })),
    null,
    2,
  );
}

function exportCsv(rows: readonly NetworkLog[]): string {
  const header = ['timestamp', 'level', 'source', 'sourceLabel', 'event', 'message', 'data'].join(',');
  const body = rows.map(r => [
    csvCell(new Date(r.timestamp).toISOString()),
    csvCell(r.level),
    csvCell(r.source),
    csvCell(r.sourceLabel ?? ''),
    csvCell(r.event),
    csvCell(r.message),
    csvCell(r.data ?? ''),
  ].join(',')).join('\n');
  return body ? `${header}\n${body}\n` : `${header}\n`;
}

export function NetworkLogsPanel(): JSX.Element {
  const logs = useNetworkLogs({ limit: 500 });
  const [levelFilter, setLevelFilter] = useState<Set<LogLevel>>(
    new Set<LogLevel>(['info', 'warn', 'error']),
  );
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<NetworkLog | null>(null);
  // Live-tail mode: when the user has not scrolled away from the top
  // (newest entry) of the list, snap back to 0 whenever new logs
  // arrive. Once they scroll into history, freeze the viewport so they
  // can actually read past entries — the standard "pause on scroll" UX
  // of every serious log viewer (k9s, lazydocker, devtools console).
  const [liveTail, setLiveTail] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);

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

  // When a new log arrives while we're in live-tail mode, snap the
  // viewport to the top (newest entry). Newest-first ordering makes
  // 0 the live edge — same as `tail -f` semantics but rendered in
  // reverse-time order so the eye lands on the freshest event.
  useEffect(() => {
    if (liveTail && listRef.current) listRef.current.scrollTop = 0;
  }, [filtered.length, liveTail]);

  const onListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const top = (e.target as HTMLDivElement).scrollTop;
    // Tiny epsilon: a momentum-scroll can land at 0.5 even when the
    // user "is at the top". 4px keeps the live-tail intuitive without
    // re-engaging it from a mid-scroll wobble.
    const atTop = top <= 4;
    if (atTop !== liveTail) setLiveTail(atTop);
  };

  const handleExportJson = () =>
    downloadText(`network-logs-${Date.now()}.json`, 'application/json', exportJson(filtered));

  const handleExportCsv = () =>
    downloadText(`network-logs-${Date.now()}.csv`, 'text/csv', exportCsv(filtered));

  return (
    <div className="h-full flex flex-col bg-card/30 backdrop-blur-xl border-l border-white/10 w-[380px]">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/10 flex items-center gap-1.5">
        <ScrollText className="w-4 h-4 text-foreground/70 shrink-0" />
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-foreground/90 flex items-center gap-2">
            Network Logs
            {!liveTail && (
              <span
                className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded
                           bg-amber-600/30 text-amber-200 font-medium"
                data-testid="logs-paused-badge"
              >
                paused
              </span>
            )}
          </h2>
          <p className="text-[10px] text-muted-foreground">
            {filtered.length} / {logs.length} entries
          </p>
        </div>
        <button
          onClick={() => {
            // Manual toggle: if paused, jump back to live; if live, just freeze in place.
            if (!liveTail && listRef.current) listRef.current.scrollTop = 0;
            setLiveTail(t => !t);
          }}
          className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
          title={liveTail ? 'Pause live tail' : 'Resume live tail'}
          data-testid="logs-toggle-tail"
        >
          {liveTail
            ? <Pause className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
            : <Play className="w-3.5 h-3.5 text-amber-300 hover:text-amber-200" />}
        </button>
        <button
          onClick={handleExportJson}
          className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
          title="Export visible rows as JSON"
          data-testid="logs-export-json"
        >
          <Download className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
        </button>
        <button
          onClick={handleExportCsv}
          className="px-1.5 py-0.5 rounded-md hover:bg-white/10 transition-colors
                     text-[10px] font-semibold text-muted-foreground hover:text-foreground"
          title="Export visible rows as CSV"
          data-testid="logs-export-csv"
        >
          CSV
        </button>
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
      <div
        ref={listRef}
        onScroll={onListScroll}
        className="flex-1 overflow-y-auto font-mono text-[11px] leading-tight"
        data-testid="logs-list"
      >
        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-center text-muted-foreground text-xs">
            No matching log entries.
          </p>
        ) : filtered.map((log, i) => (
          <button
            key={`${log.timestamp}-${i}`}
            onClick={() => setSelected(log)}
            className={cn(
              'w-full text-left px-3 py-1 border-b border-white/5 transition-colors',
              'hover:bg-white/[0.04] focus:bg-white/[0.06] focus:outline-none',
              selected === log && 'bg-primary/10 hover:bg-primary/15',
            )}
            data-testid="logs-row"
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
          </button>
        ))}
      </div>

      {/* Detail drawer — slides up from the bottom of the panel column.
          Shows the full log entry incl. `data` JSON pretty-printed,
          which is the actually-useful payload (frame contents, ARP
          tuples, SSH event metadata, …) the row preview can't fit. */}
      {selected && <LogDetailDrawer log={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function LogDetailDrawer({ log, onClose }: { log: NetworkLog; onClose: () => void }): JSX.Element {
  const dataJson = log.data ? JSON.stringify(log.data, null, 2) : null;
  const copyAll = () => {
    const payload = {
      timestamp: new Date(log.timestamp).toISOString(),
      level: log.level,
      source: log.source,
      sourceLabel: log.sourceLabel,
      event: log.event,
      message: log.message,
      data: log.data,
    };
    navigator.clipboard?.writeText(JSON.stringify(payload, null, 2)).catch(() => {});
  };
  return (
    <div
      className="border-t border-white/10 bg-black/40 backdrop-blur-xl flex flex-col max-h-[55%]"
      data-testid="logs-detail"
    >
      <div className="px-3 py-2 border-b border-white/10 flex items-center gap-2">
        <span className={cn('text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded', LEVEL_BADGE[log.level])}>
          {log.level}
        </span>
        <span className="text-xs text-foreground/80 truncate flex-1" title={log.event}>
          {log.event}
        </span>
        <button
          onClick={copyAll}
          className="p-1 rounded-md hover:bg-white/10 transition-colors"
          title="Copy as JSON"
          data-testid="logs-detail-copy"
        >
          <Copy className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
        </button>
        <button
          onClick={onClose}
          className="p-1 rounded-md hover:bg-white/10 transition-colors"
          title="Close detail"
          data-testid="logs-detail-close"
        >
          <X className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2 text-[11px] font-mono space-y-2">
        <DetailField label="time"   value={new Date(log.timestamp).toISOString()} />
        <DetailField label="source" value={log.sourceLabel ? `${log.sourceLabel} (${log.source})` : log.source} />
        <DetailField label="event"  value={log.event} />
        <DetailField label="message" value={log.message} multiline />
        {dataJson && (
          <div>
            <div className="text-muted-foreground/70 text-[10px] uppercase tracking-wide mb-1">data</div>
            <pre className="bg-black/40 border border-white/10 rounded p-2 overflow-x-auto whitespace-pre text-foreground/90">
              {dataJson}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function DetailField({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }): JSX.Element {
  return (
    <div>
      <div className="text-muted-foreground/70 text-[10px] uppercase tracking-wide">{label}</div>
      <div className={cn('text-foreground/90', multiline ? 'whitespace-pre-wrap' : 'truncate')} title={value}>
        {value}
      </div>
    </div>
  );
}
