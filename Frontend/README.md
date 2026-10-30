# Frontend

ORION Ground Control UI (Angular 20 + MapLibre GL).

- **Operations** (`/`): theatre map with zones, drones, uncertainty circles and blocked/safe egress paths; per-drone trust scores (GPS, INS, link, peer consensus); the "what is safe now" action matrix with operator approval; the hash-chained after-action log.
- **Report** (`/report`): post-action report with chain verification, attacks, decisions and full timeline. Export as JSON or print to PDF.

Data sources (toggle in the top bar):

- **Live**: FastAPI backend at `http://localhost:8000` (WebSocket `/ws/telemetry` + REST `/api/v1`). Point elsewhere with `?api=http://host:port`.
- **Offline**: the same 3-minute demo timeline run in the browser (Plan B). Used automatically if the backend does not answer within 4 s. Supports 1×/2×/4× playback and a tamper test for the hash chain.

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
