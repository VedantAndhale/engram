/*
 * The owner's sign-up list. When someone signs in to the Engram app, their GitHub login, their
 * primary verified email and their name go to an Airtable table the owner controls, once per
 * sign-in (an upsert on the login, so signing in again updates the row instead of adding one).
 *
 * Off unless AIRTABLE_TOKEN and AIRTABLE_BASE_ID are set. A failure is logged without the email
 * and never stops the sign-in. The GitHub token is used for these two reads and then dropped.
 */

const AIRTABLE = "https://api.airtable.com/v0";
const GITHUB = "https://api.github.com";
const TIMEOUT_MS = 5_000;

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export async function recordSignup(githubToken: string): Promise<void> {
  const key = process.env.AIRTABLE_TOKEN;
  const base = process.env.AIRTABLE_BASE_ID;
  if (!key || !base) return;
  try {
    await withTimeout(save(githubToken, key, base, process.env.AIRTABLE_TABLE || "Signups"));
  } catch {
    // Deliberately no detail: the error could name the email. Sign-in still succeeds.
    console.error("Engram: couldn't record a sign-up.");
  }
}

async function save(githubToken: string, key: string, base: string, table: string) {
  const headers = { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json", "User-Agent": "Engram" };
  const user = await fetch(`${GITHUB}/user`, { headers }).then((r) => (r.ok ? (r.json() as Promise<{ login?: string; name?: string | null }>) : null));
  // Needs the user:email permission. A sign-in from before it was asked for has no emails to read.
  const emails = await fetch(`${GITHUB}/user/emails`, { headers }).then((r) => (r.ok ? (r.json() as Promise<GitHubEmail[]>) : []));
  const email = emails.find((e) => e.primary && e.verified)?.email;
  if (!user?.login || !email) return;

  const res = await fetch(`${AIRTABLE}/${encodeURIComponent(base)}/${encodeURIComponent(table)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      performUpsert: { fieldsToMergeOn: ["login"] },
      typecast: true,
      records: [{ fields: { login: user.login, email, name: user.name ?? "", signed_up: new Date().toISOString().slice(0, 10) } }],
    }),
  });
  if (!res.ok) throw new Error(`Airtable answered ${res.status}`);
}

function withTimeout(p: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), TIMEOUT_MS);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
