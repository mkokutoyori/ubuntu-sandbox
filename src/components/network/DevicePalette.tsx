/**
 * DevicePalette - Sidebar with draggable device types
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, GripVertical } from 'lucide-react';
import { DEVICE_CATEGORIES, isFullyImplemented } from '@/network';
import { DeviceIcon } from './DeviceIcon';
import { useNetworkStore } from '@/store/networkStore';
import { cn } from '@/lib/utils';

const LIMITED_SIMULATION_HINT =
  'Limited simulation: this device currently behaves as a generic substitute ' +
  '(vendor-specific features are not implemented yet).';

/** Grid cascade so keyboard/click-added devices don't stack exactly on top of each other. */
const ADD_GRID_COLS = 6;
const ADD_GRID_STEP = 90;
const ADD_GRID_ORIGIN = { x: 160, y: 140 };

export function DevicePalette() {
  const [expandedCategories, setExpandedCategories] = useState<string[]>(
    DEVICE_CATEGORIES.map(c => c.id)
  );
  const addDevice = useNetworkStore(s => s.addDevice);
  const getDevices = useNetworkStore(s => s.getDevices);
  const selectDevice = useNetworkStore(s => s.selectDevice);

  // Keyboard/click equivalent of dragging a device onto the canvas — the
  // only way to add a device used to be HTML5 drag-and-drop, which is
  // unreachable without a pointer (rapport 09 audit).
  const addDeviceViaKeyboard = (type: (typeof DEVICE_CATEGORIES)[number]['devices'][number]['type']) => {
    const count = getDevices().length;
    const col = count % ADD_GRID_COLS;
    const row = Math.floor(count / ADD_GRID_COLS);
    const device = addDevice(
      type,
      ADD_GRID_ORIGIN.x + col * ADD_GRID_STEP,
      ADD_GRID_ORIGIN.y + row * ADD_GRID_STEP,
    );
    selectDevice(device.id);
  };

  const toggleCategory = (id: string) => {
    setExpandedCategories(prev =>
      prev.includes(id)
        ? prev.filter(c => c !== id)
        : [...prev, id]
    );
  };

  return (
    <div className="h-full flex flex-col bg-card/30 backdrop-blur-xl border-r border-white/10">
      <div className="p-4 border-b border-white/10">
        <h2 className="text-sm font-semibold text-foreground/90">Equipment</h2>
        <p className="text-xs text-muted-foreground mt-1">Drag to canvas</p>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {DEVICE_CATEGORIES.map(category => (
          <div key={category.id} className="rounded-lg overflow-hidden">
            <button
              onClick={() => toggleCategory(category.id)}
              aria-expanded={expandedCategories.includes(category.id)}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2 text-sm",
                "hover:bg-white/5 transition-colors rounded-lg",
                "text-foreground/80"
              )}
            >
              {expandedCategories.includes(category.id) ? (
                <ChevronDown className="w-4 h-4" aria-hidden="true" />
              ) : (
                <ChevronRight className="w-4 h-4" aria-hidden="true" />
              )}
              <span className="font-medium">{category.name}</span>
            </button>

            {expandedCategories.includes(category.id) && (
              <div className="pl-2 pb-2 space-y-1">
                {category.devices.map(device => (
                  <button
                    key={device.type}
                    type="button"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('deviceType', device.type);
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    onClick={() => addDeviceViaKeyboard(device.type)}
                    aria-label={`Add ${device.name} to canvas${!isFullyImplemented(device.type) ? ' (limited simulation)' : ''}`}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2 rounded-lg cursor-grab text-left",
                      "bg-white/5 hover:bg-white/10 border border-transparent",
                      "hover:border-white/20 transition-all group",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                      "active:cursor-grabbing active:scale-95"
                    )}
                  >
                    <GripVertical className="w-3 h-3 text-muted-foreground/50 group-hover:text-muted-foreground" aria-hidden="true" />
                    <DeviceIcon type={device.type} size={20} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground/90 truncate">
                        {device.name}
                      </p>
                      <p className="text-[10px] text-muted-foreground truncate">
                        {device.description}
                      </p>
                    </div>
                    {!isFullyImplemented(device.type) && (
                      <span
                        title={LIMITED_SIMULATION_HINT}
                        className={cn(
                          'shrink-0 text-[9px] font-semibold uppercase tracking-wide',
                          'px-1.5 py-0.5 rounded border',
                          'bg-amber-500/15 text-amber-400 border-amber-500/30',
                        )}
                      >
                        Limited
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
