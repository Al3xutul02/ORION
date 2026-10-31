import {
  ChangeDetectionStrategy, Component, ElementRef, OnDestroy, afterNextRender, computed, effect, inject, signal, viewChild,
} from '@angular/core';
import maplibregl, { GeoJSONSource, Map as MlMap, Marker, StyleSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import { circleRing, distanceM, egressPaths, evaluateActions, weatherPolygon } from '../../core/geo';
import { DroneState, Zone } from '../../core/models';
import { OrionStore } from '../../core/orion-store.service';
import { DroneDetails } from '../drone-details/drone-details';
import { describeWeather } from '../../core/platform';

const ZONE_COLORS: Record<string, string> = {
  BASE: '#5cc8ff',
  SAFE_CORRIDOR: '#3ddc84',
  INTERFERENCE: '#ff9f43',
  THREAT: '#ff5463',
  WEATHER: '#b48cff',
  PATROL: '#00d4ff',
};
const STATUS_COLORS: Record<string, string> = { GREEN: '#3ddc84', YELLOW: '#f5c542', RED: '#ff5463' };

// Real basemap (OpenStreetMap data via OpenFreeMap, no API key). The zones drawn on top are a
// training exercise, not real data.
const REAL_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
const REAL_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

// Offline fallback: a plain grid, so the demo still works without internet.
const GRID_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0d141c' } }],
};

export type Basemap = 'real' | 'grid';

// Base in the south-west, patrol sectors and threat zone in the north-east.
const THEATRE_BOUNDS: [[number, number], [number, number]] = [[23.794, 44.312], [23.866, 44.354]];

const empty = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] });

@Component({
  selector: 'app-theatre-map',
  imports: [DroneDetails],
  templateUrl: './theatre-map.html',
  styleUrl: './theatre-map.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TheatreMap implements OnDestroy {
  protected store = inject(OrionStore);
  private host = viewChild.required<ElementRef<HTMLDivElement>>('map');
  private map: MlMap | null = null;
  protected basemap = signal<Basemap>('grid');
  private ready = false;
  private resizeObserver: ResizeObserver | null = null;
  private droneMarkers = new Map<number, Marker>();
  private zoneLabels = new Map<number, Marker>();
  private loiterMarker: Marker | null = null;
  private isDrawingZone = false;
  private drawCenter: [number, number] | null = null;
  protected corridorPoints: [number, number][] = [];

  constructor() {
    afterNextRender(() => this.init());

    // The details panel covers the left of the map: shift the theatre right while it's open.
    effect(() => {
      const open = this.detailsOpen();
      if (this.map) this.map.fitBounds(THEATRE_BOUNDS, { padding: this.fitPadding(open), duration: 500 });
    });

    effect(() => {
      const zones = this.store.zones();
      if (this.ready) this.renderZones(zones);
    });

    effect(() => {
      const drones = this.store.drones();
      const zones = this.store.zones();
      const selected = this.store.selectedDroneId();
      if (this.ready) this.renderDrones(drones, zones, selected);
    });

    effect(() => {
      const pt = this.store.pickedLoiterPoint();
      if (this.ready) this.renderLoiterTarget(pt);
    });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.map?.remove();
  }

  private detailsOpen = computed(() => this.store.detailsDroneId() !== null);

  private fitPadding(open = this.detailsOpen()) {
    // Keep at least ~240 px of map visible to the right of the panel.
    const width = this.map?.getContainer().clientWidth ?? 0;
    const left = open && width > 560 ? Math.min(370, width - 240) : 40;
    return { top: 40, right: 30, bottom: 40, left };
  }

  protected recenter(): void {
    this.map?.fitBounds(THEATRE_BOUNDS, { padding: this.fitPadding(), duration: 600 });
  }

  protected setBasemap(kind: Basemap): void {
    if (kind === this.basemap()) return;
    try { localStorage.setItem('orion.basemap', kind); } catch { /* storage unavailable */ }
    this.applyBasemap(kind);
  }

  private async applyBasemap(kind: Basemap): Promise<void> {
    let style = GRID_STYLE;
    if (kind === 'real') {
      const real = await loadRealStyle();
      if (real) {
        style = real;
      } else {
        kind = 'grid';
        this.store.pushToast('info', 'Real map unavailable', 'Could not load map tiles (no internet?). Showing the offline grid.');
      }
    }
    this.basemap.set(kind);
    // Overlay sources disappear with the old style; pause rendering until they are re-added.
    this.ready = false;
    this.map?.setStyle(style, { diff: false });
  }

  private init(): void {
    const map = new maplibregl.Map({
      container: this.host().nativeElement,
      style: GRID_STYLE,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      bounds: THEATRE_BOUNDS,
      fitBoundsOptions: { padding: 40 },
    });
    this.map = map;
    // Keep the whole theatre in view when the panel resizes, until the operator pans or zooms.
    let userMoved = false;
    map.on('movestart', (e: { originalEvent?: Event }) => { if (e.originalEvent) userMoved = true; });
    this.resizeObserver = new ResizeObserver(() => {
      map.resize();
      if (!userMoved) map.fitBounds(THEATRE_BOUNDS, { padding: this.fitPadding(), duration: 0 });
    });
    this.resizeObserver.observe(this.host().nativeElement);
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    this.setupInteractions(map);

    // Overlays are wiped by every setStyle, so they are (re)added on each style load.
    map.on('style.load', () => this.addOverlays());
    this.applyBasemap(this.savedBasemap());
  }

  private addOverlays(): void {
    const map = this.map!;
    const real = this.basemap() === 'real';
    map.addSource('grid', { type: 'geojson', data: gridLines() });
    map.addLayer({
      id: 'grid', type: 'line', source: 'grid',
      paint: { 'line-color': real ? '#5cc8ff' : '#1a2633', 'line-width': 1, 'line-opacity': real ? 0.07 : 1 },
    });

    map.addSource('zones', { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'zones-fill', type: 'fill', source: 'zones',
      filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['!=', ['get', 'zone_type'], 'PATROL']],
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['==', ['get', 'is_core'], true], 0.32, ['==', ['get', 'dynamic'], true], 0.2, 0.12] },
    });
    map.addLayer({
      id: 'zones-outline', type: 'line', source: 'zones', filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-dasharray': [3, 2], 'line-opacity': 0.8 },
    });
    map.addLayer({
      id: 'corridor', type: 'line', source: 'zones', filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ZONE_COLORS['SAFE_CORRIDOR'], 'line-width': 14, 'line-opacity': 0.14 },
    });
    map.addLayer({
      id: 'corridor-center', type: 'line', source: 'zones', filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': ZONE_COLORS['SAFE_CORRIDOR'], 'line-width': 1.5, 'line-dasharray': [1, 2] },
    });

    map.addSource('uncertainty', { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'uncertainty-fill', type: 'fill', source: 'uncertainty',
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.1 },
    });
    map.addLayer({
      id: 'uncertainty-line', type: 'line', source: 'uncertainty',
      paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.7 },
    });

    map.addSource('paths', { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'paths', type: 'line', source: 'paths',
      layout: { 'line-cap': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['case', ['==', ['get', 'kind'], 'blocked'], 2.5, 3],
        'line-dasharray': ['match', ['get', 'kind'], 'blocked', ['literal', [2, 2]], 'route', ['literal', [3, 1.5]], ['literal', [1, 0]]],
      },
    });

    // Drone-to-drone mesh links: green where GPS agrees with the radio range, red where it doesn't.
    map.addSource('mesh', { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'mesh', type: 'line', source: 'mesh',
      paint: {
        'line-color': ['case', ['get', 'consistent'], '#3ddc84', '#ff5463'],
        'line-width': ['case', ['get', 'consistent'], 1, 1.8],
        'line-opacity': ['case', ['get', 'consistent'], 0.35, 0.85],
        'line-dasharray': ['case', ['get', 'consistent'], ['literal', [1, 0]], ['literal', [2, 1.5]]],
      },
    });

    map.addSource('trails', { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'trails', type: 'line', source: 'trails',
      paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.35 },
    });

    map.addSource('preview-zone', { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'preview-zone-fill', type: 'fill', source: 'preview-zone',
      paint: { 'fill-color': ['coalesce', ['get', 'color'], '#00d4ff'], 'fill-opacity': ['coalesce', ['get', 'opacity'], 0] },
    });
    map.addLayer({
      id: 'preview-zone-line', type: 'line', source: 'preview-zone',
      paint: { 'line-color': ['coalesce', ['get', 'color'], '#00d4ff'], 'line-width': 2, 'line-dasharray': [3, 2] },
    });

    map.addSource('preview-corridor', { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'preview-corridor-line', type: 'line', source: 'preview-corridor',
      paint: { 'line-color': '#3ddc84', 'line-width': 16, 'line-opacity': 0.22 },
    });
    map.addLayer({
      id: 'preview-corridor-core', type: 'line', source: 'preview-corridor',
      paint: { 'line-color': '#3ddc84', 'line-width': 2, 'line-dasharray': [4, 3] },
    });

    this.ready = true;
    this.renderZones(this.store.zones());
    this.renderDrones(this.store.drones(), this.store.zones(), this.store.selectedDroneId());
  }

  /** One line per pair of drones that hear each other, drawn between their reported positions. */
  private updateMesh(drones: DroneState[]): void {
    const pos = new Map(drones.map(d => [d.drone_id, [d.longitude, d.latitude] as [number, number]]));
    const features: Feature[] = [];
    for (const d of drones) {
      for (const l of d.mesh?.links ?? []) {
        const peer = pos.get(l.peer_id);
        if (!peer || l.peer_id < d.drone_id) continue; // each pair once
        features.push({
          type: 'Feature',
          properties: { consistent: l.consistent },
          geometry: { type: 'LineString', coordinates: [pos.get(d.drone_id)!, peer] },
        });
      }
    }
    (this.map!.getSource('mesh') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
  }

  private savedBasemap(): Basemap {
    try { return localStorage.getItem('orion.basemap') === 'grid' ? 'grid' : 'real'; } catch { return 'real'; }
  }

  private renderZones(zones: Zone[]): void {
    const map = this.map!;
    const features: Feature[] = [];
    for (const z of zones) {
      if (!z.is_active) continue;
      const props = { id: z.id, name: z.name, zone_type: z.zone_type, color: ZONE_COLORS[z.zone_type] ?? '#888', dynamic: z.zone_type === 'INTERFERENCE' && z.detected_by === 'ORION_CONSENSUS' };
      if (z.geometry_type === 'CIRCLE' && z.center && z.radius_m) {
        if (z.zone_type === 'WEATHER') {
          const kind = z.weather ?? 'STORM';
          const outerRing = weatherPolygon(z.center[0], z.center[1], z.radius_m, kind, z.id);
          features.push({
            type: 'Feature',
            properties: { ...props, is_weather: true, is_core: false },
            geometry: { type: 'Polygon', coordinates: [outerRing] },
          });
          const coreRing = weatherPolygon(z.center[0], z.center[1], z.radius_m * 0.48, kind, z.id);
          features.push({
            type: 'Feature',
            properties: { ...props, is_weather: true, is_core: true, color: '#cfa9ff' },
            geometry: { type: 'Polygon', coordinates: [coreRing] },
          });
        } else {
          features.push({
            type: 'Feature',
            properties: props,
            geometry: { type: 'Polygon', coordinates: [circleRing(z.center[0], z.center[1], z.radius_m)] },
          });
        }
      } else {
        features.push({
          type: 'Feature',
          properties: props,
          geometry: { type: 'LineString', coordinates: (z.waypoints ?? []).map(([la, lo]) => [lo, la]) },
        });
      }
    }
    (map.getSource('zones') as GeoJSONSource).setData({ type: 'FeatureCollection', features });

    const seen = new Set<number>();
    let patrolIndex = 0;
    for (const z of zones) {
      if (!z.is_active) continue;

      let anchorLngLat: [number, number];
      let anchorPos: 'center' | 'bottom' | 'left' = 'center';
      let offset: [number, number] = [0, -10];

      if (z.zone_type === 'PATROL' && z.center && z.radius_m) {
        // Distribute label angle along northern arc to prevent collisions between concentric or nested zones
        const angles = [90, 125, 55, 155, 25]; // 90=N, >90=NW, <90=NE
        const angleDeg = angles[patrolIndex % angles.length];
        patrolIndex++;
        const angleRad = (angleDeg * Math.PI) / 180.0;
        const cosLat = Math.cos((z.center[0] * Math.PI) / 180.0);
        const dLat = (z.radius_m * Math.sin(angleRad)) / 111139.0;
        const dLon = (z.radius_m * Math.cos(angleRad)) / (111139.0 * cosLat);
        anchorLngLat = [z.center[1] + dLon, z.center[0] + dLat];
        anchorPos = 'bottom';
        offset = [0, -4];
      } else if (z.zone_type === 'SAFE_CORRIDOR' && z.waypoints?.length) {
        const mid = z.waypoints[Math.floor((z.waypoints.length - 1) / 2)];
        anchorLngLat = [mid[1], mid[0]];
        anchorPos = 'left';
        offset = [14, 0];
      } else if (z.center) {
        anchorLngLat = [z.center[1], z.center[0]];
        anchorPos = 'center';
        offset = [0, -12];
      } else {
        continue;
      }

      seen.add(z.id);
      const existing = this.zoneLabels.get(z.id);
      if (existing) {
        existing.setLngLat(anchorLngLat);
        continue;
      }
      const el = document.createElement('div');
      el.className = `zone-label zone-${z.zone_type}`;
      if (z.zone_type === 'PATROL') {
        el.innerHTML = `<span class="patrol-icon">&#8853;</span><span>${escapeHtml(z.name)}</span>`;
      } else {
        const sub = z.zone_type === 'WEATHER' ? describeWeather(z) : (z.zone_type === 'INTERFERENCE' && z.detected_by === 'ORION_CONSENSUS') ? 'detected by ORION' : '';
        el.innerHTML = `<span>${escapeHtml(z.name)}</span>${sub ? `<em>${escapeHtml(sub)}</em>` : ''}`;
      }
      const marker = new maplibregl.Marker({ element: el, anchor: anchorPos, offset })
        .setLngLat(anchorLngLat)
        .addTo(map);
      this.zoneLabels.set(z.id, marker);
    }
    for (const [id, m] of this.zoneLabels) {
      if (!seen.has(id)) { m.remove(); this.zoneLabels.delete(id); }
    }
  }

  private renderDrones(drones: DroneState[], zones: Zone[], selected: number | null): void {
    const map = this.map!;
    (map.getSource('uncertainty') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: drones.filter(d => d.uncertainty_radius_m > 0).map(d => ({
        type: 'Feature',
        properties: { color: STATUS_COLORS[d.trust_status] },
        geometry: { type: 'Polygon', coordinates: [circleRing(d.latitude, d.longitude, d.uncertainty_radius_m)] },
      })),
    });

    // Egress overlay for the selected drone once it is no longer trusted.
    const sel = drones.find(d => d.drone_id === selected);
    const pathFeatures: Feature[] = [];
    if (sel && sel.trust_status !== 'GREEN' && sel.is_armed) {
      const rtl = evaluateActions(sel, zones).find(a => a.id === 'RETURN_TO_HOME')!;
      const { direct, viaCorridor, viaRoute } = egressPaths(sel, zones);
      pathFeatures.push({
        type: 'Feature',
        properties: { kind: rtl.allowed ? 'ok' : 'blocked', color: rtl.allowed ? '#3ddc84' : '#ff5463' },
        geometry: { type: 'LineString', coordinates: direct },
      });
      if (!rtl.allowed && viaCorridor.length) {
        pathFeatures.push({
          type: 'Feature', properties: { kind: 'ok', color: '#3ddc84' },
          geometry: { type: 'LineString', coordinates: viaCorridor },
        });
      }
      // A* route around every active zone, for when no corridor is clear (or to compare).
      if (!rtl.allowed && viaRoute.length) {
        pathFeatures.push({
          type: 'Feature', properties: { kind: 'route', color: '#5cc8ff' },
          geometry: { type: 'LineString', coordinates: viaRoute },
        });
      }
    }
    (map.getSource('paths') as GeoJSONSource).setData({ type: 'FeatureCollection', features: pathFeatures });

    this.updateTrails(drones);
    this.updateMesh(drones);

    const seen = new Set<number>();
    for (const d of drones) {
      seen.add(d.drone_id);
      let marker = this.droneMarkers.get(d.drone_id);
      if (!marker) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'drone-marker';
        el.addEventListener('click', ev => {
          ev.stopPropagation();
          this.store.openDetails(d.drone_id);
        });
        marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([d.longitude, d.latitude]).addTo(map);
        this.droneMarkers.set(d.drone_id, marker);
      }
      const el = marker.getElement();
      // Preserve MapLibre's internal positioning classes (maplibregl-marker, maplibregl-marker-anchor-center)
      el.classList.add('drone-marker');
      el.classList.remove('status-GREEN', 'status-YELLOW', 'status-RED');
      el.classList.add(`status-${d.trust_status}`);
      el.classList.toggle('selected', d.drone_id === selected);
      el.classList.toggle('landed', !d.is_armed);
      el.setAttribute('aria-label', `Drone ${d.drone_id}, trust ${Math.round(d.trust_score)}`);
      el.innerHTML = `<span class="glyph" style="transform: rotate(${Math.round(d.heading)}deg)">▲</span><span class="tag">D${d.drone_id} · ${Math.round(d.trust_score)}</span>`;
      marker.setLngLat([d.longitude, d.latitude]);
    }
    for (const [id, m] of this.droneMarkers) {
      if (!seen.has(id)) { m.remove(); this.droneMarkers.delete(id); }
    }
  }

  private trails = new Map<number, [number, number][]>();

  private updateTrails(drones: DroneState[]): void {
    if (!drones.length) this.trails.clear();
    for (const d of drones) {
      const t = this.trails.get(d.drone_id) ?? [];
      t.push([d.longitude, d.latitude]);
      this.trails.set(d.drone_id, t.slice(-40));
    }
    (this.map!.getSource('trails') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: drones.map(d => ({
        type: 'Feature',
        properties: { color: STATUS_COLORS[d.trust_status] },
        geometry: { type: 'LineString', coordinates: this.trails.get(d.drone_id) ?? [] },
      })),
    });
  }
  protected toggleMapMode(mode: 'create_patrol' | 'create_threat' | 'create_corridor' | 'delete_zone' | 'pick_loiter'): void {
    if (this.store.mapMode() === mode) {
      this.cancelMapMode();
    } else {
      this.cancelMapMode();
      this.store.setMapMode(mode);
    }
  }

  protected finishCorridor(): void {
    if (this.corridorPoints.length >= 2) {
      const count = this.store.zones().filter(z => z.is_active && z.zone_type === 'SAFE_CORRIDOR').length;
      const greek = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'];
      const label = greek[count] ?? `Route-${count + 1}`;
      this.store.createSafeCorridor(`Safe Corridor ${label}`, this.corridorPoints);
    }
    this.cancelMapMode();
  }

  protected cancelMapMode(): void {
    if (this.isDrawingZone) {
      this.isDrawingZone = false;
      this.map?.dragPan.enable();
    }
    this.drawCenter = null;
    this.corridorPoints = [];
    (this.map?.getSource('preview-zone') as GeoJSONSource | undefined)?.setData(empty());
    (this.map?.getSource('preview-corridor') as GeoJSONSource | undefined)?.setData(empty());
    this.store.setMapMode('view');
  }

  private setupInteractions(map: MlMap): void {
    map.on('mousedown', e => {
      const mode = this.store.mapMode();
      if ((mode === 'create_patrol' || mode === 'create_threat') && e.originalEvent.button === 0) {
        this.isDrawingZone = true;
        this.drawCenter = [e.lngLat.lat, e.lngLat.lng];
        map.dragPan.disable();
      }
    });

    map.on('mousemove', e => {
      const mode = this.store.mapMode();
      if (this.isDrawingZone && this.drawCenter) {
        const radiusM = distanceM(this.drawCenter[0], this.drawCenter[1], e.lngLat.lat, e.lngLat.lng);
        const ring = circleRing(this.drawCenter[0], this.drawCenter[1], Math.max(radiusM, 20));
        const color = mode === 'create_threat' ? '#ff5463' : '#00d4ff';
        const opacity = mode === 'create_threat' ? 0.15 : 0;
        (map.getSource('preview-zone') as GeoJSONSource | undefined)?.setData({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            properties: { radiusM, color, opacity },
            geometry: { type: 'Polygon', coordinates: [ring] },
          }],
        });
      }
    });

    map.on('mouseup', e => {
      const mode = this.store.mapMode();
      if (this.isDrawingZone && this.drawCenter) {
        this.isDrawingZone = false;
        map.dragPan.enable();
        const radiusM = distanceM(this.drawCenter[0], this.drawCenter[1], e.lngLat.lat, e.lngLat.lng);
        (map.getSource('preview-zone') as GeoJSONSource | undefined)?.setData(empty());
        if (radiusM >= 60) {
          if (mode === 'create_patrol') {
            const count = this.store.zones().filter(z => z.is_active && z.zone_type === 'PATROL').length;
            const greek = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
            const label = greek[count] ?? `Zone-${count + 1}`;
            this.store.createPatrolZone(`Patrol Zone ${label}`, this.drawCenter, radiusM);
          } else if (mode === 'create_threat') {
            const count = this.store.zones().filter(z => z.is_active && z.zone_type === 'THREAT').length;
            const greek = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'];
            const label = greek[count] ?? `Sector-${count + 1}`;
            this.store.createThreatZone(`Restricted Threat Zone ${label}`, this.drawCenter, radiusM);
          }
        }
        this.drawCenter = null;
        this.store.setMapMode('view');
      }
    });

    map.on('click', e => {
      const mode = this.store.mapMode();
      if (mode === 'create_corridor') {
        this.corridorPoints.push([e.lngLat.lat, e.lngLat.lng]);
        if (this.corridorPoints.length >= 2) {
          (map.getSource('preview-corridor') as GeoJSONSource | undefined)?.setData({
            type: 'FeatureCollection',
            features: [{
              type: 'Feature',
              properties: {},
              geometry: { type: 'LineString', coordinates: this.corridorPoints.map(pt => [pt[1], pt[0]]) },
            }],
          });
        }
      } else if (mode === 'delete_zone') {
        const clickedLat = e.lngLat.lat;
        const clickedLon = e.lngLat.lng;
        // Prioritize circular zones
        const activeCircles = this.store.zones().filter(z => z.is_active && z.center && z.radius_m);
        const clickedCircle = activeCircles.find(
          z => distanceM(z.center![0], z.center![1], clickedLat, clickedLon) <= z.radius_m!
        );
        if (clickedCircle) {
          this.store.deleteZone(clickedCircle.id);
          this.store.setMapMode('view');
          return;
        }
        // Then corridors
        const activeCorridors = this.store.zones().filter(z => z.is_active && z.zone_type === 'SAFE_CORRIDOR' && z.waypoints?.length);
        const clickedCorridor = activeCorridors.find(c => {
          return c.waypoints!.some(wp => distanceM(wp[0], wp[1], clickedLat, clickedLon) <= 220);
        });
        if (clickedCorridor) {
          this.store.deleteZone(clickedCorridor.id);
        }
        this.store.setMapMode('view');
      } else if (mode === 'pick_loiter') {
        this.store.setPickedLoiterPoint([e.lngLat.lat, e.lngLat.lng]);
        this.store.pushToast('ok', 'Loiter point selected', `Target coordinates: [${e.lngLat.lat.toFixed(4)}, ${e.lngLat.lng.toFixed(4)}]`);
        this.store.setMapMode('view');
      }
    });

    map.on('dblclick', e => {
      if (this.store.mapMode() === 'create_corridor') {
        e.preventDefault();
        this.finishCorridor();
      }
    });
  }

  private renderLoiterTarget(pt: [number, number] | null): void {
    if (!this.map) return;
    if (!pt) {
      this.loiterMarker?.remove();
      this.loiterMarker = null;
      return;
    }
    if (!this.loiterMarker) {
      const el = document.createElement('div');
      el.className = 'loiter-target-marker';
      el.innerHTML = '<span class="reticle">&#9678;</span><span class="label">LOITER</span>';
      this.loiterMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([pt[1], pt[0]])
        .addTo(this.map);
    } else {
      this.loiterMarker.setLngLat([pt[1], pt[0]]);
    }
  }

}

/** Fetches the real basemap style, or null when offline / slow, so the caller can fall back to the grid. */
async function loadRealStyle(): Promise<StyleSpecification | null> {
  try {
    const res = await fetch(REAL_STYLE_URL, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const style = (await res.json()) as StyleSpecification;
    // The style ships without a credit line; OpenFreeMap and OSM require one.
    for (const src of Object.values(style.sources)) {
      if (src && typeof src === 'object' && ('url' in src || 'tiles' in src)) {
        (src as { attribution?: string }).attribution = REAL_ATTRIBUTION;
      }
    }
    return tintBasemap(style);
  } catch {
    return null;
  }
}

// The stock dark style is near-black; lift it into the console palette so streets and
// districts read clearly under the overlays. Matched by layer-id prefix, first match wins.
const BASEMAP_TINT: [prefix: string, color: string][] = [
  ['background', '#0e151d'],
  ['water', '#13283c'],
  ['waterway', '#18324b'],
  ['landuse_residential', '#131c26'],
  ['landcover_wood', '#122119'],
  ['landuse_park', '#122119'],
  ['building', '#18222d'],
  ['highway_path', '#1b2734'],
  ['highway_minor', '#223040'],
  ['highway_major', '#2c3d51'],
  ['highway_motorway', '#3a5068'],
  ['railway', '#2a3644'],
  ['boundary', '#3b4a5c'],
];

function tintBasemap(style: StyleSpecification): StyleSpecification {
  for (const layer of style.layers) {
    const tint = BASEMAP_TINT.find(([prefix]) => layer.id.startsWith(prefix))?.[1];
    const paint = ((layer as { paint?: Record<string, unknown> }).paint ??= {});
    if (layer.type === 'symbol') {
      paint['text-color'] = '#7f93a8';
      paint['text-halo-color'] = '#0b0f14';
      paint['text-halo-width'] = 1.2;
    } else if (tint && layer.type === 'background') {
      paint['background-color'] = tint;
    } else if (tint && layer.type === 'fill') {
      paint['fill-color'] = tint;
    } else if (tint && layer.type === 'line') {
      paint['line-color'] = tint;
    }
  }
  return style;
}

function gridLines(): FeatureCollection {
  const features: Feature[] = [];
  const step = 0.0025;
  const [minLon, maxLon, minLat, maxLat] = [23.74, 23.9, 44.28, 44.38];
  for (let lon = minLon; lon <= maxLon; lon += step) {
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[lon, minLat], [lon, maxLat]] } });
  }
  for (let lat = minLat; lat <= maxLat; lat += step) {
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[minLon, lat], [maxLon, lat]] } });
  }
  return { type: 'FeatureCollection', features };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
