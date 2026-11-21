import { crawlerRules } from '../lib/search-index';
import { publicOrigin } from '../lib/public-index';

export const dynamic = 'force-dynamic';
export default function robots() { return crawlerRules(publicOrigin()); }
