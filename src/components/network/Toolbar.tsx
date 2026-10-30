/**
 * Toolbar - Top toolbar for network designer
 */

import { Save, FolderOpen, Download, Upload, ImageDown, RotateCcw, HelpCircle, Trash2, Undo2, Redo2, Settings, Languages } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LOCALES, LOCALE_NAMES, isLocale } from '@/i18n';
import { useLocale } from '@/i18n/useLocale';

interface ToolbarProps {
  projectName: string;
  onProjectNameChange: (name: string) => void;
  onClearAll?: () => void;
  hasDevices?: boolean;
  onExport?: () => void;
  onExportImage?: () => void;
  onImport?: () => void;
  onSave?: () => void;
  onOpen?: () => void;
  onReset?: () => void;
  onHelp?: () => void;
  onSettings?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
}

export function Toolbar({
  projectName, onProjectNameChange, onClearAll, hasDevices,
  onExport, onExportImage, onImport, onSave, onOpen, onReset, onHelp, onSettings,
  onUndo, onRedo, canUndo, canRedo,
}: ToolbarProps) {
  const { locale, setLocale, t } = useLocale();
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
            id="project-name"
            name="projectName"
            type="text"
            autoComplete="off"
            aria-label={t('toolbar.projectName')}
            value={projectName}
            onChange={(e) => onProjectNameChange(e.target.value)}
            className="bg-transparent text-lg font-semibold text-foreground border-none focus:outline-none focus:ring-0 w-48"
            placeholder={t('toolbar.untitled')}
          />
        </div>
        {/* Clear All button - always visible when devices exist */}
        {hasDevices && onClearAll && (
          <button
            onClick={onClearAll}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all",
              "bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30"
            )}
            title={t('toolbar.clearAllTitle')}
          >
            <Trash2 className="w-4 h-4" />
            <span className="hidden lg:inline">{t('toolbar.clearAll')}</span>
          </button>
        )}
      </div>

      {/* Center section - Actions */}
      <div className="flex items-center gap-1">
        <ToolbarButton icon={Undo2} label={t('toolbar.undo')} onClick={onUndo} disabled={!canUndo} />
        <ToolbarButton icon={Redo2} label={t('toolbar.redo')} onClick={onRedo} disabled={!canRedo} />
        <div className="w-px h-6 bg-white/10 mx-2" />
        <ToolbarButton icon={Save} label={t('toolbar.save')} onClick={onSave} />
        <ToolbarButton icon={FolderOpen} label={t('toolbar.open')} onClick={onOpen} />
        <div className="w-px h-6 bg-white/10 mx-2" />
        <ToolbarButton icon={Download} label={t('toolbar.export')} onClick={onExport} />
        <ToolbarButton
          icon={ImageDown} label={t('export.image.button')}
          title={t('export.image.buttonTitle')} onClick={onExportImage}
        />
        <ToolbarButton icon={Upload} label={t('toolbar.import')} onClick={onImport} />
        <div className="w-px h-6 bg-white/10 mx-2" />
        <ToolbarButton icon={RotateCcw} label={t('toolbar.reset')} onClick={onReset} />
      </div>

      {/* Right section - Settings, Help */}
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1 text-foreground/70">
          <Languages className="w-4 h-4" aria-hidden="true" />
          <span className="sr-only">{t('toolbar.language')}</span>
          <select
            value={locale}
            onChange={(event) => { if (isLocale(event.target.value)) setLocale(event.target.value); }}
            className="bg-transparent text-sm border border-white/10 rounded-md px-1 py-0.5"
            data-testid="language-select"
          >
            {LOCALES.map(code => (
              <option key={code} value={code} className="bg-card text-foreground">{LOCALE_NAMES[code]}</option>
            ))}
          </select>
        </label>
        <ToolbarButton icon={Settings} label={t('toolbar.settings')} onClick={onSettings} />
        <ToolbarButton icon={HelpCircle} label={t('toolbar.help')} onClick={onHelp} />
      </div>
    </div>
  );
}

interface ToolbarButtonProps {
  icon: React.ElementType;
  label: string;
  title?: string;
  onClick?: () => void;
  disabled?: boolean;
}

function ToolbarButton({ icon: Icon, label, title, onClick, disabled }: ToolbarButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all",
        "text-foreground/70 hover:text-foreground hover:bg-white/10",
        disabled && "opacity-40 cursor-not-allowed hover:bg-transparent hover:text-foreground/70"
      )}
      title={title ?? label}
    >
      <Icon className="w-4 h-4" />
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}
