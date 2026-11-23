// The backend log: one line per event, with the event name and ids only.
// Never pass message text, tool input, paths from transcripts or env values.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogFields = Record<string, string | number | boolean | null | undefined>;
export type Log = (event: string, fields?: LogFields) => void;

const SAFE = /^[\w.:@-]{0,128}$/;

function clean(value: unknown): string {
  const s = String(value);
  return SAFE.test(s) ? s : JSON.stringify(s.slice(0, 128));
}

export function openLog(file: string): Log {
  mkdirSync(dirname(file), { recursive: true });
  return (event, fields = {}) => {
    let line = `${new Date().toISOString()} ${clean(event)}`;
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) line += ` ${clean(k)}=${clean(v)}`;
    }
    try {
      appendFileSync(file, line + '\n');
    } catch {
      // A log write must never take the backend down.
    }
  };
}

export const nullLog: Log = () => {};
