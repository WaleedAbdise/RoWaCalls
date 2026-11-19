# ROWA Calls

A two-person web app for Waleed Abdullah and Roha Nadeem. It supports browser-to-browser voice and video, incoming calls, decline and hang-up, microphone mute, camera pause, and presence. The app does not record calls. The signaling server keeps sessions and call state in memory and does not store call history.

## Run on this computer

Install Node.js 22 or newer, then run these commands from the project folder.

```sh
npm run setup
npm start
```

Open [http://localhost:3000](http://localhost:3000). The setup command creates a separate access password for each account in the ignored `.env` file. Share only Roha’s password, privately. For a local call, open the page in two browser profiles or use one normal and one private window, then sign in as different people. Wear headphones if you test with two live microphones in the same room.

Keep the signed-in page open to receive calls. Interact with the page after a refresh to enable the ringtone in browsers that require an interaction. On phones, keep the browser in the foreground during calls.

## Deploy for two locations

Confirm that your intended use is permitted under the [UAE TDRA's VoIP rules](https://tdra.gov.ae/en/FAQs). The app has no approved-provider integration. A network, device, or local policy can prevent a call from connecting.

Both people need the same HTTPS URL. Use one always-on Node process behind an HTTPS reverse proxy and a TURN service supporting coturn-compatible temporary credentials. A TURN relay helps connect peers when direct WebRTC traffic cannot pass between networks. It does not guarantee access on either country's networks.

### Render

1. Create a TURN key in [Cloudflare Realtime](https://developers.cloudflare.com/realtime/turn/generate-credentials/). Save its key ID and API token privately. Cloudflare has a [monthly free allowance](https://developers.cloudflare.com/realtime/pricing/) and charges for usage beyond it.
2. [Deploy the ROWA Calls Blueprint on Render](https://render.com/deploy?repo=https://github.com/WaleedAbdise/RoWaCalls). Sign in, connect GitHub, and confirm the Free service plan. If Render asks for repository access, grant access to `WaleedAbdise/RoWaCalls`.
3. Enter `WALEED_PASSWORD` and `ROHA_PASSWORD` from your local `.env`, along with `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN`, in Render's private environment fields. Keep the values out of GitHub. The Blueprint configures the Node service and HTTPS hostname.
4. Open the Render HTTPS URL after deployment succeeds. Sign in with both accounts and verify a call from your actual devices. The free service can sleep when idle, and a wake-up or restart can require signing in again.

### Self-hosted Node

1. Point a domain at your HTTPS hosting server and copy the project there securely. Run `npm run setup` there to generate production passwords, or transfer the existing passwords through a secure channel.
2. Configure your relay with time-limited shared-secret authentication. For coturn, enable `use-auth-secret` and set `static-auth-secret` to a strong private secret. Configure a valid TLS certificate for the relay hostname, allow TLS/TCP and UDP as exposed by your relay URLs, and open the relay's configured allocation port range. Use an authenticated, operational TURN relay before testing remotely.
3. Add the following settings to the server's `.env`, replacing the sample hostnames and secret. The application refuses to start with an HTTPS origin and missing TLS relay settings.

   ```dotenv
   PUBLIC_ORIGIN=https://calls.example.com
   HOST=127.0.0.1
   PORT=3000
   TURN_URLS=turn:relay.example.com:3478?transport=udp,turns:relay.example.com:5349?transport=tcp
   TURN_SECRET=replace-with-the-relay-shared-secret
   ```

4. Run `npm start` under your host's process manager. Point your HTTPS reverse proxy to `127.0.0.1:3000`. For example, with Caddy on the same host:

   ```caddyfile
   calls.example.com {
     reverse_proxy 127.0.0.1:3000
   }
   ```

5. On your actual devices and networks, verify incoming calls, sound in both directions, and video in both directions. Grant camera and microphone access when prompted.

Server restarts end calls and require both people to sign in again. Run a single process because call state and sessions live in process memory. WebRTC encrypts media in transit. The app host and its HTTPS configuration are part of the trust boundary.
