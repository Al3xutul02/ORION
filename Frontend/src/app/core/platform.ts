import { WeatherKind, Zone } from './models';

/**
 * The simulated drones have no airframe of their own; this is the profile both simulators
 * assume. Shown as such in the UI, so nobody mistakes it for a spec sheet.
 */
export const PLATFORM = {
  type: 'Multirotor patrol UAS',
  patrolSpeedMs: 12,
  egressSpeedMs: 22,
  enduranceMin: 45,
  /** Above this sustained wind the drone can't hold position or make headway. */
  maxWindMs: 12,
  sensors: 'GNSS receiver · INS (IMU) · EO/IR camera',
  datalink: 'MAVLink 2, signed commands (HMAC-SHA256)',
};

// Weather hazards. Mirrors Backend/app/services/weather.py; keep the two in step.

export const WEATHER_TEMPLATES: Record<WeatherKind, Pick<Zone, 'name' | 'wind_ms' | 'rain' | 'radius_m'>> = {
  STORM: { name: 'Storm cell', wind_ms: 18, rain: 'HEAVY', radius_m: 650 },
  RAIN: { name: 'Heavy rain band', wind_ms: 7, rain: 'HEAVY', radius_m: 750 },
  WIND: { name: 'Strong wind corridor', wind_ms: 15, rain: 'NONE', radius_m: 800 },
};

export function isWeather(z: Zone): boolean {
  return z.zone_type === 'WEATHER';
}

/** Beyond what the platform can fly in: treated like a hazard zone. */
export function isSevereWeather(z: Zone): boolean {
  return isWeather(z) && (z.wind_ms ?? 0) > PLATFORM.maxWindMs;
}

export function describeWeather(z: Zone): string {
  const parts = [`wind ${Math.round(z.wind_ms ?? 0)} m/s`];
  if (z.rain && z.rain !== 'NONE') parts.push(`${z.rain.toLowerCase()} rain`);
  if (isSevereWeather(z)) parts.push(`above the ${PLATFORM.maxWindMs} m/s limit`);
  return parts.join(', ');
}

export interface WeatherEffects {
  dropAdd: number;
  rssiLoss: number;
  ephAdd: number;
  batteryMult: number;
}

/** How the weather at the drone's position changes its telemetry. */
export function weatherEffects(z: Zone | null | undefined): WeatherEffects {
  if (!z) return { dropAdd: 0, rssiLoss: 0, ephAdd: 0, batteryMult: 1 };
  const wind = z.wind_ms ?? 0;
  const rain = z.rain ?? 'NONE';
  return {
    dropAdd: { NONE: 0, MODERATE: 6, HEAVY: 14 }[rain],
    rssiLoss: { NONE: 0, MODERATE: 12, HEAVY: 28 }[rain],
    ephAdd: Math.round(Math.min(1.5, wind / 12) * 100) / 100,
    batteryMult: Math.round((1 + Math.min(1, wind / 15)) * 100) / 100,
  };
}
