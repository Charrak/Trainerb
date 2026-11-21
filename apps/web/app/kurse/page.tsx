import { publicMetadata } from '../../lib/public-index';
import { Shell } from '../../components/site';
import { PublicCourses } from '../../components/public-courses';
export function generateMetadata() { return publicMetadata('/kurse'); }
export default function Page() { return <Shell><PublicCourses/></Shell>; }
