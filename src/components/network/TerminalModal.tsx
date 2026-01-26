/**
 * TerminalModal - Modal window for device terminal
 * Uses the existing Linux terminal for Linux devices
 * Will use device-specific terminals for other equipment types
 *
 * Features:
 * - Resizable via drag handles
 * - Fullscreen mode
 * - Horizontal scrolling
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { X, Minus, Square, Maximize2, Minimize2 } from 'lucide-react';
import { BaseDevice } from '@/domain/devices';
import { Terminal } from '@/components/Terminal';
import { WindowsTerminal } from '@/components/WindowsTerminal';
import { CiscoTerminal } from '@/components/CiscoTerminal';
import { DeviceFactory } from '@/domain/devices/DeviceFactory';
import { preInstallForDevice } from '@/terminal/packages';
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
}

export function TerminalModal({ device, onClose, onMinimize }: TerminalModalProps) {
  const deviceName = device.getName();
  const deviceType = device.getDeviceType();
  const isPoweredOn = device.getIsPoweredOn();

  // Determine which terminal to use based on device type
  const osType = device.getOSType();
  const isLinuxDevice = osType === 'linux';
  const isWindowsDevice = osType === 'windows';
  const isCiscoDevice = osType === 'cisco-ios';
  const isFullyImplemented = DeviceFactory.isFullyImplemented(deviceType);
  const isDatabaseDevice = deviceType.startsWith('db-');

  // Resizable state
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
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
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
            onClick={onClose}
            className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-white/80 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  // Show message for non-implemented device types
  if (!isLinuxDevice && !isWindowsDevice && !isCiscoDevice && !isFullyImplemented) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
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
            onClick={onClose}
            className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-white/80 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        ref={modalRef}
        className={cn(
          "flex flex-col relative",
          "bg-slate-900 rounded-xl overflow-hidden",
          "border border-white/10 shadow-2xl shadow-black/50",
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
        {/* Terminal window header */}
        <div className="flex items-center justify-between px-4 py-2 bg-slate-800/80 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <button
                onClick={onClose}
                className="w-3 h-3 rounded-full bg-red-500 hover:bg-red-600 transition-colors"
                title="Close"
              />
              <button
                onClick={onMinimize}
                className="w-3 h-3 rounded-full bg-yellow-500 hover:bg-yellow-600 transition-colors"
                title="Minimize"
              />
              <button
                onClick={toggleFullscreen}
                className="w-3 h-3 rounded-full bg-green-500 hover:bg-green-600 transition-colors"
                title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              />
            </div>
            <span className="text-xs text-white/60 font-medium">
              {deviceName} — Terminal
            </span>
            <span className="text-xs text-white/40">
              [{deviceType}]
            </span>
            {isLinuxDevice && !isDatabaseDevice && (
              <span className="text-xs text-green-400/60 ml-2">
                Ubuntu Linux
              </span>
            )}
            {isWindowsDevice && (
              <span className="text-xs text-blue-400/60 ml-2">
                Windows
              </span>
            )}
            {isCiscoDevice && (
              <span className="text-xs text-cyan-400/60 ml-2">
                Cisco IOS
              </span>
            )}
            {isDatabaseDevice && (
              <span className="text-xs text-orange-400/60 ml-2">
                {deviceType === 'db-oracle' ? 'Oracle Database Server' :
                 deviceType === 'db-mysql' ? 'MySQL Server' :
                 deviceType === 'db-postgres' ? 'PostgreSQL Server' :
                 deviceType === 'db-sqlserver' ? 'SQL Server' : 'Database Server'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onMinimize}
              className="p-1 hover:bg-white/10 rounded transition-colors"
              title="Minimize"
            >
              <Minus className="w-4 h-4 text-white/50 hover:text-white/80" />
            </button>
            <button
              onClick={toggleFullscreen}
              className="p-1 hover:bg-white/10 rounded transition-colors"
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? (
                <Minimize2 className="w-3.5 h-3.5 text-white/50 hover:text-white/80" />
              ) : (
                <Maximize2 className="w-3.5 h-3.5 text-white/50 hover:text-white/80" />
              )}
            </button>
            <button
              onClick={onClose}
              className="p-1 hover:bg-white/10 rounded transition-colors"
              title="Close"
            >
              <X className="w-4 h-4 text-white/50 hover:text-red-400" />
            </button>
          </div>
        </div>

        {/* Terminal content - Use the appropriate terminal based on OS type */}
        <div className="flex-1 overflow-hidden">
          {isCiscoDevice ? (
            <CiscoTerminal device={device} onRequestClose={onClose} />
          ) : isWindowsDevice ? (
            <WindowsTerminal device={device} onRequestClose={onClose} />
          ) : (
            <Terminal device={device} onRequestClose={onClose} />
          )}
        </div>

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
