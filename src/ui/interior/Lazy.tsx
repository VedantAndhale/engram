import { LazyMotion } from "motion/react";
import type { ReactNode } from "react";

/**
 * Motion's lean build: components here use `m`, which carries nothing until this gives it the animation
 * features (springs, exit, tap). The features load as a chunk of their own the first time something animates,
 * so pages that never do pay nothing for them. `strict` makes an accidental full `motion.div` an error.
 */
const features = () => import("./features").then((module) => module.default);

export function Lazy({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={features} strict>
      {children}
    </LazyMotion>
  );
}
