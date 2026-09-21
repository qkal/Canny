const sorted = (nums) => [...nums].sort((a, b) => a - b);

export function mean(nums) {
  if (nums.length === 0) throw new RangeError("mean of an empty list");
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function median(nums) {
  if (nums.length === 0) throw new RangeError("median of an empty list");
  const s = sorted(nums);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
