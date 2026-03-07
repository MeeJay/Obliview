import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // ── 1. Create tenants table ──────────────────────────────────────────────
  await knex.schema.createTable('tenants', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.string('slug', 64).notNullable().unique();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // ── 2. Create user_tenants junction table ────────────────────────────────
  await knex.schema.createTable('user_tenants', (t) => {
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('role', 16).notNullable().defaultTo('member'); // 'admin' | 'member'
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['user_id', 'tenant_id']);
  });

  // ── 3. Seed default tenant ───────────────────────────────────────────────
  await knex('tenants').insert({ id: 1, name: 'Default', slug: 'default' });

  // ── 4. Migrate all existing users into tenant 1 ──────────────────────────
  // Platform admins (role='admin') → tenant role 'admin'; others → 'member'
  const users = await knex('users').select('id', 'role');
  if (users.length > 0) {
    await knex('user_tenants').insert(
      users.map((u: { id: number; role: string }) => ({
        user_id: u.id,
        tenant_id: 1,
        role: u.role === 'admin' ? 'admin' : 'member',
      })),
    );
  }

  // ── 5. Add tenant_id (NOT NULL DEFAULT 1) to business tables ─────────────
  const tablesNotNull = [
    'monitors',
    'monitor_groups',
    'settings',
    'notification_channels',
    'user_teams',
    'agent_api_keys',
    'agent_devices',
    'remediation_actions',
    'maintenance_windows',
  ];

  for (const table of tablesNotNull) {
    await knex.schema.alterTable(table, (t) => {
      t.integer('tenant_id')
        .notNullable()
        .defaultTo(1)
        .references('id')
        .inTable('tenants')
        .onDelete('CASCADE');
    });
  }

  // ── 6. Add tenant_id NULLABLE to smtp_servers ────────────────────────────
  // NULL = platform-level (MFA + password reset only)
  // non-null = tenant-scoped (notification channels)
  await knex.schema.alterTable('smtp_servers', (t) => {
    t.integer('tenant_id').nullable().references('id').inTable('tenants').onDelete('SET NULL');
  });
}

export async function down(knex: Knex): Promise<void> {
  // Remove tenant_id from smtp_servers
  await knex.schema.alterTable('smtp_servers', (t) => {
    t.dropColumn('tenant_id');
  });

  // Remove tenant_id from business tables (reverse order)
  const tablesNotNull = [
    'maintenance_windows',
    'remediation_actions',
    'agent_devices',
    'agent_api_keys',
    'user_teams',
    'notification_channels',
    'settings',
    'monitor_groups',
    'monitors',
  ];
  for (const table of tablesNotNull) {
    await knex.schema.alterTable(table, (t) => {
      t.dropColumn('tenant_id');
    });
  }

  // Drop junction and main tables
  await knex.schema.dropTableIfExists('user_tenants');
  await knex.schema.dropTableIfExists('tenants');
}
