/**
 * GitHub repo URL canonicalization.
 *
 * Goal: match `git@github.com:owner/repo.git`, `https://github.com/owner/repo`,
 * `https://github.com/owner/repo.git`, and `ssh://git@github.com/owner/repo.git`
 * to the same canonical form so we can compare against `node.repo_context.repo_url`.
 *
 * Canonical form: `https://github.com/<owner>/<repo>` (no `.git`, no trailing slash, lowercased host).
 *
 * The actual VS Code Git extension binding lives in flywheel-vscode (it depends
 * on the `vscode` module). This module is pure and runtime-agnostic.
 */

export interface RepoIdentity {
  host: string;
  owner: string;
  repo: string;
  /** Canonical https URL form (no .git suffix). */
  canonical: string;
}

const PATTERNS: Array<RegExp> = [
  // git@github.com:owner/repo(.git)?
  /^[\w.-]+@(?<host>[^:]+):(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/,
  // ssh://git@github.com/owner/repo(.git)?
  /^ssh:\/\/[\w.-]+@(?<host>[^/]+)\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/,
  // https://github.com/owner/repo(.git)?  (also http://)
  /^https?:\/\/(?:[\w.-]+@)?(?<host>[^/]+)\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?(?:\/)?$/,
];

export function parseRepoUrl(url: string): RepoIdentity | null {
  if (!url) return null;
  const trimmed = url.trim();
  for (const re of PATTERNS) {
    const m = re.exec(trimmed);
    if (m?.groups) {
      const host = m.groups['host']!.toLowerCase();
      const owner = m.groups['owner']!;
      const repo = m.groups['repo']!.replace(/\.git$/, '');
      return {
        host,
        owner,
        repo,
        canonical: `https://${host}/${owner}/${repo}`,
      };
    }
  }
  return null;
}

export function normalizeRepoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return parseRepoUrl(url)?.canonical ?? null;
}

export function repoUrlsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = normalizeRepoUrl(a);
  const nb = normalizeRepoUrl(b);
  return na !== null && nb !== null && na === nb;
}
