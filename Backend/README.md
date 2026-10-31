# ORION — Backend Ground Control Station (GCS)

> **Craiova Hackathon V2.0** — Track: *Ground Control (Critical Infrastructure and Operations)*  
> **Tehnologii**: Python 3.11+, FastAPI, WebSocket, pymavlink, MySQL 8.0 / SQLite, Cryptography

ORION este o stație de control la sol rezistentă la război electronic (EW). Evaluarea încrederii este calculată în timp real din semnale independente și consens între drone, failsafe-urile riscante (precum Return-to-Home prin zone de bruiaj) sunt blocate inteligent, iar fiecare eveniment este înregistrat într-un jurnal criptografic inviolabil cu lanț de hash (After-Action Report).

---

## 🏛️ Arhitectura Backend

```
Backend/
├── app/
│   ├── api/
│   │   ├── endpoints/
│   │   │   ├── drones.py          # /api/v1/drones (telemetrie, scoruri de încredere, cerc incertitudine)
│   │   │   ├── zones.py           # /api/v1/zones & /api/v1/zones/geojson (bază, coridoare, zone bruiaj)
│   │   │   ├── actions.py         # /api/v1/actions/decide (aprobare operator uman, comenzi semnate)
│   │   │   ├── aar.py             # /api/v1/aar/verify & export (jurnal inviolabil, verificare lanț SHA-256)
│   │   │   └── simulation.py      # /api/v1/simulation (atacuri GPS spoofing, replay, bruiaj sector)
│   │   └── websocket/
│   │       └── telemetry_ws.py    # /ws/telemetry (stream în timp real pentru MapLibre GL)
│   ├── core/
│   │   ├── config.py              # Setări Pydantic (MySQL, MAVLink, CORS)
│   │   ├── database.py            # Conexiune MySQL cu fallback automat la SQLite
│   │   └── security.py            # Lanț de hash SHA-256 & Semnare comenzi MAVLink 2 (HMAC-SHA256)
│   ├── models/                    # Modele SQLAlchemy (telemetry_logs, drone_scores, tactical_zones, audit_log, action_recommendations)
│   ├── schemas/                   # Scheme Pydantic v2 (DTO-uri REST & WebSocket)
│   ├── services/
│   │   ├── mavlink_parser.py      # Parser nativ pymavlink MAVLink 2 (HEARTBEAT, GPS_RAW_INT, etc.)
│   │   ├── trust_evaluator.py     # Scorul de încredere (0-100), dead reckoning & consens vecini
│   │   ├── theatre_rules.py       # Reguli de teatru: blocare RTL prin zone EW, rute alternative
│   │   ├── aar_service.py         # Jurnal append-only tamper-evident & verificare lanț
│   │   ├── command_manager.py     # Aprobare operator, dispatch semnat, respingere comenzi reluate (replay)
│   │   └── simulator.py           # Simulator flotă 4 drone (scenariu demo 3 minute)
│   └── scripts/
│       ├── create_mysql_user.sql  # Script MySQL: utilizator cu drept exclusiv de INSERT pe audit_log
│       └── init_db.py             # Inițializare tabele & seed date tactice
├── tests/                         # Suită completă pytest (14 teste unitare & integrare)
├── requirements.txt               # Dependențe backend
├── run.py                         # Punct de lansare server dezvoltare
└── .env                           # Variabile de mediu
```

---

## 🚀 Pornire Rapidă

### 1. Activare mediu virtual & instalare dependențe
Mediu virtual deja configurat în `Backend/.venv`:
```powershell
cd Backend
.\.venv\Scripts\pip install -r requirements.txt
```

### 2. Configurare Bază de Date (MySQL / SQLite)
Fișierul `.env` conține configurarea:
```env
DB_TYPE=mysql
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=parola_ta_mysql
MYSQL_DATABASE=orion_gcs
SQLITE_DB_PATH=./orion_gcs.db
```
> **Notă**: Dacă serverul MySQL local nu este configurat sau parola diferă, aplicația comută **automat și transparent** pe baza de date SQLite locală (`orion_gcs.db`), asigurând funcționarea continuă fără blocaje.

Pentru securizarea MySQL la nivel de bază de date (cerința din specificație: utilizator fără drept de `UPDATE` sau `DELETE` pe `audit_log`):
```powershell
mysql -u root -p < app/scripts/create_mysql_user.sql
```

### 3. Lansare Server Backend
```powershell
.\.venv\Scripts\python.exe run.py
```
Serverul va porni la:
- **API Swagger Docs**: [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)
- **ReDoc**: [http://127.0.0.1:8000/redoc](http://127.0.0.1:8000/redoc)
- **WebSocket Telemetrie Live**: `ws://127.0.0.1:8000/ws/telemetry`

---

## 🧪 Rulare Teste

```powershell
.\.venv\Scripts\python.exe -m pytest tests -v
```
Toate cele 14 teste verifică:
1. Integritatea lanțului criptografic SHA-256 și detecția modificării oricărei înregistrări.
2. Scăderea scorului de încredere sub 35 și marcarea cu roșu la salturi imposibile de poziție (GPS spoofing).
3. Blocarea failsafe-ului Return-to-Home când ruta intersectează zona de bruiaj.
4. Semnarea MAVLink 2 și respingerea tentativelor de replay attack.
5. Endpoint-urile REST și formatul GeoJSON pentru MapLibre GL.

`tests/test_copilot.py` adaugă 7 teste pentru copilot (cu un client Claude simulat, fără apeluri reale).

---

## 🤖 Copilot AAR (doar citire)

`POST /api/v1/copilot/ask` răspunde la întrebări despre misiune **doar din jurnalul cu lanț de hash** și citează înregistrările (`[#12]`). Nu are unelte, nu trimite comenzi și nu scrie nimic. Citările inexistente în jurnal sunt eliminate de server.

- Folosește **Gemini API** (SDK-ul `google-genai`) și necesită acces la internet.
- Cheia: `GEMINI_API_KEY` în `.env` sau în mediu (se creează gratuit din [Google AI Studio](https://aistudio.google.com/apikey)). Fără cheie, endpoint-ul răspunde `503` cu un mesaj clar; restul aplicației funcționează normal.
- Model: `COPILOT_MODEL` (implicit `gemini-3.8-flash`); dacă e supraîncărcat (503/504), răspunde `COPILOT_FALLBACK_MODEL` (implicit `gemini-3.5-flash-lite`), nivel de gândire: `COPILOT_EFFORT` (`low` / `medium` / `high`, implicit `low`, pentru răspunsuri rapide).
- În modul Offline, frontend-ul trimite propriul jurnal din browser (`events`) și rezultatul verificării lanțului (`chain_valid`).

---

## 📡 MAVLink 2 & Protocol

Aplicația implementează nativ parserul `pymavlink` pentru pachetele cerute:
| Mesaj MAVLink | Câmpuri Utilizate | Rol în ORION |
|---|---|---|
| `HEARTBEAT` | `base_mode`, `custom_mode`, `system_status` | Stare dronă activă, detecție schimbare mod |
| `GPS_RAW_INT` | `fix_type`, `satellites_visible`, `eph` (HDOP) | Evaluare calitate semnal GPS |
| `GLOBAL_POSITION_INT` | `lat`, `lon`, `alt`, `vx`, `vy`, `heading` | Cinematică, dead reckoning, consens vecini |
| `SYS_STATUS` | `battery_remaining`, `drop_rate_comm` | Sănătate legătură radio și autopilot |
| `RADIO_STATUS` | `rssi`, `noise` | Raport semnal/zgomot legătură de comandă |
| `COMMAND_LONG` | `command`, `params`, `signature` | Comenzi semnate criptografic (RTL, Loiter) |

### Integrare QGroundControl / SITL (`services/mavlink_bridge.py`)

**ORION → QGroundControl.** Fiecare dronă simulată e publicată ca vehicul MAVLink 2 real pe UDP
`127.0.0.1:14550` (portul pe care QGroundControl ascultă implicit): sysid = 100 + id dronă
(D1 → 101 … D4 → 104), HEARTBEAT (ArduCopter), GLOBAL_POSITION_INT, GPS_RAW_INT, SYS_STATUS,
RADIO_STATUS la 2 Hz. Deschide QGroundControl și dronele apar singure. Se trimite poziția
*raportată*, deci o dronă spoofată apare în QGC la poziția falsă, iar ORION o marchează ca suspectă.

**SITL / drone reale → ORION.** ORION ascultă pe UDP `0.0.0.0:14560`. Orice vehicul MAVLink
trimis acolo intră în flotă ca dronă 200 + sysid, cu sursa `MAVLINK`, și trece prin același scor de
încredere. Exemple:

```bash
# ArduPilot SITL
sim_vehicle.py -v ArduCopter --out=udp:127.0.0.1:14560
# QGroundControl: Application Settings → MAVLink → MAVLink forwarding → host 127.0.0.1:14560
```

Vehiculele externe sunt **doar citire**: ORION nu le trimite comenzi (comandă rămâne în GCS-ul lor).
Dronele proprii (sysid 101–199) și stațiile de sol (`MAV_TYPE_GCS`) sunt ignorate la intrare, ca
forwarding-ul să nu facă buclă. Un vehicul tăcut 5 s dispare din flotă.

Stare: `GET /api/v1/mavlink/status`. Configurare (`.env`): `MAVLINK_OUT_ENABLED`, `MAVLINK_OUT_HOST`,
`MAVLINK_OUT_PORT`, `MAVLINK_IN_ENABLED`, `MAVLINK_IN_HOST`, `MAVLINK_IN_PORT`. În Docker,
`debug.ps1` și `docker-compose.yml` publică UDP 14560 și trimit către `host.docker.internal:14550`.

---

## 🎬 Scenariul Demo de 3 Minute (Scriptat)

Simulatorul integrat rulează cronologia pitch-ului specificată în document:
- **0:00 — Context**: 4 drone patrulează în sector; bază, coridor sigur și 2 zone tactice; totul verde.
- **0:30 — Spoofing GPS pe Drona 2**: Poziția sare ~450m, sateliții scad la 4, eph crește. Scorul scade în <3s, drona devine roșie și apare cercul de incertitudine.
- **1:00 — Decizie sigură**: Calea directă spre bază trece prin zona de bruiaj. ORION blochează Return-to-Home și recomandă LOITER + retragere pe coridorul sigur. Operatorul aprobă.
- **1:40 — Comandă falsă (Replay)**: O comandă veche este retransmisă; sistemul o respinge (`COMMAND_REPLAY_REJECTED`) și o notează în jurnal.
- **2:10 — Interferență de zonă**: Două drone (1 și 3) pierd GPS; consensul marchează sectorul ca zonă de bruiaj și re-alocă patrula.
- **2:40 — Raport**: Export raport post-acțiune (`/api/v1/aar/export`) cu lanțul de hash verificat matematic (`/api/v1/aar/verify`).
