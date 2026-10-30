// Backend endpoints (FastAPI, see Backend/app/main.py). Override at runtime with
// ?api=http://host:8000 in the URL, which is remembered in localStorage.
const DEFAULT_API = 'http://localhost:8000';

function resolveApiBase(): string {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get('api');
    if (fromQuery) {
      localStorage.setItem('orion.api', fromQuery);
      return fromQuery.replace(/\/$/, '');
    }
    return (localStorage.getItem('orion.api') ?? DEFAULT_API).replace(/\/$/, '');
  } catch {
    return DEFAULT_API;
  }
}

const apiBase = resolveApiBase();

export const ORION_CONFIG = {
  apiBase,
  apiV1: `${apiBase}/api/v1`,
  wsUrl: `${apiBase.replace(/^http/, 'ws')}/ws/telemetry`,
  pollIntervalMs: 2000,
  missionId: 'ORION-MISSION-2026',
  operatorId: 'OPERATOR_1',
  // Fictional theatre, mirrors Backend/app/services/theatre_rules.py
  homeBase: { lat: 44.316, lon: 23.8 },
};
