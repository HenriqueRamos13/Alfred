/**
 * Corner-HUD battery pure logic. Renderer-safe: NO `node:*` / electron import —
 * shared by App.tsx and unit-tested via strip-types.
 *
 * The reading comes from the Chromium Battery Status API
 * (`navigator.getBattery()`), which reports charge as a 0..1 fraction plus a
 * charging flag. These helpers turn that into the HUD line's text and tone.
 *
 * `getBattery()` resolves even on a machine WITHOUT a battery: per the W3C spec
 * it hands back the "unable to report" sentinel
 * (`level 1`, `charging true`, `chargingTime 0`, `dischargingTime Infinity`)
 * rather than rejecting. So absence is detected by `batteryAbsent`, never by a
 * rejected promise — otherwise the HUD would sit on a bogus green 100%.
 */

export interface BatteryState {
  /** Charge fraction 0..1 as reported by the Battery Status API. */
  level: number;
  charging: boolean;
}

/**
 * A raw Battery Status API reading: `BatteryState` plus the timing fields, which
 * are what make the spec's "unable to report" sentinel recognisable.
 */
export interface BatteryReading extends BatteryState {
  chargingTime: number;
  dischargingTime: number;
}

/**
 * Whole percent for display AND for the tone decision — one source of truth so
 * the two can never disagree. Level is clamped to 0..1 first: the API promises
 * the range, the HUD doesn't trust it.
 */
function batteryPct(level: number): number {
  return Math.round(Math.min(1, Math.max(0, level)) * 100);
}

/** At or below this whole percent, an unplugged battery renders in danger tone. */
export const BATTERY_DANGER_PCT = 20;

/**
 * HUD string for the battery value: whole percent, plus a ` CHG` suffix while
 * charging. That suffix is deliberately ASCII — the vendored HUD font (Share
 * Tech Mono, latin subset) carries no bolt/arrow glyph, so `↯` & friends would
 * render as a fallback face or tofu.
 */
export function formatBattery(b: BatteryState): string {
  const pct = batteryPct(b.level);
  return b.charging ? `${pct}% CHG` : `${pct}%`;
}

/**
 * `.hud-v` class for the battery value: green while charging, red when low and
 * unplugged, default otherwise. The threshold is applied to the SAME rounded
 * percent `formatBattery` prints, so the tone always agrees with the digits.
 */
export function batteryClass(b: BatteryState): string {
  if (b.charging) return 'hud-v on';
  if (batteryPct(b.level) <= BATTERY_DANGER_PCT) return 'hud-v danger';
  return 'hud-v';
}

/**
 * Is this the spec's "unable to report" sentinel, i.e. no battery at all?
 * Exactly `charging` + full + `chargingTime 0` + `dischargingTime Infinity`.
 *
 * Trade-off: a fully-charged laptop that is plugged in reports the identical
 * signature and is therefore hidden too. That is acceptable — there is nothing
 * actionable to show at 100% on AC — and the line reappears on the first
 * charging/level change.
 */
export function batteryAbsent(r: BatteryReading): boolean {
  return r.charging && r.level === 1 && r.chargingTime === 0 && r.dischargingTime === Infinity;
}
