/**
 * Smoke test: hit `flywheel_list_nodes` with no extra args and print a
 * summary. Validates token resolution, transport, JSON-RPC parsing, and the
 * MCP isError pathway.
 */

import { FlywheelMcpClient } from '../src/index.js';

async function main(): Promise<void> {
  const client = new FlywheelMcpClient();
  const t0 = Date.now();
  const raw = await client.callTool<unknown>('flywheel_list_nodes', {});
  const dt = Date.now() - t0;
  if (Array.isArray(raw)) {
    console.log(`OK ${raw.length} nodes in ${dt}ms`);
    console.log(JSON.stringify(raw.slice(0, 2), null, 2));
  } else if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>;
    const nodes = (obj['nodes'] ?? obj['items'] ?? []) as unknown[];
    console.log(`OK ${nodes.length} nodes in ${dt}ms; top-level keys:`, Object.keys(obj));
    if (nodes.length > 0) console.log(JSON.stringify(nodes[0], null, 2));
  } else {
    console.log(`Unexpected payload type: ${typeof raw}`);
    console.log(String(raw).slice(0, 500));
  }
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
