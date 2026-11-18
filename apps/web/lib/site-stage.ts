// next build is also used for staging; going live is an explicit build decision.
export const liveSite = process.env.NODE_ENV === 'production' && process.env.NEXT_PUBLIC_SITE_STAGE === 'live';
