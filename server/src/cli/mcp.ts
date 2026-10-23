/**
 * MCP stdio bridge from the source tree:  npm run mcp -- --url http://127.0.0.1:4310 --api-key-file <file>
 * (the desktop executable runs the same bridge as `steward mcp …`). See mcp/bridge.ts and docs/MCP.md.
 */
import { runBridge } from '../mcp/bridge.js';

runBridge(process.argv.slice(2), 'npm run mcp --').then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`mcp: ${(e as Error)?.stack ?? e}\n`);
    process.exitCode = 1;
  },
);
