import { initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { GraphViewFactory } from "./modules/graphView";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // Knowledge graph (the one and only feature).
  await GraphViewFactory.register();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Mark initialized so external tooling (scaffold test runner) can detect load.
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window.
  addon.data.ztoolkit = createZToolkit();
  GraphViewFactory.registerWindow(win);
}

async function onMainWindowUnload(win: _ZoteroTypes.MainWindow): Promise<void> {
  GraphViewFactory.unregisterWindow(win);
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

async function onShutdown(): Promise<void> {
  GraphViewFactory.unregister();

  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * Dispatcher for Notify events. The graph registers its own targeted observer,
 * so this stays minimal.
 */
async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  ztoolkit.log("notify", event, type, ids, extraData);
}

/**
 * Dispatcher for Preference UI events.
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

function onShortcuts(_type: string) {
  // The graph registers its own Ctrl/Cmd+Alt+G shortcut directly.
}

function onDialogEvents(_type: string) {
  // No dialog events in this build.
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
