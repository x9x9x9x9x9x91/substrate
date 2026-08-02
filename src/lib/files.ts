/** Display name for a file-kind prop value: the basename of the linked
    path, trailing slashes tolerated so folders read cleanly too. */
export function basename(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, "");
  const last = trimmed.split("/").pop();
  return last || trimmed || path;
}
