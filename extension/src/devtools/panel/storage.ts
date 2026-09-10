/**
 * Per-viewer UI preferences: pane sizes, log filters.
 *
 * `localStorage` is available in a DevTools panel, but not in every context this
 * bundle can be loaded into (the verify harness, a sandboxed frame), and the
 * accessor itself throws when site data is blocked. A forgotten pane size is
 * never worth a blank panel, so every access is guarded.
 *
 * Nothing here belongs in the workspace: these are personal to whoever is
 * looking, and would be noise in an exported or committed workspace file.
 */

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string | number | boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore: the preference simply will not be remembered */
  }
}
