// Shapes mirror the FastAPI schemas in Backend/app/schemas and the simulator's
// FLEET_UPDATE WebSocket payload (Backend/app/services/simulator.py).

export type TrustStatus = 'GREEN' | 'YELLOW' | 'RED';
export type ZoneType = 'BASE' | 'SAFE_CORRIDOR' | 'INTERFERENCE' | 'THREAT' | 'WEATHER' | 'PATROL' | 'OBJECTIVE';
export type WeatherKind = 'STORM' | 'RAIN' | 'WIND';
export type DataMode = 'live' | 'offline';
export type LinkState = 'connecting' | 'online' | 'offline';
export type ZoneTactic = 'SECTOR_ORBIT_SHIFT' | 'TIGHT_MESH' | 'WIDE_RECON' | 'EGRESS_CORRIDOR' | 'RESYNC_EQUIDISTANT';
export type MapMode = 'view' | 'create_patrol' | 'create_threat' | 'create_corridor' | 'create_objective' | 'delete_zone' | 'pick_loiter';

export interface ScoreBreakdown {
  drone_id: number;
  trust_score: number;
  trust_status: TrustStatus;
  gps_score: number;
  imu_score: number;
  link_score: number;
  consensus_score: number;
  command_score: number;
  uncertainty_radius_m: number;
  reason: string;
}

export interface DroneState {
  drone_id: number;
  latitude: number;
  longitude: number;
  altitude: number;
  ground_speed: number;
  heading: number;
  fix_type: number;
  satellites_visible: number;
  eph: number;
  battery_remaining: number;
  drop_rate_comm: number;
  rssi: number;
  flight_mode: string;
  is_armed: boolean;
  trust_score: number;
  trust_status: TrustStatus;
  uncertainty_radius_m: number;
  reason: string;
  scores?: ScoreBreakdown;
  patrol_zone_id?: number;
  /** Drone-to-drone mesh view (Backend/app/services/mesh.py, core/mesh.ts). */
  mesh?: MeshView | null;
  /** SIM = ORION's simulator; MAVLINK = an external vehicle (SITL, real drone) heard over UDP. */
  source?: 'SIM' | 'MAVLINK';
  mavlink_sysid?: number;
  mavlink_address?: string;
  last_updated: string;
}

export interface MeshLink {
  peer_id: number;
  /** Distance between the two GPS-reported positions. */
  gps_distance_m: number;
  /** Distance measured by radio time-of-flight (independent of GPS). */
  radio_range_m: number;
  consistent: boolean;
}

export interface MeshView {
  neighbors: number;
  /** 0-100, or null with no neighbour in radio range. */
  score: number | null;
  status: 'TRUSTED' | 'OUTLIER' | 'DISPUTED' | 'ALONE';
  links: MeshLink[];
}

export interface Zone {
  id: number;
  name: string;
  zone_type: ZoneType;
  geometry_type: 'CIRCLE' | 'POLYGON';
  center?: [number, number]; // [lat, lon]
  radius_m?: number;
  waypoints?: [number, number][]; // [lat, lon][]
  is_active: boolean;
  detected_by: string;
  // WEATHER zones only (Backend/app/services/weather.py)
  weather?: WeatherKind;
  wind_ms?: number;
  rain?: 'NONE' | 'MODERATE' | 'HEAVY';
  /** [dlat, dlon] per second. */
  drift?: [number, number];
}

export interface FleetUpdate {
  type: 'FLEET_UPDATE';
  elapsed_time: number;
  active_sector_interference: boolean;
  zones: Zone[];
  drones: DroneState[];
  random_interval_min?: number;
  random_interval_max?: number;
  random_events_enabled?: boolean;
}

export interface SnapshotMessage {
  type: 'SNAPSHOT';
  zones: Zone[];
  simulator_running: boolean;
  elapsed_time: number;
}

export type SocketMessage = FleetUpdate | SnapshotMessage | { type: 'PONG' };

export interface AuditEvent {
  id: number;
  timestamp: string;
  event_type: string;
  drone_id: number | null;
  details: string;
  operator_id: string;
  prev_hash: string;
  curr_hash: string;
}

export interface ChainVerification {
  is_valid: boolean;
  broken_at_index: number | null;
  total_events: number;
  message: string;
}

// SUPERSEDED: offline only, the operator sent a different command to that drone instead.
export type RecommendationStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXECUTED' | 'SUPERSEDED';

export interface Recommendation {
  id: number;
  drone_id: number;
  timestamp: string;
  trigger_event: string;
  blocked_action: string;
  blocked_reason: string;
  recommended_action: string;
  recommendation_details: string | null;
  reason?: string | null;
  status: RecommendationStatus;
  operator_id: string | null;
  approved_at: string | null;
}

export interface SignedCommand {
  command: string;
  drone_id: number;
  sequence: number;
  params: Record<string, unknown>;
  timestamp: number;
  signature: string;
}

export interface DecisionResult {
  status: string;
  message: string;
  signed_command: SignedCommand | null;
}

export interface ExportReport {
  mission_id: string;
  generated_at: string;
  verification: ChainVerification;
  timeline: AuditEvent[];
  summary: Record<string, unknown>;
}

// Read-only AAR copilot (Backend/app/api/endpoints/copilot.py)
export interface CopilotAnswer {
  answer: string;
  cited_ids: number[];
  refused: boolean;
  model: string;
  source: 'server' | 'client';
  chain_valid: boolean;
  records: number;
}

export interface CopilotMessage {
  role: 'user' | 'assistant';
  text: string;
  citedIds?: number[];
  error?: boolean;
  meta?: string;
}

