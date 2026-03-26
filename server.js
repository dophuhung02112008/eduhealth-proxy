/**
 * EduHealth AI - Backend Proxy Server
 * Dùng Groq (chat - miễn phí) + Gemini (scan ảnh - miễn phí)
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// ── Middleware ──────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

app.use(cors({
  origin: ALLOWED_ORIGIN,
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Rate limit: 30 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Quá nhiều yêu cầu. Vui lòng chờ một lát.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// ── Health check ─────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    groq: !!process.env.GROQ_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
    timestamp: new Date().toISOString()
  });
});

// ── Validate API keys ──────────────────────────────────────
const requireGroq = () => {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY chưa được thiết lập. Vui lòng thêm vào Railway Variables.');
  }
};

const requireGemini = () => {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY chưa được thiết lập. Vui lòng thêm vào Railway Variables.');
  }
};

// ── POST /api/chat (Groq - miễn phí) ────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    requireGroq();

    const { messages } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages là mảng bắt buộc.' });
    }

    if (messages.length > 20) {
      return res.status(400).json({ error: 'Tối đa 20 tin nhắn trong một cuộc hội thoại.' });
    }

    const systemPrompt = `Bạn là Trợ lý EduHealth AI – chatbot giáo dục sức khỏe học đường.
- KHÔNG chẩn đoán bệnh. Dùng cụm từ "Gợi ý", "Liên quan", "Khả năng cao là".
- Trả lời dễ hiểu, ngắn gọn, thân thiện, bằng tiếng Việt.
- Luôn nhắc dấu hiệu nguy hiểm cần đi khám.
- Nếu câu hỏi không liên quan sức khỏe học đường, hãy lịch sự chuyển hướng.`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1024,
        temperature: 0.7,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.map(m => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content,
          }))
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[/api/chat] Groq error:', err);
      return res.status(502).json({ error: 'Lỗi AI. Vui lòng thử lại.' });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || 'Mình chưa có thông tin phù hợp.';

    res.json({ reply });
  } catch (err) {
    console.error('[/api/chat] Error:', err.message);
    res.status(500).json({ error: err.message || 'Lỗi server. Vui lòng thử lại.' });
  }
});

// ── POST /api/scan (Gemini - miễn phí) ─────────────────────
app.post('/api/scan', async (req, res) => {
  try {
    requireGemini();

    const { text, imageBase64 } = req.body;

    if (!text && !imageBase64) {
      return res.status(400).json({ error: 'Cần có text hoặc imageBase64.' });
    }

    const parts = [];

    if (imageBase64) {
      parts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: imageBase64,
        },
      });
    }

    if (text) {
      parts.push({
        text: `Bạn là trợ lý EduHealth AI. Sàng lọc giáo dục sức khỏe (Truyền nhiễm, Da liễu, Mắt).
Cấm chẩn đoán xác định. Dùng cụm từ "Gợi ý", "Liên quan", "Khả năng cao là".
Mô tả: ${text}
${imageBase64 ? 'Hãy phân tích kỹ dấu hiệu lâm sàng trong ảnh.' : ''}
Trả về JSON: {"title":"string","analysis":["string"],"urgency":"Theo dõi & Vệ sinh tại nhà"|"Nên tham vấn Y tế học đường"|"Cần đi khám chuyên khoa ngay","dangerSigns":["string"],"safetyAdvice":["string"]}`
      });
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }] }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error('[/api/scan] Gemini error:', err);
      return res.status(502).json({ error: 'Lỗi AI. Vui lòng thử lại.' });
    }

    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    const cleaned = rawText
      .replace(/```json\n?/gi, '')
      .replace(/```\n?/gi, '')
      .trim();

    let result;
    try {
      result = JSON.parse(cleaned);
    } catch {
      return res.status(502).json({ error: 'AI trả về dữ liệu không hợp lệ.', raw: rawText });
    }

    res.json(result);
  } catch (err) {
    console.error('[/api/scan] Error:', err.message);
    res.status(500).json({ error: err.message || 'Lỗi server. Vui lòng thử lại.' });
  }
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ EduHealth Proxy đang chạy tại http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Groq:   ${process.env.GROQ_API_KEY ? '✅ configured' : '❌ missing'}`);
  console.log(`   Gemini: ${process.env.GEMINI_API_KEY ? '✅ configured' : '❌ missing'}`);
});
