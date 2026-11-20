import express, { type RequestHandler } from 'express';

// Nur die drei Endpunkte, die langen Redaktionstext schreiben. Insbesondere
// Aktivieren, Veröffentlichen und Zurücknehmen erben diese Ausnahme nicht.
const textWrite = /^\/api\/v1\/admin\/(?:commerce\/legal|pages(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/drafts)?)\/?$/i;
export function acceptsEditorialJson(method: string, path: string) {
  return method === 'POST' && textWrite.test(path);
}

const standard = express.json({ limit: '32kb', strict: true });
const editorial = express.json({ limit: '256kb', strict: true });
export const parseJsonBody: RequestHandler = (req, res, next) => {
  const parse = acceptsEditorialJson(req.method, req.path) ? editorial : standard;
  parse(req, res, err => {
    if (err?.type === 'entity.too.large') {
      res.status(413).json({code:'PAYLOAD_TOO_LARGE', message:'Die Anfrage ist zu groß.', request_id:res.getHeader('X-Request-ID')});
      return;
    }
    next(err);
  });
};
