export function mean(nums) {
  if (nums.length === 0) throw new RangeError("mean of an empty list");
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
