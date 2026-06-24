/**
 * interaction.ts - Pointer state machine for the network canvas.
 *
 * Quality fix #2 (SMOOTH DRAG) lives here:
 *
 *   IDLE
 *     -- pointerdown on a node  --> MAYBE_DRAG (record press point, pin candidate)
 *     -- pointerdown on bg      --> PANNING
 *   MAYBE_DRAG
 *     -- pointermove > 4 CSS px --> DRAGGING
 *     -- pointerup (< 4px move) --> IDLE  (emit CLICK, not a drag)
 *   DRAGGING
 *     -- pointermove            --> pin node to cursor world point (no reheat-on-move)
 *     -- pointerup              --> IDLE  (node stays pinned)
 *   PANNING
 *     -- pointermove            --> translate the view
 *     -- pointerup              --> IDLE
 *   any state + pointercancel / blur --> reset to IDLE
 *
 * Hit-test slack is measured in SCREEN pixels (>= 8px) and converted to world
 * via / scale, so grabbing still works when zoomed out. A press that moves less
 * than the 4px threshold is a CLICK; the host decides open-vs-highlight.
 *
 * No DOM ownership beyond the listeners it attaches; no Zotero references.
 */

import type { NetModel, NetNode } from "../types";
import { nodeRadius, type ViewTransform } from "./scene";

/** Screen-pixel movement past which a press becomes a drag (not a click). */
const DRAG_THRESHOLD_PX = 4;
/** Extra hit-test slack in SCREEN pixels (grabbing tolerance when zoomed out). */
const HIT_SLACK_PX = 8;

type PointerState = "idle" | "maybeDrag" | "dragging" | "panning";

export interface InteractionCallbacks {
  /** Current model + view transform (read each event; they mutate over time). */
  getModel(): NetModel;
  getView(): ViewTransform;
  /** Local (CSS px relative to canvas) pointer point for an event. */
  localPoint(ev: PointerEvent): { x: number; y: number };

  /** Pin a node to a world point (used live while dragging). */
  pinNode(id: string, wx: number, wy: number): void;
  /** Bump alpha once on drag-start (quality fix #1: never on move). */
  nudgeSim(): void;
  /** Request a redraw (cheap; no reheat). */
  requestDraw(): void;

  /** A pan moved the view by this CSS-pixel delta (host updates tx/ty). */
  onPan(dxCss: number, dyCss: number): void;

  /** A real click (movement < threshold) landed on a node. */
  onNodeClick(node: NetNode): void;
  /** A real click landed on empty background. */
  onBackgroundClick(): void;

  /** Hover changed to this node (or null). Host updates cursor/tooltip/redraw. */
  onHover(node: NetNode | null, x: number, y: number): void;

  /** Wheel zoom toward a cursor point (host applies the transform). */
  onZoom(factor: number, x: number, y: number): void;
}

export class InteractionController {
  private canvas: HTMLCanvasElement;
  private cb: InteractionCallbacks;

  private state: PointerState = "idle";
  private pointerId: number | null = null;
  /** CSS-pixel press origin. */
  private pressX = 0;
  private pressY = 0;
  /** Pan origin (view tx/ty at pan start). */
  private panStartX = 0;
  private panStartY = 0;
  /** The node under a MAYBE_DRAG / DRAGGING press. */
  private candidate: NetNode | null = null;

  // Bound handlers (stable refs for add/removeEventListener).
  private readonly hDown = (e: PointerEvent) => this.onDown(e);
  private readonly hMove = (e: PointerEvent) => this.onMove(e);
  private readonly hUp = (e: PointerEvent) => this.onUp(e);
  private readonly hCancel = (e: PointerEvent) => this.onCancel(e);
  private readonly hLeave = () => this.onLeave();
  private readonly hWheel = (e: WheelEvent) => this.onWheel(e);
  private readonly hBlur = () => this.reset();

  constructor(canvas: HTMLCanvasElement, cb: InteractionCallbacks) {
    this.canvas = canvas;
    this.cb = cb;
  }

  attach(): void {
    const c = this.canvas;
    c.addEventListener("pointerdown", this.hDown);
    c.addEventListener("pointermove", this.hMove);
    c.addEventListener("pointerup", this.hUp);
    c.addEventListener("pointercancel", this.hCancel);
    c.addEventListener("pointerleave", this.hLeave);
    c.addEventListener("wheel", this.hWheel, { passive: false });
    const win = c.ownerDocument?.defaultView;
    if (win) win.addEventListener("blur", this.hBlur);
  }

  detach(): void {
    const c = this.canvas;
    c.removeEventListener("pointerdown", this.hDown);
    c.removeEventListener("pointermove", this.hMove);
    c.removeEventListener("pointerup", this.hUp);
    c.removeEventListener("pointercancel", this.hCancel);
    c.removeEventListener("pointerleave", this.hLeave);
    c.removeEventListener("wheel", this.hWheel);
    const win = c.ownerDocument?.defaultView;
    if (win) win.removeEventListener("blur", this.hBlur);
    this.reset();
  }

  /** Reset to IDLE (pointercancel / blur / detach). */
  private reset(): void {
    this.state = "idle";
    this.pointerId = null;
    this.candidate = null;
    this.canvas.classList.remove("bibliometero-grabbing");
  }

  /** Convert a screen (CSS-px) point to world coordinates. */
  private screenToWorld(x: number, y: number): { x: number; y: number } {
    const v = this.cb.getView();
    return { x: (x - v.tx) / v.scale, y: (y - v.ty) / v.scale };
  }

  /**
   * Nearest node whose disc (plus screen-space slack) contains the point, or
   * null. Slack is in SCREEN pixels and converted to world via / scale so the
   * grab tolerance stays constant as the user zooms.
   */
  hitTest(x: number, y: number): NetNode | null {
    const model = this.cb.getModel();
    const v = this.cb.getView();
    const w = this.screenToWorld(x, y);
    const slackWorld = HIT_SLACK_PX / v.scale;
    let best: NetNode | null = null;
    let bestD2 = Infinity;
    for (const n of model.nodes) {
      const r = nodeRadius(n) + slackWorld;
      const dx = n.x - w.x;
      const dy = n.y - w.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r * r && d2 < bestD2) {
        bestD2 = d2;
        best = n;
      }
    }
    return best;
  }

  // ---- Handlers --------------------------------------------------------

  private onDown(ev: PointerEvent): void {
    // Only track one pointer at a time.
    if (this.pointerId !== null) return;
    const { x, y } = this.cb.localPoint(ev);
    this.pointerId = ev.pointerId;
    this.pressX = x;
    this.pressY = y;
    try {
      this.canvas.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    const node = this.hitTest(x, y);
    if (node) {
      this.state = "maybeDrag";
      this.candidate = node;
    } else {
      this.state = "panning";
      const v = this.cb.getView();
      this.panStartX = v.tx;
      this.panStartY = v.ty;
      this.canvas.classList.add("bibliometero-grabbing");
    }
  }

  private onMove(ev: PointerEvent): void {
    const { x, y } = this.cb.localPoint(ev);

    if (this.state === "idle") {
      // Pure hover.
      const node = this.hitTest(x, y);
      this.cb.onHover(node, x, y);
      return;
    }

    if (this.pointerId !== ev.pointerId) return;

    if (this.state === "maybeDrag") {
      const dx = x - this.pressX;
      const dy = y - this.pressY;
      if (dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
        // Promote to a real drag: pin once and nudge (NOT reheat) one time.
        this.state = "dragging";
        this.cb.nudgeSim();
      } else {
        return; // still within click slack
      }
    }

    if (this.state === "dragging" && this.candidate) {
      // Pin the node to the cursor world point each move. No reheat here:
      // that is the boiling bug (#1). nudgeSim already ran on promotion.
      const w = this.screenToWorld(x, y);
      this.cb.pinNode(this.candidate.id, w.x, w.y);
      this.cb.requestDraw();
      return;
    }

    if (this.state === "panning") {
      const dxCss = x - this.pressX;
      const dyCss = y - this.pressY;
      this.cb.onPan(this.panStartX + dxCss, this.panStartY + dyCss);
      this.cb.requestDraw();
      return;
    }
  }

  private onUp(ev: PointerEvent): void {
    if (this.pointerId !== ev.pointerId) return;
    try {
      this.canvas.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    const prevState = this.state;
    const node = this.candidate;
    this.canvas.classList.remove("bibliometero-grabbing");

    if (prevState === "maybeDrag" && node) {
      // Moved < threshold over a node: a CLICK (host: open or highlight).
      this.cb.onNodeClick(node);
    } else if (prevState === "panning") {
      const { x, y } = this.cb.localPoint(ev);
      const movedX = x - this.pressX;
      const movedY = y - this.pressY;
      if (movedX * movedX + movedY * movedY < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
        // A press on empty background with no real movement: background click.
        this.cb.onBackgroundClick();
      }
    }
    // DRAGGING -> up: node stays pinned where it was placed (no action here).

    this.state = "idle";
    this.pointerId = null;
    this.candidate = null;
  }

  private onCancel(ev: PointerEvent): void {
    if (this.pointerId !== null && this.pointerId !== ev.pointerId) return;
    this.reset();
  }

  private onLeave(): void {
    // Clear hover when the pointer leaves the canvas (drag continues via capture).
    if (this.state === "idle") this.cb.onHover(null, 0, 0);
  }

  private onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.cb.onZoom(factor, x, y);
  }

  // ---- Test hook -------------------------------------------------------

  /**
   * Synthesize a pointer event for the live harness. Builds a minimal
   * PointerEvent-like object and routes it through the same handlers.
   */
  dispatch(type: "down" | "move" | "up" | "cancel", x: number, y: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const ev = {
      pointerId: 1,
      clientX: rect.left + x,
      clientY: rect.top + y,
      preventDefault() {
        /* no-op */
      },
    } as unknown as PointerEvent;
    if (type === "down") this.onDown(ev);
    else if (type === "move") this.onMove(ev);
    else if (type === "up") this.onUp(ev);
    else this.onCancel(ev);
  }
}
