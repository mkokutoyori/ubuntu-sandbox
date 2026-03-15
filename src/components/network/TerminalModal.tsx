/**
 * TerminalModal - Terminal window for device terminals
 * Supports two modes:
 * - Modal (default): centered floating modal with resize handles
 * - Embedded: fills parent container (for tiling layout)
 *
 * Features:
 * - Resizable via drag handles (modal mode only)
 * - Fullscreen mode
 * - Horizontal scrolling
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { X, Minus, Maximize2, Minimize2, Copy } from 'lucide-react';
import { Equipment, hasTerminalSupport, isFullyImplemented } from '@/network';
import { Terminal } from '@/components/Terminal';
import { WindowsTerminal } from '@/components/WindowsTerminal';
import { CiscoTerminal } from '@/components/CiscoTerminal';
import { HuaweiTerminal } from '@/components/HuaweiTerminal';
type BaseDevice = Equipment;
import { preInstallForDevice } from '@/terminal/packages';
import { clearTerminalState } from '@/terminal/terminalStateCache';
import { cn } from '@/lib/utils';

// Minimum and default dimensions
const MIN_WIDTH = 400;
const MIN_HEIGHT = 300;
const DEFAULT_WIDTH = 1000;
const DEFAULT_HEIGHT = 700;

interface TerminalModalProps {
  device: BaseDevice;
  onClose: () => void;
  onMinimize?: () => void;
  /** When true, fills parent container instead of rendering as a fixed modal */
  embedded?: boolean;
}

export function TerminalModal({ device, onClose, onMinimize, embedded = false }: TerminalModalProps) {
  const deviceName = device.getName();
  const deviceType = device.getDeviceType();
  const isPoweredOn = device.getIsPoweredOn();

  // Determine which terminal to use based on device type
  const osType = device.getOSType();
  const isLinuxDevice = osType === 'linux';
  const isWindowsDevice = osType === 'windows';
  const isCiscoDevice = osType === 'cisco-ios';
  const isHuaweiDevice = osType === 'huawei-vrp';
  const deviceIsFullyImplemented = isFullyImplemented(deviceType);
  const isDatabaseDevice = deviceType.startsWith('db-');

  // Wrap onClose to reset Linux terminal session state (cwd, su stack) and clear cache
  const handleClose = useCallback(() => {
    clearTerminalState(device.getId());
    if (isLinuxDevice && typeof (device as any).resetSession === 'function') {
      (device as any).resetSession();
    }
    onClose();
  }, [device, isLinuxDevice, onClose]);

  // Windows shell mode (for dynamic title bar)
  const [winShellMode, setWinShellMode] = useState<'cmd' | 'powershell'>('cmd');

  // Resizable state (only used in modal mode)
  const [dimensions, setDimensions] = useState({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<{ startX: number; startY: number; startWidth: number; startHeight: number; direction: string } | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Handle resize start
  const handleResizeStart = useCallback((e: React.MouseEvent, direction: string) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startWidth: dimensions.width,
      startHeight: dimensions.height,
      direction,
    };
  }, [dimensions]);

  // Handle resize move
  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeRef.current) return;
      const { startX, startY, startWidth, startHeight, direction } = resizeRef.current;

      let newWidth = startWidth;
      let newHeight = startHeight;

      if (direction.includes('e')) {
        newWidth = Math.max(MIN_WIDTH, startWidth + (e.clientX - startX) * 2);
      }
      if (direction.includes('w')) {
        newWidth = Math.max(MIN_WIDTH, startWidth - (e.clientX - startX) * 2);
      }
      if (direction.includes('s')) {
        newHeight = Math.max(MIN_HEIGHT, startHeight + (e.clientY - startY) * 2);
      }
      if (direction.includes('n')) {
        newHeight = Math.max(MIN_HEIGHT, startHeight - (e.clientY - startY) * 2);
      }

      // Limit to viewport
      newWidth = Math.min(newWidth, window.innerWidth - 40);
      newHeight = Math.min(newHeight, window.innerHeight - 40);

      setDimensions({ width: newWidth, height: newHeight });
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      resizeRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  // Toggle fullscreen
  const toggleFullscreen = useCallback(() => {
    setIsFullscreen(prev => !prev);
  }, []);

  // Pre-install database packages for database devices - call immediately (not in useEffect)
  // This ensures packages are installed before the terminal component mounts
  if (isDatabaseDevice) {
    preInstallForDevice(deviceType);
  }

  if (!isPoweredOn) {
    return (
      <div className={embedded
        ? "w-full h-full flex items-center justify-center bg-slate-900"
        : "fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      }>
        <div className={cn(
          "w-[400px] p-6 flex flex-col items-center",
          "bg-slate-900 rounded-xl",
          "border border-white/10 shadow-2xl shadow-black/50",
          "animate-in zoom-in-95 fade-in duration-200"
        )}>
          <div className="text-red-400 text-lg mb-2">Device Powered Off</div>
          <div className="text-white/60 text-sm text-center mb-4">
            {deviceName} is currently powered off. Please power on the device to access the terminal.
          </div>
          <button
            onClick={handleClose}
            className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-white/80 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  // Show message for non-implemented device types
  if (!isLinuxDevice && !isWindowsDevice && !isCiscoDevice && !isHuaweiDevice && !deviceIsFullyImplemented) {
    return (
      <div className={embedded
        ? "w-full h-full flex items-center justify-center bg-slate-900"
        : "fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      }>
        <div className={cn(
          "w-[500px] p-6 flex flex-col items-center",
          "bg-slate-900 rounded-xl",
          "border border-white/10 shadow-2xl shadow-black/50",
          "animate-in zoom-in-95 fade-in duration-200"
        )}>
          <div className="text-yellow-400 text-lg mb-2">Terminal Not Yet Implemented</div>
          <div className="text-white/60 text-sm text-center mb-4">
            The terminal for <span className="text-white font-medium">{deviceName}</span> ({deviceType})
            is not yet implemented. This device type will be available in a future sprint.
          </div>
          <div className="text-white/40 text-xs text-center mb-4">
            Currently implemented: Linux PC, Linux Server, Windows PC, Windows Server, Database Servers
          </div>
          <button
            onClick={handleClose}
            className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-white/80 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  // ── Title bar (shared between modal and embedded mode) ──
  const titleBar = (
    <div className="flex items-center justify-between h-8 bg-[#1f1f1f] border-b border-[#3f3f3f] shrink-0 select-none">
      {/* Left: icon + title */}
      <div className="flex items-center gap-2 pl-3 min-w-0">
        <span className="text-[11px] font-medium text-white/80 truncate">
          {deviceName}
          {isLinuxDevice && !isDatabaseDevice && ' — Ubuntu Linux'}
          {isWindowsDevice && (winShellMode === 'powershell'
            ? ' — Windows PowerShell'
            : ' — Command Prompt'
          )}
          {isCiscoDevice && ' — Cisco IOS'}
          {isHuaweiDevice && ' — Huawei VRP'}
          {isDatabaseDevice && ` — ${
            deviceType === 'db-oracle' ? 'Oracle' :
            deviceType === 'db-mysql' ? 'MySQL' :
            deviceType === 'db-postgres' ? 'PostgreSQL' :
            deviceType === 'db-sqlserver' ? 'SQL Server' : 'Database'
          }`}
        </span>
      </div>
      {/* Right: window control buttons (Windows 10/11 style) */}
      <div className="flex items-stretch h-full">
        <button
          onClick={onMinimize}
          className="w-11 h-full flex items-center justify-center hover:bg-white/10 transition-colors"
          title="Minimize"
        >
          <Minus className="w-4 h-4 text-white/70" />
        </button>
        {!embedded && (
          <button
            onClick={toggleFullscreen}
            className="w-11 h-full flex items-center justify-center hover:bg-white/10 transition-colors"
            title={isFullscreen ? 'Restore Down' : 'Maximize'}
          >
            {isFullscreen ? (
              <Copy className="w-3.5 h-3.5 text-white/70" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5 text-white/70" />
            )}
          </button>
        )}
        <button
          onClick={handleClose}
          className="w-11 h-full flex items-center justify-center hover:bg-[#e81123] transition-colors group"
          title="Close"
        >
          <X className="w-4 h-4 text-white/70 group-hover:text-white" />
        </button>
      </div>
    </div>
  );

  // ── Terminal content ──
  const terminalContent = (
    <div className="flex-1 overflow-hidden">
      {isCiscoDevice ? (
        <CiscoTerminal device={device} onRequestClose={handleClose} />
      ) : isHuaweiDevice ? (
        <HuaweiTerminal device={device} onRequestClose={handleClose} />
      ) : isWindowsDevice ? (
        <WindowsTerminal device={device} onRequestClose={handleClose} onShellModeChange={setWinShellMode} />
      ) : (
        <Terminal device={device} onRequestClose={handleClose} />
      )}
    </div>
  );

  // ── Embedded mode: fill parent container ──
  if (embedded) {
    return (
      <div className={cn(
        "w-full h-full flex flex-col",
        "bg-[#0c0c0c] overflow-hidden",
        "border border-[#3f3f3f]"
      )}>
        {titleBar}
        {terminalContent}
      </div>
    );
  }

  // ── Modal mode: centered floating window ──
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        ref={modalRef}
        className={cn(
          "flex flex-col relative",
          "bg-[#0c0c0c] overflow-hidden",
          "border border-[#3f3f3f] shadow-2xl shadow-black/70",
          "animate-in zoom-in-95 fade-in duration-200",
          isResizing && "select-none"
        )}
        style={isFullscreen ? {
          width: '100vw',
          height: '100vh',
          borderRadius: 0,
        } : {
          width: `${dimensions.width}px`,
          height: `${dimensions.height}px`,
        }}
      >
        {titleBar}
        {terminalContent}

        {/* Resize handles - only show when not fullscreen */}
        {!isFullscreen && (
          <>
            {/* Corner handles */}
            <div
              className="absolute top-0 left-0 w-4 h-4 cursor-nw-resize z-10"
              onMouseDown={(e) => handleResizeStart(e, 'nw')}
            />
            <div
              className="absolute top-0 right-0 w-4 h-4 cursor-ne-resize z-10"
              onMouseDown={(e) => handleResizeStart(e, 'ne')}
            />
            <div
              className="absolute bottom-0 left-0 w-4 h-4 cursor-sw-resize z-10"
              onMouseDown={(e) => handleResizeStart(e, 'sw')}
            />
            <div
              className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize z-10"
              onMouseDown={(e) => handleResizeStart(e, 'se')}
            />
            {/* Edge handles */}
            <div
              className="absolute top-0 left-4 right-4 h-2 cursor-n-resize z-10"
              onMouseDown={(e) => handleResizeStart(e, 'n')}
            />
            <div
              className="absolute bottom-0 left-4 right-4 h-2 cursor-s-resize z-10"
              onMouseDown={(e) => handleResizeStart(e, 's')}
            />
            <div
              className="absolute left-0 top-4 bottom-4 w-2 cursor-w-resize z-10"
              onMouseDown={(e) => handleResizeStart(e, 'w')}
            />
            <div
              className="absolute right-0 top-4 bottom-4 w-2 cursor-e-resize z-10"
              onMouseDown={(e) => handleResizeStart(e, 'e')}
            />
          </>
        )}
      </div>
    </div>
  );
}
