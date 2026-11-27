#!/bin/zsh
set -u

stopping=0
child_pid=0
failure_count=0
stop_worker() {
  stopping=1
  if (( child_pid > 0 )); then kill -TERM "$child_pid" 2>/dev/null || true; fi
}
trap stop_worker TERM INT

# Long-lived A1 entrypoint. The runtime still checks the DB policy immediately
# before every mutation; 00:00-24:00 policies are intentionally allowed all day.
while (( !stopping )); do
  run_key="continuous-all-$(TZ=Asia/Seoul date +%Y%m%d-%H%M%S)"
  PGOPTIONS='-c statement_timeout=45000 -c lock_timeout=5000' \
  node --import tsx programs/naver-auto-bid/src/competitor-pipeline.ts \
    --confirm-live --parallel-queries --all-keywords \
    "--run-key=${run_key}" &
  child_pid=$!
  wait "$child_pid"
  exit_code=$?
  if (( stopping )); then wait "$child_pid" 2>/dev/null || true; break; fi
  child_pid=0
  if (( exit_code != 0 )); then
    (( failure_count = failure_count < 6 ? failure_count + 1 : 6 ))
    delay=$(( 15 * (2 ** (failure_count - 1)) + RANDOM % 10 ))
    print -u2 -- "streaming cycle failed status=${exit_code}; consecutive=${failure_count}; backoff=${delay}s"
  else
    failure_count=0
    delay=60
  fi
  # Keep TERM responsive even during a circuit backoff or an empty inventory.
  for (( second=0; second<delay && !stopping; second++ )); do sleep 1; done
done
