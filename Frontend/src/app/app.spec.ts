import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { verifyChain, HashChainLedger } from './core/hash-chain';
import { evaluateActions } from './core/geo';
import { DroneState, Zone } from './core/models';
import { OrionStore } from './core/orion-store.service';

describe('App', () => {
  beforeEach(async () => {
    sessionStorage.clear();
    localStorage.setItem('orion.mode', 'offline');
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideHttpClient(), provideRouter([])],
    }).compileComponents();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should render the login page when no user is logged in', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.login-card')).toBeTruthy();
    expect(compiled.querySelector('h1')?.textContent).toContain('ORION GCS');
  });

  it('should render the command bar when an authenticated session is active', () => {
    sessionStorage.setItem('orion.user', JSON.stringify({
      username: 'operator_demo',
      role: 'OPERATOR',
      displayName: 'Operator Demo'
    }));
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.login-card')).toBeFalsy();
    expect(compiled.querySelector('.brand .name')?.textContent).toContain('ORION');
    expect(compiled.querySelector('.user-pill')?.textContent).toContain('operator_demo');
  });
});

describe('Authentication & Authorization Store', () => {
  let store: OrionStore;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient()],
    });
    store = TestBed.inject(OrionStore);
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it('authenticates operator_demo with correct credentials and role', async () => {
    const res = await store.login('operator_demo', '123');
    expect(res.ok).toBeTrue();
    expect(store.currentUser()?.username).toBe('operator_demo');
    expect(store.currentUser()?.role).toBe('OPERATOR');
    expect(store.isOperator()).toBeTrue();
    expect(store.isCommander()).toBeFalse();
  });

  it('authenticates commander_demo with correct credentials and role', async () => {
    const res = await store.login('commander_demo', '123');
    expect(res.ok).toBeTrue();
    expect(store.currentUser()?.username).toBe('commander_demo');
    expect(store.currentUser()?.role).toBe('COMMANDER');
    expect(store.isOperator()).toBeFalse();
    expect(store.isCommander()).toBeTrue();
  });

  it('rejects invalid password', async () => {
    const res = await store.login('operator_demo', 'wrong');
    expect(res.ok).toBeFalse();
    expect(store.currentUser()).toBeNull();
  });

  it('clears session on logout', async () => {
    await store.login('operator_demo', '123');
    expect(store.currentUser()).toBeTruthy();
    store.logout();
    expect(store.currentUser()).toBeNull();
    expect(sessionStorage.getItem('orion.user')).toBeNull();
  });

  it('allows Operator to move a patrol zone and updates zone center', async () => {
    await store.login('operator_demo', '123');
    store.setMode('offline');
    const pz = store.zones().find(z => z.zone_type === 'PATROL');
    expect(pz).toBeTruthy();
    const targetZoneId = pz!.id;
    const newCenter: [number, number] = [44.345, 23.845];
    await store.movePatrolZone(targetZoneId, newCenter);
    const updated = store.zones().find(z => z.id === targetZoneId);
    expect(updated?.center).toEqual(newCenter);
  });

  it('prevents Commander from moving a patrol zone', async () => {
    await store.login('commander_demo', '123');
    store.setMode('offline');
    const pz = store.zones().find(z => z.zone_type === 'PATROL');
    expect(pz).toBeTruthy();
    const oldCenter = [...pz!.center!] as [number, number];
    await store.movePatrolZone(pz!.id, [44.35, 23.85]);
    const unchanged = store.zones().find(z => z.id === pz!.id);
    expect(unchanged?.center).toEqual(oldCenter);
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
