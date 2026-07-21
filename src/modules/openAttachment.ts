/**
 * Open a PDF attachment in a new Zotero reader tab.
 *
 * Zotero.Reader.open() is the internal entry the app itself uses for tabs.
 * Signature (Zotero 7/8/9): open(itemID, location?, options?) where options
 * includes { openInBackground?, openInWindow?, allowDuplicate? }.
 */

export interface OpenOptions {
  /** Open without stealing focus from the current reader. */
  background?: boolean;
}

export async function openAttachmentInNewTab(
  attachmentID: number,
  opts: OpenOptions = {},
): Promise<boolean> {
  const background = opts.background ?? true;

  // Primary path: Zotero.Reader.open (opens/reuses a reader tab).
  try {
    if (Zotero.Reader?.open) {
      await Zotero.Reader.open(attachmentID, undefined, {
        openInBackground: background,
        // Reuse an existing tab for this attachment if already open.
        allowDuplicate: false,
      } as any);
      return true;
    }
  } catch (e) {
    Zotero.debug(`[zoterowiki] Zotero.Reader.open failed: ${e}`);
  }

  // Fallback: zotero://open-pdf URI via the library/item key.
  try {
    const att = Zotero.Items.get(attachmentID) as Zotero.Item;
    const libID = att.libraryID;
    const key = att.key;
    const libPart =
      libID === Zotero.Libraries.userLibraryID
        ? "library"
        : `groups/${Zotero.Groups.getGroupIDFromLibraryID(libID)}`;
    const uri = `zotero://open-pdf/${libPart}/items/${key}`;
    Zotero.launchURL(uri);
    return true;
  } catch (e) {
    Zotero.debug(`[zoterowiki] open-pdf URI fallback failed: ${e}`);
  }

  return false;
}
