/*
 * A progress bar that is honest about not knowing yet. Adapted from interior.dev's Progress Bar: the springs
 * and the rules are theirs; the markup is drawn with this app's own classes instead of Tailwind.
 *
 * `value` is null while the total is unknown: a block sweeps across instead of a fill, and the reading says
 * `pendingLabel`. Once there is a number the fill springs to it and the reading becomes a percentage. The
 * bar is a real progressbar for assistive technology, and says `completeLabel` once when it fills. With
 * reduced motion the fill jumps and the sweep is not drawn.
 */
import { m, useReducedMotion } from "motion/react";
import { useId } from "react";
import "../../styles/interior.css";
import { Lazy } from "./Lazy";

const FILL = { type: "spring", stiffness: 210, damping: 34, mass: 0.9 } as const;
const CROSSFADE = { type: "spring", stiffness: 260, damping: 34, mass: 0.8 } as const;
const INSTANT = { duration: 0 } as const;

export function ProgressBar({
  value,
  max = 100,
  label = "Progress",
  pendingLabel = "Working",
  completeLabel = "Complete",
  className = "",
}: {
  value: number | null;
  max?: number;
  label?: string;
  pendingLabel?: string;
  completeLabel?: string;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const labelId = useId();

  const indeterminate = value === null;
  const fraction = value === null || max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
  const percent = Math.round(fraction * 100);
  const complete = !indeterminate && fraction >= 1;
  const transition = reduced ? INSTANT : CROSSFADE;

  return (
    <Lazy>
      <div className={`pbar ${className}`.trim()}>
        <div className="pbar-head">
          <span id={labelId} className="pbar-label">
            {label}
          </span>
          <span className="pbar-read" aria-hidden>
            <m.span initial={false} animate={{ opacity: indeterminate ? 1 : 0 }} transition={transition}>
              {pendingLabel}
            </m.span>
            <m.span className="pbar-percent" initial={false} animate={{ opacity: indeterminate ? 0 : 1 }} transition={transition}>
              {percent}%
            </m.span>
          </span>
        </div>

        <div
          role="progressbar"
          aria-labelledby={labelId}
          aria-valuemin={0}
          aria-valuemax={max}
          {...(indeterminate ? {} : { "aria-valuenow": Math.round(fraction * max * 100) / 100, "aria-valuetext": `${percent}%` })}
          className="pbar-track"
        >
          <div className="pbar-lane">
            <m.span
              aria-hidden
              className="pbar-fill"
              initial={false}
              animate={{ scaleX: indeterminate ? 0 : fraction }}
              transition={reduced ? INSTANT : FILL}
            />
            {indeterminate && !reduced ? (
              <m.span
                aria-hidden
                className="pbar-fill pbar-sweep"
                initial={{ x: "-100%", opacity: 0 }}
                animate={{ x: "250%", opacity: 1 }}
                transition={{ x: { duration: 1.25, ease: "easeInOut", repeat: Infinity }, opacity: { duration: 0.18 } }}
              />
            ) : null}
          </div>
        </div>

        <span aria-live="polite" className="sr-only">
          {complete ? completeLabel : indeterminate ? pendingLabel : ""}
        </span>
      </div>
    </Lazy>
  );
}
