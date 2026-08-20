/**
 * Wrapper around fetch for all /api/* calls.
 * Automatically detects 401 responses (session expired or invalid) and redirects to login.
 */
export async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.href = '/login.html';
    // Return a never-resolving promise to halt the calling code
    return new Promise(() => {});
  }
  return res;
}

export function escapeHtml(text: string | null | undefined): string {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

export function truncateUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/^\//, '').replace(/\.git$/, '');
    if (path) return path;
    return url.length > 50 ? url.substring(0, 50) + '…' : url;
  } catch {
    return url.length > 50 ? url.substring(0, 50) + '…' : url;
  }
}

export function formatErrorTime(isoStr: string): string {
  try {
    const d = new Date(isoStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDays = Math.floor(diffHr / 24);
    if (diffDays < 7) return `${diffDays}d ago`;

    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return isoStr;
  }
}

export const PRIORITY_COLORS: Record<number, string> = {
  1: '#D22630',
  2: '#FF8700',
  3: '#007A87',
  4: '#9CA3AF',
};

export const ORIGIN_ICONS: Record<string, string> = {
  user: '\u{1F464}',
  ai: '\u{1F916}',
  'user-assisted': '\u{1F91D}',
};

export const TYPE_CLASSES: Record<string, string> = {
  improvement: 'badge-improvement',
  bug: 'badge-bug',
  feature: 'badge-feature',
};

export const DEFAULT_MCP_CONFIG = {
  atlassian: true,
  azureDevops: true,
  awsApi: false,
  awsDocs: true,
};
