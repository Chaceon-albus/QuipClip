/**
 * The classifier of the files of one Open action (ADR 072, "One Open action").
 *
 * The action first gets the files, from the file dialog of the system or from a drop. Only then
 * does it decide what it does. A file whose name ends in `.qcproj` is a project file
 * (`hasProjectExtension`).
 *
 * The function is pure, so a test can run it in node.
 */

import { hasVideoFileExtension } from "@/features/media/dialog";
import { hasProjectExtension } from "./paths";

/** What one Open action does with its files. */
export type OpenPathsRequest =
  /**
   * No project file: the action imports the files as videos, as before (ADR 052). The paths are
   * all the paths of the request, in their order, and the import leaves out a file that is not a
   * video, as before.
   */
  | { readonly kind: "videos"; readonly paths: readonly string[] }
  /**
   * One project file, no other project file and no video: the action opens that project.
   * `othersIgnored` is true when the request also has files that are no video and no project
   * file. The action leaves them out.
   */
  | { readonly kind: "project"; readonly path: string; readonly othersIgnored: boolean }
  /** Each other set with a project file: the action opens nothing, and a message says why. */
  | { readonly kind: "projectNotAlone" };

/**
 * Classifies the paths of one Open action. A blank path counts as no file.
 *
 * @param paths The paths of the request, in their order.
 */
export function classifyOpenPaths(paths: readonly string[]): OpenPathsRequest {
  const files = paths.filter((path) => path.trim().length > 0);
  const projects = files.filter(hasProjectExtension);
  if (projects.length === 0) {
    return { kind: "videos", paths };
  }
  const [project] = projects;
  if (
    projects.length > 1 ||
    files.some(hasVideoFileExtension) ||
    project === undefined
  ) {
    return { kind: "projectNotAlone" };
  }
  return { kind: "project", path: project, othersIgnored: files.length > 1 };
}
