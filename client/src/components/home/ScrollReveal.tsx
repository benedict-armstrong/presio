import { useEffect, useRef, useState } from "react";
import { REDUCED_MOTION_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";

// How far the page scrolls while a revealed section brightens to full.
const RAMP_PX = 500;

// Shared scroll-reveal: dims + drops an element until it enters the
// viewport, then brightens it as the page scrolls further (used for every
// section below the hero demo reel).
function useScrollReveal() {
  const ref = useRef<HTMLDivElement | null>(null);
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const [inView, setInView] = useState(() => reducedMotion);
  const [scrollY, setScrollY] = useState(() =>
    reducedMotion ? 0 : typeof window !== "undefined" ? window.scrollY : 0
  );

  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold: 0.2 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [inView]);

  // Read once per frame, not on every scroll event.
  useEffect(() => {
    if (reducedMotion) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      setScrollY(window.scrollY);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [reducedMotion]);

  const progress = inView ? (reducedMotion ? 1 : Math.min(1, scrollY / RAMP_PX)) : 0;
  const opacity = 0.4 + progress * 0.6;

  return { ref, inView, opacity };
}

export function ScrollReveal({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const { ref, inView, opacity } = useScrollReveal();
  return (
    <div
      ref={ref}
      className={`transition-all duration-700 ease-out ${inView ? "translate-y-0" : "translate-y-7"} ${className}`}
      style={{ opacity }}
    >
      {children}
    </div>
  );
}
