import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { uuidv7 } from 'uuidv7';
import { AppModule } from './app.module';
import { SafeExceptionFilter } from './errors';
import { getConfig } from './config';

export async function createApplication(): Promise<INestApplication> {
  const cfg = getConfig();
  const app = await NestFactory.create(AppModule, { bodyParser:false, logger:['error','warn','log'] });
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.disable('x-powered-by');
  expressApp.set('trust proxy', cfg.trustProxy);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use((req: any, res: any, next: () => void) => {
    req.requestId = uuidv7(); res.setHeader('X-Request-ID', req.requestId);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); next();
  });
  // The Stripe webhook needs the exact bytes it signed; every other route keeps
  // the strict JSON parser. Only this single path captures a raw buffer.
  app.use((req: any, res: any, next: () => void) => {
    if (req.method === 'POST' && req.path === '/api/v1/payments/stripe/webhook') {
      express.raw({ type: '*/*', limit: '256kb' })(req, res, err => {
        if (err) {
          const tooLarge = err.type === 'entity.too.large';
          res.status(tooLarge ? 413 : 400).json({ code: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'INVALID_WEBHOOK', request_id: req.requestId }); return;
        }
        req.rawBody = req.body; req.body = undefined; next();
      });
      return;
    }
    next();
  });
  app.use(express.json({ limit:'32kb', strict:true }));
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new SafeExceptionFilter());
  return app;
}
