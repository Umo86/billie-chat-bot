"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { BAR_TOPIC_MS, barTopics, DEFAULT_BAR_LEAD, shade, type BarMascot } from "@/lib/chat/bar";
import { textOn } from "@/lib/bots/slug";

/**
 * How the chat bar looks on the website (Look step). The real one is drawn
 * by public/widget.js with the same colours, words and timing.
 */
export function BarPreview({
  color,
  lead,
  topics,
  mascot,
  avatarUrl,
  motion,
}: {
  color: string;
  lead: string;
  topics: string[];
  mascot: BarMascot;
  avatarUrl: string | null;
  motion: boolean;
}) {
  const list = barTopics(topics);
  const [at, setAt] = useState(0);
  const topic = useRef<HTMLSpanElement>(null);
  const on = textOn(color);

  useEffect(() => {
    if (list.length < 2) return;
    const t = setInterval(() => setAt((n) => n + 1), BAR_TOPIC_MS);
    return () => clearInterval(t);
  }, [list.length]);

  useEffect(() => {
    if (!motion || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    topic.current?.animate(
      [
        { opacity: 0, transform: "translateY(70%)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 380, easing: "cubic-bezier(.3,.8,.3,1)" },
    );
  }, [at, motion]);

  return (
    <div
      className="flex h-[54px] items-center gap-3 overflow-hidden rounded-[16px] pr-2 pl-3.5 text-[15px] whitespace-nowrap shadow-panel"
      style={{
        background: `linear-gradient(180deg, ${shade(color, 0.1)}, ${shade(color, -0.1)})`,
        color: on,
      }}
    >
      {mascot === "picture" && avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatarUrl} alt="" className="size-[34px] shrink-0 rounded-full object-cover" />
      ) : mascot === "robot" ? (
        <span
          aria-hidden
          className="relative mt-1.5 flex h-6 w-[30px] shrink-0 items-center justify-center gap-1.5 bg-white"
          style={{ borderRadius: "48% 48% 42% 42% / 58% 58% 42% 42%" }}
        >
          <span className="absolute -top-1.5 left-1/2 -ml-px h-[7px] w-0.5 rounded bg-white" />
          <span className="absolute -top-2.5 left-1/2 -ml-[3px] size-1.5 rounded-full bg-white" />
          {[0, 1].map((i) => (
            <span
              key={i}
              className="h-2 w-1 rounded-[3px]"
              style={{ background: shade(color, -0.65) }}
            />
          ))}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 items-center gap-[0.35em] overflow-hidden">
        <span className="shrink-0 opacity-85">{lead.trim() || DEFAULT_BAR_LEAD}</span>
        <span ref={topic} className="min-w-0 truncate py-1 font-bold">
          {list[at % list.length]}
        </span>
      </span>
      <span
        aria-hidden
        className="grid size-[38px] shrink-0 place-items-center rounded-full bg-white"
        style={{ color: on === "#ffffff" ? color : "#111111" }}
      >
        <ArrowUp className="size-[18px]" strokeWidth={2.4} />
      </span>
    </div>
  );
}
