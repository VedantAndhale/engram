import { INDEX_FILE } from "../src/sync/paths.js";
import { parseIndex, type IndexFile } from "../src/sync/indexfile.js";

/*
 * The server's whole view of GitHub: which repos are Engram folders, their files, and adding
 * inbox files. It uses the caller's own token and keeps nothing but an ETag cache in memory,
 * so repeated reads come back 304 and don't count against the caller's rate limit.
 */

/** Must match FOLDER_DESCRIPTION_PREFIX in src/sync/github.ts (not imported: that file is browser code). */
const FOLDER_PREFIX = "Reader folder: ";
const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface FolderRepo {
  owner: string;
  repo: string;
  branch: string;
  /** The folder's name as the app shows it. */
  name: string;
}

export interface Folder extends FolderRepo {
  index: IndexFile | null;
}

/** Bounded so a long-lived instance can't grow without limit. Keyed by token hash, never the token. */
const cache = new Map<string, { etag: string; body: string }>();
const CACHE_MAX = 500;

export class GitHubReader {
  private constructor(
    private token: string,
    private key: string,
  ) {}

  static async create(token: string) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    return new GitHubReader(token, Buffer.from(digest).toString("base64url").slice(0, 16));
  }

  /** GET with the ETag cache. Returns null on 404. */
  private async get(path: string, accept = "application/vnd.github+json"): Promise<string | null> {
    const ck = `${this.key} ${accept} ${path}`;
    const hit = cache.get(ck);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "engram-mcp",
    };
    if (hit) headers["If-None-Match"] = hit.etag;
    const res = await fetch(API + path, { headers });
    if (res.status === 304 && hit) return hit.body;
    if (res.status === 404) return null;
    if (!res.ok) {
      const limited = res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
      const message =
        res.status === 401 ? "GitHub no longer accepts this sign-in (revoked or expired). Reconnect Engram in your app."
        : limited ? "GitHub rate limit reached; try again in a few minutes."
        : `GitHub said ${res.status} for ${path}`;
      throw new GitHubError(res.status, message);
    }
    const body = await res.text();
    const etag = res.headers.get("etag");
    if (etag) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
      cache.set(ck, { etag, body });
    }
    return body;
  }

  async login(): Promise<string> {
    const body = await this.get("/user");
    if (!body) throw new GitHubError(401, "This GitHub token doesn't work.");
    return (JSON.parse(body) as { login: string }).login;
  }

  /** Every repo the token reaches that the app marked as a folder. */
  async folderRepos(): Promise<FolderRepo[]> {
    const out: FolderRepo[] = [];
    for (let page = 1; page <= 10; page++) {
      const body = await this.get(`/user/repos?per_page=100&page=${page}&sort=full_name`);
      const repos = JSON.parse(body ?? "[]") as { name: string; owner: { login: string }; description: string | null; default_branch: string }[];
      for (const r of repos) {
        if (!r.description?.startsWith(FOLDER_PREFIX)) continue;
        out.push({ owner: r.owner.login, repo: r.name, branch: r.default_branch, name: r.description.slice(FOLDER_PREFIX.length).trim() || r.name });
      }
      if (repos.length < 100) break;
    }
    return out;
  }

  /** A file's text, or null if it isn't there. */
  file(f: FolderRepo, path: string): Promise<string | null> {
    const p = path.split("/").map(encodeURIComponent).join("/");
    return this.get(`/repos/${f.owner}/${f.repo}/contents/${p}?ref=${encodeURIComponent(f.branch)}`, "application/vnd.github.raw+json");
  }

  /**
   * Add a new file in one commit. The only write this server makes, and only for inbox/ files:
   * without a sha GitHub refuses to overwrite, so an existing file can never be replaced.
   */
  async create(f: FolderRepo, path: string, text: string, message: string): Promise<void> {
    if (!path.startsWith("inbox/")) throw new Error("Agents only write to inbox/.");
    const p = path.split("/").map(encodeURIComponent).join("/");
    const res = await fetch(`${API}/repos/${f.owner}/${f.repo}/contents/${p}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "engram-mcp",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, content: Buffer.from(text, "utf8").toString("base64"), branch: f.branch }),
    });
    if (!res.ok) throw new GitHubError(res.status, res.status === 401 ? "GitHub no longer accepts this sign-in. Reconnect Engram in your app." : `GitHub refused the save (${res.status}).`);
  }

  /** Every folder with its index. A folder the app hasn't indexed yet has index null. */
  async folders(): Promise<Folder[]> {
    const repos = await this.folderRepos();
    return Promise.all(
      repos.map(async (r) => {
        const text = await this.file(r, INDEX_FILE).catch(() => null);
        return { ...r, index: text ? parseIndex(text) : null };
      }),
    );
  }
}
