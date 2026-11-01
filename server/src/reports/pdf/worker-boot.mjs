// Starts the PDF worker (#13) from the TypeScript sources – Docker image, development and tests: tsx compiles them
// in this thread too. The desktop executable runs the bundled worker instead (pool.ts).
import { register } from 'tsx/esm/api';

register();
await import('./worker-entry.ts');
