# ORION — Rezistența dronelor în război electronic

> **Craiova Hackathon V2.0** — Track: *Ground Control (Critical Infrastructure and Operations)*

ORION este o stație de control la sol (Ground Control Station) pentru drone proprii capabilă să funcționeze sub atacuri de război electronic (GPS spoofing/jamming, comenzi falsificate/replay).

## Idei centrale

1. **Scor de încredere & consens între drone**: Evaluare în timp real (0–100) pe baza senzorilor (GPS, IMU, starea legăturii) și consens de poziție cu dronele vecine.
2. **Răspuns conștient de teatrul de operațiuni**: Recomandări dinamice sigure (evitarea coridoarelor cu bruiaj, blocare Return-to-Home prin zone de risc, reconfigurare patrulă). Operatorul uman decide și aprobă.
3. **Raport post-acțiune (AAR) inviolabil**: Jurnal de evenimente structurat în lanț de hash (append-only) pentru trasabilitate și analiză criminalistică.

## Arhitectură

- **Backend**: Python 3.11+, FastAPI, WebSocket, pymavlink, SQLAlchemy, MySQL 8.0
- **Frontend**: Angular, TypeScript, SCSS, MapLibre GL
- **Protocol**: MAVLink 2 (telemetrie și comenzi semnate)

## Rulare cu Docker (Container All-in-One)

Punem la dispoziție un script PowerShell ([`debug.ps1`](debug.ps1)) care construiește și pornește un container all-in-one ([`Dockerfile`](Dockerfile)) ce include **Frontend-ul Angular** (`:4200`), **Backend-ul FastAPI** (`:8000`) și o bază de date persistentă **MySQL 8.0** (`orion_gcs`) care se inițializează automat la prima pornire.

### Utilizare prin PowerShell (`debug.ps1`)
Din rădăcina proiectului (cu Docker Desktop pornit), rulează:

```powershell
# Construiește imaginea, pornește containerul și urmărește log-urile:
.\debug.ps1

# Alte opțiuni:
.\debug.ps1 -NoLogs      # Construiește + pornește în fundal, fără a urmări log-urile
.\debug.ps1 -ExposeDb    # Expune și baza de date MySQL pe 127.0.0.1:3307
.\debug.ps1 -ResetDb     # Șterge volumul persistent al bazei de date (orion-data) și pornește de la zero
.\debug.ps1 -Stop        # Oprește și șterge containerul
```

După pornire:
- **Frontend (Interfața Ground Control)**: `http://localhost:4200`
- **Backend API & Documentație Swagger**: `http://localhost:8000/docs`

### Utilizare prin Docker Compose (Multi-Container)
Alternativ, poți porni stiva ca 3 servicii separate (`mysql`, `backend`, `frontend`) folosind [`docker-compose.yml`](docker-compose.yml):

```powershell
docker compose up --build
```

## Licență

Acest proiect este licențiat sub licența [MIT](LICENSE).
