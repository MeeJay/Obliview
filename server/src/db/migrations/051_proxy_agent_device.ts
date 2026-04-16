import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitors', (t) => {
    t.integer('proxy_agent_device_id')
      .nullable()
      .references('id')
      .inTable('agent_devices')
      .onDelete('SET NULL');
    t.index('proxy_agent_device_id', 'idx_monitors_proxy_agent', {
      predicate: knex.whereNotNull('proxy_agent_device_id'),
    });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitors', (t) => {
    t.dropColumn('proxy_agent_device_id');
  });
}
