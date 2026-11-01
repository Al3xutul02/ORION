import {
  ChangeDetectionStrategy, Component, ElementRef, OnDestroy, afterNextRender, computed, effect, inject, signal, viewChild,
} from '@angular/core';
import maplibregl, { GeoJSONSource, Map as MlMap, Marker, StyleSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import { circleRing, distanceM, egressPaths, evaluateActions, orderPolygonVertices, weatherPolygon } from '../../core/geo';
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
  OBJECTIVE: '#f59e0b',
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

// 3D view: terrain from the public AWS Terrain Tiles (Terrarium PNG, no API key). The plain
// around Craiova is flat (60-200 m) and drones fly 120-150 m up, so heights are exaggerated;
// terrain and drones use the same factor, so what's above what stays true.
const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const DEM_ATTRIBUTION = 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Mapzen/AWS Terrain Tiles</a>';
export const VERTICAL_EXAGGERATION = 4;
const PITCH_3D = 62;
/** Airspace volumes drawn over threat-type zones in 3D, metres above ground (before exaggeration). */
const VOLUME_TOP_M = 220;

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
  protected view3d = signal(this.saved3d());
  protected readonly exaggeration = VERTICAL_EXAGGERATION;
  private ready = false;
  private resizeObserver: ResizeObserver | null = null;
  private droneMarkers = new Map<number, Marker>();
  private zoneLabels = new Map<number, Marker>();
  private loiterMarker: Marker | null = null;
  private isDrawingZone = false;
  private drawCenter: [number, number] | null = null;
  readonly corridorPoints = signal<[number, number][]>([]);
  readonly objectivePoints = signal<[number, number][]>([]);
  readonly threatPoints = signal<[number, number][]>([]);

  constructor() {
    afterNextRender(() => this.init());



    effect(() => {
      const zones = this.store.zones();
      if (this.ready) this.renderZones(zones);
    });

    effect(() => {
      const drones = this.store.drones();
      const zones = this.store.zones();
      const selected = this.store.selectedDroneId();
      this.store.radioBubbles(); // a new radio mention redraws the markers right away
      if (this.ready) this.renderDrones(drones, zones, selected);
    });

    effect(() => {
      const pt = this.store.pickedLoiterPoint();
      if (this.ready) this.renderLoiterTarget(pt);
    });
  }

  protected toggle3d(): void {
    const on = !this.view3d();
    this.view3d.set(on);
    try { localStorage.setItem('orion.map3d', String(on)); } catch { /* storage unavailable */ }
    // While a basemap style is loading, addOverlays() applies the view once it's ready.
    if (!this.ready) return;
    this.apply3d(true);
    this.renderDrones(this.store.drones(), this.store.zones(), this.store.selectedDroneId());
  }

  private saved3d(): boolean {
    try { return localStorage.getItem('orion.map3d') === 'true'; } catch { return false; }
  }

  /** Terrain, camera tilt and rotation for the current view; layers are only shown in 3D. */
  private apply3d(animate: boolean): void {
    const map = this.map;
    if (!map) return;
    const on = this.view3d();
    try {
      for (const id of ['hillshade', 'drone-stalks', 'drone-pucks', 'zones-volume']) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
      }
      map.setTerrain(on ? { source: 'dem', exaggeration: VERTICAL_EXAGGERATION } : null);
    } catch {
      // Style still loading (a basemap switch in flight): try again once the map settles.
      map.once('idle', () => this.apply3d(false));
      return;
    }
    if (on) {
      map.dragRotate.enable();
      map.touchZoomRotate.enableRotation();
    } else {
      map.dragRotate.disable();
      map.touchZoomRotate.disableRotation();
    }
    const camera = { pitch: on ? PITCH_3D : 0, bearing: on ? -20 : 0 };
    if (animate) map.easeTo({ ...camera, duration: 900 });
    else map.jumpTo(camera);
  }

  /**
   * HTML markers sit on the terrain; in 3D, lift each drone's marker to its altitude. The point
   * at altitude is projected with the map's own camera, by giving locationToScreenPoint a
   * terrain that reports ground elevation plus the drone's (exaggerated) altitude.
   */
  private liftMarkers(): void {
    const map = this.map;
    if (!map) return;
    const terrain = this.view3d() ? map.terrain : null;
    for (const d of this.store.drones()) {
      const marker = this.droneMarkers.get(d.drone_id);
      if (!marker) continue;
      if (!terrain || d.altitude <= 0) {
        marker.setOffset([0, 0]);
        continue;
      }
      const ll = new maplibregl.LngLat(d.longitude, d.latitude);
      const groundM = terrain.getElevationForLngLat(ll, map.transform);
      const airM = groundM + d.altitude * VERTICAL_EXAGGERATION;
      const atAltitude = { getElevationForLngLat: () => airM, getElevationForLngLatZoom: () => airM } as unknown as typeof terrain;
      const ground = map.transform.locationToScreenPoint(ll, terrain);
      const air = map.transform.locationToScreenPoint(ll, atAltitude);
      marker.setOffset([air.x - ground.x, air.y - ground.y]);
    }
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
    const on = this.view3d();
    this.map?.fitBounds(THEATRE_BOUNDS, { padding: this.fitPadding(), duration: 600, pitch: on ? PITCH_3D : 0, bearing: on ? -20 : 0 });
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
      maxPitch: 75,
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
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    this.setupInteractions(map);

    // Overlays are wiped by every setStyle, so they are (re)added on each style load.
    map.on('style.load', () => this.addOverlays());
    map.on('move', () => this.liftMarkers());
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

    // Separate DEM sources for terrain and hillshade, as MapLibre recommends.
    const dem = { type: 'raster-dem' as const, tiles: [DEM_TILES], tileSize: 256, maxzoom: 15, encoding: 'terrarium' as const };
    map.addSource('dem', { ...dem, attribution: DEM_ATTRIBUTION });
    map.addSource('dem-shade', dem);
    map.addLayer({
      id: 'hillshade', type: 'hillshade', source: 'dem-shade', layout: { visibility: 'none' },
      paint: {
        'hillshade-exaggeration': 0.55,
        'hillshade-shadow-color': '#05080c',
        'hillshade-highlight-color': real ? '#3a5068' : '#2a3a4c',
        'hillshade-accent-color': '#0b1219',
      },
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
      id: 'corridor', type: 'line', source: 'zones',
      filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'zone_type'], 'SAFE_CORRIDOR']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ZONE_COLORS['SAFE_CORRIDOR'], 'line-width': 14, 'line-opacity': 0.14 },
    });
    map.addLayer({
      id: 'corridor-center', type: 'line', source: 'zones',
      filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'zone_type'], 'SAFE_CORRIDOR']],
      paint: { 'line-color': ZONE_COLORS['SAFE_CORRIDOR'], 'line-width': 1.5, 'line-dasharray': [1, 2] },
    });
    map.addLayer({
      id: 'objective-line-glow', type: 'line', source: 'zones',
      filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'zone_type'], 'OBJECTIVE']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ZONE_COLORS['OBJECTIVE'], 'line-width': 14, 'line-opacity': 0.2 },
    });
    map.addLayer({
      id: 'objective-line-core', type: 'line', source: 'zones',
      filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'zone_type'], 'OBJECTIVE']],
      paint: { 'line-color': ZONE_COLORS['OBJECTIVE'], 'line-width': 2.5, 'line-dasharray': [4, 3] },
    });

    // Airspace volumes over threat, interference and weather zones (3D only).
    map.addLayer({
      id: 'zones-volume', type: 'fill-extrusion', source: 'zones', layout: { visibility: 'none' },
      filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['in', ['get', 'zone_type'], ['literal', ['THREAT', 'INTERFERENCE', 'WEATHER']]], ['!=', ['get', 'is_core'], true]],
      paint: {
        'fill-extrusion-color': ['get', 'color'],
        'fill-extrusion-height': VOLUME_TOP_M * VERTICAL_EXAGGERATION,
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.13,
      },
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

    // Drones in 3D: a thin stalk from the ground and a puck at flight altitude (exaggerated like the terrain).
    map.addSource('drones-3d', { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'drone-stalks', type: 'fill-extrusion', source: 'drones-3d', layout: { visibility: 'none' },
      filter: ['==', ['get', 'part'], 'stalk'],
      paint: {
        'fill-extrusion-color': ['get', 'color'],
        'fill-extrusion-base': 0,
        'fill-extrusion-height': ['get', 'top'],
        'fill-extrusion-opacity': 0.55,
      },
    });
    map.addLayer({
      id: 'drone-pucks', type: 'fill-extrusion', source: 'drones-3d', layout: { visibility: 'none' },
      filter: ['==', ['get', 'part'], 'puck'],
      paint: {
        'fill-extrusion-color': ['get', 'color'],
        'fill-extrusion-base': ['get', 'base'],
        'fill-extrusion-height': ['get', 'top'],
        'fill-extrusion-opacity': 0.9,
      },
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
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': '#3ddc84', 'line-width': 16, 'line-opacity': 0.22 },
    });
    map.addLayer({
      id: 'preview-corridor-core', type: 'line', source: 'preview-corridor',
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': '#3ddc84', 'line-width': 2, 'line-dasharray': [4, 3] },
    });
    map.addLayer({
      id: 'preview-corridor-points', type: 'circle', source: 'preview-corridor',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 5,
        'circle-color': '#3ddc84',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
      },
    });

    map.addSource('preview-objective', { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'preview-objective-fill', type: 'fill', source: 'preview-objective',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.22 },
    });
    map.addLayer({
      id: 'preview-objective-line-glow', type: 'line', source: 'preview-objective',
      filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#f59e0b', 'line-width': 14, 'line-opacity': 0.2 },
    });
    map.addLayer({
      id: 'preview-objective-line', type: 'line', source: 'preview-objective',
      filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'LineString']],
      paint: { 'line-color': '#f59e0b', 'line-width': 2.5, 'line-dasharray': [4, 3] },
    });
    map.addLayer({
      id: 'preview-objective-points', type: 'circle', source: 'preview-objective',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 5,
        'circle-color': '#f59e0b',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
      },
    });

    map.addSource('preview-threat', { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'preview-threat-fill', type: 'fill', source: 'preview-threat',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': '#ff5463', 'fill-opacity': 0.22 },
    });
    map.addLayer({
      id: 'preview-threat-line', type: 'line', source: 'preview-threat',
      filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'LineString']],
      paint: { 'line-color': '#ff5463', 'line-width': 2.5, 'line-dasharray': [4, 3] },
    });
    map.addLayer({
      id: 'preview-threat-points', type: 'circle', source: 'preview-threat',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 5,
        'circle-color': '#ff5463',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
      },
    });

    this.ready = true;
    this.apply3d(false);
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
      if (z.zone_type === 'SAFE_CORRIDOR') {
        // Safe corridors are strictly flight lines followed by RTL return algorithms
        features.push({
          type: 'Feature',
          properties: props,
          geometry: { type: 'LineString', coordinates: (z.waypoints ?? []).map(([la, lo]) => [lo, la]) },
        });
      } else if (z.geometry_type === 'CIRCLE' && z.center && z.radius_m) {
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
      } else if ((z.zone_type === 'OBJECTIVE' || z.zone_type === 'THREAT') && z.waypoints?.length) {
        const ring = z.waypoints.map(([la, lo]) => [lo, la]);
        if (ring.length >= 3) {
          if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
            ring.push([ring[0][0], ring[0][1]]);
          }
          features.push({
            type: 'Feature',
            properties: { ...props, is_objective: z.zone_type === 'OBJECTIVE', is_threat: z.zone_type === 'THREAT' },
            geometry: { type: 'Polygon', coordinates: [ring] },
          });
        } else if (ring.length === 2) {
          features.push({
            type: 'Feature',
            properties: { ...props, is_objective: z.zone_type === 'OBJECTIVE', is_line: true },
            geometry: { type: 'LineString', coordinates: ring },
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
      let anchorPos: 'center' | 'top' | 'bottom' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' = 'center';
      let offset: [number, number] = [0, -10];

      if (z.zone_type === 'PATROL' && z.center && z.radius_m) {
        // Distribute label positions alternating across opposite compass poles (N, S, E, W, etc.)
        // This guarantees concentric/nested patrol zones will never collide.
        const layoutConfigs: { angleDeg: number; anchor: 'top' | 'bottom' | 'left' | 'right'; offset: [number, number] }[] = [
          { angleDeg: 90,  anchor: 'bottom', offset: [0, -6] }, // North (top)
          { angleDeg: 270, anchor: 'top',    offset: [0, 6] },  // South (bottom)
          { angleDeg: 0,   anchor: 'left',   offset: [8, 0] },  // East (right)
          { angleDeg: 180, anchor: 'right',  offset: [-8, 0] }, // West (left)
          { angleDeg: 45,  anchor: 'bottom', offset: [4, -4] }, // North-East
          { angleDeg: 225, anchor: 'top',    offset: [-4, 4] }, // South-West
          { angleDeg: 135, anchor: 'bottom', offset: [-4, -4] },// North-West
          { angleDeg: 315, anchor: 'top',    offset: [4, 4] },  // South-East
        ];
        const cfg = layoutConfigs[patrolIndex % layoutConfigs.length];
        patrolIndex++;
        const angleRad = (cfg.angleDeg * Math.PI) / 180.0;
        const cosLat = Math.cos((z.center[0] * Math.PI) / 180.0);
        const dLat = (z.radius_m * Math.sin(angleRad)) / 111139.0;
        const dLon = (z.radius_m * Math.cos(angleRad)) / (111139.0 * cosLat);
        anchorLngLat = [z.center[1] + dLon, z.center[0] + dLat];
        anchorPos = cfg.anchor;
        offset = cfg.offset;
      } else if (z.zone_type === 'SAFE_CORRIDOR' && z.waypoints?.length) {
        const mid = z.waypoints[Math.floor((z.waypoints.length - 1) / 2)];
        anchorLngLat = [mid[1], mid[0]];
        anchorPos = 'left';
        offset = [14, 0];
      } else if ((z.zone_type === 'OBJECTIVE' || z.zone_type === 'THREAT') && z.waypoints?.length) {
        const lats = z.waypoints.map(p => p[0]);
        const lons = z.waypoints.map(p => p[1]);
        const avgLat = lats.reduce((a, b) => a + b, 0) / lats.length;
        const avgLon = lons.reduce((a, b) => a + b, 0) / lons.length;
        anchorLngLat = [avgLon, avgLat];
        anchorPos = 'center';
        offset = [0, 0];
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
        existing.setOffset(offset);
        const el = existing.getElement();
        if (z.zone_type === 'PATROL') {
          el.innerHTML = `<span class="patrol-icon">&#8853;</span><span>${escapeHtml(z.name)}</span>`;
        }
        continue;
      }
      const el = document.createElement('div');
      el.className = `zone-label zone-${z.zone_type}`;
      if (z.zone_type === 'PATROL') {
        el.innerHTML = `<span class="patrol-icon">&#8853;</span><span>${escapeHtml(z.name)}</span>`;
      } else if (z.zone_type === 'OBJECTIVE') {
        el.innerHTML = `<span class="objective-icon">&#9670;</span><span class="objective-name">${escapeHtml(z.name)}</span>`;
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
    this.update3dDrones(drones);

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
          this.store.selectDrone(d.drone_id);
        });
        // A click only selects; a double-click opens the details (and must not zoom the map).
        el.addEventListener('dblclick', ev => {
          ev.stopPropagation();
          ev.preventDefault();
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
      const alt = this.view3d() && d.is_armed ? ` · ${Math.round(d.altitude)} m` : '';
      const said = this.store.radioBubbles()[d.drone_id];
      el.classList.toggle('talking', !!said);
      const bubble = said ? `<span class="bubble"><b>${escapeHtml(said.speaker)}</b>„${escapeHtml(said.text)}”</span>` : '';
      el.innerHTML = `${bubble}<span class="glyph" style="transform: rotate(${Math.round(d.heading)}deg)">▲</span><span class="tag">D${d.drone_id} · ${Math.round(d.trust_score)}${alt}</span>`;
      marker.setLngLat([d.longitude, d.latitude]);
    }
    for (const [id, m] of this.droneMarkers) {
      if (!seen.has(id)) { m.remove(); this.droneMarkers.delete(id); }
    }
    this.liftMarkers();
  }

  private update3dDrones(drones: DroneState[]): void {
    const features: Feature[] = [];
    if (this.view3d()) {
      for (const d of drones) {
        if (!d.is_armed || d.altitude <= 0) continue;
        const top = d.altitude * VERTICAL_EXAGGERATION;
        const color = STATUS_COLORS[d.trust_status];
        features.push(
          { type: 'Feature', properties: { part: 'stalk', color, top }, geometry: { type: 'Polygon', coordinates: [circleRing(d.latitude, d.longitude, 4, 8)] } },
          { type: 'Feature', properties: { part: 'puck', color, base: top - 10, top: top + 10 }, geometry: { type: 'Polygon', coordinates: [circleRing(d.latitude, d.longitude, 24, 16)] } },
        );
      }
    }
    (this.map!.getSource('drones-3d') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
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
  protected toggleMapMode(mode: 'create_patrol' | 'create_threat' | 'create_corridor' | 'create_objective' | 'delete_zone' | 'pick_loiter'): void {
    if (this.store.mapMode() === mode) {
      this.cancelMapMode();
    } else {
      this.cancelMapMode();
      this.store.setMapMode(mode);
    }
  }

  private updateCorridorPreview(mouseLngLat?: [number, number]): void {
    if (!this.map) return;
    const pts = this.corridorPoints();
    if (!pts.length) {
      (this.map.getSource('preview-corridor') as GeoJSONSource | undefined)?.setData(empty());
      return;
    }

    const features: any[] = [];
    for (const pt of pts) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: [pt[1], pt[0]] },
      });
    }

    if (pts.length >= 2) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: pts.map(p => [p[1], p[0]]) },
      });
    }

    if (mouseLngLat && pts.length >= 1) {
      const last = pts[pts.length - 1];
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [[last[1], last[0]], mouseLngLat] },
      });
    }

    (this.map.getSource('preview-corridor') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features,
    });
  }

  private updateObjectivePreview(mouseLngLat?: [number, number]): void {
    if (!this.map) return;
    const pts = this.objectivePoints();
    if (!pts.length) {
      (this.map.getSource('preview-objective') as GeoJSONSource | undefined)?.setData(empty());
      return;
    }

    const features: any[] = [];
    for (const pt of pts) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: [pt[1], pt[0]] },
      });
    }

    if (pts.length >= 3) {
      const clean = orderPolygonVertices(pts);
      const ring = clean.map(p => [p[1], p[0]]);
      ring.push([ring[0][0], ring[0][1]]);
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
    } else if (pts.length === 2) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: pts.map(p => [p[1], p[0]]) },
      });
    }

    if (mouseLngLat && pts.length >= 1) {
      const last = pts[pts.length - 1];
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [[last[1], last[0]], mouseLngLat] },
      });
    }

    (this.map.getSource('preview-objective') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features,
    });
  }

  private updateThreatPreview(mouseLngLat?: [number, number]): void {
    if (!this.map) return;
    const pts = this.threatPoints();
    if (!pts.length) {
      (this.map.getSource('preview-threat') as GeoJSONSource | undefined)?.setData(empty());
      return;
    }

    const features: any[] = [];
    for (const pt of pts) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: [pt[1], pt[0]] },
      });
    }

    if (pts.length >= 3) {
      const clean = orderPolygonVertices(pts);
      const ring = clean.map(p => [p[1], p[0]]);
      ring.push([ring[0][0], ring[0][1]]);
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
    } else if (pts.length === 2) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: pts.map(p => [p[1], p[0]]) },
      });
    }

    if (mouseLngLat && pts.length >= 1) {
      const last = pts[pts.length - 1];
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [[last[1], last[0]], mouseLngLat] },
      });
    }

    (this.map.getSource('preview-threat') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features,
    });
  }

  protected finishThreat(): void {
    const rawPts = this.threatPoints();
    const cleanPts = orderPolygonVertices(rawPts);
    if (cleanPts.length >= 3) {
      const count = this.store.zones().filter(z => z.is_active && z.zone_type === 'THREAT').length;
      const greek = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'];
      const label = greek[count] ?? `Sector-${count + 1}`;
      this.store.createThreatZone(`Restricted Threat Zone ${label}`, cleanPts);
    }
    this.cancelMapMode();
  }

  protected finishObjective(): void {
    const rawPts = this.objectivePoints();
    const cleanPts = orderPolygonVertices(rawPts);
    if (cleanPts.length >= 2) {
      const count = this.store.zones().filter(z => z.is_active && z.zone_type === 'OBJECTIVE').length;
      const greek = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
      const label = greek[count] ?? `Sector-${count + 1}`;
      this.store.createObjectiveZone(`Objective Zone ${label}`, cleanPts);
    }
    this.cancelMapMode();
  }

  protected finishCorridor(): void {
    const pts = this.corridorPoints();
    if (pts.length >= 2) {
      const count = this.store.zones().filter(z => z.is_active && z.zone_type === 'SAFE_CORRIDOR').length;
      const greek = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'];
      const label = greek[count] ?? `Route-${count + 1}`;
      this.store.createSafeCorridor(`Safe Corridor ${label}`, pts);
    }
    this.cancelMapMode();
  }

  protected cancelMapMode(): void {
    if (this.isDrawingZone) {
      this.isDrawingZone = false;
      this.map?.dragPan.enable();
    }
    this.drawCenter = null;
    this.corridorPoints.set([]);
    this.objectivePoints.set([]);
    this.threatPoints.set([]);
    (this.map?.getSource('preview-zone') as GeoJSONSource | undefined)?.setData(empty());
    (this.map?.getSource('preview-corridor') as GeoJSONSource | undefined)?.setData(empty());
    (this.map?.getSource('preview-objective') as GeoJSONSource | undefined)?.setData(empty());
    (this.map?.getSource('preview-threat') as GeoJSONSource | undefined)?.setData(empty());
    this.store.setMapMode('view');
  }

  private setupInteractions(map: MlMap): void {
    map.on('mousedown', e => {
      const mode = this.store.mapMode();
      if (mode === 'create_patrol' && e.originalEvent.button === 0) {
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
        const color = '#00d4ff';
        const opacity = 0;
        (map.getSource('preview-zone') as GeoJSONSource | undefined)?.setData({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            properties: { radiusM, color, opacity },
            geometry: { type: 'Polygon', coordinates: [ring] },
          }],
        });
      } else if (mode === 'create_corridor' && this.corridorPoints().length >= 1) {
        this.updateCorridorPreview([e.lngLat.lng, e.lngLat.lat]);
      } else if (mode === 'create_objective' && this.objectivePoints().length >= 1) {
        this.updateObjectivePreview([e.lngLat.lng, e.lngLat.lat]);
      } else if (mode === 'create_threat' && this.threatPoints().length >= 1) {
        this.updateThreatPreview([e.lngLat.lng, e.lngLat.lat]);
      }
    });

    map.on('mouseup', e => {
      const mode = this.store.mapMode();
      if (this.isDrawingZone && this.drawCenter) {
        this.isDrawingZone = false;
        map.dragPan.enable();
        const radiusM = distanceM(this.drawCenter[0], this.drawCenter[1], e.lngLat.lat, e.lngLat.lng);
        (map.getSource('preview-zone') as GeoJSONSource | undefined)?.setData(empty());
        if (radiusM >= 60 && mode === 'create_patrol') {
          const count = this.store.zones().filter(z => z.is_active && z.zone_type === 'PATROL').length;
          const greek = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
          const label = greek[count] ?? `Zone-${count + 1}`;
          this.store.createPatrolZone(`Patrol Zone ${label}`, this.drawCenter, radiusM);
        }
        this.drawCenter = null;
        this.store.setMapMode('view');
      }
    });

    map.on('click', e => {
      const mode = this.store.mapMode();
      if (mode === 'create_corridor') {
        const current = this.corridorPoints();
        const newPt: [number, number] = [e.lngLat.lat, e.lngLat.lng];
        if (!current.length || distanceM(current[current.length - 1][0], current[current.length - 1][1], newPt[0], newPt[1]) > 5) {
          this.corridorPoints.update(pts => [...pts, newPt]);
          this.updateCorridorPreview();
        }
      } else if (mode === 'create_objective') {
        const current = this.objectivePoints();
        const newPt: [number, number] = [e.lngLat.lat, e.lngLat.lng];
        if (!current.length || distanceM(current[current.length - 1][0], current[current.length - 1][1], newPt[0], newPt[1]) > 5) {
          this.objectivePoints.update(pts => [...pts, newPt]);
          this.updateObjectivePreview();
        }
      } else if (mode === 'create_threat') {
        const current = this.threatPoints();
        const newPt: [number, number] = [e.lngLat.lat, e.lngLat.lng];
        if (!current.length || distanceM(current[current.length - 1][0], current[current.length - 1][1], newPt[0], newPt[1]) > 5) {
          this.threatPoints.update(pts => [...pts, newPt]);
          this.updateThreatPreview();
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
          this.store.setMapMode('view');
          return;
        }
        // Then threat zones (polygons or lines)
        const activeThreats = this.store.zones().filter(z => z.is_active && z.zone_type === 'THREAT');
        const clickedThreat = activeThreats.find(t => {
          if (t.waypoints?.length) {
            const nearVertex = t.waypoints.some(wp => distanceM(wp[0], wp[1], clickedLat, clickedLon) <= 220);
            if (nearVertex) return true;
            if (t.waypoints.length >= 3) {
              return pointInPolygon(clickedLat, clickedLon, t.waypoints);
            }
          }
          if (t.center && t.radius_m) {
            return distanceM(t.center[0], t.center[1], clickedLat, clickedLon) <= t.radius_m;
          }
          return false;
        });
        if (clickedThreat) {
          this.store.deleteZone(clickedThreat.id);
          this.store.setMapMode('view');
          return;
        }
        // Then objective zones (polygons or lines)
        const activeObjectives = this.store.zones().filter(z => z.is_active && z.zone_type === 'OBJECTIVE' && z.waypoints?.length);
        const clickedObjective = activeObjectives.find(obj => {
          const nearVertex = obj.waypoints!.some(wp => distanceM(wp[0], wp[1], clickedLat, clickedLon) <= 220);
          if (nearVertex) return true;
          if (obj.waypoints!.length >= 3) {
            return pointInPolygon(clickedLat, clickedLon, obj.waypoints!);
          }
          return false;
        });
        if (clickedObjective) {
          this.store.deleteZone(clickedObjective.id);
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
      } else if (this.store.mapMode() === 'create_objective') {
        e.preventDefault();
        this.finishObjective();
      } else if (this.store.mapMode() === 'create_threat') {
        e.preventDefault();
        this.finishThreat();
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

function pointInPolygon(lat: number, lon: number, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = ((yi > lon) !== (yj > lon)) && (lat < ((xj - xi) * (lon - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
