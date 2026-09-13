cat << 'EOF' > apps/iam-service/src/index.ts
import express, { Request, Response } from 'express';
import { pool, query } from './db';

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Healthcheck profundo: valida disponibilidad de Node y PostgreSQL
app.get('/health', async (_req: Request, res: Response) => {
  try {
    const dbResult = await query('SELECT NOW() as current_time;');
    res.status(200).json({
      status: 'UP',
      service: 'ic-iam-service',
      timestamp: new Date().toISOString(),
      database: {
        status: 'CONNECTED',
        server_time: dbResult.rows[0].current_time,
      },
    });
  } catch (error: any) {
    res.status(503).json({
      status: 'DOWN',
      service: 'ic-iam-service',
      database: {
        status: 'DISCONNECTED',
        error: error?.message || 'Error de comunicación con PostgreSQL',
      },
    });
  }
});

// Endpoint para consultar usuarios registrados en el esquema RBAC
app.get('/users', async (_req: Request, res: Response) => {
  try {
    const { rows } = await query(
      'SELECT id, email, rol, created_at FROM usuarios_rbac ORDER BY created_at ASC;'
    );
    res.status(200).json({
      total: rows.length,
      data: rows,
    });
  } catch (error: any) {
    console.error('[Error /users]:', error);
    res.status(500).json({ error: 'Error al consultar usuarios en PostgreSQL' });
  }
});

// Raíz informativa
app.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'IntegraCentro - IAM Service API' });
});

const server = app.listen(port, () => {
  console.log(`IAM Service activo en puerto ${port}`);
});

// Graceful Shutdown para Kubernetes (SIGTERM)
const gracefulShutdown = async (signal: string) => {
  console.log(`Recibida señal ${signal}. Cerrando servidor HTTP y conexiones de base de datos...`);
  server.close(async () => {
    try {
      await pool.end();
      console.log('Pool de PostgreSQL cerrado correctamente. Proceso terminado.');
      process.exit(0);
    } catch (err) {
      console.error('Error al cerrar el pool de PostgreSQL:', err);
      process.exit(1);
    }
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
EOF