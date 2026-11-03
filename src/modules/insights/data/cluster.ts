/**
 * data/cluster.ts - community detection for the co-authorship network.
 *
 * Louvain modularity optimisation (Blondel et al. 2008), the method VOSviewer
 * and bibliometrix offer for author maps: repeatedly move each node to the
 * neighbouring group that most increases modularity, then merge each group
 * into one node and repeat until nothing moves. Nodes are visited in a fixed
 * order, so the same graph always gives the same groups (no flicker between
 * redraws). Pure and dependency-free.
 */

export interface WeightedEdge {
  a: string;
  b: string;
  w: number;
}

/** Map every node id to a group number (0..k-1, in no particular order). */
export function louvain(
  nodeIds: string[],
  edges: WeightedEdge[],
): Map<string, number> {
  // Work on integer indices.
  const index = new Map<string, number>();
  nodeIds.forEach((id, i) => index.set(id, i));
  let n = nodeIds.length;
  let adj: Array<Map<number, number>> = Array.from(
    { length: n },
    () => new Map(),
  );
  for (const e of edges) {
    const i = index.get(e.a);
    const j = index.get(e.b);
    if (i === undefined || j === undefined || i === j || !(e.w > 0)) continue;
    adj[i]!.set(j, (adj[i]!.get(j) || 0) + e.w);
    adj[j]!.set(i, (adj[j]!.get(i) || 0) + e.w);
  }
  // membership[original node] = current super-node
  let membership = nodeIds.map((_, i) => i);

  for (let level = 0; level < 10; level++) {
    const { community, moved } = oneLevel(n, adj);
    if (!moved) break;
    // Renumber communities 0..k-1.
    const renum = new Map<number, number>();
    for (const c of community) if (!renum.has(c)) renum.set(c, renum.size);
    membership = membership.map((s) => renum.get(community[s]!)!);
    // Aggregate the graph: one node per community.
    const k = renum.size;
    const next: Array<Map<number, number>> = Array.from(
      { length: k },
      () => new Map(),
    );
    for (let i = 0; i < n; i++) {
      const ci = renum.get(community[i]!)!;
      for (const [j, w] of adj[i]!) {
        const cj = renum.get(community[j]!)!;
        next[ci]!.set(cj, (next[ci]!.get(cj) || 0) + w);
      }
    }
    adj = next;
    n = k;
  }

  const out = new Map<string, number>();
  nodeIds.forEach((id, i) => out.set(id, membership[i]!));
  return out;
}

/** One pass of local moves. Self-loops (adj[i].get(i)) carry inner weight. */
function oneLevel(
  n: number,
  adj: Array<Map<number, number>>,
): { community: number[]; moved: boolean } {
  const community = Array.from({ length: n }, (_, i) => i);
  const degree = adj.map((m) => {
    let s = 0;
    for (const w of m.values()) s += w;
    return s;
  });
  const m2 = degree.reduce((s, d) => s + d, 0); // 2m
  if (m2 === 0) return { community, moved: false };
  const tot = degree.slice(); // total degree per community

  let moved = false;
  for (let pass = 0; pass < 20; pass++) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      const ci = community[i]!;
      // Weight from i to each neighbouring community.
      const toComm = new Map<number, number>();
      for (const [j, w] of adj[i]!) {
        if (j === i) continue;
        const cj = community[j]!;
        toComm.set(cj, (toComm.get(cj) || 0) + w);
      }
      const ki = degree[i]!;
      tot[ci]! -= ki;
      let best = ci;
      let bestGain = (toComm.get(ci) || 0) - (tot[ci]! * ki) / m2;
      // Deterministic: scan candidate communities in ascending id order.
      for (const c of Array.from(toComm.keys()).sort((a, b) => a - b)) {
        const gain = toComm.get(c)! - (tot[c]! * ki) / m2;
        if (gain > bestGain + 1e-12) {
          best = c;
          bestGain = gain;
        }
      }
      tot[best]! += ki;
      if (best !== ci) {
        community[i] = best;
        changed++;
        moved = true;
      }
    }
    if (!changed) break;
  }
  return { community, moved };
}
