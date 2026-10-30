import {
  ChangeDetectionStrategy, Component, ElementRef, OnDestroy, afterNextRender, effect, inject, viewChild,
} from '@angular/core';
import maplibregl, { GeoJSONSource, Map as MlMap, Marker, StyleSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import { circleRing, egressPaths, evaluateActions } from '../../core/geo';
import { DroneState, Zone } from '../../core/models';
import { OrionStore } from '../../core/orion-store.service';

const ZONE_COLORS: Record<string, string> = {
  BASE: '#5cc8ff',
  SAFE_CORRIDOR: '#3ddc84',
  INTERFERENCE: '#ff9f43',
  THREAT: '#ff5463',
};
const STATUS_COLORS: Record<string, string> = { GREEN: '#3ddc84', YELLOW: '#f5c542', RED: '#ff5463' };

// No tile server: the theatre is fictional, so the map is a plain grid that works offline.
const BLANK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0d141c' } }],
};

// Base in the south-west to the threat zone and spoofed positions in the north-east.
const THEATRE_BOUNDS: [[number, number], [number, number]] = [[23.794, 44.312], [23.85, 44.345]];

const empty = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] });

@Component({
  selector: 'app-theatre-map',
  templateUrl: './theatre-map.html',
  styleUrl: './theatre-map.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TheatreMap implements OnDestroy {
  protected store = inject(OrionStore);
  private host = viewChild.required<ElementRef<HTMLDivElement>>('map');
  private map: MlMap | null = null;
  private ready = false;
  private resizeObserver: ResizeObserver | null = null;
  private droneMarkers = new Map<number, Marker>();
  private zoneLabels = new Map<number, Marker>();

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
      if (this.ready) this.renderDrones(drones, zones, selected);
    });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.map?.remove();
  }

  protected recenter(): void {
    this.map?.fitBounds(THEATRE_BOUNDS, { padding: 40, duration: 600 });
  }

  private init(): void {
    const map = new maplibregl.Map({
      container: this.host().nativeElement,
      style: BLANK_STYLE,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      bounds: THEATRE_BOUNDS,
      fitBoundsOptions: { padding: 40 },
    });
    this.map = map;
    // Keep the whole theatre in view when the panel resizes, until the operator pans or zooms.
    let userMoved = false;
    map.on('movestart', e => { if ((e as { originalEvent?: Event }).originalEvent) userMoved = true; });
    this.resizeObserver = new ResizeObserver(() => {
      map.resize();
      if (!userMoved) map.fitBounds(THEATRE_BOUNDS, { padding: 40, duration: 0 });
    });
    this.resizeObserver.observe(this.host().nativeElement);
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    map.on('load', () => {
      map.addSource('grid', { type: 'geojson', data: gridLines() });
      map.addLayer({ id: 'grid', type: 'line', source: 'grid', paint: { 'line-color': '#1a2633', 'line-width': 1 } });

      map.addSource('zones', { type: 'geojson', data: empty() });
      map.addLayer({
        id: 'zones-fill', type: 'fill', source: 'zones', filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['==', ['get', 'dynamic'], true], 0.2, 0.12] },
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
          'line-dasharray': ['case', ['==', ['get', 'kind'], 'blocked'], ['literal', [2, 2]], ['literal', [1, 0]]],
        },
      });

      map.addSource('trails', { type: 'geojson', data: empty() });
      map.addLayer({
        id: 'trails', type: 'line', source: 'trails',
        paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.35 },
      });

      this.ready = true;
      this.renderZones(this.store.zones());
      this.renderDrones(this.store.drones(), this.store.zones(), this.store.selectedDroneId());
    });
  }

  private renderZones(zones: Zone[]): void {
    const map = this.map!;
    const features: Feature[] = zones.filter(z => z.is_active).map(z => {
      const props = { id: z.id, name: z.name, color: ZONE_COLORS[z.zone_type] ?? '#888', dynamic: z.detected_by !== 'PRECONFIGURED' };
      if (z.geometry_type === 'CIRCLE' && z.center && z.radius_m) {
        return { type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [circleRing(z.center[0], z.center[1], z.radius_m)] } };
      }
      return {
        type: 'Feature', properties: props,
        geometry: { type: 'LineString', coordinates: (z.waypoints ?? []).map(([la, lo]) => [lo, la]) },
      };
    });
    (map.getSource('zones') as GeoJSONSource).setData({ type: 'FeatureCollection', features });

    const seen = new Set<number>();
    for (const z of zones) {
      if (!z.is_active) continue;
      const anchor = z.center ?? z.waypoints?.[Math.floor((z.waypoints.length - 1) / 2)];
      if (!anchor) continue;
      seen.add(z.id);
      if (this.zoneLabels.has(z.id)) continue;
      const el = document.createElement('div');
      el.className = `zone-label zone-${z.zone_type}`;
      el.innerHTML = `<span>${escapeHtml(z.name)}</span>${z.detected_by !== 'PRECONFIGURED' ? '<em>marked by ORION</em>' : ''}`;
      const isArea = !!(z.center && z.radius_m);
      const marker = new maplibregl.Marker({ element: el, anchor: isArea ? 'center' : 'left', offset: isArea ? [0, -14] : [12, 0] })
        .setLngLat([anchor[1], anchor[0]])
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
      const { direct, viaCorridor } = egressPaths(sel, zones);
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
    }
    (map.getSource('paths') as GeoJSONSource).setData({ type: 'FeatureCollection', features: pathFeatures });

    this.updateTrails(drones);

    const seen = new Set<number>();
    for (const d of drones) {
      seen.add(d.drone_id);
      let marker = this.droneMarkers.get(d.drone_id);
      if (!marker) {
        const el = document.createElement('button');
        el.type = 'button';
        el.addEventListener('click', ev => {
          ev.stopPropagation();
          this.store.selectDrone(d.drone_id);
        });
        marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([d.longitude, d.latitude]).addTo(map);
        this.droneMarkers.set(d.drone_id, marker);
      }
      const el = marker.getElement();
      el.className = `drone-marker status-${d.trust_status}${d.drone_id === selected ? ' selected' : ''}${d.is_armed ? '' : ' landed'}`;
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
