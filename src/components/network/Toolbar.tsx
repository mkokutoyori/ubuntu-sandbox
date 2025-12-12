/**
 * Toolbar - Top toolbar for network designer
 */

import { Save, FolderOpen, Download, Upload, Play, Pause, RotateCcw, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ToolbarProps {
  projectName: string;
  onProjectNameChange: (name: string) => void;
}

export function Toolbar({ projectName, onProjectNameChange }: ToolbarProps) {
  return (
    <div className="h-14 bg-card/30 backdrop-blur-xl border-b border-white/10 flex items-center justify-between px-4">
      {/* Left section - Project name */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary/80 to-primary flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
            </svg>
          </div>
          <input
            type="text"
            value={projectName}
            onChange={(e) => onProjectNameChange(e.target.value)}
            className="bg-transparent text-lg font-semibold text-foreground border-none focus:outline-none focus:ring-0 w-48"
            placeholder="Untitled Network"
          />
        </div>
      </div>

      {/* Center section - Actions */}
      <div className="flex items-center gap-1">
        <ToolbarButton icon={Save} label="Save" />
        <ToolbarButton icon={FolderOpen} label="Open" />
        <div className="w-px h-6 bg-white/10 mx-2" />
        <ToolbarButton icon={Download} label="Export" />
        <ToolbarButton icon={Upload} label="Import" />
        <div className="w-px h-6 bg-white/10 mx-2" />
        <ToolbarButton icon={Play} label="Simulate" variant="primary" />
        <ToolbarButton icon={Pause} label="Pause" />
        <ToolbarButton icon={RotateCcw} label="Reset" />
      </div>

      {/* Right section - Help */}
      <div className="flex items-center gap-2">
        <ToolbarButton icon={HelpCircle} label="Help" />
      </div>
    </div>
  );
}

interface ToolbarButtonProps {
  icon: React.ElementType;
  label: string;
  variant?: 'default' | 'primary';
  onClick?: () => void;
}

function ToolbarButton({ icon: Icon, label, variant = 'default', onClick }: ToolbarButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all",
        variant === 'default' && "text-foreground/70 hover:text-foreground hover:bg-white/10",
        variant === 'primary' && "bg-primary/20 text-primary hover:bg-primary/30"
      )}
      title={label}
    >
      <Icon className="w-4 h-4" />
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}
