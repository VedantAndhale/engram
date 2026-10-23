import { create } from "zustand";

/*
 * Per-device habit settings. They describe how this person likes to be nudged, so they stay
 * on the device; the things they make (highlights, notes, document topics) sync with the folder.
 */

interface HabitPrefs {
  /** Topics chosen during onboarding or later; documents are tagged from this list. */
  topics: string[];
  /** Daily reminder time as "HH:MM", once a calendar event has been made. */
  reminder: string | null;
  /** The first-run flow has been finished or skipped. */
  welcomed: boolean;
  /** The reader tip about writing in your own words has done its job. */
  coachDone: boolean;
  /** "Not now" on the suggestion to back up to GitHub. */
  backupDismissed?: boolean;
  /** When Engram was first opened on this device. */
  firstUse: number;
  /** When the inbox rule began on this device. Links added before then are left where they are. */
  agingSince?: number;
  /** The folder articles and feed entries go to, by id. Unset means the folder named "My library". */
  libraryId?: string;
  /** Sites the reader has decided about for feeds: followed, declined, or checked with no feed. */
  feedAsked?: string[];
}

const KEY = "engram.habit";

function load(): HabitPrefs {
  const fallback: HabitPrefs = { topics: [], reminder: null, welcomed: false, coachDone: false, firstUse: Date.now() };
  try {
    return { ...fallback, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<HabitPrefs>) };
  } catch {
    return fallback;
  }
}

export const useHabit = create<HabitPrefs>(load);

/** The settings as they are saved on this device right now, whichever tab wrote them last. */
function storedHabit(): Partial<HabitPrefs> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<HabitPrefs>;
  } catch {
    return {};
  }
}

/**
 * Save what this tab knows. A key this tab has not set (undefined) keeps the value another tab saved, so a
 * library choice made in one tab survives a change made in a tab that was opened before it.
 */
function save(s: HabitPrefs) {
  const stored = storedHabit();
  const merged: Record<string, unknown> = { ...stored };
  for (const [k, v] of Object.entries(s)) if (v !== undefined) merged[k] = v;
  // Sites decided about in another tab stay decided, so the two lists are joined rather than one replacing the other.
  if (stored.feedAsked && s.feedAsked) merged.feedAsked = [...new Set([...stored.feedAsked, ...s.feedAsked])];
  localStorage.setItem(KEY, JSON.stringify(merged));
}

/** Replaces the list of sites decided about for feeds, here and in the saved settings. */
export function setFeedAsked(sites: string[]) {
  localStorage.setItem(KEY, JSON.stringify({ ...storedHabit(), feedAsked: sites }));
  useHabit.setState({ feedAsked: sites });
}

// Save on every change, including the first load, so firstUse is fixed from the very first visit.
save(useHabit.getState());
useHabit.subscribe(save);

export function setHabit(patch: Partial<HabitPrefs>) {
  useHabit.setState(patch);
}

/** When the inbox rule began on this device. It starts now the first time the rule runs. */
export function agingStart(): number {
  const known = useHabit.getState().agingSince ?? storedHabit().agingSince;
  if (known !== undefined) return known;
  const now = Date.now();
  setHabit({ agingSince: now });
  return now;
}

/** Tidy a typed topic: trimmed, single spaces, first letter capitalised. */
export function cleanTopic(raw: string): string {
  const t = raw.trim().replace(/\s+/g, " ").slice(0, 40);
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

export const SUGGESTED_TOPICS = [
  "Psychology",
  "Philosophy",
  "History",
  "Economics",
  "Science",
  "Health",
  "Programming",
  "Design",
  "Writing",
  "Business",
  "Mathematics",
  "Art",
];
