import express from "express";
import cors from "cors";
import OpenAI from "openai";
import pkg from "pg";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const { Pool } = pkg;
const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =========================
   MIDDLEWARE
========================= */
app.use(express.json({ limit: "2mb" }));
app.use(cors());

app.use((req, res, next) => {
  console.log(`[REQ] ${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

/* =========================
   STATIC FRONTEND
========================= */
app.use(express.static(path.join(__dirname, "frontend")));

app.get("/", (req, res) => {
  const indexPath = path.join(__dirname, "frontend", "index.html");

  res.sendFile(indexPath, (err) => {
    if (err) {
      res.send("Multi IA Alexa backend activo");
    }
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "Servidor activo",
    time: new Date().toISOString()
  });
});

/* =========================
   DB
========================= */
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    })
  : new Pool({
      user: "postgres",
      host: "localhost",
      database: "ai_platform",
      password: process.env.DB_PASSWORD,
      port: 5432
    });

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      alexa_code TEXT UNIQUE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chats (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT,
      role TEXT,
      mensaje TEXT,
      ia TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      source TEXT DEFAULT 'web'
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS alexa_links (
      id SERIAL PRIMARY KEY,
      alexa_user_id TEXT UNIQUE NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      preferred_ia TEXT DEFAULT 'auto',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS alexa_pair_codes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      code TEXT UNIQUE NOT NULL,
      used BOOLEAN DEFAULT false,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS survey_feedback (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      clarity INTEGER,
      completeness INTEGER,
      usefulness INTEGER,
      preferred_use BOOLEAN,
      best_ai TEXT,
      comments TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS survey_state (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      dismissed_until TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS alexa_code TEXT UNIQUE;
  `);

  await pool.query(`
    ALTER TABLE chats 
    ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'web';
  `);

  console.log("✅ Tablas verificadas correctamente");
}

/* =========================
   OPENAI
========================= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* =========================
   HELPERS
========================= */
function cleanText(text) {
  return String(text || "").trim();
}

function normalizeProvider(provider) {
  const value = String(provider || "auto").toLowerCase().trim();

  const map = {
    auto: "auto",
    chatgpt: "chatgpt",
    "chat gpt": "chatgpt",
    openai: "chatgpt",

    groq: "groq_fast",
    grok: "groq_fast",
    groq_fast: "groq_fast",
    "groq rapido": "groq_fast",
    "groq rápido": "groq_fast",
    "grok rapido": "groq_fast",
    "grok rápido": "groq_fast",

    groq_power: "groq_power",
    "groq potente": "groq_power",
    "grok potente": "groq_power",

    gemini: "gemini"
  };

  return map[value] || "auto";
}

function providerLabel(provider) {
  const labels = {
    auto: "Auto",
    chatgpt: "ChatGPT",
    groq_fast: "Groq rápido",
    groq_power: "Groq potente",
    gemini: "Gemini"
  };

  return labels[provider] || "Auto";
}

function shortForAlexa(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();

  if (clean.length <= 850) return clean;

  return clean.slice(0, 850) + "... Puedes ver la respuesta completa en la aplicación.";
}

function getSlotValue(slots, slotName) {
  return slots?.[slotName]?.value || "";
}

function getAlexaUserId(body) {
  return (
    body?.session?.user?.userId ||
    body?.context?.System?.user?.userId ||
    "unknown-user"
  );
}

function normalizePairCode(value) {
  return String(value || "").replace(/\D/g, "").trim();
}

function normalizeSpokenIA(value) {
  return normalizeProvider(value);
}

function maskEmail(email) {
  const clean = String(email || "");

  if (!clean.includes("@")) return "tu cuenta";

  const [name, domain] = clean.split("@");

  const safeName =
    name.length <= 2
      ? name[0] + "*"
      : name.slice(0, 2) + "***";

  return `${safeName}@${domain}`;
}

function generatePairCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/* =========================
   AUTH
========================= */
function auth(req, res, next) {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).json({ error: "No token" });
  }

  try {
    const data = jwt.verify(token, process.env.JWT_SECRET);
    req.user = data;
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
}

/* =========================
   REGISTER
========================= */
app.post("/register", async (req, res) => {
  try {
    const email = cleanText(req.body.email);
    const password = cleanText(req.body.password);

    if (!email || !password) {
      return res.status(400).json({
        error: "Email y password son obligatorios"
      });
    }

    if (password.length < 4) {
      return res.status(400).json({
        error: "La contraseña debe tener mínimo 4 caracteres"
      });
    }

    const hash = await bcrypt.hash(password, 10);

    const inserted = await pool.query(
      "INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id, email",
      [email, hash]
    );

    const user = inserted.rows[0];
    const legacyAlexaCode = `ALEXA-${user.id}`;

    const updated = await pool.query(
      "UPDATE users SET alexa_code=$1 WHERE id=$2 RETURNING id, email, alexa_code",
      [legacyAlexaCode, user.id]
    );

    res.json({
      ok: true,
      message: "Usuario creado correctamente",
      user: updated.rows[0]
    });
  } catch (error) {
    console.log("REGISTER ERROR:", error.message);

    res.status(400).json({
      error: "No se pudo registrar. Puede que el usuario ya exista.",
      detalle: error.message
    });
  }
});

/* =========================
   LOGIN
========================= */
app.post("/login", async (req, res) => {
  try {
    const email = cleanText(req.body.email);
    const password = cleanText(req.body.password);

    if (!email || !password) {
      return res.status(400).json({
        error: "Email y password son obligatorios"
      });
    }

    const result = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        error: "No existe usuario"
      });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);

    if (!valid) {
      return res.status(401).json({
        error: "Password incorrecto"
      });
    }

    let legacyAlexaCode = user.alexa_code;

    if (!legacyAlexaCode) {
      legacyAlexaCode = `ALEXA-${user.id}`;

      await pool.query(
        "UPDATE users SET alexa_code=$1 WHERE id=$2",
        [legacyAlexaCode, user.id]
      );
    }

    const token = jwt.sign(
      {
        user_id: user.id,
        email: user.email
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "7d"
      }
    );

    res.json({ token });
  } catch (error) {
    console.log("LOGIN ERROR:", error.message);

    res.status(500).json({
      error: "Error en login",
      detalle: error.message
    });
  }
});

/* =========================
   USER INFO
========================= */
app.get("/me", auth, async (req, res) => {
  try {
    const userResult = await pool.query(
      "SELECT id, email, alexa_code FROM users WHERE id=$1",
      [req.user.user_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    const linkResult = await pool.query(
      "SELECT preferred_ia, created_at, updated_at FROM alexa_links WHERE user_id=$1 ORDER BY id DESC LIMIT 1",
      [req.user.user_id]
    );

    res.json({
      ...userResult.rows[0],
      alexa_linked: linkResult.rows.length > 0,
      alexa_link: linkResult.rows[0] || null
    });
  } catch (error) {
    console.log("ME ERROR:", error.message);

    res.status(500).json({
      error: "Error obteniendo usuario",
      detalle: error.message
    });
  }
});

/* =========================
   ALEXA PAIRING WEB ENDPOINTS
========================= */
app.post("/alexa/generate-code", auth, async (req, res) => {
  try {
    const userId = req.user.user_id;

    await pool.query(
      `UPDATE alexa_pair_codes
       SET used=true
       WHERE user_id=$1 AND used=false`,
      [userId]
    );

    let code = "";
    let inserted = null;

    for (let i = 0; i < 5; i++) {
      code = generatePairCode();

      try {
        const result = await pool.query(
          `INSERT INTO alexa_pair_codes (user_id, code, expires_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '10 minutes')
           RETURNING code, expires_at`,
          [userId, code]
        );

        inserted = result.rows[0];
        break;
      } catch (err) {
        if (!String(err.message).includes("duplicate")) {
          throw err;
        }
      }
    }

    if (!inserted) {
      return res.status(500).json({
        error: "No se pudo generar código. Intenta de nuevo."
      });
    }

    res.json({
      ok: true,
      code: inserted.code,
      expires_at: inserted.expires_at,
      message: "Código generado. Dile a Alexa: mi código es " + inserted.code
    });
  } catch (error) {
    console.log("GENERATE ALEXA CODE ERROR:", error.message);

    res.status(500).json({
      error: "Error generando código Alexa",
      detalle: error.message
    });
  }
});

app.get("/alexa/status", auth, async (req, res) => {
  try {
    const linkResult = await pool.query(
      `SELECT preferred_ia, created_at, updated_at
       FROM alexa_links
       WHERE user_id=$1
       ORDER BY id DESC
       LIMIT 1`,
      [req.user.user_id]
    );

    const activeCodeResult = await pool.query(
      `SELECT code, expires_at
       FROM alexa_pair_codes
       WHERE user_id=$1
         AND used=false
         AND expires_at > CURRENT_TIMESTAMP
       ORDER BY id DESC
       LIMIT 1`,
      [req.user.user_id]
    );

    res.json({
      linked: linkResult.rows.length > 0,
      link: linkResult.rows[0] || null,
      active_pair_code: activeCodeResult.rows[0] || null
    });
  } catch (error) {
    console.log("ALEXA STATUS ERROR:", error.message);

    res.status(500).json({
      error: "Error obteniendo estado de Alexa",
      detalle: error.message
    });
  }
});

app.delete("/alexa/unlink", auth, async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM alexa_links WHERE user_id=$1",
      [req.user.user_id]
    );

    await pool.query(
      "UPDATE alexa_pair_codes SET used=true WHERE user_id=$1 AND used=false",
      [req.user.user_id]
    );

    res.json({
      ok: true,
      message: "Alexa desvinculada correctamente"
    });
  } catch (error) {
    console.log("ALEXA UNLINK ERROR:", error.message);

    res.status(500).json({
      error: "Error desvinculando Alexa",
      detalle: error.message
    });
  }
});

/* =========================
   SURVEY ENDPOINTS
========================= */
app.get("/survey/status", auth, async (req, res) => {
  try {
    const userId = req.user.user_id;

    const feedback = await pool.query(
      "SELECT id FROM survey_feedback WHERE user_id=$1 LIMIT 1",
      [userId]
    );

    if (feedback.rows.length > 0) {
      return res.json({
        should_show: false,
        reason: "already_answered"
      });
    }

    const dismissed = await pool.query(
      `SELECT dismissed_until 
       FROM survey_state 
       WHERE user_id=$1 
         AND dismissed_until > CURRENT_TIMESTAMP`,
      [userId]
    );

    if (dismissed.rows.length > 0) {
      return res.json({
        should_show: false,
        reason: "dismissed",
        dismissed_until: dismissed.rows[0].dismissed_until
      });
    }

    const stats = await pool.query(
      `SELECT 
         COUNT(*)::int AS alexa_questions,
         MIN(created_at) AS first_alexa_use
       FROM chats
       WHERE user_id=$1
         AND source='alexa'
         AND role='user'`,
      [userId]
    );

    const row = stats.rows[0];
    const alexaQuestions = row.alexa_questions || 0;
    const firstAlexaUse = row.first_alexa_use;

    let passedThreeDays = false;

    if (firstAlexaUse) {
      const firstDate = new Date(firstAlexaUse).getTime();
      const now = Date.now();
      passedThreeDays = now - firstDate >= 3 * 24 * 60 * 60 * 1000;
    }

    const shouldShow = alexaQuestions >= 8 || passedThreeDays;

    res.json({
      should_show: shouldShow,
      reason: shouldShow ? "eligible" : "not_enough_usage",
      alexa_questions: alexaQuestions,
      first_alexa_use: firstAlexaUse,
      rules: {
        minimum_questions: 8,
        minimum_days: 3
      }
    });
  } catch (error) {
    console.log("SURVEY STATUS ERROR:", error.message);

    res.status(500).json({
      error: "Error obteniendo estado de encuesta",
      detalle: error.message
    });
  }
});

app.post("/survey/dismiss", auth, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO survey_state (user_id, dismissed_until, updated_at)
       VALUES ($1, CURRENT_TIMESTAMP + INTERVAL '7 days', CURRENT_TIMESTAMP)
       ON CONFLICT (user_id)
       DO UPDATE SET 
         dismissed_until = EXCLUDED.dismissed_until,
         updated_at = CURRENT_TIMESTAMP`,
      [req.user.user_id]
    );

    res.json({
      ok: true,
      message: "Encuesta pospuesta por 7 días"
    });
  } catch (error) {
    console.log("SURVEY DISMISS ERROR:", error.message);

    res.status(500).json({
      error: "Error posponiendo encuesta",
      detalle: error.message
    });
  }
});

app.post("/survey/submit", auth, async (req, res) => {
  try {
    const clarity = Number(req.body.clarity || 0);
    const completeness = Number(req.body.completeness || 0);
    const usefulness = Number(req.body.usefulness || 0);
    const preferredUse = Boolean(req.body.preferred_use);
    const bestAi = cleanText(req.body.best_ai);
    const comments = cleanText(req.body.comments);

    await pool.query(
      `INSERT INTO survey_feedback
       (user_id, clarity, completeness, usefulness, preferred_use, best_ai, comments)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.user.user_id,
        clarity,
        completeness,
        usefulness,
        preferredUse,
        bestAi,
        comments
      ]
    );

    res.json({
      ok: true,
      message: "Gracias por responder la encuesta"
    });
  } catch (error) {
    console.log("SURVEY SUBMIT ERROR:", error.message);

    res.status(500).json({
      error: "Error guardando encuesta",
      detalle: error.message
    });
  }
});

/* =========================
   IA FUNCTIONS
========================= */
async function askChatGPT(messages) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Falta OPENAI_API_KEY");
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages
  });

  const text = response.choices?.[0]?.message?.content;

  if (!text) {
    throw new Error("ChatGPT no devolvió respuesta");
  }

  return text;
}

async function askGroq(messages, mode = "fast") {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("Falta GROQ_API_KEY");
  }

  const model =
    mode === "power"
      ? "llama-3.3-70b-versatile"
      : "llama-3.1-8b-instant";

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7
    })
  });

  const data = await response.json();

  if (!response.ok || !data.choices?.[0]?.message?.content) {
    console.log("GROQ ERROR RESPONSE:", data);
    throw new Error(data.error?.message || "Groq no devolvió respuesta");
  }

  return data.choices[0].message.content;
}

async function askGemini(mensaje) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Falta GEMINI_API_KEY");
  }

  const model = "gemini-2.5-flash-lite";

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: mensaje
              }
            ]
          }
        ]
      })
    }
  );

  const data = await response.json();

  if (!response.ok || !data.candidates?.[0]?.content?.parts?.[0]?.text) {
    console.log("GEMINI ERROR RESPONSE:", data);
    throw new Error(data.error?.message || "Gemini no devolvió respuesta");
  }

  return data.candidates[0].content.parts[0].text;
}

async function askAI(provider, messages, rawMessage) {
  const selected = normalizeProvider(provider);

  if (selected === "chatgpt") {
    return {
      respuesta: await askChatGPT(messages),
      iaUsada: "chatgpt"
    };
  }

  if (selected === "groq_fast") {
    return {
      respuesta: await askGroq(messages, "fast"),
      iaUsada: "groq_fast"
    };
  }

  if (selected === "groq_power") {
    return {
      respuesta: await askGroq(messages, "power"),
      iaUsada: "groq_power"
    };
  }

  if (selected === "gemini") {
    try {
      return {
        respuesta: await askGemini(rawMessage),
        iaUsada: "gemini"
      };
    } catch (geminiError) {
      console.log("Gemini falló, usando Groq rápido:", geminiError.message);

      const fallback = await askGroq(messages, "fast");

      return {
        respuesta:
          "Gemini no respondió correctamente. Respondí usando Groq rápido como respaldo.\n\n" +
          fallback,
        iaUsada: "groq_fast"
      };
    }
  }

  try {
    return {
      respuesta: await askGroq(messages, "fast"),
      iaUsada: "groq_fast"
    };
  } catch (groqError) {
    console.log("AUTO: Groq falló, usando ChatGPT:", groqError.message);

    return {
      respuesta: await askChatGPT(messages),
      iaUsada: "chatgpt"
    };
  }
}

/* =========================
   SHARED CHAT HANDLER
========================= */
async function processQuestion({
  user_id,
  mensaje,
  provider,
  conversation_id,
  source,
  alexaMode = false
}) {
  const convId = conversation_id || `${source}-${Date.now()}`;

  const contexto = await pool.query(
    `SELECT role, mensaje 
     FROM (
       SELECT id, role, mensaje
       FROM chats
       WHERE user_id=$1 
         AND conversation_id=$2
         AND role IN ('user', 'ai')
       ORDER BY id DESC
       LIMIT 20
     ) AS ultimos
     ORDER BY id ASC`,
    [user_id, convId]
  );

  const systemPrompt = alexaMode
    ? "Responde en español de forma clara, útil y breve. La respuesta será leída por Alexa, así que evita listas largas y sé directo."
    : "Responde en español de forma clara, útil y directa.";

  const messages = [
    {
      role: "system",
      content: systemPrompt
    },
    ...contexto.rows.map(m => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.mensaje
    })),
    {
      role: "user",
      content: mensaje
    }
  ];

  let respuesta = "";
  let iaUsada = normalizeProvider(provider);

  try {
    const aiResult = await askAI(provider, messages, mensaje);
    respuesta = aiResult.respuesta;
    iaUsada = aiResult.iaUsada;
  } catch (aiError) {
    console.log("IA ERROR:", aiError.message);

    respuesta = `No pude responder con ${providerLabel(provider)}. Error: ${aiError.message}`;
    iaUsada = normalizeProvider(provider);
  }

  await pool.query(
    `INSERT INTO chats (user_id, conversation_id, role, mensaje, ia, source)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [user_id, convId, "user", mensaje, iaUsada, source]
  );

  await pool.query(
    `INSERT INTO chats (user_id, conversation_id, role, mensaje, ia, source)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [user_id, convId, "ai", respuesta, iaUsada, source]
  );

  return {
    respuesta,
    respuesta_alexa: shortForAlexa(respuesta),
    conversation_id: convId,
    ia: iaUsada,
    ia_nombre: providerLabel(iaUsada),
    source
  };
}

/* =========================
   WEB CHAT
========================= */
app.post("/preguntar", auth, async (req, res) => {
  try {
    const mensaje = cleanText(req.body.mensaje);
    const provider = normalizeProvider(req.body.ia);
    const conversation_id = req.body.conversation_id || null;

    if (!mensaje) {
      return res.status(400).json({
        error: "El mensaje está vacío"
      });
    }

    const result = await processQuestion({
      user_id: req.user.user_id,
      mensaje,
      provider,
      conversation_id,
      source: "web",
      alexaMode: false
    });

    res.json(result);
  } catch (error) {
    console.log("CHAT ERROR:", error);

    res.status(500).json({
      error: "Error servidor",
      detalle: error.message
    });
  }
});

/* =========================
   ALEXA SIMPLE TEST
========================= */
app.post("/alexa/preguntar", async (req, res) => {
  try {
    const mensaje = cleanText(req.body.mensaje);
    const provider = normalizeProvider(req.body.ia || "auto");
    const conversation_id = req.body.conversation_id || null;
    const pairCode = normalizePairCode(req.body.code || req.body.alexa_code);

    if (!mensaje) {
      return res.status(400).json({
        error: "Falta mensaje"
      });
    }

    if (!pairCode) {
      return res.status(400).json({
        error: "Falta code"
      });
    }

    const codeResult = await pool.query(
      `SELECT pc.id AS code_id, pc.user_id, u.email
       FROM alexa_pair_codes pc
       JOIN users u ON u.id = pc.user_id
       WHERE pc.code=$1
         AND pc.used=false
         AND pc.expires_at > CURRENT_TIMESTAMP
       ORDER BY pc.id DESC
       LIMIT 1`,
      [pairCode]
    );

    if (codeResult.rows.length === 0) {
      return res.status(404).json({
        error: "Código temporal no encontrado o expirado"
      });
    }

    const user = codeResult.rows[0];

    const result = await processQuestion({
      user_id: user.user_id,
      mensaje,
      provider,
      conversation_id,
      source: "alexa",
      alexaMode: true
    });

    res.json({
      respuesta: result.respuesta_alexa,
      respuesta_completa: result.respuesta,
      conversation_id: result.conversation_id,
      ia: result.ia,
      ia_nombre: result.ia_nombre,
      source: "alexa"
    });
  } catch (error) {
    console.log("ALEXA SIMPLE ERROR:", error);

    res.status(500).json({
      error: "Error servidor Alexa",
      detalle: error.message
    });
  }
});

/* =========================
   CONVERSACIONES
========================= */
app.get("/conversaciones", auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT conversation_id, titulo, source, last_id
      FROM (
        SELECT DISTINCT ON (conversation_id)
          conversation_id,
          LEFT(mensaje, 55) AS titulo,
          source,
          (
            SELECT MAX(id)
            FROM chats c2
            WHERE c2.conversation_id = c1.conversation_id
              AND c2.user_id = c1.user_id
          ) AS last_id
        FROM chats c1
        WHERE user_id=$1
          AND role='user'
        ORDER BY conversation_id, id ASC
      ) AS conversaciones
      ORDER BY last_id DESC
    `, [req.user.user_id]);

    res.json(result.rows);
  } catch (error) {
    console.log("CONVERSACIONES ERROR:", error.message);

    res.status(500).json({
      error: "Error obteniendo conversaciones",
      detalle: error.message
    });
  }
});

/* =========================
   HISTORIAL
========================= */
app.get("/historial/:id", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT role, mensaje, ia, source, created_at
       FROM chats
       WHERE user_id=$1 
         AND conversation_id=$2
         AND role IN ('user', 'ai')
       ORDER BY id ASC`,
      [req.user.user_id, req.params.id]
    );

    res.json(result.rows);
  } catch (error) {
    console.log("HISTORIAL ERROR:", error.message);

    res.status(500).json({
      error: "Error obteniendo historial",
      detalle: error.message
    });
  }
});

/* =========================
   PROVIDERS
========================= */
app.get("/providers", auth, (req, res) => {
  res.json([
    {
      id: "auto",
      name: "Auto",
      description: "Usa Groq rápido y si falla usa ChatGPT"
    },
    {
      id: "chatgpt",
      name: "ChatGPT",
      description: "OpenAI gpt-4o-mini"
    },
    {
      id: "groq_fast",
      name: "Groq rápido",
      description: "llama-3.1-8b-instant"
    },
    {
      id: "groq_power",
      name: "Groq potente",
      description: "llama-3.3-70b-versatile"
    },
    {
      id: "gemini",
      name: "Gemini",
      description: "gemini-2.5-flash-lite con respaldo de Groq"
    }
  ]);
});

/* =========================
   ALEXA SKILL FORMAT
========================= */
function alexaResponse(text, shouldEndSession = false, sessionAttributes = {}) {
  return {
    version: "1.0",
    sessionAttributes,
    response: {
      outputSpeech: {
        type: "PlainText",
        text: String(text || "No tengo respuesta.")
      },
      shouldEndSession
    }
  };
}

async function getAlexaLink(alexaUserId) {
  const result = await pool.query(
    `SELECT al.user_id, al.preferred_ia, u.email, u.alexa_code
     FROM alexa_links al
     JOIN users u ON u.id = al.user_id
     WHERE al.alexa_user_id=$1`,
    [alexaUserId]
  );

  return result.rows[0] || null;
}

async function findValidPairCode(code) {
  const result = await pool.query(
    `SELECT 
       pc.id AS code_id,
       pc.code,
       pc.user_id,
       pc.expires_at,
       u.email
     FROM alexa_pair_codes pc
     JOIN users u ON u.id = pc.user_id
     WHERE pc.code=$1
       AND pc.used=false
       AND pc.expires_at > CURRENT_TIMESTAMP
     ORDER BY pc.id DESC
     LIMIT 1`,
    [code]
  );

  return result.rows[0] || null;
}

async function completeAlexaPairing({ alexaUserId, code }) {
  const pair = await findValidPairCode(code);

  if (!pair) {
    return {
      ok: false,
      message: "Ese código ya expiró o no existe. Genera uno nuevo desde la página web o la aplicación."
    };
  }

  await pool.query(
    `INSERT INTO alexa_links (alexa_user_id, user_id, preferred_ia, updated_at)
     VALUES ($1, $2, 'auto', CURRENT_TIMESTAMP)
     ON CONFLICT (alexa_user_id)
     DO UPDATE SET 
       user_id = EXCLUDED.user_id,
       updated_at = CURRENT_TIMESTAMP`,
    [alexaUserId, pair.user_id]
  );

  await pool.query(
    `UPDATE alexa_pair_codes
     SET used=true
     WHERE id=$1`,
    [pair.code_id]
  );

  return {
    ok: true,
    email: pair.email,
    message: `Listo. Tu Alexa quedó vinculada con la cuenta ${maskEmail(pair.email)}. Ahora puedes decir: pregunta qué es una API.`
  };
}

app.post("/alexa/skill", async (req, res) => {
  try {
    console.log("ALEXA BODY TYPE:", req.body?.request?.type);
    console.log("ALEXA INTENT:", req.body?.request?.intent?.name || "NO_INTENT");

    const requestType = req.body?.request?.type;
    const alexaUserId = getAlexaUserId(req.body);
    const sessionAttributes = req.body?.session?.attributes || {};

    if (requestType === "LaunchRequest") {
      const link = await getAlexaLink(alexaUserId);

      if (link) {
        return res.json(
          alexaResponse(
            "Bienvenido de nuevo. Tu Alexa ya está vinculada. Puedes decir: pregunta qué es una API, o usa groq rápido.",
            false
          )
        );
      }

      return res.json(
        alexaResponse(
          "Bienvenido a Asistente Inteligente. Para vincular tu cuenta, abre la página web o la aplicación, genera un código de Alexa, y después dime: mi código es, seguido de los seis números.",
          false
        )
      );
    }

    if (requestType === "IntentRequest") {
      const intentName = req.body?.request?.intent?.name;
      const slots = req.body?.request?.intent?.slots || {};

      if (intentName === "VincularIntent") {
        const rawCode = getSlotValue(slots, "codigo");
        const pairCode = normalizePairCode(rawCode);

        if (!pairCode || pairCode.length < 4) {
          return res.json(
            alexaResponse(
              "No entendí tu código. Genera un código desde la página web y dime: mi código es, seguido de los seis números.",
              false
            )
          );
        }

        const pair = await findValidPairCode(pairCode);

        if (!pair) {
          return res.json(
            alexaResponse(
              "Ese código no existe o ya expiró. Genera uno nuevo desde la página web o la aplicación.",
              false
            )
          );
        }

        return res.json(
          alexaResponse(
            `Encontré la cuenta ${maskEmail(pair.email)}. Di sí para vincular esta Alexa, o di no para cancelar.`,
            false,
            {
              pending_pair_code: pairCode
            }
          )
        );
      }

      if (intentName === "AMAZON.YesIntent") {
        const pendingCode = normalizePairCode(sessionAttributes.pending_pair_code);

        if (!pendingCode) {
          return res.json(
            alexaResponse(
              "No tengo una vinculación pendiente. Primero di: mi código es, y los seis números generados en la página web.",
              false
            )
          );
        }

        const result = await completeAlexaPairing({
          alexaUserId,
          code: pendingCode
        });

        return res.json(
          alexaResponse(
            result.message,
            false,
            {}
          )
        );
      }

      if (intentName === "AMAZON.NoIntent") {
        return res.json(
          alexaResponse(
            "Vinculación cancelada. Puedes generar otro código cuando quieras.",
            true,
            {}
          )
        );
      }

      if (intentName === "CambiarIAIntent") {
        const link = await getAlexaLink(alexaUserId);

        if (!link) {
          return res.json(
            alexaResponse(
              "Primero vincula tu cuenta. Genera un código desde la web y dime: mi código es, seguido de los seis números.",
              false
            )
          );
        }

        const iaValue = getSlotValue(slots, "ia");
        const provider = normalizeSpokenIA(iaValue);

        await pool.query(
          `UPDATE alexa_links
           SET preferred_ia=$1, updated_at=CURRENT_TIMESTAMP
           WHERE alexa_user_id=$2`,
          [provider, alexaUserId]
        );

        return res.json(
          alexaResponse(
            `Listo. Ahora responderé usando ${providerLabel(provider)}.`,
            false
          )
        );
      }

      if (intentName === "PreguntaIntent") {
        const link = await getAlexaLink(alexaUserId);

        if (!link) {
          return res.json(
            alexaResponse(
              "Primero vincula tu cuenta. Genera un código desde la web y dime: mi código es, seguido de los seis números.",
              false
            )
          );
        }

        const mensaje = cleanText(getSlotValue(slots, "pregunta"));

        if (!mensaje) {
          return res.json(
            alexaResponse(
              "No entendí la pregunta. Intenta decir: pregunta qué es una API.",
              false
            )
          );
        }

        const result = await processQuestion({
          user_id: link.user_id,
          mensaje,
          provider: link.preferred_ia || "auto",
          conversation_id: null,
          source: "alexa",
          alexaMode: true
        });

        return res.json(
          alexaResponse(result.respuesta_alexa, true)
        );
      }

      if (intentName === "AMAZON.HelpIntent") {
        return res.json(
          alexaResponse(
            "Para empezar, abre la página web o la aplicación, genera un código de Alexa y dime: mi código es, seguido de los seis números. Después podrás decir: pregunta qué es una API.",
            false
          )
        );
      }

      if (
        intentName === "AMAZON.CancelIntent" ||
        intentName === "AMAZON.StopIntent"
      ) {
        return res.json(
          alexaResponse("Hasta luego.", true)
        );
      }

      return res.json(
        alexaResponse(
          "No entendí esa instrucción. Intenta decir: pregunta qué es una API.",
          false
        )
      );
    }

    if (requestType === "SessionEndedRequest") {
      return res.json({});
    }

    return res.json(
      alexaResponse("No pude procesar esa solicitud.", true)
    );
  } catch (error) {
    console.log("ALEXA SKILL ERROR:", error);

    return res.json(
      alexaResponse(
        "Hubo un error procesando tu solicitud. Intenta de nuevo más tarde.",
        true
      )
    );
  }
});

/* =========================
   DEBUG OPCIONAL
========================= */
app.get("/debug/alexa-links", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT al.id, al.alexa_user_id, al.user_id, u.email, u.alexa_code, al.preferred_ia, al.created_at, al.updated_at
      FROM alexa_links al
      JOIN users u ON u.id = al.user_id
      ORDER BY al.id DESC
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Error debug alexa links",
      detalle: error.message
    });
  }
});

app.get("/debug/pair-codes", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pc.id, pc.user_id, u.email, pc.code, pc.used, pc.expires_at, pc.created_at
      FROM alexa_pair_codes pc
      JOIN users u ON u.id = pc.user_id
      ORDER BY pc.id DESC
      LIMIT 30
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Error debug pair codes",
      detalle: error.message
    });
  }
});

/* =========================
   START SERVER
========================= */
async function startServer() {
  try {
    await initDatabase();

    app.listen(PORT, () => {
      console.log(`🚀 MULTI IA + ALEXA listo en puerto ${PORT}`);
    });
  } catch (error) {
    console.error("❌ ERROR INICIANDO SERVIDOR:", error);
    process.exit(1);
  }
}

startServer();