import { useEffect, useState } from "react";
import { fmtCountdown } from "../format";

/**
 * The time left to a scheduled wake-up, on its own clock rather than the fleet's refresh: it changes at the moment a displayed
 * second elapses, so the number moves steadily between the server's updates. Once the time has passed it says "now" and stops.
 */
export function WakeTimer({ at }: { at: number }) {
  const [, redraw] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      redraw((n) => n + 1);
      const left = at - Date.now();
      if (left <= 0) return;
      // The number shown is the seconds left rounded up, so it drops when what is left crosses the next whole second below it.
      timer = setTimeout(tick, left - (Math.ceil(left / 1000) - 1) * 1000);
    };
    const left = at - Date.now();
    if (left > 0) timer = setTimeout(tick, left - (Math.ceil(left / 1000) - 1) * 1000);
    return () => clearTimeout(timer);
  }, [at]);
  const left = at - Date.now();
  return (
    <strong className="wake-timer mono" role="timer">
      {left <= 0 ? "now" : fmtCountdown(Math.ceil(left / 1000))}
    </strong>
  );
}
