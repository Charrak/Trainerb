import type { Prisma } from '@prisma/client';

/** Check on the actual connection; comparing DSN strings would miss aliases and role membership. */
export async function assertRuntimeRole(tx: Pick<Prisma.TransactionClient, '$queryRaw'>) {
  const [row] = await tx.$queryRaw<{ unsafe: boolean }[]>`
    WITH reachable AS (SELECT * FROM pg_roles WHERE pg_has_role(current_user,oid,'MEMBER'))
    SELECT EXISTS(SELECT FROM reachable r WHERE r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
      OR r.rolname IN ('pg_write_all_data','pg_read_all_data','pg_execute_server_program','pg_read_server_files','pg_write_server_files')
      OR has_database_privilege(r.oid,current_database(),'CREATE') OR has_schema_privilege(r.oid,'public','CREATE')
      OR has_table_privilege(r.oid,'public._trainerb_migrations','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
      OR has_table_privilege(r.oid,'public.audit_events','UPDATE,DELETE,TRUNCATE,TRIGGER')
      OR has_any_column_privilege(r.oid,'public.audit_events','UPDATE')
      OR has_any_column_privilege(r.oid,'public._trainerb_migrations','INSERT,UPDATE')
      OR EXISTS(SELECT FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','S') AND c.relowner=r.oid)
    ) AS unsafe`;
  if (!row || row.unsafe) throw new Error('Unsafe database privileges for a runtime process.');
}
