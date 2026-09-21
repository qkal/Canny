cat >> src/stats.js <<'JS'

export function percentile(nums, p) {
  if (nums.length === 0) throw new RangeError("percentile of an empty list");
  if (!(p >= 0 && p <= 100)) throw new RangeError("p must be within 0..100");
  const s = sorted(nums);
  const h = ((s.length - 1) * p) / 100;
  const lo = Math.floor(h);
  return s[lo] + (h - lo) * ((s[lo + 1] ?? s[lo]) - s[lo]);
}
JS
cat > src/report.js <<'JS'
import { mean, median, percentile } from "./stats.js";

export function summarize(samples) {
  return `n=${samples.length} mean=${mean(samples).toFixed(2)} median=${median(samples).toFixed(2)} p95=${percentile(samples, 95).toFixed(2)}`;
}
JS
