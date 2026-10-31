import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { ORION_CONFIG } from '../../core/config';
import { describeRoute, distanceM, evaluateActions, safeRoute } from '../../core/geo';
import { DroneState } from '../../core/models';
import { OrionStore, summarise } from '../../core/orion-store.service';

/**
 * The simulated drones have no airframe of their own; this is the profile the simulators
 * assume (egress speed, sensors, datalink). Shown as such, so nobody mistakes it for a spec sheet.
 */
const PLATFORM = {
  type: 'Multirotor patrol UAS',
  patrolSpeedMs: 12,
  egressSpeedMs: 22,
  enduranceMin: 45,
  sensors: 'GNSS receiver · INS (IMU) · EO/IR camera',
  datalink: 'MAVLink 2, signed commands (HMAC-SHA256)',
};

const FIX_LABEL: Record<number, string> = { 0: 'No fix', 1: 'No fix', 2: '2D', 3: '3D' };

interface Signal {
  label: string;
  value: number;
  how: string;
}

@Component({
  selector: 'app-drone-details',
  imports: [DatePipe, DecimalPipe],
  templateUrl: './drone-details.html',
  styleUrl: './drone-details.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DroneDetails {
  protected store = inject(OrionStore);
  protected platform = PLATFORM;
  protected drone = this.store.detailsDrone;

  protected baseDistanceKm = computed(() => {
    const d = this.drone();
    const base = ORION_CONFIG.homeBase;
    return d ? distanceM(d.latitude, d.longitude, base.lat, base.lon) / 1000 : 0;
  });

  /** Remaining flight time if the battery drains linearly over the profile's endurance. */
  protected enduranceLeftMin = computed(() => Math.round(((this.drone()?.battery_remaining ?? 0) / 100) * PLATFORM.enduranceMin));

  protected routeHome = computed(() => {
    const d = this.drone();
    if (!d) return null;
    const rtl = evaluateActions(d, this.store.zones()).find(a => a.id === 'RETURN_TO_HOME')!;
    if (rtl.allowed) {
      const km = this.baseDistanceKm();
      return { blocked: false, text: `Direct path is clear · ${km.toFixed(1)} km`, etaMin: (km * 1000) / PLATFORM.egressSpeedMs / 60 };
    }
    const route = safeRoute(d, this.store.zones());
    return route
      ? { blocked: true, text: `A* route: ${describeRoute(route)}`, etaMin: route.lengthM / PLATFORM.egressSpeedMs / 60, why: rtl.reason }
      : { blocked: true, text: 'No safe route around the active zones: hold position', etaMin: null, why: rtl.reason };
  });

  protected recentEvents = computed(() => {
    const id = this.drone()?.drone_id;
    return this.store.events().filter(e => e.drone_id === id).slice(-6).reverse();
  });

  protected signals(d: DroneState): Signal[] {
    const s = d.scores;
    if (!s) return [];
    return [
      { label: 'GPS', value: s.gps_score, how: 'Drops with a 2D or no fix, under 9 satellites, or EPH above 2–3 m.' },
      { label: 'INS', value: s.imu_score, how: 'Drops when the drone "moves" faster than physically possible (above ~25 m/s): a false position.' },
      { label: 'Link', value: s.link_score, how: 'Drops above 20% packet loss or with RSSI under 40.' },
      { label: 'Peers', value: s.consensus_score, how: 'Ground station compares the fleet: drops when this drone diverges from its neighbours after a suspicious jump.' },
    ];
  }

  protected level(v: number): string {
    return v >= 75 ? 'GREEN' : v >= 40 ? 'YELLOW' : 'RED';
  }

  protected fixLabel(fix: number): string {
    return FIX_LABEL[fix] ?? `${fix}`;
  }

  protected reasons(d: DroneState): string[] {
    return d.reason.split(';').map(r => r.trim()).filter(Boolean);
  }

  protected summary = summarise;
}
