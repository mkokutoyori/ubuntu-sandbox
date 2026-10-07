import { useEffect, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SIMULATION_SPEEDS } from '@/events/SimulationClock';
import { simulationDate } from '@/network/core/SystemClock';
import { useSimulationClock } from '@/hooks/useSimulationClock';
import { DISPLAY_REFRESH_MS, SIMULATION_JUMPS, formatSimulatedInstant, formatSpeed } from './simulationClockFormat';

export function SimulationClockControls() {
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
    <div className="flex items-center gap-1" data-testid="simulation-clock">
      <span className="font-mono text-xs text-foreground/70 px-2" data-testid="simulation-instant">{instant}</span>
      <button
        type="button"
        onClick={() => (state.running ? clock.pause() : clock.play())}
        className="flex items-center px-2 py-1.5 rounded-lg text-foreground/70 hover:text-foreground hover:bg-white/10"
        title={state.running ? 'Pause the simulation' : 'Resume the simulation'}
        aria-label={state.running ? 'Pause the simulation' : 'Resume the simulation'}
        data-testid="simulation-toggle"
      >
        {state.running ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
      </button>
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
          title={`Run the simulation ${formatSpeed(speed)} faster than real time`}
          data-testid={`simulation-speed-${speed}`}
        >
          {formatSpeed(speed)}
        </button>
      ))}
      <div className="w-px h-6 bg-white/10 mx-1" />
      {SIMULATION_JUMPS.map((jump) => (
        <button
          key={jump.label}
          type="button"
          disabled={state.advancing}
          onClick={() => { void clock.advance(jump.ms); }}
          className={cn(
            'px-2 py-1 rounded-md text-xs text-foreground/60 hover:text-foreground hover:bg-white/10',
            state.advancing && 'opacity-40 cursor-not-allowed',
          )}
          title={`Advance every device by ${jump.label.slice(1)}`}
          data-testid={`simulation-jump-${jump.ms}`}
        >
          {jump.label}
        </button>
      ))}
    </div>
  );
}
