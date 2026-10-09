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
  /** When Engram was first opened on this device. */
  firstUse: number;
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

// Save on every change, including the first load, so firstUse is fixed from the very first visit.
localStorage.setItem(KEY, JSON.stringify(useHabit.getState()));
useHabit.subscribe((s) => localStorage.setItem(KEY, JSON.stringify(s)));

export function setHabit(patch: Partial<HabitPrefs>) {
  useHabit.setState(patch);
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
