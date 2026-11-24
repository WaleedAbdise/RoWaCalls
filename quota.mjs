const limit = 4500 * 60 * 1000;
const maxCall = 60 * 60 * 1000;
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
    async reserve(id, now = Date.now()) {
      const month = monthAt(now);
      const date = new Date(now);
      const rollover = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
      const requested = Math.min(maxCall, rollover - now);
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
      return { month, reservation, start: now, deadline: now + duration,
        reason: exhausted ? quotaMessage : 'This call reached its time limit. You can call again if time remains.' };
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
