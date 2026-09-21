import { mean, median } from "./stats.js";

/** One line per series, for the nightly latency mail. */
export function summarize(samples) {
  return `n=${samples.length} mean=${mean(samples).toFixed(2)} median=${median(samples).toFixed(2)}`;
}
