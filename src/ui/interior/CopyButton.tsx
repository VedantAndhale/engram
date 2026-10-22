/*
 * A copy button that tells you what happened without moving anything. Adapted from interior.dev's Copy
 * Button: the clipboard hook (with its fallback for a browser that has no clipboard API), the springs, and
 * the rules are theirs; the markup is drawn with this app's own classes instead of Tailwind.
 *
 * Its three states (copy, copied, failed) share one cell, so the button never changes size. Success is
 * only shown when the write really happened, a second click restarts the timer rather than stacking one,
 * and a polite live region says the result. With reduced motion, everything is instant.
 */
import { m, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import "../../styles/interior.css";
import { Lazy } from "./Lazy";

const EASE = [0.23, 1, 0.32, 1] as const;
const CELL = { type: "spring", stiffness: 520, damping: 34, mass: 0.45 } as const;
const CROSSFADE = { type: "spring", stiffness: 260, damping: 34, mass: 0.8 } as const;
const DRAW = { duration: 0.26, ease: EASE } as const;
const INSTANT = { duration: 0 } as const;

export type CopyStatus = "idle" | "copied" | "error";

/** Writes through a hidden, read-only text box for a browser that has no clipboard API, then puts the selection back. */
function writeFallback(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);

  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }

  document.body.removeChild(area);
  if (selection && previous) {
    selection.removeAllRanges();
    selection.addRange(previous);
  }
  return ok;
}

export function useCopyToClipboard({
  timeout = 2000,
  onCopy,
  onError,
}: { timeout?: number; onCopy?: (value: string) => void; onError?: (reason: unknown) => void } = {}) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const [ticket, setTicket] = useState(0);

  const mounted = useRef(true);
  const copied = useRef(onCopy);
  copied.current = onCopy;
  const failed = useRef(onError);
  failed.current = onError;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const copy = useCallback(async (text: string) => {
    if (!text) return false;

    let ok = false;
    let reason: unknown = null;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      } else {
        ok = writeFallback(text);
      }
    } catch (error) {
      reason = error;
      try {
        ok = writeFallback(text);
      } catch {
        ok = false;
      }
    }

    if (!mounted.current) return ok;
    setStatus(ok ? "copied" : "error");
    setTicket((t) => t + 1);
    if (ok) copied.current?.(text);
    else failed.current?.(reason);
    return ok;
  }, []);

  // Every result restarts the timer, so a second click never leaves an earlier one to cut it short.
  useEffect(() => {
    if (ticket === 0 || status === "idle") return;
    const id = setTimeout(() => setStatus("idle"), timeout);
    return () => clearTimeout(id);
  }, [ticket, status, timeout]);

  return { copy, status };
}

/**
 * `iconOnly` draws just the icon, as in a row of small buttons, and keeps `label` as its name. Otherwise the
 * label sits beside the icon, and all three labels share one cell so the longest one sets the width.
 */
export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  errorLabel = "Failed",
  timeout = 2000,
  iconOnly = false,
  disabled = false,
  className = "",
}: {
  value: string;
  label?: string;
  copiedLabel?: string;
  errorLabel?: string;
  timeout?: number;
  iconOnly?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const { copy, status } = useCopyToClipboard({ timeout });
  const reduced = useReducedMotion();
  const fade = reduced ? INSTANT : CROSSFADE;
  const draw = reduced ? INSTANT : DRAW;

  const labels: [CopyStatus, string][] = [
    ["idle", label],
    ["copied", copiedLabel],
    ["error", errorLabel],
  ];
  const shown = (on: boolean) => ({ opacity: on ? 1 : 0, scale: on ? 1 : 0.92 });

  return (
    <Lazy>
      <m.button
        type="button"
        disabled={disabled}
        aria-label={label}
        title={iconOnly ? label : undefined}
        onClick={() => void copy(value)}
        whileTap={disabled || reduced ? undefined : { y: 1 }}
        transition={CELL}
        className={`${iconOnly ? "icon-btn" : "btn"} copy-btn is-${status} ${className}`.trim()}
      >
        <span className="copy-cell" aria-hidden="true">
          <m.svg
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={false}
            animate={shown(status === "idle")}
            transition={fade}
          >
            <rect x="4.75" y="4.75" width="7" height="7" rx="1.5" />
            <path d="M9.25 4.75v-.5a1.5 1.5 0 0 0-1.5-1.5h-4a1.5 1.5 0 0 0-1.5 1.5v4a1.5 1.5 0 0 0 1.5 1.5h.5" />
          </m.svg>
          <m.svg
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={false}
            animate={shown(status === "copied")}
            transition={fade}
          >
            <m.path d="M3 7.4 5.8 10.2 11 4.4" initial={false} animate={{ pathLength: status === "copied" ? 1 : 0 }} transition={draw} />
          </m.svg>
          <m.svg
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={false}
            animate={shown(status === "error")}
            transition={fade}
          >
            <path d="M3.6 3.6 10.4 10.4" />
            <path d="M10.4 3.6 3.6 10.4" />
          </m.svg>
        </span>

        {!iconOnly && (
          <span className="copy-labels" aria-hidden="true">
            {labels.map(([key, text]) => (
              <m.span
                key={key}
                initial={false}
                animate={key === status ? { opacity: 1, y: 0, filter: "blur(0px)" } : { opacity: 0, y: 3, filter: "blur(3px)" }}
                transition={fade}
              >
                {text}
              </m.span>
            ))}
          </span>
        )}

        <span role="status" aria-live="polite" className="sr-only">
          {status === "copied" ? copiedLabel : status === "error" ? errorLabel : ""}
        </span>
      </m.button>
    </Lazy>
  );
}
