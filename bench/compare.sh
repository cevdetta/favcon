#!/usr/bin/env bash
#
# favcon against its two predecessors, with hyperfine.
#
#   bench/compare.sh [corpus-dir]
#
# The three are NOT interchangeable, and a single number would hide that, so this runs two
# configurations and a byte sweep:
#
#   A  defaults      what you actually get by typing the command. favcon defaults to
#                    --colors 256 and the other two to 8, so this is a comparison of
#                    products, not of implementations.
#   B  like-for-like --colors 8 --sizes "192 512" everywhere, which is the only way to
#                    read the wall clock as a statement about the code.
#   C  bytes         one cold build per tool per mark; bytes are deterministic, so this
#                    needs no repetition.
#
# Read the caveat in the output before quoting a speedup: favicon.sh does less work. It
# emits no logo.svg, and its perl inliner bails out on any at-rule - so for an animated
# mark its icon.svg keeps the <style>, the @media and the @keyframes that favcon's
# icon.svg exists to remove.

set -Eeuo pipefail
export LC_ALL=C

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(dirname -- "$HERE")

NEW=${FAVCON_NEW:-$ROOT/bin/favcon.mjs}
OLD=${FAVCON_OLD:-$HOME/dev/branding-c/favicon/favicon.mjs}
SH=${FAVCON_SH:-$HOME/.local/bin/favicon.sh}
CORPUS=${1:-${FAVCON_CORPUS:-$HOME/dev/branding/concepts}}
OUT=$HERE/out/compare
RUNS=${RUNS:-5}
BYTE_MARKS=${BYTE_MARKS:-6}

command -v hyperfine >/dev/null || { echo "compare: hyperfine is not installed" >&2; exit 1; }
[[ -d $CORPUS ]] || { echo "compare: no corpus at $CORPUS" >&2; exit 1; }

mapfile -t MARKS < <(find "$CORPUS" -maxdepth 1 -name '*.svg' | sort)
(( ${#MARKS[@]} )) || { echo "compare: no SVGs in $CORPUS" >&2; exit 1; }

# The corpus is homogeneous - same viewBox, two or three paths each - so one mark is
# representative for timing. The median by file size is the least arguable choice.
mapfile -t BY_SIZE < <(ls -S "${MARKS[@]}")
MARK=${MARK:-${BY_SIZE[$(( ${#BY_SIZE[@]} / 2 ))]}}

rm -rf -- "$OUT"; mkdir -p -- "$OUT"

have() { [[ -x $1 || -f $1 ]]; }
declare -a NAMES=() CMDS_A=() CMDS_B=()
add() {                                   # add <name> <defaults-cmd> <like-for-like-cmd>
  NAMES+=("$1"); CMDS_A+=("$2"); CMDS_B+=("$3")
}
# hyperfine runs each command through a shell, so the arguments are quoted the way a shell
# needs them: an unquoted #ffffff starts a comment and silently truncates the command, and
# `--sizes 192 512` has to stay one argument. The shell costs about a millisecond against a
# build of several seconds, which is why using it is cheaper than fighting it with -N.
BG="'#000000'"
SZ="'192 512'"
have "$NEW" && add "favcon (new)" \
  "node $NEW -q --bg $BG -o $OUT/r-new $MARK" \
  "node $NEW -q --bg $BG --colors 8 --sizes $SZ -o $OUT/r-new $MARK"
have "$OLD" && add "favicon.mjs (old)" \
  "$OLD -q --bg $BG -o $OUT/r-old $MARK" \
  "$OLD -q --bg $BG --colors 8 --sizes $SZ -o $OUT/r-old $MARK"
have "$SH" && add "favicon.sh" \
  "$SH -q --bg $BG -o $OUT/r-sh $MARK" \
  "$SH -q --bg $BG --colors 8 --sizes $SZ -o $OUT/r-sh $MARK"

(( ${#NAMES[@]} > 1 )) || { echo "compare: need at least two implementations" >&2; exit 1; }

banner() { printf '\n\033[1m%s\033[0m\n' "$*"; }

banner "environment"
printf '  %-10s %s\n' node "$(node --version)" resvg "$(resvg --version)" \
       pngquant "$(pngquant --version 2>&1 | head -1)" oxipng "$(oxipng --version)"
printf '  %-10s %s\n' cores "$(nproc)" mark "${MARK##*/}" corpus "${#MARKS[@]} marks" runs "$RUNS"

run_config() {                            # run_config <label> <array-name> <slug>
  local label=$1 arr=$2 slug=$3 i args=()
  banner "$label"
  for i in "${!NAMES[@]}"; do
    local -n ref=$arr
    args+=(--command-name "${NAMES[$i]}" "${ref[$i]}")
  done
  # --prepare wipes the output directory so every run is a cold build, and -N keeps a
  # shell out of the measurement. Zopfli saturates every core, so this is only meaningful
  # on an otherwise idle machine.
  hyperfine --warmup 1 --runs "$RUNS" --prepare "rm -rf $OUT/r-new $OUT/r-old $OUT/r-sh" \
            --export-markdown "$OUT/$slug.md" --export-json "$OUT/$slug.json" \
            "${args[@]}"
}

run_config "A. each tool's own defaults" CMDS_A defaults
run_config "B. like-for-like (--colors 8, --sizes \"192 512\")" CMDS_B like-for-like

# ---- C. bytes -------------------------------------------------------------------------
# Deterministic, so one build each. Every file any tool emits is listed; a blank cell means
# that tool does not produce that file at all, which is itself the point.
banner "C. output bytes, like-for-like, first $BYTE_MARKS marks"
declare -A TOTAL=()
rows=$OUT/bytes.tsv
: >"$rows"
for m in "${MARKS[@]:0:$BYTE_MARKS}"; do
  for i in "${!NAMES[@]}"; do
    d=$OUT/b-$i/${m##*/}
    rm -rf -- "$d"; mkdir -p -- "$d"
    case ${NAMES[$i]} in
      favcon*) node "$NEW" -q --bg "#000000" --colors 8 --sizes "192 512" -o "$d" "$m" >/dev/null 2>&1 ;;
      favicon.mjs*) "$OLD" -q --bg "#000000" --colors 8 --sizes "192 512" -o "$d" "$m" >/dev/null 2>&1 ;;
      favicon.sh*) "$SH" -q --bg "#000000" --colors 8 --sizes "192 512" -o "$d" "$m" >/dev/null 2>&1 ;;
    esac
    for f in "$d"/*; do
      printf '%s\t%s\t%s\n' "${NAMES[$i]}" "${f##*/}" "$(stat -c %s -- "$f")" >>"$rows"
    done
  done
done

awk -F'\t' '
  { sum[$1 FS $2] += $3; files[$2] = 1; tools[$1] = 1; total[$1] += $3 }
  END {
    n = 0; for (t in tools) order[++n] = t
    printf "%-22s", "file"
    for (i = 1; i <= n; i++) printf "%18s", order[i]
    printf "\n"
    split("logo.svg icon.svg favicon.ico apple-touch-icon.png icon-192.png icon-512.png", want, " ")
    for (w = 1; w <= 6; w++) {
      f = want[w]; if (!(f in files)) continue
      printf "%-22s", f
      for (i = 1; i <= n; i++) {
        k = order[i] FS f
        if (k in sum) printf "%18d", sum[k]; else printf "%18s", "-"
      }
      printf "\n"
    }
    printf "%-22s", "TOTAL"
    for (i = 1; i <= n; i++) printf "%18d", total[order[i]]
    printf "\n"
  }' "$rows"

banner "caveat"
cat <<'NOTE'
  favicon.sh is not doing the same job. It emits no logo.svg, and its inliner abandons the
  stylesheet whenever it meets an at-rule - so for an animated mark its icon.svg still
  carries the <style>, the @media and the @keyframes. Every mark in this corpus is animated.
  Compare the icon.svg row before reading the wall clock as a verdict.
NOTE
printf '\n  written to %s\n' "$OUT"
