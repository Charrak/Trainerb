import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { getConfig } from './config';
import { apiError, keyedHash, randomToken } from './security';

const INCREMENT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`;
// Count in-flight validations as reservations so parallel requests cannot all
// pass a stale counter. Success releases only its own reservation; failures age out.
const RESERVE_LOGIN = `
for i,key in ipairs(KEYS) do
  redis.call('ZREMRANGEBYSCORE', key, '-inf', ARGV[1] - ARGV[2])
  if redis.call('ZCARD', key) >= tonumber(ARGV[i+3]) then return 0 end
end
for _,key in ipairs(KEYS) do
  redis.call('ZADD', key, ARGV[1], ARGV[3]); redis.call('PEXPIRE', key, ARGV[2])
end
return 1`;

@Injectable()
export class RateLimiter implements OnModuleDestroy {
  private readonly redis = new Redis(getConfig().redisUrl, {
    lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 1500,
    retryStrategy: () => null,
  });
  private connecting?: Promise<void>;
  constructor() { this.redis.on('error', () => {}); }
  private async ready(): Promise<void> {
    if (this.redis.status === 'ready') return;
    try {
      if (!this.connecting) {
        this.connecting = this.redis.connect().then(() => undefined).finally(() => { this.connecting = undefined; });
      }
      await this.connecting;
      if ((this.redis.status as string) !== 'ready') throw new Error('redis not ready');
    } catch { throw apiError(503, 'AUTH_TEMPORARILY_UNAVAILABLE', 'Bitte versuche es später erneut.'); }
  }
  private key(scope: string, identity: string): string {
    return `trainerb:rl:${scope}:${keyedHash(getConfig().auditKey, scope, identity).toString('hex')}`;
  }
  async hit(scope: string, identity: string, limit: number, ttlMs = 15 * 60_000): Promise<void> {
    await this.ready();
    let count: number;
    try { count = Number(await this.redis.eval(INCREMENT, 1, this.key(scope, identity), ttlMs)); }
    catch { throw apiError(503, 'AUTH_TEMPORARILY_UNAVAILABLE', 'Bitte versuche es später erneut.'); }
    if (count > limit) throw apiError(429, 'RATE_LIMITED', 'Zu viele Anfragen. Bitte versuche es später erneut.');
  }
  async checkLogin<T>(email: string, ip: string, validate: () => Promise<T | null>): Promise<T | null> {
    await this.ready();
    const keys = [this.key('login-pair', `${email}\0${ip}`), this.key('login-account', email), this.key('login-source', ip)];
    const owner = randomToken();
    try {
      const acquired = await this.redis.eval(RESERVE_LOGIN, keys.length, ...keys, Date.now(), 15 * 60_000, owner, 5, 15, 50);
      if (!acquired) throw apiError(429, 'RATE_LIMITED', 'Zu viele Anfragen. Bitte versuche es später erneut.');
      const result = await validate();
      if (result) await this.redis.eval("for _,key in ipairs(KEYS) do redis.call('ZREM', key, ARGV[1]) end return 1", keys.length, ...keys, owner);
      return result;
    } catch (error) {
      if (error && typeof error === 'object' && 'getStatus' in error) throw error;
      throw apiError(503, 'AUTH_TEMPORARILY_UNAVAILABLE', 'Bitte versuche es später erneut.');
    }
  }
  async onModuleDestroy(): Promise<void> { this.redis.disconnect(); }
}
