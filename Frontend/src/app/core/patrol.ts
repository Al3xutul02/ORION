/**
 * Patrol spacing: keeps the drones on one orbit evenly spread (4 drones 90° apart, 3 at 120°...).
 * A drone ahead of its slot slows down until the gaps are equal again; none ever flies faster
 * than the normal orbit speed. Mirror of Backend/app/services/patrol.py.
 */
export const TAU = 2 * Math.PI;
export const MIN_RATE_FACTOR = 0.4; // a drone waits for its slot at no less than 40% of orbit speed
const GAIN = 4; // how hard a drone brakes per radian ahead of its slot

const mod = (a: number) => ((a % TAU) + TAU) % TAU;
export const wrap = (a: number) => mod(a + Math.PI) - Math.PI;

/** How far (radians) each drone is from its evenly spaced slot; positive = drone is ahead. */
export function slotErrors(angles: Map<number, number>): Map<number, number> {
  const n = angles.size;
  if (n < 2) return new Map([...angles.keys()].map(i => [i, 0]));
  const order = [...angles.keys()].sort((a, b) => mod(angles.get(a)!) - mod(angles.get(b)!));
  const step = TAU / n;
  let sx = 0;
  let sy = 0;
  order.forEach((i, k) => {
    sx += Math.cos(angles.get(i)! - k * step);
    sy += Math.sin(angles.get(i)! - k * step);
  });
  const phase = Math.atan2(sy, sx);
  return new Map(order.map((i, k) => [i, wrap(angles.get(i)! - (phase + k * step))]));
}

/** Angular speed for each drone on the orbit: base speed, or slower while ahead of its slot. */
export function spacingRates(angles: Map<number, number>, baseRate: number): Map<number, number> {
  return new Map(
    [...slotErrors(angles)].map(([i, err]) => [i, baseRate * Math.max(MIN_RATE_FACTOR, 1 - GAIN * Math.max(0, err))]),
  );
}
