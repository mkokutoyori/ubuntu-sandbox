/**
 * DevicePalette - Sidebar with draggable device types
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, GripVertical } from 'lucide-react';
import { DEVICE_CATEGORIES, DeviceType } from '@/domain/devices';
import { DeviceIcon } from './DeviceIcon';
import { cn } from '@/lib/utils';

interface DevicePaletteProps {
  onDragStart: (type: DeviceType) => void;
}

export function DevicePalette({ onDragStart }: DevicePaletteProps) {
  const [expandedCategories, setExpandedCategories] = useState<string[]>(
    DEVICE_CATEGORIES.map(c => c.id)
  );

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
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2 text-sm",
                "hover:bg-white/5 transition-colors rounded-lg",
                "text-foreground/80"
              )}
            >
              {expandedCategories.includes(category.id) ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
              <span className="font-medium">{category.name}</span>
            </button>

            {expandedCategories.includes(category.id) && (
              <div className="pl-2 pb-2 space-y-1">
                {category.devices.map(device => (
                  <div
                    key={device.type}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('deviceType', device.type);
                      onDragStart(device.type);
                    }}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2 rounded-lg cursor-grab",
                      "bg-white/5 hover:bg-white/10 border border-transparent",
                      "hover:border-white/20 transition-all group",
                      "active:cursor-grabbing active:scale-95"
                    )}
                  >
                    <GripVertical className="w-3 h-3 text-muted-foreground/50 group-hover:text-muted-foreground" />
                    <DeviceIcon type={device.type} size={20} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground/90 truncate">
                        {device.name}
                      </p>
                      <p className="text-[10px] text-muted-foreground truncate">
                        {device.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
