// Types for fetch-feeds.mjs, which is plain JavaScript so the Action can run it with no build.

export interface FeedEntry {
  guid: string;
  title: string;
  link: string;
  summary: string;
  published: string | null;
}

export interface ParsedFeed {
  title: string;
  entries: FeedEntry[];
}

export interface FeedConfig {
  id: string;
  url: string;
  title: string;
  addedAt: number;
}

export interface FeedState {
  url: string;
  title: string;
  etag: string | null;
  lastModified: string | null;
  retryAfter: string | null;
  lastError: { message: string; since: string } | null;
  seen: string[];
}

export interface FeedsState {
  version: 1;
  updatedAt: string;
  feeds: Record<string, FeedState>;
}

// What one fetch produced. "error" carries retryAfter only for 429 and 503.
export type FetchResult =
  | {
      kind: "ok";
      title: string;
      entries: FeedEntry[];
      etag: string | null;
      lastModified: string | null;
    }
  | { kind: "notModified" }
  | { kind: "error"; message: string; retryAfter?: string | null };

export interface FeedRunError {
  feedId: string;
  message: string;
}

export class FeedParseError extends Error {}

export function parseFeed(xmlText: string, feedUrl: string): ParsedFeed;

export function entryKey(feedId: string, guid: string): string;

export function inboxFileText(
  entry: FeedEntry,
  feed: { id: string; title: string },
  createdAt: string,
): string;

export function validateFeeds(json: unknown): { feeds: FeedConfig[]; errors: string[] };

export function planRun(args: {
  feeds: FeedConfig[];
  state: FeedsState | null;
  fetched: Record<string, FetchResult> | Map<string, FetchResult>;
  now: number;
}): {
  writes: { path: string; text: string }[];
  state: FeedsState;
  errors: FeedRunError[];
};

export function serializeState(state: FeedsState): string;

export function main(options?: {
  root?: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  log?: (line: string) => void;
}): Promise<{ written: number; errors: number }>;