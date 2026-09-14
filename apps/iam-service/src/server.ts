import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import nodemailer from 'nodemailer';
import axios from 'axios';
import { pool, query } from './db';
import { MfaCanal, MfaTicketPayload, JwtUserPayload } from './types';

const app = express();
const port = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'integra_centro_secret_2026';

app.use(express.json());

// --- CLIENTE REDIS (Gestión de tickets MFA y revocación JWT) ---
const redisHost = process.env.REDIS_HOST || 'ic-redis';
const redisPort = Number(process.env.REDIS_PORT) || 6379;

const redisClient = new Redis({
  host: redisHost,
  port: redisPort,
  retryStrategy: (times) => Math.min(times * 100, 3000),
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

redisClient.on('connect', () => {
  console.log(`[Redis] Conectado en ${redisHost}:${redisPort}`);
});

redisClient.on('error', (err) => {
  console.error('[Redis] Error de conexión:', err.message);
});

// --- PROVEEDORES DE DESPACHO MFA (Email y WhatsApp) ---
class MfaNotificationService {
  private static smtpTransporter: nodemailer.Transporter | null = process.env.SMTP_HOST
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      })
    : null;

  static async sendOtp(canal: MfaCanal, destino: string, codigo: string, nombre: string): Promise<void> {
    if (canal === 'email') {
      if (!this.smtpTransporter || process.env.NODE_ENV === 'development') {
        console.log(`[MFA-EMAIL-MOCK] Para: ${destino} | Usuario: ${nombre} | Código OTP: [${codigo}]`);
        return;
      }
      await this.smtpTransporter.sendMail({
        from: process.env.SMTP_FROM || '"IntegraCentro Seguridad" <seguridad@integracentro.gob.mx>',
        to: destino,
        subject: 'Tu código de verificación - IntegraCentro',
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px;">
            <h2>Verificación de Identidad</h2>
            <p>Hola <strong>${nombre}</strong>,</p>
            <p>Tu código temporal de acceso es:</p>
            <h1 style="letter-spacing: 4px; color: #1e40af;">${codigo}</h1>
            <p>Este código expira en 5 minutos. Si no solicitaste este acceso, reporta de inmediato.</p>
          </div>
        `,
      });
    } else if (canal === 'whatsapp') {
      const apiUrl = process.env.WHATSAPP_API_URL;
      const apiToken = process.env.WHATSAPP_API_TOKEN;

      if (!apiUrl || !apiToken || process.env.NODE_ENV === 'development') {
        console.log(`[MFA-WHATSAPP-MOCK] Para: ${destino} | Usuario: ${nombre} | Código OTP: [${codigo}]`);
        return;
      }

      await axios.post(
        apiUrl,
        {
          messaging_product: 'whatsapp',
          to: destino.replace(/[^0-9]/g, ''),
          type: 'template',
          template: {
            name: 'auth_otp_code',
            language: { code: 'es_MX' },
            components: [
              {
                type: 'body',
                parameters: [
                  { type: 'text', text: nombre },
                  { type: 'text', text: codigo },
                ],
              },
            ],
          },
        },
        {
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
        }
      );
    }
  }
}

// --- MIDDLEWARE DE AUTENTICACIÓN Y VALIDACIÓN DE REVOCACIÓN ---
export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Encabezado de autorización ausente o inválido' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const revocado = await redisClient.get(`blacklist:${token}`);
    if (revocado) {
      return res.status(401).json({ error: 'Token revocado o sesión cerrada' });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as JwtUserPayload & { exp: number };
    (req as any).user = decoded;
    (req as any).rawToken = token;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
};

// --- HEALTHCHECK PROFUNDO (PostgreSQL + Redis) ---
app.get('/health', async (_req: Request, res: Response) => {
  try {
    const [dbResult, redisPing] = await Promise.all([
      query('SELECT NOW() as current_time;'),
      redisClient.ping().catch((err) => `DOWN: ${err.message}`),
    ]);

    const redisOk = redisPing === 'PONG';

    res.status(200).json({
      status: redisOk ? 'UP' : 'DEGRADED',
      service: 'ic-iam-service',
      timestamp: new Date().toISOString(),
      database: {
        status: 'CONNECTED',
        server_time: dbResult.rows[0].current_time,
      },
      redis: {
        status: redisOk ? 'CONNECTED' : 'DISCONNECTED',
      },
    });
  } catch (error: any) {
    res.status(503).json({
      status: 'DOWN',
      service: 'ic-iam-service',
      database: {
        status: 'DISCONNECTED',
        error: error?.message || 'Error de comunicación con dependencias',
      },
    });
  }
});

// --- ENDPOINT DE USUARIOS RBAC (Mantiene compatibilidad con verify_deployment.yml) ---
app.get('/users', async (_req: Request, res: Response) => {
  try {
    const { rows } = await query(
      'SELECT id, email, rol, nombre, mfa_enabled, mfa_canal, telefono, created_at FROM usuarios_rbac ORDER BY created_at ASC;'
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

// --- FLUJO DE AUTENTICACIÓN PASO 1: LOGIN CON CREDENCIALES ---
app.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña requeridos' });
    }

    const { rows } = await query(
      `SELECT id, nombre, email, password_hash, rol, mfa_enabled, mfa_canal, telefono 
       FROM usuarios_rbac 
       WHERE email = $1;`,
      [email.toLowerCase().trim()]
    );

    if (rows.length === 0 || !rows[0].password_hash) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const user = rows[0];
    const passValida = await bcrypt.compare(password, user.password_hash);
    if (!passValida) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.ip || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'Desconocido';

    // Si el usuario requiere autenticación MFA:
    if (user.mfa_enabled) {
      const canal: MfaCanal = user.mfa_canal || 'email';
      const destino = canal === 'whatsapp' ? user.telefono : user.email;

      if (canal === 'whatsapp' && !user.telefono) {
        return res.status(400).json({ error: 'El usuario no tiene número telefónico configurado para WhatsApp' });
      }

      // Control de cooldown contra bombardeo de OTP
      const cooldownKey = `mfa:cooldown:${user.id}`;
      const enCooldown = await redisClient.get(cooldownKey);
      if (enCooldown) {
        const ttl = await redisClient.ttl(cooldownKey);
        return res.status(429).json({ error: `Espera ${ttl} segundos antes de solicitar otro código OTP` });
      }

      // Generación de OTP criptográfico de 6 dígitos numéricos
      const codigoOtp = crypto.randomInt(100000, 999999).toString();
      const hashOtp = crypto.createHash('sha256').update(codigoOtp).digest('hex');
      const ticketId = crypto.randomBytes(32).toString('hex');

      const payload: MfaTicketPayload = {
        userId: user.id,
        email: user.email,
        canal,
        destino: destino!,
        hashOtp,
        intentosRestantes: 3,
      };

      // Guardar ticket (TTL 5 min) y cooldown (TTL 60s) en Redis
      await redisClient
        .multi()
        .set(`mfa:ticket:${ticketId}`, JSON.stringify(payload), 'EX', 300)
        .set(cooldownKey, '1', 'EX', 60)
        .exec();

      // Envío de la notificación
      await MfaNotificationService.sendOtp(canal, destino!, codigoOtp, user.nombre || 'Usuario');

      // Registro de auditoría
      const destinoOfuscado = canal === 'email'
        ? user.email.replace(/(.{2})(.*)(?=@)/, '$1***')
        : destino!.replace(/(\+\d{2})(\d+)(\d{4})/, '$1***$3');

      await query(
        `INSERT INTO mfa_auditoria_eventos (usuario_id, evento, canal, destino, ip_origen, user_agent)
         VALUES ($1, 'OTP_ENVIADO', $2, $3, $4, $5);`,
        [user.id, canal, destinoOfuscado, ip, userAgent]
      );

      return res.status(200).json({
        mfa_required: true,
        mfa_ticket: ticketId,
        canal,
        mensaje: `Código de verificación enviado vía ${canal.toUpperCase()}`,
        expira_en_segundos: 300,
      });
    }

    // Si MFA no está habilitado, genera el token JWT directamente
    const token = jwt.sign(
      { id: user.id, email: user.email, rol: user.rol, nombre: user.nombre },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    return res.status(200).json({
      mfa_required: false,
      token,
      usuario: { id: user.id, email: user.email, nombre: user.nombre, rol: user.rol },
    });
  } catch (error: any) {
    console.error('[Error /auth/login]:', error);
    res.status(500).json({ error: error.message || 'Error en inicio de sesión' });
  }
});

// --- FLUJO DE AUTENTICACIÓN PASO 2: VERIFICACIÓN OTP Y EMISIÓN JWT ---
app.post('/auth/mfa/verify', async (req: Request, res: Response) => {
  try {
    const { mfa_ticket, codigo } = req.body;
    if (!mfa_ticket || !codigo) {
      return res.status(400).json({ error: 'mfa_ticket y codigo son obligatorios' });
    }

    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.ip || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'Desconocido';
    const ticketKey = `mfa:ticket:${mfa_ticket}`;
    const rawData = await redisClient.get(ticketKey);

    if (!rawData) {
      return res.status(401).json({ error: 'El ticket MFA es inválido o ha expirado. Inicia sesión nuevamente.' });
    }

    const ticketData: MfaTicketPayload = JSON.parse(rawData);
    const hashIngresado = crypto.createHash('sha256').update(String(codigo).trim()).digest('hex');

    // Comparación resistente a timing-attacks
    const esValido = crypto.timingSafeEqual(
      Buffer.from(ticketData.hashOtp),
      Buffer.from(hashIngresado)
    );

    if (!esValido) {
      ticketData.intentosRestantes -= 1;

      if (ticketData.intentosRestantes <= 0) {
        await redisClient.del(ticketKey);
        await query(
          `INSERT INTO mfa_auditoria_eventos (usuario_id, evento, canal, destino, ip_origen, user_agent)
           VALUES ($1, 'BLOQUEO_INTENTOS_AGOTADOS', $2, $3, $4, $5);`,
          [ticketData.userId, ticketData.canal, ticketData.destino, ip, userAgent]
        );
        return res.status(401).json({ error: 'Número de intentos superado. Inicia sesión nuevamente.' });
      }

      const ttlActual = await redisClient.ttl(ticketKey);
      if (ttlActual > 0) {
        await redisClient.set(ticketKey, JSON.stringify(ticketData), 'EX', ttlActual);
      }

      await query(
        `INSERT INTO mfa_auditoria_eventos (usuario_id, evento, canal, destino, ip_origen, user_agent)
         VALUES ($1, 'OTP_FALLIDO', $2, $3, $4, $5);`,
        [ticketData.userId, ticketData.canal, ticketData.destino, ip, userAgent]
      );

      return res.status(401).json({
        error: `Código incorrecto. Te quedan ${ticketData.intentosRestantes} intento(s).`,
      });
    }

    // Código válido: eliminar ticket de Redis para evitar reutilización
    await redisClient.del(ticketKey);

    await query(
      `INSERT INTO mfa_auditoria_eventos (usuario_id, evento, canal, destino, ip_origen, user_agent)
       VALUES ($1, 'OTP_EXITOSO', $2, $3, $4, $5);`,
      [ticketData.userId, ticketData.canal, ticketData.destino, ip, userAgent]
    );

    const { rows } = await query(
      'SELECT id, email, rol, nombre FROM usuarios_rbac WHERE id = $1;',
      [ticketData.userId]
    );
    const user = rows[0];

    const token = jwt.sign(
      { id: user.id, email: user.email, rol: user.rol, nombre: user.nombre },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.status(200).json({
      mensaje: 'Autenticación completada con éxito',
      token,
      usuario: user,
    });
  } catch (error: any) {
    console.error('[Error /auth/mfa/verify]:', error);
    res.status(500).json({ error: 'Error validando código MFA' });
  }
});

// --- CONFIGURACIÓN DE MFA POR USUARIO (Email / WhatsApp) ---
app.put('/auth/mfa/config', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const { mfa_enabled, mfa_canal, telefono } = req.body;

    if (mfa_canal && !['email', 'whatsapp'].includes(mfa_canal)) {
      return res.status(400).json({ error: 'Canal inválido. Solo se permite "email" o "whatsapp"' });
    }

    if (mfa_canal === 'whatsapp' && !telefono) {
      return res.status(400).json({ error: 'El teléfono en formato E.164 (+52...) es obligatorio para WhatsApp' });
    }

    const updateSql = `
      UPDATE usuarios_rbac
      SET 
        mfa_enabled = COALESCE($1, mfa_enabled),
        mfa_canal = COALESCE($2, mfa_canal),
        telefono = COALESCE($3, telefono),
        mfa_updated_at = NOW()
      WHERE id = $4
      RETURNING id, email, nombre, mfa_enabled, mfa_canal, telefono, mfa_updated_at;
    `;
    const { rows } = await query(updateSql, [mfa_enabled, mfa_canal, telefono, userId]);

    res.status(200).json({
      mensaje: 'Configuración MFA actualizada',
      usuario: rows[0],
    });
  } catch (error: any) {
    console.error('[Error /auth/mfa/config]:', error);
    res.status(500).json({ error: 'Error actualizando configuración MFA' });
  }
});

// --- LOGOUT Y REVOCACIÓN DE TOKEN EN REDIS ---
app.post('/auth/logout', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = (req as any).rawToken;
    const user = (req as any).user;
    const ahora = Math.floor(Date.now() / 1000);
    const ttl = user.exp ? user.exp - ahora : 28800; // 8h default

    if (ttl > 0) {
      await redisClient.set(`blacklist:${token}`, 'revoked', 'EX', ttl);
    }

    res.status(200).json({ mensaje: 'Sesión finalizada y token revocado exitosamente' });
  } catch (error: any) {
    console.error('[Error /auth/logout]:', error);
    res.status(500).json({ error: 'Error cerrando sesión' });
  }
});

// --- PERFIL DE USUARIO PROTEGIDO ---
app.get('/auth/perfil', requireAuth, (req: Request, res: Response) => {
  res.json({
    mensaje: 'Acceso autorizado',
    usuario: (req as any).user,
  });
});

// Raíz informativa
app.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'IntegraCentro - IAM Service API' });
});

const server = app.listen(port, () => {
  console.log(`IAM Service activo en puerto ${port}`);
});

// Graceful Shutdown coordinado (HTTP, PostgreSQL Pool y Redis Client)
const gracefulShutdown = async (signal: string) => {
  console.log(`Recibida señal ${signal}. Cerrando servidor HTTP, conexiones de BD y Redis...`);
  server.close(async () => {
    try {
      await Promise.allSettled([pool.end(), redisClient.quit()]);
      console.log('Conexiones a PostgreSQL y Redis cerradas exitosamente.');
      process.exit(0);
    } catch (err) {
      console.error('Error cerrando recursos:', err);
      process.exit(1);
    }
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));