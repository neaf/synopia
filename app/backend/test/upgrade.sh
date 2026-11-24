#!/bin/bash
# The one-time upgrade from a daemon of the rearch-base code to this tree's (test/upgrade.ts). Opt-in
# and slow (about 30 s), so not in app/check.sh.
#   app/backend/test/upgrade.sh [<git ref of the old code>]
exec node --experimental-strip-types --disable-warning=ExperimentalWarning "$(dirname "$0")/upgrade.ts" "$@"
