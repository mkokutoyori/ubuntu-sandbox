/**
 * TerminalModal - Modal window for device terminal
 * Connected to device instances from Sprint 1
 */

import { X, Minus, Square } from 'lucide-react';
import { BaseDevice } from '@/devices';
import { DeviceTerminal } from './DeviceTerminal';
import { cn } from '@/lib/utils';

interface TerminalModalProps {
  device: BaseDevice;
  onClose: () => void;
}

export function TerminalModal({ device, onClose }: TerminalModalProps) {
  const deviceName = device.getName();
  const deviceType = device.getDeviceType();
  const isPoweredOn = device.getIsPoweredOn();

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className={cn(
          "w-[900px] h-[600px] flex flex-col",
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

        {/* Terminal content */}
        <div className="flex-1 overflow-hidden">
          <DeviceTerminal device={device} />
        </div>
      </div>
    </div>
  );
}
