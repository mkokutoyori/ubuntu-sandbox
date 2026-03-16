/**
 * TerminalTaskbar - Always-visible taskbar at the bottom of the screen
 * Shows all open terminal sessions and tiling layout controls.
 *
 * Layout selector inspired by i3/sway tiling WMs:
 *   - Stack: single focused terminal (Alt+S)
 *   - Split H: horizontal split (Alt+H)
 *   - Split V: vertical split (Alt+V)
 *   - Grid: auto grid (Alt+G)
 *   - Master+Stack: master pane + stack (Alt+M)
 *
 * Focus navigation: Alt+J (next) / Alt+K (prev)
 *
 * Now session-based: receives [sessionId, TerminalSession][] from the
 * TerminalManager instead of Map<string, BaseDevice>.
 */

import {
  X, Terminal, Columns2, Rows2, LayoutGrid,
  Layers, PanelLeft, ChevronLeft, ChevronRight,
} from 'lucide-react';
import type { TerminalSession } from '@/terminal/sessions/TerminalSession';
import type { TileLayout } from './NetworkDesigner';
import { cn } from '@/lib/utils';

interface TerminalTaskbarProps {
  sessions: Array<[string, TerminalSession]>;
  minimizedIds: Set<string>;
  onToggle: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  tileLayout: TileLayout;
  onLayoutChange: (layout: TileLayout) => void;
  focusedIndex: number;
  visibleCount: number;
  onFocusChange: (index: number) => void;
}

const LAYOUT_OPTIONS: { id: TileLayout; icon: typeof LayoutGrid; label: string; shortcut: string }[] = [
  { id: 'stack',        icon: Layers,     label: 'Stack',          shortcut: 'Alt+S' },
  { id: 'split-h',      icon: Columns2,   label: 'Split Horizontal', shortcut: 'Alt+H' },
  { id: 'split-v',      icon: Rows2,      label: 'Split Vertical',   shortcut: 'Alt+V' },
  { id: 'grid',         icon: LayoutGrid, label: 'Grid',           shortcut: 'Alt+G' },
  { id: 'master-stack', icon: PanelLeft,  label: 'Master + Stack', shortcut: 'Alt+M' },
];

export function TerminalTaskbar({
  sessions,
  minimizedIds,
  onToggle,
  onClose,
  tileLayout,
  onLayoutChange,
  focusedIndex,
  visibleCount,
  onFocusChange,
}: TerminalTaskbarProps) {
  if (sessions.length === 0) return null;

  const visibleCountTotal = sessions.length - minimizedIds.size;
  const showFocusControls = tileLayout === 'stack' || tileLayout === 'master-stack';

  return (
    <div className={cn(
      "fixed bottom-0 left-0 right-0 z-[60]",
      "flex items-center gap-1 px-2 py-1",
      "bg-slate-900/95 border-t border-white/10",
      "backdrop-blur-sm"
    )}>
      {/* ── Layout selector ── */}
      <div className="flex items-center gap-0.5 mr-2 border-r border-white/10 pr-2">
        {LAYOUT_OPTIONS.map(opt => {
          const Icon = opt.icon;
          const isActive = tileLayout === opt.id;
          return (
            <button
              key={opt.id}
              onClick={() => onLayoutChange(opt.id)}
              className={cn(
                "p-1.5 rounded transition-colors",
                isActive
                  ? "bg-blue-500/30 text-blue-400"
                  : "text-white/30 hover:text-white/60 hover:bg-white/5"
              )}
              title={`${opt.label} (${opt.shortcut})`}
            >
              <Icon className="w-3.5 h-3.5" />
            </button>
          );
        })}
      </div>

      {/* ── Focus navigation (for stack / master-stack) ── */}
      {showFocusControls && visibleCount > 1 && (
        <div className="flex items-center gap-0.5 mr-2 border-r border-white/10 pr-2">
          <button
            onClick={() => onFocusChange((focusedIndex - 1 + visibleCount) % visibleCount)}
            className="p-1 rounded text-white/40 hover:text-white/70 hover:bg-white/5 transition-colors"
            title="Focus previous (Alt+K)"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <span className="text-[10px] text-white/40 font-mono min-w-[2.5rem] text-center">
            {focusedIndex + 1}/{visibleCount}
          </span>
          <button
            onClick={() => onFocusChange((focusedIndex + 1) % visibleCount)}
            className="p-1 rounded text-white/40 hover:text-white/70 hover:bg-white/5 transition-colors"
            title="Focus next (Alt+J)"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* ── Terminal tabs ── */}
      <div className="flex items-center gap-1 flex-1 overflow-x-auto">
        {sessions.map(([sessionId, session]) => {
          const isMinimized = minimizedIds.has(sessionId);
          const deviceName = session.device.getName();
          return (
            <div
              key={sessionId}
              className={cn(
                "flex items-center gap-2 px-3 py-1",
                "rounded border transition-all cursor-pointer group shrink-0",
                isMinimized
                  ? "bg-slate-800/50 border-white/5 hover:border-white/15 hover:bg-slate-800"
                  : "bg-slate-700/80 border-white/20 hover:border-white/30"
              )}
            >
              <button
                onClick={() => onToggle(sessionId)}
                className="flex items-center gap-2"
              >
                <Terminal className={cn(
                  "w-3 h-3",
                  isMinimized ? "text-white/30" : "text-green-400"
                )} />
                <span className={cn(
                  "text-[11px]",
                  isMinimized
                    ? "text-white/40 group-hover:text-white/60"
                    : "text-white/80 group-hover:text-white"
                )}>
                  {deviceName}
                </span>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onClose(sessionId); }}
                className="p-0.5 rounded hover:bg-red-500/20 transition-colors"
                title="Close terminal"
              >
                <X className="w-2.5 h-2.5 text-white/30 hover:text-red-400" />
              </button>
            </div>
          );
        })}
      </div>

      {/* ── Status ── */}
      <div className="flex items-center gap-1 ml-2 text-white/25 shrink-0">
        <span className="text-[10px] font-mono">{visibleCountTotal}/{sessions.length}</span>
      </div>
    </div>
  );
}

export { TerminalTaskbar as MinimizedTerminals };
