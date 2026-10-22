/*
 * A placeholder that never flashes and never moves the page. Adapted from interior.dev's Skeleton Swap: the
 * timing hook is theirs as it stands. The skeleton waits `delay` ms before it can appear, so a fast answer
 * never shows one, and once shown it stays `minVisible` ms, so it never flickers. The crossfade springs are
 * theirs too.
 *
 * One change: theirs reserves a fixed box and scrolls inside it, which suits a short bio. An answer can run
 * to any length, so this one keeps a minimum height and lets the content set the rest.
 */
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import "../../styles/interior.css";
import { Lazy } from "./Lazy";

const CROSSFADE = { type: "spring", stiffness: 260, damping: 34, mass: 0.8 } as const;

/** Bar widths in a fixed pattern, the last line short, so the placeholder looks the same on every render. */
const WIDTHS = [100, 93, 97, 88, 95, 91] as const;
const widthFor = (index: number, total: number) => (total > 1 && index === total - 1 ? 62 : WIDTHS[(index * 7 + 3) % WIDTHS.length]);

export function useSkeletonSwap({ ready, delay = 120, minVisible = 380 }: { ready: boolean; delay?: number; minVisible?: number }) {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef(0);

  useEffect(() => {
    if (!ready) {
      if (visible) return;
      const t = setTimeout(() => {
        shownAt.current = performance.now();
        setVisible(true);
      }, delay);
      return () => clearTimeout(t);
    }

    if (!visible) return;
    const rest = Math.max(0, minVisible - (performance.now() - shownAt.current));
    const t = setTimeout(() => setVisible(false), rest);
    return () => clearTimeout(t);
  }, [ready, visible, delay, minVisible]);

  return { showSkeleton: visible, busy: !ready };
}

/** `children` is the real content, drawn once `ready`. `label` names the region and says "loaded" once. */
export function SkeletonSwap({
  ready,
  children,
  label,
  lines = 2,
  lineHeight = 22,
  barHeight = 9,
  delay,
  minVisible,
  className = "",
}: {
  ready: boolean;
  children: ReactNode;
  label?: string;
  lines?: number;
  lineHeight?: number;
  barHeight?: number;
  delay?: number;
  minVisible?: number;
  className?: string;
}) {
  const { showSkeleton } = useSkeletonSwap({ ready, delay, minVisible });
  const reduced = useReducedMotion();

  return (
    <Lazy>
      <div
        className={`swap ${className}`.trim()}
        aria-busy={!ready}
        aria-label={label}
        // The room for the placeholder is kept from the start, so it appearing later moves nothing.
        style={{ minHeight: !ready || showSkeleton ? lines * lineHeight : undefined }}
      >
        <m.div
          className="swap-content"
          initial={false}
          animate={reduced ? { opacity: showSkeleton ? 0 : 1 } : { opacity: showSkeleton ? 0 : 1, scale: showSkeleton ? 0.99 : 1 }}
          transition={reduced ? { duration: 0 } : CROSSFADE}
          style={{ transformOrigin: "top left", pointerEvents: showSkeleton ? "none" : undefined }}
        >
          {children}
        </m.div>

        <AnimatePresence initial={false}>
          {showSkeleton ? (
            <m.div
              key="skeleton"
              aria-hidden
              className="swap-skeleton"
              initial={{ opacity: reduced ? 1 : 0 }}
              animate={{ opacity: 1 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, filter: "blur(3px)" }}
              transition={reduced ? { duration: 0 } : CROSSFADE}
            >
              {Array.from({ length: lines }, (_, i) => (
                <div key={i} className="swap-line" style={{ height: lineHeight }}>
                  <div className="swap-bar" style={{ height: barHeight, width: `${widthFor(i, lines)}%` }} />
                </div>
              ))}
            </m.div>
          ) : null}
        </AnimatePresence>

        {label ? (
          <span role="status" className="sr-only">
            {ready ? `${label} loaded` : ""}
          </span>
        ) : null}
      </div>
    </Lazy>
  );
}
