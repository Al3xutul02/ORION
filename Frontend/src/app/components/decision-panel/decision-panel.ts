import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActionOption, distanceM, evaluateActions } from '../../core/geo';
import { DroneState, Recommendation, Zone, ZoneTactic } from '../../core/models';
import { OrionStore } from '../../core/orion-store.service';

export type DecisionTab = 'commands' | 'suggestions';

@Component({
  selector: 'app-decision-panel',
  imports: [DatePipe],
  templateUrl: './decision-panel.html',
  styleUrl: './decision-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DecisionPanel {
  protected store = inject(OrionStore);

  /** Active sub-tab: 'commands' (default) or 'suggestions'. */
  protected activeTab = signal<DecisionTab>('commands');

  /** Action awaiting the operator's second click in the Commands tab. */
  protected confirming = signal<ActionOption['id'] | null>(null);

  protected actions = computed(() => {
    const d = this.store.selectedDrone();
    return d ? evaluateActions(d, this.store.zones()) : [];
  });

  protected canCommand = computed(() => this.store.mode() === 'offline' || this.store.link() === 'online');

  protected history = computed(() => this.store.recommendations().filter(r => r.status !== 'PENDING'));

  protected pathType = signal<'SAFE' | 'RISKY'>('SAFE');
  protected patrolZones = computed(() => this.store.zones().filter(z => z.is_active && z.zone_type === 'PATROL'));
  protected selectedPatrolZoneId = signal<number | null>(null);
  protected pickedLoiterPoint = computed(() => this.store.pickedLoiterPoint());
  protected commandScope = this.store.commandScope;
  protected activeZoneId = signal<number | null>(null);
  protected activeZone = computed(() => {
    const pzs = this.patrolZones();
    const id = this.activeZoneId() ?? pzs[0]?.id;
    return pzs.find(z => z.id === id) ?? null;
  });
  protected executingTactic = signal<string | null>(null);



  protected setCommandScope(scope: 'drone' | 'zone'): void {
    this.store.setCommandScope(scope);
    this.confirming.set(null);
    this.executingTactic.set(null);
  }

  protected selectZone(id: number): void {
    this.activeZoneId.set(id);
    this.executingTactic.set(null);
  }

  protected zoneDrones(zoneId: number): DroneState[] {
    return this.store.drones().filter(d => (d.patrol_zone_id ?? 10) === zoneId || (zoneId === 100 && (d.patrol_zone_id === 100 || d.patrol_zone_id === 10)));
  }

  protected isZoneJammed(zoneId: number): boolean {
    const z = this.store.zones().find(zone => zone.id === zoneId);
    if (!z || !z.center || !z.radius_m) return false;
    const jammers = this.store.zones().filter(zone => zone.is_active && zone.zone_type === 'INTERFERENCE' && zone.center && zone.radius_m);
    return jammers.some(j => distanceM(z.center![0], z.center![1], j.center![0], j.center![1]) < (z.radius_m! + j.radius_m!));
  }

  protected zoneName(id: number): string | null {
    const z = this.store.zones().find(zone => zone.id === id);
    return z?.name ?? null;
  }

  protected executeTactic(zoneId: number, tactic: string): void {
    this.store.executeZoneTactic(zoneId, tactic);
    this.executingTactic.set(null);
  }

  protected setPathType(type: 'SAFE' | 'RISKY'): void {
    this.pathType.set(type);
  }

  protected setPatrolZone(id: number): void {
    this.selectedPatrolZoneId.set(id);
  }

  protected joinPatrol(droneId: number): void {
    const pzs = this.patrolZones();
    const selected = this.selectedPatrolZoneId();
    const zid = selected !== null && pzs.some(z => z.id === selected) ? selected : pzs[0]?.id;
    this.store.commandDrone(droneId, 'JOIN_PATROL', zid, undefined, this.pathType());
  }

  protected pickLoiter(): void {
    this.store.setMapMode('pick_loiter');
  }

  protected sendLoiter(droneId: number): void {
    const d = this.store.selectedDrone();
    const pt = this.pickedLoiterPoint() ?? (d ? [d.latitude, d.longitude] : [44.335, 23.83]);
    this.store.commandDrone(droneId, 'LOITER_AT', undefined, pt, this.pathType());
    this.store.setPickedLoiterPoint(null);
  }

  constructor() {
    // Switching drones cancels a half-finished confirmation and displays the commands tab.
    effect(() => {
      const id = this.store.selectedDroneId();
      this.confirming.set(null);
      if (id !== null) {
        this.activeTab.set('commands');
      }
    });
  }

  protected setTab(tab: DecisionTab): void {
    this.activeTab.set(tab);
  }

  protected send(a: ActionOption): void {
    const d = this.store.selectedDrone();
    if (!d) return;
    this.store.commandDrone(d.drone_id, a.id);
    this.confirming.set(null);
  }

  protected steps(rec: Recommendation): string[] {
    const text = rec.recommendation_details ?? '';
    const parts = text.split(/\s*\d+\.\s+/).map(s => s.trim()).filter(Boolean);
    return parts.length ? parts : [text];
  }

  protected pretty(action: string): string {
    return action.replaceAll('_', ' ').toLowerCase();
  }

  protected eventLabel(event: string): string {
    const ev = (event || '').toUpperCase();
    if (ev.includes('RECALIBRAT') || ev.includes('SAFE')) {
      return 'Recalibrated';
    }
    if (ev.includes('SPOOF')) {
      return 'GPS Spoofed';
    }
    if (ev.includes('PATROL_ZONE_JAMMED') || ev.includes('JAMMED')) {
      return 'EW Jammed';
    }
    if (ev.includes('EW_HAZARD') || ev.includes('HAZARD')) {
      return 'EW Hazard';
    }
    if (ev.includes('NO_CORRIDOR')) {
      return 'Hazard Area';
    }
    if (ev.includes('WEATHER')) {
      return 'Severe Weather';
    }
    return event ? event.replaceAll('_', ' ') : 'Alert';
  }

  protected eventLevel(event: string): 'green' | 'yellow' | 'red' {
    const ev = (event || '').toUpperCase();
    if (ev.includes('SAFE') || ev.includes('RECALIBRAT')) return 'green';
    if (ev.includes('SPOOF') || ev.includes('WEATHER')) return 'yellow';
    return 'red';
  }

  protected recReason(rec: Recommendation): string {
    if (rec.reason) return rec.reason;
    if (rec.trigger_event === 'PATROL_ZONE_JAMMED' || rec.recommended_action === 'SECTOR_ORBIT_SHIFT') {
      return 'Active electronic warfare jamming intersects the patrol zone, compromising drone GPS and C2 navigation. Action needed: Shift swarm orbit to unjammed sector to restore clean communications while maintaining continuous surveillance.';
    }
    if (rec.trigger_event === 'SENSORS_RECALIBRATED_SAFE' || rec.recommended_action === 'CONTINUE_PATROL') {
      return 'Sensor recalibration complete and verified in clean airspace. Action needed: Drone is holding idle in loiter; operator command is required to resume regular sector patrol.';
    }
    if (rec.trigger_event === 'SPOOFING_ATTACK_DETECTED' || rec.recommended_action === 'LOITER') {
      return 'Adversary GPS spoofing detected (sudden ephemeris jump). Action needed: Continuing patrol with corrupted GPS coordinates will drive the drone off course into danger; immediate LOITER is required to hold position and stabilize onboard EKF/IMU.';
    }
    if (rec.recommended_action.includes('CORRIDOR')) {
      return rec.blocked_reason
        ? `Hostile electronic warfare hazard active (${rec.blocked_reason}). Action needed: Direct flight path is compromised; drone must divert through Safe Corridor to prevent complete C2 link loss.`
        : 'Hostile interference active in sector. Action needed: Drone must divert through verified Safe Corridor to maintain link.';
    }
    if (rec.recommended_action === 'SAFE_ROUTE_RETREAT') {
      return `Direct path to Base is blocked (${rec.blocked_reason || 'hazard zone'}). Action needed: Drone must navigate around threats via computed A* safe waypoints to reach Base.`;
    }
    if (rec.recommended_action === 'RETURN_TO_HOME') {
      return 'Sensor confidence degraded or operating limits exceeded. Action needed: Return-to-base along clear corridor is required to protect the airframe.';
    }
    return rec.blocked_reason
      ? `Operating hazard detected: ${rec.blocked_reason}. Action needed: Tactical intervention required to safeguard the airframe.`
      : 'Action needed: Tactical safety procedure required by ORION rules engine.';
  }
}
