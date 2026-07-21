import { BasicTool } from "zotero-plugin-toolkit";
import Addon from "./addon";
import { config } from "../package.json";

// Zotero 9 removed ChromeUtils.import (it now throws "has been removed").
// zotero-plugin-toolkit's _importESModule guards on
// `typeof ChromeUtils.import === "undefined"` — false here — so it calls the
// removed API and spams warnings. Drop the property so the toolkit falls back
// to importESModule.
try {
  const CU: any = (globalThis as any).ChromeUtils;
  if (CU && CU.import) {
    try {
      delete CU.import;
    } catch {
      CU.import = undefined;
    }
  }
} catch {
  /* ignore */
}

const basicTool = new BasicTool();

// @ts-expect-error - Plugin instance is not typed
if (!basicTool.getGlobal("Zotero")[config.addonInstance]) {
  _globalThis.addon = new Addon();
  defineGlobal("ztoolkit", () => {
    return _globalThis.addon.data.ztoolkit;
  });
  // @ts-expect-error - Plugin instance is not typed
  Zotero[config.addonInstance] = addon;
}

function defineGlobal(name: Parameters<BasicTool["getGlobal"]>[0]): void;
function defineGlobal(name: string, getter: () => any): void;
function defineGlobal(name: string, getter?: () => any) {
  Object.defineProperty(_globalThis, name, {
    get() {
      return getter ? getter() : basicTool.getGlobal(name);
    },
  });
}
