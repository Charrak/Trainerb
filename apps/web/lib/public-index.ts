import { liveSite } from './site-stage';
import { indexOrigin } from './search-index';

export const publicOrigin = () => indexOrigin(liveSite, process.env.PUBLIC_BASE_URL);
export function publicMetadata(path: string) {
  const origin = publicOrigin();
  return origin ? { robots: { index: true, follow: true }, alternates: { canonical: origin + path } }
    : { robots: { index: false, follow: false } };
}
