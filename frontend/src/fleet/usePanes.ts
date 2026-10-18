// Which of the left pane, right pane and top bar are collapsed, and wall mode. The flags are kept in
// localStorage apart from the saved widths (useResizable), so expanding a pane returns it to its width.
// Wall mode collapses all three without touching the saved flags, so leaving it restores them, and a
// reload comes back out of it.
import { useCallback, useState } from "react";
import { readJson, writeJson } from "./storage";

export type Pane = "left" | "right" | "top";
export type Collapsed = Record<Pane, boolean>;
const KEY = "podium.collapsed";
/** The board keeps its own flags (#346) and opens with both side panels collapsed, so its columns get the width. */
const BOARD_KEY = "podium.collapsed.board";
const ALL: Collapsed = { left: true, right: true, top: true };
const FLEET_OPEN: Collapsed = { left: false, right: false, top: false };
const BOARD_OPEN: Collapsed = { left: true, right: true, top: false };

function load(key: string, fallback: Collapsed): Collapsed {
  const v = readJson<Partial<Record<Pane, unknown>> | null>(key, null);
  const flag = (p: Pane) => (typeof v?.[p] === "boolean" ? (v[p] as boolean) : fallback[p]);
  return { left: flag("left"), right: flag("right"), top: flag("top") };
}

export interface Panes {
  /** What is collapsed right now: wall mode collapses everything. */
  collapsed: Collapsed;
  wall: boolean;
  toggle: (pane: Pane) => void;
  enterWall: () => void;
  exitWall: () => void;
}

export function usePanes(board = false): Panes {
  const [fleetSaved, setFleetSaved] = useState<Collapsed>(() => load(KEY, FLEET_OPEN));
  const [boardSaved, setBoardSaved] = useState<Collapsed>(() => load(BOARD_KEY, BOARD_OPEN));
  const saved = board ? boardSaved : fleetSaved;
  const [wall, setWall] = useState(false);

  const save = useCallback(
    (next: Collapsed) => {
      (board ? setBoardSaved : setFleetSaved)(next);
      writeJson(board ? BOARD_KEY : KEY, next);
    },
    [board],
  );

  const toggle = useCallback(
    (pane: Pane) => {
      if (wall) {
        // Opening a pane from its edge tab ends wall mode and restores the saved flags, with that pane open.
        setWall(false);
        save({ ...saved, [pane]: false });
        return;
      }
      save({ ...saved, [pane]: !saved[pane] });
    },
    [wall, saved, save],
  );

  const enterWall = useCallback(() => setWall(true), []);
  const exitWall = useCallback(() => setWall(false), []);

  return { collapsed: wall ? ALL : saved, wall, toggle, enterWall, exitWall };
}
