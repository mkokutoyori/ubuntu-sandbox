/**
 * MinimizedTerminals - Taskbar for minimized terminal windows
 * Shows minimized terminals at the bottom of the screen
 * Click to restore, right X to close
 */

import { X, Terminal } from 'lucide-react';
import { BaseDevice } from '@/devices';
import { cn } from '@/lib/utils';

interface MinimizedTerminalsProps {
  terminals: Map<string, BaseDevice>;
  onRestore: (device: BaseDevice) => void;
  onClose: (deviceId: string) => void;
}

export function MinimizedTerminals({
  terminals,
  onRestore,
  onClose,
}: MinimizedTerminalsProps) {
  if (terminals.size === 0) return null;

  return (
    <div className={cn(
      "fixed bottom-0 left-0 right-0 z-40",
      "flex items-center gap-2 px-4 py-2",
      "bg-slate-900/95 border-t border-white/10",
      "backdrop-blur-sm"
    )}>
      <span className="text-xs text-white/40 mr-2">Minimized:</span>
      {Array.from(terminals.entries()).map(([deviceId, device]) => (
        <div
          key={deviceId}
          className={cn(
            "flex items-center gap-2 px-3 py-1.5",
            "bg-slate-800 hover:bg-slate-700 rounded-lg",
            "border border-white/10 hover:border-white/20",
            "transition-all cursor-pointer group"
          )}
        >
          <button
            onClick={() => onRestore(device)}
            className="flex items-center gap-2"
          >
            <Terminal className="w-4 h-4 text-green-400" />
            <span className="text-sm text-white/80 group-hover:text-white">
              {device.getName()}
            </span>
            <span className="text-xs text-white/40">
              [{device.getDeviceType()}]
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
            <X className="w-3.5 h-3.5 text-white/40 hover:text-red-400" />
          </button>
        </div>
      ))}
    </div>
  );
}
