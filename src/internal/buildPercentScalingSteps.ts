type PercentScalingStep = {
  pctTarget: number;
  upper?: number;
  lower?: number;
  change: number;
  pctAfter: number;
};

/**
 * Builds scaling steps, so that the further the actual percentage metric is
 * from pctTarget, the more instances will be added or removed (so the resulting
 * instances busy percentage will remain around pctTarget if nothing changes).
 */
export function buildPercentScalingSteps(
  pctTarget: number,
  steps: number,
): PercentScalingStep[] {
  const result: PercentScalingStep[] = [];

  // An example number of instances to illustrate the "after" situation.
  const N = 100;

  {
    const stepSize = pctTarget / steps;
    for (let i = steps; i >= 1; i--) {
      const lower = Math.round(pctTarget - i * stepSize);
      const upper = Math.round(pctTarget - (i - 1) * stepSize);
      const change = Math.round((upper / pctTarget - 1) * 100);
      const pctAfter = Math.round(
        ((N * upper * 0.01) / (N + N * change * 0.01)) * 100,
      );
      result.push({
        pctTarget,
        lower: lower <= 0 ? undefined : lower,
        upper,
        change,
        pctAfter,
      });
    }
  }

  {
    const stepSize = (100 - pctTarget) / steps;
    for (let i = 1; i <= steps; i++) {
      const lower = Math.round(pctTarget + (i - 1) * stepSize);
      const upper = Math.round(pctTarget + i * stepSize);
      const change = Math.round((upper / pctTarget - 1) * 100);
      const pctAfter = Math.round(
        ((N * upper * 0.01) / (N + N * change * 0.01)) * 100,
      );
      result.push({
        pctTarget,
        lower,
        upper: upper >= 100 ? undefined : upper,
        change,
        pctAfter,
      });
    }
  }

  return result;
}
