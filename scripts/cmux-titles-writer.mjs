#!/usr/bin/env node
// Keeps ~/.podium/cmux-titles.json current so a Podium server that cmux will not talk to (started by launchd, not inside
// cmux) still names its cards after the cmux tabs. Run it from inside cmux (a Dock control or a tab): cmux refuses any
// other process. Reads the tab titles the way the server does and saves them every 15 seconds; stops only when told to.
// Needs the server built (`podiumctl build --mode standalone`). No arguments are required.
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const USAGE = `Usage: node scripts/cmux-titles-writer.mjs [--once] [--interval <seconds>] [--file <path>]

Writes the cmux tab titles to ~/.podium/cmux-titles.json (--file changes it) every --interval seconds (default 15, at most 300: the server ignores a file older than ten minutes).
--once writes one time and exits (status 1 when cmux refuses). PODIUM_CMUX_BIN names another cmux binary.
Run it from inside cmux; stop it with kill <pid>.`;

export function parseArgs(argv) {
  const out = { once: false, intervalMs: 15_000, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') out.once = true;
    else if (a === '--interval') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 1 || n > 300) throw new Error('--interval needs a number of seconds from 1 to 300');
      out.intervalMs = n * 1000;
    } else if (a === '--file') {
      out.file = argv[++i];
      if (!out.file) throw new Error('--file needs a path');
    } else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(USAGE);
  const { CMUX_BIN, defaultTitlesFile, execList, writeTitlesFile } = await import('../server/dist/fleet/cmuxNames.js');
  const file = args.file ?? defaultTitlesFile(os.homedir());
  const list = execList(process.env.PODIUM_CMUX_BIN || CMUX_BIN);
  let lastError = '';
  let running = false;
  const tick = async () => {
    // A slow cmux call must not let a later refresh be overwritten by an earlier one.
    if (running) return false;
    running = true;
    try {
      writeTitlesFile(file, await list(), Date.now());
      lastError = '';
      return true;
    } catch (err) {
      // One line per distinct reason, so a cmux that stays unreachable does not fill a log.
      if (err.message !== lastError) console.error(`cmux_titles_writer.failed reason=${JSON.stringify(String(err.message).slice(0, 200))}`);
      lastError = err.message;
      return false;
    } finally {
      running = false;
    }
  };
  if (args.once) process.exit((await tick()) ? 0 : 1);
  await tick();
  setInterval(tick, args.intervalMs);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((err) => { console.error(`cmux_titles_writer.failed reason=${JSON.stringify(err.message)}`); process.exit(1); });
