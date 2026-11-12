#!/usr/bin/env bash
# Run Lighthouse (the engine behind Google's PageSpeed Insights) against a URL,
# in its default mobile mode, and fail if any category drops below its floor.
#
#   scripts/lighthouse-gate.sh http://localhost:8080/              # the image a PR ships
#   scripts/lighthouse-gate.sh https://cams.skylar.technology/     # production (live-check.yml)
#
# Needs a Chrome: CHROME_PATH, or google-chrome on PATH (GitHub's runners have
# one). Writes the median run's report to lighthouse-report.report.{json,html}.
#
# Adapted from klaushofrichter/www-skylar-technology (itself from
# christina.art), the reference for kube-setup's "public web pages" baseline
# (docs/cluster-deployment-requirements.md, §4).
#
# Floors: performance >= 90, everything else 100: a drop there is always a
# real defect (a contrast slip, a missing meta tag, a console error), never
# noise. Measured 2026-11-11 on https://cams.skylar.technology/ before this
# gate existed: performance 99/99/99, accessibility 94 (the viewport refused
# zooming), best practices 100, SEO 100, layout shift 0, 242 KB in all.
#
# Lighthouse runs LH_RUNS times (default 3). Performance is judged on the
# MEDIAN run (one run on a busy GitHub runner can score 81 where three from
# elsewhere score 100); every other category must hold in EVERY run.
#
# Lighthouse sees the signed-out start page only; the sign-in pages and the
# 404 page share its shell and are covered by the axe specs (e2e-public/).
set -euo pipefail

URL="${1:?usage: lighthouse-gate.sh URL}"
OUT="${LH_OUT:-lighthouse-report}"
declare -A FLOOR=([performance]=90 [accessibility]=100 [best-practices]=100 [seo]=100)

CHROME_PATH="${CHROME_PATH:-$(command -v google-chrome || command -v chromium || true)}"
[ -n "$CHROME_PATH" ] || { echo "::error::no Chrome found for Lighthouse"; exit 1; }
export CHROME_PATH

RUNS="${LH_RUNS:-3}"
for n in $(seq 1 "$RUNS"); do
  npx --yes lighthouse@12 "$URL" \
    --quiet \
    --chrome-flags="--headless=new --no-sandbox" \
    --only-categories=performance,accessibility,best-practices,seo \
    --output=json --output=html --output-path="./$OUT-run$n"
done

# The median run by performance becomes the report; the rest are dropped.
median=$(node -e "
const runs=[];for(let n=1;n<=$RUNS;n++)runs.push({n,p:require('./$OUT-run'+n+'.report.json').categories.performance.score});
runs.sort((a,b)=>a.p-b.p);console.log(runs[Math.floor(runs.length/2)].n)")
echo "Lighthouse performance per run: $(for n in $(seq 1 "$RUNS"); do node -e "process.stdout.write(Math.round(require('./$OUT-run$n.report.json').categories.performance.score*100)+' ')"; done)(median: run $median)"

failed=0
for cat in performance accessibility best-practices seo; do
  if [ "$cat" = performance ]; then
    score=$(node -e "console.log(Math.round(require('./$OUT-run$median.report.json').categories.performance.score*100))")
  else
    # The lowest of all runs: these never vary on a sound page.
    score=$(node -e "let m=100;for(let n=1;n<=$RUNS;n++)m=Math.min(m,Math.round(require('./$OUT-run'+n+'.report.json').categories['$cat'].score*100));console.log(m)")
  fi
  floor=${FLOOR[$cat]}
  if [ "$score" -lt "$floor" ]; then
    echo "::error::Lighthouse $cat is $score, below $floor"
    failed=1
  else
    echo "Lighthouse $cat: $score (floor $floor)"
  fi
done

cp "$OUT-run$median.report.json" "$OUT.report.json"
cp "$OUT-run$median.report.html" "$OUT.report.html"
for n in $(seq 1 "$RUNS"); do rm -f "$OUT-run$n.report.json" "$OUT-run$n.report.html"; done

# Name what lost points (in the median run), so nobody has to open the report
# to start fixing.
node -e "
const a=require('./$OUT.report.json').audits;
for (const [id,x] of Object.entries(a))
  if (x.score!==null && x.score<0.9 && !['informative','notApplicable','manual'].includes(x.scoreDisplayMode))
    console.log('  below 90: '+id+' '+(x.displayValue||''));
for (const k of ['first-contentful-paint','largest-contentful-paint','cumulative-layout-shift','total-blocking-time','total-byte-weight'])
  console.log('  '+k+': '+a[k].displayValue);
"
exit $failed
