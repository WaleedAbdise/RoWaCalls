import { createServer } from 'node:http';
import { createHash, createHmac, randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createQuota, quotaMessage } from './quota.mjs';
import { videoFilters } from './public/video-filters.js';

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
const directOnly = process.env.DIRECT_ONLY === 'true';
const stun = { urls: 'stun:stun.cloudflare.com:3478' };
const turnLifetime = 4 * 3600;
if (secure && !directOnly && !meteredTurn && !managedTurn && (!turnUrls.some(url => url.startsWith('turns:')) || !turnSecret)) {
  throw new Error('HTTPS deployment requires a configured TLS TURN relay.');
}

const sessions = new Map();
const attempts = new Map();
const sessionDuration = 7 * 86400;
let call = null;
const pendingRefunds = new Set();

const staticFiles = new Map([
  ['/', ['index.html', 'text/html']],
  ['/style.css', ['style.css', 'text/css']],
  ['/video-filters.js', ['video-filters.js', 'text/javascript']],
  ['/theme.js', ['theme.js', 'text/javascript']],
  ['/app.js', ['app.js', 'text/javascript']]
].map(([path, [file, type]]) => [path, { type, body: readFileSync(new URL(`./public/${file}`, import.meta.url)) }]));
const galleryDirectory = process.env.GALLERY_DIRECTORY || fileURLToPath(new URL('./images/', import.meta.url));
const photoTypes = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.webp', 'image/webp'], ['.avif', 'image/avif'], ['.gif', 'image/gif']
]);
const bundledPhotos = new Map();
try {
  const bundle = JSON.parse(readFileSync(
    process.env.GALLERY_BUNDLE_FILE || '/etc/secrets/rowa-gallery.json', 'utf8'
  ));
  for (const [name, encoded] of Object.entries(bundle)) {
    if (!/^[0-9]+\.jpg$/.test(name) || typeof encoded !== 'string') {
      throw new Error('Invalid photo bundle entry.');
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      throw new Error('Invalid photo bundle entry.');
    }
    bundledPhotos.set(name, bytes);
  }
} catch (error) {
  if (error.code !== 'ENOENT') console.error('Could not load the private photo bundle.');
  bundledPhotos.clear();
}

async function gallery(reqPath, res) {
  if (reqPath === '/api/gallery') {
    if (bundledPhotos.size) {
      return json(res, 200, [...bundledPhotos.keys()].map(name => '/api/gallery/' + name));
    }
    const entries = await readdir(galleryDirectory, { withFileTypes: true }).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return [];
    });
    const photos = entries.filter(file => file.isFile() && photoTypes.has(extname(file.name).toLowerCase()))
      .map(file => file.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return json(res, 200, photos.map(name => '/api/gallery/' + encodeURIComponent(name)));
  }
  const name = decodeURIComponent(reqPath.slice('/api/gallery/'.length));
  const type = photoTypes.get(extname(name).toLowerCase());
  if (!type || /[/\\\x00]/.test(name)) return json(res, 404, { error: 'Photo unavailable.' });
  if (bundledPhotos.size) {
    const bytes = bundledPhotos.get(name);
    if (!bytes) return json(res, 404, { error: 'Photo unavailable.' });
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length });
    return res.end(bytes);
  }
  const file = await open(join(galleryDirectory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(error => {
      if (!['ENOENT', 'ELOOP'].includes(error.code)) throw error;
      return null;
    });
  if (!file) return json(res, 404, { error: 'Photo unavailable.' });
  const stat = await file.stat().catch(async error => {
    await file.close();
    throw error;
  });
  if (!stat.isFile()) {
    await file.close();
    return json(res, 404, { error: 'Photo unavailable.' });
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size });
  const stream = file.createReadStream();
  stream.on('error', error => res.destroy(error));
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

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
  if (directOnly) return [stun];
  if (managedTurn) {
    const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(turnKeyId)}/credentials/generate-ice-servers`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${turnToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: turnLifetime }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error('TURN credentials unavailable.');
    const data = await response.json();
    return requireTlsRelay(data.iceServers);
  }
  if (meteredTurn) {
    const url = new URL(`https://${meteredApp}.metered.live/api/v1/turn/credentials`);
    url.searchParams.set('apiKey', meteredKey);
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) throw new Error('TURN credentials unavailable.');
    return requireTlsRelay(await response.json());
  }
  if (!turnUrls.length || !turnSecret) return [];
  const username = `${Math.floor(Date.now() / 1000) + turnLifetime}:${id}`;
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
    now - (sessions.get(id)?.seen || 0) > (state === 'active' ? 120000 : 45000));
  if (state === 'ended') {
    if (now - updated > 10000) call = null;
  } else if (call.lease && now >= call.lease.deadline) {
    endCall(call.lease.reason);
  } else if (missing || (state === 'ringing' && now - updated > 45000)) {
    endCall(missing ? 'Your partner lost connection to the call room.' : 'No answer.');
  } else if (state === 'active' && call.lease.renewable && call.lease.deadline - now <= 5 * 60000 &&
      now >= (call.nextRenewal || 0)) {
    call.nextRenewal = now + 15000;
    void renewCall(call);
  }
}

async function renewCall(activeCall) {
  try {
    const lease = await quota.extend(activeCall.lease);
    if (call === activeCall) activeCall.lease = lease;
  } catch {
    console.error('Could not extend the call time reservation. Will retry.');
  }
}

function callTime(lease, now) {
  return lease ? {
    remainingMs: Math.max(0, lease.deadline - now), deadline: lease.deadline, cutoffMessage: lease.reason
  } : {};
}

function endCall(reason) {
  const lease = call.lease;
  call = { id: call.id, caller: call.caller, callee: call.callee, state: 'ended', reason, updated: Date.now() };
  if (lease) refundTime(lease);
}

function refundTime(lease, endedAt = Date.now()) {
  const refund = quota.release(lease, endedAt).catch(() => console.error('Could not return unused call time.'));
  pendingRefunds.add(refund);
  void refund.then(() => pendingRefunds.delete(refund));
}

function snapshot(id, session, now) {
  const visible = call && (call.caller === id || call.callee === id ||
    (call.state === 'ringing' && sessions.get(call.caller)?.user !== session.user));
  let current = null;
  if (visible) {
    const outgoing = call.caller === id;
    current = {
      id: call.id, state: call.state, outgoing, mode: call.mode,
      round: call.round, restartRequested: outgoing ? call.restartRequested : undefined,
      offer: outgoing ? undefined : call.offer,
      answer: outgoing ? call.answer : undefined,
      candidates: (outgoing ? call.calleeCandidates : call.callerCandidates) || [],
      partnerFilter: outgoing ? call.calleeFilter : call.callerFilter,
      ...callTime(call.lease, now),
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
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self' blob:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
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
    if (req.method === 'GET' && (path === '/api/gallery' || path.startsWith('/api/gallery/'))) {
      return await gallery(path, res);
    }
    session.seen = now;
    expire(now);
    if (path === '/api/state' && req.method === 'GET') {
      return json(res, 200, { user: session.user, ...snapshot(id, session, now) });
    }
    if (path === '/api/usage' && req.method === 'GET') {
      try {
        await Promise.all(pendingRefunds);
        expire(Date.now());
        await Promise.all(pendingRefunds);
        return json(res, 200, await quota.usage(Date.now(), call?.lease));
      } catch {
        return json(res, 503, { error: 'Monthly call usage is unavailable.' });
      }
    }
    if (path === '/api/ice' && req.method === 'GET') {
      try {
        const requestedCall = new URL(req.url, origin).searchParams.get('call');
        const renewing = call?.state === 'active' && call.id === requestedCall && [call.caller, call.callee].includes(id);
        if (!renewing) {
          await Promise.all(pendingRefunds);
          if (!(await quota.available())) return json(res, 429, { error: quotaMessage });
        }
      } catch {
        return json(res, 503, { error: 'Monthly call usage is unavailable.' });
      }
      const servers = await iceServers(session.user).catch(() => []);
      return json(res, 200, servers.some(server => [server?.urls].flat().includes(stun.urls))
        ? servers : [stun, ...servers]);
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
      await Promise.all(pendingRefunds);
      const available = await quota.available().catch(() => null);
      if (!available) {
        return json(res, available === false ? 429 : 503, { error: available === false ? quotaMessage : 'Monthly call usage is unavailable.' });
      }
      if (call && call.state !== 'ended') return json(res, 409, { error: 'A call is already in progress.' });
      if (!['voice', 'video'].includes(data.mode) || typeof data.sdp !== 'string') throw new Error('Invalid offer.');
      call = {
        id: randomUUID(), caller: id, callee: null, mode: data.mode, state: 'ringing', round: 0,
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
        if (lease) refundTime(lease, lease.start);
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
      return json(res, 200, callTime(lease, Date.now()));
    } else if (data.action === 'decline' && invited) {
      call.callee = id;
      endCall('Call declined.');
    } else if (data.action === 'end' && (isCaller || isCallee)) {
      endCall('Call ended.');
    } else if (data.action === 'filter' && (isCaller || isCallee) &&
        call.state === 'active' && call.mode === 'video') {
      if (typeof data.filter !== 'string' || !Object.hasOwn(videoFilters, data.filter)) {
        return json(res, 400, { error: 'Choose a video filter from the list.' });
      }
      call[isCaller ? 'callerFilter' : 'calleeFilter'] = data.filter;
    } else if (data.action === 'request-restart' && isCallee && call.state === 'active') {
      if (data.round === call.round && call.answer) call.restartRequested = true;
    } else if (data.action === 'restart' && isCaller && call.state === 'active') {
      if (data.round === call.round && call.offer.sdp === data.sdp) return json(res, 200, {});
      if (data.round !== call.round + 1 || !call.answer || typeof data.sdp !== 'string') return conflict();
      call.round = data.round;
      call.offer = { type: 'offer', sdp: data.sdp };
      call.answer = null;
      call.restartRequested = false;
      call.callerCandidates = [];
      call.calleeCandidates = [];
    } else if (data.action === 'restart-answer' && isCallee && call.state === 'active') {
      if (data.round !== call.round || call.round === 0 || typeof data.sdp !== 'string') return conflict();
      if (call.answer && call.answer.sdp !== data.sdp) return conflict();
      call.answer = { type: 'answer', sdp: data.sdp };
    } else if (['candidate', 'candidates'].includes(data.action) && (isCaller || isCallee)) {
      if ((data.round ?? 0) !== call.round) return conflict();
      const batch = data.action === 'candidate' ? [data.candidate] : data.candidates;
      if (!Array.isArray(batch) || batch.length > 16 ||
          batch.some(candidate => typeof candidate?.candidate !== 'string')) throw new Error('Invalid ICE candidates.');
      const list = isCaller ? call.callerCandidates : call.calleeCandidates;
      for (const candidate of batch) {
        const duplicate = list.some(existing => existing.candidate === candidate.candidate &&
          existing.sdpMid === candidate.sdpMid && existing.sdpMLineIndex === candidate.sdpMLineIndex);
        if (!duplicate && list.length < 256) list.push(candidate);
      }
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
