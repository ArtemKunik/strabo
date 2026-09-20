/**
 * Repository link helpers: turn a Git remote or scan location into something the UI
 * can open or explain.
 *
 * Pure functions only: no DOM, no fetch.
 */

/** Normalise a Git remote into a browsable HTTPS base, or null when unrecognised. */
export function normalizeGitUrl(url) {
  if (!url) {
    return null;
  }
  let value = url.trim().replace(/\.git$/, '');
  const scp = /^(?:ssh:\/\/)?git@([^:/]+):(.+)$/.exec(value);
  if (scp) {
    value = `https://${scp[1]}/${scp[2]}`;
  } else if (value.startsWith('ssh://')) {
    value = `https://${value.slice('ssh://'.length).replace(/^[^@/]+@/, '')}`;
  }
  if (!/^https?:\/\//.test(value)) {
    return null;
  }
  return value.replace(/\/+$/, '');
}

/** Repository web URL fallback when no host `openWorkspaceFile` adapter exists. */
export function fileWebUrl(repository, path) {
  const base = normalizeGitUrl(repository?.gitUrl);
  if (!base || !path) {
    return null;
  }
  return `${base}/blob/HEAD/${path}`;
}

/**
 * Describe where the folder dialog sits relative to the scan ceiling.
 *
 * The ceiling is an operator boundary, so the dialog explains why "Up" stops instead of
 * leaving the button looking broken.
 */
export function folderLocation(result) {
  const atCeiling = !result.parent;
  return {
    atCeiling,
    path: result.path,
    ceiling: result.ceiling,
    upLabel: atCeiling ? 'Top of scan ceiling' : `Up to ${parentName(result.parent)}`,
    note: atCeiling
      ? `Scan ceiling reached. Raise STRABO_SCAN_CEILING to browse above ${result.ceiling}.`
      : `Scan ceiling: ${result.ceiling}`,
  };
}

function parentName(parent) {
  return String(parent).split(/[\\/]/).filter(Boolean).pop() ?? parent;
}
