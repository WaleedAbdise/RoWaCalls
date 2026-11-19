import { createServer } from 'node:http';
import { createHash, createHmac, randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createQuota, quotaMessage } from './quota.mjs';

const accounts = {
  waleed: { name: 'Waleed Abdullah', password: process.env.WALEED_PASSWORD },
  roha: { name: 'Roha Nadeem', password: process.env.ROHA_PASSWORD }
};
const digest = value => createHash('sha256').update(value).digest();
if (Object.values(accounts).some(account => !account.password || account.password.length < 20) ||
    accounts.waleed.password === accounts.roha.password) {
  throw new Error('Set separate passwords of at least 20 characters, or run npm run setup.');
}
for (const account of Object.values(accounts)) account.hash = digest(account.password);

const origin = new URL(process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000');
const secure = origin.protocol === 'https:';
const quota = createQuota(secure);
const turnUrls = (process.env.TURN_URLS || '').split(',').map(url => url.trim()).filter(Boolean);
const turnSecret = process.env.TURN_SECRET;
const turnKeyId = process.env.CLOUDFLARE_TURN_KEY_ID;
const turnToken = process.env.CLOUDFLARE_TURN_API_TOKEN;
const managedTurn = !!(turnKeyId && turnToken);
const meteredApp = process.env.METERED_TURN_APP;
const meteredKey = process.env.METERED_TURN_API_KEY;
const meteredTurn = !!(meteredKey && /^[a-z0-9-]+$/.test(meteredApp || ''));
if (secure && !meteredTurn && !managedTurn && (!turnUrls.some(url => url.startsWith('turns:')) || !turnSecret)) {
  throw new Error('HTTPS deployment requires a configured TLS TURN relay.');
}

const sessions = new Map();
const attempts = new Map();
const sessionDuration = 7 * 86400;
let call = null;

const staticFiles = new Map([
  ['/', ['index.html', 'text/html']],
  ['/style.css', ['style.css', 'text/css']],
  ['/app.js', ['app.js', 'text/javascript']]
].map(([path, [file, type]]) => [path, { type, body: readFileSync(new URL(`./public/${file}`, import.meta.url)) }]));

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function body(req) {
  if (req.headers['content-type'] !== 'application/json') throw new Error('Expected JSON.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new Error('Request too large.');
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid JSON.');
  return data;
}

async function iceServers(id) {
  if (meteredTurn) {
    const url = new URL(`https://${meteredApp}.metered.live/api/v1/turn/credentials`);
    url.searchParams.set('apiKey', meteredKey);
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) throw new Error('TURN credentials unavailable.');
    return requireTlsRelay(await response.json());
  }
  if (managedTurn) {
    const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(turnKeyId)}/credentials/generate-ice-servers`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${turnToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 3600 }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error('TURN credentials unavailable.');
    const data = await response.json();
    return requireTlsRelay(data.iceServers);
  }
  if (!turnUrls.length || !turnSecret) return [];
  const username = `${Math.floor(Date.now() / 1000) + 3600}:${id}`;
  const credential = createHmac('sha1', turnSecret).update(username).digest('base64');
  return [{ urls: turnUrls, username, credential }];
}

function requireTlsRelay(servers) {
  if (!Array.isArray(servers) || !servers.some(server =>
    [server?.urls].flat().some(url => typeof url === 'string' && url.startsWith('turns:'))
  )) throw new Error('TURN credentials unavailable.');
  return servers;
}

function expire(now) {
  if (!call) return;
  const { caller, callee, state, updated } = call;
  const missing = [caller, callee].filter(Boolean).some(id =>
    now - (sessions.get(id)?.seen || 0) > 30000);
  if (state === 'ended') {
    if (now - updated > 10000) call = null;
  } else if (call.lease && now >= call.lease.deadline) {
    endCall(call.lease.reason);
  } else if (missing || (state === 'ringing' && now - updated > 45000)) {
    endCall(missing ? 'Connection lost.' : 'No answer.');
  }
}

function endCall(reason) {
  const lease = call.lease;
  call = { id: call.id, caller: call.caller, callee: call.callee, state: 'ended', reason, updated: Date.now() };
  if (lease) void quota.release(lease).catch(() => console.error('Could not return unused call time.'));
}

function snapshot(id, session, now) {
  const visible = call && (call.caller === id || call.callee === id ||
    (call.state === 'ringing' && sessions.get(call.caller)?.user !== session.user));
  let current = null;
  if (visible) {
    const outgoing = call.caller === id;
    current = {
      id: call.id, state: call.state, outgoing, mode: call.mode,
      offer: outgoing ? undefined : call.offer,
      answer: outgoing ? call.answer : undefined,
      candidates: (outgoing ? call.calleeCandidates : call.callerCandidates) || [],
      remainingMs: call.lease ? Math.max(0, call.lease.deadline - now) : undefined,
      cutoffMessage: call.lease?.reason,
      reason: call.reason
    };
  }
  const online = [...sessions.values()].some(other => other.user !== session.user && now - other.seen < 10000);
  return { online, call: current };
}

const cookieName = secure ? '__Host-rowa' : 'rowa';
function cookie(value, age) {
  return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
}

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  const path = req.url.split('?')[0];
  const now = Date.now();

  try {
    if (req.method === 'GET' && staticFiles.has(path)) {
      const file = staticFiles.get(path);
      res.writeHead(200, { 'Content-Type': `${file.type}; charset=utf-8` });
      return res.end(file.body);
    }
    if (req.method === 'POST' && req.headers.origin !== origin.origin) {
      return json(res, 403, { error: 'Open ROWA Calls at its configured address.' });
    }

    const id = req.headers.cookie?.split(/;\s*/).find(value => value.startsWith(`${cookieName}=`))?.split('=')[1];
    const session = sessions.get(id);
    if (path === '/api/login' && req.method === 'POST') {
      const key = req.socket.remoteAddress;
      const count = attempts.get(key) || { count: 0, until: now + 60000 };
      if (count.until <= now) {
        count.count = 0;
        count.until = now + 60000;
      }
      if (++count.count > 20) return json(res, 429, { error: 'Too many attempts. Try again in a minute.' });
      attempts.set(key, count);
      const { user, password } = await body(req);
      const account = typeof user === 'string' && Object.hasOwn(accounts, user) ? accounts[user] : null;
      if (!account || typeof password !== 'string' || !timingSafeEqual(digest(password), account.hash)) {
        return json(res, 401, { error: 'Check your name and access password.' });
      }
      if (session) {
        if (call?.state !== 'ended' && call && (call.caller === id || call.callee === id)) endCall('Call ended.');
        sessions.delete(id);
      }
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, { user, seen: now, expires: now + sessionDuration * 1000 });
      res.setHeader('Set-Cookie', cookie(token, sessionDuration));
      return json(res, 200, {});
    }
    if (!session || session.expires <= now) return json(res, 401, { error: 'Sign in to continue.' });
    expire(now);
    session.seen = now;
    if (path === '/api/state' && req.method === 'GET') {
      return json(res, 200, { user: session.user, ...snapshot(id, session, now) });
    }
    if (path === '/api/ice' && req.method === 'GET') {
      try {
        if (!(await quota.available())) return json(res, 429, { error: quotaMessage });
        return json(res, 200, await iceServers(session.user));
      } catch {
        return json(res, 503, { error: 'The call relay is unavailable. Try again shortly.' });
      }
    }
    if (path === '/api/logout' && req.method === 'POST') {
      if (call && call.state !== 'ended' && [call.caller, call.callee].includes(id)) endCall('Call ended.');
      sessions.delete(id);
      res.setHeader('Set-Cookie', cookie('', 0));
      return json(res, 200, {});
    }
    if (path !== '/api/call' || req.method !== 'POST') return json(res, 404, { error: 'Unknown request.' });

    const data = await body(req);
    if (!sessions.has(id)) return json(res, 401, { error: 'Sign in to continue.' });
    const conflict = () => json(res, 409, { error: 'This call is no longer available.' });
    if (data.action === 'start') {
      const available = await quota.available().catch(() => null);
      if (!available) {
        return json(res, available === false ? 429 : 503, { error: available === false ? quotaMessage : 'Monthly call usage is unavailable.' });
      }
      if (call && call.state !== 'ended') return json(res, 409, { error: 'A call is already in progress.' });
      if (!['voice', 'video'].includes(data.mode) || typeof data.sdp !== 'string') throw new Error('Invalid offer.');
      call = {
        id: randomUUID(), caller: id, callee: null, mode: data.mode, state: 'ringing',
        offer: { type: 'offer', sdp: data.sdp }, callerCandidates: [], calleeCandidates: [], updated: Date.now()
      };
      return json(res, 200, { id: call.id });
    }
    if (!call || call.id !== data.id || call.state === 'ended') return conflict();
    const isCaller = call.caller === id;
    const isCallee = call.callee === id;
    const invited = call.state === 'ringing' && sessions.get(call.caller)?.user !== session.user;
    if (data.action === 'accept' && invited && !call.accepting) {
      if (typeof data.sdp !== 'string') throw new Error('Invalid answer.');
      const ringing = call;
      ringing.accepting = true;
      let lease;
      try {
        lease = await quota.reserve(ringing.id);
      } catch {
        return json(res, 503, { error: 'Monthly call usage is unavailable.' });
      } finally {
        ringing.accepting = false;
      }
      if (call !== ringing || !sessions.has(id)) {
        if (lease) void quota.release(lease, lease.start).catch(() => console.error('Could not return unused call time.'));
        return conflict();
      }
      if (!lease) {
        endCall(quotaMessage);
        return json(res, 429, { error: quotaMessage });
      }
      call.callee = id;
      call.answer = { type: 'answer', sdp: data.sdp };
      call.state = 'active';
      call.lease = lease;
      call.updated = Date.now();
      return json(res, 200, {
        remainingMs: Math.max(0, lease.deadline - Date.now()), cutoffMessage: lease.reason
      });
    } else if (data.action === 'decline' && invited) {
      call.callee = id;
      endCall('Call declined.');
    } else if (data.action === 'end' && (isCaller || isCallee)) {
      endCall('Call ended.');
    } else if (data.action === 'candidate' && (isCaller || isCallee)) {
      const list = isCaller ? call.callerCandidates : call.calleeCandidates;
      if (typeof data.candidate?.candidate !== 'string' || list.length >= 128) throw new Error('Invalid ICE candidate.');
      list.push(data.candidate);
    } else {
      return conflict();
    }
    return json(res, 200, {});
  } catch {
    if (!res.headersSent) json(res, 400, { error: 'The request could not be processed.' });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) if (session.expires <= now) sessions.delete(id);
  for (const [key, attempt] of attempts) if (attempt.until <= now) attempts.delete(key);
  expire(now);
}, 5000).unref();

server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
  console.log(`ROWA Calls is ready at ${origin.origin}`);
});
