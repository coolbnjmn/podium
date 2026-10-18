import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { IconCheck, IconCopy } from "./Icons";

/** How long "Copied" stays on a copy control. */
export const COPIED_MS = 1600;

/** The characters of a session id shown on the card and the orchestrator page; the click copies all of it. */
export const SHORT_ID = 8;

/**
 * The session id, shortened, copied whole on a click (#322). On the orchestrator page it is a button. On a card it sits inside the card's own
 * button, so it is a `role="button"` span that keeps its click and Enter/Space from opening the card.
 */
export function SessionId({ id, nested, prefix }: { id: string; nested?: boolean; prefix?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const short = id.slice(0, SHORT_ID);
  const settle = (next: "copied" | "failed") => {
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), COPIED_MS);
  };
  const copy = () => {
    try {
      const p = navigator.clipboard?.writeText(id);
      if (!p) return settle("failed");
      p.then(() => settle("copied"), () => settle("failed"));
    } catch {
      settle("failed");
    }
  };
  const label = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : `${prefix ?? ""}${short}`;
  const props = {
    className: "sid",
    title: `Copy session id ${id}`,
    "aria-label": `Copy session id ${short}`,
  };
  const body = (
    <>
      <span aria-live="polite">{label}</span>
      {state === "copied" ? <IconCheck /> : <IconCopy />}
    </>
  );
  if (!nested) {
    return (
      <button type="button" {...props} onClick={copy}>
        {body}
      </button>
    );
  }
  const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation();
  return (
    <span
      role="button"
      tabIndex={0}
      {...props}
      onClick={(e) => {
        stop(e);
        copy();
      }}
      onKeyDown={(e) => {
        stop(e);
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          copy();
        }
      }}
    >
      {body}
    </span>
  );
}
