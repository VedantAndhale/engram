import { cleanText, cleanTopics, MAX_TITLE, typeForUrl, cleanUrl, titleFromUrl } from "../capture/capture";
import { folderCtx } from "../folders/registry";
import { fillFromWeb } from "../capture/fetchpage";
import { createItem } from "../store/actions";
import type { LinkRow } from "./links";

export interface LinkImportResult {
  links: number;
  created: number;
  alreadyThere: number;
  failed: number;
}

// Runs go one after another. Closing the dialog does not stop a run, so a second import started meanwhile waits
// for the first and then sees what it saved; otherwise both would create the same links.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Save each link as a link item in `folder`. Each page is then fetched in the background, one at a time, so its
 * text, author and picture come in after the import has finished. A link already
 * in the folder is left as it is, trashed items included, so a file imported twice adds nothing, and a
 * link you trashed does not come back.
 */
export function importLinks(folder: string, links: LinkRow[], onProgress?: (done: number, total: number) => void): Promise<LinkImportResult> {
  const run = queue.then(() => saveAll(folder, links, onProgress));
  queue = run.catch(() => undefined);
  return run;
}

async function saveAll(folder: string, links: LinkRow[], onProgress?: (done: number, total: number) => void): Promise<LinkImportResult> {
  const result: LinkImportResult = { links: links.length, created: 0, alreadyThere: 0, failed: 0 };
  const { db } = folderCtx(folder);
  // One read of the folder, not one search per link: the sourceUrl field is not indexed.
  const created: string[] = [];
  const known = new Set((await db.items.toArray()).filter((i) => i.type !== "quote" && i.sourceUrl).map((i) => i.sourceUrl!));

  let done = 0;
  // One link at a time: a bad row is counted and skipped, never allowed to stop the rest.
  for (const link of links) {
    try {
      const url = cleanUrl(link.url);
      if (known.has(url)) {
        result.alreadyThere++;
      } else {
        const topics = cleanTopics(link.topics);
        const item = await createItem(folder, {
          type: typeForUrl(url, 0),
          title: cleanText(link.title, MAX_TITLE)?.replace(/\n/g, " ") || titleFromUrl(url),
          sourceUrl: url,
          author: cleanText(link.author, MAX_TITLE),
          siteName: cleanText(link.publication, MAX_TITLE),
          description: cleanText(link.description, 1000),
          topics: topics.length ? topics : undefined,
          // Imported links are for later, so they skip the Inbox that the weekly rule clears.
          location: "later",
        });
        created.push(item.id);
        known.add(url);
        result.created++;
      }
    } catch {
      result.failed++;
    }
    onProgress?.(++done, links.length);
  }
  // Each page is read from its own site, so this runs after the import is done and one page at a time.
  void (async () => {
    for (const id of created) await fillFromWeb(folder, id);
  })();
  return result;
}
