/**
 * EduHealth AI - Backend Proxy Server
 * Bảo mật API key bằng cách gọi Anthropic từ server-side
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import Anthropic from '@anthropic-ai/sdk';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// ── Middleware ──────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));

app.use(cors({
  origin: ALLOWED_ORIGIN,
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Rate limit: 20 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Quá nhiều yêu cầu. Vui lòng chờ một lát.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// ── Health check ─────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Validate API key ────────────────────────────────────────
const validateApiKey = () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY chưa được thiết lập trong biến môi trường.');
  }
};

// ── POST /api/chat ───────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    validateApiKey();

    const { messages, role } = req.body;

    // Validate
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages là mảng bắt buộc.' });
    }

    if (messages.length > 20) {
      return res.status(400).json({ error: 'Tối đa 20 tin nhắn trong một cuộc hội thoại.' });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const systemPrompt = `Bạn là Trợ lý EduHealth AI – chatbot giáo dục sức khỏe học đường.
- KHÔNG chẩn đoán bệnh. Dùng cụm từ "Gợi ý", "Liên quan", "Khả năng cao là".
- Trả lời dễ hiểu, ngắn gọn, thân thiện, bằng tiếng Việt.
- Luôn nhắc dấu hiệu nguy hiểm cần đi khám.
- Nếu câu hỏi không liên quan sức khỏe học đường, hãy lịch sự chuyển hướng.`;

    const msgParams = messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: msgParams,
    });

    const reply = response.content[0]?.type === 'text'
      ? response.content[0].text
      : 'Mình chưa có thông tin phù hợp.';

    res.json({ reply });
  } catch (err) {
    console.error('[/api/chat] Error:', err.message);
    if (err.status === 401) {
      return res.status(502).json({ error: 'API key không hợp lệ.' });
    }
    res.status(500).json({ error: err.message || 'Lỗi server. Vui lòng thử lại.' });
  }
});

// ── POST /api/scan ───────────────────────────────────────────
app.post('/api/scan', async (req, res) => {
  try {
    validateApiKey();

    const { text, imageBase64 } = req.body;

    if (!text && !imageBase64) {
      return res.status(400).json({ error: 'Cần có text hoặc imageBase64.' });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const systemPrompt = `Bạn là trợ lý EduHealth AI. Nhiệm vụ: Sàng lọc giáo dục sức khỏe (Truyền nhiễm, Da liễu, Mắt).
Cấm chẩn đoán xác định. Dùng cụm từ "Gợi ý", "Liên quan", "Khả năng cao là".
Luôn trả về JSON hợp lệ với schema:
{
  "title": "string",
  "analysis": ["string"],
  "urgency": "Theo dõi & Vệ sinh tại nhà" | "Nên tham vấn Y tế học đường" | "Cần đi khám chuyên khoa ngay",
  "dangerSigns": ["string"],
  "safetyAdvice": ["string"]
}`;

    const userContent = [];

    if (imageBase64) {
      userContent.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: imageBase64,
        },
      });
    }

    if (text) {
      userContent.push({
        type: 'text',
        text: `Mô tả: ${text}${imageBase64 ? '\nHãy phân tích kỹ dấu hiệu lâm sàng trong ảnh.' : ''}`,
      });
    }

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });

    const rawText = response.content[0]?.type === 'text'
      ? response.content[0].text
      : '{}';

    // Strip markdown code blocks
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
    if (err.status === 401) {
      return res.status(502).json({ error: 'API key không hợp lệ.' });
    }
    res.status(500).json({ error: err.message || 'Lỗi server. Vui lòng thử lại.' });
  }
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ EduHealth Proxy đang chạy tại http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});
