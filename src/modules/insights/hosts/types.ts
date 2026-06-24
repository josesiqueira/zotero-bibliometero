/**
 * hosts/types.ts - the small host-controller contract shared by the bottom dock
 * (dock.ts) and the pop-out tab (tab.ts).
 *
 * A host knows HOW to create a place for the Insights shell to live (a resizable
 * dock inside the library view, or a full Zotero tab). It returns a header bar +
 * a scrollable body; the hub's buildShell() then mounts the nav strip, topbar,
 * viewport and status into those two elements. The hub owns the active view and
 * state; the host owns only its chrome and teardown.
 */

/** The two host slots the shell mounts into. */
export interface HostMount {
  /** The header bar (nav tab-strip + source toggle + export + maximize/restore). */
  header: HTMLElement;
  /** The scrollable content area (viewport + status). */
  body: HTMLElement;
}

export interface HostController {
  /** "dock" | "tab" - lets buildShell render the right maximize/restore affordance. */
  kind(): "dock" | "tab";
  /** Create the host chrome for a window and return its header + body slots. */
  open(win: _ZoteroTypes.MainWindow): HostMount | null;
  /** Tear the host chrome down and restore the original layout. */
  close(win: _ZoteroTypes.MainWindow): void;
  /** Is the host currently open for this window? */
  isOpen(win: _ZoteroTypes.MainWindow): boolean;
  /** Best-effort full teardown for a window (unload / disable). */
  dispose(win: _ZoteroTypes.MainWindow): void;
}
