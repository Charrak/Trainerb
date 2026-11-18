import { isAbsolute } from 'node:path';

/** Worker entry point: the scheduler supplies this environment directly. Do not
 * import the API config loader (it reads the web application's .env on import). */
function workerConfig(env: NodeJS.ProcessEnv, identity: string) {
  const required = (key: string) => {
    const value = env[key];
    if (!value?.trim()) throw new Error(`Missing ${key}`);
    return value;
  };
  const databaseUrl = required('DATABASE_URL');
  const endpoint = new URL(required('MEDIA_S3_ENDPOINT'));
  const region = required('MEDIA_S3_REGION'), bucket = required('MEDIA_QUARANTINE_BUCKET');
  const accessKeyId = required(`${identity}_ACCESS_KEY_ID`);
  if (!['postgresql:', 'postgres:'].includes(new URL(databaseUrl).protocol) ||
      endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !/^[a-z0-9-]+$/.test(region) ||
      bucket === env.MEDIA_S3_BUCKET || [env.MEDIA_S3_ACCESS_KEY_ID, env.MEDIA_QUARANTINE_ACCESS_KEY_ID].includes(accessKeyId)) {
    throw new Error('Invalid worker database, quarantine reader, endpoint or socket');
  }
  return { databaseUrl, store: { origin: endpoint.origin, bucket, region, accessKeyId,
    secretAccessKey: required(`${identity}_SECRET_ACCESS_KEY`) } };
}

export function scanConfig(env: NodeJS.ProcessEnv) {
  const socket = env.MEDIA_SCAN_CLAMD_SOCKET;
  if (!socket || !isAbsolute(socket)) throw new Error('Invalid clamd socket');
  return { ...workerConfig(env, 'MEDIA_SCAN'), socket };
}

export function promotionConfig(env: NodeJS.ProcessEnv) {
  const { databaseUrl, store } = workerConfig(env, 'MEDIA_PROMOTE');
  const bucket = env.MEDIA_S3_BUCKET;
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || env.MEDIA_SCAN_ACCESS_KEY_ID === store.accessKeyId) {
    throw new Error('Configure a distinct private destination and promotion identity');
  }
  return { databaseUrl, source: store, destination: { ...store, bucket } };
}
