import { base64ToUtf8, blobToBase64, utf8ToBase64 } from "../lib/util";
import type { RepoRef } from "../model";

/** The signed-in GitHub account. One token, from Sign in with GitHub, serves every folder repository. */
export interface Account {
  token: string;
  login: string;
  name?: string;
  avatarUrl?: string;
}

export interface RepoSummary {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
  description: string | null;
  default_branch: string;
  permissions?: { push: boolean; admin: boolean };
}

/** Description written on every folder repo. Discovery looks for it, then confirms with reader.json. */
export const FOLDER_DESCRIPTION_PREFIX = "Engram folder: ";
/** Folder repos made before the rename. Still recognised, never written. */
export const LEGACY_FOLDER_DESCRIPTION_PREFIX = "Reader folder: ";

export const isFolderDescription = (description: string | null | undefined) =>
  !!description && (description.startsWith(FOLDER_DESCRIPTION_PREFIX) || description.startsWith(LEGACY_FOLDER_DESCRIPTION_PREFIX));

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAt?: number,
  ) {
    super(message);
  }
  get isConflict() {
    return this.status === 409 || this.status === 422;
  }
  get isAuth() {
    return this.status === 401;
  }
  get isRateLimit() {
    return this.retryAt !== undefined;
  }
}

const API = "https://api.github.com";

interface RequestOpts {
  method?: string;
  body?: unknown;
  accept?: string;
  keepalive?: boolean;
  etag?: string;
}

/**
 * Thin GitHub REST client. Everything runs in the browser; the token never leaves this device
 * except to api.github.com. Account-level calls need no repo; file calls need one.
 */
export class GitHub {
  constructor(
    private token: string,
    private repoRef?: RepoRef,
  ) {}

  private get cfg(): RepoRef {
    if (!this.repoRef) throw new Error("No repository selected");
    return this.repoRef;
  }

  private get repoPath() {
    return `/repos/${this.cfg.owner}/${this.cfg.repo}`;
  }

  async request(path: string, opts: RequestOpts = {}): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: opts.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    // Conditional requests that come back 304 do not count against the rate limit,
    // which is what makes frequent polling free.
    if (opts.etag) headers["If-None-Match"] = opts.etag;
    let res: Response;
    try {
      res = await fetch(API + path, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        cache: "no-store",
        keepalive: opts.keepalive,
      });
    } catch {
      throw new GitHubError(0, "Network unavailable");
    }
    if (res.ok || res.status === 304) return res;

    let message = res.statusText;
    try {
      message = ((await res.json()) as { message?: string }).message ?? message;
    } catch {
      /* body was not JSON */
    }
    const retryAfter = res.headers.get("retry-after");
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");
    if ((res.status === 403 || res.status === 429) && (retryAfter || remaining === "0")) {
      const retryAt = retryAfter ? Date.now() + Number(retryAfter) * 1000 : Number(reset) * 1000;
      throw new GitHubError(res.status, "GitHub rate limit reached", retryAt);
    }
    throw new GitHubError(res.status, message);
  }

  async json<T>(path: string, opts: RequestOpts = {}): Promise<T> {
    return (await (await this.request(path, opts)).json()) as T;
  }

  /** The token's user, plus the scopes it was granted at sign-in. */
  async getUser() {
    const res = await this.request("/user");
    const user = (await res.json()) as { login: string; avatar_url: string; name: string | null };
    const scopes = (res.headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return { ...user, scopes };
  }

  getRepo(owner = this.cfg.owner, repo = this.cfg.repo) {
    return this.json<RepoSummary>(`/repos/${owner}/${repo}`);
  }

  /** Every repository the token can see, most recently pushed first. */
  async listRepos(maxPages = 10): Promise<RepoSummary[]> {
    const out: RepoSummary[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.json<RepoSummary[]>(
        `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
      );
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  /**
   * Create a private repository for a folder (needs the "repo" scope granted at sign-in).
   * `auto_init` gives it a first commit, which the Git Data API needs.
   */
  createRepo(name: string, folderName: string) {
    return this.json<RepoSummary>("/user/repos", {
      method: "POST",
      body: {
        name,
        private: true,
        description: FOLDER_DESCRIPTION_PREFIX + folderName,
        auto_init: true,
        has_issues: false,
        has_projects: false,
        has_wiki: false,
      },
    });
  }

  /** Keep the repo description in step with the folder name. */
  async setDescription(folderName: string) {
    await this.request(this.repoPath, {
      method: "PATCH",
      body: { description: FOLDER_DESCRIPTION_PREFIX + folderName },
    });
  }

  /** Head commit of the branch. Returns null when unchanged since `etag`, or when the repo is empty. */
  async getHead(etag?: string): Promise<{ sha: string; etag?: string } | null | "empty"> {
    try {
      const res = await this.request(`${this.repoPath}/git/ref/heads/${this.cfg.branch}`, { etag });
      if (res.status === 304) return null;
      const body = (await res.json()) as { object: { sha: string } };
      return { sha: body.object.sha, etag: res.headers.get("etag") ?? undefined };
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 409 || e.status === 404)) return "empty";
      throw e;
    }
  }

  async getTree(commitSha: string): Promise<{ path: string; sha: string; size?: number }[]> {
    const body = await this.json<{ tree: { path: string; sha: string; type: string; size?: number }[] }>(
      `${this.repoPath}/git/trees/${commitSha}?recursive=1`,
    );
    return body.tree.filter((t) => t.type === "blob");
  }

  async getBlobText(sha: string): Promise<string> {
    const body = await this.json<{ content: string }>(`${this.repoPath}/git/blobs/${sha}`);
    return base64ToUtf8(body.content);
  }

  async getBlobBytes(sha: string): Promise<ArrayBuffer> {
    const res = await this.request(`${this.repoPath}/git/blobs/${sha}`, { accept: "application/vnd.github.raw" });
    return res.arrayBuffer();
  }

  /** Current text and blob sha of a file, or null if it does not exist. */
  async getFile(path: string, ref: RepoRef = this.cfg): Promise<{ sha: string; text: string } | null> {
    try {
      const body = await this.json<{ sha: string; content?: string; size: number }>(
        `/repos/${ref.owner}/${ref.repo}/contents/${encodePath(path)}?ref=${ref.branch}`,
      );
      // The contents API omits content above 1 MB; fall back to the blob API.
      const text = body.content ? base64ToUtf8(body.content) : await this.getBlobText(body.sha);
      return { sha: body.sha, text };
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * Create or update a small text file in one commit. `sha` is the version we last saw;
   * GitHub rejects the write (409) if someone else changed the file since, so we never overwrite blindly.
   */
  async putFile(path: string, text: string, sha: string | undefined, message: string, keepalive = false) {
    const body = await this.json<{ content: { sha: string }; commit: { sha: string } }>(
      `${this.repoPath}/contents/${encodePath(path)}`,
      {
        method: "PUT",
        keepalive,
        body: { message, content: utf8ToBase64(text), sha, branch: this.cfg.branch },
      },
    );
    return body.content.sha;
  }

  /** Delete a file in one commit. Already gone counts as done. */
  async deleteFile(path: string, sha: string, message: string): Promise<void> {
    try {
      await this.request(`${this.repoPath}/contents/${encodePath(path)}`, { method: "DELETE", body: { message, sha, branch: this.cfg.branch } });
    } catch (e) {
      if (!(e instanceof GitHubError && e.status === 404)) throw e;
    }
  }

  /**
   * Upload a binary (PDF) through the Git Data API, which handles files up to 100 MB.
   * Returns the blob sha.
   */
  async putBinary(path: string, data: Blob, message: string): Promise<string> {
    const blob = await this.json<{ sha: string }>(`${this.repoPath}/git/blobs`, {
      method: "POST",
      body: { content: await blobToBase64(data), encoding: "base64" },
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      const head = await this.getHead();
      if (head === null || head === "empty") throw new GitHubError(409, "Repository has no commits yet");
      const commit = await this.json<{ tree: { sha: string } }>(`${this.repoPath}/git/commits/${head.sha}`);
      const tree = await this.json<{ sha: string }>(`${this.repoPath}/git/trees`, {
        method: "POST",
        body: { base_tree: commit.tree.sha, tree: [{ path, mode: "100644", type: "blob", sha: blob.sha }] },
      });
      const newCommit = await this.json<{ sha: string }>(`${this.repoPath}/git/commits`, {
        method: "POST",
        body: { message, tree: tree.sha, parents: [head.sha] },
      });
      try {
        await this.request(`${this.repoPath}/git/refs/heads/${this.cfg.branch}`, {
          method: "PATCH",
          body: { sha: newCommit.sha, force: false },
        });
        return blob.sha;
      } catch (e) {
        // Another device pushed in between: rebuild on top of the new head and retry.
        if (e instanceof GitHubError && e.status === 422) continue;
        throw e;
      }
    }
    throw new GitHubError(409, "Could not upload after several retries");
  }

  /**
   * Write and delete many text files in one commit (text `null` deletes). Costs three writes
   * however many files change, so a whole folder can move to a new layout at once.
   * Returns false if the base commit moved on; the caller pulls and tries again.
   */
  async commitFiles(files: { path: string; text: string | null }[], message: string, base: string): Promise<boolean> {
    const commit = await this.json<{ tree: { sha: string } }>(`${this.repoPath}/git/commits/${base}`);
    const tree = await this.json<{ sha: string }>(`${this.repoPath}/git/trees`, {
      method: "POST",
      body: {
        base_tree: commit.tree.sha,
        tree: files.map((f) =>
          f.text === null
            ? { path: f.path, mode: "100644", type: "blob", sha: null }
            : { path: f.path, mode: "100644", type: "blob", content: f.text },
        ),
      },
    });
    const newCommit = await this.json<{ sha: string }>(`${this.repoPath}/git/commits`, {
      method: "POST",
      body: { message, tree: tree.sha, parents: [base] },
    });
    try {
      await this.request(`${this.repoPath}/git/refs/heads/${this.cfg.branch}`, {
        method: "PATCH",
        body: { sha: newCommit.sha, force: false },
      });
      return true;
    } catch (e) {
      if (e instanceof GitHubError && e.status === 422) return false;
      throw e;
    }
  }
}

function encodePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}
