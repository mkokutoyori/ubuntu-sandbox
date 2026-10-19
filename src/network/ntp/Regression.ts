const CHI2_COEFFICIENTS: readonly number[] = [
  2.706, 4.605, 6.251, 7.779, 9.236, 10.645, 12.017, 13.362,
  14.684, 15.987, 17.275, 18.549, 19.812, 21.064, 22.307, 23.542,
  24.769, 25.989, 27.204, 28.412, 29.615, 30.813, 32.007, 33.196,
  34.382, 35.563, 36.741, 37.916, 39.087, 40.256, 41.422, 42.585,
  43.745, 44.903, 46.059, 47.212, 48.363, 49.513, 50.660, 51.805,
  52.949, 54.090, 55.230, 56.369, 57.505, 58.641, 59.774, 60.907,
  62.038, 63.167, 64.295, 65.422, 66.548, 67.673, 68.796, 69.919,
  71.040, 72.160, 73.279, 74.397, 75.514, 76.630, 77.745, 78.860,
].map(Math.fround);

export function chi2Coefficient(degreesOfFreedom: number): number {
  return degreesOfFreedom <= 64 ? CHI2_COEFFICIENTS[degreesOfFreedom - 1] : 1.2 * degreesOfFreedom;
}

export interface WeightedFit {
  readonly intercept: number;
  readonly slope: number;
  readonly variance: number;
  readonly interceptDeviation: number;
  readonly slopeDeviation: number;
}

export function weightedRegression(
  x: readonly number[], y: readonly number[], w: readonly number[], n: number,
): WeightedFit {
  let sumXw = 0;
  let totalWeight = 0;
  for (let i = 0; i < n; i++) {
    sumXw += x[i] / w[i];
    totalWeight += 1 / w[i];
  }
  const u = sumXw / totalWeight;
  let p = 0;
  let q = 0;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const ui = x[i] - u;
    p += y[i] / w[i];
    q += y[i] * ui / w[i];
    v += ui * ui / w[i];
  }
  const slope = q / v;
  const intercept = p / totalWeight - slope * u;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const diff = y[i] - intercept - slope * x[i];
    s2 += diff * diff / w[i];
  }
  s2 /= n - 2;
  const slopeDeviation = Math.sqrt(s2 / v);
  const aa = u * slopeDeviation;
  return {
    intercept, slope,
    variance: s2 * (n / totalWeight),
    interceptDeviation: Math.sqrt(s2 / totalWeight + aa * aa),
    slopeDeviation,
  };
}

export function multipleRegressionSecondSlope(
  x1: readonly number[], x2: readonly number[], y: readonly number[], n: number,
): number | null {
  if (n < 4) return null;
  let sx1 = 0; let sx2 = 0; let sx1x1 = 0; let sx1x2 = 0; let sx2x2 = 0; let sx1y = 0; let sx2y = 0; let sy = 0;
  for (let i = 0; i < n; i++) {
    sx1 += x1[i];
    sx2 += x2[i];
    sx1x1 += x1[i] * x1[i];
    sx1x2 += x1[i] * x2[i];
    sx2x2 += x2[i] * x2[i];
    sx1y += x1[i] * y[i];
    sx2y += x2[i] * y[i];
    sy += y[i];
  }
  const u = n * (sx1x2 * sx1y - sx1x1 * sx2y) + sx1 * sx1 * sx2y - sx1 * sx2 * sx1y + sy * (sx2 * sx1x1 - sx1 * sx1x2);
  const v1 = n * (sx1x2 * sx1x2 - sx1x1 * sx2x2);
  const v2 = sx1 * sx1 * sx2x2 + sx2 * sx2 * sx1x1;
  const v3 = -2.0 * sx1 * sx2 * sx1x2;
  const v = v1 + v2 + v3;
  if (Math.abs(v) * 1.0e10 <= -v1 + v2 + Math.abs(v3)) return null;
  return u / v;
}
