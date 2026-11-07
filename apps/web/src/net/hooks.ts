import { useEffect, useState, useSyncExternalStore } from 'react';
import { client, type Snapshot } from './client.js';

export function useGame(): Snapshot {
  return useSyncExternalStore(client.subscribe, client.getSnapshot);
}

/** Current game-time estimate: server gameNow at receipt + local elapsed (unless the clock is frozen). */
export function useGameNow(intervalMs = 100): number {
  const snap = useGame();
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  const v = snap.view;
  if (!v) return 0;
  return v.clock.frozen ? v.clock.gameNow : v.clock.gameNow + (performance.now() - snap.receivedAt);
}

export function useRemaining(deadline: number | null | undefined): number | null {
  const now = useGameNow();
  if (deadline === null || deadline === undefined) return null;
  return Math.max(0, deadline - now);
}
