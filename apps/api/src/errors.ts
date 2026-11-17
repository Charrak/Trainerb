import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { uuidv7 } from 'uuidv7';

@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { requestId?: string }>();
    const requestId = req.requestId || uuidv7();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const safe = typeof body === 'object' && body !== null && 'code' in body
        ? body : { code: status === 404 ? 'NOT_FOUND' : 'REQUEST_FAILED', message: 'Die Anfrage konnte nicht verarbeitet werden.' };
      res.status(status).json({ ...safe, request_id: requestId });
      return;
    }
    // Never log request bodies, credentials, token links or raw provider data.
    console.error(JSON.stringify({ level: 'error', event: 'unhandled_request_error', request_id: requestId }));
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Die Anfrage konnte vorübergehend nicht verarbeitet werden.', request_id: requestId });
  }
}
