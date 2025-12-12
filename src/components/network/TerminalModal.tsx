/**
 * TerminalModal - Modal window for device terminal
 * Uses the existing Linux terminal for Linux devices
 * Will use device-specific terminals for other equipment types
 */

import { X, Minus, Square } from 'lucide-react';
import { BaseDevice } from '@/devices';
import { Terminal } from '@/components/Terminal';
import { DeviceFactory } from '@/devices/DeviceFactory';
import { cn } from '@/lib/utils';

interface TerminalModalProps {
  device: BaseDevice;
  onClose: () => void;
}

export function TerminalModal({ device, onClose }: TerminalModalProps) {
  const deviceName = device.getName();
  const deviceType = device.getDeviceType();
  const isPoweredOn = device.getIsPoweredOn();

  // Determine which terminal to use based on device type
  const osType = device.getOSType();
  const isLinuxDevice = osType === 'linux';
  const isFullyImplemented = DeviceFactory.isFullyImplemented(deviceType);

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
  if (!isLinuxDevice && !isFullyImplemented) {
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
            Currently implemented: Linux PC, Linux Server, Database Servers
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
        className={cn(
          "w-[1000px] h-[700px] flex flex-col",
          "bg-slate-900 rounded-xl overflow-hidden",
          "border border-white/10 shadow-2xl shadow-black/50",
          "animate-in zoom-in-95 fade-in duration-200"
        )}
      >
        {/* Terminal window header */}
        <div className="flex items-center justify-between px-4 py-2 bg-slate-800/80 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <button
                onClick={onClose}
                className="w-3 h-3 rounded-full bg-red-500 hover:bg-red-600 transition-colors"
                title="Close"
              />
              <button className="w-3 h-3 rounded-full bg-yellow-500 hover:bg-yellow-600 transition-colors" />
              <button className="w-3 h-3 rounded-full bg-green-500 hover:bg-green-600 transition-colors" />
            </div>
            <span className="text-xs text-white/60 font-medium">
              {deviceName} — Terminal
            </span>
            <span className="text-xs text-white/40">
              [{deviceType}]
            </span>
            {isLinuxDevice && (
              <span className="text-xs text-green-400/60 ml-2">
                Ubuntu Linux
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button className="p-1 hover:bg-white/10 rounded transition-colors">
              <Minus className="w-4 h-4 text-white/50" />
            </button>
            <button className="p-1 hover:bg-white/10 rounded transition-colors">
              <Square className="w-3.5 h-3.5 text-white/50" />
            </button>
            <button
              onClick={onClose}
              className="p-1 hover:bg-white/10 rounded transition-colors"
            >
              <X className="w-4 h-4 text-white/50" />
            </button>
          </div>
        </div>

        {/* Terminal content - Use the existing Linux terminal */}
        <div className="flex-1 overflow-hidden">
          <Terminal />
        </div>
      </div>
    </div>
  );
}
