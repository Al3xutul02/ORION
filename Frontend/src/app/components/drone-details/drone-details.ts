import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { ORION_CONFIG } from '../../core/config';
import { describeRoute, distanceM, evaluateActions, safeRoute, segmentIntersectsCircle, weatherAt } from '../../core/geo';
import { DroneState } from '../../core/models';
import { OrionStore, summarise } from '../../core/orion-store.service';
import { PLATFORM, describeWeather, isSevereWeather, isWeather, weatherEffects } from '../../core/platform';
import { MESH_RANGE_M } from '../../core/mesh';

const FIX_LABEL: Record<number, string> = { 0: 'No fix', 1: 'No fix', 2: '2D', 3: '3D' };

/** Keep this much more battery than the trip home needs. */
const RESERVE_FACTOR = 1.3;

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
  protected meshRangeKm = MESH_RANGE_M / 1000;
  protected drone = this.store.detailsDrone;

  protected baseDistanceKm = computed(() => {
    const d = this.drone();
    const base = ORION_CONFIG.homeBase;
    return d ? distanceM(d.latitude, d.longitude, base.lat, base.lon) / 1000 : 0;
  });

  /** Remaining flight time if the battery drains linearly over the profile's endurance. */
  protected enduranceLeftMin = computed(() => ((this.drone()?.battery_remaining ?? 0) / 100) * PLATFORM.enduranceMin);

  protected weatherHere = computed(() => {
    const d = this.drone();
    const wx = d ? weatherAt(this.store.zones(), d.latitude, d.longitude) : undefined;
    if (!wx) return null;
    const fx = weatherEffects(wx);
    return {
      zone: wx,
      text: `${wx.name}: ${describeWeather(wx)}`,
      severe: isSevereWeather(wx),
      effects: `Link fade ${fx.rssiLoss ? `−${fx.rssiLoss} RSSI, +${fx.dropAdd}% loss` : 'none'} · battery drain ×${fx.batteryMult}`,
    };
  });

  /** The way home (direct, or the A* route when RTL is blocked) as [lat, lon] points. */
  protected routeHome = computed(() => {
    const d = this.drone();
    if (!d) return null;
    const base = ORION_CONFIG.homeBase;
    const rtl = evaluateActions(d, this.store.zones()).find(a => a.id === 'RETURN_TO_HOME')!;
    if (rtl.allowed) {
      return {
        blocked: false, why: null, text: `Direct path is clear · ${this.baseDistanceKm().toFixed(1)} km`,
        lengthM: this.baseDistanceKm() * 1000,
        points: [[d.latitude, d.longitude], [base.lat, base.lon]] as [number, number][],
      };
    }
    const route = safeRoute(d, this.store.zones());
    return route
      ? { blocked: true, why: rtl.reason, text: `A* route: ${describeRoute(route)}`, lengthM: route.lengthM, points: route.waypoints }
      : { blocked: true, why: rtl.reason, text: 'No safe route around the active zones: hold position', lengthM: null, points: [] };
  });

  /**
   * Can it still make it home? Estimate, assuming the worst wind met on the way blows head-on
   * (so the drone makes 60% of that wind less headway).
   */
  protected reserve = computed(() => {
    const r = this.routeHome();
    if (!r || r.lengthM === null) return null;
    const winds = this.store.zones()
      .filter(z => z.is_active && isWeather(z) && z.center && z.radius_m)
      .filter(z => r.points.some((p, i) =>
        i > 0 && segmentIntersectsCircle(r.points[i - 1][0], r.points[i - 1][1], p[0], p[1], z.center![0], z.center![1], z.radius_m!)))
      .map(z => z.wind_ms ?? 0);
    const headwind = Math.max(0, ...winds);
    const speed = Math.max(6, PLATFORM.egressSpeedMs - 0.6 * headwind);
    const neededMin = r.lengthM / speed / 60;
    const availableMin = this.enduranceLeftMin();
    return { neededMin, availableMin, headwind, speed, ok: availableMin >= neededMin * RESERVE_FACTOR };
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
      {
        label: 'Peers', value: s.consensus_score,
        how: d.mesh?.score != null
          ? 'Drone-to-drone mesh: neighbours measure their distance to it by radio and check it against the GPS positions.'
          : 'No drone in mesh range: the ground station compares it with the rest of the fleet instead.',
      },
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

  protected meshStatus(status: string): string {
    return ({
      TRUSTED: 'Agrees with the mesh majority',
      OUTLIER: 'Outvoted: its GPS contradicts the radio ranges',
      DISPUTED: 'Disputed: neighbours disagree, no majority',
      ALONE: 'No drone in mesh range',
    } as Record<string, string>)[status] ?? status;
  }
}
