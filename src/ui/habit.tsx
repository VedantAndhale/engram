import { CalendarPlus, Check, Plus } from "lucide-react";
import { useState } from "react";
import { downloadIcs, googleCalendarUrl } from "../habit/calendar";
import { cleanTopic, setHabit, useHabit } from "../habit/prefs";
import { Modal } from "./common";

/** Toggle topics on and off, or type a new one. */
export function TopicPicker({ options, value, onChange }: { options: string[]; value: string[]; onChange: (topics: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const all = [...new Set([...options, ...value])];
  const toggle = (t: string) => onChange(value.includes(t) ? value.filter((x) => x !== t) : [...value, t]);
  const add = () => {
    const t = cleanTopic(draft);
    if (t && !value.some((x) => x.toLowerCase() === t.toLowerCase())) onChange([...value, t]);
    setDraft("");
  };
  return (
    <div className="topic-picker">
      <div className="chips">
        {all.map((t) => (
          <button key={t} type="button" className={`chip ${value.includes(t) ? "on" : ""}`} aria-pressed={value.includes(t)} onClick={() => toggle(t)}>
            {value.includes(t) && <Check size={13} />} {t}
          </button>
        ))}
      </div>
      <form
        className="topic-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input value={draft} placeholder="Add your own topic" aria-label="New topic" onChange={(e) => setDraft(e.target.value)} />
        <button className="btn" type="submit" disabled={!cleanTopic(draft)}>
          <Plus size={15} /> Add
        </button>
      </form>
    </div>
  );
}

/** Choose a time, then add a daily event to your own calendar. Nothing is scheduled on a server. */
export function ReminderSetup({ onDone }: { onDone?: () => void }) {
  const saved = useHabit((s) => s.reminder);
  const [time, setTime] = useState(saved ?? "08:30");
  const finish = () => {
    setHabit({ reminder: time });
    onDone?.();
  };
  return (
    <div className="reminder-setup">
      <label className="time-field">
        <span>Every day at</span>
        <input type="time" value={time} required onChange={(e) => setTime(e.target.value || "08:30")} />
      </label>
      <div className="reminder-actions">
        <button
          className="btn btn-primary"
          onClick={() => {
            downloadIcs(time);
            finish();
          }}
        >
          <CalendarPlus size={16} /> Add to calendar
        </button>
        <a className="btn" href={googleCalendarUrl(time)} target="_blank" rel="noopener" onClick={finish}>
          Google Calendar
        </a>
      </div>
      <p className="hint">
        "Add to calendar" downloads a repeating event that Apple Calendar, Outlook and most calendar apps open directly. Your calendar
        does the reminding, so it works even when Engram is closed.
      </p>
    </div>
  );
}

export function ReminderDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Daily reminder" onClose={onClose}>
      <div className="form">
        <p>Pick a time you're usually free for five minutes. A small daily cue is what turns this into a habit.</p>
        <ReminderSetup onDone={onClose} />
      </div>
    </Modal>
  );
}

export function TopicsDialog({
  title,
  intro,
  options,
  initial,
  onSave,
  onClose,
}: {
  title: string;
  intro?: string;
  options: string[];
  initial: string[];
  onSave: (topics: string[]) => void | Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Modal title={title} onClose={onClose}>
      <div className="form">
        {intro && <p className="hint">{intro}</p>}
        <TopicPicker options={options} value={value} onChange={setValue} />
        <footer>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={async () => {
              await onSave(value);
              onClose();
            }}
          >
            Save
          </button>
        </footer>
      </div>
    </Modal>
  );
}
