// One starter for daemon-files.test.ts's race: says `ready`, tries the lock on the line `go`, says
// `won` or `locked`, and holds what it won until its stdin closes.
import { createInterface } from 'node:readline';
import { acquireLock, LockedError } from '../../src/daemon-files.ts';

const dir = process.argv[2];
const lines = createInterface({ input: process.stdin });
process.stdout.write('ready\n');
lines.once('line', () => {
  try {
    acquireLock(dir);
    process.stdout.write('won\n');
  } catch (e) {
    process.stdout.write(e instanceof LockedError ? 'locked\n' : `error ${(e as Error).message}\n`);
  }
});
lines.once('close', () => process.exit(0));
