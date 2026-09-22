# Proposal: let releases land on the Pi by themselves

**Status:** proposed, not implemented. Nothing in the stack does this today.

Every release so far has needed someone to SSH into the Pi and run `docker compose pull && docker compose up -d`. That's fine at this cadence, but it means a fix can sit published and undeployed for days, and it's the step most likely to be forgotten after a late-night change.

## What it would look like

Add [Watchtower](https://containrrr.dev/watchtower/) to `docker-compose.yml`:

```yaml
  watchtower:
    image: containrrr/watchtower
    command: --label-enable --cleanup --schedule "0 0 5 * * *"
    environment:
      TZ: America/Mexico_City
      # Announces updates through the bot the app already uses
      WATCHTOWER_NOTIFICATION_URL: telegram://${TELEGRAM_BOT_TOKEN}@telegram?chats=${TELEGRAM_CHAT_ID}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    restart: unless-stopped
```

and label the app so Watchtower only manages that one container:

```yaml
  atomix-to-notion:
    labels:
      com.centurylinklabs.watchtower.enable: "true"
```

At 05:00 it checks Docker Hub for a newer image behind the tag in use, pulls it, recreates the container with the same settings, removes the old image, and sends a Telegram message.

## Why this shape

- **Label-scoped.** Without `--label-enable` Watchtower updates everything on the host — including the other stacks on that Pi. With it, only the labelled container is touched.
- **`--cleanup`.** Old image layers would otherwise accumulate on the SD card, which is the one resource the deployment is careful about.
- **Off-hours schedule.** A restart mid-crawl is safe (jobs survive in Redis and an interrupted one is retried), but 05:00 avoids doing it while you're watching the dashboard.
- **Pinning still works.** Watchtower follows whatever `IMAGE_TAG` resolves to. `IMAGE_TAG=latest` tracks releases; `IMAGE_TAG=1.6.0` or `sha-<commit>` freezes the Pi until you change it. That's also the rollback: set the tag to a known-good `sha-` and `docker compose up -d`.

## The cost, plainly

Watchtower needs `/var/run/docker.sock`. Even mounted read-only, that socket is effectively root on the host: anything that compromises the Watchtower container can control Docker. It accepts no inbound connections and is a widely used image, but this is a real trade and the reason it isn't switched on already.

The alternative designs don't avoid it. A CI webhook needs the same socket *plus* an inbound port and an authenticated listener; a cron'd `docker compose pull` on the host avoids the container but needs a root-ish crontab entry and gives no notification.

Doing nothing is also defensible: releases are infrequent, and a manual pull is one command with a human deciding when.

## If you want it

1. Confirm the socket trade is acceptable on that Pi.
2. Add the service and label above, and redeploy once by hand.
3. Watch one release land: push a change, then check for the Telegram message and `docker ps` showing a fresh container.
4. Keep `IMAGE_TAG` unset (or `latest`) for tracking; set it to a version when you want the Pi to hold still.

Should the first automatic update ever go wrong, `IMAGE_TAG=sha-<previous commit>` plus `docker compose up -d` puts it back, and `docker compose stop watchtower` ends the experiment.
