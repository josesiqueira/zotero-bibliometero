import { config } from "../../package.json";

type PluginPrefsMap = _ZoteroTypes.Prefs["PluginPrefsMap"];

const PREFS_PREFIX = config.prefsPrefix;

/**
 * Get preference value.
 * Wrapper of `Zotero.Prefs.get`.
 * @param key
 */
export function getPref<K extends keyof PluginPrefsMap>(key: K) {
  return Zotero.Prefs.get(`${PREFS_PREFIX}.${key}`, true) as PluginPrefsMap[K];
}

/**
 * Set preference value.
 * Wrapper of `Zotero.Prefs.set`.
 * @param key
 * @param value
 */
export function setPref<K extends keyof PluginPrefsMap>(
  key: K,
  value: PluginPrefsMap[K],
) {
  return Zotero.Prefs.set(`${PREFS_PREFIX}.${key}`, value, true);
}

/**
 * Clear preference value.
 * Wrapper of `Zotero.Prefs.clear`.
 * @param key
 */
export function clearPref(key: string) {
  return Zotero.Prefs.clear(`${PREFS_PREFIX}.${key}`, true);
}

/**
 * Untyped read of a namespaced preference under the plugin prefix.
 * Used for per-view prefs (`view.<id>.<key>`) and other dynamic keys that are
 * not part of the typed PluginPrefsMap. Returns `undefined` when unset.
 */
export function getPrefRaw(key: string): unknown {
  return Zotero.Prefs.get(`${PREFS_PREFIX}.${key}`, true);
}

/**
 * Untyped write of a namespaced preference under the plugin prefix. Mirror of
 * `getPrefRaw`. Accepts string | number | boolean (Zotero.Prefs storage types).
 */
export function setPrefRaw(
  key: string,
  value: string | number | boolean,
): void {
  Zotero.Prefs.set(`${PREFS_PREFIX}.${key}`, value, true);
}
