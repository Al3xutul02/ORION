# syntax=docker/dockerfile:1
#
# All-in-one ORION container: Angular Frontend (port 4200) + FastAPI Backend (port 8000) + MySQL 8.0 (port 3306)
# modeled after GamersKeep's all-in-one container architecture.
#
#   docker build -t orion .
#   docker run --rm -p 4200:4200 -p 8000:8000 -v orion-data:/var/lib/mysql orion
#
# Or simply use the PowerShell helper script:
#   .\debug.ps1

# ==============================================================================
# Stage 1: Build the Angular Frontend
# ==============================================================================
FROM node:22-alpine AS frontend-build
WORKDIR /src/frontend
COPY Frontend/package.json Frontend/package-lock.json ./
RUN npm ci
COPY Frontend/ ./
RUN npm run build

# ==============================================================================
# Stage 2: Ubuntu 24.04 Runtime (MySQL 8.0 + Python FastAPI + Nginx Frontend)
# ==============================================================================
FROM ubuntu:24.04 AS final
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

USER root

# Install lightweight MySQL 8.0 server/client binaries, Python 3 venv, and Nginx.
# Because mysql-server-core-8.0 only ships the binaries (no postinst script), we create the 'mysql' system user explicitly.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        mysql-server-core-8.0 \
        mysql-client-core-8.0 \
        python3 \
        python3-venv \
        python3-pip \
        nginx-light \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && (id -u mysql >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/mysql --no-create-home --shell /usr/sbin/nologin mysql) \
    && mkdir -p /var/lib/mysql /var/run/mysqld /run/nginx /app/backend \
    && chown -R mysql:mysql /var/lib/mysql /var/run/mysqld

# Install Backend Python dependencies in an isolated virtual environment
COPY Backend/requirements.txt /app/backend/requirements.txt
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r /app/backend/requirements.txt

# Copy Backend application code
COPY Backend/app /app/backend/app

# Copy compiled Angular SPA to Nginx web root
RUN rm -rf /usr/share/nginx/html/*
COPY --from=frontend-build /src/frontend/dist/frontend/browser /usr/share/nginx/html

# Configure Nginx to serve the Angular SPA on port 4200 and proxy /api and /ws to FastAPI (8000)
COPY <<'EOF' /etc/nginx/sites-available/default
server {
    listen 4200 default_server;
    listen [::]:4200 default_server;
    server_name _;

    root /usr/share/nginx/html;
    index index.html;

    # Angular SPA routing fallback
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Optional reverse-proxy for /api and /ws on the same origin
    location /api/ {
        proxy_pass http://127.0.0.1:8000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:8000/ws/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
EOF

# Startup script: initialise + start MySQL, create the ORION database/user,
# then start Nginx (Frontend on :4200) and Uvicorn (FastAPI Backend on :8000).
COPY <<'EOF' /usr/local/bin/start.sh
#!/bin/bash
set -euo pipefail

DATADIR=/var/lib/mysql
SOCKET=/var/run/mysqld/mysqld.sock

MYSQL_DATABASE="${MYSQL_DATABASE:-orion_gcs}"
MYSQL_USER="${MYSQL_USER:-orion}"

# Reuse the saved password if the persistent volume already has one
if [ -f "$DATADIR/.orion_password" ]; then
    MYSQL_PASSWORD=$(cat "$DATADIR/.orion_password")
elif [ -z "${MYSQL_PASSWORD:-}" ]; then
    MYSQL_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
    echo "[start] Generated MySQL password for '$MYSQL_USER': $MYSQL_PASSWORD"
fi

chown -R mysql:mysql "$DATADIR" /var/run/mysqld

NEEDS_INIT=0
if [ ! -d "$DATADIR/mysql" ]; then
    NEEDS_INIT=1
    echo "[start] Initialising MySQL data directory..."
    mysqld --no-defaults --user=mysql --initialize-insecure --datadir="$DATADIR"
fi

echo "[start] Starting MySQL..."
mysqld --no-defaults \
    --user=mysql \
    --datadir="$DATADIR" \
    --socket="$SOCKET" \
    --pid-file=/var/run/mysqld/mysqld.pid \
    --bind-address=0.0.0.0 --port=3306 \
    --mysqlx=OFF \
    --secure-file-priv=NULL \
    --skip-name-resolve \
    --performance-schema=OFF \
    --innodb-buffer-pool-size=64M \
    --innodb-log-buffer-size=8M \
    --innodb-redo-log-capacity=64M \
    --max-connections=100 \
    --key-buffer-size=8M \
    --tmp-table-size=16M \
    --max-heap-table-size=16M \
    --character-set-server=utf8mb4 \
    --collation-server=utf8mb4_0900_ai_ci &
MYSQL_PID=$!

for _ in $(seq 60); do
    if mysql --socket="$SOCKET" -uroot -e 'SELECT 1' >/dev/null 2>&1; then break; fi
    if ! kill -0 "$MYSQL_PID" 2>/dev/null; then echo "[start] MySQL failed to start." >&2; exit 1; fi
    sleep 1
done

if [ "$NEEDS_INIT" -eq 1 ]; then
    echo "[start] Creating database '$MYSQL_DATABASE' and user '$MYSQL_USER'..."
    mysql --socket="$SOCKET" -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`$MYSQL_DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS '$MYSQL_USER'@'%' IDENTIFIED BY '$MYSQL_PASSWORD';
CREATE USER IF NOT EXISTS '$MYSQL_USER'@'localhost' IDENTIFIED BY '$MYSQL_PASSWORD';
CREATE USER IF NOT EXISTS '$MYSQL_USER'@'127.0.0.1' IDENTIFIED BY '$MYSQL_PASSWORD';
GRANT ALL PRIVILEGES ON \`$MYSQL_DATABASE\`.* TO '$MYSQL_USER'@'%';
GRANT ALL PRIVILEGES ON \`$MYSQL_DATABASE\`.* TO '$MYSQL_USER'@'localhost';
GRANT ALL PRIVILEGES ON \`$MYSQL_DATABASE\`.* TO '$MYSQL_USER'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
    echo "$MYSQL_PASSWORD" > "$DATADIR/.orion_password"
fi

export DB_TYPE="mysql"
export MYSQL_HOST="127.0.0.1"
export MYSQL_PORT="3306"
export MYSQL_DATABASE="$MYSQL_DATABASE"
export MYSQL_USER="$MYSQL_USER"
export MYSQL_PASSWORD="$MYSQL_PASSWORD"

echo "[start] Starting Nginx (Frontend on :4200)..."
nginx -g 'daemon off;' &
NGINX_PID=$!

echo "[start] Starting ORION FastAPI Backend (on :8000)..."
cd /app/backend
/opt/venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 &
APP_PID=$!

# Forward docker stop (SIGTERM) / Ctrl+C to all processes for a clean shutdown.
trap 'kill -TERM "$APP_PID" "$NGINX_PID" "$MYSQL_PID" 2>/dev/null' TERM INT

set +e
wait -n "$APP_PID" "$NGINX_PID" "$MYSQL_PID"
EXIT_CODE=$?
kill -TERM "$APP_PID" "$NGINX_PID" "$MYSQL_PID" 2>/dev/null
wait
exit "$EXIT_CODE"
EOF

# Strip Windows line endings in case this file gets saved with CRLF.
RUN sed -i 's/\r$//' /usr/local/bin/start.sh && chmod 755 /usr/local/bin/start.sh

WORKDIR /app/backend
EXPOSE 4200
EXPOSE 8000
EXPOSE 3306
VOLUME ["/var/lib/mysql"]

ENTRYPOINT ["/usr/local/bin/start.sh"]
