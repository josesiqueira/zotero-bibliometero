import type { VizFactory, VizModule } from "./types";

/**
 * Global, stateless registry of view factories. Order of registration == sidebar order.
 * Factories return a FRESH VizModule instance per activation (never shared across windows).
 */
const entries: Array<{ id: string; label: string; factory: VizFactory }> = [];

export const VizRegistry = {
  register(id: string, label: string, factory: VizFactory): void {
    if (entries.some((e) => e.id === id)) return; // idempotent
    entries.push({ id, label, factory });
  },
  list(): ReadonlyArray<{ id: string; label: string; factory: VizFactory }> {
    return entries;
  },
  create(id: string): VizModule | null {
    const e = entries.find((x) => x.id === id);
    return e ? e.factory() : null;
  },
  has(id: string): boolean {
    return entries.some((e) => e.id === id);
  },
  clear(): void {
    entries.length = 0;
  },
};
