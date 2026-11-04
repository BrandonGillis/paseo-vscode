import type { DOWNLOADS } from "../shared/rpc";
import { isCliInstalled } from "./devcontainer";
import { isInstalled } from "./install";

/*
 * Software the plugin downloads while running. Nothing is downloaded before the user
 * confirms it in a VS Code tab (see VSCodeView): the tab lists what is missing, with its
 * source and size, and the download starts only once they accept.
 */

export type Download = (typeof DOWNLOADS)[number];

/** Accepted by the user since the plugin started. A later version asks again. */
const approved = new Set<Download>();

/** What a start needs that is not downloaded yet; the dev container CLI only for containers. */
export async function missingDownloads(container: boolean): Promise<Download[]> {
  const missing: Download[] = [];
  if (!(await isInstalled())) missing.push("code-server");
  if (container && !(await isCliInstalled())) missing.push("devcontainer-cli");
  return missing;
}

/** The downloads in `list` the user has not accepted yet. */
export function unapproved(list: readonly Download[]): Download[] {
  return list.filter((d) => !approved.has(d));
}

export function approve(list: readonly Download[]) {
  for (const d of list) approved.add(d);
}

/** Called right before a download: refuses one the user has not accepted. */
export function assertApproved(download: Download) {
  if (!approved.has(download)) throw new Error("Download not confirmed. Open VS Code again to confirm it.");
}
