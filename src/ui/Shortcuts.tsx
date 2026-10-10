import { closeShortcuts, useUI } from "../store/ui";
import { Modal } from "./common";

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = MAC ? "⌘" : "Ctrl";
const ALT = MAC ? "⌥" : "Alt";

const GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: "Anywhere",
    keys: [
      [`${MOD} K`, "Go to anything"],
      ["/", "Search everything"],
      ["N", "Save something new"],
      ["J  K", "Next and previous item in a list"],
      ["?", "These shortcuts"],
    ],
  },
  {
    title: "Writing",
    keys: [
      ["/", "Headings, lists, to-dos, math and more"],
      ["[[", "Link to something you saved"],
      [`${MOD} B  ${MOD} I  ${MOD} E`, "Bold, italic, code"],
      [`${MOD} /`, "Options for this block"],
      [`${MOD} Shift ↑  ↓`, "Move this block"],
      [`${ALT} ↑  ↓`, "Move this line"],
      [`${MOD} Shift [  ]`, "Fold and unfold here"],
      [`${MOD} ${ALT} [  ]`, "Fold and unfold everything"],
    ],
  },
  {
    title: "Reading a PDF",
    keys: [
      [`/  ${MOD} F`, "Find in the document"],
      ["H", "Highlight"],
      ["D", "Draw"],
      ["E", "Erase"],
      ["V", "Select"],
      ["N", "Notes panel"],
      [`${MOD} +  −  0`, "Zoom in, out, reset"],
    ],
  },
];

/** Every keyboard shortcut, on "?". */
export function Shortcuts() {
  const open = useUI((s) => s.shortcuts);
  if (!open) return null;
  return (
    <Modal title="Keyboard shortcuts" onClose={closeShortcuts} wide>
      <div className="shortcuts">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3>{g.title}</h3>
            <dl>
              {g.keys.map(([k, what]) => (
                <div key={what}>
                  <dt>
                    {k.split("  ").map((part) => (
                      <kbd key={part}>{part}</kbd>
                    ))}
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
