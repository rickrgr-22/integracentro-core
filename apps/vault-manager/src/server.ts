import express, { Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { pool, query } from './db';

const app = express();
const port = process.env.PORT || 3000;
const uploadDir = process.env.UPLOAD_DIR || '/data/evidencias';

// Garantizar que la ruta del PVC exista al arrancar
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configuración de almacenamiento en disco con Multer
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const uniquePrefix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${uniquePrefix}-${sanitizedName}`);
  },
});

// Validación estricta de extensiones y tipos MIME
const TIPOS_PERMITIDOS = [
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
];

const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  const extension = path.extname(file.originalname).toLowerCase();
  const extensionesValidas = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];

  if (TIPOS_PERMITIDOS.includes(file.mimetype) && extensionesValidas.includes(extension)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        `Formato de archivo no permitido (${file.mimetype}). Solo se aceptan PDF, JPG, PNG y WEBP.`
      )
    );
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25 MB máximo
  },
});

app.use(express.json({ limit: '10mb' }));

// Healthcheck profundo
app.get('/health', async (_req: Request, res: Response) => {
  try {
    const dbResult = await query('SELECT NOW() as current_time;');
    res.status(200).json({
      status: 'UP',
      service: 'ic-vault-manager',
      timestamp: new Date().toISOString(),
      upload_dir: {
        path: uploadDir,
        writable: fs.existsSync(uploadDir),
      },
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

// Subida y sellado de archivos binarios (multipart/form-data)
app.post('/evidencias/upload', (req: Request, res: Response) => {
  upload.single('archivo')(req, res, async (err: any) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'El archivo excede el limite de 25 MB' });
      }
      return res.status(400).json({ error: `Error en la subida: ${err.message}` });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Debe adjuntar un archivo en el campo "archivo"' });
    }

    try {
      let { centro_id, valido } = req.body;

      if (!centro_id) {
        const centroDefecto = await query('SELECT id FROM centros_estancia LIMIT 1;');
        if (centroDefecto.rows.length === 0) {
          fs.unlinkSync(req.file.path);
          return res.status(400).json({ error: 'No existen centros de estancia registrados' });
        }
        centro_id = centroDefecto.rows[0].id;
      }

      // Sellado SHA-256 calculado sobre el archivo guardado en el PVC
      const fileBuffer = fs.readFileSync(req.file.path);
      const hash_sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

      const insertSql = `
        INSERT INTO expedientes_evidencias (centro_id, ruta_archivo, hash_sha256, valido)
        VALUES ($1, $2, $3, $4)
        RETURNING id, centro_id, ruta_archivo, hash_sha256, valido, created_at;
      `;
      const valores = [centro_id, req.file.path, hash_sha256, valido !== 'false'];
      const result = await query(insertSql, valores);

      res.status(201).json({
        mensaje: 'Evidencia almacenada en PVC y sellada con SHA-256',
        archivo: {
          nombre_original: req.file.originalname,
          mimetype: req.file.mimetype,
          tamanio_bytes: req.file.size,
          ruta_pvc: req.file.path,
        },
        evidencia: result.rows[0],
      });
    } catch (dbError: any) {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      console.error('[Error DB /evidencias/upload]:', dbError);
      res.status(500).json({ error: 'Error registrando metadatos en base de datos' });
    }
  });
});

// Endpoint legacy JSON para pruebas directas / Ansible
app.post('/evidencias', async (req: Request, res: Response) => {
  try {
    let { centro_id, ruta_archivo, contenido, hash_sha256, valido } = req.body;

    if (!ruta_archivo) {
      return res.status(400).json({ error: 'El campo ruta_archivo es obligatorio' });
    }

    if (contenido) {
      hash_sha256 = crypto.createHash('sha256').update(contenido).digest('hex');
    } else if (!hash_sha256 || hash_sha256.length !== 64) {
      return res.status(400).json({
        error: 'Debe proporcionar contenido para calcular el hash o un hash_sha256 de 64 caracteres',
      });
    }

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

// Listado general de evidencias
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
    res.status(500).json({ error: 'Error al consultar expedientes' });
  }
});

app.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'IntegraCentro - Vault Manager API' });
});

const server = app.listen(port, () => {
  console.log(`Vault Manager activo en puerto ${port}`);
});

const gracefulShutdown = async (signal: string) => {
  console.log(`Recibida señal ${signal}. Cerrando conexiones...`);
  server.close(async () => {
    try {
      await pool.end();
      console.log('Pool de PostgreSQL cerrado exitosamente.');
      process.exit(0);
    } catch (err) {
      console.error('Error cerrando pool de PostgreSQL:', err);
      process.exit(1);
    }
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
