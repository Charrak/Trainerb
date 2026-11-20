'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
type Menus = Record<'header' | 'footer', { label: string; href: string }[]>;
const empty: Menus = { header: [], footer: [] };
const Context = createContext(empty);
export function NavigationProvider({ children }: { children: ReactNode }) {
  const path = usePathname(),
    [menus, setMenus] = useState(empty);
  useEffect(() => {
    const controller = new AbortController();
    setMenus(empty);
    fetch('/api/v1/navigation', { cache: 'no-store', credentials: 'omit', signal: controller.signal })
      .then(async (r) => {
        if (r.ok) {
          const fresh: Menus = await r.json();
          if (!controller.signal.aborted) setMenus(fresh);
        }
      })
      .catch(() => {
        /* Core and legal navigation remain usable without editorial data. */
      });
    return () => controller.abort();
  }, [path]);
  return <Context.Provider value={menus}>{children}</Context.Provider>;
}
export function EditorialNavigation({ location }: { location: 'header' | 'footer' }) {
  const items = useContext(Context)[location];
  if (!items.length) return null;
  return (
    <nav
      className={'editorial-links editorial-links-' + location}
      aria-label={location === 'header' ? 'Weitere Website-Seiten' : 'Weitere Links im Fußbereich'}
    >
      {items.map((item) => (
        <Link prefetch={false} key={item.href} href={item.href}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
