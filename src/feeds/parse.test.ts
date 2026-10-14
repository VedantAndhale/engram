import { test } from "node:test";
import assert from "node:assert/strict";
import { FeedParseError, parseFeed } from "./action/fetch-feeds.mjs";

const FEED_URL = "https://example.com/blog/feed.xml";

// Wraps items in a minimal RSS 2.0 envelope so each test only spells out what it checks.
function rss(items: string, channelTitle = "Test Feed"): string {
  return `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
<title>${channelTitle}</title>
<link>https://example.com/</link>
${items}
</channel>
</rss>`;
}

test("parses an RSS 2.0 feed", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example Blog</title>
    <link>https://example.com/</link>
    <item>
      <title>First post</title>
      <link>https://example.com/posts/1</link>
      <guid isPermaLink="false">post-1</guid>
      <description>Hello there</description>
      <pubDate>Tue, 06 Oct 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Second post</title>
      <link>https://example.com/posts/2</link>
      <guid>post-2</guid>
      <description>Another one</description>
      <dc:date>2026-10-05T09:30:00Z</dc:date>
    </item>
  </channel>
</rss>`;
  const feed = parseFeed(xml, FEED_URL);
  assert.equal(feed.title, "Example Blog");
  assert.deepEqual(feed.entries, [
    {
      guid: "post-1",
      title: "First post",
      link: "https://example.com/posts/1",
      summary: "Hello there",
      published: "2026-10-06T10:00:00.000Z",
    },
    {
      guid: "post-2",
      title: "Second post",
      link: "https://example.com/posts/2",
      summary: "Another one",
      published: "2026-10-05T09:30:00.000Z",
    },
  ]);
});

test("parses an RSS 1.0 (RDF) feed where items sit beside the channel", () => {
  const xml = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://example.org/">
    <title>RDF Feed</title>
    <link>https://example.org/</link>
  </channel>
  <item rdf:about="https://example.org/a">
    <title>Item A</title>
    <description>About A</description>
    <dc:date>2026-10-01T00:00:00Z</dc:date>
  </item>
  <item rdf:about="https://example.org/b">
    <title>Item B</title>
    <link>https://example.org/b-link</link>
  </item>
</rdf:RDF>`;
  const feed = parseFeed(xml, "https://example.org/rss.rdf");
  assert.equal(feed.title, "RDF Feed");
  assert.deepEqual(feed.entries, [
    {
      // No link element, so the link comes from rdf:about, and the guid from the link.
      guid: "https://example.org/a",
      title: "Item A",
      link: "https://example.org/a",
      summary: "About A",
      published: "2026-10-01T00:00:00.000Z",
    },
    {
      guid: "https://example.org/b-link",
      title: "Item B",
      link: "https://example.org/b-link",
      summary: "",
      published: null,
    },
  ]);
});

test("parses an Atom feed, preferring published over updated and summary over content", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Blog</title>
  <id>urn:feed:1</id>
  <link rel="self" href="https://example.net/feed.atom"/>
  <entry>
    <title>Atom one</title>
    <id>tag:example.net,2026:1</id>
    <link rel="alternate" href="https://example.net/1"/>
    <published>2026-10-02T08:00:00Z</published>
    <updated>2026-10-03T08:00:00Z</updated>
    <summary>Short summary</summary>
    <content type="html">Long content that should lose to the summary</content>
  </entry>
  <entry>
    <title>Atom two</title>
    <id>tag:example.net,2026:2</id>
    <link href="https://example.net/2"/>
    <updated>2026-10-04T08:00:00Z</updated>
    <content type="html">&lt;p&gt;Body &lt;i&gt;text&lt;/i&gt;&lt;/p&gt;</content>
  </entry>
</feed>`;
  const feed = parseFeed(xml, "https://example.net/feed.atom");
  assert.equal(feed.title, "Atom Blog");
  assert.deepEqual(feed.entries, [
    {
      guid: "tag:example.net,2026:1",
      title: "Atom one",
      link: "https://example.net/1",
      summary: "Short summary",
      published: "2026-10-02T08:00:00.000Z",
    },
    {
      guid: "tag:example.net,2026:2",
      title: "Atom two",
      link: "https://example.net/2",
      summary: "Body text",
      published: "2026-10-04T08:00:00.000Z",
    },
  ]);
});

test("Atom links with rel self or enclosure are ignored", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Links</title>
  <entry>
    <title>Self listed first</title>
    <id>urn:e:1</id>
    <link rel="self" href="https://example.net/api/1"/>
    <link rel="enclosure" href="https://example.net/a.mp3"/>
    <link rel="alternate" href="https://example.net/real/1"/>
    <updated>2026-10-04T08:00:00Z</updated>
  </entry>
  <entry>
    <title>Only self</title>
    <id>urn:e:2</id>
    <link rel="self" href="https://example.net/api/2"/>
    <updated>2026-10-04T08:00:00Z</updated>
  </entry>
</feed>`;
  const { entries } = parseFeed(xml, "https://example.net/feed.atom");
  // The second entry has no usable link at all, so it is dropped.
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.link, "https://example.net/real/1");
  assert.equal(entries[0]?.guid, "urn:e:1");
});

test("reads CDATA sections and content:encoded", () => {
  const xml = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
<title><![CDATA[CDATA Channel]]></title>
<item>
<title><![CDATA[Tom's <em>big</em> idea]]></title>
<link>https://example.com/cdata</link>
<guid>cdata-1</guid>
<content:encoded><![CDATA[<p>Hello <b>world</b></p>]]></content:encoded>
<pubDate>Mon, 05 Oct 2026 08:00:00 GMT</pubDate>
</item>
</channel>
</rss>`;
  const feed = parseFeed(xml, FEED_URL);
  assert.equal(feed.title, "CDATA Channel");
  assert.deepEqual(feed.entries, [
    {
      guid: "cdata-1",
      title: "Tom's big idea",
      link: "https://example.com/cdata",
      summary: "Hello world",
      published: "2026-10-05T08:00:00.000Z",
    },
  ]);
});

test("decodes named and numeric entities and collapses whitespace", () => {
  const xml = rss(`
<item>
  <title>Fish &amp; Chips &#38; Peas &#x26; &quot;Co&quot;</title>
  <link>https://example.com/entities</link>
  <description>Caf&#233; &amp; bar</description>
</item>
<item>
  <title>  Spaced
      out	title  </title>
  <link>https://example.com/spaced</link>
</item>`);
  const { entries } = parseFeed(xml, FEED_URL);
  assert.equal(entries[0]?.title, 'Fish & Chips & Peas & "Co"');
  assert.equal(entries[0]?.summary, "Café & bar");
  assert.equal(entries[1]?.title, "Spaced out title");
});

test("entity-encoded HTML is decoded, stripped, then its HTML entities decoded", () => {
  const xml = rss(`
<item>
  <title>Encoded</title>
  <link>https://example.com/encoded</link>
  <description>&lt;p&gt;Hello &lt;b&gt;bold&lt;/b&gt; &amp;amp; &amp;mdash; ok&lt;/p&gt;</description>
</item>`);
  const { entries } = parseFeed(xml, FEED_URL);
  assert.equal(entries[0]?.summary, "Hello bold & \u2014 ok");
});

test("resolves relative links against the feed URL", () => {
  const xml = rss(`
<item><title>Rooted</title><link>/posts/1</link><pubDate>Tue, 06 Oct 2026 10:00:00 GMT</pubDate></item>
<item><title>Sibling</title><link>post-2.html</link><pubDate>Tue, 06 Oct 2026 10:00:00 GMT</pubDate></item>`);
  const { entries } = parseFeed(xml, FEED_URL);
  assert.deepEqual(
    entries.map((e) => e.link),
    ["https://example.com/posts/1", "https://example.com/blog/post-2.html"],
  );
  // With no guid in the feed, the resolved link doubles as the guid.
  assert.deepEqual(
    entries.map((e) => e.guid),
    ["https://example.com/posts/1", "https://example.com/blog/post-2.html"],
  );
});

test("skips entries whose link is not http or https", () => {
  const xml = rss(`
<item><title>Script</title><link>javascript:alert(1)</link></item>
<item><title>Mail</title><link>mailto:someone@example.com</link></item>
<item><title>Data</title><link>data:text/html,hi</link></item>
<item><title>Good</title><link>https://example.com/good</link></item>`);
  const { entries } = parseFeed(xml, FEED_URL);
  assert.deepEqual(
    entries.map((e) => e.title),
    ["Good"],
  );
});

test("a missing guid falls back to the link, and an entry with no link is skipped", () => {
  const xml = rss(`
<item>
  <title>Has guid</title>
  <link>https://example.com/with-guid</link>
  <guid>explicit-guid</guid>
</item>
<item>
  <title>No guid</title>
  <link>https://example.com/no-guid</link>
</item>
<item>
  <title>No link and no guid</title>
  <pubDate>Tue, 06 Oct 2026 10:00:00 GMT</pubDate>
</item>`);
  const { entries } = parseFeed(xml, FEED_URL);
  assert.deepEqual(
    entries.map((e) => e.guid),
    ["explicit-guid", "https://example.com/no-guid"],
  );
});

test("skips entries with neither a title nor a date, and bad dates become null", () => {
  const xml = rss(`
<item><link>https://example.com/bare</link></item>
<item><title>Title only</title><link>https://example.com/title-only</link></item>
<item><link>https://example.com/date-only</link><pubDate>Tue, 06 Oct 2026 10:00:00 GMT</pubDate></item>
<item><title>Bad date</title><link>https://example.com/bad-date</link><pubDate>not a date</pubDate></item>`);
  const { entries } = parseFeed(xml, FEED_URL);
  assert.deepEqual(
    entries.map((e) => e.link),
    [
      "https://example.com/title-only",
      "https://example.com/date-only",
      "https://example.com/bad-date",
    ],
  );
  assert.equal(entries[0]?.published, null);
  assert.equal(entries[1]?.title, "");
  assert.equal(entries[1]?.published, "2026-10-06T10:00:00.000Z");
  assert.equal(entries[2]?.published, null);
});

test("caps the entry title at 300, the summary at 1000 and the feed title at 120", () => {
  const xml = rss(
    `<item>
  <title>${"t".repeat(500)}</title>
  <link>https://example.com/long</link>
  <description>${"s".repeat(5000)}</description>
</item>`,
    "c".repeat(200),
  );
  const feed = parseFeed(xml, FEED_URL);
  assert.equal(feed.title.length, 120);
  assert.equal(feed.entries[0]?.title.length, 300);
  assert.equal(feed.entries[0]?.summary.length, 1000);
});

test("tolerates comments, processing instructions, self-closing tags and single quotes", () => {
  const xml = `<?xml version='1.0'?>
<?xml-stylesheet type="text/xsl" href="feed.xsl"?>
<!-- generated by a tool -->
<feed xmlns='http://www.w3.org/2005/Atom'>
  <title>Quoted</title>
  <!-- <entry><title>commented out</title></entry> -->
  <entry>
    <title>Single quotes</title>
    <id>q-1</id>
    <link rel='alternate' href='https://example.net/q/1' />
    <updated>2026-10-04T08:00:00Z</updated>
    <summary/>
  </entry>
</feed>`;
  const feed = parseFeed(xml, "https://example.net/feed.atom");
  assert.equal(feed.title, "Quoted");
  assert.deepEqual(feed.entries, [
    {
      guid: "q-1",
      title: "Single quotes",
      link: "https://example.net/q/1",
      summary: "",
      published: "2026-10-04T08:00:00.000Z",
    },
  ]);
});

test("throws FeedParseError on empty input", () => {
  assert.throws(() => parseFeed("", FEED_URL), FeedParseError);
  assert.throws(() => parseFeed("   \n\t ", FEED_URL), FeedParseError);
});

test("throws FeedParseError on a truncated CDATA section", () => {
  const xml = `<rss version="2.0"><channel><title>x</title><item><title><![CDATA[never closed`;
  assert.throws(() => parseFeed(xml, FEED_URL), FeedParseError);
});

test("throws FeedParseError on an unterminated tag or comment at end of file", () => {
  assert.throws(
    () => parseFeed(`<rss version="2.0"><channel><title>Hi</title><item`, FEED_URL),
    FeedParseError,
  );
  assert.throws(
    () => parseFeed(`<rss version="2.0"><!-- never ends`, FEED_URL),
    FeedParseError,
  );
});

test("throws FeedParseError on an HTML page", () => {
  const html = `<!DOCTYPE html><html><head><title>Not a feed</title></head><body><p>Hi</p></body></html>`;
  assert.throws(() => parseFeed(html, FEED_URL), FeedParseError);
});

test("throws FeedParseError on a DOCTYPE with an ENTITY declaration", () => {
  const xml = `<?xml version="1.0"?>
<!DOCTYPE rss [<!ENTITY xxe "boom">]>
<rss version="2.0"><channel><title>&xxe;</title></channel></rss>`;
  assert.throws(() => parseFeed(xml, FEED_URL), FeedParseError);
});