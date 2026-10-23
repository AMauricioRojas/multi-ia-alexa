import { ChatError, MODELS, monthPeriod } from './plans.js';

export class UsageStore {
  constructor(pool, config, clock = () => new Date()) {
    this.pool = pool;
    this.config = config;
    this.clock = clock;
  }

  async transaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async reserve({ userId, requestId, fingerprint, source, provider }) {
    return this.transaction(async (client) => {
      await client.query('INSERT INTO ai_accounts(user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
      const { rows: [account] } = await client.query('SELECT plan FROM ai_accounts WHERE user_id=$1 FOR UPDATE', [userId]);
      // This account lock serializes duplicate request IDs and all channels for this user.
      const { rows: [existing] } = await client.query('SELECT * FROM ai_requests WHERE user_id=$1 AND request_id=$2', [userId, requestId]);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new ChatError('IDEMPOTENCY_CONFLICT', 'La solicitud ya existe con otro contenido.', 409);
        if (existing.status === 'completed') return { replay: existing.result };
        if (existing.status === 'failed') throw new ChatError('PROVIDER_FAILED', 'El proveedor rechazó esta solicitud. Puedes enviar una nueva.', 502);
        throw new ChatError('REQUEST_PENDING', 'Esta solicitud sigue pendiente de confirmación. No se volverá a enviar al proveedor.', 409);
      }
      const plan = this.config.plans[account.plan];
      const selected = provider === 'auto' ? plan.models[0] : provider;
      if (!plan.models.includes(selected)) throw new ChatError('MODEL_NOT_ALLOWED', 'Tu plan no incluye este modelo. Elige uno de los modelos disponibles.', 403);

      const period = monthPeriod(this.clock());
      await client.query('INSERT INTO ai_budget_periods(period_start) VALUES ($1) ON CONFLICT DO NOTHING', [period.start]);
      // One shared database lock protects the global cap, including multiple server processes.
      const { rows: [budget] } = await client.query('SELECT consumed_requests FROM ai_budget_periods WHERE period_start=$1 FOR UPDATE', [period.start]);
      const { rows: [counts] } = await client.query(`
        SELECT COUNT(*)::int AS user_used
        FROM ai_requests WHERE period_start=$1 AND user_id=$2 AND status <> 'failed'`, [period.start, userId]);
      if (counts.user_used >= plan.request_limit) throw new ChatError('QUOTA_EXHAUSTED', 'Agotaste el cupo de consultas de este periodo.', 429);
      if (budget.consumed_requests >= this.config.globalLimit) throw new ChatError('SERVICE_LIMIT', 'El servicio alcanzó su límite de consultas de prueba. Intenta en el siguiente periodo.', 429);
      await client.query('UPDATE ai_budget_periods SET consumed_requests=consumed_requests+1 WHERE period_start=$1', [period.start]);
      await client.query(`INSERT INTO ai_requests
        (user_id, request_id, fingerprint, period_start, period_end, source, provider, model, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'reserved')`,
      [userId, requestId, fingerprint, period.start, period.end, source, selected, MODELS[selected]]);
      return { provider: selected, model: MODELS[selected] };
    });
  }

  async complete({ userId, requestId, result, usage, message, conversationId, source, provider }) {
    // Save the answer, the two history rows, and usage atomically. A failed commit keeps the reservation.
    return this.transaction(async (client) => {
      const updated = await client.query(`UPDATE ai_requests SET status='completed', result=$3,
        input_tokens=$4, output_tokens=$5, total_tokens=$6, usage_reported=$7, updated_at=CURRENT_TIMESTAMP
        WHERE user_id=$1 AND request_id=$2 AND status='reserved' RETURNING request_id`,
      [userId, requestId, result, usage?.input_tokens ?? null, usage?.output_tokens ?? null,
        usage?.total_tokens ?? null, Boolean(usage)]);
      if (updated.rowCount !== 1) throw new Error('Reservation not available');
      const history = await client.query(`INSERT INTO chats(user_id, conversation_id, role, mensaje, ia, source)
        VALUES ($1,$2,'user',$3,$5,$6), ($1,$2,'ai',$4,$5,$6) RETURNING id,role`,
      [userId, conversationId, message, result.respuesta, provider, source]);
      result.assistant_chat_id = history.rows.find(row => row.role === 'ai').id;
      await client.query('UPDATE ai_requests SET result=$3 WHERE user_id=$1 AND request_id=$2', [userId, requestId, result]);
    });
  }

  async fail(userId, requestId, error) {
    return this.transaction(async client => {
      const { rows: [request] } = await client.query('SELECT status, period_start FROM ai_requests WHERE user_id=$1 AND request_id=$2 FOR UPDATE', [userId, requestId]);
      if (request?.status !== 'reserved') return;
      await client.query(`UPDATE ai_requests SET status=$3, error_code=$4,
        input_tokens=$5, output_tokens=$6, total_tokens=$7, usage_reported=$8, updated_at=CURRENT_TIMESTAMP
        WHERE user_id=$1 AND request_id=$2 AND status='reserved'`,
      [userId, requestId, error.definitelyRejected ? 'failed' : 'uncertain', error.code || 'PROVIDER_UNKNOWN',
        error.usage?.input_tokens ?? null, error.usage?.output_tokens ?? null,
        error.usage?.total_tokens ?? null, Boolean(error.usage)]);
      if (error.definitelyRejected) await client.query('UPDATE ai_budget_periods SET consumed_requests=consumed_requests-1 WHERE period_start=$1', [request.period_start]);
    });
  }

  async summary(userId) {
    const period = monthPeriod(this.clock());
    const { rows: [account] } = await this.pool.query('SELECT plan FROM ai_accounts WHERE user_id=$1', [userId]);
    const planId = account?.plan || 'basic';
    const plan = this.config.plans[planId];
    const { rows: [counts] } = await this.pool.query(`SELECT
      COUNT(*) FILTER (WHERE status='completed')::int AS used,
      COUNT(*) FILTER (WHERE status IN ('reserved','uncertain'))::int AS reserved,
      COALESCE(SUM(total_tokens),0)::text AS total_tokens,
      COUNT(*) FILTER (WHERE status='completed' AND NOT usage_reported)::int AS unreported
      FROM ai_requests WHERE user_id=$1 AND period_start=$2`, [userId, period.start]);
    const { rows: byModel } = await this.pool.query(`SELECT provider, model,
      COUNT(*) FILTER (WHERE status='completed')::int AS requests,
      COALESCE(SUM(input_tokens),0)::text AS input_tokens,
      COALESCE(SUM(output_tokens),0)::text AS output_tokens,
      COALESCE(SUM(total_tokens),0)::text AS total_tokens
      FROM ai_requests WHERE user_id=$1 AND period_start=$2 GROUP BY provider, model`, [userId, period.start]);
    return {
      plan: { id: planId, name: plan.name }, beta: true,
      period: { start: period.start, end: period.end, timezone: 'UTC' },
      quota: { unit: 'requests', limit: plan.request_limit, used: counts.used, reserved: counts.reserved,
        available: Math.max(0, plan.request_limit - counts.used - counts.reserved) },
      allowed_models: plan.models.map(id => ({ id, model: MODELS[id] })),
      usage: { total_tokens: counts.total_tokens, unreported_requests: counts.unreported, by_model: byModel },
    };
  }
}
