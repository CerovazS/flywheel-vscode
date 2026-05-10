/**
 * Smoke: getNodeTree() returns flat nodes + derived edges.
 */

import { FlywheelMcpClient, getNodeTree, listNodes } from '../src/index.js';

async function main(): Promise<void> {
  const client = new FlywheelMcpClient();
  const list = await listNodes(client, { page_size: 50 });
  const candidate =
    list.nodes.find(
      (n) =>
        Array.isArray(n.outgoing_ids) &&
        n.outgoing_ids.length > 2 &&
        (n.incoming_ids?.length ?? 0) === 0,
    ) ??
    list.nodes[0]!;
  console.log(`Probing tree on ${candidate.node_id} (${candidate.title.slice(0, 60)})`);
  const t0 = Date.now();
  const tree = await getNodeTree(client, candidate.node_id);
  console.log(
    `OK root=${tree.root_id.slice(0, 8)} · ${tree.nodes.length} nodes · ${tree.edges.length} edges in ${Date.now() - t0}ms`,
  );
  for (const n of tree.nodes.slice(0, 3)) {
    console.log(
      `  • ${n.node_id.slice(0, 8)}  d=${n.depth ?? '?'}  out=${n.outgoing_ids?.length ?? 0}  ${n.title.slice(0, 60)}`,
    );
  }
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
