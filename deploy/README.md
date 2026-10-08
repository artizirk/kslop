# Running the relay as a service

`kslop.service` runs `server.ts` under [Bun](https://bun.sh) as a hardened,
capability-free systemd unit. Nothing here is installed for you.

## Install

    # 1. Bun, if it is not already present
    curl -fsSL https://bun.sh/install | bash
    sudo install -m 0755 ~/.bun/bin/bun /usr/local/bin/bun

    # 2. The game, root-owned and read-only to the service
    sudo install -d /opt/kslop /etc/kslop
    sudo cp index.html server.ts /opt/kslop/
    sudo cp -r deploy /opt/kslop/deploy
    sudo chown -R root:root /opt/kslop
    sudo chmod -R a-w /opt/kslop

    # 3. Config and the unit
    sudo install -m 0600 deploy/kslop.env.example /etc/kslop/kslop.env
    sudo install -m 0644 deploy/kslop.service /etc/systemd/system/kslop.service
    sudo systemctl daemon-reload
    sudo systemctl enable --now kslop

    # 4. Watch it and read the reload token
    journalctl -u kslop -f

Nothing is written at runtime, so `ProtectSystem=strict` leaves the whole
filesystem read-only to the service. Editing `/opt/kslop/index.html` pushes a
live reload to every connected client.

## Behind nginx (in another container)

The relay binds `0.0.0.0:8080`; nginx terminates TLS and proxies to the host.
WebSockets need the upgrade headers and a long read timeout:

    server {
      listen 443 ssl;
      server_name play.example.com;
      ssl_certificate     /etc/letsencrypt/live/play.example.com/fullchain.pem;
      ssl_certificate_key /etc/letsencrypt/live/play.example.com/privkey.pem;

      location / {
        proxy_pass http://host.docker.internal:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;
        proxy_set_header X-Real-IP  $remote_addr;   # the relay trusts this from the proxy
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
      }

      # operator endpoints stay on the host
      location = /health { return 404; }
      location = /reload { return 404; }
    }

## Two things the proxy changes

**Every request arrives from the proxy.** Set `TRUSTED_PROXY` in
`/etc/kslop/kslop.env` to the address the relay sees for nginx — otherwise all
players share one address and the 4-connections-per-address limit holds the
whole game to four. Only a trusted peer may set `X-Real-IP` /
`X-Forwarded-For`, so a direct client cannot forge its address. Because nginx
sets `X-Real-IP` from `$remote_addr`, a client cannot spoof it through the
proxy.

**`/health` clients look remote.** The roster is shown only to the operator, so
proxied requests get counts, not names; use the reload token if you need the
full list. Blocking `/health` and `/reload` at the proxy, as above, is the
belt-and-braces option.

## Hardening notes

- The unit runs under `DynamicUser=yes` with an empty `CapabilityBoundingSet` —
  no accounts to create and no privileges to lose.
- `MemoryDenyWriteExecute` is **not** set: Bun's JIT maps writable-executable
  memory and would be killed. The syscall filter is `@system-service`; if a
  future Bun build dies with `SIGSYS`, loosen it (see the comment in the unit).
- `IPAddressAllow` ships allowing loopback and docker's default networks. Tighten
  or correct it if your container network differs (for example `10.0.0.0/8`),
  or the proxy will not be able to connect.
