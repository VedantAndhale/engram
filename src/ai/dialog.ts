/*
 * Which AI dialog is open, and on what text. The dialog reads the text it was given, so it never
 * needs to look items up itself.
 */
import { create } from "zustand";

/** The one-click actions on a selection. Define is offered only for short selections. */
export type QuickAction = "explain" | "define" | "simplify" | "counterpoint";
export const QUICK_ACTIONS: QuickAction[] = ["explain", "define", "simplify", "counterpoint"];
export const QUICK_LABEL: Record<QuickAction, string> = { explain: "Explain", define: "Define", simplify: "Simplify", counterpoint: "Counterpoint" };

export type AiTask =
  | { mode: "settings" }
  | { mode: "summarize"; title: string; text: string }
  /** `key` names the item's follow-up thread. `source` is set for a PDF, so its page citations can open the reader. */
  | {
      mode: "ask";
      title: string;
      text: string;
      key: string;
      /** Set for a PDF: its page citations open the reader at that page. */
      source?: { folder: string; doc: string };
      /** Set for a saved article: its paragraph citations open the paragraph. `markdown` is its save format. */
      article?: { markdown: boolean };
    }
  /** `context` is the sentence the selection sits in, when the item's text can be found. Empty when it cannot. */
  | { mode: "explain"; title: string; text: string; context?: string };

export type AskTask = Extract<AiTask, { mode: "ask" }>;

export const useAiDialog = create<{ task: AiTask | null }>(() => ({ task: null }));

export const openAi = (task: AiTask) => useAiDialog.setState({ task });
export const closeAi = () => useAiDialog.setState({ task: null });
