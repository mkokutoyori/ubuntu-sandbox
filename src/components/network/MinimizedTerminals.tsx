/**
 * TerminalTaskbar - Always-visible taskbar at the bottom of the screen
 * Shows all open terminals: active ones highlighted, minimized ones dimmed
 * Click to toggle visibility, X to close
 */

import { X, Terminal, LayoutGrid } from 'lucide-react';
import { Equipment } from '@/network';
type BaseDevice = Equipment;
import { cn } from '@/lib/utils';

interface TerminalTaskbarProps {
  /** All open terminals */
  terminals: Map<string, BaseDevice>;
  /** Set of device IDs that are minimized (not visible in tile area) */
  minimizedIds: Set<string>;
  /** Toggle a terminal's visibility (minimize/restore) */
  onToggle: (device: BaseDevice) => void;
  /** Close a terminal */
  onClose: (deviceId: string) => void;
}

export function TerminalTaskbar({
  terminals,
  minimizedIds,
  onToggle,
  onClose,
}: TerminalTaskbarProps) {
  if (terminals.size === 0) return null;

  const visibleCount = terminals.size - minimizedIds.size;

  return (
    <div className={cn(
      "fixed bottom-0 left-0 right-0 z-[60]",
      "flex items-center gap-2 px-4 py-1.5",
      "bg-slate-900/95 border-t border-white/10",
      "backdrop-blur-sm"
    )}>
      <div className="flex items-center gap-1 mr-2 text-white/30">
        <LayoutGrid className="w-3.5 h-3.5" />
        <span className="text-[10px] font-medium">{visibleCount}/{terminals.size}</span>
      </div>
      {Array.from(terminals.entries()).map(([deviceId, device]) => {
        const isMinimized = minimizedIds.has(deviceId);
        return (
          <div
            key={deviceId}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5",
              "rounded-lg border transition-all cursor-pointer group",
              isMinimized
                ? "bg-slate-800/50 border-white/5 hover:border-white/15 hover:bg-slate-800"
                : "bg-slate-700/80 border-white/20 hover:border-white/30"
            )}
          >
            <button
              onClick={() => onToggle(device)}
              className="flex items-center gap-2"
            >
              <Terminal className={cn(
                "w-3.5 h-3.5",
                isMinimized ? "text-white/30" : "text-green-400"
              )} />
              <span className={cn(
                "text-xs",
                isMinimized
                  ? "text-white/40 group-hover:text-white/60"
                  : "text-white/80 group-hover:text-white"
              )}>
                {device.getName()}
              </span>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(deviceId);
              }}
              className={cn(
                "p-0.5 rounded hover:bg-red-500/20",
                "transition-colors"
              )}
              title="Close terminal"
            >
              <X className="w-3 h-3 text-white/30 hover:text-red-400" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// Keep the old export name for backwards compatibility
export { TerminalTaskbar as MinimizedTerminals };
