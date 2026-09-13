import { Pool, QueryResult } from 'pg';

export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'integracentro_db',
  user: process.env.POSTGRES_USER || 'ic_admin',
  password: process.env.POSTGRES_PASSWORD || 'IC_Segura_2026!Local',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err: Error) => {
  console.error('[PostgreSQL Pool Error - Vault]:', err);
});

export const query = (text: string, params?: any[]): Promise<QueryResult<any>> => {
  return pool.query(text, params);
};
EOF