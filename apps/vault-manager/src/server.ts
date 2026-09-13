import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { pool, query } from './db';

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

// Healthcheck profundo con comprobación de PostgreSQL
app.get('/health', async (_req: Request, res: Response) => {
  try {
    const dbResult = await query('SELECT NOW() as current_time;');
    res.status(200).json({
      status: 'UP',
      service: 'ic-vault-manager',
      timestamp: new Date().toISOString(),
      database: {
        status: 'CONNECTED',
        server_time: dbResult.rows[0].current_time,
      },
    });
  } catch (error: any) {
    res.status(503).json({
      status: 'DOWN',
      service: 'ic-vault-manager',
      database: {
        status: 'DISCONNECTED',
        error: error?.message || 'Error conectando a PostgreSQL',
      },
    });
  }
});

// Registrar y sellar criptográficamente una nueva evidencia
app.post('/evidencias', async (req: Request, res: Response) => {
  try {
    let { centro_id, ruta_archivo, contenido, hash_sha256, valido } = req.body;

    if (!ruta_archivo) {
      return res.status(400).json({ error: 'El campo ruta_archivo es obligatorio' });
    }

    // Si se envía contenido, calcular el hash SHA-256 en caliente
    if (contenido) {
      hash_sha256 = crypto.createHash('sha256').update(contenido).digest('hex');
    } else if (!hash_sha256 || hash_sha256.length !== 64) {
      return res.status(400).json({
        error: 'Debe proporcionar contenido para calcular el hash o un hash_sha256 valido de 64 caracteres',
      });
    }

    // Si no se especifica centro_id, asociar al centro modelo por defecto
    if (!centro_id) {
      const centroDefecto = await query('SELECT id FROM centros_estancia LIMIT 1;');
      if (centroDefecto.rows.length === 0) {
        return res.status(400).json({ error: 'No existen centros de estancia registrados' });
      }
      centro_id = centroDefecto.rows[0].id;
    }

    const insertSql = `
      INSERT INTO expedientes_evidencias (centro_id, ruta_archivo, hash_sha256, valido)
      VALUES ($1, $2, $3, $4)
      RETURNING id, centro_id, ruta_archivo, hash_sha256, valido, created_at;
    `;
    const valores = [centro_id, ruta_archivo, hash_sha256, valido ?? true];
    const result = await query(insertSql, valores);

    res.status(201).json({
      mensaje: 'Evidencia registrada y sellada con SHA-256',
      evidencia: result.rows[0],
    });
  } catch (error: any) {
    console.error('[Error POST /evidencias]:', error);
    res.status(500).json({ error: 'Fallo al registrar la evidencia en base de datos' });
  }
});

// Listar evidencias registradas junto con el centro de estancia
app.get('/evidencias', async (_req: Request, res: Response) => {
  try {
    const sql = `
      SELECT 
        e.id,
        e.ruta_archivo,
        e.hash_sha256,
        e.valido,
        e.created_at,
        c.nombre AS centro_nombre,
        c.registro_sanitario
      FROM expedientes_evidencias e
      LEFT JOIN centros_estancia c ON e.centro_id = c.id
      ORDER BY e.created_at DESC;
    `;
    const { rows } = await query(sql);
    res.status(200).json({
      total: rows.length,
      data: rows,
    });
  } catch (error: any) {
    console.error('[Error GET /evidencias]:', error);
    res.status(500).json({ error: 'Error al consultar expedientes en PostgreSQL' });
  }
});

// Raíz informativa
app.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'IntegraCentro - Vault Manager API' });
});

const server = app.listen(port, () => {
  console.log(`Vault Manager activo en puerto ${port}`);
});

// Graceful Shutdown
const gracefulShutdown = async (signal: string) => {
  console.log(`Recibida señal ${signal}. Cerrando pool de base de datos...`);
  server.close(async () => {
    try {
      await pool.end();
      console.log('Pool de PostgreSQL cerrado correctamente.');
      process.exit(0);
    } catch (err) {
      console.error('Error cerrando el pool:', err);
      process.exit(1);
    }
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
