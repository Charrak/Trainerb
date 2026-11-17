import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { getConfig } from './config';
import { apiError, keyedHash, randomToken } from './security';

const INCREMENT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`;
const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

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
    await this.hit('login-ip', ip, 50);
    await this.ready();
    const pair = this.key('login-failures', `${email}\0${ip}`);
    const lock = `${pair}:lock`;
    const owner = randomToken();
    try {
      const acquired = await this.redis.set(lock, owner, 'PX', 20_000, 'NX');
      if (!acquired) throw apiError(429, 'RATE_LIMITED', 'Bitte versuche es später erneut.');
      try {
        const failures = Number(await this.redis.get(pair) || 0);
        if (failures >= 5) throw apiError(429, 'RATE_LIMITED', 'Zu viele Anfragen. Bitte versuche es später erneut.');
        const result = await validate();
        if (result) await this.redis.del(pair);
        else await this.redis.eval(INCREMENT, 1, pair, 15 * 60_000);
        return result;
      } finally {
        await this.redis.eval(RELEASE, 1, lock, owner);
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'getStatus' in error) throw error;
      throw apiError(503, 'AUTH_TEMPORARILY_UNAVAILABLE', 'Bitte versuche es später erneut.');
    }
  }
  async onModuleDestroy(): Promise<void> { this.redis.disconnect(); }
}
