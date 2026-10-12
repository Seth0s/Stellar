import { UpdateDialog } from "./UpdateDialog";
import { useUpdateStatus } from "./useUpdateStatus";

/**
 * Host of the update dialog (DESIGN-BACKLOG.md item 13, reworked). The old
 * single-line banner is gone: an update now gets its own dialog
 * (`UpdateDialog.tsx`) with real download progress and a restart that only
 * happens when the user asks. Nothing is drawn until the dialog is opened —
 * automatically once for a freshly offered version, or from the title-bar
 * icon (`Titlebar.tsx`) afterwards.
 *
 * Kept under this name so the places that mount it (`App.tsx`) stay as they are.
 */
export function UpdateBanner() {
  const { dialogOpen } = useUpdateStatus();
  return dialogOpen ? <UpdateDialog /> : null;
}
