# ORION — Rezistența dronelor în război electronic

> **Craiova Hackathon V2.0** — Track: *Ground Control (Critical Infrastructure and Operations)*

ORION este o stație de control la sol (Ground Control Station) pentru drone proprii capabilă să funcționeze sub atacuri de război electronic (GPS spoofing/jamming, comenzi falsificate/replay).

## Idei centrale

1. **Scor de încredere & consens între drone**: Evaluare în timp real (0–100) pe baza senzorilor (GPS, IMU, starea legăturii) și consens de poziție cu dronele vecine.
2. **Răspuns conștient de teatrul de operațiuni**: Recomandări dinamice sigure (evitarea coridoarelor cu bruiaj, blocare Return-to-Home prin zone de risc, reconfigurare patrulă). Operatorul uman decide și aprobă.
3. **Raport post-acțiune (AAR) inviolabil**: Jurnal de evenimente structurat în lanț de hash (append-only) pentru trasabilitate și analiză criminalistică.

## Arhitectură

- **Backend**: Python 3.11, FastAPI, WebSocket, pymavlink, MySQL
- **Frontend**: React 19, TypeScript, Sass, MapLibre GL, Vite
- **Protocol**: MAVLink 2 (telemetrie și comenzi semnate)

## Licență

Acest proiect este licențiat sub licența [MIT](LICENSE).
