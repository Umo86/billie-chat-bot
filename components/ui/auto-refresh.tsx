"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-reads the page every few seconds while something is still in progress. */
export function AutoRefresh({ active, every = 3000 }: { active: boolean; every?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, every);
    return () => clearInterval(t);
  }, [active, every, router]);
  return null;
}
