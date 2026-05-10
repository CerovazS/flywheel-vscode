import { FlywheelMcpClient } from '../src/index.js';

async function main(): Promise<void> {
  const client = new FlywheelMcpClient();
  const list = await client.callTool<{ nodes: Array<{ node_id: string }> }>('flywheel_list_nodes', {});
  const target = list.nodes[0]!.node_id;
  console.log('Probing flywheel_get_node on', target);
  const res = await client.callTool<unknown>('flywheel_get_node', { node_id: target });
  if (typeof res === 'object' && res !== null) {
    console.log('Top-level keys:', Object.keys(res as object));
    console.log(JSON.stringify(res, null, 2).slice(0, 2000));
  } else {
    console.log('Shape:', typeof res, res);
  }
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
