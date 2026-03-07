import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('live_alerts', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('severity', 16).notNullable();       // 'down' | 'up' | 'warning' | 'info'
    t.text('title').notNullable();
    t.text('message').notNullable();
    t.text('navigate_to').nullable();
    t.text('stable_key').nullable();              // dedup: skip if unread + same (tenant_id, stable_key)
    t.timestamp('read_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Fast lookup: newest alerts per tenant
  await knex.raw(`CREATE INDEX live_alerts_tenant_created ON live_alerts(tenant_id, created_at DESC)`);
  // Dedup index: stable_key uniqueness per tenant (partial — only non-null keys)
  await knex.raw(`CREATE INDEX live_alerts_stable_key ON live_alerts(tenant_id, stable_key) WHERE stable_key IS NOT NULL`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('live_alerts');
}
