import { useEffect, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLocale } from '@/i18n/useLocale';
import { SIMULATION_SPEEDS } from '@/events/SimulationClock';
import { simulationDate } from '@/network/core/SystemClock';
import { useSimulationClock } from '@/hooks/useSimulationClock';
import { DISPLAY_REFRESH_MS, SIMULATION_JUMPS, formatSimulatedInstant, formatSpeed } from './simulationClockFormat';

export function SimulationClockControls() {
  const { t } = useLocale();
  const { clock, state } = useSimulationClock();
  const [instant, setInstant] = useState(() => formatSimulatedInstant(simulationDate()));

  useEffect(() => {
    const refresh = () => setInstant(formatSimulatedInstant(simulationDate()));
    refresh();
    const handle = globalThis.setInterval(refresh, DISPLAY_REFRESH_MS);
    return () => globalThis.clearInterval(handle);
  }, [state]);

  if (!clock) return null;

  return (
    <div className="space-y-4" data-testid="simulation-clock">
      <div className="flex items-center gap-3">
        <span className="font-mono text-lg text-foreground" data-testid="simulation-instant">{instant}</span>
        <button
          type="button"
          onClick={() => (state.running ? clock.pause() : clock.play())}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-foreground/80 hover:text-foreground hover:bg-white/10 border border-white/10"
          title={state.running ? t('clock.pauseTitle') : t('clock.resumeTitle')}
          aria-label={state.running ? t('clock.pauseTitle') : t('clock.resumeTitle')}
          data-testid="simulation-toggle"
        >
          {state.running ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          <span>{state.running ? t('clock.pause') : t('clock.resume')}</span>
        </button>
      </div>
      <div>
        <div className="text-xs text-muted-foreground mb-1">{t('clock.speed')}</div>
        <div className="flex flex-wrap items-center gap-1">
          {SIMULATION_SPEEDS.map((speed) => (
            <button
              key={speed}
              type="button"
              onClick={() => clock.play(speed)}
              className={cn(
                'px-2 py-1 rounded-md text-xs font-mono',
                state.running && state.speed === speed
                  ? 'bg-primary/20 text-primary'
                  : 'text-foreground/60 hover:text-foreground hover:bg-white/10',
              )}
              title={t('clock.speedTitle', { speed: formatSpeed(speed) })}
              data-testid={`simulation-speed-${speed}`}
            >
              {formatSpeed(speed)}
            </button>
          ))}
        </div>
      </div>
      <div>
        <div className="text-xs text-muted-foreground mb-1">{t('clock.advance')}</div>
        <div className="flex flex-wrap items-center gap-1">
          {SIMULATION_JUMPS.map((jump) => (
            <button
              key={jump.ms}
              type="button"
              disabled={state.advancing}
              onClick={() => { void clock.advance(jump.ms); }}
              className={cn(
                'px-2 py-1 rounded-md text-xs text-foreground/60 hover:text-foreground hover:bg-white/10',
                state.advancing && 'opacity-40 cursor-not-allowed',
              )}
              title={t('clock.advanceTitle', { span: t(jump.spanKey) })}
              data-testid={`simulation-jump-${jump.ms}`}
            >
              {t(jump.labelKey)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
