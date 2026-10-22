// Silence the ExperimentalWarning printed by node:sqlite on Node 22.
const originalEmitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message;
  if (text && (text.includes('SQLite') || text.includes('disableRequestLogging'))) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (originalEmitWarning as any).call(process, warning, ...args);
}) as typeof process.emitWarning;
export {};
