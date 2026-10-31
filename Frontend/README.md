# Frontend

ORION Ground Control UI (Angular 20 + MapLibre GL).

- **Operations** (`/`): theatre map with zones, drones, uncertainty circles and blocked/safe egress paths; per-drone trust scores (GPS, INS, link, peer consensus); the "what is safe now" action matrix with operator approval; the hash-chained after-action log.
- **Radio log** (🎙 PTT in the top bar, or hold Space): each transmission is transcribed by Gemini on the backend and appended to the hash-chained log as `RADIO_TRANSMISSION`, timed from when the mic was keyed; only the text is kept. Demo adds scripted, marked-simulated chatter at the key beats. The copilot quotes transcripts next to the system events of the same minute.
- **3D view** (map button): terrain from the public AWS Terrain Tiles, drones lifted to their altitude on a stalk, threat/interference/weather zones as airspace volumes. Heights are exaggerated ×4 (terrain and drones alike) so the flat Craiova plain and the 120/150 m separation are visible; right-drag to rotate and tilt.
- **AI training** (Demo): 3-minute session where an adversary (Gemini via the backend, or local rules offline) stages attacks; at the end a scored debrief measured from the hash-chained log (`core/training.ts`).
- **Ask ORION** (next to the log): read-only copilot. Answers come only from the hash-chained log and cite records as clickable `#id` links that highlight the row. Needs the backend running with `GEMINI_API_KEY` (see Backend/README.md); in Offline mode the browser sends its own ledger.
- **Report** (`/report`): post-action report with chain verification, attacks, decisions and full timeline. Export as JSON or print to PDF.

Data sources (toggle in the top bar):

- **Live**: FastAPI backend at `http://localhost:8000` (WebSocket `/ws/telemetry` + REST `/api/v1`). Point elsewhere with `?api=http://host:port`.
- **Offline**: an extended version of the 3-minute exercise run in the browser (Plan B). Used automatically if the backend does not answer within 4 s. Supports 1×/2×/4× playback and a tamper test for the hash chain. On top of the backend's beats it adds a second patrol sector (6 drones), a mobile hostile jammer that ORION maps by peer consensus and tracks as it moves, and a command-link loss on D5 handled by the zone-filtered failsafe. In this mode the operator can also command any drone directly.

Map: real basemap of the Craiova area (OpenStreetMap data via OpenFreeMap, no API key) with the exercise zones on top; falls back to a plain grid when offline. Toggle with **Real map / Grid**. The zones and attacks are simulated; nothing on the map is real data.

The backend CORS list allows `http://localhost:4200`, so run the dev server on that port when using Live mode.

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 20.1.1.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Karma](https://karma-runner.github.io) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
