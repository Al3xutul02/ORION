import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { verifyChain, HashChainLedger } from './core/hash-chain';
import { evaluateActions } from './core/geo';
import { DroneState, Zone } from './core/models';

describe('App', () => {
  beforeEach(async () => {
    localStorage.setItem('orion.mode', 'offline');
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideHttpClient(), provideRouter([])],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should render the ORION command bar', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.brand .name')?.textContent).toContain('ORION');
  });
});

describe('hash chain', () => {
  it('verifies an untouched ledger and detects tampering', async () => {
    const ledger = new HashChainLedger();
    await ledger.append('A', null, { x: 1 });
    await ledger.append('B', 2, { nested: { b: 1, a: 2 } });
    await ledger.append('C', null, { y: 'z' });
    expect((await verifyChain(ledger.events)).is_valid).toBeTrue();

    ledger.tamper(1);
    const result = await verifyChain(ledger.events);
    expect(result.is_valid).toBeFalse();
    expect(result.broken_at_index).toBe(1);
  });
});

describe('theatre rules', () => {
  const zones: Zone[] = [
    { id: 2, name: 'Safe Corridor Alpha', zone_type: 'SAFE_CORRIDOR', geometry_type: 'POLYGON', waypoints: [[44.316, 23.8], [44.338, 23.815]], is_active: true, detected_by: 'PRECONFIGURED' },
    { id: 3, name: 'EW Jamming Zone Sector 4', zone_type: 'INTERFERENCE', geometry_type: 'CIRCLE', center: [44.328, 23.82], radius_m: 600, is_active: true, detected_by: 'PRECONFIGURED' },
  ];
  const drone = (lat: number, lon: number): DroneState => ({
    drone_id: 2, latitude: lat, longitude: lon, altitude: 120, ground_speed: 12, heading: 0, fix_type: 2,
    satellites_visible: 4, eph: 4.2, battery_remaining: 90, drop_rate_comm: 0.5, rssi: 95, flight_mode: 'GUIDED',
    is_armed: true, trust_score: 30, trust_status: 'RED', uncertainty_radius_m: 120, reason: '', last_updated: '',
  });

  it('blocks RTL when the direct path crosses an interference zone and recommends the corridor', () => {
    const actions = evaluateActions(drone(44.342, 23.836), zones);
    const rtl = actions.find(a => a.id === 'RETURN_TO_HOME')!;
    expect(rtl.allowed).toBeFalse();
    expect(actions.find(a => a.id === 'SAFE_CORRIDOR_RETREAT')!.recommended).toBeTrue();
  });

  it('stops recommending once the drone is already retreating safely, and flags unsafe patrol', () => {
    const retreating = evaluateActions({ ...drone(44.342, 23.836), flight_mode: 'CORRIDOR' }, zones);
    expect(retreating.find(a => a.id === 'SAFE_CORRIDOR_RETREAT')!.active).toBeTrue();
    expect(retreating.some(a => a.recommended)).toBeFalse();

    const patrolling = evaluateActions(drone(44.342, 23.836), zones).find(a => a.id === 'CONTINUE_PATROL')!;
    expect(patrolling.active).toBeTrue();
    expect(patrolling.allowed).toBeFalse();
  });

  it('allows RTL when the path is clear', () => {
    const rtl = evaluateActions(drone(44.316, 23.79), zones).find(a => a.id === 'RETURN_TO_HOME')!;
    expect(rtl.allowed).toBeTrue();
  });
});
