const limit = 4500 * 60 * 1000;
const reservationWindow = 60 * 60 * 1000;
export const quotaMessage = 'Cuties, I think you’ve talked too much this month. That’s enough! Go do some work, you farigh unemployed log. 🦭💕 Calling resets on the first of next month (UTC).';

const reserveScript = `
if redis.call('EXISTS', KEYS[2]) == 1 then return {-1, 0} end
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local remaining = tonumber(ARGV[1]) - used
local duration = math.min(remaining, tonumber(ARGV[2]))
if duration <= 0 then return {0, 1} end
redis.call('INCRBY', KEYS[1], duration)
redis.call('SET', KEYS[2], duration, 'EX', 172800)
redis.call('EXPIRE', KEYS[1], 3456000)
return {duration, duration == remaining and 1 or 0}
`;

const extendScript = `
local reserved = tonumber(redis.call('GET', KEYS[2]) or '0')
local expected = tonumber(ARGV[1])
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(ARGV[2])
if reserved == 0 or reserved < expected then return {-1, 0} end
if reserved > expected then return {reserved - expected, used >= limit and 1 or 0} end
local remaining = math.max(0, limit - used)
local extra = math.min(remaining, tonumber(ARGV[3]))
if extra > 0 then
  redis.call('INCRBY', KEYS[1], extra)
  redis.call('SET', KEYS[2], reserved + extra, 'EX', 172800)
  redis.call('EXPIRE', KEYS[1], 3456000)
end
return {extra, extra == remaining and 1 or 0}
`;

const releaseScript = `
local reserved = tonumber(redis.call('GET', KEYS[2]) or '0')
if reserved > 0 then
  redis.call('DEL', KEYS[2])
  redis.call('DECRBY', KEYS[1], math.max(0, reserved - tonumber(ARGV[1])))
end
return 1
`;

export function createQuota(secure) {
  const endpoint = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if ((endpoint || token || secure) && (!endpoint || !token || new URL(endpoint).protocol !== 'https:')) {
    throw new Error('Hosted calls require HTTPS Upstash Redis settings for the monthly call limit.');
  }
  let localMonth;
  let localUsed = 0;

  const monthAt = now => new Date(now).toISOString().slice(0, 7);
  const key = month => `rowa:calls:{${month}}:used`;
  function monthEnd(now) {
    const date = new Date(now);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  }

  function makeLease(lease, deadline, exhausted) {
    const renewable = !exhausted && deadline < monthEnd(lease.start);
    return {
      ...lease, deadline, renewable,
      reason: exhausted ? quotaMessage : renewable
        ? 'Could not extend this call. Please call again.'
        : 'It’s a new month. Call again to start using this month’s minutes.'
    };
  }

  function useLocal(month) {
    if (localMonth !== month) {
      localMonth = month;
      localUsed = 0;
    }
    return localUsed;
  }

  async function redis(...command) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(4000),
      redirect: 'error'
    });
    const result = await response.json();
    if (!response.ok || result.error || !Object.hasOwn(result, 'result')) {
      throw new Error('Monthly usage service unavailable.');
    }
    return result.result;
  }

  return {
    async available(now = Date.now()) {
      const month = monthAt(now);
      const used = endpoint ? Number(await redis('GET', key(month))) : useLocal(month);
      return Number.isFinite(used) && used < limit;
    },
    async usage(now = Date.now(), lease) {
      const month = monthAt(now);
      const active = lease?.month === month && now < lease.deadline ? lease : null;
      let unused = active ? Math.max(0, active.deadline - now) : 0;
      let used;
      if (!endpoint) {
        used = useLocal(month) - unused;
      } else if (active) {
        const [total, reserved] = await redis('MGET', key(month), active.reservation);
        unused = Math.min(Number(reserved), unused);
        used = Number(total) - unused;
      } else {
        used = Number(await redis('GET', key(month)));
      }
      if (!Number.isFinite(used)) throw new Error('Invalid monthly usage.');
      return { usedMs: Math.min(limit, Math.max(0, used)), limitMs: limit, runningMs: unused };
    },
    async reserve(id, now = Date.now()) {
      const month = monthAt(now);
      const requested = Math.min(reservationWindow, monthEnd(now) - now);
      const reservation = `rowa:calls:{${month}}:${id}`;
      let duration;
      let exhausted;
      if (endpoint) {
        [duration, exhausted] = await redis('EVAL', reserveScript, 2, key(month), reservation, limit, requested);
        duration = Number(duration);
        exhausted = Number(exhausted);
      } else {
        const remaining = Math.max(0, limit - useLocal(month));
        duration = Math.min(remaining, requested);
        exhausted = duration === remaining;
      }
      if (!Number.isSafeInteger(duration) || duration < 0 || duration > requested) {
        throw new Error('Invalid monthly usage reservation.');
      }
      if (!duration) return null;
      if (!endpoint) localUsed += duration;
      return makeLease({ month, reservation, start: now }, now + duration, exhausted);
    },
    async extend(lease) {
      const requested = Math.min(reservationWindow, monthEnd(lease.start) - lease.deadline);
      if (!lease.renewable || requested <= 0) return lease;
      let extra;
      let exhausted;
      if (endpoint) {
        [extra, exhausted] = await redis('EVAL', extendScript, 2, key(lease.month), lease.reservation,
          lease.deadline - lease.start, limit, requested);
        extra = Number(extra);
        exhausted = Number(exhausted);
      } else {
        const remaining = Math.max(0, limit - useLocal(lease.month));
        extra = Math.min(requested, remaining);
        exhausted = extra === remaining;
      }
      if (!Number.isSafeInteger(extra) || extra < 0 || extra > requested) {
        throw new Error('Invalid monthly usage extension.');
      }
      if (!endpoint) localUsed += extra;
      return makeLease(lease, lease.deadline + extra, exhausted);
    },
    async release(lease, now = Date.now()) {
      const used = Math.max(0, Math.min(lease.deadline, now) - lease.start);
      if (endpoint) {
        await redis('EVAL', releaseScript, 2, key(lease.month), lease.reservation, used);
      } else if (localMonth === lease.month) {
        localUsed -= lease.deadline - lease.start - used;
      }
    }
  };
}
