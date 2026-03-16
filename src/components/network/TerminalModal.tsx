/**
 * TerminalModal — Terminal window wrapper.
 *
 * Supports two modes:
 *   - Modal (default): centered floating modal with resize handles
 *   - Embedded: fills parent container (for tiling layout)
 *
 * Now session-based: receives a TerminalSession from the TerminalManager
 * instead of creating terminal state internally.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { X, Minus, Maximize2, Copy, Circle, Download, Settings2 } from 'lucide-react';
import { Equipment, isFullyImplemented } from '@/network';
import { TerminalView, useTerminalSession } from '@/components/terminal/TerminalView';
import type { TerminalSession } from '@/terminal/sessions/TerminalSession';
import type { SessionRecording } from '@/terminal/sessions/TerminalSession';
import type { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import { cn } from '@/lib/utils';

// Minimum and default dimensions
const MIN_WIDTH = 400;
const MIN_HEIGHT = 300;
const DEFAULT_WIDTH = 1000;
const DEFAULT_HEIGHT = 700;

interface TerminalModalProps {
  session: TerminalSession;
  onClose: () => void;
  onMinimize?: () => void;
  /** When true, fills parent container instead of rendering as a fixed modal */
  embedded?: boolean;
}

export function TerminalModal({ session, onClose, onMinimize, embedded = false }: TerminalModalProps) {
  // Subscribe to session so we re-render on changes (e.g. Windows shell mode)
  useTerminalSession(session);

  const device = session.device;
  const deviceName = device.getName();
  const deviceType = device.getDeviceType();
  const isPoweredOn = device.getIsPoweredOn();
  const sessionType = session.getSessionType();

  const isDatabaseDevice = deviceType.startsWith('db-');
  const [showScrollbackConfig, setShowScrollbackConfig] = useState(false);
  const [scrollbackValue, setScrollbackValue] = useState(String(session.getMaxScrollback()));

  // Windows shell mode for title bar
  const winShellMode = sessionType === 'windows'
    ? (session as WindowsTerminalSession).shellMode
    : undefined;

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
      startX: e.clientX, startY: e.clientY,
      startWidth: dimensions.width, startHeight: dimensions.height,
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
      if (direction.includes('e')) newWidth = Math.max(MIN_WIDTH, startWidth + (e.clientX - startX) * 2);
      if (direction.includes('w')) newWidth = Math.max(MIN_WIDTH, startWidth - (e.clientX - startX) * 2);
      if (direction.includes('s')) newHeight = Math.max(MIN_HEIGHT, startHeight + (e.clientY - startY) * 2);
      if (direction.includes('n')) newHeight = Math.max(MIN_HEIGHT, startHeight - (e.clientY - startY) * 2);
      newWidth = Math.min(newWidth, window.innerWidth - 40);
      newHeight = Math.min(newHeight, window.innerHeight - 40);
      setDimensions({ width: newWidth, height: newHeight });
    };
    const handleMouseUp = () => { setIsResizing(false); resizeRef.current = null; };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => { document.removeEventListener('mousemove', handleMouseMove); document.removeEventListener('mouseup', handleMouseUp); };
  }, [isResizing]);

  const toggleFullscreen = useCallback(() => setIsFullscreen(prev => !prev), []);

  // Recording controls
  const toggleRecording = useCallback(() => {
    if (session.isRecording) {
      const recording = session.stopRecording();
      if (recording) downloadRecording(recording);
    } else {
      session.startRecording();
    }
  }, [session]);

  const applyScrollback = useCallback(() => {
    const val = parseInt(scrollbackValue, 10);
    if (!isNaN(val) && val >= 100) {
      session.setMaxScrollback(val);
    }
    setShowScrollbackConfig(false);
  }, [session, scrollbackValue]);

  // ── Power off / not implemented guards ──

  if (!isPoweredOn) {
    return (
      <div className={embedded
        ? "w-full h-full flex items-center justify-center bg-slate-900"
        : "fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      }>
        <div className={cn("w-[400px] p-6 flex flex-col items-center", "bg-slate-900 rounded-xl", "border border-white/10 shadow-2xl shadow-black/50", "animate-in zoom-in-95 fade-in duration-200")}>
          <div className="text-red-400 text-lg mb-2">Device Powered Off</div>
          <div className="text-white/60 text-sm text-center mb-4">
            {deviceName} is currently powered off. Please power on the device to access the terminal.
          </div>
          <button onClick={onClose} className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-white/80 transition-colors">Close</button>
        </div>
      </div>
    );
  }

  // ── Title bar ──

  const titleBar = (
    <div className="flex items-center justify-between h-8 bg-[#1f1f1f] border-b border-[#3f3f3f] shrink-0 select-none">
      <div className="flex items-center gap-2 pl-3 min-w-0">
        <span className="text-[11px] font-medium text-white/80 truncate">
          {deviceName}
          {sessionType === 'linux' && !isDatabaseDevice && ' — Ubuntu Linux'}
          {sessionType === 'windows' && (winShellMode === 'powershell' ? ' — Windows PowerShell' : ' — Command Prompt')}
          {sessionType === 'cisco' && ' — Cisco IOS'}
          {sessionType === 'huawei' && ' — Huawei VRP'}
          {isDatabaseDevice && ` — ${
            deviceType === 'db-oracle' ? 'Oracle' :
            deviceType === 'db-mysql' ? 'MySQL' :
            deviceType === 'db-postgres' ? 'PostgreSQL' :
            deviceType === 'db-sqlserver' ? 'SQL Server' : 'Database'
          }`}
        </span>
      </div>
      <div className="flex items-stretch h-full">
        <button
          onClick={() => setShowScrollbackConfig(prev => !prev)}
          className="w-8 h-full flex items-center justify-center hover:bg-white/10 transition-colors"
          title="Scrollback settings"
        >
          <Settings2 className="w-3 h-3 text-white/40 hover:text-white/70" />
        </button>
        <button
          onClick={toggleRecording}
          className={cn(
            "w-8 h-full flex items-center justify-center hover:bg-white/10 transition-colors",
            session.isRecording && "bg-red-500/10"
          )}
          title={session.isRecording ? 'Stop recording & download' : 'Start recording session'}
        >
          {session.isRecording
            ? <Download className="w-3 h-3 text-red-400" />
            : <Circle className="w-3 h-3 text-white/40 hover:text-white/70" />
          }
        </button>
        <button onClick={onMinimize} className="w-11 h-full flex items-center justify-center hover:bg-white/10 transition-colors" title="Minimize">
          <Minus className="w-4 h-4 text-white/70" />
        </button>
        {!embedded && (
          <button onClick={toggleFullscreen} className="w-11 h-full flex items-center justify-center hover:bg-white/10 transition-colors" title={isFullscreen ? 'Restore Down' : 'Maximize'}>
            {isFullscreen ? <Copy className="w-3.5 h-3.5 text-white/70" /> : <Maximize2 className="w-3.5 h-3.5 text-white/70" />}
          </button>
        )}
        <button onClick={onClose} className="w-11 h-full flex items-center justify-center hover:bg-[#e81123] transition-colors group" title="Close">
          <X className="w-4 h-4 text-white/70 group-hover:text-white" />
        </button>
      </div>
    </div>
  );

  const terminalContent = (
    <div className="flex-1 overflow-hidden relative">
      <TerminalView session={session} />
      {/* Scrollback config popover */}
      {showScrollbackConfig && (
        <div
          className="absolute top-1 right-1 z-20 p-3 rounded-lg border shadow-xl"
          style={{ backgroundColor: '#1e1e1e', borderColor: '#3f3f3f' }}
        >
          <div className="text-[11px] text-white/60 mb-2">Scrollback limit</div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={scrollbackValue}
              onChange={(e) => setScrollbackValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applyScrollback(); }}
              min={100}
              max={50000}
              step={500}
              className="w-24 px-2 py-1 rounded text-xs bg-black/40 border border-white/10 text-white/80 outline-none focus:border-blue-500/50"
            />
            <button
              onClick={applyScrollback}
              className="px-2 py-1 rounded text-xs bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors"
            >
              Apply
            </button>
          </div>
          <div className="text-[10px] text-white/30 mt-1">100 – 50,000 lines</div>
        </div>
      )}
    </div>
  );

  // ── Embedded mode ──
  if (embedded) {
    return (
      <div className={cn("w-full h-full flex flex-col", "bg-[#0c0c0c] overflow-hidden", "border border-[#3f3f3f]")}>
        {titleBar}
        {terminalContent}
      </div>
    );
  }

  // ── Modal mode ──
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        ref={modalRef}
        className={cn("flex flex-col relative", "bg-[#0c0c0c] overflow-hidden", "border border-[#3f3f3f] shadow-2xl shadow-black/70", "animate-in zoom-in-95 fade-in duration-200", isResizing && "select-none")}
        style={isFullscreen ? { width: '100vw', height: '100vh', borderRadius: 0 } : { width: `${dimensions.width}px`, height: `${dimensions.height}px` }}
      >
        {titleBar}
        {terminalContent}
        {!isFullscreen && (
          <>
            <div className="absolute top-0 left-0 w-4 h-4 cursor-nw-resize z-10" onMouseDown={(e) => handleResizeStart(e, 'nw')} />
            <div className="absolute top-0 right-0 w-4 h-4 cursor-ne-resize z-10" onMouseDown={(e) => handleResizeStart(e, 'ne')} />
            <div className="absolute bottom-0 left-0 w-4 h-4 cursor-sw-resize z-10" onMouseDown={(e) => handleResizeStart(e, 'sw')} />
            <div className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize z-10" onMouseDown={(e) => handleResizeStart(e, 'se')} />
            <div className="absolute top-0 left-4 right-4 h-2 cursor-n-resize z-10" onMouseDown={(e) => handleResizeStart(e, 'n')} />
            <div className="absolute bottom-0 left-4 right-4 h-2 cursor-s-resize z-10" onMouseDown={(e) => handleResizeStart(e, 's')} />
            <div className="absolute left-0 top-4 bottom-4 w-2 cursor-w-resize z-10" onMouseDown={(e) => handleResizeStart(e, 'w')} />
            <div className="absolute right-0 top-4 bottom-4 w-2 cursor-e-resize z-10" onMouseDown={(e) => handleResizeStart(e, 'e')} />
          </>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

/** Download a session recording as a JSON file. */
function downloadRecording(recording: SessionRecording): void {
  const json = JSON.stringify(recording, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.download = `terminal-recording-${recording.deviceName}-${ts}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
