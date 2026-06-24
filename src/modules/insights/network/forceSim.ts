/**
 * forceSim.ts - Dependency-free force-directed layout engine (FIXED copy).
 *
 * Velocity-Verlet style integrator with three forces:
 *   (a) many-body repulsion approximated with a Barnes-Hut quadtree (O(n log n));
 *   (b) link springs pulling edge endpoints toward a rest length, scaled by
 *       1/weight so heavier links sit closer;
 *   (c) weak centering gravity that keeps disconnected components on-screen.
 *
 * This is a clean copy of src/modules/graphView/forceSim.ts evolved for the
 * Insights NetModel and with the JITTER bug fixed (quality fix #1):
 *   - every Math.random() in the force loop is replaced by a DETERMINISTIC
 *     id-hash offset, so coincident nodes separate the same way every tick and
 *     the layout can actually converge;
 *   - a velocity-gated settle: once alpha < ALPHA_MIN AND the maximum node speed
 *     drops below SPEED_MIN, all velocities are zeroed on that final tick so the
 *     positions are pixel-stable across frames and the rAF loop can stop;
 *   - theta lowered to 0.75 for steadier (less popping) Barnes-Hut aggregation.
 *
 * No DOM and no Zotero references: trivially unit testable.
 */

import type { NetModel, NetNode } from "../types";

export interface ForceSimOptions {
  charge?: number; // many-body strength (negative = repulsion)
  linkDistance?: number; // spring rest length in px
  gravity?: number; // centering strength
  alphaDecay?: number; // per-tick alpha multiplier decrement
  /** Barnes-Hut opening criterion; larger = faster, less accurate. */
  theta?: number;
}

interface QuadNode {
  // Bounds of this cell.
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  // Aggregate mass / center of mass.
  mass: number;
  cx: number;
  cy: number;
  // Either a single body (leaf) or four children.
  body: NetNode | null;
  children: (QuadNode | null)[] | null;
}

const ALPHA_MIN = 0.005;
const ALPHA_TARGET = 0;
const VELOCITY_DECAY = 0.82; // damping per tick
/** Max per-node speed (px/tick) under which the layout is considered at rest. */
const SPEED_MIN = 0.05;

/**
 * Deterministic small offset derived from a node id. Replaces Math.random()
 * so coincident nodes always separate in the SAME direction (quality fix #1:
 * no more frame-to-frame boiling). Returns a unit-ish vector with magnitude in
 * roughly [0.001, 0.011] px.
 */
function jitterOffset(id: string): { dx: number; dy: number } {
  // FNV-1a style hash over the id string (deterministic, dependency-free).
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Two independent angles from the hash bits.
  const a = ((h >>> 0) % 360) * (Math.PI / 180);
  const mag = 0.001 + (((h >>> 9) & 0x3ff) / 0x3ff) * 0.01;
  return { dx: Math.cos(a) * mag, dy: Math.sin(a) * mag };
}

export class ForceSim {
  private nodes: NetNode[] = [];
  private edges: { source: NetNode; target: NetNode; weight: number }[] = [];
  private byId = new Map<string, NetNode>();

  private charge: number;
  private linkDistance: number;
  private gravity: number;
  private alphaDecay: number;
  private theta2: number;

  private alpha = 1;
  private center = { x: 0, y: 0 };
  /** True once the velocity-gated settle has fired (positions frozen). */
  private atRest = false;

  constructor(opts: ForceSimOptions = {}) {
    this.charge = opts.charge ?? -220;
    this.linkDistance = opts.linkDistance ?? 60;
    this.gravity = opts.gravity ?? 0.05;
    this.alphaDecay = opts.alphaDecay ?? 0.022;
    const theta = opts.theta ?? 0.75;
    this.theta2 = theta * theta;
  }

  /** Update tunable force parameters without rebuilding the graph. */
  setParams(opts: ForceSimOptions): void {
    if (opts.charge !== undefined) this.charge = opts.charge;
    if (opts.linkDistance !== undefined) this.linkDistance = opts.linkDistance;
    if (opts.gravity !== undefined) this.gravity = opts.gravity;
    if (opts.alphaDecay !== undefined) this.alphaDecay = opts.alphaDecay;
    if (opts.theta !== undefined) this.theta2 = opts.theta * opts.theta;
  }

  /** Set the logical center toward which gravity pulls (canvas center). */
  setCenter(x: number, y: number): void {
    this.center.x = x;
    this.center.y = y;
  }

  /**
   * Load a model into the simulation. Nodes keep their existing x/y if already
   * positioned (so a rebuild does not violently re-seed); new nodes are placed
   * on a phyllotaxis spiral around the center to avoid initial overlap.
   */
  setGraph(model: NetModel): void {
    this.nodes = model.nodes;
    this.byId.clear();
    for (const n of this.nodes) this.byId.set(n.id, n);

    const radiusStep = Math.max(this.linkDistance, 30);
    const golden = Math.PI * (3 - Math.sqrt(5));
    let i = 0;
    for (const node of this.nodes) {
      if (
        !isFinite(node.x) ||
        !isFinite(node.y) ||
        (node.x === 0 && node.y === 0)
      ) {
        const r = radiusStep * Math.sqrt(i + 0.5);
        const a = i * golden;
        node.x = this.center.x + r * Math.cos(a);
        node.y = this.center.y + r * Math.sin(a);
        node.vx = 0;
        node.vy = 0;
      }
      i++;
    }

    this.edges = [];
    for (const e of model.edges) {
      const s = this.byId.get(e.source);
      const t = this.byId.get(e.target);
      if (s && t) this.edges.push({ source: s, target: t, weight: e.weight });
    }

    this.reheat();
  }

  /** Restore alpha so the simulation runs again (after a rebuild or drag). */
  reheat(): void {
    this.alpha = 1;
    this.atRest = false;
  }

  /**
   * Gentle reheat used on drag-start: bump alpha just enough to let neighbours
   * relax, never resetting to 1 (quality fix #1: drag must not boil the graph).
   */
  nudge(target = 0.3): void {
    if (this.alpha < target) this.alpha = target;
    this.atRest = false;
  }

  /** Pin a node to a fixed position (excluded from integration). */
  pin(id: string, x: number, y: number): void {
    const n = this.byId.get(id);
    if (n) {
      n.fx = x;
      n.fy = y;
      n.x = x;
      n.y = y;
    }
  }

  /** Release a previously pinned node. */
  unpin(id: string): void {
    const n = this.byId.get(id);
    if (n) {
      n.fx = null;
      n.fy = null;
    }
  }

  /** Release every pinned node (toolbar "Release pins"). */
  releaseAll(): void {
    for (const n of this.nodes) {
      n.fx = null;
      n.fy = null;
    }
  }

  /** Whether the simulation has effectively settled (alpha + velocity gated). */
  get settled(): boolean {
    return this.atRest || this.alpha < ALPHA_MIN;
  }

  /**
   * Advance the simulation one step. Returns false once the layout has cooled
   * AND come to rest; on that final tick all velocities are zeroed so positions
   * stay pixel-stable across frames.
   */
  tick(): boolean {
    if (this.nodes.length === 0) return false;
    if (this.atRest) return false;

    this.alpha += (ALPHA_TARGET - this.alpha) * this.alphaDecay;
    const alpha = this.alpha;

    // (a) Many-body repulsion via Barnes-Hut quadtree.
    this.applyManyBody(alpha);
    // (b) Link springs.
    this.applyLinks(alpha);
    // (c) Centering gravity.
    this.applyGravity(alpha);

    // Integrate, tracking the maximum speed for the settle gate.
    let maxSpeed2 = 0;
    for (const node of this.nodes) {
      if (node.fx !== null) {
        node.x = node.fx;
        node.vx = 0;
      } else {
        node.vx *= VELOCITY_DECAY;
        node.x += node.vx;
      }
      if (node.fy !== null) {
        node.y = node.fy;
        node.vy = 0;
      } else {
        node.vy *= VELOCITY_DECAY;
        node.y += node.vy;
      }
      const s2 = node.vx * node.vx + node.vy * node.vy;
      if (s2 > maxSpeed2) maxSpeed2 = s2;
    }

    // Velocity-gated settle: cold AND slow -> freeze (quality fix #1). Zero
    // every velocity on this final tick so the next frame is identical.
    if (this.alpha < ALPHA_MIN && maxSpeed2 < SPEED_MIN * SPEED_MIN) {
      for (const node of this.nodes) {
        node.vx = 0;
        node.vy = 0;
      }
      this.atRest = true;
      return false;
    }

    return true;
  }

  // ---- Forces ----------------------------------------------------------

  private applyGravity(alpha: number): void {
    const g = this.gravity * alpha;
    if (g === 0) return;
    for (const node of this.nodes) {
      if (node.fx === null) node.vx += (this.center.x - node.x) * g;
      if (node.fy === null) node.vy += (this.center.y - node.y) * g;
    }
  }

  private applyLinks(alpha: number): void {
    const base = this.linkDistance;
    for (const e of this.edges) {
      const s = e.source;
      const t = e.target;
      let dx = t.x - s.x;
      let dy = t.y - s.y;
      let dist = Math.sqrt(dx * dx + dy * dy);
      if (dist === 0) {
        // Coincident endpoints: separate deterministically by id hash so the
        // result is identical every tick (no boiling).
        const o = jitterOffset(t.id + "|" + s.id);
        dx = o.dx;
        dy = o.dy;
        dist = Math.sqrt(dx * dx + dy * dy);
      }
      // Heavier edges pull toward a shorter rest length.
      const rest = base / Math.sqrt(Math.max(1, e.weight));
      const k = 0.4 * alpha;
      const f = ((dist - rest) / dist) * k;
      const ox = dx * f;
      const oy = dy * f;
      // Split correction by inverse mass approximation (both mass 1 here).
      if (s.fx === null) s.vx += ox * 0.5;
      if (s.fy === null) s.vy += oy * 0.5;
      if (t.fx === null) t.vx -= ox * 0.5;
      if (t.fy === null) t.vy -= oy * 0.5;
    }
  }

  private applyManyBody(alpha: number): void {
    const n = this.nodes.length;
    if (n === 0) return;
    const root = this.buildQuadtree();
    if (!root) return;
    const strength = this.charge * alpha;
    for (const node of this.nodes) {
      this.accumulateRepulsion(node, root, strength);
    }
  }

  // ---- Barnes-Hut quadtree --------------------------------------------

  private buildQuadtree(): QuadNode | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of this.nodes) {
      if (node.x < minX) minX = node.x;
      if (node.y < minY) minY = node.y;
      if (node.x > maxX) maxX = node.x;
      if (node.y > maxY) maxY = node.y;
    }
    if (!isFinite(minX)) return null;
    // Square, padded bounds keep cell subdivision simple.
    const w = Math.max(maxX - minX, maxY - minY, 1) + 2;
    const root: QuadNode = {
      x0: minX - 1,
      y0: minY - 1,
      x1: minX - 1 + w,
      y1: minY - 1 + w,
      mass: 0,
      cx: 0,
      cy: 0,
      body: null,
      children: null,
    };
    for (const node of this.nodes) this.insert(root, node, 0);
    return root;
  }

  private insert(cell: QuadNode, body: NetNode, depth: number): void {
    // Update aggregate center of mass incrementally.
    const m = cell.mass + 1;
    cell.cx = (cell.cx * cell.mass + body.x) / m;
    cell.cy = (cell.cy * cell.mass + body.y) / m;
    cell.mass = m;

    if (!cell.children && cell.body === null) {
      cell.body = body;
      return;
    }

    // Guard against pathological recursion on coincident points.
    if (depth > 32) {
      return;
    }

    if (!cell.children) {
      cell.children = [null, null, null, null];
      const existing = cell.body;
      cell.body = null;
      if (existing) this.placeInChild(cell, existing, depth);
    }
    this.placeInChild(cell, body, depth);
  }

  private placeInChild(cell: QuadNode, body: NetNode, depth: number): void {
    const midX = (cell.x0 + cell.x1) / 2;
    const midY = (cell.y0 + cell.y1) / 2;
    const east = body.x >= midX ? 1 : 0;
    const south = body.y >= midY ? 1 : 0;
    const idx = south * 2 + east;
    const children = cell.children!;
    if (!children[idx]) {
      children[idx] = {
        x0: east ? midX : cell.x0,
        y0: south ? midY : cell.y0,
        x1: east ? cell.x1 : midX,
        y1: south ? cell.y1 : midY,
        mass: 0,
        cx: 0,
        cy: 0,
        body: null,
        children: null,
      };
    }
    this.insert(children[idx]!, body, depth + 1);
  }

  private accumulateRepulsion(
    node: NetNode,
    cell: QuadNode,
    strength: number,
  ): void {
    if (cell.mass === 0) return;
    // Leaf with the same single body: skip self-interaction.
    if (cell.body === node && cell.mass === 1) return;

    let dx = cell.cx - node.x;
    let dy = cell.cy - node.y;
    let dist2 = dx * dx + dy * dy;
    const width = cell.x1 - cell.x0;

    if (
      cell.children === null ||
      (width * width) / Math.max(dist2, 1e-9) < this.theta2
    ) {
      // Treat this cell as a single aggregate body.
      if (dist2 < 1e-6) {
        // Coincident: deterministic offset from the node id (no Math.random).
        const o = jitterOffset(node.id);
        dx = o.dx;
        dy = o.dy;
        dist2 = dx * dx + dy * dy;
      }
      // Soften at very short range to keep forces bounded.
      const dist = Math.sqrt(dist2);
      const minDist = 1;
      const eff = Math.max(dist, minDist);
      // Repulsion magnitude ~ strength * mass / dist^2 (strength is negative).
      const force = (strength * cell.mass) / (eff * eff);
      // Apply along the unit vector from cell to node (push node away).
      const ux = dx / dist;
      const uy = dy / dist;
      if (node.fx === null) node.vx += ux * force;
      if (node.fy === null) node.vy += uy * force;
      return;
    }

    // Otherwise recurse into children.
    for (const child of cell.children) {
      if (child) this.accumulateRepulsion(node, child, strength);
    }
  }
}
