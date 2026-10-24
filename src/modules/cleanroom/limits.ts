/**
 * Cleanroom limits (SC-007 A, D-184A).
 *
 * Particle action limits come from the ISO 14644-1 class formula Cn = 10^N x (0.1 / D)^2.08 particles per cubic metre (N the class, D the
 * size in micrometres), rounded to three significant figures and then to a whole count, which reproduces the standard's table. The standard
 * gives no value for some sizes in some classes (for example 0.1 um in ISO 7); those sizes are not limited unless a point sets its own limit.
 * The platform generates the numbers so the company can see them; it does not certify them. The company confirms them against its own copy
 * of the standard (ISO 14644-1) before relying on them.
 */
export const PARTICLE_CHANNELS = ['p0_1', 'p0_2', 'p0_3', 'p0_5', 'p1', 'p5'] as const;
export const ENV_CHANNELS = ['dp', 'temp', 'rh'] as const;
export const CHANNELS = [...PARTICLE_CHANNELS, ...ENV_CHANNELS] as const;
export type Channel = (typeof CHANNELS)[number];
export type ParticleChannel = (typeof PARTICLE_CHANNELS)[number];

export const SIZE_UM: Record<ParticleChannel, number> = { p0_1: 0.1, p0_2: 0.2, p0_3: 0.3, p0_5: 0.5, p1: 1, p5: 5 };
export const CHANNEL_LABEL: Record<Channel, string> = {
  p0_1: '0.1 µm', p0_2: '0.2 µm', p0_3: '0.3 µm', p0_5: '0.5 µm', p1: '1 µm', p5: '5 µm',
  dp: 'Differential pressure', temp: 'Temperature', rh: 'Relative humidity',
};
export const CHANNEL_UNIT: Record<Channel, string> = { p0_1: '/m³', p0_2: '/m³', p0_3: '/m³', p0_5: '/m³', p1: '/m³', p5: '/m³', dp: 'Pa', temp: '°C', rh: '%RH' };
export const isChannel = (c: string): c is Channel => (CHANNELS as readonly string[]).includes(c);
export const isParticle = (c: string): c is ParticleChannel => (PARTICLE_CHANNELS as readonly string[]).includes(c);

/** Which sizes the standard gives a limit for, by class (the cells of its table that are not blank). */
const APPLICABLE: Record<number, ParticleChannel[]> = {
  1: ['p0_1', 'p0_2'],
  2: ['p0_1', 'p0_2', 'p0_3', 'p0_5'],
  3: ['p0_1', 'p0_2', 'p0_3', 'p0_5', 'p1'],
  4: ['p0_1', 'p0_2', 'p0_3', 'p0_5', 'p1'],
  5: ['p0_1', 'p0_2', 'p0_3', 'p0_5', 'p1', 'p5'],
  6: ['p0_1', 'p0_2', 'p0_3', 'p0_5', 'p1', 'p5'],
  7: ['p0_5', 'p1', 'p5'],
  8: ['p0_5', 'p1', 'p5'],
  9: ['p0_5', 'p1', 'p5'],
};

/** The maximum permitted concentration (per cubic metre) for a class and size, or null where the standard gives none. */
export function classLimit(isoClass: number, channel: ParticleChannel): number | null {
  if (!Number.isInteger(isoClass) || isoClass < 1 || isoClass > 9) return null;
  if (!APPLICABLE[isoClass]!.includes(channel)) return null;
  const raw = 10 ** isoClass * (0.1 / SIZE_UM[channel]) ** 2.08;
  return Math.round(Number(raw.toPrecision(3)));
}

/** The whole table for one class, for the screen and the docs. */
export function classLimits(isoClass: number): { channel: ParticleChannel; label: string; limit: number | null }[] {
  return PARTICLE_CHANNELS.map((c) => ({ channel: c, label: CHANNEL_LABEL[c], limit: classLimit(isoClass, c) }));
}

export interface ChannelLimits { alertLow: number | null; alertHigh: number | null; actionLow: number | null; actionHigh: number | null; source: 'class' | 'point' | 'none' }
export interface Override { alert_low: unknown; alert_high: unknown; action_low: unknown; action_high: unknown }
const n = (v: unknown) => (v == null ? null : Number(v));

/**
 * The limits in force for one channel at one point. Particle channels default to the class action limit with the alert limit at
 * `alertPct` of it; any field a point sets replaces the default for that field. Pressure, temperature and humidity are limited only by
 * the range a point sets (the standard sets none), and a range with only an action level has no alert level.
 */
export function effectiveLimits(isoClass: number, alertPct: number, channel: Channel, o?: Override | null): ChannelLimits {
  let actionHigh = n(o?.action_high); const actionLow = n(o?.action_low);
  let alertHigh = n(o?.alert_high); const alertLow = n(o?.alert_low);
  const overridden = [actionHigh, actionLow, alertHigh, alertLow].some((v) => v != null);
  if (isParticle(channel)) {
    if (actionHigh == null) actionHigh = classLimit(isoClass, channel);
    if (alertHigh == null && actionHigh != null) alertHigh = (actionHigh * alertPct) / 100;
  }
  const none = actionHigh == null && actionLow == null && alertHigh == null && alertLow == null;
  return { alertLow, alertHigh, actionLow, actionHigh, source: none ? 'none' : overridden ? 'point' : 'class' };
}

export type Level = 'ok' | 'alert' | 'action';
export interface Breach { channel: Channel; level: 'alert' | 'action'; value: number; limit: number; side: 'high' | 'low' }

/** Judges one value against its limits: over an action limit is action, over only an alert limit is alert. */
export function judge(channel: Channel, value: number, l: ChannelLimits): Breach | null {
  if (l.actionHigh != null && value > l.actionHigh) return { channel, level: 'action', value, limit: l.actionHigh, side: 'high' };
  if (l.actionLow != null && value < l.actionLow) return { channel, level: 'action', value, limit: l.actionLow, side: 'low' };
  if (l.alertHigh != null && value > l.alertHigh) return { channel, level: 'alert', value, limit: l.alertHigh, side: 'high' };
  if (l.alertLow != null && value < l.alertLow) return { channel, level: 'alert', value, limit: l.alertLow, side: 'low' };
  return null;
}

export const worstLevel = (breaches: Breach[]): Level => (breaches.some((b) => b.level === 'action') ? 'action' : breaches.length ? 'alert' : 'ok');

const fmt = (v: number) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 100) / 100));
export const describeBreach = (b: Breach) => `${CHANNEL_LABEL[b.channel]} ${fmt(b.value)}${CHANNEL_UNIT[b.channel]} ${b.side === 'high' ? 'over' : 'under'} the ${b.level} limit of ${fmt(b.limit)}${CHANNEL_UNIT[b.channel]}`;
