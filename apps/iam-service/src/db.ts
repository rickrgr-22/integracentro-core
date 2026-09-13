cat << 'EOF' > apps/iam-service/src/db.ts
import { Pool, QueryResult } from 'pg';

export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'integracentro_db',
  user: process.env.POSTGRES_USER || 'ic_admin',
  password: process.env.POSTGRES_PASSWORD || 'IC_Segura_2026!Local',
  max: 10, // Conexiones concurrentes máximas en el pool
  idleTimeoutMillis: 30000, // Cerrar sockets inactivos tras 30s
  connectionTimeoutMillis: 5000, // Límite de 5s para establecer conexión inicial
});

pool.on('error', (err: Error) => {
  console.error('[PostgreSQL Pool Error]: Error imprevisto en cliente inactivo', err);
});

export const query = (text: string, params?: any[]): Promise<QueryResult<any>> => {
  return pool.query(text, params);
};
EOF