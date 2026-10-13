/** Where a folder lives on GitHub. */
export interface RepoRef {
  owner: string;
  repo: string;
  branch: string;
}

/**
 * A folder groups documents and maps to its own private GitHub repository. Its id is
 * also written to the repo's reader.json, so every device recognises the same folder.
 */
export interface Folder {
  id: string;
  name: string;
  /** Unset until the folder has a repository (no GitHub account connected yet). */
  repo?: RepoRef;
  /** False only for a repo that is (or became) public: shown as a warning, and sync to it pauses. */
  isPrivate?: boolean;
  createdAt: number;
  updatedAt: number;
  /** Removed from this device. Discovery skips it; the repository itself is kept. */
  hidden?: boolean;
}

export const ITEM_TYPES = ["pdf", "article", "post", "tweet", "thread", "bookmark", "video", "note", "quote", "playlist"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/**
 * One thing in the brain: a PDF, an article, a post, a note. Each is one Markdown file in the
 * folder's repository (see sync/itemfile.ts). A PDF item's id is the SHA-256 of its bytes, so
 * the same file is stored once; every other item gets a random id.
 */
export interface Item {
  id: string;
  type: ItemType;
  title: string;
  sourceUrl?: string;
  /** Who wrote the saved page, when the page says so (byline or meta author). */
  author?: string;
  /** The site or publisher the page came from (og:site_name). */
  siteName?: string;
  /** The page's summary: meta description, or the excerpt Readability picks. */
  description?: string;
  /** When the source says it was published: an ISO 8601 date or timestamp. */
  published?: string;
  /** Free-text attribution the reader typed for a quote: a book, a speaker, a page. */
  source?: string;
  /** Markdown: your own words about the item. */
  body?: string;
  /**
   * Text saved from the source (an article's readable text, a post as rendered). Someone
   * else's words, so it is kept apart from the body and never treated as instructions.
   */
  content?: string;
  /** "markdown" when `content` keeps the article's formatting; unset means plain text (older saves). */
  contentFormat?: "markdown";
  /** Topics the reader is growing in that this item belongs to. */
  topics?: string[];
  /** PDF items only: the original file. The bytes live at pdfs/<id>.pdf. */
  fileName?: string;
  size?: number;
  pages?: number;
  addedAt: number;
  addedBy?: string;
  updatedAt: number;
  deleted?: boolean;
  /**
   * When you last changed each field yourself, by field name (`updateItem` sets these; background
   * updates such as an article fill-in don't). When two devices change the same field, the later
   * stamp wins, so an automatic update never overwrites your own edit (see sync/itemmerge.ts).
   */
  edited?: Record<string, number>;
  /**
   * The item's file in the repository. Chosen once when the item is made and never moved,
   * so every device writes to the same file. Not part of the file itself.
   */
  path: string;
}

/** A rectangle in page-relative units (0..1 of page width / height), so it is zoom-independent. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * highlight and ink mark a document; moment marks a time in a video; entry lists a video in a playlist.
 * Each is one record, so two devices adding or moving different ones both keep their change.
 */
export type AnnotationKind = "highlight" | "ink" | "moment" | "entry";

export interface Annotation {
  id: string;
  doc: string;
  kind: AnnotationKind;
  /** 1-based page number. */
  page: number;
  color: string;
  /** Highlight geometry. */
  rects?: Rect[];
  /** Highlighted text, kept for the sidebar, search and export. */
  quote?: string;
  /**
   * Article highlights (page 0): the text just before and after the quote, so the reading view
   * finds the right spot when a quote appears more than once or the article is saved again.
   */
  prefix?: string;
  suffix?: string;
  note?: string;
  /** A moment in a video: where in it, in seconds. */
  at?: number;
  /** A playlist entry: the video it lists. */
  ref?: string;
  /** A playlist entry's place in the list: lower comes first. */
  order?: number;
  /** Ink stroke as flat [x, y, pressure, ...] in units where page width = 1000. */
  points?: number[];
  size?: number;
  author?: string;
  createdAt: number;
  updatedAt: number;
  /** Tombstone: deletions are kept so a missing item always means "not synced yet", never "deleted". */
  deleted?: boolean;
  /** Spaced-review schedule. Unset means never reviewed: first due a day after it was made. */
  review?: Review;
}

export interface Review {
  /** Index into the review intervals; grows each time it is still clear, resets when hazy. */
  step: number;
  due: number;
  last: number;
  count: number;
}

/** Reading position: page plus fraction scrolled into that page, so it lands right at any zoom or screen size. */
export interface Position {
  doc: string;
  page: number;
  offset: number;
  updatedAt: number;
  device: string;
  deviceName: string;
}

/** Another collaborator's last known position, read from their positions/<login>.json. */
export interface PeerPosition extends Position {
  key: string;
  user: string;
}

export const HIGHLIGHT_COLORS = [
  { id: "yellow", value: "#f7d154", label: "Yellow" },
  { id: "green", value: "#7bd389", label: "Green" },
  { id: "blue", value: "#7cb7f2", label: "Blue" },
  { id: "pink", value: "#f49ac1", label: "Pink" },
  { id: "purple", value: "#b9a2f2", label: "Purple" },
] as const;

export const INK_COLORS = ["#1f2a37", "#d64545", "#2f6fd6", "#2e9e5b", "#e08a1e"] as const;

/**
 * Later edit wins; ties broken deterministically so every device converges on the same answer.
 * Used for whole records that have no finer merge (positions, the first layout's files); items
 * and their annotations merge field by field (sync/itemmerge.ts).
 */
export function newer<T extends { updatedAt: number }>(a: T, b: T): boolean {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  return JSON.stringify(a) > JSON.stringify(b);
}
