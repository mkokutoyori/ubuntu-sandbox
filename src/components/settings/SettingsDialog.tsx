import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { defaultSettingsRegistry } from './defaultSettingsRegistry';
import type { SettingsRegistry } from './settingsRegistry';

const SEARCH_MIN_SECTIONS = 5;

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registry?: SettingsRegistry;
  initialSectionId?: string;
}

export function SettingsDialog({
  open, onOpenChange, registry = defaultSettingsRegistry, initialSectionId,
}: SettingsDialogProps) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(initialSectionId ?? registry.list()[0]?.id);
  useEffect(() => {
    if (!open) return;
    setQuery('');
    if (initialSectionId !== undefined) setSelectedId(initialSectionId);
  }, [open, initialSectionId]);
  const matches = useMemo(() => registry.search(query), [registry, query]);
  const active = matches.find((section) => section.id === selectedId) ?? matches[0];
  const Panel = active?.component;
  const searchable = registry.list().length >= SEARCH_MIN_SECTIONS;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(34rem,85vh)] max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:flex-row"
        data-testid="settings-dialog"
      >
        <aside className="flex shrink-0 flex-col gap-3 border-b border-white/10 p-4 sm:w-56 sm:border-b-0 sm:border-r">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="sr-only">Preferences of the simulator, by category.</DialogDescription>
          {searchable && (
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search settings"
                aria-label="Search settings"
                className="w-full rounded-md border border-white/10 bg-transparent py-2 pl-8 pr-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
          )}
          <nav aria-label="Settings categories" className="flex gap-1 overflow-x-auto sm:flex-col sm:overflow-visible">
            {matches.map((section) => {
              const Icon = section.icon;
              const current = section.id === active?.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => setSelectedId(section.id)}
                  aria-current={current ? 'page' : undefined}
                  data-testid={`settings-nav-${section.id}`}
                  className={cn(
                    'flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm',
                    current ? 'bg-primary/15 text-primary' : 'text-foreground/70 hover:bg-white/10 hover:text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span>{section.label}</span>
                </button>
              );
            })}
            {matches.length === 0 && (
              <p className="px-3 py-2 text-sm text-muted-foreground" data-testid="settings-no-match">No matching settings.</p>
            )}
          </nav>
        </aside>
        <main className="min-h-0 flex-1 overflow-y-auto p-6" data-testid="settings-panel">
          {active && Panel && (
            <>
              <header className="mb-4 pr-6">
                <h2 className="text-lg font-semibold text-foreground">{active.label}</h2>
                <p className="text-sm text-muted-foreground">{active.description}</p>
              </header>
              <Panel />
            </>
          )}
        </main>
      </DialogContent>
    </Dialog>
  );
}
