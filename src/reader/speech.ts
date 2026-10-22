/*
 * Reading an article aloud with the browser's own voices: free, and on the device. The text is spoken a
 * paragraph at a time, each cut into sentence-sized clips, because some browsers stop a long clip partway.
 * The speech engine is passed in, so this runs the same in a test with no sound.
 */

/** The parts of the browser's speech engine this needs. */
export interface Synth {
  speak(utterance: Clip): void;
  cancel(): void;
  pause(): void;
  resume(): void;
}

/** One spoken clip: the words, and what to call when it ends or fails. */
export interface Clip {
  text: string;
  onend: ((...args: never[]) => void) | null;
  onerror: ((...args: never[]) => void) | null;
}

export interface Para {
  n: number;
  text: string;
}

/** A paragraph as clips of at most `max` characters, cut at sentence ends where there are any, else at a space. */
export function speechChunks(text: string, max = 220): string[] {
  const plain = text.replace(/\s+/g, " ").trim();
  if (!plain) return [];
  const sentences = plain.match(/[^.!?…]+[.!?…]+["'”’)]*\s*|[^.!?…]+$/g) ?? [plain];
  const clips: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) clips.push(current.trim());
    current = "";
  };
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > max) push();
    if (sentence.length <= max) {
      current += sentence;
      continue;
    }
    // A sentence longer than a clip: cut it at spaces.
    push();
    let rest = sentence.trim();
    while (rest.length > max) {
      const at = rest.lastIndexOf(" ", max);
      const cut = at > max * 0.4 ? at : max;
      clips.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    current = rest;
  }
  push();
  return clips;
}

export type SpeakerState = "idle" | "speaking" | "paused";

/** Speaks `paras` in order from any one of them. Tell it what is being read, and when it finishes. */
export class Speaker {
  state: SpeakerState = "idle";
  private index = 0;
  /** Each start, skip or stop makes the clips still queued from before out of date. */
  private run = 0;

  constructor(
    private synth: Synth,
    private paras: Para[],
    private make: (text: string) => Clip,
    private on: { onPara: (n: number | null) => void; onChange: (state: SpeakerState) => void },
  ) {}

  private set(state: SpeakerState) {
    this.state = state;
    this.on.onChange(state);
  }

  /** Begin at paragraph `i` of the list (not its number). */
  start(i = 0) {
    this.run++;
    this.synth.cancel();
    this.index = Math.max(0, Math.min(i, this.paras.length - 1));
    if (this.paras.length === 0) return this.stop();
    this.set("speaking");
    this.paragraph(this.run);
  }

  private paragraph(run: number) {
    const para = this.paras[this.index];
    if (!para) return this.stop();
    const clips = speechChunks(para.text);
    // An empty paragraph is passed over.
    if (clips.length === 0) return this.advance(run);
    this.on.onPara(para.n);
    const speak = (k: number) => {
      if (run !== this.run) return;
      if (k >= clips.length) return this.advance(run);
      const clip = this.make(clips[k]);
      clip.onend = () => speak(k + 1);
      // An error from a clip that was cancelled on purpose is not a reason to carry on.
      clip.onerror = () => {
        if (run === this.run) this.stop();
      };
      this.synth.speak(clip);
    };
    speak(0);
  }

  private advance(run: number) {
    if (run !== this.run) return;
    this.index++;
    if (this.index >= this.paras.length) return this.stop();
    this.paragraph(run);
  }

  pause() {
    if (this.state !== "speaking") return;
    this.synth.pause();
    this.set("paused");
  }

  resume() {
    if (this.state !== "paused") return;
    this.synth.resume();
    this.set("speaking");
  }

  /** Skip to the next paragraph. */
  next() {
    if (this.state === "idle") return;
    this.start(this.index + 1 >= this.paras.length ? this.index : this.index + 1);
  }

  stop() {
    this.run++;
    this.synth.cancel();
    this.on.onPara(null);
    if (this.state !== "idle") this.set("idle");
  }
}
