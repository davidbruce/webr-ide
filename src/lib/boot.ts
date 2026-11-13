// Start-up progress, shown while R starts (StartupCard).
import { createSignal } from 'solid-js';

export interface BootStage {
  /** What is happening, e.g. "Loading R's base library". */
  label: string;
  done?: number;
  total?: number;
}

const [boot, setBootSignal] = createSignal<BootStage | null>(null);
const [bootStarted, setBootStarted] = createSignal(0);
export { boot, bootStarted };

export function setBoot(stage: BootStage | null) {
  if (stage && !boot()) setBootStarted(performance.now());
  setBootSignal(stage);
}

/** Update the count of the current stage. */
export function bootProgress(done: number, total: number) {
  const b = boot();
  if (b) setBootSignal({ ...b, done, total });
}
