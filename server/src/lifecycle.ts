/** Where the process is in its life (bootstrap.ts sets it): readiness answers 503 once it is stopping. No imports. */
export type Phase = 'starting' | 'running' | 'stopping' | 'stopped';
let phase: Phase = 'starting';

export const lifecyclePhase = (): Phase => phase;
export const shuttingDown = (): boolean => phase === 'stopping' || phase === 'stopped';
export function setLifecyclePhase(p: Phase): void {
  phase = p;
}
