# Running a master server

The master server keeps the public server list, handles friends, and optionally Discord login for the launcher. It needs Node 22.13 or newer and has no npm dependencies.

```sh
cd master-server
npm start
```

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `30180` | Port to listen on |
| `PUBLIC_URL` | `http://localhost:<PORT>` | The address players reach it at. Used for the Discord redirect |
| `DB_FILE` | `master-server/data/projectvi.db` | SQLite file for accounts, sessions and favorites |
| `DISCORD_CLIENT_ID` | | Turns login on, together with the secret |
| `DISCORD_CLIENT_SECRET` | | Keep this private. It never leaves the master server |

## Production

- Put it behind HTTPS, for example with Caddy or nginx as a reverse proxy. The launcher only talks to master servers over `https://`, except on the same PC.
- Back up `DB_FILE`. Losing it logs everyone out and clears synced favorites. The server list itself isn't stored.

## Turning on Discord login

Login is optional. Without it, the launcher shows "This master server doesn't offer logging in" and everything else works.

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application named after your community.
2. Under **OAuth2**:
   - Copy the **Client ID**.
   - Reset and copy the **Client Secret**.
   - Add a redirect: `<PUBLIC_URL>/auth/discord/callback`, for example `https://list.example.com/auth/discord/callback`. For local testing, use `http://localhost:30180/auth/discord/callback`.
3. Start the server with the values:

   ```powershell
   $env:DISCORD_CLIENT_ID = "…"
   $env:DISCORD_CLIENT_SECRET = "…"
   $env:PUBLIC_URL = "https://list.example.com"
   npm start
   ```

   The startup log says `Discord login is on` and prints the redirect URL to register.

## What's stored

Only what's needed:

| Table | Contents |
| --- | --- |
| `users` | Discord user id, username, display name, avatar hash, first and last login time. Guests: a random id and their in-game name. Everyone with friends: a friend code, whether they take friend requests, a color and an optional picture (up to 32 KB) |
| `sessions` | SHA-256 of each launcher session token (never the token itself), with a 90-day expiry |
| `favorites` | Server ids a logged-in player starred, if they turned on favorites sync |
| `friends`, `friend_requests` | Who is friends with whom, and requests waiting, with their times |
| `messages` | Messages between friends: sender, receiver, text, sent and read time. Deleted after 30 days, or when the two stop being friends |

Who is online and on which server is only kept in memory. Guest accounts are made when a player turns on friends without logging in; they are deleted once their session is gone, and merged into the Discord account when the guest logs in.

Only Discord's `identify` scope is requested: no email, servers or friends.

## How login works

1. The launcher opens `/auth/discord/start` in the player's browser, with a random state, a loopback port and the SHA-256 of a secret verifier.
2. The master server sends the browser to Discord, receives the code back, and fetches the player's profile with the client secret.
3. The browser is sent to `http://127.0.0.1:<port>/callback` with a one-time code. The code is valid for 60 seconds and for a single try.
4. The launcher exchanges that code plus its verifier for a session token. It stores the token encrypted with Windows DPAPI, through Electron's safeStorage.

If someone intercepts the one-time code, it's useless without the verifier, which never leaves the launcher.
