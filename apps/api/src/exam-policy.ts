/** Keine stillschweigende Abschaltung bei leerer, negativer oder fehlerhafter Konfiguration. */
export function examPolicy(env: NodeJS.ProcessEnv) {
  function integer(key: string, fallback: number, max: number) {
    const raw = env[key];
    if (raw === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(raw) || Number(raw) > max) throw new Error(`Ungültige Prüfungseinstellung: ${key}`);
    return Number(raw);
  }
  return {
    maxFailures: integer('EXAM_MAX_FAILURES', 3, 100),
    windowMs: integer('EXAM_FAILURE_WINDOW_SECONDS', 86400, 604800) * 1000,
    minWorkMs: integer('EXAM_MIN_WORK_SECONDS', 20, 3600) * 1000,
  };
}
