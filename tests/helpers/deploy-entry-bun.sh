#!/usr/bin/env bash
# The host Bun of a deploy-entry fixture (tests/ops/deploy-entry.test.ts): it runs the core, the console's plan check (which
# passes) and the console's stage tool (which stages a synthetic configuration). The preflight answers FIXTURE_PREFLIGHT; the
# hand-over keeps a copy of the stage, its standard input, the lock and BOT_HOST it inherited, optionally publishes a
# transaction pointer (FIXTURE_POINTER) and exits with FIXTURE_CORE.
set -euo pipefail
printf 'bun %s\n' "$*" >> "$FIXTURE_EVENTS"
previous='' stage='' project=''
for arg in "$@"; do
    [ "$previous" != --stage ] || stage="$arg"
    [ "$previous" != --project ] || project="$arg"
    previous="$arg"
done
case " $* " in
    *" --preflight "*) exit "${FIXTURE_PREFLIGHT:-0}" ;;
    *"/check-plan.ts "*) exit 0 ;;
    *" ops/core/console-stage.ts "*|*"/ops/core/console-stage.ts "*)
        printf '%s\n' '{"version":1,"base":{"kind":"app","files":{"app":null},"binding":null},"next":{"kind":"app","files":{"app":"{}"},"binding":null}}' \
            > "$stage/configuration-app.json"
        printf '%s\n' '{"version":1,"base":{"kind":"models","files":{"models":null,"settings":null,"catalog":null},"binding":null},"next":{"kind":"models","files":{"models":"{}","settings":"{}","catalog":null},"binding":null}}' \
            > "$stage/configuration-models.json"
        exit 0 ;;
esac
cp -R -- "$stage" "$FIXTURE_CAPTURE"
printf 'stdin=%s\nlock=%s\nhost=%s\n' "$(readlink /proc/self/fd/0)" "${BOT_DEPLOY_LOCK_HELD:-}" "${BOT_HOST-unset}" > "$FIXTURE_CAPTURE.env"
echo CORE-HANDOVER
[ -z "${FIXTURE_POINTER:-}" ] || printf '%s\n' "$FIXTURE_POINTER" > "$project/data/state/deploy-transaction"
exit "${FIXTURE_CORE:-0}"
